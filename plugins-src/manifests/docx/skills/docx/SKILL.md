---
name: docx
description: 处理 Word 文档（.docx/.doc/.odt）：创建、读取段落与表格、编辑正文和标题、格式转换（PDF/HTML/ODT/TXT）及按页出图预览。Use when working with Word documents or docx files.
---

# Word 文档处理（word MCP）

处理 `.docx`、`.doc`、`.odt` 等文字文档时使用本技能，所有路径参数必须传绝对路径。

## 可用工具（MCP 服务器 `word`）

- `read`：读取文档的全部段落（含索引、文本与标题级别）及表格内容（只读）。
- `create`：从 Markdown（默认）或 HTML 生成新的 `.docx` 文件；目标已存在时需传 `overwrite: true`。
- `edit`：按顺序执行编辑操作（`replace` 替换文本、`insert_paragraph` 插入段落、`delete_paragraph` 删除段落、`set_heading` 设置标题级别、`insert_table` 插入表格）。默认原地保存，也可传 `outputPath` 另存。
- `convert`：转换为 `pdf`、`odt`、`html`、`txt`（UTF-8）。
- `render`：按页导出 PNG 图片供视觉检查，默认返回前 4 页，可用 `pages`（如 `"1-4"`、`"5-8"`）指定页码（只读）。

## 推荐工作流

1. 修改既有文档前先调用 `read`，确认段落索引、标题层级与表格结构。
2. 用 `edit` 修改或 `create` 生成文档。
3. 完成后调用 `render` 查看实际分页、排版、表格与中文字体效果；若有错位或遗漏继续调整，再交付给用户。

## 依赖异常处理

- 返回 `libreoffice_not_found`：提示用户本机未检测到 LibreOffice，请前往 `https://www.libreoffice.org/download/` 下载安装后重试。
- 返回 `libreoffice_uno_unavailable`：说明本机已安装 LibreOffice 但缺少 Python UNO 绑定（Linux 需安装 `python3-uno` 包）；此时 `convert` 与从 HTML/Markdown `create` 仍可通过命令行转换使用，读取、编辑与出图需补齐 UNO 环境。
