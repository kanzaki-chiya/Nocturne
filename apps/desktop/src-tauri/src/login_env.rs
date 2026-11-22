//! macOS 登录 shell 环境探测（ADR-0110 第 6 节）：从访达或程序坞启动的应用
//! 拿不到 Homebrew / nvm 等写入 shell 配置的 PATH。外壳启动时在后台线程运行一次
//! 用户的登录 shell，按标记行解析出 PATH，供后台 Node 进程与面板终端使用；
//! 不改外壳进程自身的环境。Windows 不运行探测，纯函数解析与超时逻辑全平台单测。

use std::sync::mpsc;
use std::thread;
use std::time::Duration;

#[cfg(target_os = "macos")]
use std::io::Read;
#[cfg(target_os = "macos")]
use std::process::{Command, Stdio};
#[cfg(target_os = "macos")]
use std::sync::{Arc, Condvar, Mutex};
#[cfg(target_os = "macos")]
use std::time::Instant;

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const START_MARKER: &str = "__NOCTURNE_LOGIN_PATH_START__";
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const END_MARKER: &str = "__NOCTURNE_LOGIN_PATH_END__";
#[cfg(target_os = "macos")]
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(target_os = "macos")]
const MAX_PROBE_OUTPUT_BYTES: usize = 1024 * 1024;
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const FALLBACK_PREFIXES: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin"];

/// 从登录 shell 输出中提取标记行之间的 PATH；忽略前后杂散输出，空内容或缺失标记返回 None。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn parse_marked_path(output: &str) -> Option<String> {
    let lines: Vec<&str> = output
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect();
    let start = lines.iter().position(|&line| line == START_MARKER)?;
    let rest = &lines[start + 1..];
    let end = rest.iter().position(|&line| line == END_MARKER)?;
    let value = rest[..end]
        .iter()
        .copied()
        .find(|line| !line.trim().is_empty())?;
    Some(value.to_string())
}

/// 探测失败时的兜底 PATH：在现有系统 PATH 前补 `/opt/homebrew/bin`、`/usr/local/bin`（去重）。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn fallback_path(current_path: Option<&str>) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for &prefix in FALLBACK_PREFIXES {
        if !parts.contains(&prefix) {
            parts.push(prefix);
        }
    }
    if let Some(current) = current_path {
        for entry in current.split(':').filter(|s| !s.is_empty()) {
            if !parts.contains(&entry) {
                parts.push(entry);
            }
        }
    }
    parts.join(":")
}

/// 带超时执行一次探测函数并解析结果；失败（错误、超时、空输出、缺标记）时返回兜底 PATH
/// 与一行说明，便于单测直接覆盖所有失败路径。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn resolve_with_timeout<F>(
    probe: F,
    timeout: Duration,
    current_path: Option<&str>,
) -> (String, Option<String>)
where
    F: FnOnce() -> Result<String, String> + Send + 'static,
{
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let _ = tx.send(probe());
    });
    match rx.recv_timeout(timeout) {
        Ok(Ok(output)) => match parse_marked_path(&output) {
            Some(path) => (path, None),
            None => (
                fallback_path(current_path),
                Some("登录 shell PATH 探测输出缺失有效标记，已改用兜底 PATH".into()),
            ),
        },
        Ok(Err(reason)) => (
            fallback_path(current_path),
            Some(format!("登录 shell PATH 探测失败（{reason}），已改用兜底 PATH")),
        ),
        Err(mpsc::RecvTimeoutError::Timeout) => (
            fallback_path(current_path),
            Some(format!(
                "登录 shell PATH 探测超时（{} 秒），已改用兜底 PATH",
                timeout.as_secs()
            )),
        ),
        Err(mpsc::RecvTimeoutError::Disconnected) => (
            fallback_path(current_path),
            Some("登录 shell PATH 探测线程异常退出，已改用兜底 PATH".into()),
        ),
    }
}

#[cfg(target_os = "macos")]
fn probe_shell_path_output(timeout: Duration) -> Result<String, String> {
    let env_shell = std::env::var("SHELL").ok();
    let etc_shells = std::fs::read_to_string("/etc/shells").unwrap_or_default();
    let shell = crate::terminal::resolve_login_shell_from(env_shell.as_deref(), &etc_shells);
    let name = shell.rsplit('/').next().unwrap_or("");
    let script = format!(
        "printf '\\n{START_MARKER}\\n'; /usr/bin/printenv PATH; printf '\\n{END_MARKER}\\n'"
    );
    let mut cmd = Command::new(&shell);
    match name {
        "sh" => {
            cmd.args(["-i", "-c", &script]);
        }
        _ => {
            cmd.args(["-l", "-i", "-c", &script]);
        }
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| format!("无法启动 {shell}：{e}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法接管登录 shell 标准输出".to_string())?;
    let (out_tx, out_rx) = mpsc::channel();
    thread::spawn(move || {
        let mut buf = Vec::new();
        let mut limited = stdout.take(MAX_PROBE_OUTPUT_BYTES as u64);
        let _ = limited.read_to_end(&mut buf);
        let _ = out_tx.send(buf);
    });
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                let bytes = out_rx
                    .recv_timeout(Duration::from_millis(500))
                    .unwrap_or_default();
                return Ok(String::from_utf8_lossy(&bytes).into_owned());
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("超时（{} 秒）", timeout.as_secs()));
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("等待登录 shell 失败：{e}"));
            }
        }
    }
}

/// 异步探测结果容器：后台线程写入一次，后台进程与终端启动时等待完成或超时。
#[cfg(target_os = "macos")]
pub struct LoginPath {
    state: Mutex<Option<String>>,
    ready: Condvar,
}

#[cfg(target_os = "macos")]
impl LoginPath {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(None),
            ready: Condvar::new(),
        }
    }

    pub fn start_probe(self: &Arc<Self>, log: impl FnOnce(String) + Send + 'static) {
        let this = Arc::clone(self);
        thread::spawn(move || {
            let current = std::env::var("PATH").ok();
            let (resolved, note) = match probe_shell_path_output(PROBE_TIMEOUT) {
                Ok(output) => match parse_marked_path(&output) {
                    Some(path) => (path, None),
                    None => (
                        fallback_path(current.as_deref()),
                        Some("登录 shell PATH 探测输出缺失有效标记，已改用兜底 PATH".into()),
                    ),
                },
                Err(reason) => (
                    fallback_path(current.as_deref()),
                    Some(format!(
                        "登录 shell PATH 探测失败（{reason}），已改用兜底 PATH"
                    )),
                ),
            };
            if let Some(note) = note {
                log(note);
            }
            let mut guard = this.state.lock().unwrap_or_else(|e| e.into_inner());
            *guard = Some(resolved);
            this.ready.notify_all();
        });
    }

    /// 等待登录 shell PATH 就绪（最多等待探测超时 + 1 秒，超时直接返回兜底值）。
    pub fn wait(&self) -> String {
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let deadline = Instant::now() + PROBE_TIMEOUT + Duration::from_secs(1);
        while guard.is_none() {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                break;
            };
            let (next, result) = self
                .ready
                .wait_timeout(guard, remaining)
                .unwrap_or_else(|e| e.into_inner());
            guard = next;
            if result.timed_out() {
                break;
            }
        }
        guard.clone().unwrap_or_else(|| {
            let current = std::env::var("PATH").ok();
            fallback_path(current.as_deref())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_path_between_markers_ignoring_stray_output() {
        let output = format!(
            "Welcome to zsh!\nLast login: Sun\n{START_MARKER}\n/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin\n\n{END_MARKER}\ngoodbye\n"
        );
        assert_eq!(
            parse_marked_path(&output).as_deref(),
            Some("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")
        );
    }

    #[test]
    fn returns_none_on_empty_or_missing_markers() {
        assert_eq!(parse_marked_path(""), None);
        assert_eq!(parse_marked_path("just noise without markers\n"), None);
        assert_eq!(
            parse_marked_path(&format!("{START_MARKER}\n/usr/bin\n")),
            None
        );
        assert_eq!(
            parse_marked_path(&format!("{START_MARKER}\n   \n{END_MARKER}\n")),
            None
        );
    }

    #[test]
    fn fallback_prepends_homebrew_and_local_without_duplicates() {
        assert_eq!(
            fallback_path(Some("/usr/bin:/bin")),
            "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
        );
        assert_eq!(
            fallback_path(Some("/usr/local/bin:/usr/bin")),
            "/opt/homebrew/bin:/usr/local/bin:/usr/bin"
        );
        assert_eq!(fallback_path(None), "/opt/homebrew/bin:/usr/local/bin");
    }

    #[test]
    fn resolve_with_timeout_handles_stray_output_empty_missing_markers_and_timeout() {
        let (path, note) = resolve_with_timeout(
            || Ok(format!("banner\n{START_MARKER}\n/opt/homebrew/bin:/usr/bin\n{END_MARKER}\ntrailing")),
            Duration::from_secs(1),
            Some("/usr/bin"),
        );
        assert_eq!(path, "/opt/homebrew/bin:/usr/bin");
        assert!(note.is_none());

        let (path, note) = resolve_with_timeout(
            || Ok(String::new()),
            Duration::from_secs(1),
            Some("/usr/bin"),
        );
        assert_eq!(path, "/opt/homebrew/bin:/usr/local/bin:/usr/bin");
        assert!(note.is_some());

        let (path, note) = resolve_with_timeout(
            || Ok("no markers here".into()),
            Duration::from_secs(1),
            Some("/usr/bin"),
        );
        assert_eq!(path, "/opt/homebrew/bin:/usr/local/bin:/usr/bin");
        assert!(note.is_some());

        let (path, note) = resolve_with_timeout(
            || {
                thread::sleep(Duration::from_millis(250));
                Ok(format!("{START_MARKER}\n/late\n{END_MARKER}"))
            },
            Duration::from_millis(40),
            Some("/usr/bin"),
        );
        assert_eq!(path, "/opt/homebrew/bin:/usr/local/bin:/usr/bin");
        assert!(note.is_some());
    }
}
