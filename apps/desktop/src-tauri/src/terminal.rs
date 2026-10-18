//! 面板终端（ADR-0060 第 4 节）：外壳用 portable-pty（Windows 上是 ConPTY）起用户自己的
//! shell，输出经每个终端自己的 Channel 推给前端。agent 看不到也操作不了它，不经过权限层。
//!
//! 安全：`terminal_open` 不能变成「从前端启动任意程序」的口子——可执行文件必须存在、
//! 是绝对路径，且文件名在固定清单里（pwsh / Windows PowerShell / Git Bash / cmd）；
//! 参数由外壳按种类决定，前端传不了参数；工作目录必须是存在的目录。

use crate::backend::CommandError;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

type CmdResult<T> = Result<T, CommandError>;

/// 外壳认得的 shell 种类；由可执行文件名决定，不由前端声明。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellKind {
    Pwsh,
    PowerShell,
    Bash,
    Cmd,
}

impl ShellKind {
    /// 文件名（不分大小写）→ 种类；清单外的一律不认。
    fn from_file_name(name: &str) -> Option<Self> {
        match name.to_ascii_lowercase().as_str() {
            "pwsh.exe" => Some(Self::Pwsh),
            "powershell.exe" => Some(Self::PowerShell),
            "bash.exe" => Some(Self::Bash),
            "cmd.exe" => Some(Self::Cmd),
            _ => None,
        }
    }

    /// 交互终端的启动参数：PowerShell 照常加载用户配置文件；Git Bash 用登录交互模式
    /// （与 Git 自带的 git-bash 一致，读 ~/.bash_profile）；cmd 不带参数。
    pub fn args(self) -> &'static [&'static str] {
        match self {
            Self::Pwsh | Self::PowerShell => &["-NoLogo"],
            Self::Bash => &["--login", "-i"],
            Self::Cmd => &[],
        }
    }
}

/// 校验前端传来的 shell 路径：绝对路径、文件存在、文件名在清单里。
/// System32 下的 bash.exe 是 WSL 入口（Core 的 Git Bash 探测同样避开它），不认。
pub fn validate_shell(path: &str) -> CmdResult<(PathBuf, ShellKind)> {
    let invalid = |message: &str| CommandError::new("invalid_shell", message);
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err(invalid("Shell 路径必须是绝对路径"));
    }
    let kind = path
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(ShellKind::from_file_name)
        .ok_or_else(|| invalid("只能启动 pwsh、Windows PowerShell、Git Bash 或 cmd"))?;
    if kind == ShellKind::Bash && is_system32_bash(&path) {
        return Err(invalid("System32 下的 bash.exe 是 WSL 入口，不支持"));
    }
    if !path.is_file() {
        return Err(invalid("Shell 可执行文件不存在"));
    }
    Ok((path, kind))
}

fn is_system32_bash(path: &Path) -> bool {
    path.parent()
        .and_then(|dir| dir.file_name())
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("system32"))
}

/// 工作目录必须是存在的目录（绝对路径）。
pub fn validate_cwd(cwd: &str) -> CmdResult<PathBuf> {
    let path = PathBuf::from(cwd);
    if !path.is_absolute() || !path.is_dir() {
        return Err(CommandError::new(
            "invalid_workspace",
            "终端的工作目录不存在或不是文件夹",
        ));
    }
    Ok(path)
}

/// 前端给的行列数夹在合理范围内，避免 0 或离谱的值传给 ConPTY。
fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.clamp(2, 1000),
        cols: cols.clamp(2, 1000),
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// 发给前端的 Channel 消息。所有 output 都在 exit 之前发出，exit 每个终端只发一次。
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TerminalMessage {
    Output { data: String },
    Exit { code: Option<u32> },
}

/// 增量 UTF-8 解码：一次读出的字节可能截在多字节字符中间，尾部不完整的留到下一次。
#[derive(Default)]
pub struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    pub fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut out = String::new();
        let mut rest: &[u8] = &self.pending;
        loop {
            match std::str::from_utf8(rest) {
                Ok(text) => {
                    out.push_str(text);
                    rest = &[];
                    break;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    // valid_up_to 之前已经校验过是合法 UTF-8
                    out.push_str(std::str::from_utf8(&rest[..valid]).unwrap_or_default());
                    match error.error_len() {
                        Some(bad) => {
                            out.push('\u{FFFD}');
                            rest = &rest[valid + bad..];
                        }
                        // 结尾不完整：留到下一块
                        None => {
                            rest = &rest[valid..];
                            break;
                        }
                    }
                }
            }
        }
        self.pending = rest.to_vec();
        out
    }
}

/// 一个运行中的终端。master 在进程退出后由等待线程放掉（关闭伪控制台，读线程才会读到 EOF）。
pub struct Terminal {
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    /// 等待线程结束时发信号；terminal_close 用它确认进程已经收尾
    done: Mutex<Option<mpsc::Receiver<()>>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Terminal {
    fn kill(&self) {
        let _ = lock(&self.killer).kill();
    }
}

#[derive(Default)]
pub struct TerminalState {
    next_id: AtomicU32,
    terminals: Mutex<HashMap<u32, Arc<Terminal>>>,
}

impl TerminalState {
    fn get(&self, id: u32) -> CmdResult<Arc<Terminal>> {
        lock(&self.terminals)
            .get(&id)
            .cloned()
            .ok_or_else(|| CommandError::new("unknown_terminal", "终端已经结束"))
    }

    /// 结束全部终端并等它们收尾（页面重载、应用退出时）；每个最多等 3 秒。
    pub fn close_all(&self) {
        let all: Vec<Arc<Terminal>> = lock(&self.terminals).drain().map(|(_, t)| t).collect();
        for terminal in &all {
            terminal.kill();
        }
        for terminal in &all {
            wait_done(terminal, Duration::from_secs(3));
        }
    }
}

fn wait_done(terminal: &Terminal, timeout: Duration) {
    let receiver = lock(&terminal.done).take();
    if let Some(receiver) = receiver {
        let _ = receiver.recv_timeout(timeout);
    }
}

fn open_terminal(
    state: &TerminalState,
    #[cfg(windows)] app: &crate::backend::AppState,
    shell: &str,
    cwd: &str,
    cols: u16,
    rows: u16,
    channel: tauri::ipc::Channel<TerminalMessage>,
) -> CmdResult<u32> {
    let (program, kind) = validate_shell(shell)?;
    let cwd = validate_cwd(cwd)?;
    let pair = native_pty_system()
        .openpty(pty_size(cols, rows))
        .map_err(spawn_error)?;
    let mut command = CommandBuilder::new(&program);
    command.args(kind.args());
    command.cwd(&cwd);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    let mut child = pair.slave.spawn_command(command).map_err(spawn_error)?;
    // slave 也持有伪控制台：不放掉的话进程退出后读线程永远等不到 EOF
    drop(pair.slave);
    let reader = pair.master.try_clone_reader().map_err(spawn_error);
    let writer = pair.master.take_writer().map_err(spawn_error);
    let (mut reader, writer) = match (reader, writer) {
        (Ok(r), Ok(w)) => (r, w),
        (Err(e), _) | (_, Err(e)) => {
            let _ = child.kill();
            return Err(e);
        }
    };
    // Windows：放进 Job Object，外壳被强杀时 shell 与它启动的程序一起结束
    #[cfg(windows)]
    if let Some(pid) = child.process_id() {
        app.assign_job(pid);
    }

    let id = state.next_id.fetch_add(1, Ordering::SeqCst) + 1;
    let (done_tx, done_rx) = mpsc::channel();
    let terminal = Arc::new(Terminal {
        master: Mutex::new(Some(pair.master)),
        writer: Mutex::new(Some(writer)),
        killer: Mutex::new(child.clone_killer()),
        done: Mutex::new(Some(done_rx)),
    });
    lock(&state.terminals).insert(id, Arc::clone(&terminal));

    // 读线程：输出按块解码后推给前端，EOF（伪控制台关闭）时结束
    let (drained_tx, drained_rx) = mpsc::channel::<()>();
    let output = channel.clone();
    thread::spawn(move || {
        let mut decoder = Utf8Stream::default();
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = decoder.push(&buf[..n]);
                    if !data.is_empty() && output.send(TerminalMessage::Output { data }).is_err() {
                        break;
                    }
                }
            }
        }
        let _ = drained_tx.send(());
    });

    // 等待线程：进程退出 → 关伪控制台 → 等读线程排空 → 发 exit → 从注册表移除
    thread::spawn(move || {
        let code = child.wait().ok().map(|status| status.exit_code());
        lock(&terminal.writer).take();
        lock(&terminal.master).take();
        let _ = drained_rx.recv_timeout(Duration::from_secs(2));
        let _ = channel.send(TerminalMessage::Exit { code });
        let _ = done_tx.send(());
    });
    Ok(id)
}

/// portable-pty 的错误类型是 anyhow::Error；只取它的文字，不另引 anyhow。
fn spawn_error(error: impl std::fmt::Display) -> CommandError {
    CommandError::new("spawn_failed", format!("无法启动终端：{error}"))
}

#[tauri::command]
pub async fn terminal_open(
    terminals: tauri::State<'_, Arc<TerminalState>>,
    #[cfg_attr(not(windows), allow(unused_variables))] app: tauri::State<
        '_,
        Arc<crate::backend::AppState>,
    >,
    shell: String,
    cwd: String,
    cols: u16,
    rows: u16,
    channel: tauri::ipc::Channel<TerminalMessage>,
) -> CmdResult<u32> {
    let terminals = Arc::clone(terminals.inner());
    #[cfg(windows)]
    let app = Arc::clone(app.inner());
    tauri::async_runtime::spawn_blocking(move || {
        open_terminal(
            &terminals,
            #[cfg(windows)]
            &app,
            &shell,
            &cwd,
            cols,
            rows,
            channel,
        )
    })
    .await
    .map_err(|e| CommandError::new("spawn_failed", e.to_string()))?
}

#[tauri::command]
pub async fn terminal_write(
    terminals: tauri::State<'_, Arc<TerminalState>>,
    id: u32,
    data: String,
) -> CmdResult<()> {
    let terminal = terminals.get(id)?;
    let mut writer = lock(&terminal.writer);
    let Some(writer) = writer.as_mut() else {
        return Ok(());
    };
    writer
        .write_all(data.as_bytes())
        .and_then(|_| writer.flush())
        .map_err(|e| CommandError::new("io", format!("写入终端失败：{e}")))
}

#[tauri::command]
pub async fn terminal_resize(
    terminals: tauri::State<'_, Arc<TerminalState>>,
    id: u32,
    cols: u16,
    rows: u16,
) -> CmdResult<()> {
    let terminal = terminals.get(id)?;
    if let Some(master) = lock(&terminal.master).as_ref() {
        master
            .resize(pty_size(cols, rows))
            .map_err(|e| CommandError::new("io", format!("调整终端尺寸失败：{e}")))?;
    }
    Ok(())
}

/// 结束终端进程并等它收尾；对已经结束的终端调用返回成功。
#[tauri::command]
pub async fn terminal_close(
    terminals: tauri::State<'_, Arc<TerminalState>>,
    id: u32,
) -> CmdResult<()> {
    let Some(terminal) = lock(&terminals.terminals).remove(&id) else {
        return Ok(());
    };
    tauri::async_runtime::spawn_blocking(move || {
        terminal.kill();
        wait_done(&terminal, Duration::from_secs(3));
    })
    .await
    .map_err(|e| CommandError::new("io", e.to_string()))
}

/// 右键菜单「粘贴」读剪贴板文本。网页里的 `navigator.clipboard.readText` 会让 WebView2
/// 弹「想要查看剪贴板」的权限框，所以由外壳直接读；只读 CF_UNICODETEXT。
/// Ctrl+Shift+V 走浏览器原生粘贴事件，不经过这里。
#[tauri::command]
pub async fn terminal_read_clipboard() -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(read_clipboard_text)
        .await
        .map_err(|e| CommandError::new("io", e.to_string()))?
}

#[cfg(windows)]
fn read_clipboard_text() -> CmdResult<String> {
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    };
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
    use windows_sys::Win32::System::Ole::CF_UNICODETEXT;

    let format = u32::from(CF_UNICODETEXT);
    // SAFETY: 标准的剪贴板读取流程。打开后无论结果都 CloseClipboard；
    // GlobalLock 拿到的指针只在 GlobalUnlock 之前使用，长度不超过 GlobalSize。
    unsafe {
        if IsClipboardFormatAvailable(format) == 0 {
            return Ok(String::new());
        }
        // 别的程序正占着剪贴板时 OpenClipboard 会失败，稍等重试几次
        let mut opened = false;
        for _ in 0..10 {
            if OpenClipboard(std::ptr::null_mut()) != 0 {
                opened = true;
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        if !opened {
            return Err(CommandError::new("io", "剪贴板正被别的程序占用"));
        }
        let mut text = String::new();
        let handle = GetClipboardData(format);
        if !handle.is_null() {
            let data = GlobalLock(handle) as *const u16;
            if !data.is_null() {
                let max = GlobalSize(handle) / 2;
                let units = std::slice::from_raw_parts(data, max);
                let len = units.iter().position(|&u| u == 0).unwrap_or(max);
                text = String::from_utf16_lossy(&units[..len]);
                GlobalUnlock(handle);
            }
        }
        CloseClipboard();
        Ok(text)
    }
}

#[cfg(not(windows))]
fn read_clipboard_text() -> CmdResult<String> {
    Err(CommandError::new("unsupported", "这个平台还不支持读剪贴板"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("nocturne-terminal-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn touch(dir: &Path, name: &str) -> String {
        let path = dir.join(name);
        fs::write(&path, b"").unwrap();
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn accepts_only_listed_shell_names() {
        let dir = temp_dir("names");
        for (name, kind) in [
            ("pwsh.exe", ShellKind::Pwsh),
            ("PowerShell.EXE", ShellKind::PowerShell),
            ("bash.exe", ShellKind::Bash),
            ("cmd.exe", ShellKind::Cmd),
        ] {
            let path = touch(&dir, name);
            assert_eq!(validate_shell(&path).unwrap().1, kind, "{name}");
        }
        for name in [
            "node.exe",
            "python.exe",
            "bash.exe.lnk",
            "wt.exe",
            "cmd.bat",
            "pwsh",
        ] {
            let path = touch(&dir, name);
            let error = validate_shell(&path).unwrap_err();
            assert_eq!(error.code, "invalid_shell", "{name}");
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rejects_missing_relative_and_directory_paths() {
        let dir = temp_dir("missing");
        let missing = dir.join("pwsh.exe").to_string_lossy().into_owned();
        assert_eq!(validate_shell(&missing).unwrap_err().code, "invalid_shell");
        assert_eq!(
            validate_shell("pwsh.exe").unwrap_err().code,
            "invalid_shell"
        );
        let folder = dir.join("cmd.exe");
        fs::create_dir_all(&folder).unwrap();
        assert_eq!(
            validate_shell(&folder.to_string_lossy()).unwrap_err().code,
            "invalid_shell"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rejects_wsl_bash_in_system32() {
        let dir = temp_dir("wsl").join("System32");
        fs::create_dir_all(&dir).unwrap();
        let path = touch(&dir, "bash.exe");
        assert_eq!(validate_shell(&path).unwrap_err().code, "invalid_shell");
        fs::remove_dir_all(dir.parent().unwrap()).unwrap();
    }

    #[test]
    fn arguments_are_decided_by_kind() {
        assert_eq!(ShellKind::Pwsh.args(), ["-NoLogo"]);
        assert_eq!(ShellKind::PowerShell.args(), ["-NoLogo"]);
        assert_eq!(ShellKind::Bash.args(), ["--login", "-i"]);
        assert!(ShellKind::Cmd.args().is_empty());
    }

    #[test]
    fn working_directory_must_exist() {
        let dir = temp_dir("cwd");
        assert!(validate_cwd(&dir.to_string_lossy()).is_ok());
        let file = touch(&dir, "file.txt");
        assert_eq!(validate_cwd(&file).unwrap_err().code, "invalid_workspace");
        let missing = dir.join("nope").to_string_lossy().into_owned();
        assert_eq!(
            validate_cwd(&missing).unwrap_err().code,
            "invalid_workspace"
        );
        assert_eq!(
            validate_cwd("relative").unwrap_err().code,
            "invalid_workspace"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn utf8_stream_keeps_split_characters() {
        let mut stream = Utf8Stream::default();
        let bytes = "中文".as_bytes();
        assert_eq!(stream.push(&bytes[..2]), "");
        assert_eq!(stream.push(&bytes[2..4]), "中");
        assert_eq!(stream.push(&bytes[4..]), "文");
        assert_eq!(stream.push(&[b'a', 0xff, b'b']), "a\u{FFFD}b");
    }

    #[test]
    fn size_is_clamped() {
        let size = pty_size(0, 5000);
        assert_eq!((size.cols, size.rows), (2, 1000));
    }

    #[cfg(windows)]
    #[test]
    fn spawns_cmd_and_reports_exit_code() {
        let comspec =
            std::env::var("ComSpec").unwrap_or_else(|_| r"C:\Windows\System32\cmd.exe".into());
        let (program, kind) = validate_shell(&comspec).unwrap();
        let pair = native_pty_system().openpty(pty_size(80, 24)).unwrap();
        let mut command = CommandBuilder::new(&program);
        command.args(kind.args());
        command.cwd(std::env::temp_dir());
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let writer = Arc::new(Mutex::new(pair.master.take_writer().unwrap()));
        // ConPTY（PSEUDOCONSOLE_INHERIT_CURSOR）启动时先发 ESC[6n 查光标位置，等到回答
        // 才让 shell 跑起来；前端由 xterm.js 自动回答，这里手动回答
        let answer = Arc::clone(&writer);
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut answered = false;
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                if !answered && buf[..n].windows(4).any(|w| w == b"\x1b[6n") {
                    answered = true;
                    let mut w = lock(&answer);
                    let _ = w.write_all(b"\x1b[1;1R");
                    let _ = w.write_all(b"exit 7\r\n");
                    let _ = w.flush();
                }
            }
        });
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let _ = tx.send(child.wait().map(|status| status.exit_code()));
        });
        let code = rx
            .recv_timeout(Duration::from_secs(20))
            .expect("cmd 没有在 20 秒内退出");
        assert_eq!(code.unwrap(), 7);
        drop(pair.master);
    }
}
