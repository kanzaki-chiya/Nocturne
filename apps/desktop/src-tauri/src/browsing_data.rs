//! 设置 › 浏览器 › 浏览数据（ADR-0078、ADR-0110）：用户浏览与 agent 浏览两份数据的占用大小与清除。
//!
//! - **Windows**：目录只经 [`crate::browser_policy::browser_data_dir`] /
//!   [`crate::browser_policy::agent_data_dir`] 取得，隔离环境（`WEBVIEW2_USER_DATA_FOLDER`）下
//!   也一样；主界面的数据目录不在这里出现。清除时临时建一个挂到同一数据目录的隐藏 webview，
//!   调 `ICoreWebView2Profile2::ClearBrowsingDataAll`，等完成回调后经 `close_later` 关掉。
//! - **macOS**：WKWebView 按 16 字节 `data_store_identifier`（[`crate::browser_policy::browser_data_store_id`] /
//!   [`crate::browser_policy::agent_data_store_id`]）隔离，拿不到占用大小。清除时临时建一个
//!   挂到对应 `data_store_identifier` 的隐藏 webview，经 `with_webview` 取 `WKWebView` 对应的
//!   `WKWebsiteDataStore`，直接调用 `removeDataOfTypes:modifiedSince:completionHandler:` 等异步
//!   完成回调后再经 `close_later` 关掉（不用 wry 的 `clear_all_browsing_data`，后者传空回调后
//!   立刻返回，不等删除完成）。
//!
//! 已打开的标签不刷新，网页刷新后就是退出登录的状态；主界面与另一份存储不受影响。

use crate::backend::CommandError;
use crate::browser::BrowserState;
use serde::Serialize;
use std::path::Path;
#[cfg(not(target_os = "macos"))]
use std::path::PathBuf;
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

/// macOS 对应的 16 字节 `WKWebsiteDataStore` 标识（与 `browser.rs` 创建标签使用同一规则）。
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
pub(crate) fn store_id_for(which: Which, data_override: Option<&Path>) -> [u8; 16] {
    match which {
        Which::User => crate::browser_policy::browser_data_store_id(data_override),
        Which::Agent => crate::browser_policy::agent_data_store_id(data_override),
    }
}

#[cfg(any(windows, target_os = "macos"))]
fn data_error(error: impl std::fmt::Display) -> CommandError {
    CommandError::new("browser_failed", format!("浏览数据操作失败：{error}"))
}

#[cfg(not(target_os = "macos"))]
fn data_dir(app: &AppHandle, which: Which) -> CmdResult<PathBuf> {
    let state = app.state::<Arc<BrowserState>>();
    match which {
        Which::User => state.user_data_dir(app),
        Which::Agent => state.agent_data_dir(app),
    }
}

#[cfg(not(target_os = "macos"))]
async fn size_of(dir: PathBuf) -> CmdResult<u64> {
    tauri::async_runtime::spawn_blocking(move || dir_size(&dir))
        .await
        .map_err(|e| CommandError::new("browser_failed", format!("浏览数据操作失败：{e}")))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sizes {
    user: u64,
    agent: u64,
}

/// 两份浏览数据的占用大小（Windows 异步遍历目录不占主线程；macOS 拿不到大小返回 0）。
#[tauri::command]
pub async fn browser_data_sizes(app: AppHandle) -> CmdResult<Sizes> {
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        Ok(Sizes { user: 0, agent: 0 })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let user = data_dir(&app, Which::User)?;
        let agent = data_dir(&app, Which::Agent)?;
        Ok(Sizes {
            user: size_of(user).await?,
            agent: size_of(agent).await?,
        })
    }
}

/// 同一时间只清一份
static CLEARING: AtomicBool = AtomicBool::new(false);
static NEXT_TEMP: AtomicU32 = AtomicU32::new(0);

/// 清完等这么久还没回调就算失败
#[cfg(any(windows, target_os = "macos"))]
const CLEAR_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// 清除一份浏览数据，返回清除后的实际大小（Windows WebView2 基础文件会留下不一定是 0；
/// macOS 拿不到大小返回 0）。
#[tauri::command]
pub async fn browser_data_clear(app: AppHandle, which: String) -> CmdResult<u64> {
    let which = Which::parse(&which)?;
    #[cfg(not(target_os = "macos"))]
    let dir = data_dir(&app, which)?;
    if CLEARING.swap(true, Ordering::SeqCst) {
        return Err(CommandError::new("busy", "正在清除浏览数据"));
    }
    #[cfg(target_os = "macos")]
    let result = clear(&app, which).await;
    #[cfg(not(target_os = "macos"))]
    let result = clear(&app, which, &dir).await;
    CLEARING.store(false, Ordering::SeqCst);
    result?;
    #[cfg(target_os = "macos")]
    {
        Ok(0)
    }
    #[cfg(not(target_os = "macos"))]
    {
        size_of(dir).await
    }
}

/// 临时 webview 的标签：capability 只认 `main`，与之错开，任何命令都过不了 ACL。
#[cfg_attr(not(any(windows, target_os = "macos", test)), allow(dead_code))]
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

#[cfg(target_os = "macos")]
async fn clear(app: &AppHandle, which: Which) -> CmdResult<()> {
    use tauri::{LogicalPosition, LogicalSize, WebviewBuilder, WebviewUrl};
    let window = app
        .get_window("main")
        .ok_or_else(|| CommandError::new("browser_failed", "主窗口不存在"))?;
    let store_id = store_id_for(which, app.state::<Arc<BrowserState>>().data_override());
    let builder = WebviewBuilder::new(
        temp_label(which),
        WebviewUrl::External("about:blank".parse().map_err(data_error)?),
    )
    .data_store_identifier(store_id)
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

#[cfg(not(any(windows, target_os = "macos")))]
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

#[cfg(target_os = "macos")]
mod native {
    use std::sync::mpsc::Sender;

    use block2::RcBlock;
    use objc2_foundation::{MainThreadMarker, NSDate};
    use objc2_web_kit::{WKWebView, WKWebsiteDataStore};

    /// 清掉这个 webview 所在 `WKWebsiteDataStore` 的全部浏览数据；等异步完成回调后再经 `done` 送回。
    pub fn clear_all(platform: &tauri::webview::PlatformWebview, done: Sender<Result<(), String>>) {
        let Some(mtm) = MainThreadMarker::new() else {
            let _ = done.send(Err("清除浏览数据必须在主线程执行".into()));
            return;
        };
        let ptr = platform.inner().cast::<WKWebView>();
        if ptr.is_null() {
            let _ = done.send(Err("无法取得 WKWebView 实例".into()));
            return;
        }
        // SAFETY: `with_webview` 在主线程执行，回调期间 `platform.inner()` 指向有效的 `WKWebView`。
        unsafe {
            let view: &WKWebView = &*ptr;
            let config = view.configuration();
            let store = config.websiteDataStore();
            let all_types = WKWebsiteDataStore::allWebsiteDataTypes(mtm);
            let since = NSDate::distantPast();
            let handler = RcBlock::new(move || {
                let _ = done.send(Ok(()));
            });
            store.removeDataOfTypes_modifiedSince_completionHandler(&all_types, &since, &handler);
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

    #[test]
    fn store_id_for_matches_browser_policy_for_user_and_agent() {
        assert_eq!(
            store_id_for(Which::User, None),
            crate::browser_policy::browser_data_store_id(None)
        );
        assert_eq!(
            store_id_for(Which::Agent, None),
            crate::browser_policy::agent_data_store_id(None)
        );
        assert_ne!(
            store_id_for(Which::User, None),
            store_id_for(Which::Agent, None)
        );
        let isolated = Path::new("/tmp/nocturne-isolated-a");
        assert_eq!(
            store_id_for(Which::User, Some(isolated)),
            crate::browser_policy::browser_data_store_id(Some(isolated))
        );
        assert_eq!(
            store_id_for(Which::Agent, Some(isolated)),
            crate::browser_policy::agent_data_store_id(Some(isolated))
        );
        assert_ne!(
            store_id_for(Which::User, Some(isolated)),
            store_id_for(Which::User, None)
        );
    }
}
