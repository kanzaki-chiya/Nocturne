//! 面板里的内置浏览器（ADR-0060 第 5 节、修订（四））：每个浏览器标签一个子 webview，
//! 用 `Window::add_child` 挂在主窗口下（需要 tauri 的 `unstable` 特性），位置和尺寸由
//! 前端按面板里的占位元素给出（逻辑像素）。
//!
//! 隔离：
//! - Tauri 一定会给子 webview 注入调用入口，但 capability 只按 webview 标签匹配 `main`，
//!   浏览器的标签是 `nct-browser-<n>`（browser_policy::browser_label），任何应用命令、
//!   插件命令都过不了 ACL；
//! - 导航白名单（browser_policy）是第二道防线：不让网页进应用自己的地址，自定义协议
//!   不交给系统，网页不能从 http(s) 跳到本地文件；
//! - cookie 和存储在独立的数据目录（browser_policy::browser_data_dir）；
//! - 页面事件经创建时的 Channel 只推给主界面，不广播事件。

use crate::backend::CommandError;
use crate::browser_fullscreen::{Fullscreen, Step};
use crate::browser_policy::{
    self, Blocked, DownloadPlan, DownloadPrefs, DownloadReport, Downloads,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::ipc::Channel;
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, PhysicalPosition, Rect, Url, WebviewUrl,
};

type CmdResult<T> = Result<T, CommandError>;

/// 推给前端的页面事件（前端 host.ts BrowserMessage）。
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BrowserMessage {
    /// 地址变化（含网页内 pushState）
    Url {
        url: String,
    },
    Title {
        title: String,
    },
    Loading {
        loading: bool,
    },
    History {
        back: bool,
        forward: bool,
    },
    /// 网站图标（PNG）；没有时为 None
    Favicon {
        png: Option<Vec<u8>>,
    },
    /// `target=_blank` / `window.open`：前端在本会话开一个新浏览器标签
    NewWindow {
        url: String,
    },
    /// 被导航规则拦下
    Blocked {
        url: String,
        reason: &'static str,
        message: String,
    },
    /// 下载：started（选好了保存位置）/ finished / failed
    Download {
        state: &'static str,
        name: String,
    },
    /// 焦点在网页里时按下的应用快捷键（browser_policy::app_shortcut）
    Shortcut {
        key: &'static str,
    },
    /// 网页进出全屏（browser_fullscreen）：全屏期间 webview 铺满窗口，主界面不做浮层遮挡
    Fullscreen {
        on: bool,
    },
}

/// 一个浏览器标签的外壳状态。
pub struct Browser {
    label: String,
    channel: Channel<BrowserMessage>,
    nav: Mutex<Nav>,
    /// WebView2 的焦点：隐藏时焦点要还给主界面
    focused: AtomicBool,
    /// 下载登记：哪些结束要提示（browser_policy::Downloads）
    downloads: Mutex<Downloads>,
    /// 网页全屏与最后一次面板位置（browser_fullscreen::Fullscreen）
    fullscreen: Mutex<Fullscreen<Bounds>>,
}

impl Browser {
    fn send(&self, message: BrowserMessage) {
        let _ = self.channel.send(message);
    }
}

#[derive(Default)]
struct Nav {
    /// 当前文档的地址（页面提交时更新）：判断「网页从 http(s) 跳到 file」
    current: Option<Url>,
    /// 我们自己发起的那次导航：用户主动打开的本地文件凭它放行
    user_target: Option<Url>,
}

#[derive(Default)]
pub struct BrowserState {
    next_id: AtomicU32,
    browsers: Mutex<HashMap<u32, Arc<Browser>>>,
    /// 启动时接管的 `WEBVIEW2_USER_DATA_FOLDER`（browser_policy::browser_data_dir）
    data_override: Option<std::path::PathBuf>,
    /// 网页全屏前主窗口是最大化的：退出全屏后重新最大化（见 [`window_fullscreen`]）
    restore_maximized: AtomicBool,
    /// 设置 › 常规 › 下载（前端启动时和改动时同步）；还没同步时按询问处理
    download_prefs: Mutex<Option<DownloadPrefs>>,
    /// 直接保存、还没结束的下载（地址, 路径）：同时下两个同名文件时不撞同一个路径
    pending_saves: Mutex<Vec<(String, std::path::PathBuf)>>,
    /// 当前尚未收到 `DownloadEvent::Finished` 的下载数（为 0 时可安全清理本进程暂存目录中的孤儿 UUID `.tmp`）
    active_downloads: AtomicU32,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl BrowserState {
    pub fn new(data_override: Option<std::path::PathBuf>) -> Self {
        Self {
            data_override,
            ..Self::default()
        }
    }

    fn get(&self, id: u32) -> CmdResult<Arc<Browser>> {
        lock(&self.browsers)
            .get(&id)
            .cloned()
            .ok_or_else(|| CommandError::new("unknown_browser", "浏览器标签已经关闭"))
    }

    /// 页面重载、应用退出时关掉全部浏览器（前端的标签随页面一起没了）。
    pub fn close_all(&self, app: &AppHandle) {
        let all: Vec<Arc<Browser>> = lock(&self.browsers).drain().map(|(_, b)| b).collect();
        for browser in all {
            leave_window_fullscreen(app, &browser);
            if let Some(webview) = app.get_webview(&browser.label) {
                close_later(webview);
            }
        }
    }

    /// 用户浏览数据目录（`<应用本地数据>/browser`，隔离环境放在
    /// `WEBVIEW2_USER_DATA_FOLDER` 下）。浏览器创建与「设置 › 浏览器 › 浏览数据」共用。
    pub fn user_data_dir(&self, app: &AppHandle) -> CmdResult<std::path::PathBuf> {
        Ok(match self.data_override.as_deref() {
            Some(dir) => browser_policy::browser_data_dir(dir, Some(dir)),
            None => browser_policy::browser_data_dir(
                &app.path().app_local_data_dir().map_err(native_error)?,
                None,
            ),
        })
    }

    /// agent 浏览数据目录：和 agent 标签创建时（`agent_browser::shell`）同一个路径函数与覆盖目录。
    pub fn agent_data_dir(&self, app: &AppHandle) -> CmdResult<std::path::PathBuf> {
        Ok(browser_policy::agent_data_dir(
            &app.path().app_local_data_dir().map_err(native_error)?,
            self.data_override.as_deref(),
        ))
    }

    /// 当前存活的用户浏览器标签数。容量判定把 agent 标签另算（desktop-browser.md 第 2 节）。
    pub fn live_count(&self) -> usize {
        lock(&self.browsers).len()
    }

    /// 应用私有的 WebView2 下载暂存根目录（`<应用本地数据>/download-staging`，隔离环境在
    /// `WEBVIEW2_USER_DATA_FOLDER/download-staging`），与用户「下载」文件夹及浏览数据统计目录分离。
    pub fn staging_root(&self, app: &AppHandle) -> Option<std::path::PathBuf> {
        let base = match self.data_override.as_deref() {
            Some(dir) => Some(dir.to_path_buf()),
            None => app.path().app_local_data_dir().ok(),
        }
        .or_else(|| Some(std::env::temp_dir().join("nocturne")))?;
        Some(base.join("download-staging"))
    }

    /// 本进程专属的下载暂存子目录（`<staging_root>/pid-<pid>`）。
    pub fn staging_dir(&self, app: &AppHandle) -> Option<std::path::PathBuf> {
        Some(
            self.staging_root(app)?
                .join(format!("pid-{}", std::process::id())),
        )
    }

    /// 应用退出时清理本进程的下载暂存子目录（仅删除 WebView2 UUID `.tmp`，目录为空再删目录）。
    pub fn cleanup_own_staging(&self, app: &AppHandle) {
        if let Some(dir) = self.staging_dir(app) {
            clean_webview_tmps_in_dir(&dir);
            let _ = std::fs::remove_dir(&dir);
        }
    }
}

/// 关掉一个浏览器 webview：不在调用方的线程上关，换一个线程发起。
///
/// 同步命令和页面加载钩子都跑在主线程上，主线程这时可能正卡在另一个浏览器的创建里：
/// tauri-runtime-wry 建 webview 时一直拿着 web context 的锁，同时嵌套泵消息等 WebView2
/// 建好控制器，主界面发来的 IPC 请求就在这个嵌套循环里执行。在这里直接 `close()`，
/// 析构 webview 又去拿同一把锁，主线程把自己锁死，整个应用无响应。从别的线程
/// `close()` 只是给事件循环发一条消息；事件处理器还没返回时 tao 先把它缓冲起来，
/// 等 webview 建完、锁放开后再关。
pub(crate) fn close_later(webview: tauri::Webview) {
    std::thread::spawn(move || {
        let _ = webview.close();
    });
}

/// agent 标签关 webview 也走同一条路径（desktop-browser.md 第 2 节）。
pub fn close_later_for_agent(webview: tauri::Webview) {
    close_later(webview);
}

/// 前端给的位置和尺寸（主界面的 CSS 像素 = 逻辑像素）。
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl Bounds {
    fn rect(self) -> Rect {
        Rect {
            position: LogicalPosition::new(self.x, self.y).into(),
            size: LogicalSize::new(self.width.max(1.0), self.height.max(1.0)).into(),
        }
    }
}

fn blocked_error(blocked: &Blocked) -> CommandError {
    CommandError::new(&format!("browser_{}", blocked.reason()), blocked.message())
}

fn dev_url(app: &AppHandle) -> Option<Url> {
    app.config().build.dev_url.clone()
}

fn webview_of(app: &AppHandle, browser: &Browser) -> CmdResult<tauri::Webview> {
    app.get_webview(&browser.label)
        .ok_or_else(|| CommandError::new("unknown_browser", "浏览器标签已经关闭"))
}

fn native_error(error: impl std::fmt::Display) -> CommandError {
    CommandError::new("browser_failed", format!("浏览器操作失败：{error}"))
}

/// 判定文件名是否为 WebView2 在 `DefaultDownloadFolderPath` 预创建的 `<UUID>.tmp`（8-4-4-4-12 十六进制）。
fn is_webview_download_tmp_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".tmp") else {
        return false;
    };
    if stem.len() != 36 {
        return false;
    }
    for (idx, b) in stem.bytes().enumerate() {
        match idx {
            8 | 13 | 18 | 23 => {
                if b != b'-' {
                    return false;
                }
            }
            _ => {
                if !b.is_ascii_hexdigit() {
                    return false;
                }
            }
        }
    }
    true
}

/// 仅删除给定暂存目录内符合 `<UUID>.tmp` 格式的普通文件；其他文件（含非 UUID `.tmp`）一律保留。
fn clean_webview_tmps_in_dir(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if !ft.is_file() {
            continue;
        }
        let name = entry.file_name();
        if let Some(name_str) = name.to_str() {
            if is_webview_download_tmp_name(name_str) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

/// 回收 `staging_root` 下已退出的旧进程 `pid-<u32>` 暂存目录；存活进程目录与非 `pid-*` 条目一律不碰。
fn prune_staging_root(
    staging_root: &std::path::Path,
    current_pid: u32,
    is_pid_alive: impl Fn(u32) -> bool,
) {
    let Ok(entries) = std::fs::read_dir(staging_root) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if !ft.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let Some(pid_str) = name.to_str().and_then(|s| s.strip_prefix("pid-")) else {
            continue;
        };
        let Ok(pid) = pid_str.parse::<u32>() else {
            continue;
        };
        if pid == current_pid || is_pid_alive(pid) {
            continue;
        }
        let path = entry.path();
        clean_webview_tmps_in_dir(&path);
        let _ = std::fs::remove_dir(&path);
    }
}

#[cfg(windows)]
fn is_process_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    // SAFETY: OpenProcess / GetExitCodeProcess / CloseHandle 为只读查询内核句柄状态
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut exit_code: u32 = 0;
        let ok = GetExitCodeProcess(handle, &mut exit_code);
        CloseHandle(handle);
        ok != 0 && exit_code == STILL_ACTIVE as u32
    }
}

/// 为一次下载请求决定保存路径并维护 `pending_saves`（主窗口与面板浏览器共用）。
/// 返回 `Some(path)` 表示允许下载并写入该路径，`None` 表示用户取消「另存为」。
fn resolve_download_destination(
    state: &BrowserState,
    default_dir: Option<&std::path::Path>,
    staging_dir: Option<&std::path::Path>,
    url: &str,
    initial_destination: &std::path::Path,
    writable_dir: impl Fn(&std::path::Path) -> bool,
    prompt: impl FnOnce(Option<&std::path::Path>, &str) -> Option<std::path::PathBuf>,
) -> Option<std::path::PathBuf> {
    let name = initial_destination
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".into());
    let prefs = lock(&state.download_prefs).clone();
    let plan = {
        let pending = lock(&state.pending_saves);
        browser_policy::plan_download(
            prefs.as_ref(),
            default_dir,
            &name,
            writable_dir,
            |path| path.exists() || pending.iter().any(|(_, p)| p == path),
        )
    };
    match plan {
        DownloadPlan::Ask { dir } => {
            let dir = dir
                .or_else(|| default_dir.map(std::path::Path::to_path_buf))
                .or_else(|| {
                    initial_destination
                        .parent()
                        .filter(|d| !d.as_os_str().is_empty() && staging_dir != Some(*d))
                        .map(std::path::Path::to_path_buf)
                });
            prompt(dir.as_deref(), &name)
        }
        DownloadPlan::Save(path) => {
            lock(&state.pending_saves).push((url.to_string(), path.clone()));
            Some(path)
        }
    }
}

/// 下载结束时移除在途记录；若当前无其他进行中的下载，顺带清理本进程暂存目录内可能残留的 `<UUID>.tmp`。
fn finish_download(state: &BrowserState, staging_dir: Option<&std::path::Path>, url: &str) {
    finish_pending_save(state, url);
    let prev = state.active_downloads.load(Ordering::SeqCst);
    let remaining = if prev > 0 {
        state
            .active_downloads
            .fetch_sub(1, Ordering::SeqCst)
            .saturating_sub(1)
    } else {
        0
    };
    if remaining == 0 {
        if let Some(dir) = staging_dir {
            clean_webview_tmps_in_dir(dir);
        }
    }
}

/// 下载结束时从 `pending_saves` 移除对应的在途保存记录。
fn finish_pending_save(state: &BrowserState, url: &str) {
    let mut pending = lock(&state.pending_saves);
    if let Some(index) = pending.iter().position(|(u, _)| u == url) {
        pending.remove(index);
    }
}

/// 初始化本进程下载暂存目录并回收已退出旧进程的遗留暂存目录。
#[cfg(windows)]
fn ensure_staging_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    let state = app.try_state::<Arc<BrowserState>>()?;
    if let Some(root) = state.staging_root(app) {
        prune_staging_root(&root, std::process::id(), is_process_alive);
    }
    let dir = state.staging_dir(app)?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir)
}

/// 主窗口挂载 WebView2 多次下载权限放行，并将 WebView2 默认下载暂存目录指向应用私有目录。
pub fn configure_main_webview(window: &tauri::WebviewWindow) {
    #[cfg(windows)]
    {
        let staging = ensure_staging_dir(window.app_handle());
        let _ = native::configure_main(window, staging);
    }
    #[cfg(not(windows))]
    let _ = window;
}

/// 将任意子 WebView（如 Agent 浏览器）的 WebView2 默认下载目录指向应用私有暂存目录。
pub fn configure_webview_download_staging(webview: &tauri::Webview) {
    #[cfg(windows)]
    if let Some(staging) = ensure_staging_dir(webview.app_handle()) {
        let _ = native::set_webview_staging(webview, staging);
    }
    #[cfg(not(windows))]
    let _ = webview;
}

/// 主窗口下载（图片查看器、对话文件附件卡片等 `<a download>`）：
/// 按「设置 › 常规 › 下载」弹「另存为」或直接存到保存位置；不发面板浏览器通知。
pub fn on_main_download(app: &AppHandle, event: DownloadEvent<'_>) -> bool {
    match event {
        DownloadEvent::Requested { url, destination } => {
            let state = app.state::<Arc<BrowserState>>();
            state.active_downloads.fetch_add(1, Ordering::SeqCst);
            let default_dir = default_download_dir(app);
            let staging_dir = state.staging_dir(app);
            match resolve_download_destination(
                state.inner(),
                default_dir.as_deref(),
                staging_dir.as_deref(),
                url.as_str(),
                destination,
                browser_policy::dir_writable,
                |dir, name| save_as(app, dir, name),
            ) {
                Some(path) => {
                    *destination = path;
                    true
                }
                None => false,
            }
        }
        DownloadEvent::Finished { url, .. } => {
            let state = app.state::<Arc<BrowserState>>();
            let staging_dir = state.staging_dir(app);
            finish_download(state.inner(), staging_dir.as_deref(), url.as_str());
            true
        }
        _ => true,
    }
}

/// 面板浏览器下载：按「设置 › 常规 › 下载」弹「另存为」或直接存到保存位置
/// （[`browser_policy::plan_download`]）；另存为里取消就不下载。结果配对见
/// [`browser_policy::Downloads`]。
fn on_download(app: &AppHandle, browser: &Browser, event: DownloadEvent<'_>) -> bool {
    match event {
        DownloadEvent::Requested { url, destination } => {
            let fallback_name = destination
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "download".into());
            let state = app.state::<Arc<BrowserState>>();
            state.active_downloads.fetch_add(1, Ordering::SeqCst);
            let default_dir = default_download_dir(app);
            let staging_dir = state.staging_dir(app);
            let target = resolve_download_destination(
                state.inner(),
                default_dir.as_deref(),
                staging_dir.as_deref(),
                url.as_str(),
                destination,
                browser_policy::dir_writable,
                |dir, name| save_as(app, dir, name),
            );
            match target {
                Some(path) => {
                    let chosen = path
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or(fallback_name);
                    *destination = path;
                    lock(&browser.downloads).chosen(url.as_str(), chosen.clone());
                    browser.send(BrowserMessage::Download {
                        state: "started",
                        name: chosen,
                    });
                    true
                }
                None => {
                    lock(&browser.downloads).cancelled(url.as_str());
                    false
                }
            }
        }
        DownloadEvent::Finished { url, path, success } => {
            let state = app.state::<Arc<BrowserState>>();
            let staging_dir = state.staging_dir(app);
            finish_download(state.inner(), staging_dir.as_deref(), url.as_str());
            let file_name = path
                .as_ref()
                .and_then(|p| p.file_name())
                .map(|n| n.to_string_lossy().into_owned());
            let report = lock(&browser.downloads).finished(url.as_str(), file_name, success);
            match report {
                Some(DownloadReport::Finished(name)) => browser.send(BrowserMessage::Download {
                    state: "finished",
                    name,
                }),
                Some(DownloadReport::Failed(name)) => browser.send(BrowserMessage::Download {
                    state: "failed",
                    name,
                }),
                None => {}
            }
            true
        }
        _ => true,
    }
}

/// 另存为对话框。下载回调在主线程上同步等结果，Tauri 对话框插件的阻塞接口在主线程上
/// 会和父窗口互相等待，所以直接用它底下的 rfd 同步对话框（模态，自带消息循环）。
#[cfg(windows)]
fn save_as(
    app: &AppHandle,
    dir: Option<&std::path::Path>,
    name: &str,
) -> Option<std::path::PathBuf> {
    let mut dialog = rfd::FileDialog::new()
        .set_title("另存为")
        .set_file_name(name);
    if let Some(dir) = dir.filter(|d| d.is_dir()) {
        dialog = dialog.set_directory(dir);
    }
    if let Some(window) = app.get_window("main") {
        dialog = dialog.set_parent(&window);
    }
    dialog.save_file()
}

#[cfg(not(windows))]
fn save_as(_: &AppHandle, _: Option<&std::path::Path>, _: &str) -> Option<std::path::PathBuf> {
    None
}

/// 系统「下载」文件夹；取不到为 None。
fn default_download_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().download_dir().ok()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadSettings {
    /// 系统「下载」文件夹（没设保存位置时设置页显示它）
    default_dir: Option<String>,
}

/// 设置 › 常规 › 下载：前端启动时和改动时同步过来。`dir` 为空 = 系统「下载」文件夹。
#[tauri::command]
pub fn browser_downloads_set(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserState>>,
    ask: bool,
    dir: Option<String>,
) -> DownloadSettings {
    let dir = dir
        .filter(|d| !d.trim().is_empty())
        .map(std::path::PathBuf::from);
    *lock(&state.download_prefs) = Some(DownloadPrefs { ask, dir });
    DownloadSettings {
        default_dir: default_download_dir(&app).map(|d| d.to_string_lossy().into_owned()),
    }
}

#[tauri::command]
pub async fn browser_create(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserState>>,
    url: String,
    bounds: Option<Bounds>,
    channel: Channel<BrowserMessage>,
) -> CmdResult<u32> {
    let dev = dev_url(&app);
    let target =
        browser_policy::parse_user_url(&url, dev.as_ref()).map_err(|b| blocked_error(&b))?;
    let window = app
        .get_window("main")
        .ok_or_else(|| CommandError::new("browser_failed", "主窗口不存在"))?;
    let data_dir = state.user_data_dir(&app)?;
    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let browser = Arc::new(Browser {
        label: browser_policy::browser_label(id),
        channel,
        nav: Mutex::new(Nav {
            current: None,
            user_target: Some(target.clone()),
        }),
        focused: AtomicBool::new(false),
        downloads: Mutex::new(Downloads::default()),
        fullscreen: Mutex::new(Fullscreen::new(bounds)),
    });

    let nav = Arc::clone(&browser);
    let new_window = Arc::clone(&browser);
    let title = Arc::clone(&browser);
    let page = Arc::clone(&browser);
    let download = Arc::clone(&browser);
    let download_app = app.clone();
    let new_window_dev = dev.clone();
    // 先开空白页、挂好原生事件再导航，第一次导航的事件不会漏
    let builder = WebviewBuilder::new(
        &browser.label,
        WebviewUrl::External("about:blank".parse().map_err(native_error)?),
    )
    .data_directory(data_dir)
    .on_navigation(move |url| {
        let mut state = lock(&nav.nav);
        let user = state.user_target.clone();
        match browser_policy::allow_navigation(
            url,
            state.current.as_ref(),
            user.as_ref(),
            dev.as_ref(),
        ) {
            Ok(()) => {
                // 用户要的那次导航到了：之后网页再跳本地文件就不再沾它的光
                if user.is_some_and(|user| browser_policy::same_target(&user, url)) {
                    state.user_target = None;
                }
                drop(state);
                nav.send(BrowserMessage::Loading { loading: true });
                true
            }
            Err(blocked) => {
                drop(state);
                nav.send(BrowserMessage::Blocked {
                    url: url.to_string(),
                    reason: blocked.reason(),
                    message: blocked.message(),
                });
                false
            }
        }
    })
    .on_new_window(move |url, _| {
        match browser_policy::check_target(&url, new_window_dev.as_ref()) {
            Ok(()) if url.as_str() != "about:blank" => new_window.send(BrowserMessage::NewWindow {
                url: url.to_string(),
            }),
            Ok(()) => {}
            Err(blocked) => new_window.send(BrowserMessage::Blocked {
                url: url.to_string(),
                reason: blocked.reason(),
                message: blocked.message(),
            }),
        }
        NewWindowResponse::Deny
    })
    .on_document_title_changed(move |_, value| {
        title.send(BrowserMessage::Title { title: value });
    })
    .on_page_load(move |_, payload| match payload.event() {
        PageLoadEvent::Started => {
            // ContentLoading：新文档已提交
            lock(&page.nav).current = Some(payload.url().clone());
        }
        PageLoadEvent::Finished => page.send(BrowserMessage::Loading { loading: false }),
    })
    .on_download(move |_, event| on_download(&download_app, &download, event));

    let (position, size) = match bounds {
        Some(b) => (
            LogicalPosition::new(b.x, b.y),
            LogicalSize::new(b.width.max(1.0), b.height.max(1.0)),
        ),
        None => (LogicalPosition::new(0.0, 0.0), LogicalSize::new(1.0, 1.0)),
    };
    let webview = window
        .add_child(builder, position, size)
        .map_err(native_error)?;
    if bounds.is_none() {
        let _ = webview.hide();
    }
    lock(&state.browsers).insert(id, Arc::clone(&browser));
    #[cfg(windows)]
    native::attach(
        &webview,
        Arc::clone(&browser),
        target,
        app.get_webview("main"),
    )
    .map_err(native_error)?;
    #[cfg(not(windows))]
    webview.navigate(target).map_err(native_error)?;
    Ok(id)
}

/// 地址栏和外壳导航命令：拒绝 `javascript:` 和白名单外的协议。
#[tauri::command]
pub fn browser_navigate(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserState>>,
    id: u32,
    url: String,
) -> CmdResult<()> {
    let browser = state.get(id)?;
    let target = browser_policy::parse_user_url(&url, dev_url(&app).as_ref())
        .map_err(|b| blocked_error(&b))?;
    lock(&browser.nav).user_target = Some(target.clone());
    webview_of(&app, &browser)?
        .navigate(target)
        .map_err(native_error)
}

/// 位置和尺寸；`bounds` 为空时隐藏。同步命令在主线程按收到的顺序执行，拖动面板时
/// 连续的调整不会乱序。网页全屏期间只记下位置，见 [`browser_fullscreen`](crate::browser_fullscreen)。
#[tauri::command]
pub fn browser_layout(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserState>>,
    id: u32,
    bounds: Option<Bounds>,
) -> CmdResult<()> {
    let browser = state.get(id)?;
    let webview = webview_of(&app, &browser)?;
    let step = lock(&browser.fullscreen).layout(bounds);
    apply_step(&app, &browser, &webview, step).map_err(native_error)
}

/// 把全屏取舍的结果接到 webview 上。
fn apply_step(
    app: &AppHandle,
    browser: &Browser,
    webview: &tauri::Webview,
    step: Step<Bounds>,
) -> tauri::Result<()> {
    match step {
        Step::None => Ok(()),
        Step::Apply(Some(bounds)) => {
            webview.set_bounds(bounds.rect())?;
            webview.show()
        }
        Step::Apply(None) => {
            webview.hide()?;
            // 隐藏前焦点在网页里：还给主界面，键盘快捷键才接得上
            if browser.focused.swap(false, Ordering::Relaxed) {
                if let Some(main) = app.get_webview("main") {
                    let returned = main.set_focus().is_ok();
                    crate::key_diag::shell(
                        app,
                        &format!(
                            "browser_layout hide label={} focusReturned={returned}",
                            browser.label
                        ),
                    );
                }
            }
            Ok(())
        }
        Step::FillWindow => {
            let Some(window) = app.get_window("main") else {
                return Ok(());
            };
            let size = window.inner_size()?;
            webview.set_bounds(Rect {
                position: PhysicalPosition::new(0, 0).into(),
                size: size.into(),
            })?;
            webview.show()?;
            #[cfg(windows)]
            native::raise(webview)?;
            Ok(())
        }
        Step::ExitPage => {
            #[cfg(windows)]
            native::exit_page(webview)?;
            Ok(())
        }
    }
}

/// 网页进出全屏（WebView2 `ContainsFullScreenElementChanged`）。事件回调里不直接改
/// webview：换个线程把活排回事件循环，和 tauri-runtime-wry 切窗口全屏的消息一样异步。
#[cfg(windows)]
fn fullscreen_changed(app: &AppHandle, browser: &Arc<Browser>, on: bool) {
    let app = app.clone();
    let browser = Arc::clone(browser);
    std::thread::spawn(move || {
        let main = app.clone();
        let _ = main.run_on_main_thread(move || {
            let (was, step, now) = {
                let mut fullscreen = lock(&browser.fullscreen);
                let was = fullscreen.active();
                let step = fullscreen.changed(on);
                (was, step, fullscreen.active())
            };
            if was != now {
                window_fullscreen(&app, now);
                browser.send(BrowserMessage::Fullscreen { on: now });
            }
            if let Some(webview) = app.get_webview(&browser.label) {
                let _ = apply_step(&app, &browser, &webview, step);
            }
        });
    });
}

/// 窗口层的补正：tao 在最大化的窗口上直接把窗口拉到整屏，但窗口还带着最大化样式，
/// 无边框窗口的客户区仍按工作区算（底下空出任务栏那条），退出时恢复的也是最大化，
/// 矩形停在整屏。所以最大化时先还原再全屏（tao 记下普通位置），退出后再最大化。
/// tauri-runtime-wry 自己的全屏消息先于这里到，重复的切换 tao 会忽略。
fn window_fullscreen(app: &AppHandle, on: bool) {
    let (Some(window), Some(state)) =
        (app.get_window("main"), app.try_state::<Arc<BrowserState>>())
    else {
        return;
    };
    if on {
        if window.is_maximized().unwrap_or(false) {
            state.restore_maximized.store(true, Ordering::Relaxed);
            let _ = window.set_fullscreen(false);
            let _ = window.unmaximize();
            let _ = window.set_fullscreen(true);
        }
    } else {
        let _ = window.set_fullscreen(false);
        if state.restore_maximized.swap(false, Ordering::Relaxed) {
            let _ = window.maximize();
        }
    }
}

impl BrowserState {
    /// 主窗口尺寸变了：全屏中的网页跟着铺满（切到全屏是异步的，尺寸稍后才到）。
    pub fn window_resized(&self, app: &AppHandle) {
        let all: Vec<Arc<Browser>> = lock(&self.browsers).values().cloned().collect();
        for browser in all {
            let step = lock(&browser.fullscreen).resized();
            if matches!(step, Step::FillWindow) {
                if let Some(webview) = app.get_webview(&browser.label) {
                    let _ = apply_step(app, &browser, &webview, step);
                }
            }
        }
    }
}

/// 关掉还在全屏的网页时，tauri-runtime-wry 收不到退出事件，窗口会停在全屏：自己退出。
fn leave_window_fullscreen(app: &AppHandle, browser: &Browser) {
    if lock(&browser.fullscreen).active() {
        window_fullscreen(app, false);
    }
}

#[tauri::command]
pub fn browser_action(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserState>>,
    id: u32,
    action: String,
) -> CmdResult<()> {
    let browser = state.get(id)?;
    let webview = webview_of(&app, &browser)?;
    match action.as_str() {
        "reload" => webview.reload().map_err(native_error),
        #[cfg(windows)]
        "back" | "forward" | "stop" | "devtools" | "focus" => {
            native::action(&webview, &action).map_err(native_error)
        }
        _ => Err(CommandError::new(
            "browser_failed",
            format!("不支持的操作：{action}"),
        )),
    }
}

/// 截一张当前页面的 PNG（主界面浮层伸进面板时的占位，见 desktop.md 5.10）。
#[tauri::command]
pub async fn browser_capture(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserState>>,
    id: u32,
) -> CmdResult<tauri::ipc::Response> {
    let browser = state.get(id)?;
    let webview = webview_of(&app, &browser)?;
    #[cfg(windows)]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        webview
            .with_webview(move |platform| native::capture(&platform, tx))
            .map_err(native_error)?;
        let bytes = tauri::async_runtime::spawn_blocking(move || {
            rx.recv_timeout(std::time::Duration::from_secs(3))
        })
        .await
        .map_err(native_error)?
        .map_err(|_| CommandError::new("browser_failed", "截图超时"))?
        .ok_or_else(|| CommandError::new("browser_failed", "截图失败"))?;
        Ok(tauri::ipc::Response::new(bytes))
    }
    #[cfg(not(windows))]
    {
        let _ = webview;
        Err(CommandError::new("browser_failed", "这个平台不支持截图"))
    }
}

#[tauri::command]
pub fn browser_destroy(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserState>>,
    id: u32,
) -> CmdResult<()> {
    let Some(browser) = lock(&state.browsers).remove(&id) else {
        return Ok(());
    };
    leave_window_fullscreen(&app, &browser);
    if let Some(webview) = app.get_webview(&browser.label) {
        close_later(webview);
    }
    Ok(())
}

/// WebView2 原生接口：Tauri 没有包装的事件和操作。
#[cfg(windows)]
mod native {
    use super::{Browser, BrowserMessage};
    use crate::browser_policy;
    use std::sync::atomic::Ordering;
    use std::sync::mpsc::Sender;
    use std::sync::Arc;
    use tauri::{Manager, Url};
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::{
        take_pwstr, AcceleratorKeyPressedEventHandler, CapturePreviewCompletedHandler,
        ContainsFullScreenElementChangedEventHandler, ExecuteScriptCompletedHandler,
        FaviconChangedEventHandler, FocusChangedEventHandler, GetFaviconCompletedHandler,
        HistoryChangedEventHandler, LaunchingExternalUriSchemeEventHandler,
        PermissionRequestedEventHandler, SourceChangedEventHandler,
    };
    use windows::core::{Interface, HSTRING, PWSTR};
    use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;
    use windows::Win32::System::Com::{IStream, STATFLAG_NONAME, STATSTG, STREAM_SEEK_SET};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetKeyState, VK_CONTROL, VK_MENU, VK_SHIFT,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_TOP, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    };

    type WinResult = windows::core::Result<()>;

    fn down(key: u16) -> bool {
        // SAFETY: GetKeyState 只读当前线程的键盘状态
        unsafe { GetKeyState(i32::from(key)) < 0 }
    }

    fn read_stream(stream: &IStream) -> Option<Vec<u8>> {
        // SAFETY: stream 是 WebView2 回调交来的有效 COM 对象
        unsafe {
            let mut stat = STATSTG::default();
            stream.Stat(&mut stat, STATFLAG_NONAME).ok()?;
            stream.Seek(0, STREAM_SEEK_SET, None).ok()?;
            let mut bytes = vec![0u8; usize::try_from(stat.cbSize).ok()?];
            let mut read = 0u32;
            stream
                .Read(
                    bytes.as_mut_ptr().cast(),
                    u32::try_from(bytes.len()).ok()?,
                    Some(&mut read),
                )
                .ok()
                .ok()?;
            bytes.truncate(read as usize);
            Some(bytes)
        }
    }

    fn send_history(core: &ICoreWebView2, browser: &Browser) -> WinResult {
        let (mut back, mut forward) = (Default::default(), Default::default());
        // SAFETY: core 是有效的 ICoreWebView2
        unsafe {
            core.CanGoBack(&mut back)?;
            core.CanGoForward(&mut forward)?;
        }
        browser.send(BrowserMessage::History {
            back: back.as_bool(),
            forward: forward.as_bool(),
        });
        Ok(())
    }

    fn send_favicon(core: &ICoreWebView2, browser: Arc<Browser>) -> WinResult {
        let Ok(core15) = core.cast::<ICoreWebView2_15>() else {
            return Ok(());
        };
        // SAFETY: core15 有效；回调在主线程执行
        unsafe {
            let mut uri = PWSTR::null();
            core15.FaviconUri(&mut uri)?;
            if take_pwstr(uri).is_empty() {
                browser.send(BrowserMessage::Favicon { png: None });
                return Ok(());
            }
            core15.GetFavicon(
                COREWEBVIEW2_FAVICON_IMAGE_FORMAT_PNG,
                &GetFaviconCompletedHandler::create(Box::new(move |result, stream| {
                    let png = result.ok().and(stream).and_then(|s| read_stream(&s));
                    browser.send(BrowserMessage::Favicon { png });
                    Ok(())
                })),
            )
        }
    }

    /// 将 WebView2 Profile 的默认下载文件夹设为应用私有暂存目录（主窗口与面板浏览器共用）：
    /// WebView2 在触发 `DownloadStarting` 前就会往 `DefaultDownloadFolderPath` 预写 `<UUID>.tmp`，
    /// 重定向后用户「下载」文件夹与保存位置不会出现任何 `.tmp` 残留。
    unsafe fn set_profile_download_staging_dir(
        core: &ICoreWebView2,
        staging_dir: &std::path::Path,
    ) {
        if let Ok(core13) = core.cast::<ICoreWebView2_13>() {
            if let Ok(profile) = core13.Profile() {
                let path = HSTRING::from(staging_dir.as_os_str());
                let _ = profile.SetDefaultDownloadFolderPath(&path);
            }
        }
    }

    /// 主窗口壳页面：绑定下载暂存目录并放行 `MULTIPLE_AUTOMATIC_DOWNLOADS`。
    pub fn configure_main(
        window: &tauri::WebviewWindow,
        staging_dir: Option<std::path::PathBuf>,
    ) -> tauri::Result<()> {
        window.with_webview(move |platform| {
            let mut token = Default::default();
            // SAFETY: 主线程、有效的 WebView2 控制器
            let _ = unsafe {
                platform.controller().CoreWebView2().and_then(|core| {
                    if let Some(dir) = staging_dir.as_deref() {
                        set_profile_download_staging_dir(&core, dir);
                    }
                    core.add_PermissionRequested(
                        &PermissionRequestedEventHandler::create(Box::new(|_, args| {
                            let Some(args) = args else { return Ok(()) };
                            let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                            args.PermissionKind(&mut kind)?;
                            if kind == COREWEBVIEW2_PERMISSION_KIND_MULTIPLE_AUTOMATIC_DOWNLOADS {
                                args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                            }
                            Ok(())
                        })),
                        &mut token,
                    )
                })
            };
        })
    }

    pub fn set_webview_staging(
        webview: &tauri::Webview,
        staging_dir: std::path::PathBuf,
    ) -> tauri::Result<()> {
        webview.with_webview(move |platform| {
            // SAFETY: 主线程、有效的 WebView2 控制器
            unsafe {
                if let Ok(core) = platform.controller().CoreWebView2() {
                    set_profile_download_staging_dir(&core, &staging_dir);
                }
            }
        })
    }

    /// 挂原生事件，然后导航到第一个地址。
    pub fn attach(
        webview: &tauri::Webview,
        browser: Arc<Browser>,
        initial: Url,
        main: Option<tauri::Webview>,
    ) -> tauri::Result<()> {
        let app = webview.app_handle().clone();
        let staging_dir = super::ensure_staging_dir(&app);
        webview.with_webview(move |platform| {
            if let Err(error) = attach_inner(
                &platform.controller(),
                &browser,
                &initial,
                main,
                app,
                staging_dir.as_deref(),
            ) {
                browser.send(BrowserMessage::Blocked {
                    url: initial.to_string(),
                    reason: "failed",
                    message: format!("浏览器初始化失败：{error}"),
                });
            }
        })
    }

    fn attach_inner(
        controller: &ICoreWebView2Controller,
        browser: &Arc<Browser>,
        initial: &Url,
        main: Option<tauri::Webview>,
        app: tauri::AppHandle,
        staging_dir: Option<&std::path::Path>,
    ) -> WinResult {
        let mut token = Default::default();
        // SAFETY: 所有调用都在主线程、对有效的 WebView2 对象；回调闭包持有 Arc，不借用栈上数据
        unsafe {
            let core = controller.CoreWebView2()?;
            if let Some(dir) = staging_dir {
                set_profile_download_staging_dir(&core, dir);
            }
            // 「开发者工具」按钮：Tauri 只在调试构建或开 `devtools` 特性时打开开发者工具，
            // 正式包里 `WebviewBuilder::devtools(true)` 不生效；只给浏览器 webview 打开，
            // 主界面照旧关着
            core.Settings()?.SetAreDevToolsEnabled(true)?;

            let keys = Arc::clone(browser);
            controller.add_AcceleratorKeyPressed(
                &AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    let mut kind = COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN;
                    args.KeyEventKind(&mut kind)?;
                    if kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN {
                        return Ok(());
                    }
                    let mut status = COREWEBVIEW2_PHYSICAL_KEY_STATUS::default();
                    args.PhysicalKeyStatus(&mut status)?;
                    let mut key = 0u32;
                    args.VirtualKey(&mut key)?;
                    let (ctrl, shift, alt) = (down(VK_CONTROL), down(VK_SHIFT), down(VK_MENU));
                    // 网页全屏期间不拦：面板关在全屏底下、窗口却停在全屏里更糟
                    let matched = if super::lock(&keys.fullscreen).active() {
                        None
                    } else {
                        browser_policy::app_shortcut(key, ctrl, shift, alt)
                    };
                    let mut focus_returned = false;
                    if let Some(name) = matched {
                        args.SetHandled(true)?;
                        // 按住不放的自动重复只拦不转
                        if !status.WasKeyDown.as_bool() {
                            // 快捷键打开的都是主界面的东西（快速打开、新标签页、终端）：
                            // 键盘焦点先还给主界面，否则接着打字、按 Esc 仍落在网页里
                            if let Some(main) = &main {
                                focus_returned = main.set_focus().is_ok();
                            }
                            keys.send(BrowserMessage::Shortcut { key: name });
                        }
                    }
                    if let (Some(main), Some(line)) = (
                        &main,
                        crate::key_diag::accelerator_line(crate::key_diag::Accelerator {
                            label: &keys.label,
                            key,
                            ctrl,
                            shift,
                            alt,
                            was_down: status.WasKeyDown.as_bool(),
                            matched,
                            focus_returned,
                        }),
                    ) {
                        crate::key_diag::shell(main.app_handle(), &line);
                    }
                    Ok(())
                })),
                &mut token,
            )?;

            let got = Arc::clone(browser);
            let got_app = app.clone();
            let full_app = app.clone();
            controller.add_GotFocus(
                &FocusChangedEventHandler::create(Box::new(move |_, _| {
                    got.focused.store(true, Ordering::Relaxed);
                    crate::key_diag::shell(&got_app, &format!("GotFocus label={}", got.label));
                    Ok(())
                })),
                &mut token,
            )?;
            let lost = Arc::clone(browser);
            controller.add_LostFocus(
                &FocusChangedEventHandler::create(Box::new(move |_, _| {
                    lost.focused.store(false, Ordering::Relaxed);
                    crate::key_diag::shell(&app, &format!("LostFocus label={}", lost.label));
                    Ok(())
                })),
                &mut token,
            )?;

            // tauri-runtime-wry 自己也挂了这个事件，只把整个窗口切成全屏；webview 的尺寸归我们
            let full = Arc::clone(browser);
            core.add_ContainsFullScreenElementChanged(
                &ContainsFullScreenElementChangedEventHandler::create(Box::new(move |core, _| {
                    let Some(core) = core else { return Ok(()) };
                    let mut on = windows::core::BOOL::default();
                    core.ContainsFullScreenElement(&mut on)?;
                    super::fullscreen_changed(&full_app, &full, on.as_bool());
                    Ok(())
                })),
                &mut token,
            )?;

            let source = Arc::clone(browser);
            core.add_SourceChanged(
                &SourceChangedEventHandler::create(Box::new(move |core, _| {
                    let Some(core) = core else { return Ok(()) };
                    let mut uri = PWSTR::null();
                    core.Source(&mut uri)?;
                    source.send(BrowserMessage::Url {
                        url: take_pwstr(uri),
                    });
                    Ok(())
                })),
                &mut token,
            )?;

            let history = Arc::clone(browser);
            core.add_HistoryChanged(
                &HistoryChangedEventHandler::create(Box::new(move |core, _| {
                    if let Some(core) = core {
                        send_history(&core, &history)?;
                    }
                    Ok(())
                })),
                &mut token,
            )?;

            if let Ok(core15) = core.cast::<ICoreWebView2_15>() {
                let favicon = Arc::clone(browser);
                core15.add_FaviconChanged(
                    &FaviconChangedEventHandler::create(Box::new(move |core, _| {
                        if let Some(core) = core {
                            send_favicon(&core, Arc::clone(&favicon))?;
                        }
                        Ok(())
                    })),
                    &mut token,
                )?;
            }

            // iframe 里的自定义协议不走主框架的导航回调：在这里统一拦下，不交给系统
            if let Ok(core18) = core.cast::<ICoreWebView2_18>() {
                let external = Arc::clone(browser);
                core18.add_LaunchingExternalUriScheme(
                    &LaunchingExternalUriSchemeEventHandler::create(Box::new(move |_, args| {
                        let Some(args) = args else { return Ok(()) };
                        args.SetCancel(true)?;
                        let mut uri = PWSTR::null();
                        args.Uri(&mut uri)?;
                        let uri = take_pwstr(uri);
                        let scheme = uri
                            .split(':')
                            .next()
                            .unwrap_or_default()
                            .to_ascii_lowercase();
                        let blocked = browser_policy::Blocked::External { scheme };
                        external.send(BrowserMessage::Blocked {
                            url: uri,
                            reason: blocked.reason(),
                            message: blocked.message(),
                        });
                        Ok(())
                    })),
                    &mut token,
                )?;
            }

            core.Navigate(&HSTRING::from(initial.as_str()))?;
        }
        Ok(())
    }

    pub fn action(webview: &tauri::Webview, action: &str) -> tauri::Result<()> {
        let action = action.to_string();
        webview.with_webview(move |platform| {
            let controller = platform.controller();
            // SAFETY: 主线程、有效的 WebView2 对象
            let _ = unsafe {
                controller
                    .CoreWebView2()
                    .and_then(|core| match action.as_str() {
                        "back" => core.GoBack(),
                        "forward" => core.GoForward(),
                        "stop" => core.Stop(),
                        "devtools" => core.OpenDevToolsWindow(),
                        "focus" => {
                            controller.MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC)
                        }
                        _ => Ok(()),
                    })
            };
        })
    }

    /// 放到主窗口子窗口的最上层：wry 调尺寸时不动 Z 序（SWP_NOZORDER）。
    pub fn raise(webview: &tauri::Webview) -> tauri::Result<()> {
        webview.with_webview(|platform| {
            let mut hwnd = windows::Win32::Foundation::HWND::default();
            // SAFETY: 主线程、有效的 WebView2 控制器；hwnd 是 wry 建的容器窗口
            unsafe {
                if platform.controller().ParentWindow(&mut hwnd).is_ok() {
                    SetWindowPos(
                        hwnd.0,
                        HWND_TOP,
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                    );
                }
            }
        })
    }

    /// 让网页退出全屏；退出事件随后把 webview 放回面板或隐藏。
    pub fn exit_page(webview: &tauri::Webview) -> tauri::Result<()> {
        webview.with_webview(|platform| {
            // SAFETY: 主线程、有效的 WebView2 对象
            let _ = unsafe {
                platform.controller().CoreWebView2().and_then(|core| {
                    core.ExecuteScript(
                        &HSTRING::from("document.fullscreenElement && document.exitFullscreen()"),
                        &ExecuteScriptCompletedHandler::create(Box::new(|_, _| Ok(()))),
                    )
                })
            };
        })
    }

    pub fn capture(platform: &tauri::webview::PlatformWebview, done: Sender<Option<Vec<u8>>>) {
        // SAFETY: 主线程、有效的 WebView2 对象；stream 由回调闭包持有到完成
        let result = unsafe {
            (|| -> windows::core::Result<()> {
                let core = platform.controller().CoreWebView2()?;
                let stream = CreateStreamOnHGlobal(Default::default(), true)?;
                let output = stream.clone();
                let tx = done.clone();
                core.CapturePreview(
                    COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                    &stream,
                    &CapturePreviewCompletedHandler::create(Box::new(move |result| {
                        let _ = tx.send(result.ok().and_then(|()| read_stream(&output)));
                        Ok(())
                    })),
                )
            })()
        };
        if result.is_err() {
            let _ = done.send(None);
        }
    }
}

#[cfg(test)]
mod tests {
    /// 关浏览器 webview 只能经 [`super::close_later`]：在主线程上直接关，会和正在创建的
    /// webview 争同一把锁，整个应用卡死（desktop.md 5.10）。这里没法真的建 webview，
    /// 只检查源码里关 webview 的地方只有那一处。
    #[test]
    fn webviews_are_closed_only_through_close_later() {
        let close = [".clo", "se()"].concat();
        let source = include_str!("browser.rs");
        let code = &source[..source.find("#[cfg(test)]").unwrap_or(source.len())];
        let calls: Vec<&str> = code
            .lines()
            .filter(|line| !line.trim_start().starts_with("//") && line.contains(&close))
            .collect();
        assert_eq!(calls, ["        let _ = webview.close();"]);
    }

    #[test]
    fn resolve_download_destination_asks_when_enabled_or_unsynced_and_handles_cancel() {
        use super::{lock, resolve_download_destination, BrowserState, DownloadPrefs};
        use std::path::{Path, PathBuf};

        let state = BrowserState::default();
        let default_dir = PathBuf::from(r"C:\Users\me\Downloads");
        let initial = PathBuf::from(r"C:\Users\me\Downloads\shot.png");

        // 1) download_prefs 尚未同步（None）：按询问处理，初始目录回退系统下载目录，取消返回 None
        let mut prompted: Option<(Option<PathBuf>, String)> = None;
        let cancelled = resolve_download_destination(
            &state,
            Some(&default_dir),
            None,
            "blob:http://tauri.localhost/1",
            &initial,
            |_| true,
            |dir, name| {
                prompted = Some((dir.map(Path::to_path_buf), name.to_string()));
                None
            },
        );
        assert_eq!(cancelled, None);
        assert_eq!(
            prompted,
            Some((Some(default_dir.clone()), "shot.png".into()))
        );
        assert!(lock(&state.pending_saves).is_empty());

        // 2) ask = true 且配置了自定义目录：初始目录为配置的保存位置，确认后返回所选路径
        let custom_dir = PathBuf::from(r"D:\Saved");
        *lock(&state.download_prefs) = Some(DownloadPrefs {
            ask: true,
            dir: Some(custom_dir.clone()),
        });
        let chosen_path = custom_dir.join("renamed.png");
        let mut prompted_custom: Option<(Option<PathBuf>, String)> = None;
        let saved = resolve_download_destination(
            &state,
            Some(&default_dir),
            None,
            "blob:http://tauri.localhost/2",
            &initial,
            |_| true,
            |dir, name| {
                prompted_custom = Some((dir.map(Path::to_path_buf), name.to_string()));
                Some(chosen_path.clone())
            },
        );
        assert_eq!(saved, Some(chosen_path));
        assert_eq!(
            prompted_custom,
            Some((Some(custom_dir), "shot.png".into()))
        );

        // 3) ask = true 且未设置保存位置（dir = None）：初始目录使用系统下载目录
        *lock(&state.download_prefs) = Some(DownloadPrefs {
            ask: true,
            dir: None,
        });
        let mut prompted_default: Option<Option<PathBuf>> = None;
        let _ = resolve_download_destination(
            &state,
            Some(&default_dir),
            None,
            "blob:http://tauri.localhost/3",
            &initial,
            |_| true,
            |dir, _| {
                prompted_default = Some(dir.map(Path::to_path_buf));
                None
            },
        );
        assert_eq!(prompted_default, Some(Some(default_dir)));
    }

    #[test]
    fn resolve_download_destination_saves_directly_and_deduplicates_names() {
        use super::{
            finish_pending_save, lock, resolve_download_destination, BrowserState, DownloadPrefs,
        };

        let temp = std::env::temp_dir().join(format!(
            "nocturne-dl-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&temp).unwrap();

        let state = BrowserState::default();
        // 未设置自定义 dir 时（dir = None），直接存到系统默认下载目录（此处传入 temp）
        *lock(&state.download_prefs) = Some(DownloadPrefs {
            ask: false,
            dir: None,
        });
        let initial = temp.join("report.pdf");

        // 第一次：report.pdf（记录在 pending_saves 中，尚未落盘）
        let first = resolve_download_destination(
            &state,
            Some(&temp),
            None,
            "blob:1",
            &initial,
            |_| true,
            |_, _| panic!("should not prompt"),
        );
        assert_eq!(first, Some(temp.join("report.pdf")));

        // 第二次（第一次尚未结束，在 pending_saves 中占用）：自动变成 report (1).pdf
        let second = resolve_download_destination(
            &state,
            Some(&temp),
            None,
            "blob:2",
            &initial,
            |_| true,
            |_, _| panic!("should not prompt"),
        );
        assert_eq!(second, Some(temp.join("report (1).pdf")));

        // 模拟落盘并结束在途记录后，磁盘上已存在 report.pdf 与 report (1).pdf，第三次应得 report (2).pdf
        std::fs::write(temp.join("report.pdf"), b"a").unwrap();
        std::fs::write(temp.join("report (1).pdf"), b"b").unwrap();
        finish_pending_save(&state, "blob:1");
        finish_pending_save(&state, "blob:2");
        assert!(lock(&state.pending_saves).is_empty());

        let third = resolve_download_destination(
            &state,
            Some(&temp),
            None,
            "blob:3",
            &initial,
            |_| true,
            |_, _| panic!("should not prompt"),
        );
        assert_eq!(third, Some(temp.join("report (2).pdf")));

        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn is_webview_download_tmp_name_matches_only_uuid_tmps() {
        use super::is_webview_download_tmp_name;

        assert!(is_webview_download_tmp_name(
            "0d42944e-ef71-4336-bc32-b93c6ff7e52c.tmp"
        ));
        assert!(is_webview_download_tmp_name(
            "BA9602F4-19B3-4957-93F5-72EBA5F3C90D.tmp"
        ));
        assert!(!is_webview_download_tmp_name("notes.tmp"));
        assert!(!is_webview_download_tmp_name("draft-2026.tmp"));
        assert!(!is_webview_download_tmp_name(
            "0d42944e-ef71-4336-bc32-b93c6ff7e52c.png"
        ));
        assert!(!is_webview_download_tmp_name(
            "0d42944eef714336bc32b93c6ff7e52c.tmp"
        ));
        assert!(!is_webview_download_tmp_name(
            "0d42944e-ef71-4336-bc32-b93c6ff7e52z.tmp"
        ));
    }

    #[test]
    fn prune_staging_root_removes_only_dead_pid_uuid_tmps_and_preserves_other_files() {
        use super::{clean_webview_tmps_in_dir, prune_staging_root};

        let root = std::env::temp_dir().join(format!(
            "nocturne-staging-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let alive_dir = root.join("pid-200");
        let dead_only_uuid = root.join("pid-300");
        let dead_with_other = root.join("pid-400");
        let current_dir = root.join("pid-100");
        for d in [&alive_dir, &dead_only_uuid, &dead_with_other, &current_dir] {
            std::fs::create_dir_all(d).unwrap();
        }

        // 根级无关 .tmp 文件与存活/当前进程目录均不得被触碰
        let root_unrelated = root.join("user-unrelated.tmp");
        let alive_uuid = alive_dir.join("0d42944e-ef71-4336-bc32-b93c6ff7e52c.tmp");
        let current_uuid = current_dir.join("11111111-2222-3333-4444-555555555555.tmp");
        let current_other = current_dir.join("keep-note.tmp");
        let dead1_uuid = dead_only_uuid.join("ba9602f4-19b3-4957-93f5-72eba5f3c90d.tmp");
        let dead2_uuid = dead_with_other.join("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.tmp");
        let dead2_other = dead_with_other.join("important.tmp");

        for f in [
            &root_unrelated,
            &alive_uuid,
            &current_uuid,
            &current_other,
            &dead1_uuid,
            &dead2_uuid,
            &dead2_other,
        ] {
            std::fs::write(f, b"x").unwrap();
        }

        prune_staging_root(&root, 100, |pid| pid == 200);

        // 已退出且仅含 WebView2 UUID .tmp 的目录被连同文件清除
        assert!(!dead1_uuid.exists());
        assert!(!dead_only_uuid.exists());
        // 已退出但含有其他 .tmp 的目录：仅删 WebView2 UUID .tmp，保留其他 .tmp 与目录
        assert!(!dead2_uuid.exists());
        assert!(dead2_other.exists());
        // 存活进程、当前进程与根级其他 .tmp 一律不动
        assert!(root_unrelated.exists());
        assert!(alive_uuid.exists());
        assert!(current_uuid.exists());
        assert!(current_other.exists());

        // 单目录清理同样只删 UUID .tmp，不碰同目录其他 .tmp
        clean_webview_tmps_in_dir(&current_dir);
        assert!(!current_uuid.exists());
        assert!(current_other.exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_download_destination_never_exposes_staging_dir_as_prompt_fallback() {
        use super::{resolve_download_destination, BrowserState};
        use std::path::{Path, PathBuf};

        let state = BrowserState::default();
        let staging = PathBuf::from(r"C:\AppLocal\download-staging\pid-999");
        let staged_initial = staging.join("photo.png");

        let mut prompted_when_staged: Option<Option<PathBuf>> = None;
        let _ = resolve_download_destination(
            &state,
            None,
            Some(&staging),
            "blob:1",
            &staged_initial,
            |_| true,
            |dir, _| {
                prompted_when_staged = Some(dir.map(Path::to_path_buf));
                None
            },
        );
        assert_eq!(prompted_when_staged, Some(None));
    }
}
