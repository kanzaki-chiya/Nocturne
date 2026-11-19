---
name: xlsx
description: 处理电子表格（Excel/.xlsx/.xls/.ods）：创建表格、读取工作表值与公式、编辑单元格与行列、重算公式、导出 PDF/CSV/ODS 及按页预览。Use for Excel spreadsheets and xlsx files.
---

# 电子表格处理（sheets MCP）

处理 `.xlsx`、`.xls`、`.ods` 等电子表格时使用本技能，所有路径参数必须传绝对路径。

## 可用工具（MCP 服务器 `sheets`）

- `read`：列出全部工作表及已用范围，读取指定工作表和区域（如 `"A1:F20"`）的计算值与公式（只读）。
- `create`：根据工作表列表与行数据生成 `.xlsx`（以 `=` 开头的字符串自动写为公式并重算）；目标已存在时需传 `overwrite: true`。
- `edit`：按顺序执行编辑操作（`set_cells` 写值或公式、`insert_rows` / `delete_rows` 增删行、`insert_columns` / `delete_columns` 增删列、`add_sheet` / `delete_sheet` / `rename_sheet` 管理工作表），保存前自动重算公式。默认原地保存，可传 `outputPath` 另存。
- `recalculate`：显式重新计算整个工作簿的全部公式并保存。
- `convert`：转换为 `pdf`、`csv`（一次性导出全部工作表）或 `ods`。
- `render`：按页导出 PNG 图片供视觉检查，默认返回前 4 页，可用 `pages` 指定页码（只读）。

## 推荐工作流

1. 修改前先调用 `read` 查看工作表名称、坐标与现有公式，避免覆盖公式单元格。
2. 用 `edit` 或 `create` 写入数据与公式，必要时再调用 `read` 核对公式重算后的数值。
3. 交付前调用 `render` 检查列宽、分页与中文显示效果，确认无截断或乱码后再交付。

## 依赖异常处理

- 返回 `libreoffice_not_found`：提示用户本机未检测到 LibreOffice，请前往 `https://www.libreoffice.org/download/` 下载安装后重试。
- 返回 `libreoffice_uno_unavailable`：说明本机已安装 LibreOffice 但缺少 Python UNO 绑定（Linux 需安装 `python3-uno` 包）；此时 `convert` 仍可通过命令行转换完成，读写单元格与重算需补齐 UNO 环境。
