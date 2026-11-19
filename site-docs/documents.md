# 文档处理

Nocturne 内置四个文档处理插件，分别对应 Word 文档、电子表格、演示文档与 PDF，每个插件提供一个 MCP 服务器和一条同名技能，按需启动，默认开启。

| 插件 | 显示名 | MCP 服务器 | 技能 | 能力范围 |
|---|---|---|---|---|
| `docx` | Word 文档 | `word` | `docx` | 读取段落与表格、从 Markdown/HTML 新建、编辑正文/标题/表格、转换（PDF/ODT/HTML/TXT）、按页出图 |
| `xlsx` | 电子表格 | `sheets` | `xlsx` | 列出工作表并读取值与公式、新建表格、编辑单元格/行列/工作表、公式重算、转换（PDF/全表 CSV/ODS）、按页出图 |
| `pptx` | 演示文档 | `slides` | `pptx` | 读取每页文字与备注、新建幻灯片（含图片与备注）、替换文本、增删页与调整页序、转换（PDF/ODP）、按页出图 |
| `pdf` | PDF | `pdf` | `pdf` | 由 Word/Excel/PPT/HTML 生成 PDF、按页提取文本、按页出图、无损合并多个 PDF、按页码范围拆分 |

## 前置依赖

文档处理依赖本机已安装的 [LibreOffice](https://www.libreoffice.org/download/)（Nocturne 不自带 LibreOffice）：

- **Windows**：安装官方 LibreOffice，自动检测 `PATH` 或 `%ProgramFiles%\LibreOffice\program\soffice.com` 与同目录 `python.exe`。
- **macOS**：安装官方 `LibreOffice.app`，自动检测 `/Applications/LibreOffice.app/Contents/MacOS/soffice` 与 `Contents/Resources/python`。
- **Linux**：安装 `libreoffice` 与 `python3-uno`（例如 Debian/Ubuntu 执行 `sudo apt install libreoffice python3-uno`）。

支持通过环境变量覆盖可执行文件路径：`NOCTURNE_OFFICE_SOFFICE` 指定 `soffice` 绝对路径，`NOCTURNE_OFFICE_PYTHON` 指定带 `uno` 模块的 Python 绝对路径。

未安装 LibreOffice 时，依赖 LibreOffice 的工具会返回错误码 `libreoffice_not_found`（`pdf` 的 `merge` 与 `split` 不依赖 LibreOffice，仍可直接使用）。缺少 UNO 绑定时返回 `libreoffice_uno_unavailable`，仅靠命令行转换完成的工具（`docx.convert`、`docx.create`、`xlsx.convert`、`pptx.convert`、`pdf.create`）照常工作。

## 通用规则

- **绝对路径**：所有文件路径参数均须传入绝对路径。
- **防误覆盖**：写文件工具在目标文件已存在且未传 `overwrite: true` 时拒绝写入（返回 `file_exists`）。`edit` 与 `recalculate` 默认原地保存；传入不同的 `outputPath` 时同样受 `overwrite` 保护。
- **按页出图（`render`）**：以 PNG 图片形式返回供模型查看，缺省返回前 4 页，单次最多返回 4 页；可通过 `pages`（如 `"1"`、`"1-4"`、`"5-8"`）分批查看其余页。
- **进程生命周期**：`soffice` 与 Python UNO 辅助进程在首次调用时按需启动，使用独立临时配置目录（不连接用户打开的 LibreOffice），同一服务器内串行执行，闲置 5 分钟自动退出，单次调用超时 120 秒并终止进程树。

## 工具与参数

### Word 文档（`word`）

| 工具 | 只读 | 主要参数 | 说明 |
|---|---|---|---|
| `read` | 是 | `path` | 读取段落（索引、文本、标题级别、样式）与表格 |
| `create` | 否 | `outputPath`, `content`, `format?` (`"markdown"` \| `"html"`), `title?`, `overwrite?` | 从 Markdown（默认）或 HTML 新建 `.docx` |
| `edit` | 否 | `path`, `operations`, `outputPath?`, `overwrite?` | 顺序执行 `replace`、`insert_paragraph`、`delete_paragraph`、`set_heading`、`insert_table` |
| `convert` | 否 | `path`, `outputPath`, `format` (`"pdf"` \| `"odt"` \| `"html"` \| `"txt"`), `overwrite?` | 转换为指定格式（`txt` 为 UTF-8） |
| `render` | 是 | `path`, `pages?` | 按页导出 PNG 供视觉检查（默认前 4 页） |

### 电子表格（`sheets`）

| 工具 | 只读 | 主要参数 | 说明 |
|---|---|---|---|
| `read` | 是 | `path`, `sheet?`, `range?` | 列出工作表及已用范围，读取指定工作表与区域的值和公式 |
| `create` | 否 | `outputPath`, `sheets` (`[{ name, rows }]`), `overwrite?` | 新建 `.xlsx`，以 `=` 开头的字符串写为公式并重算 |
| `edit` | 否 | `path`, `operations`, `outputPath?`, `overwrite?` | 顺序执行 `set_cells`、`insert_rows`、`delete_rows`、`insert_columns`、`delete_columns`、`add_sheet`、`delete_sheet`、`rename_sheet` 并重算 |
| `recalculate` | 否 | `path`, `outputPath?`, `overwrite?` | 重新计算全部公式并保存 |
| `convert` | 否 | `path`, `outputPath`, `format` (`"pdf"` \| `"csv"` \| `"ods"`), `overwrite?` | 转换格式；`csv` 一次导出全部工作表（`<文件名>-<表名>.csv`） |
| `render` | 是 | `path`, `pages?` | 按页导出 PNG 供视觉检查（默认前 4 页） |

### 演示文档（`slides`）

| 工具 | 只读 | 主要参数 | 说明 |
|---|---|---|---|
| `read` | 是 | `path` | 读取总页数以及每页文字和演讲者备注 |
| `create` | 否 | `outputPath`, `slides` (`[{ title?, bullets?, body?, imagePath?, notes? }]`), `overwrite?` | 新建 `.pptx` 并嵌入指定本地图片与备注 |
| `edit` | 否 | `path`, `operations`, `outputPath?`, `overwrite?` | 顺序执行 `replace`、`add_slide`、`delete_slide`、`reorder_slides` |
| `convert` | 否 | `path`, `outputPath`, `format` (`"pdf"` \| `"odp"`), `overwrite?` | 转换为 PDF 或 ODP |
| `render` | 是 | `path`, `pages?` | 按页导出幻灯片 PNG 供视觉检查（默认前 4 页） |

### PDF（`pdf`）

| 工具 | 只读 | 主要参数 | 说明 |
|---|---|---|---|
| `create` | 否 | `inputPath`, `outputPath`, `overwrite?` | 由 `.docx`、`.xlsx`、`.pptx`、`.html` 等生成 PDF |
| `read` | 是 | `path`, `pages?` | 按页提取 PDF 文本（可选 1 起始页码范围） |
| `render` | 是 | `path`, `pages?` | 按页导出 PNG 供视觉检查（默认前 4 页） |
| `merge` | 否 | `inputPaths`, `outputPath`, `overwrite?` | 无损合并多个 PDF（不依赖 LibreOffice） |
| `split` | 否 | `path`, `pages`, `outputPath`, `overwrite?` | 按 1 起始页码范围拆分提取为新 PDF（不依赖 LibreOffice） |

## 停用插件

四个文档插件默认开启，且按需启动（不使用文档工具的会话不会拉起进程）。如不需要某些格式，可在「设置 › 插件」中找到对应的内置插件（Word 文档、电子表格、演示文档、PDF）分别关闭；关闭后其 MCP 工具与技能即从新会话中移除。详见 [插件](plugins.md)。
