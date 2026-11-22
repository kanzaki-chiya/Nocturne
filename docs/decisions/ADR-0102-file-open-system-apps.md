# ADR-0102：「文件」标签用系统建议的应用打开文件

- 状态：已接受
- 日期：2026-11-21
- 相关：[ADR-0060](ADR-0060-desktop-side-panel.md)（右侧面板，本 ADR 与其 2026-11-21 修订同轮）、[ADR-0046](ADR-0046-desktop-tauri.md)（`open_with_default` 防误执行，2026-10 修订）、[desktop.md 第 2 节与 5.10](../apps/desktop.md#510-右侧面板adr-0060)

## 背景

「文件」标签顶栏原有「只读」徽标和两个文字按钮：「用 VS Code 打开」（没有编辑器时是「用 Cursor 打开」或「用系统程序打开」）与 HTML 的「在浏览器标签打开」。用户希望改成 ZCode 那样的「打开」分裂按钮：左半直接用默认程序打开，右半弹出菜单，列出系统给这个文件建议的应用（和资源管理器右键「打开方式」里看到的一致），再加资源管理器、另存为、复制路径和换行开关。

列出「建议的应用」需要读系统的文件关联。ZCode 的做法是起 PowerShell 跑 C# 片段、再拼注册表命令行去执行；本仓库外壳已经依赖 `windows` crate（0.62.2），可以直接调 Shell 的 COM 接口，不必起子进程，也不必自己解析注册表里的命令行。

## 决定

### 1. 两个外壳命令

- `list_file_apps(path)` 返回 `{ apps: [{ id, name, iconDataUrl?, isDefault }], launchesCode, failed, editorIcons }`；
- `open_file_with_app(path, id, line?)` 用其中一个应用打开。

签名、错误码与图标规格见 [desktop.md 第 2 节](../apps/desktop.md#2-命令与消息格式)。约束：

- **系统是唯一事实源**。应用名用 `IAssocHandler::GetUIName`（系统界面上的名字），去重键用 `GetName`；默认程序取 `IApplicationAssociationRegistration::QueryCurrentDefault(扩展名, AT_FILEEXTENSION, AL_EFFECTIVE)`，与列表按 ProgID、再按可执行文件匹配，匹配到多个时不标默认。图标从 `GetIconLocation` 指向的文件里取，仓库里不放图标文件、不下载。
- **只读查询**。查询不写任何系统状态，不调用 `MakeDefault`，也不改文件关联。每次打开菜单都重新查，不做持久缓存：用户在系统里改了默认程序或装了新应用，下次打开菜单就能看到。
- **`id` 不暴露路径**。`id` 是去重键的 FNV-1a 64 散列（`app-` 加 16 位十六进制）。打开时外壳重新枚举、按 `id` 找回应用，不接受前端传来的程序路径或命令行；找不到报 `app_unavailable`，前端显示「无法打开此文件」。
- **只收存在的本地绝对文件路径**。空、相对、字面 UNC 路径报 `invalid_path`，不存在报 `not_found`，目录报 `is_directory`。
- **COM 在独立 STA 线程里跑**（`CoInitializeEx(COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE)`）。Shell 的关联处理器大多只支持单线程套间，Tauri 的异步命令线程不保证套间类型。打开走 `SHCreateItemFromParsingName` → `IShellItem::BindToHandler(BHID_DataObject)` → `IAssocHandler::Invoke`，与资源管理器「打开方式」的调用路径一致。
- **行号**。应用的可执行文件就是 `find_editor` 找到的 VS Code / Cursor（从 `bin\code.cmd` 一类命令往上找到真实的 `Code.exe` / `Cursor.exe`，按规范化后的真实路径比较）时，改走 `open_in_editor` 的 `-g 文件:行`，保留原来「带行号打开」的能力；其余应用只打开文件。

### 2. 防误执行沿用 ADR-0046

`open_with_default` 会改为「在资源管理器中显示」的脚本与可执行类型（PATHEXT 加固定清单，按原路径和真实路径各判一次），`list_file_apps` 返回空列表并带 `launchesCode: true`，`open_file_with_app` 直接拒绝。菜单的应用组这时只剩检测到的 VS Code / Cursor；左半「打开」交给 `open_with_default`，结果就是在资源管理器中显示。

理由：系统给 `.ps1`、`.bat`、`.py` 建议的应用里常有解释器本身（PowerShell、Python），点一下就是执行；这类文件在面板里本来就只读，查看和编辑交给编辑器足够。把例外做成「不列系统应用」，比逐个判断哪个处理器会执行更可靠。

### 3. 兜底

macOS 经 `NSWorkspace` 实现同一命令与防误运行规则（见 [ADR-0110](ADR-0110-macos-desktop.md) 第 7 节）。其他平台或查询本身出错（`failed: true`）时，应用组退回原来的做法：检测到的 VS Code / Cursor，加「系统默认程序」（`open_with_default`）。列表为空时外壳附带两种编辑器的程序图标（`editorIcons`），与系统应用用同一个取图标函数。

### 4. 与「默认打开方式」设置的关系

设置 › 常规的「默认打开方式」（Nocturne 面板 / 系统默认 / VS Code / Cursor）决定的是**对话里文件引用的左键**去哪儿，本轮不改。「打开」菜单是面板里已经打开的文件再交给外部程序，两者互不影响：左半「打开」总是系统默认程序（等同资源管理器里双击），不读这个设置。

## 后果

- 外壳新增依赖 `png`（0.18.1）与 `base64`（0.22.1）两个 crate，两者已在锁文件里（被 Tauri 间接依赖），只是改为直接依赖；`windows` crate 增加 `Win32_UI_Shell`、`Win32_UI_Shell_Common`、`Win32_Graphics_Gdi`、`Win32_UI_WindowsAndMessaging`、`Win32_System_Environment` 特性。
- COM 部分没有单元测试，靠实机核对；纯函数（排序、去重、`id`、路径校验、脚本返回空、从命令找 exe）有 Rust 单元测试。
- 应用名称由系统给出，可能是英文、带公司名或很长；菜单按已有样式显示，不截短改写。

## 备选方案

- **照搬 ZCode（PowerShell + C# + 注册表命令行）**：每次打开菜单都起一个 PowerShell 进程，慢且依赖执行策略；自己拼命令行容易在引号、`%1`、`%L` 上出错，也绕开了 Shell 处理器（UWP 应用、DelegateExecute）。放弃。
- **只列 VS Code / Cursor**：做不到「和系统打开方式一致」，放弃。
- **前端传可执行文件路径**：外壳就得信任前端给的程序路径，扩大了外壳的执行面，改为外壳自己按 `id` 重新查找。
