//! Nocturne 桌面外壳（ADR-0046）：启停 `nctrn rpc --stdio` 子进程、按行转发
//! stdin/stdout、把子进程退出通知前端；另管面板终端的 pty 进程和面板浏览器的子 webview
//! （ADR-0060）。
//! 所有 Nocturne 语义在前端经 `@nocturne/rpc/client` 处理。

mod agent_browser;
mod backend;
mod browser;
mod browser_policy;
mod editor;
mod images;
mod job;
mod key_diag;
mod lines;
mod node;
mod notify;
mod plugin_script;
mod terminal;
mod workspace;

use backend::{close_backend, AppState};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// 页面重载或窗口关闭时每个后台的关闭超时（与 backend_close 相同）。
const SHUTDOWN_CLOSE_TIMEOUT: Duration = Duration::from_secs(5);

/// 对捕获的后台并行执行关闭（各自超时后强杀），全部结束才返回。
/// 不在清理线程中重新读取状态，避免旧页面清理关掉新页面后台。
fn close_backends(backends: Vec<Arc<backend::Backend>>) {
    let handles: Vec<_> = backends
        .into_iter()
        .map(|backend| thread::spawn(move || close_backend(&backend, SHUTDOWN_CLOSE_TIMEOUT)))
        .collect();
    for handle in handles {
        let _ = handle.join();
    }
}

/// 开始退出流程：拦截关闭、后台线程关后台、结束后 app.exit(0)。
/// 重复触发直接返回（shutting_down 已置位）。
fn begin_shutdown(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || {
        let terminals = Arc::clone(app.state::<Arc<terminal::TerminalState>>().inner());
        let closing_terminals = thread::spawn(move || terminals.close_all());
        app.state::<Arc<browser::BrowserState>>().close_all(&app);
        // agent 浏览器：先撤绑定（阻断仍在途的 HTTP 调用），再关 webview
        let agents = app.state::<Arc<agent_browser::AgentBrowserState>>();
        agents.revoke_all();
        agents.destroy_all();
        close_backends(app.state::<Arc<AppState>>().backends_snapshot());
        let _ = closing_terminals.join();
        app.exit(0);
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 设了 WEBVIEW2_USER_DATA_FOLDER 时它会覆盖每个 WebView2 环境的数据目录，浏览器就和
    // 主界面共用一个目录（browser_policy::take_user_data_override）。这里还没有别的线程：
    // 读出来删掉，主窗口改在 setup 里显式用这个目录创建
    let webview_data = browser_policy::take_user_data_override();
    let mut context = tauri::generate_context!();
    let main_window = webview_data.as_ref().and_then(|_| {
        let windows = &mut context.config_mut().app.windows;
        let main = windows.iter_mut().find(|w| w.label == "main")?;
        main.create = false;
        Some(main.clone())
    });
    let commands: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        backend::app_note,
        backend::backend_send,
        backend::backend_close,
        backend::backend_stderr,
        backend::node_probe,
        backend::plain_workspace,
        backend::shell_log,
        key_diag::key_diag_push,
        key_diag::key_diag_log,
        images::pick_images,
        workspace::open_skill_directory,
        editor::detect_editors,
        editor::open_in_editor,
        editor::open_with_default,
        notify::notify_show,
        notify::notify_dismiss,
        terminal::terminal_open,
        terminal::terminal_write,
        terminal::terminal_resize,
        terminal::terminal_close,
        terminal::terminal_read_clipboard,
        terminal::terminal_write_clipboard,
        browser::browser_create,
        browser::browser_navigate,
        browser::browser_layout,
        browser::browser_action,
        browser::browser_capture,
        browser::browser_destroy,
        agent_browser::agent_browser_watch,
        agent_browser::agent_browser_ui_state,
        agent_browser::agent_browser_presented,
        agent_browser::agent_browser_control,
        agent_browser::agent_browser_dialog,
        agent_browser::agent_browser_set_enabled,
    ];
    tauri::Builder::default()
        // 不要插件往每个 webview 注入的 alert / confirm 改写（plugin_script.rs）：网页和主界面都用
        // WebView2 自带的脚本对话框
        .plugin(plugin_script::WithoutScript(tauri_plugin_dialog::init()))
        // 不要插件往每个 webview 注入的「_blank 链接交给系统浏览器」脚本：主界面的链接都自己
        // 处理；面板浏览器里它会吞掉 target=_blank 的点击（调 open_url 被 ACL 拒），也不该往
        // 第三方网页里注入东西
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(move |invoke| {
            if invoke.message.command() == "backend_open" {
                backend::handle_backend_open(invoke);
                true
            } else {
                commands(invoke)
            }
        })
        .setup(move |app| {
            let resource_dir = app
                .path()
                .resource_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            let state = Arc::new(AppState::new(node::strip_verbatim_prefix(resource_dir)));
            #[cfg(windows)]
            state.init_job();
            app.manage(state);
            app.manage(key_diag::KeyDiag::default());
            // 通知：持有每个会话当前那条 toast，点击回调才有效（ADR-0056）
            app.manage(notify::NotifyState::default());
            // 面板终端（ADR-0060 第 4 节）：页面重载、应用退出时全部结束
            app.manage(Arc::new(terminal::TerminalState::default()));
            // 面板浏览器（ADR-0060 第 5 节）：同上，随页面重载、应用退出全部关掉
            app.manage(Arc::new(browser::BrowserState::new(webview_data.clone())));
            // 第 5 轮 agent 浏览器：回环 MCP 与 agent 标签，默认关闭；开关落在
            // agent 专用目录的标记文件里，外壳启动时先读它再开服务器，和前端调用顺序无关
            {
                let platform = agent_browser::shell::ShellPlatform::new(
                    app.handle().clone(),
                    webview_data.clone(),
                );
                let enabled_path = app.path().app_local_data_dir().ok().map(|dir| {
                    browser_policy::agent_data_dir(&dir, webview_data.as_deref()).join("enabled")
                });
                let agents = agent_browser::AgentBrowserState::new(platform.clone(), enabled_path);
                platform.bind(Arc::downgrade(&agents));
                app.manage(agents);
            }
            if let (Some(config), Some(dir)) = (&main_window, &webview_data) {
                tauri::WebviewWindowBuilder::from_config(app.handle(), config)?
                    .data_directory(dir.clone())
                    .build()?;
            }
            Ok(())
        })
        .on_page_load(|webview, payload| {
            if webview.label() == "main"
                && matches!(payload.event(), tauri::webview::PageLoadEvent::Started)
            {
                // Tauri 创建初始窗口早于 setup；此时尚无状态，也不可能有后台。
                let Some(state) = webview.try_state::<Arc<AppState>>() else {
                    return;
                };
                // 换代必须在钩子内完成；不能放进可能晚于新页面启动的清理线程。
                let previous = state.begin_page_load();
                if !previous.is_empty() {
                    thread::spawn(move || close_backends(previous));
                }
                // 前端的终端标签随页面一起没了，进程不再有人接管
                if let Some(terminals) = webview.try_state::<Arc<terminal::TerminalState>>() {
                    let terminals = Arc::clone(terminals.inner());
                    thread::spawn(move || terminals.close_all());
                }
                if let Some(browsers) = webview.try_state::<Arc<browser::BrowserState>>() {
                    browsers.close_all(webview.app_handle());
                }
                // agent 标签与绑定随页面代际一起作废：先撤绑定再关 webview
                if let Some(agents) = webview.try_state::<Arc<agent_browser::AgentBrowserState>>() {
                    agent_browser::page_reloaded(agents.inner());
                }
            }
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::Focused(focused) = event {
                    key_diag::shell(
                        window.app_handle(),
                        &format!("WindowEvent::Focused {focused}"),
                    );
                }
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let state = window.state::<Arc<AppState>>();
                // 已经在退出流程中：不重复执行，等关后台线程收尾
                if state.shutting_down.swap(true, Ordering::SeqCst) {
                    return;
                }
                begin_shutdown(window.app_handle());
            }
        })
        .build(context)
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let state = app.state::<Arc<AppState>>();
                if state.shutting_down.swap(true, Ordering::SeqCst) {
                    // begin_shutdown 已经发过 app.exit：放行本次退出
                    return;
                }
                api.prevent_exit();
                begin_shutdown(app);
            }
        });
}
