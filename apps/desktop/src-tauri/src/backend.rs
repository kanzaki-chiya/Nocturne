//! 后台进程管理：`nctrn rpc --stdio` 子进程的启动、按行转发、关闭与退出监督
//! （ADR-0046 第 1、3 节）。外壳只按行转发，不解析报文，也不记录 stdin/stdout 的内容。

use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use crate::lines::{LineSplitter, Split, TruncatingLineSplitter};
use crate::node;

/// stdout 单行上限 64 MiB；超过就强杀后台（宁可显式失败也不悄悄丢报文）。
const STDOUT_MAX_LINE: usize = 64 * 1024 * 1024;
/// stderr 单行上限 64 KiB，超长截断。
const STDERR_MAX_LINE: usize = 64 * 1024;
/// stderr 内存缓冲行数上限。
const STDERR_BUFFER_LINES: usize = 500;
/// backend_close 等待自行退出的超时。
const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);
/// 退出监督轮询间隔。
const POLL_INTERVAL: Duration = Duration::from_millis(50);
/// 进程退出后等待 stdout 读线程收尾的上限（防止孙进程继承 stdout 卡住）。
const STDOUT_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

/// 发给前端的 Channel 消息。
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BackendMessage {
    Line { line: String },
    Closed { code: Option<i32>, stderr: Vec<String> },
}

/// 命令错误：可序列化，message 为中文用户可读文案。
#[derive(Debug, Serialize)]
pub struct CommandError {
    pub code: String,
    pub message: String,
}

impl CommandError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

type CmdResult<T> = Result<T, CommandError>;

/// 一个运行中的后台。
pub struct Backend {
    child: Mutex<Child>,
    stdin: Mutex<Option<ChildStdin>>,
    stderr: Arc<Mutex<VecDeque<String>>>,
    /// 被强杀（超时或超长行）时置位，closed 的 code 随之报 null
    killed: AtomicBool,
}

impl Backend {
    fn push_stderr_note(&self, line: impl Into<String>) {
        let mut buf = lock(&self.stderr);
        if buf.len() >= STDERR_BUFFER_LINES {
            buf.pop_front();
        }
        buf.push_back(line.into());
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// spawn 一个已配置好的命令并接好读写与监督线程。
/// `sink` 接收每条 BackendMessage（实现保证 line 全部在 closed 之前发出）；
/// `on_exit` 在发出 closed 之后调用一次（生产里用于把后台从表里移除）。
pub fn spawn_backend(
    id: u32,
    mut command: Command,
    sink: impl FnMut(BackendMessage) + Send + 'static,
    on_exit: impl FnOnce(u32) + Send + 'static,
) -> std::io::Result<Arc<Backend>> {
    let mut child = command.spawn()?;
    let stdin = child.stdin.take();
    let mut stdout = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();

    let backend = Arc::new(Backend {
        child: Mutex::new(child),
        stdin: Mutex::new(stdin),
        stderr: Arc::new(Mutex::new(VecDeque::new())),
        killed: AtomicBool::new(false),
    });

    let sink = Arc::new(Mutex::new(sink));

    // stdout 读线程：切行 → line 消息；超长行记 stderr 并强杀。
    let (stdout_done_tx, stdout_done_rx) = mpsc::channel::<()>();
    {
        let backend = Arc::clone(&backend);
        let sink = Arc::clone(&sink);
        thread::spawn(move || {
            let send = |m: BackendMessage| (lock(&sink))(m);
            let mut splitter = LineSplitter::new(STDOUT_MAX_LINE);
            let mut chunk = [0u8; 64 * 1024];
            let mut overlong = false;
            if let Some(pipe) = stdout.as_mut() {
                loop {
                    match pipe.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(n) => {
                            for split in splitter.push(&chunk[..n]) {
                                match split {
                                    Split::Line(line) => send(BackendMessage::Line { line }),
                                    Split::Overlong { .. } => {
                                        backend.push_stderr_note(
                                            "[nocturne-desktop] stdout 单行超过 64 MiB，已终止后台",
                                        );
                                        backend.killed.store(true, Ordering::SeqCst);
                                        let _ = lock(&backend.child).kill();
                                        overlong = true;
                                        break;
                                    }
                                }
                            }
                            if overlong {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
            }
            if !overlong {
                if let Some(Split::Line(line)) = splitter.finish() {
                    send(BackendMessage::Line { line });
                }
            }
            let _ = stdout_done_tx.send(());
        });
    }

    // stderr 读线程：截断切行 → 内存环形缓冲；不写盘、不打印、不 log。
    {
        let backend = Arc::clone(&backend);
        thread::spawn(move || {
            let mut splitter = TruncatingLineSplitter::new(STDERR_MAX_LINE);
            let mut chunk = [0u8; 64 * 1024];
            if let Some(pipe) = stderr_pipe.as_mut() {
                loop {
                    match pipe.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(n) => {
                            for line in splitter.push(&chunk[..n]) {
                                backend.push_stderr_note(line);
                            }
                        }
                        Err(_) => break,
                    }
                }
            }
            if let Some(line) = splitter.finish() {
                backend.push_stderr_note(line);
            }
        });
    }

    // 退出监督线程：等退出 → 等 stdout 排空 → 发 closed → 移出表。
    {
        let backend = Arc::clone(&backend);
        let sink = Arc::clone(&sink);
        thread::spawn(move || {
            let status = loop {
                {
                    let mut child = lock(&backend.child);
                    match child.try_wait() {
                        Ok(Some(status)) => break Some(status),
                        Ok(None) => {}
                        Err(_) => break None,
                    }
                }
                thread::sleep(POLL_INTERVAL);
            };
            let _ = stdout_done_rx.recv_timeout(STDOUT_DRAIN_TIMEOUT);
            let stderr: Vec<String> = lock(&backend.stderr).iter().cloned().collect();
            let code = if backend.killed.load(Ordering::SeqCst) {
                None
            } else {
                status.and_then(|s| s.code())
            };
            (lock(&sink))(BackendMessage::Closed { code, stderr });
            on_exit(id);
        });
    }

    Ok(backend)
}

/// 关闭结果。
pub enum CloseOutcome {
    Exited,
    Killed,
}

/// 关闭 stdin 后等子进程自行退出；超时强杀，直到进程确实结束才返回。
pub fn close_with_timeout(child: &mut Child, timeout: Duration) -> std::io::Result<CloseOutcome> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if child.try_wait()?.is_some() {
            return Ok(CloseOutcome::Exited);
        }
        if std::time::Instant::now() >= deadline {
            child.kill()?;
            let _ = child.wait();
            return Ok(CloseOutcome::Killed);
        }
        thread::sleep(Duration::from_millis(20));
    }
}

/// 对一个后台执行完整关闭：drop stdin（EOF）→ 等待或强杀。
/// 已退出或正在退出的后台同样返回。
pub fn close_backend(backend: &Arc<Backend>, timeout: Duration) {
    lock(&backend.stdin).take();
    let mut child = lock(&backend.child);
    if let Ok(CloseOutcome::Killed) = close_with_timeout(&mut child, timeout) {
        backend.killed.store(true, Ordering::SeqCst);
    }
}

/// 应用状态。
pub struct AppState {
    backends: Mutex<HashMap<u32, Arc<Backend>>>,
    next_backend_id: AtomicU32,
    node_probe_cache: Mutex<Option<node::NodeProbe>>,
    resource_dir: std::path::PathBuf,
    #[cfg(windows)]
    job: Mutex<Option<crate::job::JobObject>>,
    /// Job Object 创建失败的原因；打开后台时写入该后台的 stderr 缓冲
    #[cfg(windows)]
    job_error: Mutex<Option<String>>,
    /// 退出流程进行中：拦截到的第二次关闭请求直接放行判断用
    pub shutting_down: AtomicBool,
}

impl AppState {
    pub fn new(resource_dir: std::path::PathBuf) -> Self {
        Self {
            backends: Mutex::new(HashMap::new()),
            next_backend_id: AtomicU32::new(1),
            node_probe_cache: Mutex::new(None),
            resource_dir,
            #[cfg(windows)]
            job: Mutex::new(None),
            #[cfg(windows)]
            job_error: Mutex::new(None),
            shutting_down: AtomicBool::new(false),
        }
    }

    #[cfg(windows)]
    pub fn init_job(&self) {
        match crate::job::JobObject::create_kill_on_close() {
            Ok(job) => *lock(&self.job) = Some(job),
            Err(e) => {
                *lock(&self.job_error) = Some(format!("创建 Job Object 失败：{e}"));
            }
        }
    }

    pub fn backend(&self, id: u32) -> Option<Arc<Backend>> {
        lock(&self.backends).get(&id).cloned()
    }

    pub fn remove_backend(&self, id: u32) {
        lock(&self.backends).remove(&id);
    }

    /// 所有后台的快照（用于窗口关闭时并行关闭）。
    pub fn backends_snapshot(&self) -> Vec<Arc<Backend>> {
        lock(&self.backends).values().cloned().collect()
    }

    pub fn resource_dir(&self) -> &Path {
        &self.resource_dir
    }

    /// 取缓存的探测结果；没有缓存就探测一次并缓存。
    fn node_probe(&self) -> node::NodeProbe {
        let mut cache = lock(&self.node_probe_cache);
        if cache.is_none() {
            *cache = Some(node::probe_node(&self.resource_dir));
        }
        cache.clone().unwrap_or_else(|| node::probe_node(&self.resource_dir))
    }

    fn set_node_probe(&self, probe: node::NodeProbe) {
        *lock(&self.node_probe_cache) = Some(probe);
    }
}

#[tauri::command]
pub async fn node_probe(state: tauri::State<'_, Arc<AppState>>) -> CmdResult<node::NodeProbe> {
    // 「重新检测」依赖每次重新探测并刷新缓存
    let probe = node::probe_node(state.resource_dir());
    state.set_node_probe(probe.clone());
    Ok(probe)
}

#[tauri::command]
pub async fn backend_open(
    state: tauri::State<'_, Arc<AppState>>,
    workspace: String,
    channel: tauri::ipc::Channel<BackendMessage>,
) -> CmdResult<u32> {
    let workspace_path = Path::new(&workspace);
    if !workspace_path.is_dir() {
        return Err(CommandError::new(
            "invalid_workspace",
            format!("工作区目录不存在：{workspace}"),
        ));
    }

    let probe = state.node_probe();
    if !probe.ok {
        return Err(CommandError::new(
            "node_unavailable",
            "没有找到满足要求的 Node.js（需要 v24.14.0 或更高版本）",
        ));
    }
    let node_path = probe
        .selected
        .map(|s| s.path)
        .unwrap_or_default();

    let script = node::backend_script(state.resource_dir());
    if !script.is_file() {
        return Err(CommandError::new(
            "backend_script_missing",
            format!(
                "找不到后台脚本 {}；开发模式下请先运行 pnpm build",
                script.display()
            ),
        ));
    }

    let mut command = node::program_command(
        Path::new(&node_path),
        &[
            script.as_os_str(),
            std::ffi::OsStr::new("rpc"),
            std::ffi::OsStr::new("--stdio"),
        ],
    );
    command
        .current_dir(workspace_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let id = state.next_backend_id.fetch_add(1, Ordering::SeqCst);
    let state_arc = Arc::clone(state.inner());
    let backend = spawn_backend(
        id,
        command,
        move |message| {
            let _ = channel.send(message);
        },
        move |id| {
            state_arc.remove_backend(id);
        },
    )
    .map_err(|e| {
        CommandError::new(
            "spawn_failed",
            format!("无法启动后台进程：{e}"),
        )
    })?;

    // Windows：放进 Job Object，外壳被强杀时后台一起结束。失败不致命，记 stderr。
    #[cfg(windows)]
    {
        let job = lock(&state.job);
        match job.as_ref() {
            Some(job) => {
                if let Err(e) = job.assign_process(backend_pid(&backend)) {
                    backend.push_stderr_note(format!(
                        "[nocturne-desktop] 无法把后台加入 Job Object：{e}"
                    ));
                }
            }
            None => {
                let reason = lock(&state.job_error)
                    .clone()
                    .unwrap_or_else(|| "Job Object 不可用".into());
                backend.push_stderr_note(format!(
                    "[nocturne-desktop] {reason}，外壳被强杀时此后台可能残留"
                ));
            }
        }
    }

    lock(&state.backends).insert(id, backend);
    Ok(id)
}

#[cfg(windows)]
fn backend_pid(backend: &Arc<Backend>) -> u32 {
    lock(&backend.child).id()
}

#[tauri::command]
pub async fn backend_send(
    state: tauri::State<'_, Arc<AppState>>,
    backend_id: u32,
    line: String,
) -> CmdResult<()> {
    let backend = state
        .backend(backend_id)
        .ok_or_else(|| CommandError::new("unknown_backend", "后台不存在或已退出"))?;
    let mut guard = lock(&backend.stdin);
    let stdin = guard
        .as_mut()
        .ok_or_else(|| CommandError::new("unknown_backend", "后台已关闭输入"))?;
    let write = (|| -> std::io::Result<()> {
        stdin.write_all(line.as_bytes())?;
        stdin.write_all(b"\n")?;
        stdin.flush()
    })();
    write.map_err(|e| CommandError::new("io", format!("写入后台 stdin 失败：{e}")))
}

#[tauri::command]
pub async fn backend_close(state: tauri::State<'_, Arc<AppState>>, backend_id: u32) -> CmdResult<()> {
    let Some(backend) = state.backend(backend_id) else {
        return Ok(()); // 重复关闭或对已退出的后台调用：Ok
    };
    close_backend(&backend, CLOSE_TIMEOUT);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::RecvTimeoutError;

    fn collect_sink() -> (
        impl FnMut(BackendMessage) + Send + 'static,
        mpsc::Receiver<BackendMessage>,
    ) {
        let (tx, rx) = mpsc::channel::<BackendMessage>();
        (move |m| { let _ = tx.send(m); }, rx)
    }

    #[test]
    fn close_exits_before_timeout_when_process_quits() {
        // 读到 stdin EOF 就退出的子进程（Windows/Unix 都有 sort）
        let mut child = Command::new("sort")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn sort");
        drop(child.stdin.take());
        let start = std::time::Instant::now();
        let outcome = close_with_timeout(&mut child, Duration::from_secs(10)).unwrap();
        assert!(matches!(outcome, CloseOutcome::Exited));
        assert!(start.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn close_kills_after_timeout() {
        #[cfg(windows)]
        let mut command = {
            let mut c = Command::new("powershell");
            c.args(["-NoProfile", "-Command", "Start-Sleep", "30"]);
            c
        };
        #[cfg(unix)]
        let mut command = {
            let mut c = Command::new("sleep");
            c.arg("30");
            c
        };
        let mut child = command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn sleeper");
        let start = std::time::Instant::now();
        let outcome = close_with_timeout(&mut child, Duration::from_millis(300)).unwrap();
        assert!(matches!(outcome, CloseOutcome::Killed));
        assert!(start.elapsed() < Duration::from_secs(10));
        assert!(child.try_wait().unwrap().is_some());
    }

    #[test]
    fn forwards_lines_then_closed_once() {
        #[cfg(windows)]
        let mut command = {
            let mut c = Command::new("cmd");
            c.args(["/c", "echo one& echo two^&three& exit /b 3"]);
            c
        };
        #[cfg(unix)]
        let mut command = {
            let mut c = Command::new("sh");
            c.args(["-c", "printf 'one\\ntwo&three\\r\\n'; exit 3"]);
            c
        };
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let (sink, rx) = collect_sink();
        let _backend = spawn_backend(7, command, sink, |_| {}).unwrap();

        let mut kinds: Vec<String> = Vec::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        loop {
            match rx.recv_timeout(Duration::from_secs(15)) {
                Ok(BackendMessage::Line { line }) => {
                    kinds.push(format!("line:{line}"));
                }
                Ok(BackendMessage::Closed { code, .. }) => {
                    kinds.push(format!("closed:{:?}", code));
                    break;
                }
                Err(RecvTimeoutError::Timeout) => panic!("timed out waiting for closed"),
                Err(e) => panic!("channel error: {e}"),
            }
            assert!(std::time::Instant::now() < deadline);
        }
        // 所有 line 都在 closed 之前，closed 只出现一次且退出码为 3
        let closed_pos = kinds.iter().position(|k| k.starts_with("closed:")).unwrap();
        assert_eq!(closed_pos, kinds.len() - 1);
        assert!(kinds[..closed_pos].iter().all(|k| k.starts_with("line:")));
        assert_eq!(kinds.last().unwrap(), "closed:Some(3)");
        assert!(kinds.iter().any(|k| k == "line:two&three"));
    }

    #[test]
    fn close_backend_is_idempotent() {
        let mut command = Command::new("sort");
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let (sink, _rx) = collect_sink();
        let backend = spawn_backend(9, command, sink, |_| {}).unwrap();
        close_backend(&backend, Duration::from_secs(5));
        close_backend(&backend, Duration::from_secs(5));
    }
}
