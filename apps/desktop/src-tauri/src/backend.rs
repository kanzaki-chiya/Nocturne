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

use tauri::Manager;

use crate::lines::{LineSplitter, Split, TruncatingLineSplitter};
use crate::node;
use crate::workspace;

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
    Line {
        line: String,
    },
    Closed {
        code: Option<i32>,
        stderr: Vec<String>,
    },
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

    /// 内存 stderr 缓冲的快照：最近 STDERR_BUFFER_LINES 行，每行 ≤ STDERR_MAX_LINE 字节。
    /// 缓冲只存在于内存，不写盘；进程退出后随 Backend 一起回收。
    fn stderr_lines(&self) -> Vec<String> {
        lock(&self.stderr).iter().cloned().collect()
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

/// 页面代际与后台登记共用一把锁：重载不能漏掉已启动但尚未登记的后台。
struct BackendRegistry {
    page_generation: u64,
    backends: HashMap<u32, PageBackend>,
}

struct PageBackend {
    generation: u64,
    backend: Arc<Backend>,
}

/// 应用状态。
pub struct AppState {
    registry: Mutex<BackendRegistry>,
    next_backend_id: AtomicU32,
    node_probe_cache: Mutex<Option<node::NodeProbe>>,
    /// 外壳自身的诊断行（更新检查结果等），与后台 stderr 同款的内存环形缓冲；
    /// 后台日志页以「外壳」条目展示
    shell_log: Mutex<VecDeque<String>>,
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
            registry: Mutex::new(BackendRegistry {
                page_generation: 0,
                backends: HashMap::new(),
            }),
            next_backend_id: AtomicU32::new(1),
            node_probe_cache: Mutex::new(None),
            shell_log: Mutex::new(VecDeque::new()),
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
        lock(&self.registry)
            .backends
            .get(&id)
            .map(|entry| Arc::clone(&entry.backend))
    }

    pub fn remove_backend(&self, id: u32) {
        lock(&self.registry).backends.remove(&id);
    }

    /// backend_stderr 命令的实现主体，与命令包装分开便于单测。
    /// 回收时机：退出监督线程发出 closed 消息后立即 remove_backend，此后
    /// backend_stderr 返回 unknown_backend；已退出后台的尾部日志只能从
    /// closed 消息携带的 stderr 字段读取。页面重载与应用退出路径同样经
    /// 退出监督线程回收，没有第二条路径。
    pub fn backend_stderr(&self, id: u32) -> CmdResult<Vec<String>> {
        self.backend(id)
            .map(|backend| backend.stderr_lines())
            .ok_or_else(|| CommandError::new("unknown_backend", "后台不存在或已退出"))
    }

    /// 外壳日志：前端写入的诊断行（如更新检查结果），与 stderr 缓冲同规则。
    pub fn push_shell_note(&self, line: impl Into<String>) {
        let mut line = line.into();
        if line.len() > STDERR_MAX_LINE {
            // truncate 要求字符边界，先回退到边界内
            let mut end = STDERR_MAX_LINE;
            while !line.is_char_boundary(end) {
                end -= 1;
            }
            line.truncate(end);
        }
        let mut buf = lock(&self.shell_log);
        if buf.len() >= STDERR_BUFFER_LINES {
            buf.pop_front();
        }
        buf.push_back(line);
    }

    pub fn shell_log_lines(&self) -> Vec<String> {
        lock(&self.shell_log).iter().cloned().collect()
    }

    /// 所有后台的快照，包含正在被旧页面清理的后台，供整个应用退出时使用。
    pub fn backends_snapshot(&self) -> Vec<Arc<Backend>> {
        lock(&self.registry)
            .backends
            .values()
            .map(|entry| Arc::clone(&entry.backend))
            .collect()
    }

    fn page_generation(&self) -> u64 {
        lock(&self.registry).page_generation
    }

    /// 在页面开始加载的回调内同步换代；清理线程只使用返回的旧代快照。
    pub fn begin_page_load(&self) -> Vec<Arc<Backend>> {
        let mut registry = lock(&self.registry);
        let previous = registry.page_generation;
        registry.page_generation += 1;
        registry
            .backends
            .values()
            .filter(|entry| entry.generation == previous)
            .map(|entry| Arc::clone(&entry.backend))
            .collect()
    }

    /// 启动与登记保持原子性；探测期间重载的旧请求不会启动任何进程。
    /// 退出监督也用此锁移出后台，避免快速退出先移除、后登记而留下死条目。
    fn open_in_page(
        &self,
        generation: u64,
        spawn: impl FnOnce(u32) -> CmdResult<Arc<Backend>>,
    ) -> CmdResult<u32> {
        let mut registry = lock(&self.registry);
        if self.shutting_down.load(Ordering::SeqCst) || registry.page_generation != generation {
            return Err(CommandError::new(
                "unknown_backend",
                "页面已重新加载或应用正在退出，后台启动已取消",
            ));
        }
        let id = self.next_backend_id.fetch_add(1, Ordering::SeqCst);
        let backend = spawn(id)?;
        registry.backends.insert(
            id,
            PageBackend {
                generation,
                backend,
            },
        );
        Ok(id)
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
        cache
            .clone()
            .unwrap_or_else(|| node::probe_node(&self.resource_dir))
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

/// 普通对话工作区：解析 `<NOCTURNE_HOME>/workspace`，不存在就创建，返回绝对路径。
/// 与 backend_open 分开：前端归类「对话」需要这个路径、目录必须由外壳创建，
/// 而 backend_open 仍只接受已存在的目录，不给前端"创建任意目录"的能力。
#[tauri::command]
pub async fn plain_workspace() -> CmdResult<String> {
    let cwd = std::env::current_dir().map_err(|e| {
        CommandError::new("workspace_unavailable", format!("无法取得当前目录：{e}"))
    })?;
    let env = std::env::var_os("NOCTURNE_HOME");
    let home = std::env::home_dir();
    let nocturne_home = workspace::resolve_nocturne_home(env, home, &cwd).ok_or_else(|| {
        CommandError::new(
            "workspace_unavailable",
            "无法确定用户主目录，也不能解析 NOCTURNE_HOME",
        )
    })?;
    let path = workspace::plain_workspace_path(&nocturne_home);
    workspace::ensure_dir(&path).map_err(|e| {
        CommandError::new(
            "workspace_unavailable",
            format!("无法创建普通对话工作区 {}：{e}", path.display()),
        )
    })?;
    Ok(path.to_string_lossy().into_owned())
}

/// 在同步 invoke 分发阶段捕获页面代际，不能等异步命令开始执行才读取。
/// Tauri 的默认 async 命令包装器会把参数提取也延迟到异步任务中。
pub fn handle_backend_open(invoke: tauri::ipc::Invoke) {
    use tauri::ipc::{CommandArg, CommandItem};

    let state = Arc::clone(
        invoke
            .message
            .webview_ref()
            .state::<Arc<AppState>>()
            .inner(),
    );
    let generation = state.page_generation();
    let workspace = String::from_command(CommandItem {
        plugin: None,
        name: "backend_open",
        key: "workspace",
        message: &invoke.message,
        acl: &invoke.acl,
    });
    let channel = tauri::ipc::Channel::<BackendMessage>::from_command(CommandItem {
        plugin: None,
        name: "backend_open",
        key: "channel",
        message: &invoke.message,
        acl: &invoke.acl,
    });
    let (workspace, channel) = match (workspace, channel) {
        (Ok(workspace), Ok(channel)) => (workspace, channel),
        (Err(error), _) | (_, Err(error)) => {
            invoke.resolver.invoke_error(error);
            return;
        }
    };
    let resolver = invoke.resolver;
    tauri::async_runtime::spawn_blocking(move || {
        resolver.respond(backend_open(&state, generation, workspace, channel).map_err(Into::into));
    });
}

fn backend_open(
    state: &Arc<AppState>,
    generation: u64,
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
    let selected = probe.selected;
    let node_path = selected
        .as_ref()
        .map(|s| s.path.clone())
        .unwrap_or_default();
    // 后台日志里能看出 Node 的来源（随附 / env / PATH）与版本
    let node_desc = selected.map(|s| s.describe());

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

    state.open_in_page(generation, move |id| {
        let state_arc = Arc::clone(state);
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
        .map_err(|e| CommandError::new("spawn_failed", format!("无法启动后台进程：{e}")))?;

        if let Some(desc) = node_desc {
            backend.push_stderr_note(format!("[nocturne-desktop] Node {desc}"));
        }

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
        Ok(backend)
    })
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
pub async fn backend_close(
    state: tauri::State<'_, Arc<AppState>>,
    backend_id: u32,
) -> CmdResult<()> {
    let Some(backend) = state.backend(backend_id) else {
        return Ok(()); // 重复关闭或对已退出的后台调用：Ok
    };
    close_backend(&backend, CLOSE_TIMEOUT);
    Ok(())
}

/// 返回后台内存里的 stderr 缓冲（最近 500 行、每行 ≤ 64 KiB）。
/// 只读运行中或尚未回收的后台；已退出后台经 closed 消息携带 stderr。
#[tauri::command]
pub async fn backend_stderr(
    state: tauri::State<'_, Arc<AppState>>,
    backend_id: u32,
) -> CmdResult<Vec<String>> {
    state.backend_stderr(backend_id)
}

/// 前端诊断行写入外壳日志（更新检查失败等静默降级场景）。
/// 入参不受信：按 stderr 同样的单行上限截断。
#[tauri::command]
pub async fn app_note(state: tauri::State<'_, Arc<AppState>>, line: String) -> CmdResult<()> {
    state.push_shell_note(line);
    Ok(())
}

/// 外壳日志快照（后台日志页「外壳」条目）。
#[tauri::command]
pub async fn shell_log(state: tauri::State<'_, Arc<AppState>>) -> CmdResult<Vec<String>> {
    Ok(state.shell_log_lines())
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
        (
            move |m| {
                let _ = tx.send(m);
            },
            rx,
        )
    }

    fn spawn_sort(state: &Arc<AppState>, id: u32) -> CmdResult<Arc<Backend>> {
        let mut command = Command::new("sort");
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let state = Arc::clone(state);
        spawn_backend(id, command, |_| {}, move |id| state.remove_backend(id))
            .map_err(|error| CommandError::new("spawn_failed", error.to_string()))
    }

    #[test]
    fn reload_closes_all_old_backends_without_closing_new_page() {
        let state = Arc::new(AppState::new(std::path::PathBuf::new()));
        let generation = state.page_generation();
        for _ in 0..2 {
            state
                .open_in_page(generation, |id| spawn_sort(&state, id))
                .unwrap();
        }
        let previous = state.begin_page_load();
        assert_eq!(previous.len(), 2);
        let id = state
            .open_in_page(state.page_generation(), |id| spawn_sort(&state, id))
            .unwrap();
        let current = state.backend(id).unwrap();

        // 模拟清理线程晚于新页面启动；它只能拿旧页面的快照。
        for backend in previous {
            close_backend(&backend, Duration::from_secs(5));
            assert!(lock(&backend.child).try_wait().unwrap().is_some());
        }
        assert!(lock(&current.child).try_wait().unwrap().is_none());
        close_backend(&current, Duration::from_secs(5));
    }

    #[test]
    fn open_dispatched_before_reload_never_spawns() {
        let state = AppState::new(std::path::PathBuf::new());
        let generation = state.page_generation();
        assert!(state.begin_page_load().is_empty());
        let error = state
            .open_in_page(generation, |_| panic!("旧页面的后台不得启动"))
            .unwrap_err();
        assert_eq!(error.code, "unknown_backend");
        assert!(state.backends_snapshot().is_empty());
    }

    #[test]
    fn shutdown_rejects_new_backend_opens() {
        let state = AppState::new(std::path::PathBuf::new());
        state.shutting_down.store(true, Ordering::SeqCst);
        let error = state
            .open_in_page(state.page_generation(), |_| panic!("退出期间不得启动后台"))
            .unwrap_err();
        assert_eq!(error.code, "unknown_backend");
    }

    #[test]
    fn reload_waits_for_in_flight_spawn_to_be_registered() {
        let state = Arc::new(AppState::new(std::path::PathBuf::new()));
        let generation = state.page_generation();
        let (spawning_tx, spawning_rx) = mpsc::channel();
        let (continue_tx, continue_rx) = mpsc::channel();
        let opening_state = Arc::clone(&state);
        let opening = thread::spawn(move || {
            opening_state.open_in_page(generation, |id| {
                spawning_tx.send(()).unwrap();
                continue_rx.recv_timeout(Duration::from_secs(10)).unwrap();
                spawn_sort(&opening_state, id)
            })
        });
        spawning_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        let (reloading_tx, reloading_rx) = mpsc::channel();
        let reloading_state = Arc::clone(&state);
        let reloading = thread::spawn(move || {
            reloading_tx.send(()).unwrap();
            reloading_state.begin_page_load()
        });
        reloading_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        continue_tx.send(()).unwrap();
        opening.join().unwrap().unwrap();
        let previous = reloading.join().unwrap();
        assert_eq!(previous.len(), 1);

        let id = state
            .open_in_page(state.page_generation(), |id| spawn_sort(&state, id))
            .unwrap();
        let current = state.backend(id).unwrap();
        close_backend(&previous[0], Duration::from_secs(5));
        assert!(lock(&previous[0].child).try_wait().unwrap().is_some());
        assert!(lock(&current.child).try_wait().unwrap().is_none());
        close_backend(&current, Duration::from_secs(5));
    }

    #[test]
    fn shutdown_snapshot_includes_in_flight_spawn_and_reloading_backends() {
        let state = Arc::new(AppState::new(std::path::PathBuf::new()));
        state
            .open_in_page(state.page_generation(), |id| spawn_sort(&state, id))
            .unwrap();
        let previous = state.begin_page_load();
        let generation = state.page_generation();
        let (spawning_tx, spawning_rx) = mpsc::channel();
        let (continue_tx, continue_rx) = mpsc::channel();
        let opening_state = Arc::clone(&state);
        let opening = thread::spawn(move || {
            opening_state.open_in_page(generation, |id| {
                spawning_tx.send(()).unwrap();
                continue_rx.recv_timeout(Duration::from_secs(10)).unwrap();
                spawn_sort(&opening_state, id)
            })
        });
        spawning_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        state.shutting_down.store(true, Ordering::SeqCst);
        let closing_state = Arc::clone(&state);
        let closing = thread::spawn(move || closing_state.backends_snapshot());
        continue_tx.send(()).unwrap();
        opening.join().unwrap().unwrap();
        let all = closing.join().unwrap();
        assert_eq!(all.len(), 2);
        assert!(all.iter().any(|backend| Arc::ptr_eq(backend, &previous[0])));
        for backend in all {
            close_backend(&backend, Duration::from_secs(5));
            assert!(lock(&backend.child).try_wait().unwrap().is_some());
        }
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

    /// 经 open_in_page 登记一个执行任意命令的后台（on_exit 从表里移除）。
    fn open_with(state: &Arc<AppState>, command: Command) -> CmdResult<u32> {
        let generation = state.page_generation();
        let owner = Arc::clone(state);
        state.open_in_page(generation, |id| {
            let owner = Arc::clone(&owner);
            spawn_backend(id, command, |_| {}, move |id| owner.remove_backend(id))
                .map_err(|error| CommandError::new("spawn_failed", error.to_string()))
        })
    }

    #[test]
    fn backend_stderr_reads_buffer_and_rejects_unknown_ids() {
        let state = Arc::new(AppState::new(std::path::PathBuf::new()));
        let error = state.backend_stderr(424_242).unwrap_err();
        assert_eq!(error.code, "unknown_backend");

        // 子进程先往 stderr 写两行再停住（不立即退出，保证回收前可读）
        #[cfg(windows)]
        let mut command = {
            let mut c = Command::new("cmd");
            c.args([
                "/c",
                "echo first-err>&2& echo second-err>&2& timeout /t 30 /nobreak >nul",
            ]);
            c
        };
        #[cfg(unix)]
        let mut command = {
            let mut c = Command::new("sh");
            c.args(["-c", "echo first-err >&2; echo second-err >&2; sleep 30"]);
            c
        };
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        let id = open_with(&state, command).unwrap();

        // stderr 读线程异步写缓冲：轮询直到两行都进来
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        let lines = loop {
            let lines = state.backend_stderr(id).unwrap();
            if lines.len() >= 2 {
                break lines;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "stderr 未及时进入缓冲"
            );
            thread::sleep(Duration::from_millis(20));
        };
        assert!(lines.iter().any(|line| line.contains("first-err")));
        assert!(lines.iter().any(|line| line.contains("second-err")));
        close_backend(&state.backend(id).unwrap(), Duration::from_secs(5));
    }

    #[test]
    fn backend_stderr_buffer_is_bounded() {
        let state = Arc::new(AppState::new(std::path::PathBuf::new()));
        let id = state
            .open_in_page(state.page_generation(), |id| spawn_sort(&state, id))
            .unwrap();
        let backend = state.backend(id).unwrap();
        for i in 0..STDERR_BUFFER_LINES + 10 {
            backend.push_stderr_note(format!("line-{i}"));
        }
        let lines = state.backend_stderr(id).unwrap();
        assert_eq!(lines.len(), STDERR_BUFFER_LINES);
        assert_eq!(lines.first().unwrap(), "line-10");
        assert_eq!(
            lines.last().unwrap(),
            &format!("line-{}", STDERR_BUFFER_LINES + 9)
        );
        close_backend(&backend, Duration::from_secs(5));
    }

    #[test]
    fn backend_stderr_is_reclaimed_after_exit() {
        // closed 发出后退出监督线程立即移出登记表，此后读取报 unknown_backend；
        // 已退出后台的尾部 stderr 只能经 closed 消息携带的副本获取。
        let state = Arc::new(AppState::new(std::path::PathBuf::new()));
        #[cfg(windows)]
        let mut command = {
            let mut c = Command::new("cmd");
            c.args(["/c", "echo bye>&2& exit /b 5"]);
            c
        };
        #[cfg(unix)]
        let mut command = {
            let mut c = Command::new("sh");
            c.args(["-c", "echo bye >&2; exit 5"]);
            c
        };
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let id = open_with(&state, command).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        loop {
            match state.backend_stderr(id) {
                Err(error) => {
                    assert_eq!(error.code, "unknown_backend");
                    break;
                }
                Ok(_) => {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "后台退出后 stderr 缓冲未回收"
                    );
                    thread::sleep(Duration::from_millis(20));
                }
            }
        }
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

    #[test]
    fn shell_log_truncates_at_char_boundary_and_is_bounded() {
        let state = AppState::new(std::path::PathBuf::new());
        // 超长行按 STDERR_MAX_LINE 截断；多字节字符不能让 truncate panic
        state.push_shell_note("中".repeat(STDERR_MAX_LINE));
        let lines = state.shell_log_lines();
        assert_eq!(lines.len(), 1);
        assert!(lines[0].len() <= STDERR_MAX_LINE);
        assert!(lines[0].chars().all(|c| c == '中'));

        for i in 0..STDERR_BUFFER_LINES + 10 {
            state.push_shell_note(format!("note-{i}"));
        }
        let lines = state.shell_log_lines();
        assert_eq!(lines.len(), STDERR_BUFFER_LINES);
        assert_eq!(lines.first().unwrap(), "note-10");
        assert_eq!(
            lines.last().unwrap(),
            &format!("note-{}", STDERR_BUFFER_LINES + 9)
        );
    }
}
