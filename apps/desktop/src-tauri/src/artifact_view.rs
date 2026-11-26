//! Open Artifact 受限隔离编辑器子 WebView（ADR-0125）：
//!
//! 隔离保证：
//! - 子 webview 标签为 `nct-artifact-<id>`（与 `capabilities/main.json` 只匹配的 `main` 错开），
//!   不向作品暴露任何 Tauri IPC 或插件权限；
//! - 顶层导航只放行 daemon 明确声明的精确来源（`browser_policy::allow_artifact_navigation`），
//!   绝不允许加载 `tauri:`、`ipc:`、`asset:`、`nct-sandbox:`、`file:`、devUrl 或任意外部网站；
//! - 独立的数据目录（Windows/Linux 为 `open-artifact`，macOS 为独立 `WKWebsiteDataStore`）；
//! - 编辑器内点击导出走受控下载回调，遵循「设置 › 常规 › 下载」并把状态通知前端。

use crate::backend::CommandError;
use crate::browser::{self, Bounds};
use crate::browser_policy;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::ipc::Channel;
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl};

type CmdResult<T> = Result<T, CommandError>;

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ArtifactViewMessage {
    Loading { loading: bool },
    Title { title: String },
    NewWindow { url: String },
    Blocked { url: String, reason: &'static str, message: String },
    Download { state: &'static str, name: String },
}

struct ArtifactView {
    label: String,
    channel: Channel<ArtifactViewMessage>,
    allowed_origins: Mutex<Vec<String>>,
}

impl ArtifactView {
    fn send(&self, message: ArtifactViewMessage) {
        let _ = self.channel.send(message);
    }
}

#[derive(Default)]
pub struct ArtifactViewState {
    next_id: AtomicU32,
    views: Mutex<HashMap<u32, Arc<ArtifactView>>>,
    data_override: Option<std::path::PathBuf>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn native_error(error: impl std::fmt::Display) -> CommandError {
    CommandError::new("artifact_view_failed", error.to_string())
}

fn normalize_origins(origins: Vec<String>, fallback_target: &Url) -> Vec<String> {
    let mut out: Vec<String> = origins
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    // 若调用方同时传了 embedUrl 与 daemon 声明的 allowedOrigins，不隐式扩充未声明来源；
    // 仅当允许列表为空时也不放行非回环外域（由 allow_artifact_navigation 最终判定）。
    if out.is_empty() {
        let host = fallback_target
            .host_str()
            .unwrap_or_default()
            .to_ascii_lowercase();
        if matches!(host.as_str(), "127.0.0.1" | "localhost" | "[::1]") {
            if let Some(port) = fallback_target.port() {
                out.push(format!("{}://{}:{}", fallback_target.scheme(), host, port));
            }
        }
    }
    out
}

impl ArtifactViewState {
    pub fn new(data_override: Option<std::path::PathBuf>) -> Self {
        Self {
            data_override,
            ..Self::default()
        }
    }

    fn get(&self, id: u32) -> CmdResult<Arc<ArtifactView>> {
        lock(&self.views)
            .get(&id)
            .cloned()
            .ok_or_else(|| CommandError::new("unknown_artifact_view", "作品视图已关闭"))
    }

    #[cfg(not(target_os = "macos"))]
    fn user_data_dir(&self, app: &AppHandle) -> CmdResult<std::path::PathBuf> {
        let local = app.path().app_local_data_dir().map_err(native_error)?;
        Ok(browser_policy::artifact_data_dir(
            &local,
            self.data_override.as_deref(),
        ))
    }

    /// 页面重载或应用退出时关闭全部 Open Artifact 子 webview。
    pub fn close_all(&self, app: &AppHandle) {
        let all: Vec<Arc<ArtifactView>> = lock(&self.views).drain().map(|(_, v)| v).collect();
        for view in all {
            if let Some(webview) = app.get_webview(&view.label) {
                browser::close_later(webview);
            }
        }
    }
}

fn webview_of(app: &AppHandle, view: &ArtifactView) -> CmdResult<tauri::Webview> {
    app.get_webview(&view.label)
        .ok_or_else(|| CommandError::new("unknown_artifact_view", "作品视图已关闭"))
}

#[tauri::command]
pub async fn artifact_view_create(
    app: AppHandle,
    state: tauri::State<'_, Arc<ArtifactViewState>>,
    embed_url: String,
    allowed_origins: Vec<String>,
    bounds: Option<Bounds>,
    channel: Channel<ArtifactViewMessage>,
) -> CmdResult<u32> {
    let dev = browser::dev_url_for(&app);
    let target = Url::parse(embed_url.trim())
        .map_err(|_| CommandError::new("artifact_blocked", "作品视图地址无效"))?;
    let origins = normalize_origins(allowed_origins, &target);
    if let Err(blocked) = browser_policy::allow_artifact_navigation(&target, &origins, dev.as_ref()) {
        return Err(CommandError::new("artifact_blocked", blocked.message()));
    }

    let window = app
        .get_window("main")
        .ok_or_else(|| CommandError::new("artifact_view_failed", "主窗口不存在"))?;
    #[cfg(not(target_os = "macos"))]
    let data_dir = state.user_data_dir(&app)?;
    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let view = Arc::new(ArtifactView {
        label: browser_policy::artifact_label(id),
        channel,
        allowed_origins: Mutex::new(origins),
    });

    let nav_view = Arc::clone(&view);
    let new_win_view = Arc::clone(&view);
    let title_view = Arc::clone(&view);
    let load_view = Arc::clone(&view);
    let download_view = Arc::clone(&view);
    let download_app = app.clone();
    let new_win_dev = dev.clone();

    let builder = WebviewBuilder::new(
        &view.label,
        WebviewUrl::External("about:blank".parse().map_err(native_error)?),
    );
    #[cfg(target_os = "macos")]
    let builder = builder.data_store_identifier(browser_policy::artifact_data_store_id(
        state.data_override.as_deref(),
    ));
    #[cfg(not(target_os = "macos"))]
    let builder = builder.data_directory(data_dir);

    let builder = builder
        .on_navigation(move |url| {
            let allowed = lock(&nav_view.allowed_origins).clone();
            match browser_policy::allow_artifact_navigation(url, &allowed, dev.as_ref()) {
                Ok(()) => {
                    if url.as_str() != "about:blank" {
                        nav_view.send(ArtifactViewMessage::Loading { loading: true });
                    }
                    true
                }
                Err(blocked) => {
                    nav_view.send(ArtifactViewMessage::Blocked {
                        url: url.to_string(),
                        reason: blocked.reason(),
                        message: blocked.message(),
                    });
                    false
                }
            }
        })
        .on_new_window(move |url, _| {
            match browser_policy::check_target(&url, new_win_dev.as_ref()) {
                Ok(()) if matches!(url.scheme(), "http" | "https") => {
                    new_win_view.send(ArtifactViewMessage::NewWindow {
                        url: url.to_string(),
                    });
                }
                Ok(()) => {}
                Err(blocked) => {
                    new_win_view.send(ArtifactViewMessage::Blocked {
                        url: url.to_string(),
                        reason: blocked.reason(),
                        message: blocked.message(),
                    });
                }
            }
            NewWindowResponse::Deny
        })
        .on_document_title_changed(move |_, value| {
            title_view.send(ArtifactViewMessage::Title { title: value });
        })
        .on_page_load(move |_, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                load_view.send(ArtifactViewMessage::Loading { loading: false });
            }
        })
        .on_download(move |_, event| {
            let (name, finished_ok) = match &event {
                DownloadEvent::Requested { destination, .. } => (
                    destination
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "artifact".into()),
                    None,
                ),
                DownloadEvent::Finished { path, success, .. } => (
                    path.as_ref()
                        .and_then(|p| p.file_name())
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "artifact".into()),
                    Some(*success),
                ),
                _ => (String::new(), None),
            };
            let allowed = browser::on_main_download(&download_app, event);
            match finished_ok {
                None if allowed => download_view.send(ArtifactViewMessage::Download {
                    state: "started",
                    name,
                }),
                Some(true) => download_view.send(ArtifactViewMessage::Download {
                    state: "finished",
                    name,
                }),
                Some(false) => download_view.send(ArtifactViewMessage::Download {
                    state: "failed",
                    name,
                }),
                _ => {}
            }
            allowed
        });

    let (position, size) = match bounds {
        Some(b) => {
            let rect = b.rect();
            match (rect.position, rect.size) {
                (tauri::Position::Logical(p), tauri::Size::Logical(s)) => (p, s),
                _ => (LogicalPosition::new(0.0, 0.0), LogicalSize::new(1.0, 1.0)),
            }
        }
        None => (LogicalPosition::new(0.0, 0.0), LogicalSize::new(1.0, 1.0)),
    };
    let webview = window
        .add_child(builder, position, size)
        .map_err(native_error)?;
    browser::configure_webview_download_staging(&webview);
    if bounds.is_none() {
        let _ = webview.hide();
    }
    lock(&state.views).insert(id, Arc::clone(&view));
    webview.navigate(target).map_err(native_error)?;
    Ok(id)
}

#[tauri::command]
pub fn artifact_view_navigate(
    app: AppHandle,
    state: tauri::State<'_, Arc<ArtifactViewState>>,
    id: u32,
    embed_url: String,
    allowed_origins: Vec<String>,
) -> CmdResult<()> {
    let view = state.get(id)?;
    let dev = browser::dev_url_for(&app);
    let target = Url::parse(embed_url.trim())
        .map_err(|_| CommandError::new("artifact_blocked", "作品视图地址无效"))?;
    let origins = normalize_origins(allowed_origins, &target);
    if let Err(blocked) = browser_policy::allow_artifact_navigation(&target, &origins, dev.as_ref()) {
        return Err(CommandError::new("artifact_blocked", blocked.message()));
    }
    *lock(&view.allowed_origins) = origins;
    webview_of(&app, &view)?
        .navigate(target)
        .map_err(native_error)
}

#[tauri::command]
pub fn artifact_view_set_origins(
    state: tauri::State<'_, Arc<ArtifactViewState>>,
    id: u32,
    allowed_origins: Vec<String>,
) -> CmdResult<()> {
    let view = state.get(id)?;
    *lock(&view.allowed_origins) = allowed_origins
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    Ok(())
}

#[tauri::command]
pub fn artifact_view_layout(
    app: AppHandle,
    state: tauri::State<'_, Arc<ArtifactViewState>>,
    id: u32,
    bounds: Option<Bounds>,
) -> CmdResult<()> {
    let view = state.get(id)?;
    let webview = webview_of(&app, &view)?;
    match bounds {
        Some(b) => {
            webview.set_bounds(b.rect()).map_err(native_error)?;
            webview.show().map_err(native_error)
        }
        None => {
            webview.hide().map_err(native_error)?;
            if let Some(main) = app.get_webview("main") {
                let _ = main.set_focus();
            }
            Ok(())
        }
    }
}

#[tauri::command]
pub async fn artifact_view_capture(
    app: AppHandle,
    state: tauri::State<'_, Arc<ArtifactViewState>>,
    id: u32,
) -> CmdResult<tauri::ipc::Response> {
    let view = state.get(id)?;
    let webview = webview_of(&app, &view)?;
    let bytes = browser::capture_webview_png(&webview).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn artifact_view_destroy(
    app: AppHandle,
    state: tauri::State<'_, Arc<ArtifactViewState>>,
    id: u32,
) -> CmdResult<()> {
    let Some(view) = lock(&state.views).remove(&id) else {
        return Ok(());
    };
    if let Some(webview) = app.get_webview(&view.label) {
        browser::close_later(webview);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::browser_policy;
    use tauri::Url;

    #[test]
    fn allow_only_exact_declared_origins() {
        let allowed = vec!["http://127.0.0.1:41234".to_string()];
        let dev = Url::parse("http://localhost:31420").unwrap();

        assert!(browser_policy::allow_artifact_navigation(
            &Url::parse("http://127.0.0.1:41234/a/abc?ticket=1").unwrap(),
            &allowed,
            Some(&dev),
        )
        .is_ok());
        assert!(browser_policy::allow_artifact_navigation(
            &Url::parse("about:blank").unwrap(),
            &allowed,
            Some(&dev),
        )
        .is_ok());

        // 不同端口拒绝
        assert!(browser_policy::allow_artifact_navigation(
            &Url::parse("http://127.0.0.1:41235/a/abc").unwrap(),
            &allowed,
            Some(&dev),
        )
        .is_err());
        // 不同回环主机名（未声明 localhost）拒绝
        assert!(browser_policy::allow_artifact_navigation(
            &Url::parse("http://localhost:41234/a/abc").unwrap(),
            &allowed,
            Some(&dev),
        )
        .is_err());
        // 外站、file、应用内部协议、devUrl 全部拒绝
        for bad in [
            "https://example.com/",
            "file:///C:/Windows/win.ini",
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
            "http://ipc.localhost/",
            "http://nct-sandbox.localhost/",
            "http://localhost:31420/",
            "javascript:alert(1)",
        ] {
            assert!(
                browser_policy::allow_artifact_navigation(
                    &Url::parse(bad).unwrap(),
                    &allowed,
                    Some(&dev),
                )
                .is_err(),
                "should block {bad}"
            );
        }
    }

    #[test]
    fn artifact_label_never_matches_main() {
        assert_ne!(browser_policy::artifact_label(1), "main");
        assert!(browser_policy::artifact_label(1).starts_with("nct-artifact-"));
    }
}
