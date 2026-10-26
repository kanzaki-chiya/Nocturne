//! Independent, memory-only shortcut diagnostics. Never receives ordinary typing or page metadata.
use std::collections::VecDeque;
use std::sync::Mutex;
use tauri::Manager;

const CAPACITY: usize = 500;
const LINE_LIMIT: usize = 4096;

#[derive(Default)]
pub struct KeyDiag(Mutex<VecDeque<String>>);

impl KeyDiag {
    pub fn push(&self, source: &str, line: &str) {
        let mut end = line.len().min(LINE_LIMIT);
        while !line.is_char_boundary(end) {
            end -= 1;
        }
        let line = line[..end].replace(['\r', '\n'], " ");
        let line = format!(
            "{} {source} {line}",
            chrono::Local::now().format("%H:%M:%S%.3f")
        );
        let mut lines = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if lines.len() == CAPACITY {
            lines.pop_front();
        }
        lines.push_back(line);
    }

    fn snapshot(&self) -> Vec<String> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .cloned()
            .collect()
    }
}

pub fn shell(app: &tauri::AppHandle, line: &str) {
    if let Some(diag) = app.try_state::<KeyDiag>() {
        diag.push("shell", line);
    }
}

pub struct Accelerator<'a> {
    pub label: &'a str,
    pub key: u32,
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
    pub was_down: bool,
    pub matched: Option<&'a str>,
    pub focus_returned: bool,
}

pub fn accelerator_line(key: Accelerator<'_>) -> Option<String> {
    key.ctrl.then(|| format!("AcceleratorKeyPressed label={} vk={} ctrl={} shift={} alt={} WasKeyDown={} matched={} focusReturned={}", key.label, key.key, key.ctrl, key.shift, key.alt, key.was_down, key.matched.unwrap_or("none"), key.focus_returned))
}

#[tauri::command]
pub fn key_diag_push(
    webview: tauri::Webview,
    state: tauri::State<'_, KeyDiag>,
    lines: Vec<String>,
) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("仅主界面可写入按键诊断".into());
    }
    for line in lines.iter().take(CAPACITY) {
        state.push("main", line);
    }
    Ok(())
}

#[tauri::command]
pub fn key_diag_log(
    webview: tauri::Webview,
    state: tauri::State<'_, KeyDiag>,
) -> Result<Vec<String>, String> {
    if webview.label() != "main" {
        return Err("仅主界面可读取按键诊断".into());
    }
    Ok(state.snapshot())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_capacity_truncation_and_single_line() {
        let diag = KeyDiag::default();
        for n in 0..501 {
            diag.push("main", &format!("event={n}"));
        }
        let lines = diag.snapshot();
        assert_eq!(lines.len(), 500);
        assert!(lines[0].ends_with("main event=1"));
        diag.push("shell", &format!("\r\n{}", "中".repeat(5000)));
        let lines = diag.snapshot();
        let last = lines.last().unwrap();
        assert!(last.len() <= LINE_LIMIT + 32);
        assert!(!last.contains(['\r', '\n']));
        assert_eq!(&last[2..3], ":");
        assert_eq!(&last[8..9], ".");
    }

    #[test]
    fn accelerator_format_and_no_plain_keys() {
        let make = |ctrl| {
            accelerator_line(Accelerator {
                label: "nct-browser-1",
                key: 66,
                ctrl,
                shift: false,
                alt: false,
                was_down: false,
                matched: Some("b"),
                focus_returned: true,
            })
        };
        assert!(make(false).is_none());
        assert_eq!(make(true).unwrap(), "AcceleratorKeyPressed label=nct-browser-1 vk=66 ctrl=true shift=false alt=false WasKeyDown=false matched=b focusReturned=true");
    }
}
