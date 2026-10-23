//! Windows 上的 WebView2 实现（desktop-browser.md 第 2、5 节）：创建 agent 标签的
//! 子 webview、经 CDP 执行动作、接原生事件（脚本对话框、导航完成、焦点）。
//!
//! 非 Windows 平台只提供返回「不支持」的占位实现：面板浏览器本身就是 Windows 功能。

#![allow(unused_variables)]

use super::{AgentBrowserState, AgentPlatform, AgentTab, Rect, OFFSCREEN_SIZE, OFFSCREEN_X};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak};
use std::time::{Duration, Instant};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Url};

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(windows)]
pub struct ShellPlatform {
    app: AppHandle,
    data_override: Option<PathBuf>,
    webviews: Mutex<HashMap<String, tauri::Webview>>,
    state: OnceLock<Weak<AgentBrowserState>>,
}

#[cfg(windows)]
impl ShellPlatform {
    pub fn new(app: AppHandle, data_override: Option<PathBuf>) -> Arc<Self> {
        Arc::new(Self {
            app,
            data_override,
            webviews: Mutex::new(HashMap::new()),
            state: OnceLock::new(),
        })
    }

    pub fn bind(&self, state: Weak<AgentBrowserState>) {
        let _ = self.state.set(state);
    }

    fn state(&self) -> Option<Arc<AgentBrowserState>> {
        self.state.get().and_then(Weak::upgrade)
    }

    fn state_weak(&self) -> Option<Weak<AgentBrowserState>> {
        self.state.get().cloned()
    }

    fn agent_dir(&self) -> PathBuf {
        let app_local = self
            .app
            .path()
            .app_local_data_dir()
            .unwrap_or_else(|_| PathBuf::from("."));
        crate::browser_policy::agent_data_dir(&app_local, self.data_override.as_deref())
    }

    fn webview(&self, tab: &Arc<AgentTab>) -> Result<tauri::Webview, String> {
        lock(&self.webviews)
            .get(&tab.id)
            .cloned()
            .ok_or_else(|| "标签已经关闭".to_string())
    }
}

#[cfg(windows)]
impl AgentPlatform for ShellPlatform {
    fn create(&self, tab: &Arc<AgentTab>) -> Result<(), String> {
        let window = self
            .app
            .get_window("main")
            .ok_or_else(|| "主窗口不存在".to_string())?;
        let dev = self.dev_url();
        let weak_state = self.state_weak();
        let nav_tab = Arc::clone(tab);
        let title_tab = Arc::clone(tab);
        let page_tab = Arc::clone(tab);
        let state_page = weak_state.clone();
        let state_title = weak_state.clone();
        let download_tab = Arc::clone(tab);
        let download_state = weak_state.clone();
        let popup_tab = Arc::clone(tab);
        let popup_state = weak_state.clone();
        let nav_state = weak_state.clone();
        let builder = tauri::webview::WebviewBuilder::new(
            &tab.label,
            tauri::WebviewUrl::External(
                "about:blank"
                    .parse()
                    .map_err(|_| "初始地址无效".to_string())?,
            ),
        )
        .data_directory(self.agent_dir())
        // 新建时不抢键盘焦点：默认会把原生焦点移进新 webview，用户正在输入的字落进 agent 的网页，
        // 而且用户之后点进来也不再触发 GotFocus，自动接管失效
        .focused(false)
        .on_navigation(move |url| {
            let dev = dev.as_ref();
            let current = nav_tab.url_text();
            let current = Url::parse(&current).ok();
            let agent_port = nav_state
                .as_ref()
                .and_then(|weak| weak.upgrade())
                .and_then(|state| state.server_port());
            match crate::browser_policy::agent_allow_navigation(
                url,
                current.as_ref(),
                None,
                dev,
                agent_port,
            ) {
                Ok(()) => true,
                Err(blocked) => {
                    *nav_tab.notice.lock().unwrap_or_else(|p| p.into_inner()) =
                        Some(blocked.message());
                    false
                }
            }
        })
        .on_new_window(move |url, _| {
            // `target=_blank` / `window.open`：同一 actor 的新 agent 标签，不开原生弹窗
            let tab = Arc::clone(&popup_tab);
            let state = popup_state.clone();
            let url = url.to_string();
            std::thread::spawn(move || {
                let Some(state) = state.and_then(|weak| weak.upgrade()) else {
                    return;
                };
                if !state.capacity_available() {
                    *tab.notice.lock().unwrap_or_else(|p| p.into_inner()) =
                        Some("新窗口被拒绝：浏览器数量已达上限".into());
                    return;
                }
                let binding = tab.binding_id.clone();
                let root = tab.root.clone();
                let actor = tab.actor.clone();
                let _ = state.create_tab(&binding, &root, &actor, &url);
            });
            tauri::webview::NewWindowResponse::Deny
        })
        .on_document_title_changed(move |_, title| {
            if let Some(state) = state_title.as_ref().and_then(|weak| weak.upgrade()) {
                state.set_tab_title(&title_tab, &title);
            }
        })
        .on_page_load(move |_, payload| {
            let Some(state) = state_page.as_ref().and_then(|weak| weak.upgrade()) else {
                return;
            };
            match payload.event() {
                tauri::webview::PageLoadEvent::Started => {
                    state.document_changed(&page_tab, payload.url().as_str());
                    state.set_tab_loading(&page_tab, true);
                }
                tauri::webview::PageLoadEvent::Finished => {
                    state.set_tab_loading(&page_tab, false);
                }
            }
        })
        .on_download(move |_, event| {
            use tauri::webview::DownloadEvent;
            match event {
                DownloadEvent::Requested { .. } => {
                    // agent 标签的下载直接取消，不弹另存为、不自动存盘
                    download_tab.download_blocked.store(true, Ordering::SeqCst);
                    *download_tab
                        .notice
                        .lock()
                        .unwrap_or_else(|p| p.into_inner()) =
                        Some("下载已被取消：agent 不能写本机文件".into());
                    if let Some(state) = download_state.as_ref().and_then(|weak| weak.upgrade()) {
                        state.notify_tabs();
                    }
                    false
                }
                _ => true,
            }
        });
        let webview = window
            .add_child(
                builder,
                LogicalPosition::new(OFFSCREEN_X, 0.0),
                LogicalSize::new(OFFSCREEN_SIZE.0, OFFSCREEN_SIZE.1),
            )
            .map_err(|error| format!("创建浏览器失败：{error}"))?;
        lock(&self.webviews).insert(tab.id.clone(), webview.clone());
        if let Some(state) = self.state() {
            native::attach(&webview, Arc::clone(tab), state);
        }
        let url = tab.url_text();
        webview
            .navigate(url.parse().map_err(|_| "地址无效".to_string())?)
            .map_err(|error| format!("导航失败：{error}"))?;
        Ok(())
    }

    fn destroy(&self, tab: &Arc<AgentTab>) {
        // 关标签前先取消挂起的对话框，网页脚本不停在半路
        let id = tab.id.clone();
        let _ = self
            .app
            .run_on_main_thread(move || native::resolve_dialog(&id, false, None));
        let webview = lock(&self.webviews).remove(&tab.id);
        if let Some(webview) = webview {
            crate::browser::close_later_for_agent(webview);
        }
    }

    fn set_bounds(&self, tab: &Arc<AgentTab>, bounds: Rect) -> Result<(), String> {
        let webview = self.webview(tab)?;
        webview
            .set_bounds(tauri::Rect {
                position: LogicalPosition::new(bounds.x, bounds.y).into(),
                size: LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)).into(),
            })
            .map_err(|error| error.to_string())?;
        // 始终 shown：离屏时只是移出可见区域，hide 会让截图超时
        webview.show().map_err(|error| error.to_string())
    }

    fn navigate(&self, tab: &Arc<AgentTab>, url: &str) -> Result<(), String> {
        let target: Url = url.parse().map_err(|_| "地址无效".to_string())?;
        *tab.url.lock().unwrap_or_else(|p| p.into_inner()) = url.to_string();
        tab.loading.store(true, Ordering::SeqCst);
        self.webview(tab)?
            .navigate(target)
            .map_err(|error| error.to_string())
    }

    fn history(&self, tab: &Arc<AgentTab>, forward: bool) -> Result<(), String> {
        let webview = self.webview(tab)?;
        tab.loading.store(true, Ordering::SeqCst);
        webview
            .with_webview(move |platform| {
                // SAFETY: 主线程、有效的 WebView2 对象
                let _ = unsafe {
                    platform.controller().CoreWebView2().and_then(|core| {
                        if forward {
                            core.GoForward()
                        } else {
                            core.GoBack()
                        }
                    })
                };
            })
            .map_err(|error| error.to_string())
    }

    fn cdp(
        &self,
        tab: &Arc<AgentTab>,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let webview = self.webview(tab)?;
        let (tx, rx) = std::sync::mpsc::channel();
        let method = method.to_string();
        let payload = params.to_string();
        let sender = tx.clone();
        webview
            .with_webview(move |platform| {
                let method = method.clone();
                let payload = payload.clone();
                let sender = sender.clone();
                // SAFETY: 主线程、有效的 WebView2 对象；回调完成前 stream/闭包由 WebView2 持有
                let result = unsafe {
                    (|| -> windows::core::Result<()> {
                        let core = platform.controller().CoreWebView2()?;
                        core.CallDevToolsProtocolMethod(
                            &windows::core::HSTRING::from(method.as_str()),
                            &windows::core::HSTRING::from(payload.as_str()),
                            &webview2_com::CallDevToolsProtocolMethodCompletedHandler::create(
                                Box::new(move |result, json| {
                                    let value = match result {
                                        Ok(()) => serde_json::from_str(&json)
                                            .map_err(|error| format!("CDP 返回不是 JSON：{error}")),
                                        Err(error) => Err(format!("CDP 失败：{error}")),
                                    };
                                    let _ = sender.send(value);
                                    Ok(())
                                }),
                            ),
                        )
                    })()
                };
                if let Err(error) = result {
                    let _ = tx.send(Err(error.to_string()));
                }
            })
            .map_err(|error| error.to_string())?;
        // 动作触发脚本对话框时，CDP 要等对话框关掉才回复：看到对话框就不再等，交给调用方报 dialog_open
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match rx.recv_timeout(Duration::from_millis(50)) {
                Ok(value) => return value,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("CDP 通道已断开".into())
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    if lock(&tab.dialog).is_some() {
                        return Err("网页弹出了对话框".into());
                    }
                    if Instant::now() >= deadline {
                        return Err("CDP 超时".into());
                    }
                }
            }
        }
    }

    fn focus_main(&self) -> Result<(), String> {
        let main = self
            .app
            .get_webview("main")
            .ok_or_else(|| "主界面不存在".to_string())?;
        main.set_focus().map_err(|error| error.to_string())
    }

    fn child_focused(&self, tab: &Arc<AgentTab>) -> bool {
        tab.focused.load(Ordering::SeqCst)
    }

    fn resolve_dialog(
        &self,
        tab: &Arc<AgentTab>,
        accept: bool,
        text: Option<String>,
    ) -> Result<(), String> {
        let id = tab.id.clone();
        // 挂起的对话框参数只在主线程上有效
        self.app
            .run_on_main_thread(move || native::resolve_dialog(&id, accept, text.as_deref()))
            .map_err(|error| error.to_string())
    }

    fn live_webviews(&self) -> usize {
        self.app
            .try_state::<Arc<crate::browser::BrowserState>>()
            .map(|state| state.live_count())
            .unwrap_or(0)
    }

    fn dev_url(&self) -> Option<Url> {
        self.app.config().build.dev_url.clone()
    }
}

#[cfg(windows)]
mod native {
    use super::{AgentBrowserState, AgentTab};
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::sync::atomic::Ordering;
    use std::sync::Arc;
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::{
        take_pwstr, FocusChangedEventHandler, NavigationCompletedEventHandler,
        ScriptDialogOpeningEventHandler, SourceChangedEventHandler,
    };
    use windows::core::{HSTRING, PWSTR};

    thread_local! {
        /// 挂起的脚本对话框（按 tabId）。WebView2 对象只在主线程上用，所以放线程局部。
        static PENDING: RefCell<
            HashMap<String, (ICoreWebView2ScriptDialogOpeningEventArgs, ICoreWebView2Deferral)>,
        > = RefCell::new(HashMap::new());
    }

    /// 答复挂起的对话框（主线程）：确定时 prompt 带上输入；没有挂起的对话框时什么都不做。
    pub fn resolve_dialog(tab_id: &str, accept: bool, text: Option<&str>) {
        let Some((args, deferral)) = PENDING.with(|pending| pending.borrow_mut().remove(tab_id))
        else {
            return;
        };
        // SAFETY: 主线程、事件参数与 deferral 在 Complete 之前都有效
        unsafe {
            if accept {
                if let Some(text) = text {
                    let _ = args.SetResultText(&HSTRING::from(text));
                }
                let _ = args.Accept();
            }
            let _ = deferral.Complete();
        }
    }

    pub fn attach(webview: &tauri::Webview, tab: Arc<AgentTab>, state: Arc<AgentBrowserState>) {
        let callback_tab = Arc::clone(&tab);
        let _ = webview.with_webview(move |platform| {
            if let Err(error) = attach_inner(&platform.controller(), &callback_tab, &state) {
                *callback_tab
                    .notice
                    .lock()
                    .unwrap_or_else(|p| p.into_inner()) =
                    Some(format!("浏览器初始化失败：{error}"));
            }
        });
    }

    fn attach_inner(
        controller: &ICoreWebView2Controller,
        tab: &Arc<AgentTab>,
        state: &Arc<AgentBrowserState>,
    ) -> windows::core::Result<()> {
        let mut token = Default::default();
        // SAFETY: 全部在主线程、对有效的 WebView2 对象；闭包持有 Arc，不借用栈上数据
        unsafe {
            let core = controller.CoreWebView2()?;
            // 脚本对话框不弹原生窗口，也不自动答复：挂起它，内容推给面板横幅，由用户点确定或取消
            core.Settings()?.SetAreDefaultScriptDialogsEnabled(false)?;

            let dialog_tab = Arc::clone(tab);
            let dialog_state = Arc::clone(state);
            core.add_ScriptDialogOpening(
                &ScriptDialogOpeningEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    let mut kind = COREWEBVIEW2_SCRIPT_DIALOG_KIND_ALERT;
                    args.Kind(&mut kind)?;
                    let mut uri = PWSTR::null();
                    args.Uri(&mut uri)?;
                    let mut message = PWSTR::null();
                    args.Message(&mut message)?;
                    let mut default_text = PWSTR::null();
                    args.DefaultText(&mut default_text)?;
                    let kind_name = match kind {
                        COREWEBVIEW2_SCRIPT_DIALOG_KIND_CONFIRM => "confirm",
                        COREWEBVIEW2_SCRIPT_DIALOG_KIND_PROMPT => "prompt",
                        COREWEBVIEW2_SCRIPT_DIALOG_KIND_BEFOREUNLOAD => "beforeunload",
                        _ => "alert",
                    };
                    let dialog = super::super::DialogInfo {
                        kind: kind_name.to_string(),
                        uri: take_pwstr(uri),
                        message: take_pwstr(message),
                        default_text: take_pwstr(default_text),
                    };
                    // 不管 agent 控制还是用户接管，都等用户在横幅里答复；返回前不调用 Accept
                    let deferral = args.GetDeferral()?;
                    // 同一标签不会同时挂两个对话框；万一有旧的先取消，避免网页永远停住
                    resolve_dialog(&dialog_tab.id, false, None);
                    PENDING.with(|pending| {
                        pending
                            .borrow_mut()
                            .insert(dialog_tab.id.clone(), (args, deferral))
                    });
                    dialog_state.dialog_opened(&dialog_tab, dialog);
                    Ok(())
                })),
                &mut token,
            )?;

            let nav_tab = Arc::clone(tab);
            let nav_state = Arc::clone(state);
            core.add_NavigationCompleted(
                &NavigationCompletedEventHandler::create(Box::new(move |core, _| {
                    if let Some(core) = core {
                        let mut back = Default::default();
                        let mut forward = Default::default();
                        let _ = core.CanGoBack(&mut back);
                        let _ = core.CanGoForward(&mut forward);
                        nav_tab.back.store(back.as_bool(), Ordering::SeqCst);
                        nav_tab.forward.store(forward.as_bool(), Ordering::SeqCst);
                    }
                    nav_state.set_tab_loading(&nav_tab, false);
                    Ok(())
                })),
                &mut token,
            )?;

            let source_tab = Arc::clone(tab);
            let source_state = Arc::clone(state);
            core.add_SourceChanged(
                &SourceChangedEventHandler::create(Box::new(move |core, _| {
                    let Some(core) = core else { return Ok(()) };
                    let mut uri = PWSTR::null();
                    core.Source(&mut uri)?;
                    let url = take_pwstr(uri);
                    if !url.is_empty() && url != "about:blank" {
                        source_state.document_changed(&source_tab, &url);
                    }
                    Ok(())
                })),
                &mut token,
            )?;

            let focus_tab = Arc::clone(tab);
            let focus_state = Arc::clone(state);
            controller.add_GotFocus(
                &FocusChangedEventHandler::create(Box::new(move |_, _| {
                    focus_tab.focused.store(true, Ordering::SeqCst);
                    // 用户点进 agent 标签：原生焦点是撤销控制权的信号，不是权限批准
                    focus_state.auto_takeover(&focus_tab.id);
                    Ok(())
                })),
                &mut token,
            )?;
            let blur_tab = Arc::clone(tab);
            controller.add_LostFocus(
                &FocusChangedEventHandler::create(Box::new(move |_, _| {
                    blur_tab.focused.store(false, Ordering::SeqCst);
                    Ok(())
                })),
                &mut token,
            )?;
        }
        Ok(())
    }
}

// ── 非 Windows：占位实现 ──

#[cfg(not(windows))]
pub struct ShellPlatform;

#[cfg(not(windows))]
impl ShellPlatform {
    pub fn new(_app: AppHandle, _data_override: Option<PathBuf>) -> Arc<Self> {
        Arc::new(Self)
    }

    pub fn bind(&self, _state: Weak<AgentBrowserState>) {}
}

#[cfg(not(windows))]
impl AgentPlatform for ShellPlatform {
    fn create(&self, _tab: &Arc<AgentTab>) -> Result<(), String> {
        Err("这个平台不支持面板浏览器".into())
    }
    fn destroy(&self, _tab: &Arc<AgentTab>) {}
    fn set_bounds(&self, _tab: &Arc<AgentTab>, _bounds: Rect) -> Result<(), String> {
        Ok(())
    }
    fn navigate(&self, _tab: &Arc<AgentTab>, _url: &str) -> Result<(), String> {
        Err("这个平台不支持面板浏览器".into())
    }
    fn history(&self, _tab: &Arc<AgentTab>, _forward: bool) -> Result<(), String> {
        Err("这个平台不支持面板浏览器".into())
    }
    fn cdp(
        &self,
        _tab: &Arc<AgentTab>,
        _method: &str,
        _params: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        Err("这个平台不支持面板浏览器".into())
    }
    fn focus_main(&self) -> Result<(), String> {
        Err("这个平台不支持面板浏览器".into())
    }
    fn child_focused(&self, _tab: &Arc<AgentTab>) -> bool {
        false
    }
    fn live_webviews(&self) -> usize {
        0
    }
    fn dev_url(&self) -> Option<Url> {
        None
    }
    fn resolve_dialog(
        &self,
        _tab: &Arc<AgentTab>,
        _accept: bool,
        _text: Option<String>,
    ) -> Result<(), String> {
        Err("这个平台不支持面板浏览器".into())
    }
}

#[cfg(test)]
mod tests {
    use super::{Rect, OFFSCREEN_SIZE, OFFSCREEN_X};
    use std::sync::Mutex;

    /// 离屏位置必须离可见区域足够远，且不按 1×1 执行（desktop-browser.md 第 2 节）。
    #[test]
    fn offscreen_layout_keeps_a_real_viewport() {
        let rect = Rect::offscreen();
        assert!(rect.x <= -10000.0);
        assert!(rect.width >= 320.0);
        assert!(rect.height >= 240.0);
        assert_eq!(rect.x, OFFSCREEN_X);
        assert_eq!(rect.width, OFFSCREEN_SIZE.0);
    }

    #[test]
    fn unused_imports_are_referenced() {
        let mutex = Mutex::new(1u8);
        let guard = super::lock(&mutex);
        assert_eq!(*guard, 1);
    }
}
