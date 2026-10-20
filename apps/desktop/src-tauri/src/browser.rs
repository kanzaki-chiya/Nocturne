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
use crate::browser_policy::{self, Blocked, DownloadReport, Downloads};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::ipc::Channel;
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Rect, Url, WebviewUrl};

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
}

#[derive(Default)]
struct Nav {
    /// 当前文档的地址（页面提交时更新）：判断「网页从 http(s) 跳到 file」
    current: Option<Url>,
    /// 我们自己发起的那次导航：用户主动打开的本地文件凭它放行
    user_target: Option<Url>,
}

impl Browser {
    fn send(&self, message: BrowserMessage) {
        let _ = self.channel.send(message);
    }
}

#[derive(Default)]
pub struct BrowserState {
    next_id: AtomicU32,
    browsers: Mutex<HashMap<u32, Arc<Browser>>>,
    /// 启动时接管的 `WEBVIEW2_USER_DATA_FOLDER`（browser_policy::browser_data_dir）
    data_override: Option<std::path::PathBuf>,
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
            if let Some(webview) = app.get_webview(&browser.label) {
                close_later(webview);
            }
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
fn close_later(webview: tauri::Webview) {
    std::thread::spawn(move || {
        let _ = webview.close();
    });
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

/// 下载：弹系统的「另存为」，取消就不下载；不自动存进默认目录。结果配对见
/// [`browser_policy::Downloads`]。
fn on_download(app: &AppHandle, browser: &Browser, event: DownloadEvent<'_>) -> bool {
    match event {
        DownloadEvent::Requested { url, destination } => {
            let name = destination
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "download".into());
            match save_as(app, destination, &name) {
                Some(path) => {
                    let chosen = path
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or(name);
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
fn save_as(app: &AppHandle, default: &std::path::Path, name: &str) -> Option<std::path::PathBuf> {
    let mut dialog = rfd::FileDialog::new()
        .set_title("另存为")
        .set_file_name(name);
    if let Some(dir) = default.parent().filter(|d| d.is_dir()) {
        dialog = dialog.set_directory(dir);
    }
    if let Some(window) = app.get_window("main") {
        dialog = dialog.set_parent(&window);
    }
    dialog.save_file()
}

#[cfg(not(windows))]
fn save_as(_: &AppHandle, _: &std::path::Path, _: &str) -> Option<std::path::PathBuf> {
    None
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
    let data_dir = match state.data_override.as_deref() {
        Some(dir) => browser_policy::browser_data_dir(dir, Some(dir)),
        None => browser_policy::browser_data_dir(
            &app.path().app_local_data_dir().map_err(native_error)?,
            None,
        ),
    };
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
/// 连续的调整不会乱序。
#[tauri::command]
pub fn browser_layout(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserState>>,
    id: u32,
    bounds: Option<Bounds>,
) -> CmdResult<()> {
    let browser = state.get(id)?;
    let webview = webview_of(&app, &browser)?;
    match bounds {
        Some(bounds) => {
            webview.set_bounds(bounds.rect()).map_err(native_error)?;
            webview.show().map_err(native_error)
        }
        None => {
            webview.hide().map_err(native_error)?;
            // 隐藏前焦点在网页里：还给主界面，键盘快捷键才接得上
            if browser.focused.swap(false, Ordering::Relaxed) {
                if let Some(main) = app.get_webview("main") {
                    let _ = main.set_focus();
                }
            }
            Ok(())
        }
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
    use tauri::Url;
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::{
        take_pwstr, AcceleratorKeyPressedEventHandler, CapturePreviewCompletedHandler,
        FaviconChangedEventHandler, FocusChangedEventHandler, GetFaviconCompletedHandler,
        HistoryChangedEventHandler, LaunchingExternalUriSchemeEventHandler,
        SourceChangedEventHandler,
    };
    use windows::core::{Interface, HSTRING, PWSTR};
    use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;
    use windows::Win32::System::Com::{IStream, STATFLAG_NONAME, STATSTG, STREAM_SEEK_SET};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetKeyState, VK_CONTROL, VK_MENU, VK_SHIFT,
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

    /// 挂原生事件，然后导航到第一个地址。
    pub fn attach(
        webview: &tauri::Webview,
        browser: Arc<Browser>,
        initial: Url,
        main: Option<tauri::Webview>,
    ) -> tauri::Result<()> {
        webview.with_webview(move |platform| {
            if let Err(error) = attach_inner(&platform.controller(), &browser, &initial, main) {
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
    ) -> WinResult {
        let mut token = Default::default();
        // SAFETY: 所有调用都在主线程、对有效的 WebView2 对象；回调闭包持有 Arc，不借用栈上数据
        unsafe {
            let core = controller.CoreWebView2()?;
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
                    if let Some(name) = browser_policy::app_shortcut(
                        key,
                        down(VK_CONTROL),
                        down(VK_SHIFT),
                        down(VK_MENU),
                    ) {
                        args.SetHandled(true)?;
                        // 按住不放的自动重复只拦不转
                        if !status.WasKeyDown.as_bool() {
                            // 快捷键打开的都是主界面的东西（快速打开、新标签页、终端）：
                            // 键盘焦点先还给主界面，否则接着打字、按 Esc 仍落在网页里
                            if let Some(main) = &main {
                                let _ = main.set_focus();
                            }
                            keys.send(BrowserMessage::Shortcut { key: name });
                        }
                    }
                    Ok(())
                })),
                &mut token,
            )?;

            let got = Arc::clone(browser);
            controller.add_GotFocus(
                &FocusChangedEventHandler::create(Box::new(move |_, _| {
                    got.focused.store(true, Ordering::Relaxed);
                    Ok(())
                })),
                &mut token,
            )?;
            let lost = Arc::clone(browser);
            controller.add_LostFocus(
                &FocusChangedEventHandler::create(Box::new(move |_, _| {
                    lost.focused.store(false, Ordering::Relaxed);
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
}
