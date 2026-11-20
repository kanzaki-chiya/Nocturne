---
name: pptx
description: 处理演示文档（PPT/PowerPoint/.pptx/.odp）：创建幻灯片、读取页面文字与演讲者备注、替换文本、增删与重排页面、转换 PDF/ODP 及按页出图预览。Use for slides, PPT, or pptx files.
---

# 演示文档处理（slides MCP）

处理 `.pptx`、`.ppt`、`.odp` 等演示文稿时使用本技能，所有路径参数必须传绝对路径。

## 可用工具（MCP 服务器 `slides`）

- `read`：读取总页数以及每页幻灯片的文字内容与演讲者备注（只读）。
- `create`：按页列表（每页支持 `title`、`bullets`、`body`、可选本地图片 `imagePath` 与 `notes`）生成 `.pptx`；目标已存在时需传 `overwrite: true`。
- `edit`：按顺序执行编辑操作（`replace` 替换全篇或指定页文本、`add_slide` 插入页面、`delete_slide` 删除页面、`reorder_slides` 按 1 起始页码序列调整页序）。默认原地保存，可传 `outputPath` 另存。
- `convert`：转换为 `pdf` 或 `odp`。
- `render`：按页导出幻灯片 PNG 图片供视觉检查，默认返回前 4 页，可用 `pages`（如 `"1-4"`、`"5-8"`）指定页码（只读）。
- `show_in_viewer`：在桌面端右侧面板打开文档查看器，支持可选 `page`（1 起始初始页码），仅向模型返回文件名与页数摘要（只读）。

## 推荐工作流

1. 修改前先调用 `read` 了解总页数、各页文案与备注。
2. 用 `edit` 修改或 `create` 生成演示文稿。
3. 完成后务必调用 `render` 逐页检查文字溢出、图片遮挡与中文排版，修正问题后再交付。

## 在面板中查看

- 创建或编辑完演示文稿后，调用 `show_in_viewer` 在右侧面板向用户展示；再次修改后可再次调用 `show_in_viewer` 刷新查看器内容。
- 用户说「打开」「给我看看」某个演示文稿时，直接调用 `show_in_viewer`。
- `show_in_viewer` 只返回文件名与页数摘要；模型要检查页面排版仍使用 `render`。

## 依赖异常处理

- 返回 `libreoffice_not_found`：提示用户本机未检测到 LibreOffice，请前往 `https://www.libreoffice.org/download/` 下载安装后重试。
- 返回 `libreoffice_uno_unavailable`：说明本机已安装 LibreOffice 但缺少 Python UNO 绑定（Linux 需安装 `python3-uno` 包）；此时 `convert` 仍可通过命令行转换完成，读取、编辑与出图需补齐 UNO 环境。
