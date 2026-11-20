import json
import os
import re
import shutil
import sys
import tempfile
import time
import zipfile

if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8", errors="strict")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="strict")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def write_json(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


try:
    import uno
    from com.sun.star.awt import Point, Size
    from com.sun.star.beans import PropertyValue
    from com.sun.star.text.ControlCharacter import PARAGRAPH_BREAK
except Exception as exc:
    write_json(
        {
            "ready": False,
            "code": "libreoffice_uno_unavailable",
            "error": f"UNO module unavailable: {exc}",
        }
    )
    sys.exit(2)


def to_file_url(path: str) -> str:
    return uno.systemPathToFileUrl(os.path.abspath(path))


def prop(name: str, value):
    p = PropertyValue()
    p.Name = name
    p.Value = value
    return p


class EngineError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def connect_uno(pipe_name: str, timeout: float = 30.0):
    local_ctx = uno.getComponentContext()
    resolver = local_ctx.ServiceManager.createInstanceWithContext(
        "com.sun.star.bridge.UnoUrlResolver", local_ctx
    )
    url = f"uno:pipe,name={pipe_name};urp;StarOffice.ComponentContext"
    deadline = time.monotonic() + timeout
    last_err = None
    while time.monotonic() < deadline:
        try:
            ctx = resolver.resolve(url)
            smgr = ctx.ServiceManager
            desktop = smgr.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
            return ctx, smgr, desktop
        except Exception as exc:
            last_err = exc
            time.sleep(0.15)
    raise EngineError("engine_error", f"Failed to connect to LibreOffice UNO pipe: {last_err}")


def safe_close(doc):
    if doc is None:
        return
    try:
        doc.close(True)
    except Exception:
        try:
            doc.dispose()
        except Exception:
            pass


def ensure_parent_dir(path: str):
    parent = os.path.dirname(os.path.abspath(path))
    if parent:
        os.makedirs(parent, exist_ok=True)


def store_with_temp(doc, output_path: str, filter_props):
    """Save to a temporary file first, then caller closes doc and commits to output_path."""
    ensure_parent_dir(output_path)
    ext = os.path.splitext(output_path)[1] or ".tmp"
    fd, tmp_path = tempfile.mkstemp(prefix=".nocturne-save-", suffix=ext, dir=os.path.dirname(os.path.abspath(output_path)))
    os.close(fd)
    try:
        doc.storeToURL(to_file_url(tmp_path), tuple(filter_props))
    except Exception:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise
    return tmp_path


def commit_temp(tmp_path: str, output_path: str):
    if not os.path.exists(tmp_path) or os.path.getsize(tmp_path) == 0:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise EngineError("output_missing", f"LibreOffice produced no output file for {output_path}")
    try:
        os.replace(tmp_path, output_path)
    except OSError:
        shutil.move(tmp_path, output_path)


def select_pages(total_pages: int, pages_list):
    if total_pages <= 0:
        return []
    if not pages_list:
        return list(range(1, min(total_pages, 4) + 1))
    result = []
    for p in pages_list:
        if p < 1 or p > total_pages:
            raise EngineError(
                "invalid_argument",
                f"Page {p} is out of range (document has {total_pages} page(s)).",
            )
        if p not in result:
            result.append(p)
    return result


def export_draw_pages(smgr, doc, out_dir: str, page_numbers):
    os.makedirs(out_dir, exist_ok=True)
    exporter = smgr.createInstance("com.sun.star.drawing.GraphicExportFilter")
    draw_pages = doc.getDrawPages()
    total = draw_pages.getCount()
    selected = select_pages(total, page_numbers)
    rendered = []
    for pno in selected:
        page = draw_pages.getByIndex(pno - 1)
        out_path = os.path.join(out_dir, f"page-{pno}.png")
        exporter.setSourceDocument(page)
        args = (
            prop("URL", to_file_url(out_path)),
            prop("MediaType", "image/png"),
        )
        exporter.filter(args)
        if not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
            raise EngineError("output_missing", f"Failed to export PNG for page {pno}")
        rendered.append({"page": pno, "path": out_path})
    return {"totalPages": total, "renderedPages": rendered}


# ==================== DOCX (Writer) ====================


def get_writer_paragraphs(doc):
    paras = []
    enum = doc.Text.createEnumeration()
    while enum.hasMoreElements():
        el = enum.nextElement()
        if el.supportsService("com.sun.star.text.Paragraph"):
            paras.append(el)
    return paras


def apply_heading_style(para_or_cursor, level: int):
    if level < 0 or level > 6:
        raise EngineError("invalid_argument", f"Heading level must be between 0 and 6, got {level}")
    if level == 0:
        try:
            para_or_cursor.ParaStyleName = "Text body"
        except Exception:
            para_or_cursor.ParaStyleName = "Standard"
        try:
            para_or_cursor.OutlineLevel = 0
        except Exception:
            pass
    else:
        para_or_cursor.ParaStyleName = f"Heading {level}"


def op_docx_read(desktop, params):
    path = params["path"]
    doc = None
    try:
        doc = desktop.loadComponentFromURL(
            to_file_url(path), "_blank", 0, (prop("Hidden", True), prop("ReadOnly", True))
        )
        if doc is None:
            raise EngineError("engine_error", f"Could not open document: {path}")
        paragraphs = []
        tables = []
        enum = doc.Text.createEnumeration()
        p_idx = 0
        t_idx = 0
        while enum.hasMoreElements():
            el = enum.nextElement()
            if el.supportsService("com.sun.star.text.Paragraph"):
                style = getattr(el, "ParaStyleName", "") or ""
                outline = int(getattr(el, "OutlineLevel", 0) or 0)
                paragraphs.append(
                    {
                        "index": p_idx,
                        "text": el.getString(),
                        "headingLevel": outline,
                        "style": style,
                    }
                )
                p_idx += 1
            elif el.supportsService("com.sun.star.text.TextTable"):
                rows = []
                for r in range(el.Rows.Count):
                    row = []
                    for c in range(el.Columns.Count):
                        row.append(el.getCellByPosition(c, r).getString())
                    rows.append(row)
                tables.append({"index": t_idx, "rows": rows})
                t_idx += 1
        return {"paragraphs": paragraphs, "tables": tables}
    finally:
        safe_close(doc)


def op_docx_create(desktop, params):
    html_path = params["htmlPath"]
    output_path = params["outputPath"]
    doc = None
    tmp_path = None
    try:
        doc = desktop.loadComponentFromURL(
            to_file_url(html_path),
            "_blank",
            0,
            (prop("Hidden", True), prop("FilterName", "HTML (StarWriter)")),
        )
        if doc is None:
            raise EngineError("engine_error", "Failed to load HTML into LibreOffice Writer")
        tmp_path = store_with_temp(doc, output_path, [prop("FilterName", "MS Word 2007 XML")])
    finally:
        safe_close(doc)
    commit_temp(tmp_path, output_path)
    return {"outputPath": output_path}


def op_docx_edit(desktop, params):
    path = params["path"]
    output_path = params["outputPath"]
    operations = params.get("operations", [])
    doc = None
    tmp_path = None
    summary = []
    try:
        doc = desktop.loadComponentFromURL(
            to_file_url(path), "_blank", 0, (prop("Hidden", True),)
        )
        if doc is None:
            raise EngineError("engine_error", f"Could not open document: {path}")
        text = doc.Text

        for op in operations:
            kind = op.get("type")
            if kind == "replace":
                rd = doc.createReplaceDescriptor()
                rd.SearchString = op["find"]
                rd.ReplaceString = op["replace"]
                rd.SearchCaseSensitive = bool(op.get("caseSensitive", False))
                rd.SearchRegularExpression = bool(op.get("regex", False))
                count = int(doc.replaceAll(rd))
                summary.append({"type": "replace", "replaced": count})

            elif kind == "insert_paragraph":
                paras = get_writer_paragraphs(doc)
                p_text = op["text"]
                idx = op.get("index")
                level = int(op.get("headingLevel", 0))
                if idx is None or idx >= len(paras):
                    cursor = text.createTextCursorByRange(text.getEnd())
                    if len(paras) > 0 and not (len(paras) == 1 and paras[0].getString() == ""):
                        text.insertControlCharacter(cursor, PARAGRAPH_BREAK, False)
                    text.insertString(cursor, p_text, False)
                    apply_heading_style(cursor, level)
                    inserted_idx = len(get_writer_paragraphs(doc)) - 1
                else:
                    if idx < 0:
                        raise EngineError("invalid_argument", f"Invalid paragraph index: {idx}")
                    target = paras[idx]
                    cursor = text.createTextCursorByRange(target.getStart())
                    text.insertString(cursor, p_text, False)
                    text.insertControlCharacter(cursor, PARAGRAPH_BREAK, False)
                    updated_paras = get_writer_paragraphs(doc)
                    if idx < len(updated_paras):
                        apply_heading_style(updated_paras[idx], level)
                    inserted_idx = idx
                summary.append({"type": "insert_paragraph", "index": inserted_idx})

            elif kind == "delete_paragraph":
                paras = get_writer_paragraphs(doc)
                idx = int(op["index"])
                if idx < 0 or idx >= len(paras):
                    raise EngineError(
                        "invalid_argument",
                        f"Paragraph index {idx} out of range (0..{len(paras) - 1})",
                    )
                if len(paras) == 1:
                    paras[0].setString("")
                else:
                    target = paras[idx]
                    try:
                        target.dispose()
                    except Exception:
                        target.setString("")
                summary.append({"type": "delete_paragraph", "index": idx})

            elif kind == "set_heading":
                paras = get_writer_paragraphs(doc)
                idx = int(op["index"])
                level = int(op["level"])
                if idx < 0 or idx >= len(paras):
                    raise EngineError(
                        "invalid_argument",
                        f"Paragraph index {idx} out of range (0..{len(paras) - 1})",
                    )
                apply_heading_style(paras[idx], level)
                summary.append({"type": "set_heading", "index": idx, "level": level})

            elif kind == "insert_table":
                rows = op.get("rows", [])
                if not rows or not rows[0]:
                    raise EngineError("invalid_argument", "insert_table requires non-empty rows")
                num_rows = len(rows)
                num_cols = max(len(r) for r in rows)
                table = doc.createInstance("com.sun.star.text.TextTable")
                table.initialize(num_rows, num_cols)
                after_idx = op.get("afterParagraph")
                if after_idx is not None:
                    paras = get_writer_paragraphs(doc)
                    after_idx = int(after_idx)
                    if after_idx < 0 or after_idx >= len(paras):
                        raise EngineError(
                            "invalid_argument",
                            f"afterParagraph {after_idx} out of range (0..{len(paras) - 1})",
                        )
                    cursor = text.createTextCursorByRange(paras[after_idx].getEnd())
                else:
                    cursor = text.createTextCursorByRange(text.getEnd())
                text.insertTextContent(cursor, table, False)
                for r_idx, row in enumerate(rows):
                    for c_idx in range(num_cols):
                        val = "" if c_idx >= len(row) or row[c_idx] is None else str(row[c_idx])
                        table.getCellByPosition(c_idx, r_idx).setString(val)
                summary.append({"type": "insert_table", "rows": num_rows, "cols": num_cols})

            else:
                raise EngineError("invalid_argument", f"Unknown docx edit operation: {kind}")

        ext = os.path.splitext(output_path)[1].lower()
        filter_name = "writer8" if ext == ".odt" else "MS Word 2007 XML"
        tmp_path = store_with_temp(doc, output_path, [prop("FilterName", filter_name)])
    finally:
        safe_close(doc)
    commit_temp(tmp_path, output_path)
    return {"outputPath": output_path, "operations": summary}


def op_docx_convert(desktop, params):
    path = params["path"]
    output_path = params["outputPath"]
    fmt = params["format"]
    filter_map = {
        "pdf": [prop("FilterName", "writer_pdf_Export")],
        "odt": [prop("FilterName", "writer8")],
        "html": [prop("FilterName", "HTML (StarWriter)")],
        "txt": [prop("FilterName", "Text (encoded)"), prop("FilterOptions", "UTF8")],
    }
    if fmt not in filter_map:
        raise EngineError("invalid_argument", f"Unsupported docx convert format: {fmt}")
    doc = None
    tmp_path = None
    try:
        doc = desktop.loadComponentFromURL(
            to_file_url(path), "_blank", 0, (prop("Hidden", True), prop("ReadOnly", True))
        )
        if doc is None:
            raise EngineError("engine_error", f"Could not open document: {path}")
        tmp_path = store_with_temp(doc, output_path, filter_map[fmt])
    finally:
        safe_close(doc)
    if fmt == "txt" and os.path.exists(tmp_path):
        with open(tmp_path, "rb") as f:
            raw = f.read()
        if raw.startswith(b"\xef\xbb\xbf"):
            with open(tmp_path, "wb") as f:
                f.write(raw[3:])
    commit_temp(tmp_path, output_path)
    return {"outputPath": output_path, "format": fmt}


def op_docx_render(smgr, desktop, params):
    path = params["path"]
    out_dir = params["outDir"]
    pages_list = params.get("pages")
    tmp_pdf_dir = tempfile.mkdtemp(prefix="nocturne-word-pdf-")
    tmp_pdf = os.path.join(tmp_pdf_dir, "render.pdf")
    doc = None
    pdf_doc = None
    try:
        doc = desktop.loadComponentFromURL(
            to_file_url(path), "_blank", 0, (prop("Hidden", True), prop("ReadOnly", True))
        )
        if doc is None:
            raise EngineError("engine_error", f"Could not open document: {path}")
        doc.storeToURL(to_file_url(tmp_pdf), (prop("FilterName", "writer_pdf_Export"),))
        safe_close(doc)
        doc = None
        if not os.path.exists(tmp_pdf) or os.path.getsize(tmp_pdf) == 0:
            raise EngineError("output_missing", "Failed to export intermediate PDF for rendering")
        pdf_doc = desktop.loadComponentFromURL(
            to_file_url(tmp_pdf),
            "_blank",
            0,
            (prop("Hidden", True), prop("ReadOnly", True), prop("FilterName", "draw_pdf_import")),
        )
        if pdf_doc is None:
            raise EngineError("engine_error", "Failed to load intermediate PDF in LibreOffice Draw")
        return export_draw_pages(smgr, pdf_doc, out_dir, pages_list)
    finally:
        safe_close(doc)
        safe_close(pdf_doc)
        shutil.rmtree(tmp_pdf_dir, ignore_errors=True)


# ==================== XLSX (Calc) ====================


def col_index_to_letters(col_idx: int) -> str:
    letters = ""
    n = col_idx + 1
    while n > 0:
        n, rem = divmod(n - 1, 26)
        letters = chr(65 + rem) + letters
    return letters


def get_sheet(doc, sheet_name=None):
    sheets = doc.Sheets
    if not sheet_name:
        return sheets.getByIndex(0)
    if not sheets.hasByName(sheet_name):
        raise EngineError("invalid_argument", f"Sheet not found: {sheet_name}")
    return sheets.getByName(sheet_name)


def get_used_bounds(sheet):
    cursor = sheet.createCursor()
    cursor.gotoStartOfUsedArea(False)
    start_col = cursor.RangeAddress.StartColumn
    start_row = cursor.RangeAddress.StartRow
    cursor.gotoEndOfUsedArea(True)
    end_col = cursor.RangeAddress.EndColumn
    end_row = cursor.RangeAddress.EndRow
    return start_col, start_row, end_col, end_row


def write_cell_value(cell, value=None, formula=None):
    if formula is not None:
        f_str = str(formula)
        if not f_str.startswith("="):
            f_str = "=" + f_str
        cell.setFormula(f_str)
        return
    if value is None:
        cell.setString("")
    elif isinstance(value, bool):
        cell.setFormula("=TRUE()" if value else "=FALSE()")
    elif isinstance(value, (int, float)):
        cell.setValue(float(value))
    elif isinstance(value, str):
        if value.startswith("="):
            cell.setFormula(value)
        else:
            cell.setString(value)
    else:
        cell.setString(str(value))


def normalize_cell_val(v):
    if isinstance(v, float) and v.is_integer():
        return int(v)
    return v


def op_xlsx_read(desktop, params):
    path = params["path"]
    sheet_name = params.get("sheet")
    cell_range = params.get("range")
    doc = None
    try:
        doc = desktop.loadComponentFromURL(
            to_file_url(path), "_blank", 0, (prop("Hidden", True), prop("ReadOnly", True))
        )
        if doc is None:
            raise EngineError("engine_error", f"Could not open spreadsheet: {path}")
        sheet_infos = []
        for i in range(doc.Sheets.Count):
            sh = doc.Sheets.getByIndex(i)
            sc, sr, ec, er = get_used_bounds(sh)
            sheet_infos.append(
                {
                    "name": sh.Name,
                    "usedRange": f"{col_index_to_letters(sc)}{sr + 1}:{col_index_to_letters(ec)}{er + 1}",
                    "rows": er - sr + 1,
                    "cols": ec - sc + 1,
                }
            )
        target_sheet = get_sheet(doc, sheet_name)
        truncated = False
        if cell_range:
            rng = target_sheet.getCellRangeByName(cell_range)
            effective_range = cell_range
        else:
            sc, sr, ec, er = get_used_bounds(target_sheet)
            max_rows = 200
            max_cols = 50
            if er - sr + 1 > max_rows:
                er = sr + max_rows - 1
                truncated = True
            if ec - sc + 1 > max_cols:
                ec = sc + max_cols - 1
                truncated = True
            effective_range = f"{col_index_to_letters(sc)}{sr + 1}:{col_index_to_letters(ec)}{er + 1}"
            rng = target_sheet.getCellRangeByPosition(sc, sr, ec, er)

        raw_data = rng.getDataArray()
        raw_formulas = rng.getFormulaArray()
        values = [[normalize_cell_val(c) for c in row] for row in raw_data]
        formulas = [[str(c) for c in row] for row in raw_formulas]
        return {
            "sheets": sheet_infos,
            "sheet": target_sheet.Name,
            "range": effective_range,
            "truncated": truncated,
            "values": values,
            "formulas": formulas,
        }
    finally:
        safe_close(doc)


def op_xlsx_create(desktop, params):
    output_path = params["outputPath"]
    sheets_spec = params.get("sheets", [])
    if not sheets_spec:
        raise EngineError("invalid_argument", "sheets must contain at least one sheet")
    doc = None
    tmp_path = None
    try:
        doc = desktop.loadComponentFromURL(
            "private:factory/scalc", "_blank", 0, (prop("Hidden", True),)
        )
        for idx, spec in enumerate(sheets_spec):
            name = spec["name"]
            if idx == 0:
                sh = doc.Sheets.getByIndex(0)
                sh.Name = name
            else:
                doc.Sheets.insertNewByName(name, idx)
                sh = doc.Sheets.getByName(name)
            rows = spec.get("rows", [])
            for r_idx, row in enumerate(rows):
                for c_idx, val in enumerate(row):
                    write_cell_value(sh.getCellByPosition(c_idx, r_idx), value=val)
        doc.calculateAll()
        tmp_path = store_with_temp(
            doc, output_path, [prop("FilterName", "Calc MS Excel 2007 XML")]
        )
    finally:
        safe_close(doc)
    commit_temp(tmp_path, output_path)
    return {"outputPath": output_path, "sheets": [s["name"] for s in sheets_spec]}


def op_xlsx_edit(desktop, params):
    path = params["path"]
    output_path = params["outputPath"]
    operations = params.get("operations", [])
    doc = None
    tmp_path = None
    summary = []
    try:
        doc = desktop.loadComponentFromURL(
            to_file_url(path), "_blank", 0, (prop("Hidden", True),)
        )
        if doc is None:
            raise EngineError("engine_error", f"Could not open spreadsheet: {path}")

        for op in operations:
            kind = op.get("type")
            if kind == "set_cells":
                sh = get_sheet(doc, op.get("sheet"))
                cells = op.get("cells", [])
                for item in cells:
                    addr = item["cell"]
                    cell = sh.getCellRangeByName(addr).getCellByPosition(0, 0)
                    write_cell_value(cell, value=item.get("value"), formula=item.get("formula"))
                summary.append({"type": "set_cells", "sheet": sh.Name, "count": len(cells)})

            elif kind == "insert_rows":
                sh = get_sheet(doc, op.get("sheet"))
                idx = int(op["index"])
                count = int(op.get("count", 1))
                sh.Rows.insertByIndex(idx, count)
                summary.append({"type": "insert_rows", "sheet": sh.Name, "index": idx, "count": count})

            elif kind == "delete_rows":
                sh = get_sheet(doc, op.get("sheet"))
                idx = int(op["index"])
                count = int(op.get("count", 1))
                sh.Rows.removeByIndex(idx, count)
                summary.append({"type": "delete_rows", "sheet": sh.Name, "index": idx, "count": count})

            elif kind == "insert_columns":
                sh = get_sheet(doc, op.get("sheet"))
                idx = int(op["index"])
                count = int(op.get("count", 1))
                sh.Columns.insertByIndex(idx, count)
                summary.append({"type": "insert_columns", "sheet": sh.Name, "index": idx, "count": count})

            elif kind == "delete_columns":
                sh = get_sheet(doc, op.get("sheet"))
                idx = int(op["index"])
                count = int(op.get("count", 1))
                sh.Columns.removeByIndex(idx, count)
                summary.append({"type": "delete_columns", "sheet": sh.Name, "index": idx, "count": count})

            elif kind == "add_sheet":
                name = op["name"]
                idx = int(op.get("index", doc.Sheets.Count))
                doc.Sheets.insertNewByName(name, idx)
                summary.append({"type": "add_sheet", "name": name, "index": idx})

            elif kind == "delete_sheet":
                name = op["name"]
                if not doc.Sheets.hasByName(name):
                    raise EngineError("invalid_argument", f"Sheet not found: {name}")
                if doc.Sheets.Count <= 1:
                    raise EngineError("invalid_argument", "Cannot delete the last remaining sheet")
                doc.Sheets.removeByName(name)
                summary.append({"type": "delete_sheet", "name": name})

            elif kind == "rename_sheet":
                old_name = op["from"]
                new_name = op["to"]
                sh = get_sheet(doc, old_name)
                sh.Name = new_name
                summary.append({"type": "rename_sheet", "from": old_name, "to": new_name})

            else:
                raise EngineError("invalid_argument", f"Unknown xlsx edit operation: {kind}")

        doc.calculateAll()
        ext = os.path.splitext(output_path)[1].lower()
        filter_name = "calc8" if ext == ".ods" else "Calc MS Excel 2007 XML"
        tmp_path = store_with_temp(doc, output_path, [prop("FilterName", filter_name)])
    finally:
        safe_close(doc)
    commit_temp(tmp_path, output_path)
    return {"outputPath": output_path, "operations": summary}


def op_xlsx_recalculate(desktop, params):
    path = params["path"]
    output_path = params["outputPath"]
    doc = None
    tmp_path = None
    try:
        doc = desktop.loadComponentFromURL(
            to_file_url(path), "_blank", 0, (prop("Hidden", True),)
        )
        if doc is None:
            raise EngineError("engine_error", f"Could not open spreadsheet: {path}")
        doc.calculateAll()
        sheet_names = [doc.Sheets.getByIndex(i).Name for i in range(doc.Sheets.Count)]
        ext = os.path.splitext(output_path)[1].lower()
        filter_name = "calc8" if ext == ".ods" else "Calc MS Excel 2007 XML"
        tmp_path = store_with_temp(doc, output_path, [prop("FilterName", filter_name)])
    finally:
        safe_close(doc)
    commit_temp(tmp_path, output_path)
    return {"outputPath": output_path, "sheets": sheet_names}


def op_xlsx_convert(desktop, params):
    path = params["path"]
    output_path = params["outputPath"]
    fmt = params["format"]
    doc = None
    if fmt == "csv":
        out_dir = params["outDir"]
        stem = params["stem"]
        overwrite = bool(params.get("overwrite", False))
        tmp_dir = tempfile.mkdtemp(prefix="nocturne-csv-")
        try:
            doc = desktop.loadComponentFromURL(
                to_file_url(path), "_blank", 0, (prop("Hidden", True), prop("ReadOnly", True))
            )
            if doc is None:
                raise EngineError("engine_error", f"Could not open spreadsheet: {path}")
            target_base = os.path.join(tmp_dir, f"{stem}.csv")
            doc.storeToURL(
                to_file_url(target_base),
                (
                    prop("FilterName", "Text - txt - csv (StarCalc)"),
                    prop("FilterOptions", "44,34,76,1,,0,false,true,false,false,false,-1"),
                ),
            )
            safe_close(doc)
            doc = None
            produced = sorted(
                f for f in os.listdir(tmp_dir) if f.lower().endswith(".csv")
            )
            if not produced:
                raise EngineError("output_missing", "LibreOffice produced no CSV files")
            os.makedirs(out_dir, exist_ok=True)
            if not overwrite:
                for fname in produced:
                    dest = os.path.join(out_dir, fname)
                    if os.path.exists(dest):
                        raise EngineError(
                            "file_exists",
                            f"Target CSV already exists: {dest} (pass overwrite: true to replace)",
                        )
            final_paths = []
            for fname in produced:
                src = os.path.join(tmp_dir, fname)
                dest = os.path.join(out_dir, fname)
                shutil.move(src, dest)
                final_paths.append(dest)
            return {"outputPaths": final_paths, "format": "csv"}
        finally:
            safe_close(doc)
            shutil.rmtree(tmp_dir, ignore_errors=True)

    filter_map = {
        "pdf": [prop("FilterName", "calc_pdf_Export")],
        "ods": [prop("FilterName", "calc8")],
    }
    if fmt not in filter_map:
        raise EngineError("invalid_argument", f"Unsupported xlsx convert format: {fmt}")
    filter_props = list(filter_map[fmt])
    if fmt == "pdf" and params.get("singlePageSheets") is True:
        filter_data = uno.Any(
            "[]com.sun.star.beans.PropertyValue",
            (prop("SinglePageSheets", True),),
        )
        filter_props.append(prop("FilterData", filter_data))
    tmp_path = None
    try:
        doc = desktop.loadComponentFromURL(
            to_file_url(path), "_blank", 0, (prop("Hidden", True), prop("ReadOnly", True))
        )
        if doc is None:
            raise EngineError("engine_error", f"Could not open spreadsheet: {path}")
        tmp_path = store_with_temp(doc, output_path, filter_props)
    finally:
        safe_close(doc)
    commit_temp(tmp_path, output_path)
    return {"outputPath": output_path, "format": fmt}


def op_xlsx_render(smgr, desktop, params):
    path = params["path"]
    out_dir = params["outDir"]
    pages_list = params.get("pages")
    tmp_pdf_dir = tempfile.mkdtemp(prefix="nocturne-calc-pdf-")
    tmp_pdf = os.path.join(tmp_pdf_dir, "render.pdf")
    doc = None
    pdf_doc = None
    try:
        doc = desktop.loadComponentFromURL(
            to_file_url(path), "_blank", 0, (prop("Hidden", True), prop("ReadOnly", True))
        )
        if doc is None:
            raise EngineError("engine_error", f"Could not open spreadsheet: {path}")
        doc.storeToURL(to_file_url(tmp_pdf), (prop("FilterName", "calc_pdf_Export"),))
        safe_close(doc)
        doc = None
        if not os.path.exists(tmp_pdf) or os.path.getsize(tmp_pdf) == 0:
            raise EngineError("output_missing", "Failed to export intermediate PDF for rendering")
        pdf_doc = desktop.loadComponentFromURL(
            to_file_url(tmp_pdf),
            "_blank",
            0,
            (prop("Hidden", True), prop("ReadOnly", True), prop("FilterName", "draw_pdf_import")),
        )
        if pdf_doc is None:
            raise EngineError("engine_error", "Failed to load intermediate PDF in LibreOffice Draw")
        return export_draw_pages(smgr, pdf_doc, out_dir, pages_list)
    finally:
        safe_close(doc)
        safe_close(pdf_doc)
        shutil.rmtree(tmp_pdf_dir, ignore_errors=True)


# ==================== PPTX (Impress) ====================


def populate_slide(ctx, smgr, pres, slide, spec):
    title = spec.get("title")
    bullets = spec.get("bullets")
    body = spec.get("body")
    image_path = spec.get("imagePath")
    notes = spec.get("notes")

    has_body = bool(bullets) or bool(body)
    slide.Layout = 1 if (title or has_body) else 20  # 1 = Title, Content; 20 = Blank

    body_text = ""
    if bullets:
        body_text = "\n".join(str(b) for b in bullets)
    if body:
        body_text = f"{body_text}\n{body}" if body_text else str(body)

    title_set = False
    body_set = False
    for idx in range(slide.getCount()):
        sh = slide.getByIndex(idx)
        stype = sh.getShapeType()
        if stype == "com.sun.star.presentation.TitleTextShape" and title is not None:
            sh.setString(str(title))
            title_set = True
        elif stype == "com.sun.star.presentation.OutlinerShape" and body_text:
            sh.setString(body_text)
            if image_path:
                # Narrow text box to left half when image is placed on right
                sz = sh.getSize()
                sh.setSize(Size(int(sz.Width * 0.54), sz.Height))
            body_set = True

    if title and not title_set:
        tshape = pres.createInstance("com.sun.star.drawing.TextShape")
        tshape.setPosition(Point(1500, 1000))
        tshape.setSize(Size(25000, 2500))
        slide.add(tshape)
        tshape.setString(str(title))

    if body_text and not body_set:
        bshape = pres.createInstance("com.sun.star.drawing.TextShape")
        bshape.setPosition(Point(1500, 4200))
        bshape.setSize(Size(13000 if image_path else 25000, 10000))
        slide.add(bshape)
        bshape.setString(body_text)

    if image_path:
        if not os.path.exists(image_path):
            raise EngineError("file_not_found", f"Image file not found: {image_path}")
        gp = smgr.createInstanceWithContext("com.sun.star.graphic.GraphicProvider", ctx)
        graphic = gp.queryGraphic((prop("URL", to_file_url(image_path)),))
        if graphic is None:
            raise EngineError("engine_error", f"Could not load image: {image_path}")
        gshape = pres.createInstance("com.sun.star.drawing.GraphicObjectShape")
        gshape.Graphic = graphic
        page_w = slide.Width
        page_h = slide.Height
        img_w = int(page_w * 0.36)
        img_h = int(page_h * 0.45)
        pos_x = int(page_w * 0.58) if body_text else int((page_w - img_w) / 2)
        pos_y = int(page_h * 0.30)
        gshape.setPosition(Point(pos_x, pos_y))
        gshape.setSize(Size(img_w, img_h))
        slide.add(gshape)

    if notes is not None:
        notes_page = slide.getNotesPage()
        for idx in range(notes_page.getCount()):
            nsh = notes_page.getByIndex(idx)
            if nsh.getShapeType() == "com.sun.star.presentation.NotesShape":
                nsh.setString(str(notes))
                break


def reorder_pptx_slides(pptx_path: str, order_1based):
    """Reorder slides in a PPTX by permuting <p:sldId .../> entries in ppt/presentation.xml."""
    with zipfile.ZipFile(pptx_path, "r") as zin:
        if "ppt/presentation.xml" not in zin.namelist():
            raise EngineError("engine_error", "Invalid PPTX: missing ppt/presentation.xml")
        pres_xml = zin.read("ppt/presentation.xml").decode("utf-8")
        match = re.search(r"(<p:sldIdLst>)(.*?)(</p:sldIdLst>)", pres_xml, flags=re.DOTALL)
        if not match:
            raise EngineError("engine_error", "Invalid PPTX: missing <p:sldIdLst>")
        slide_tags = re.findall(r"<p:sldId\b[^>]*/\s*>", match.group(2))
        count = len(slide_tags)
        if len(order_1based) != count or sorted(order_1based) != list(range(1, count + 1)):
            raise EngineError(
                "invalid_argument",
                f"reorder_slides order must be a permutation of 1..{count}, got {order_1based}",
            )
        reordered = "".join(slide_tags[i - 1] for i in order_1based)
        new_xml = pres_xml[: match.start(2)] + reordered + pres_xml[match.end(2) :]

        fd, tmp_zip = tempfile.mkstemp(
            prefix=".nocturne-reorder-", suffix=".pptx", dir=os.path.dirname(os.path.abspath(pptx_path))
        )
        os.close(fd)
        try:
            with zipfile.ZipFile(tmp_zip, "w", compression=zipfile.ZIP_DEFLATED) as zout:
                for item in zin.infolist():
                    if item.filename == "ppt/presentation.xml":
                        zout.writestr(item, new_xml.encode("utf-8"))
                    else:
                        zout.writestr(item, zin.read(item.filename))
        except Exception:
            if os.path.exists(tmp_zip):
                os.remove(tmp_zip)
            raise
    os.replace(tmp_zip, pptx_path)


def op_pptx_read(desktop, params):
    path = params["path"]
    doc = None
    try:
        doc = desktop.loadComponentFromURL(
            to_file_url(path), "_blank", 0, (prop("Hidden", True), prop("ReadOnly", True))
        )
        if doc is None:
            raise EngineError("engine_error", f"Could not open presentation: {path}")
        pages = doc.getDrawPages()
        slides = []
        for i in range(pages.getCount()):
            page = pages.getByIndex(i)
            texts = []
            for j in range(page.getCount()):
                sh = page.getByIndex(j)
                try:
                    t = sh.getString()
                except Exception:
                    t = ""
                if t and t.strip():
                    texts.append(t)
            notes_text = ""
            try:
                notes_page = page.getNotesPage()
                for j in range(notes_page.getCount()):
                    nsh = notes_page.getByIndex(j)
                    if nsh.getShapeType() == "com.sun.star.presentation.NotesShape":
                        notes_text = nsh.getString() or ""
                        break
            except Exception:
                notes_text = ""
            slides.append({"slide": i + 1, "texts": texts, "notes": notes_text})
        return {"totalSlides": len(slides), "slides": slides}
    finally:
        safe_close(doc)


def op_pptx_create(ctx, smgr, desktop, params):
    output_path = params["outputPath"]
    slides_spec = params.get("slides", [])
    if not slides_spec:
        raise EngineError("invalid_argument", "slides must contain at least one slide")
    doc = None
    tmp_path = None
    try:
        doc = desktop.loadComponentFromURL(
            "private:factory/simpress", "_blank", 0, (prop("Hidden", True),)
        )
        for idx, spec in enumerate(slides_spec):
            if idx == 0:
                slide = doc.DrawPages.getByIndex(0)
            else:
                slide = doc.DrawPages.insertNewByIndex(idx)
            populate_slide(ctx, smgr, doc, slide, spec)
        tmp_path = store_with_temp(
            doc, output_path, [prop("FilterName", "Impress MS PowerPoint 2007 XML")]
        )
    finally:
        safe_close(doc)
    commit_temp(tmp_path, output_path)
    return {"outputPath": output_path, "totalSlides": len(slides_spec)}


def replace_text_on_slide(page, find_str: str, replace_str: str, case_sensitive: bool) -> int:
    replaced = 0
    flags = 0 if case_sensitive else re.IGNORECASE
    pattern = re.compile(re.escape(find_str), flags)
    for j in range(page.getCount()):
        sh = page.getByIndex(j)
        try:
            cur = sh.getString()
        except Exception:
            continue
        if not cur:
            continue
        new_str, n = pattern.subn(lambda _m: replace_str, cur)
        if n > 0:
            sh.setString(new_str)
            replaced += n
    return replaced


def op_pptx_edit(ctx, smgr, desktop, params):
    path = params["path"]
    output_path = params["outputPath"]
    operations = params.get("operations", [])
    summary = []
    work_dir = tempfile.mkdtemp(prefix="nocturne-pptx-edit-")
    work_pptx = os.path.join(work_dir, "work.pptx")
    doc = None
    try:
        doc = desktop.loadComponentFromURL(
            to_file_url(path), "_blank", 0, (prop("Hidden", True),)
        )
        if doc is None:
            raise EngineError("engine_error", f"Could not open presentation: {path}")

        for op in operations:
            kind = op.get("type")
            if kind == "replace":
                find_str = op["find"]
                replace_str = op["replace"]
                case_sensitive = bool(op.get("caseSensitive", False))
                slide_num = op.get("slide")
                count = 0
                pages = doc.getDrawPages()
                if slide_num is not None:
                    s_idx = int(slide_num) - 1
                    if s_idx < 0 or s_idx >= pages.getCount():
                        raise EngineError(
                            "invalid_argument",
                            f"Slide {slide_num} out of range (1..{pages.getCount()})",
                        )
                    count += replace_text_on_slide(
                        pages.getByIndex(s_idx), find_str, replace_str, case_sensitive
                    )
                else:
                    for i in range(pages.getCount()):
                        count += replace_text_on_slide(
                            pages.getByIndex(i), find_str, replace_str, case_sensitive
                        )
                summary.append({"type": "replace", "replaced": count})

            elif kind == "add_slide":
                pages = doc.getDrawPages()
                idx_1 = op.get("index")
                if idx_1 is None:
                    insert_at = pages.getCount()
                else:
                    insert_at = int(idx_1) - 1
                    if insert_at < 0 or insert_at > pages.getCount():
                        raise EngineError(
                            "invalid_argument",
                            f"Slide insertion index {idx_1} out of range (1..{pages.getCount() + 1})",
                        )
                new_slide = pages.insertNewByIndex(insert_at)
                populate_slide(ctx, smgr, doc, new_slide, op)
                summary.append({"type": "add_slide", "slide": insert_at + 1})

            elif kind == "delete_slide":
                pages = doc.getDrawPages()
                slide_num = int(op["slide"])
                if pages.getCount() <= 1:
                    raise EngineError("invalid_argument", "Cannot delete the last remaining slide")
                s_idx = slide_num - 1
                if s_idx < 0 or s_idx >= pages.getCount():
                    raise EngineError(
                        "invalid_argument",
                        f"Slide {slide_num} out of range (1..{pages.getCount()})",
                    )
                pages.remove(pages.getByIndex(s_idx))
                summary.append({"type": "delete_slide", "slide": slide_num})

            elif kind == "reorder_slides":
                order = [int(x) for x in op["order"]]
                # Save current state to work_pptx, reorder OOXML sldIdLst, and reload
                doc.storeToURL(
                    to_file_url(work_pptx),
                    (prop("FilterName", "Impress MS PowerPoint 2007 XML"),),
                )
                safe_close(doc)
                doc = None
                reorder_pptx_slides(work_pptx, order)
                doc = desktop.loadComponentFromURL(
                    to_file_url(work_pptx), "_blank", 0, (prop("Hidden", True),)
                )
                if doc is None:
                    raise EngineError("engine_error", "Failed to reopen presentation after reorder")
                summary.append({"type": "reorder_slides", "order": order})

            else:
                raise EngineError("invalid_argument", f"Unknown pptx edit operation: {kind}")

        ext = os.path.splitext(output_path)[1].lower()
        filter_name = "impress8" if ext == ".odp" else "Impress MS PowerPoint 2007 XML"
        tmp_path = store_with_temp(doc, output_path, [prop("FilterName", filter_name)])
        total_slides = doc.getDrawPages().getCount()
    finally:
        safe_close(doc)
        shutil.rmtree(work_dir, ignore_errors=True)
    commit_temp(tmp_path, output_path)
    return {"outputPath": output_path, "totalSlides": total_slides, "operations": summary}


def op_pptx_convert(desktop, params):
    path = params["path"]
    output_path = params["outputPath"]
    fmt = params["format"]
    filter_map = {
        "pdf": [prop("FilterName", "impress_pdf_Export")],
        "odp": [prop("FilterName", "impress8")],
    }
    if fmt not in filter_map:
        raise EngineError("invalid_argument", f"Unsupported pptx convert format: {fmt}")
    doc = None
    tmp_path = None
    try:
        doc = desktop.loadComponentFromURL(
            to_file_url(path), "_blank", 0, (prop("Hidden", True), prop("ReadOnly", True))
        )
        if doc is None:
            raise EngineError("engine_error", f"Could not open presentation: {path}")
        tmp_path = store_with_temp(doc, output_path, filter_map[fmt])
    finally:
        safe_close(doc)
    commit_temp(tmp_path, output_path)
    return {"outputPath": output_path, "format": fmt}


def op_pptx_render(smgr, desktop, params):
    path = params["path"]
    out_dir = params["outDir"]
    pages_list = params.get("pages")
    doc = None
    try:
        doc = desktop.loadComponentFromURL(
            to_file_url(path), "_blank", 0, (prop("Hidden", True), prop("ReadOnly", True))
        )
        if doc is None:
            raise EngineError("engine_error", f"Could not open presentation: {path}")
        return export_draw_pages(smgr, doc, out_dir, pages_list)
    finally:
        safe_close(doc)


# ==================== PDF (Draw / Convert) ====================


def op_pdf_create(desktop, params):
    input_path = params["inputPath"]
    output_path = params["outputPath"]
    ext = os.path.splitext(input_path)[1].lower()
    load_props = [prop("Hidden", True), prop("ReadOnly", True)]
    if ext in (".html", ".htm"):
        load_props.append(prop("FilterName", "HTML (StarWriter)"))
    doc = None
    tmp_path = None
    try:
        doc = desktop.loadComponentFromURL(to_file_url(input_path), "_blank", 0, tuple(load_props))
        if doc is None:
            raise EngineError("engine_error", f"Could not open source document: {input_path}")
        if doc.supportsService("com.sun.star.text.TextDocument") or doc.supportsService(
            "com.sun.star.text.WebDocument"
        ):
            pdf_filter = "writer_pdf_Export"
        elif doc.supportsService("com.sun.star.sheet.SpreadsheetDocument"):
            pdf_filter = "calc_pdf_Export"
        elif doc.supportsService("com.sun.star.presentation.PresentationDocument"):
            pdf_filter = "impress_pdf_Export"
        else:
            pdf_filter = "draw_pdf_Export"
        tmp_path = store_with_temp(doc, output_path, [prop("FilterName", pdf_filter)])
    finally:
        safe_close(doc)
    commit_temp(tmp_path, output_path)
    return {"outputPath": output_path}


def op_pdf_read(desktop, params):
    path = params["path"]
    pages_list = params.get("pages")
    doc = None
    try:
        doc = desktop.loadComponentFromURL(
            to_file_url(path),
            "_blank",
            0,
            (prop("Hidden", True), prop("ReadOnly", True), prop("FilterName", "draw_pdf_import")),
        )
        if doc is None:
            raise EngineError("engine_error", f"Could not open PDF: {path}")
        draw_pages = doc.getDrawPages()
        total = draw_pages.getCount()
        if pages_list:
            selected = select_pages(total, pages_list)
        else:
            selected = list(range(1, total + 1))
        extracted = []
        for pno in selected:
            page = draw_pages.getByIndex(pno - 1)
            lines = []
            for j in range(page.getCount()):
                sh = page.getByIndex(j)
                try:
                    txt = sh.getString()
                except Exception:
                    txt = ""
                if txt and txt.strip():
                    pos = sh.getPosition()
                    lines.append((pos.Y, pos.X, txt))
            lines.sort(key=lambda item: (round(item[0] / 250), item[1]))
            # Group items on approximately the same visual line
            merged_lines = []
            last_bucket = None
            buf = []
            for y, _x, txt in lines:
                bucket = round(y / 250)
                if last_bucket is None or bucket == last_bucket:
                    buf.append(txt)
                else:
                    merged_lines.append(" ".join(buf))
                    buf = [txt]
                last_bucket = bucket
            if buf:
                merged_lines.append(" ".join(buf))
            extracted.append({"page": pno, "text": "\n".join(merged_lines)})
        return {"totalPages": total, "pages": extracted}
    finally:
        safe_close(doc)


def op_pdf_render(smgr, desktop, params):
    path = params["path"]
    out_dir = params["outDir"]
    pages_list = params.get("pages")
    doc = None
    try:
        doc = desktop.loadComponentFromURL(
            to_file_url(path),
            "_blank",
            0,
            (prop("Hidden", True), prop("ReadOnly", True), prop("FilterName", "draw_pdf_import")),
        )
        if doc is None:
            raise EngineError("engine_error", f"Could not open PDF: {path}")
        return export_draw_pages(smgr, doc, out_dir, pages_list)
    finally:
        safe_close(doc)


def dispatch(ctx, smgr, desktop, op: str, params: dict):
    if op == "ping":
        return {"pong": True, "echo": params.get("echo")}
    if op == "docx_read":
        return op_docx_read(desktop, params)
    if op == "docx_create":
        return op_docx_create(desktop, params)
    if op == "docx_edit":
        return op_docx_edit(desktop, params)
    if op == "docx_convert":
        return op_docx_convert(desktop, params)
    if op == "docx_render":
        return op_docx_render(smgr, desktop, params)
    if op == "xlsx_read":
        return op_xlsx_read(desktop, params)
    if op == "xlsx_create":
        return op_xlsx_create(desktop, params)
    if op == "xlsx_edit":
        return op_xlsx_edit(desktop, params)
    if op == "xlsx_recalculate":
        return op_xlsx_recalculate(desktop, params)
    if op == "xlsx_convert":
        return op_xlsx_convert(desktop, params)
    if op == "xlsx_render":
        return op_xlsx_render(smgr, desktop, params)
    if op == "pptx_read":
        return op_pptx_read(desktop, params)
    if op == "pptx_create":
        return op_pptx_create(ctx, smgr, desktop, params)
    if op == "pptx_edit":
        return op_pptx_edit(ctx, smgr, desktop, params)
    if op == "pptx_convert":
        return op_pptx_convert(desktop, params)
    if op == "pptx_render":
        return op_pptx_render(smgr, desktop, params)
    if op == "pdf_create":
        return op_pdf_create(desktop, params)
    if op == "pdf_read":
        return op_pdf_read(desktop, params)
    if op == "pdf_render":
        return op_pdf_render(smgr, desktop, params)
    raise EngineError("invalid_argument", f"Unknown operation: {op}")


def main():
    pipe_name = None
    connect_timeout = 30.0
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        if args[i] == "--pipe" and i + 1 < len(args):
            pipe_name = args[i + 1]
            i += 2
        elif args[i] == "--connect-timeout" and i + 1 < len(args):
            connect_timeout = float(args[i + 1])
            i += 2
        else:
            i += 1
    if not pipe_name:
        write_json({"ready": False, "code": "invalid_argument", "error": "Missing --pipe argument"})
        sys.exit(1)

    try:
        ctx, smgr, desktop = connect_uno(pipe_name, timeout=connect_timeout)
    except EngineError as exc:
        write_json({"ready": False, "code": exc.code, "error": exc.message})
        sys.exit(1)
    except Exception as exc:
        write_json({"ready": False, "code": "engine_error", "error": str(exc)})
        sys.exit(1)

    write_json({"ready": True})

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            op = req.get("op")
            params = req.get("params") or {}
            if op == "shutdown":
                write_json({"id": req_id, "ok": True, "result": {"shutdown": True}})
                break
            result = dispatch(ctx, smgr, desktop, op, params)
            write_json({"id": req_id, "ok": True, "result": result})
        except EngineError as exc:
            write_json({"id": req_id, "ok": False, "code": exc.code, "error": exc.message})
        except Exception as exc:
            write_json({"id": req_id, "ok": False, "code": "engine_error", "error": str(exc)})


if __name__ == "__main__":
    main()
