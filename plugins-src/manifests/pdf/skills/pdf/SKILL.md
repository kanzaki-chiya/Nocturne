---
name: pdf
description: 处理 PDF 文档：由 Word/Excel/PPT/HTML 生成 PDF、按页提取文本、按页出图预览、合并多个 PDF 及按页码范围拆分。Use for creating, reading, rendering, merging, or splitting PDF files.
---

# PDF 文档处理（pdf MCP）

生成、读取、预览、合并或拆分 `.pdf` 文档时使用本技能，所有路径参数必须传绝对路径。

## 可用工具（MCP 服务器 `pdf`）

- `create`：由 `.docx`、`.xlsx`、`.pptx`、`.html` 等文档生成 PDF；目标已存在时需传 `overwrite: true`。
- `read`：按页提取 PDF 中的文字内容，可选 `pages` 指定页码范围（只读）。
- `render`：按页导出 PNG 图片供视觉检查，默认返回前 4 页，可用 `pages`（如 `"1-4"`、`"5-8"`）指定页码（只读）。
- `merge`：无损合并多个 PDF 文件为单个 PDF；不依赖 LibreOffice。
- `split`：按页码范围（如 `"1-3"`、`"2,4-6"`）提取页面为新 PDF；不依赖 LibreOffice。
- `show_in_viewer`：在桌面端右侧面板打开 PDF 查看器，支持可选 `page`（1 起始初始页码），仅向模型返回文件名与页数摘要；不依赖 LibreOffice（只读）。

## 推荐工作流

1. 检查已有 PDF 时先用 `read` 提取文本，若含图表或复杂版式则做视觉检查。
2. 需要生成、合并或拆分时调用 `create`、`merge` 或 `split`。
3. 产出新 PDF 后交付前做视觉检查：优先用 `task` 调用本插件的 `visual-judge`（`profile: "pdf:visual-judge"`，在 `task` 中提供文件绝对路径、要检查的页码范围和用户要求），将其结论直接作为视觉检查结果，按不通过项修改后再交付；仅在 `pdf:visual-judge` 不可用时才自己调用 `render` 检查。两条路只走一条，不要先自己调用 `render` 看一遍再交给 `visual-judge`。

## 在面板中查看

- 创建、合并或拆分完 PDF 后，调用 `show_in_viewer` 在右侧面板向用户展示；更新文件后可再次调用 `show_in_viewer` 刷新查看器内容。
- 用户说「打开」「给我看看」某个 PDF 文档时，直接调用 `show_in_viewer`。
- `show_in_viewer` 只返回文件名与页数摘要；提取文字用 `read`，视觉排版检查走 `pdf:visual-judge`（不可用时改用 `render`）。

## 依赖异常处理

- 返回 `libreoffice_not_found`：提示用户本机未检测到 LibreOffice，请前往 `https://www.libreoffice.org/download/` 下载安装后重试（`merge` 与 `split` 不依赖 LibreOffice，可直接使用）。
- 返回 `libreoffice_uno_unavailable`：说明本机已安装 LibreOffice 但缺少 Python UNO 绑定（Linux 需安装 `python3-uno` 包）；此时 `create`、`merge`、`split` 仍可正常工作，文本提取与按页出图需补齐 UNO 环境。
