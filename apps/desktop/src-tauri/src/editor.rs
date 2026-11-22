//! 用编辑器打开文件（U-09，方案 A）：检测 VS Code / Cursor 是否安装，
//! 带行号启动；「系统默认程序」也经这里，先挡掉会直接执行的文件类型。
//! 资源管理器 / 访达显示走前端 opener 插件。

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::backend::CommandError;

#[derive(Debug, Serialize)]
pub struct EditorAvailability {
    pub vscode: bool,
    pub cursor: bool,
}

/// 检测 VS Code / Cursor 是否可用：PATH 里的命令，或平台默认安装位置。
/// 只读探测，不启动任何进程（`--version` 也不跑，避免冷启动编辑器后台）。
#[tauri::command]
pub async fn detect_editors() -> EditorAvailability {
    EditorAvailability {
        vscode: find_editor("code").is_some(),
        cursor: find_editor("cursor").is_some(),
    }
}

/// 用指定编辑器打开文件并跳到行号：`<exe> -g <file>:<line>`。
/// path 必须是绝对路径；目录只能用系统默认程序或文件管理器打开，
/// 这里拒绝（前端不应对目录提供"打开"入口）。
#[tauri::command]
pub async fn open_in_editor(
    editor: String,
    path: String,
    line: Option<u32>,
) -> Result<(), CommandError> {
    let target = PathBuf::from(&path);
    if !target.is_absolute() {
        return Err(CommandError::new("invalid_path", "文件路径必须是绝对路径"));
    }
    if target.is_dir() {
        let msg = if cfg!(target_os = "macos") {
            "目录请用「在访达中显示」打开"
        } else {
            "目录请用「在资源管理器中显示」打开"
        };
        return Err(CommandError::new("is_directory", msg));
    }
    launch_editor(&editor, &path, line)
}

/// 用 VS Code / Cursor 打开文件并跳到行号（`<exe> -g <file>:<line>`）；
/// `open_in_editor` 与「打开」菜单里的系统应用（file_apps.rs）共用。
pub(crate) fn launch_editor(
    editor: &str,
    path: &str,
    line: Option<u32>,
) -> Result<(), CommandError> {
    let exe = match editor {
        "vscode" => find_editor("code")
            .ok_or_else(|| CommandError::new("editor_missing", "未检测到 VS Code"))?,
        "cursor" => find_editor("cursor")
            .ok_or_else(|| CommandError::new("editor_missing", "未检测到 Cursor"))?,
        _ => return Err(CommandError::new("invalid_editor", "未知的编辑器")),
    };
    let mut arg = path.to_string();
    if let Some(line) = line {
        arg = format!("{arg}:{line}");
    }
    std::process::Command::new(exe)
        .arg("-g")
        .arg(&arg)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| CommandError::new("spawn_failed", format!("无法启动编辑器：{e}")))?;
    Ok(())
}

/// `open_with_default` 的结果：opened = 已交给系统默认程序；
/// revealed = 文件类型会被直接执行，改为在文件管理器（资源管理器 / 访达）中显示。
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DefaultOpenOutcome {
    Opened,
    Revealed,
}

/// 用系统默认程序打开文件（U-09）。工作区里的脚本和可执行文件用默认方式"打开"
/// 就是执行或安装，这类文件只在文件管理器中显示。path 必须是存在的绝对路径。
#[tauri::command]
pub async fn open_with_default(path: String) -> Result<DefaultOpenOutcome, CommandError> {
    let target = PathBuf::from(&path);
    if !target.is_absolute() {
        return Err(CommandError::new("invalid_path", "文件路径必须是绝对路径"));
    }
    std::fs::canonicalize(&target).map_err(|_| CommandError::new("not_found", "文件不存在"))?;
    // 真实路径也查一遍：Windows 的尾点名、指向脚本或可执行文件的符号链接都按目标类型算
    if launches_code_any(&target) {
        tauri_plugin_opener::reveal_item_in_dir(&target)
            .map_err(|e| CommandError::new("open_failed", format!("无法显示文件：{e}")))?;
        return Ok(DefaultOpenOutcome::Revealed);
    }
    tauri_plugin_opener::open_path(&target, None::<&str>)
        .map_err(|e| CommandError::new("open_failed", format!("无法打开文件：{e}")))?;
    Ok(DefaultOpenOutcome::Opened)
}

/// 用 Windows 外壳默认方式打开就会执行代码的扩展名：PATHEXT 里的全部，
/// 加上 PATHEXT 通常不含、但默认关联仍会运行或安装的类型。目录不算。
#[rustfmt::skip]
const LAUNCHING_EXTENSIONS: &[&str] = &[
    "exe", "com", "bat", "cmd", "ps1", "psm1", "psd1", "vbs", "vbe", "js", "jse", "wsf", "wsh",
    "msc", "msi", "msp", "msix", "msixbundle", "appx", "appxbundle", "appref-ms", "application",
    "py", "pyw", "pyz", "pyc", "cpl", "scr", "pif", "hta", "lnk", "url", "reg", "inf", "jar",
    "chm", "scf", "sct", "gadget", "settingcontent-ms", "library-ms", "search-ms", "diagcab",
];

/// macOS 上可能是目录包（bundle）也可能是扁平文件、用默认方式打开就会启动或安装的类型：
/// - `.app`：应用程序包，Launch Services 直接运行包内可执行文件；
/// - `.pkg` / `.mpkg`：安装器包 / 元包，默认由「安装器」打开并可执行安装脚本；
/// - `.workflow` / `.action`：Automator 工作流程 / 可加载操作包，打开可触发安装或运行。
const MACOS_BUNDLE_LAUNCHING_EXTENSIONS: &[&str] = &["app", "pkg", "mpkg", "workflow", "action"];

/// macOS 上普通文件用默认方式打开就会在「终端」里执行命令的扩展名：
/// - `.command` / `.tool`：Terminal.app 关联的 shell 脚本，双击直接在新终端窗口运行；
/// - `.terminal`：Terminal.app 窗口配置文件（plist），含 `CommandString` 时打开即执行命令。
const MACOS_FILE_LAUNCHING_EXTENSIONS: &[&str] = &["command", "tool", "terminal"];

/// 常见无扩展名纯文本文档：即便从其他文件系统带入 `+x` 位，也视为已知文档而非可执行文件。
const MACOS_KNOWN_DOC_NAMES: &[&str] = &[
    "readme",
    "license",
    "licence",
    "copying",
    "notice",
    "authors",
    "changelog",
    "todo",
];

/// 原路径和真实路径各判一次（`a.bat.` 这类尾点名、指向脚本或可执行文件的符号链接按目标类型算）；
/// `open_with_default` 与 file_apps.rs 共用。
pub(crate) fn launches_code_any(path: &Path) -> bool {
    #[cfg(target_os = "macos")]
    {
        launches_code_macos_path(path)
            || std::fs::canonicalize(path).is_ok_and(|real| launches_code_macos_path(&real))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let pathext = std::env::var("PATHEXT").ok();
        launches_code(path, pathext.as_deref())
            || std::fs::canonicalize(path).is_ok_and(|real| launches_code(&real, pathext.as_deref()))
    }
}

#[cfg_attr(target_os = "macos", allow(dead_code))]
fn launches_code(path: &Path, pathext: Option<&str>) -> bool {
    if path.is_dir() {
        return false;
    }
    let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
        return false;
    };
    let ext = ext.to_ascii_lowercase();
    if LAUNCHING_EXTENSIONS.contains(&ext.as_str()) {
        return true;
    }
    pathext.is_some_and(|list| {
        list.split(';')
            .filter_map(|item| item.trim().strip_prefix('.'))
            .any(|item| item.eq_ignore_ascii_case(&ext))
    })
}

#[cfg(target_os = "macos")]
fn launches_code_macos_path(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    let (is_dir, is_executable) = match std::fs::metadata(path) {
        Ok(meta) => (
            meta.is_dir(),
            meta.is_file() && (meta.permissions().mode() & 0o111 != 0),
        ),
        Err(_) => (false, false),
    };
    launches_code_macos(path, is_dir, is_executable)
}

/// macOS 防误运行纯函数（ADR-0046、ADR-0110）：
/// 1. `.app` / `.pkg` / `.mpkg` / `.workflow` / `.action`（无论目录包还是扁平文件）；
/// 2. 普通文件里的 `.command` / `.tool` / `.terminal`；
/// 3. 带可执行位、无扩展名且不是已知文本文档名的普通文件（Finder 按 `public.unix-executable` 在终端运行）。
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
pub(crate) fn launches_code_macos(path: &Path, is_dir: bool, is_executable: bool) -> bool {
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        let ext = ext.to_ascii_lowercase();
        if MACOS_BUNDLE_LAUNCHING_EXTENSIONS.contains(&ext.as_str()) {
            return true;
        }
        if is_dir {
            return false;
        }
        return MACOS_FILE_LAUNCHING_EXTENSIONS.contains(&ext.as_str());
    }
    if is_dir || !is_executable {
        return false;
    }
    let known_doc = path
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|name| {
            MACOS_KNOWN_DOC_NAMES
                .iter()
                .any(|known| name.eq_ignore_ascii_case(known))
        });
    !known_doc
}

/// macOS 上 VS Code 的官方 CFBundleIdentifier（microsoft/vscode product.json）。
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
pub(crate) const MACOS_VSCODE_BUNDLE_ID: &str = "com.microsoft.VSCode";

/// macOS 上 Cursor 的官方 CFBundleIdentifier（ToDesktop 打包标识，官方确认长期不变）。
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
pub(crate) const MACOS_CURSOR_BUNDLE_ID: &str = "com.todesktop.230313mzl4w4u92";

/// 按 macOS bundle identifier 识别 VS Code / Cursor，返回 `(editor_name, cli_cmd)`。
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
pub(crate) fn macos_editor_for_bundle_id(bundle_id: &str) -> Option<(&'static str, &'static str)> {
    let trimmed = bundle_id.trim();
    if trimmed.eq_ignore_ascii_case(MACOS_VSCODE_BUNDLE_ID) {
        Some(("vscode", "code"))
    } else if trimmed.eq_ignore_ascii_case(MACOS_CURSOR_BUNDLE_ID) {
        Some(("cursor", "cursor"))
    } else {
        None
    }
}

/// VS Code / Cursor macOS 应用包内的命令行可执行文件相对路径：
/// `<App>.app/Contents/Resources/app/bin/<cmd>`。
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
pub(crate) fn macos_editor_cli_in_bundle(bundle: &Path, cmd: &str) -> PathBuf {
    bundle
        .join("Contents")
        .join("Resources")
        .join("app")
        .join("bin")
        .join(cmd)
}

/// 从包内命令行路径向上找 `.app` 包根（如 `…/Visual Studio Code.app/Contents/Resources/app/bin/code`
/// → `…/Visual Studio Code.app`）。
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
pub(crate) fn macos_app_bundle_ancestor(path: &Path) -> Option<PathBuf> {
    path.ancestors()
        .find(|dir| {
            dir.extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("app"))
        })
        .map(Path::to_path_buf)
}

#[cfg(target_os = "macos")]
pub(crate) fn macos_editor_bundle(cmd: &str) -> Option<PathBuf> {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::NSString;

    let (bundle_id, app_name) = match cmd {
        "code" => (MACOS_VSCODE_BUNDLE_ID, "Visual Studio Code.app"),
        "cursor" => (MACOS_CURSOR_BUNDLE_ID, "Cursor.app"),
        _ => return None,
    };
    let ws = NSWorkspace::sharedWorkspace();
    let id = NSString::from_str(bundle_id);
    if let Some(url) = ws.URLForApplicationWithBundleIdentifier(&id) {
        if let Some(path) = url.path() {
            let bundle = PathBuf::from(path.to_string());
            if bundle.is_dir() {
                return Some(bundle);
            }
        }
    }
    let system_app = PathBuf::from("/Applications").join(app_name);
    if system_app.is_dir() {
        return Some(system_app);
    }
    if let Some(home) = std::env::home_dir() {
        let user_app = home.join("Applications").join(app_name);
        if user_app.is_dir() {
            return Some(user_app);
        }
    }
    None
}

pub(crate) fn find_editor(cmd: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        // PATH 里找 `code.cmd` / `cursor.cmd`（.cmd 由 volta/nvm 类垫片与官方安装程序提供）
        if let Some(paths) = std::env::var_os("PATH") {
            for dir in std::env::split_paths(&paths) {
                for name in [format!("{cmd}.cmd"), format!("{cmd}.exe"), cmd.to_string()] {
                    let candidate = dir.join(&name);
                    if is_executable_file(&candidate) {
                        return Some(candidate);
                    }
                }
            }
        }
        // Windows 默认安装位置
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let local = PathBuf::from(local);
            let candidates: &[&[&str]] = match cmd {
                "code" => &[
                    &["Programs", "Microsoft VS Code", "bin", "code.cmd"],
                    &["Programs", "Microsoft VS Code", "Code.exe"],
                ],
                "cursor" => &[&[
                    "Programs",
                    "cursor",
                    "resources",
                    "app",
                    "bin",
                    "cursor.exe",
                ]],
                _ => &[],
            };
            for parts in candidates {
                let mut candidate = local.clone();
                for part in *parts {
                    candidate = candidate.join(part);
                }
                if is_executable_file(&candidate) {
                    return Some(candidate);
                }
            }
        }
        None
    }

    #[cfg(target_os = "macos")]
    {
        if let Some(paths) = std::env::var_os("PATH") {
            for dir in std::env::split_paths(&paths) {
                let candidate = dir.join(cmd);
                if is_executable_file(&candidate) {
                    return Some(candidate);
                }
            }
        }
        // 从访达启动时外壳进程自身的 PATH 不含 Homebrew / `/usr/local/bin`
        for dir in ["/opt/homebrew/bin", "/usr/local/bin"] {
            let candidate = Path::new(dir).join(cmd);
            if is_executable_file(&candidate) {
                return Some(candidate);
            }
        }
        // 直接查应用包内的 CLI（不依赖用户是否跑过「Install 'code' command in PATH」）
        if let Some(bundle) = macos_editor_bundle(cmd) {
            let candidate = macos_editor_cli_in_bundle(&bundle, cmd);
            if is_executable_file(&candidate) {
                return Some(candidate);
            }
        }
        None
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    {
        if let Some(paths) = std::env::var_os("PATH") {
            for dir in std::env::split_paths(&paths) {
                let candidate = dir.join(cmd);
                if is_executable_file(&candidate) {
                    return Some(candidate);
                }
            }
        }
        None
    }
}

fn is_executable_file(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .is_ok_and(|meta| meta.is_file() && (meta.permissions().mode() & 0o111 != 0))
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_editor_missing_returns_none() {
        // 不存在的命令名永远返回 None（不碰真实 PATH 之外的东西）
        assert!(find_editor("nocturne-definitely-not-an-editor").is_none());
    }

    #[test]
    fn launches_code_blocks_scripts_and_pathext() {
        let tmp = std::env::temp_dir();
        for name in [
            "run.bat",
            "a.PS1",
            "jc_check.py",
            "setup.exe",
            "x.lnk",
            "y.reg",
        ] {
            assert!(launches_code(&tmp.join(name), None), "{name}");
        }
        assert!(launches_code(
            &tmp.join("tool.custom"),
            Some(".COM;.EXE;.CUSTOM")
        ));
        for name in ["notes.md", "index.html", "a.ts", "Makefile", "image.png"] {
            assert!(
                !launches_code(&tmp.join(name), Some(".COM;.EXE;.BAT")),
                "{name}"
            );
        }
        // 目录即使名字像脚本也不算（交给资源管理器打开）
        assert!(!launches_code(&tmp, Some(".COM;.EXE")));
    }

    #[test]
    fn launches_code_macos_blocks_terminal_bundles_and_execs() {
        // 终端脚本与配置
        for name in ["start.command", "RUN.TOOL", "profile.terminal"] {
            assert!(
                launches_code_macos(Path::new(name), false, false),
                "expected blocked: {name}"
            );
        }
        // 应用与安装包（扁平文件或目录包均拦）
        for name in [
            "MyApp.app",
            "Installer.pkg",
            "Suite.mpkg",
            "Quick.workflow",
            "Step.action",
        ] {
            assert!(
                launches_code_macos(Path::new(name), true, false),
                "expected bundle blocked: {name}"
            );
            assert!(
                launches_code_macos(Path::new(name), false, false),
                "expected flat blocked: {name}"
            );
        }
        // 无扩展名且带可执行位 → 拦；不带可执行位 → 放行
        assert!(launches_code_macos(Path::new("my-binary"), false, true));
        assert!(!launches_code_macos(Path::new("my-binary"), false, false));
        // 已知文档名即便带可执行位也放行
        for name in ["README", "LICENSE", "CHANGELOG", "NOTICE"] {
            assert!(
                !launches_code_macos(Path::new(name), false, true),
                "expected known doc allowed: {name}"
            );
        }
        // 有普通扩展名（即使带 +x）与普通目录 → 放行
        for name in ["notes.md", "index.html", "a.ts", "image.png", "script.sh"] {
            assert!(
                !launches_code_macos(Path::new(name), false, true),
                "expected regular extension allowed: {name}"
            );
        }
        assert!(!launches_code_macos(Path::new("my-folder"), true, true));
        assert!(!launches_code_macos(Path::new("dir.command"), true, false));
    }

    #[test]
    fn macos_editor_bundle_helpers_recognize_vscode_and_cursor() {
        assert_eq!(
            macos_editor_for_bundle_id("com.microsoft.VSCode"),
            Some(("vscode", "code"))
        );
        assert_eq!(
            macos_editor_for_bundle_id("com.todesktop.230313mzl4w4u92"),
            Some(("cursor", "cursor"))
        );
        assert_eq!(macos_editor_for_bundle_id("com.apple.TextEdit"), None);

        let bundle = Path::new("/Applications/Visual Studio Code.app");
        let cli = macos_editor_cli_in_bundle(bundle, "code");
        assert!(cli.ends_with("Contents/Resources/app/bin/code") || cli.ends_with(r"Contents\Resources\app\bin\code"));
        assert_eq!(macos_app_bundle_ancestor(&cli).as_deref(), Some(bundle));
        assert_eq!(macos_app_bundle_ancestor(Path::new("/usr/local/bin/code")), None);
    }

    #[test]
    fn open_with_default_rejects_relative_path() {
        let result = tauri::async_runtime::block_on(open_with_default("a/b.md".to_string()));
        assert!(result.is_err());
    }

    #[test]
    fn open_in_editor_rejects_relative_path() {
        let result = tauri::async_runtime::block_on(open_in_editor(
            "vscode".to_string(),
            "relative/path.ts".to_string(),
            None,
        ));
        assert!(result.is_err());
    }
}
