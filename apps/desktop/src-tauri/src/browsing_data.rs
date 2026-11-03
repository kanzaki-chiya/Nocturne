//! 设置 › 浏览器 › 浏览数据（ADR-0078）：用户浏览与 agent 浏览两个数据目录的占用大小与清除。
//!
//! 目录只经 [`crate::browser_policy::browser_data_dir`] / [`crate::browser_policy::agent_data_dir`]
//! 取得，隔离环境（`WEBVIEW2_USER_DATA_FOLDER`）下也一样；主界面的数据目录不在这里出现。
//!
//! 清除：目录被运行中的 WebView2 占着，不能直接删。用和标签相同的方式（同一个数据目录、
//! 默认环境选项）临时建一个隐藏 webview，接入同一个 WebView2 环境与 Profile，调
//! `ICoreWebView2Profile2::ClearBrowsingDataAll`，等完成回调后关掉它。cookie、本地存储、
//! IndexedDB、缓存等都在范围内；只作用于这个 Profile，另一个目录和主界面不受影响。
//! 已打开的标签不刷新，网页刷新后就是退出登录的状态。

use crate::backend::CommandError;
use crate::browser::BrowserState;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Manager};

type CmdResult<T> = Result<T, CommandError>;

/// 目录占用的字节数：递归加文件大小，不跟随符号链接与目录联接；目录不存在算 0，
/// 读不了的条目跳过（WebView2 正在写的文件也可能一时读不到）。
pub fn dir_size(root: &Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
                continue;
            };
            if meta.file_type().is_symlink() || is_reparse_point(&meta) {
                continue;
            }
            if meta.is_dir() {
                stack.push(entry.path());
            } else {
                total = total.saturating_add(meta.len());
            }
        }
    }
    total
}

#[cfg(windows)]
fn is_reparse_point(meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_: &std::fs::Metadata) -> bool {
    false
}

/// 哪一份浏览数据。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Which {
    User,
    Agent,
}

impl Which {
    fn parse(value: &str) -> CmdResult<Self> {
        match value {
            "user" => Ok(Self::User),
            "agent" => Ok(Self::Agent),
            _ => Err(CommandError::new("invalid_args", "未知的浏览数据")),
        }
    }
}

fn data_error(error: impl std::fmt::Display) -> CommandError {
    CommandError::new("browser_failed", format!("浏览数据操作失败：{error}"))
}

fn data_dir(app: &AppHandle, which: Which) -> CmdResult<PathBuf> {
    let state = app.state::<Arc<BrowserState>>();
    match which {
        Which::User => state.user_data_dir(app),
        Which::Agent => state.agent_data_dir(app),
    }
}

async fn size_of(dir: PathBuf) -> CmdResult<u64> {
    tauri::async_runtime::spawn_blocking(move || dir_size(&dir))
        .await
        .map_err(data_error)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sizes {
    user: u64,
    agent: u64,
}

/// 两份浏览数据的占用大小（异步，遍历目录不占主线程）。
#[tauri::command]
pub async fn browser_data_sizes(app: AppHandle) -> CmdResult<Sizes> {
    let user = data_dir(&app, Which::User)?;
    let agent = data_dir(&app, Which::Agent)?;
    Ok(Sizes {
        user: size_of(user).await?,
        agent: size_of(agent).await?,
    })
}

/// 同一时间只清一份
static CLEARING: AtomicBool = AtomicBool::new(false);
static NEXT_TEMP: AtomicU32 = AtomicU32::new(0);

/// 清完等这么久还没回调就算失败
const CLEAR_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// 清除一份浏览数据，返回清除后的实际大小（WebView2 的基础文件会留下，不一定是 0）。
#[tauri::command]
pub async fn browser_data_clear(app: AppHandle, which: String) -> CmdResult<u64> {
    let which = Which::parse(&which)?;
    let dir = data_dir(&app, which)?;
    if CLEARING.swap(true, Ordering::SeqCst) {
        return Err(CommandError::new("busy", "正在清除浏览数据"));
    }
    let result = clear(&app, which, &dir).await;
    CLEARING.store(false, Ordering::SeqCst);
    result?;
    size_of(dir).await
}

/// 临时 webview 的标签：capability 只认 `main`，与之错开，任何命令都过不了 ACL。
fn temp_label(which: Which) -> String {
    let kind = match which {
        Which::User => "user",
        Which::Agent => "agent",
    };
    format!(
        "nct-clear-{kind}-{}",
        NEXT_TEMP.fetch_add(1, Ordering::Relaxed) + 1
    )
}

#[cfg(windows)]
async fn clear(app: &AppHandle, which: Which, dir: &Path) -> CmdResult<()> {
    use tauri::{LogicalPosition, LogicalSize, WebviewBuilder, WebviewUrl};
    // 从来没用过：没有数据可清，也不为它新建目录
    if !dir.exists() {
        return Ok(());
    }
    let window = app
        .get_window("main")
        .ok_or_else(|| CommandError::new("browser_failed", "主窗口不存在"))?;
    // 环境选项必须和标签一致（只设数据目录），否则 WebView2 拒绝在同一目录建第二个环境
    let builder = WebviewBuilder::new(
        temp_label(which),
        WebviewUrl::External("about:blank".parse().map_err(data_error)?),
    )
    .data_directory(dir.to_path_buf())
    .focused(false);
    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(-20000.0, -20000.0),
            LogicalSize::new(1.0, 1.0),
        )
        .map_err(data_error)?;
    let _ = webview.hide();
    let (tx, rx) = std::sync::mpsc::channel();
    let started = webview
        .with_webview(move |platform| native::clear_all(&platform, tx))
        .map_err(data_error);
    let outcome = match started {
        Ok(()) => tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(CLEAR_TIMEOUT))
            .await
            .map_err(data_error)
            .and_then(|r| r.map_err(|_| CommandError::new("browser_failed", "清除浏览数据超时")))
            .and_then(|r| r.map_err(data_error)),
        Err(e) => Err(e),
    };
    crate::browser::close_later(webview);
    outcome
}

#[cfg(not(windows))]
async fn clear(_: &AppHandle, _: Which, _: &Path) -> CmdResult<()> {
    Err(CommandError::new(
        "browser_failed",
        "这个平台不支持清除浏览数据",
    ))
}

#[cfg(windows)]
mod native {
    use std::sync::mpsc::Sender;
    use webview2_com::ClearBrowsingDataCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use windows::core::Interface;

    /// 清掉这个 webview 所在 Profile 的全部浏览数据；结果经 `done` 送回。
    pub fn clear_all(platform: &tauri::webview::PlatformWebview, done: Sender<Result<(), String>>) {
        let tx = done.clone();
        // SAFETY: 主线程、有效的 WebView2 对象；回调闭包持有 tx 到完成
        let result = unsafe {
            (|| -> windows::core::Result<()> {
                let core = platform.controller().CoreWebView2()?;
                let profile = core
                    .cast::<ICoreWebView2_13>()?
                    .Profile()?
                    .cast::<ICoreWebView2Profile2>()?;
                profile.ClearBrowsingDataAll(&ClearBrowsingDataCompletedHandler::create(Box::new(
                    move |result| {
                        let _ = tx.send(result.map_err(|e| e.to_string()));
                        Ok(())
                    },
                )))
            })()
        };
        if let Err(e) = result {
            let _ = done.send(Err(e.to_string()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn size_of_missing_dir_is_zero() {
        let dir = std::env::temp_dir().join(format!("nct-size-missing-{}", std::process::id()));
        assert_eq!(dir_size(&dir), 0);
    }

    #[test]
    fn size_adds_nested_files() {
        let dir = std::env::temp_dir().join(format!("nct-size-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("a/b")).unwrap();
        std::fs::write(dir.join("x.bin"), vec![0u8; 1000]).unwrap();
        std::fs::write(dir.join("a/y.bin"), vec![0u8; 200]).unwrap();
        std::fs::write(dir.join("a/b/z.bin"), vec![0u8; 34]).unwrap();
        assert_eq!(dir_size(&dir), 1234);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn which_is_parsed_strictly() {
        assert_eq!(Which::parse("user").unwrap(), Which::User);
        assert_eq!(Which::parse("agent").unwrap(), Which::Agent);
        assert!(Which::parse("main").is_err());
        assert!(Which::parse("").is_err());
    }

    #[test]
    fn temp_webviews_never_get_the_main_label() {
        for which in [Which::User, Which::Agent] {
            let label = temp_label(which);
            assert!(label.starts_with("nct-clear-"));
            assert_ne!(label, "main");
        }
    }
}
