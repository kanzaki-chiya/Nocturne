//! Nocturne 桌面外壳（ADR-0046）：只做三件事——启停 `nctrn rpc --stdio` 子进程、
//! 按行转发 stdin/stdout、把子进程退出通知前端。所有 Nocturne 语义在前端经
//! `@nocturne/rpc/client` 处理。

mod backend;
mod job;
mod lines;
mod workspace;
mod node;

use backend::{close_backend, AppState};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// 窗口关闭时每个后台的关闭超时（与 backend_close 相同）。
const SHUTDOWN_CLOSE_TIMEOUT: Duration = Duration::from_secs(5);

/// 对所有后台并行执行关闭（各自超时后强杀），全部结束才返回。
fn close_all_backends(app: &AppHandle) {
    let backends = app.state::<Arc<AppState>>().backends_snapshot();
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
        close_all_backends(&app);
        app.exit(0);
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            backend::backend_open,
            backend::backend_send,
            backend::backend_close,
            backend::node_probe,
            backend::plain_workspace,
        ])
        .setup(|app| {
            let resource_dir = app
                .path()
                .resource_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            let state = Arc::new(AppState::new(resource_dir));
            #[cfg(windows)]
            state.init_job();
            app.manage(state);
            Ok(())
        })
        .on_window_event(|window, event| {
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
        .build(tauri::generate_context!())
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
