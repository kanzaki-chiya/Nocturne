//! 用编辑器打开文件（U-09，方案 A）：检测 VS Code / Cursor 是否安装，
//! 带行号启动；「系统默认程序」也经这里，先挡掉会直接执行的文件类型。
//! 资源管理器显示走前端 opener 插件。

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::backend::CommandError;

#[derive(Debug, Serialize)]
pub struct EditorAvailability {
    pub vscode: bool,
    pub cursor: bool,
}

/// 检测 VS Code / Cursor 是否可用：PATH 里的 `code.cmd` / `cursor.cmd`，
/// 或 Windows 默认安装位置。只读探测，不启动任何进程（`--version` 也不跑，
/// 避免冷启动编辑器后台）。
#[tauri::command]
pub async fn detect_editors() -> EditorAvailability {
    EditorAvailability {
        vscode: find_editor("code").is_some(),
        cursor: find_editor("cursor").is_some(),
    }
}

/// 用指定编辑器打开文件并跳到行号：`<exe> -g <file>:<line>`。
/// path 必须是绝对路径；目录只能用系统默认程序或资源管理器打开，
/// 这里拒绝（前端不应对目录提供"打开"入口）。
#[tauri::command]
pub async fn open_in_editor(editor: String, path: String, line: Option<u32>) -> Result<(), CommandError> {
    let target = PathBuf::from(&path);
    if !target.is_absolute() {
        return Err(CommandError::new("invalid_path", "文件路径必须是绝对路径"));
    }
    if target.is_dir() {
        return Err(CommandError::new(
            "is_directory",
            "目录请用「在资源管理器中显示」打开",
        ));
    }
    let exe = match editor.as_str() {
        "vscode" => find_editor("code")
            .ok_or_else(|| CommandError::new("editor_missing", "未检测到 VS Code"))?,
        "cursor" => find_editor("cursor")
            .ok_or_else(|| CommandError::new("editor_missing", "未检测到 Cursor"))?,
        _ => return Err(CommandError::new("invalid_editor", "未知的编辑器")),
    };
    let mut arg = path;
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
/// revealed = 文件类型会被直接执行，改为在资源管理器中显示。
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DefaultOpenOutcome {
    Opened,
    Revealed,
}

/// 用系统默认程序打开文件（U-09）。工作区里的脚本和可执行文件（`.bat`、
/// `.ps1`、`.py` 等）用默认方式"打开"就是执行，这类文件只在资源管理器中
/// 显示。path 必须是存在的绝对路径。
#[tauri::command]
pub async fn open_with_default(path: String) -> Result<DefaultOpenOutcome, CommandError> {
    let target = PathBuf::from(&path);
    if !target.is_absolute() {
        return Err(CommandError::new("invalid_path", "文件路径必须是绝对路径"));
    }
    // 真实路径也查一遍：`a.bat.` 这类尾点名、指向脚本的符号链接都按目标类型算
    let real = std::fs::canonicalize(&target)
        .map_err(|_| CommandError::new("not_found", "文件不存在"))?;
    let pathext = std::env::var("PATHEXT").ok();
    if launches_code(&target, pathext.as_deref()) || launches_code(&real, pathext.as_deref()) {
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
const LAUNCHING_EXTENSIONS: &[&str] = &[
    "exe", "com", "bat", "cmd", "ps1", "psm1", "psd1", "vbs", "vbe", "js", "jse", "wsf", "wsh",
    "msc", "msi", "msp", "msix", "msixbundle", "appx", "appxbundle", "appref-ms", "application",
    "py", "pyw", "pyz", "pyc", "cpl", "scr", "pif", "hta", "lnk", "url", "reg", "inf", "jar",
    "chm", "scf", "sct", "gadget", "settingcontent-ms", "library-ms", "search-ms", "diagcab",
];

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

fn find_editor(cmd: &str) -> Option<PathBuf> {
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
            "cursor" => &[&["Programs", "cursor", "resources", "app", "bin", "cursor.exe"]],
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

fn is_executable_file(path: &Path) -> bool {
    path.is_file()
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
        for name in ["run.bat", "a.PS1", "jc_check.py", "setup.exe", "x.lnk", "y.reg"] {
            assert!(launches_code(&tmp.join(name), None), "{name}");
        }
        assert!(launches_code(&tmp.join("tool.custom"), Some(".COM;.EXE;.CUSTOM")));
        for name in ["notes.md", "index.html", "a.ts", "Makefile", "image.png"] {
            assert!(!launches_code(&tmp.join(name), Some(".COM;.EXE;.BAT")), "{name}");
        }
        // 目录即使名字像脚本也不算（交给资源管理器打开）
        assert!(!launches_code(&tmp, Some(".COM;.EXE")));
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
