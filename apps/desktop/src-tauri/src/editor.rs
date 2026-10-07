//! 用编辑器打开文件（U-09，方案 A）：检测 VS Code / Cursor 是否安装，
//! 带行号启动。系统默认程序与资源管理器显示走前端 opener 插件，这里只
//! 处理需要命令行参数（`-g file:line`）的编辑器。

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
    fn open_in_editor_rejects_relative_path() {
        let result = tauri::async_runtime::block_on(open_in_editor(
            "vscode".to_string(),
            "relative/path.ts".to_string(),
            None,
        ));
        assert!(result.is_err());
    }
}
