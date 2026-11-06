use std::sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex};
use tauri::{AppHandle, Emitter};

#[derive(Default)]
pub struct ComputerHotkey {
    active: Arc<AtomicBool>,
    worker: Mutex<Option<std::thread::JoinHandle<()>>>,
}
#[cfg(windows)]
fn run_hotkey(app: AppHandle, active: Arc<AtomicBool>) -> Result<std::thread::JoinHandle<()>, String> {
    use windows_sys::Win32::System::Threading::GetCurrentThreadId;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, VK_ESCAPE};
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetMessageW, PostThreadMessageW, MSG, WM_HOTKEY, WM_QUIT};
    let (tx, rx) = std::sync::mpsc::channel();
    let flag = Arc::clone(&active);
    let handle = std::thread::spawn(move || unsafe {
        let tid = GetCurrentThreadId();
        if RegisterHotKey(std::ptr::null_mut(), 1, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, u32::from(VK_ESCAPE)) == 0 {
            let _ = tx.send(Err("无法注册停止快捷键".to_string()));
            return;
        }
        let _ = tx.send(Ok(tid));
        let mut msg: MSG = std::mem::zeroed();
        while flag.load(Ordering::SeqCst) && GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            if msg.message == WM_HOTKEY { let _ = app.emit("computer-stop-hotkey", ()); }
        }
        let _ = UnregisterHotKey(std::ptr::null_mut(), 1);
    });
    let tid = rx.recv().map_err(|e| e.to_string())??;
    let watcher = Arc::clone(&active);
    std::thread::spawn(move || {
        while watcher.load(Ordering::SeqCst) { std::thread::sleep(std::time::Duration::from_millis(40)); }
        unsafe { let _ = PostThreadMessageW(tid, WM_QUIT, 0, 0); }
    });
    Ok(handle)
}
#[tauri::command]
pub fn computer_set_hotkey(app: AppHandle, state: tauri::State<'_, Arc<ComputerHotkey>>, active: bool) -> bool {
    if !active {
        state.active.store(false, Ordering::SeqCst);
        if let Some(worker) = state.worker.lock().unwrap_or_else(|e| e.into_inner()).take() { let _ = worker.join(); }
        return true;
    }
    let mut guard = state.worker.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_some() { return true; }
    state.active.store(true, Ordering::SeqCst);
    #[cfg(windows)]
    match run_hotkey(app, Arc::clone(&state.active)) {
        Ok(worker) => { *guard = Some(worker); true }
        Err(_) => { state.active.store(false, Ordering::SeqCst); false }
    }
    #[cfg(not(windows))]
    { let _ = app; false }
}
