//! agent 操作面板浏览器（desktop-browser.md）：回环 HTTP MCP、会话绑定、标签租约与
//! 呈现状态。
//!
//! 分工：
//! - 本模块：状态、绑定、标签、UI 控制命令、服务器生命周期与启动凭证；
//! - `http`：回环 HTTP 解析、鉴权、路由与 MCP JSON-RPC；
//! - `tools`：第一版工具 schema 与执行；
//! - `ax`：可访问性树的有界摘要；
//! - `shell`：Windows 上的 WebView2 创建、CDP 与事件（测试用假实现）。
//!
//! 安全边界：服务器只绑定 `127.0.0.1:0`；每个根会话一个随机 bearer；bearer 只在内存里，
//! 不进 URL、日志、配置或模型。网页的 Origin 一律拒绝，Host 必须精确匹配回环端口。

pub mod ax;
pub mod http;
pub mod shell;
pub mod tools;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::State;

/// 全部 live webview（用户标签 + agent 标签）的硬上限，与前端 BrowserPool 的
/// `MAX_LIVE_BROWSERS` 同一口径。agent 标签 pinned，不参与回收。
pub const MAX_LIVE_BROWSERS: usize = 5;

/// 呈现确认的超时：前端在这一代没有确认布局就取消并回收预留。
pub const PRESENT_TIMEOUT: Duration = Duration::from_secs(2);

/// 离屏位置：保持 shown，但移出可见区域。探针实测 hide 后截图 8 秒不返回，而离屏截图、
/// 可访问性树与输入都正常（desktop-browser.md 第 2 节）。
pub const OFFSCREEN_X: f64 = -20000.0;
/// 离屏时保留的视口尺寸：不能按 1×1 执行。
pub const OFFSCREEN_SIZE: (f64, f64) = (900.0, 700.0);

pub type TabState = u8;
pub const STATE_AGENT: TabState = 0;
pub const STATE_BUSY: TabState = 1;
pub const STATE_TAKEN_OVER: TabState = 2;
pub const STATE_ENDED: TabState = 3;

pub fn state_name(state: TabState) -> &'static str {
    match state {
        STATE_BUSY => "busy",
        STATE_TAKEN_OVER => "taken_over",
        STATE_ENDED => "ended",
        _ => "agent",
    }
}

/// 逻辑像素矩形（与面板占位区同一坐标系）。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn offscreen() -> Self {
        Self {
            x: OFFSCREEN_X,
            y: 0.0,
            width: OFFSCREEN_SIZE.0,
            height: OFFSCREEN_SIZE.1,
        }
    }
}

/// 外壳提供的能力。生产实现走 WebView2；测试用假实现，HTTP 与工具层不需要窗口。
pub trait AgentPlatform: Send + Sync {
    fn create(&self, tab: &Arc<AgentTab>) -> Result<(), String>;
    fn destroy(&self, tab: &Arc<AgentTab>);
    fn set_bounds(&self, tab: &Arc<AgentTab>, bounds: Rect) -> Result<(), String>;
    fn navigate(&self, tab: &Arc<AgentTab>, url: &str) -> Result<(), String>;
    fn history(&self, tab: &Arc<AgentTab>, forward: bool) -> Result<(), String>;
    fn cdp(&self, tab: &Arc<AgentTab>, method: &str, params: Value) -> Result<Value, String>;
    /// 把原生键盘焦点交回主界面（交回控制前必须先做）。
    fn focus_main(&self) -> Result<(), String>;
    fn child_focused(&self, tab: &Arc<AgentTab>) -> bool;
    /// 当前用户浏览器标签的 live 数；容量判定把 agent 标签另算。
    fn live_webviews(&self) -> usize;
    /// 开发服务器的同源地址（正式包为 None）：agent 也不许访问自己的应用。
    fn dev_url(&self) -> Option<tauri::Url>;
    /// 答复挂起的脚本对话框：`accept` = 确定（prompt 带 `text`），否则取消。
    fn resolve_dialog(
        &self,
        tab: &Arc<AgentTab>,
        accept: bool,
        text: Option<String>,
    ) -> Result<(), String>;
}

/// 接管后 agent 的动作被拒绝；取消后不再派发动作。纯判定供调用方在派发前检查。
pub fn check_agent_control(taken_over: bool, cancelled: bool) -> Result<(), &'static str> {
    if taken_over {
        return Err("taken_over");
    }
    if cancelled {
        return Err("cancelled");
    }
    Ok(())
}

/// 一次操作（一个 MCP tools/call 请求）。
pub struct Op {
    pub request_key: String,
    /// `sessionId/turnId/callId`：同一调用在途时的重复检测
    pub caller_key: String,
    /// 取消标记：Turn 中断、接管、禁用、绑定撤销都会置位。派发前与等待循环里都要检查。
    pub cancelled: AtomicBool,
    /// 这个操作当前占用的标签，用于接管时批量取消。
    pub tab_id: Mutex<Option<String>>,
}

impl Op {
    pub fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }
}

pub struct Binding {
    pub id: String,
    pub root: String,
    pub bearer: String,
    /// 这个根会话下出现过的 actor（根自身与子会话）。MCP session id 只是传输标识。
    pub sessions: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBrowserTab {
    pub tab_id: String,
    pub root_session_id: String,
    pub actor_session_id: String,
    pub title: String,
    pub url: String,
    pub live: bool,
    pub pinned: bool,
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation: Option<String>,
    /// 子代理的标签：父会话面板里显示子代理徽标
    pub child: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notice: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dialog: Option<DialogView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DialogView {
    pub kind: String,
    pub uri: String,
    pub message: String,
    /// prompt 的默认输入；其他类型为空
    pub default_text: String,
}

/// 网页的脚本对话框：外壳挂起它（不自动接受或取消），等用户在面板横幅里处理。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DialogInfo {
    pub kind: String,
    pub uri: String,
    pub message: String,
    pub default_text: String,
}

pub struct AgentTab {
    pub id: String,
    pub root: String,
    pub actor: String,
    pub binding_id: String,
    pub label: String,
    pub url: Mutex<String>,
    pub title: Mutex<String>,
    pub loading: AtomicBool,
    pub live: AtomicBool,
    pub state: AtomicU8,
    pub operation: Mutex<Option<String>>,
    /// refs 的代数：导航、接管、交回都递增，旧 refs 自然失效。
    pub generation: AtomicU64,
    /// 当前 read 的快照；同一时刻只保留最近一次。
    pub snapshot: Mutex<Option<ax::AxSnapshot>>,
    pub dialog: Mutex<Option<DialogInfo>>,
    /// 工具栏提示（下载被取消、新窗口被拒绝、初始化失败）
    pub notice: Mutex<Option<String>>,
    pub download_blocked: AtomicBool,
    pub back: AtomicBool,
    pub forward: AtomicBool,
    /// 子 webview 是否持有原生焦点（GotFocus / LostFocus）
    pub focused: AtomicBool,
    /// 刚创建或刚交回时忽略 GotFocus，避免自己的焦点搬动被当成用户接管。
    pub ignore_focus_until: Mutex<Instant>,
    /// 最近一次提交给前端的布局；`None` = 还没布局过。
    pub bounds: Mutex<Option<Rect>>,
    pub busy: Mutex<()>,
    pub created: Instant,
}

impl AgentTab {
    pub fn tab_state(&self) -> TabState {
        self.state.load(Ordering::SeqCst)
    }
    pub fn bound_to(&self, root: &str, actor: &str) -> bool {
        self.root == root && self.actor == actor
    }
    pub fn bump_generation(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }
    pub fn title_text(&self) -> String {
        lock(&self.title).clone()
    }
    pub fn url_text(&self) -> String {
        lock(&self.url).clone()
    }
    pub fn should_ignore_focus(&self) -> bool {
        Instant::now() < *lock(&self.ignore_focus_until)
    }
}

/// `rename_all` 只改变体名（kind 的值）；变体里的字段要靠 `rename_all_fields` 才是 camelCase，
/// 否则主界面读到的 `shellGeneration`、`tabId` 都是 undefined。
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum WatchMessage {
    Tabs {
        shell_generation: u64,
        revision: u64,
        tabs: Vec<AgentBrowserTab>,
    },
    Present {
        shell_generation: u64,
        revision: u64,
        operation_id: String,
        tab_id: String,
    },
    Operation {
        shell_generation: u64,
        revision: u64,
        tab_id: String,
        operation_id: String,
        state: &'static str,
        operation: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        error_code: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchSnapshot {
    pub shell_generation: u64,
    pub revision: u64,
    pub enabled: bool,
    pub tabs: Vec<AgentBrowserTab>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutRef {
    pub tab_id: String,
    pub version: u64,
    pub bounds: Rect,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiState {
    pub shell_generation: u64,
    pub revision: u64,
    pub route: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub panel_open: bool,
    #[serde(default)]
    pub active_tab_id: Option<String>,
    #[serde(default)]
    pub covered: bool,
    #[serde(default)]
    pub layout: Option<LayoutRef>,
    /// 便于测试与排查：最近一次被接受的状态时间不参与判定
    #[serde(skip)]
    pub applied: Option<Instant>,
}

impl Default for UiState {
    fn default() -> Self {
        Self {
            shell_generation: 0,
            revision: 0,
            route: "home".into(),
            session_id: None,
            panel_open: false,
            active_tab_id: None,
            covered: false,
            layout: None,
            applied: None,
        }
    }
}

struct Server {
    port: u16,
    secret: String,
    stop: Arc<AtomicBool>,
}

pub struct AgentBrowserState {
    platform: Arc<dyn AgentPlatform>,
    /// 开关落盘位置（应用数据目录里的标记文件）：外壳启动时先读它再开服务器，
    /// 不依赖前端调用顺序；文件不存在/读不到视为关闭
    enabled_path: Option<PathBuf>,
    enabled: AtomicBool,
    server: Mutex<Option<Server>>,
    /// 前端 UI 状态代际（主界面每次整页加载会递增）
    shell_generation: AtomicU64,
    revision: AtomicU64,
    ui_revision: AtomicU64,
    /// 最近接受的布局版本：旧 version 的布局不覆盖新布局
    layout_version: AtomicU64,
    bindings: Mutex<HashMap<String, Binding>>,
    /// 每个绑定下的在途请求：requestKey → Op
    ops: Mutex<HashMap<String, HashMap<String, Arc<Op>>>>,
    tabs: Mutex<HashMap<String, Arc<AgentTab>>>,
    watch: Mutex<Option<Channel<WatchMessage>>>,
    ui: Mutex<UiState>,
    pending_present: Mutex<HashMap<String, std::sync::mpsc::Sender<()>>>,
    /// 已经关闭的标签（tabId → actor）：同一 actor 的 close 幂等，别人猜 id 不成功。
    closed: Mutex<HashMap<String, String>>,
    /// MCP 传输 session id → 绑定 id（不是授权依据）
    mcp_sessions: Mutex<HashMap<String, String>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// 256 bit 随机数。Windows 走 BCryptGenRandom；其他平台读 `/dev/urandom`。
/// 取不到随机数时失败关闭（返回 None），不退回时间戳之类的可猜值。
pub fn random_bytes(len: usize) -> Option<Vec<u8>> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Security::Cryptography::{
            BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        };
        let mut out = vec![0u8; len];
        // SAFETY: out 是有效可写缓冲；系统首选 RNG 不需要算法句柄
        let status = unsafe {
            BCryptGenRandom(
                std::ptr::null_mut(),
                out.as_mut_ptr(),
                u32::try_from(len).ok()?,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            )
        };
        if status == 0 {
            return Some(out);
        }
        None
    }
    #[cfg(not(windows))]
    {
        use std::io::Read;
        let mut out = vec![0u8; len];
        let mut file = std::fs::File::open("/dev/urandom").ok()?;
        file.read_exact(&mut out).ok()?;
        Some(out)
    }
}

fn random_hex(len: usize) -> Option<String> {
    random_bytes(len).map(|bytes| hex(&bytes))
}

impl AgentBrowserState {
    /// `enabled_path` 是开关的落盘标记：存在即启用。外壳启动时读它，和前端调用顺序无关。
    pub fn new(platform: Arc<dyn AgentPlatform>, enabled_path: Option<PathBuf>) -> Arc<Self> {
        let state = Arc::new(Self {
            platform,
            enabled_path,
            enabled: AtomicBool::new(false),
            server: Mutex::new(None),
            shell_generation: AtomicU64::new(1),
            revision: AtomicU64::new(0),
            ui_revision: AtomicU64::new(0),
            layout_version: AtomicU64::new(0),
            bindings: Mutex::new(HashMap::new()),
            ops: Mutex::new(HashMap::new()),
            tabs: Mutex::new(HashMap::new()),
            watch: Mutex::new(None),
            ui: Mutex::new(UiState::default()),
            pending_present: Mutex::new(HashMap::new()),
            closed: Mutex::new(HashMap::new()),
            mcp_sessions: Mutex::new(HashMap::new()),
        });
        let stored = state
            .enabled_path
            .as_ref()
            .is_some_and(|path| path.exists());
        if stored {
            // 取不到随机数或端口就先不开：状态保持关闭，设置页会显示未启用
            let _ = state.start_server();
        }
        state
    }

    /// 开关落盘：启用写标记，关闭删标记。写失败不影响本次运行的开关。
    fn persist_enabled(&self, enabled: bool) {
        let Some(path) = &self.enabled_path else {
            return;
        };
        if enabled {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(path, b"1");
        } else {
            let _ = std::fs::remove_file(path);
        }
    }

    pub fn platform(&self) -> &Arc<dyn AgentPlatform> {
        &self.platform
    }

    /// 回环服务器的端口（未启用/未启动时为 None）；agent 导航策略用它拒绝对
    /// `/bindings` 与 `/mcp/*` 的访问。
    pub fn server_port(&self) -> Option<u16> {
        lock(&self.server).as_ref().map(|server| server.port)
    }

    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    pub fn shell_generation(&self) -> u64 {
        self.shell_generation.load(Ordering::SeqCst)
    }

    pub fn next_revision(&self) -> u64 {
        self.revision.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// 启动回环服务器。已启用/已有服务器时返回现有端口。
    pub fn start_server(self: &Arc<Self>) -> Result<u16, String> {
        if let Some(server) = lock(&self.server).as_ref() {
            return Ok(server.port);
        }
        let secret = random_hex(32).ok_or_else(|| "无法取得启动凭证的随机数".to_string())?;
        let stop = Arc::new(AtomicBool::new(false));
        let port = http::serve(Arc::clone(self), secret.clone(), Arc::clone(&stop))?;
        *lock(&self.server) = Some(Server { port, secret, stop });
        self.enabled.store(true, Ordering::SeqCst);
        Ok(port)
    }

    /// 停用：撤销全部绑定与在途操作、关闭 agent 标签、停止监听。
    pub fn stop_server(&self) {
        if let Some(server) = lock(&self.server).take() {
            server.stop.store(true, Ordering::SeqCst);
            // 唤醒 accept：连一下就退出
            let _ = std::net::TcpStream::connect(("127.0.0.1", server.port));
        }
        self.enabled.store(false, Ordering::SeqCst);
        self.revoke_all();
    }

    pub fn revoke_all(&self) {
        let bindings: Vec<String> = lock(&self.bindings).keys().cloned().collect();
        for id in bindings {
            self.revoke_binding(&id);
        }
    }

    /// 启动凭证：只在 spawn 后台时经进程环境传一次（desktop-browser.md 第 1 节）。
    pub fn bootstrap_env(&self) -> Option<(String, String)> {
        let server = lock(&self.server);
        let server = server.as_ref()?;
        if !self.enabled() {
            return None;
        }
        let payload = serde_json::json!({
            "version": 1,
            "port": server.port,
            "secret": server.secret,
        });
        Some((
            "NOCTURNE_DESKTOP_BROWSER_BOOTSTRAP".to_string(),
            payload.to_string(),
        ))
    }

    // ── 绑定 ──

    pub fn open_binding(&self, root: &str) -> Result<(String, String), &'static str> {
        if !self.enabled() {
            return Err("disabled");
        }
        let id = random_hex(16).ok_or("random")?;
        let bearer = random_hex(32).ok_or("random")?;
        // 同代同根重复申请撤销旧绑定，禁止两个活绑定争用
        let stale: Vec<String> = lock(&self.bindings)
            .values()
            .filter(|b| b.root == root)
            .map(|b| b.id.clone())
            .collect();
        for id in stale {
            self.revoke_binding(&id);
        }
        let mut bindings = lock(&self.bindings);
        bindings.insert(
            id.clone(),
            Binding {
                id: id.clone(),
                root: root.to_string(),
                bearer: bearer.clone(),
                sessions: vec![root.to_string()],
            },
        );
        drop(bindings);
        self.notify_tabs();
        Ok((id, bearer))
    }

    pub fn revoke_binding(&self, id: &str) {
        let removed = lock(&self.bindings).remove(id);
        if removed.is_none() {
            return;
        }
        if let Some(ops) = lock(&self.ops).remove(id) {
            for op in ops.values() {
                op.cancel();
            }
        }
        let tabs: Vec<Arc<AgentTab>> = {
            let mut tabs = lock(&self.tabs);
            let ids: Vec<String> = tabs
                .values()
                .filter(|tab| tab.binding_id == id)
                .map(|tab| tab.id.clone())
                .collect();
            ids.iter().filter_map(|id| tabs.remove(id)).collect()
        };
        for tab in tabs {
            tab.state.store(STATE_ENDED, Ordering::SeqCst);
            tab.live.store(false, Ordering::SeqCst);
            self.platform.destroy(&tab);
        }
        self.notify_tabs();
    }

    pub fn binding_root(&self, id: &str) -> Option<String> {
        lock(&self.bindings).get(id).map(|b| b.root.clone())
    }

    pub fn bearer_valid(&self, id: &str, bearer: &str) -> bool {
        lock(&self.bindings).get(id).is_some_and(|b| {
            crate::agent_browser::constant_time_eq(b.bearer.as_bytes(), bearer.as_bytes())
        })
    }

    /// 记录这个绑定下出现过的 actor。外壳信任后台给出的 actor（同一凭证已授权到该根面板），
    /// 不据此扩大跨根权限。
    pub fn touch_actor(&self, id: &str, session: &str) -> bool {
        let mut bindings = lock(&self.bindings);
        let Some(binding) = bindings.get_mut(id) else {
            return false;
        };
        if !binding.sessions.iter().any(|s| s == session) {
            binding.sessions.push(session.to_string());
        }
        true
    }

    // ── 操作 ──

    pub fn begin_call(
        self: &Arc<Self>,
        binding_id: &str,
        request_key: &str,
        caller_key: &str,
    ) -> Result<Arc<Op>, &'static str> {
        if !self.enabled() {
            return Err("disabled");
        }
        let mut all = lock(&self.ops);
        let ops = all.entry(binding_id.to_string()).or_default();
        // 同一 (sessionId, turnId, callId) 的在途重复请求拒绝，不自动重放
        if ops.values().any(|op| op.caller_key == caller_key) {
            return Err("duplicate_call");
        }
        let op = Arc::new(Op {
            request_key: request_key.to_string(),
            caller_key: caller_key.to_string(),
            cancelled: AtomicBool::new(false),
            tab_id: Mutex::new(None),
        });
        ops.insert(request_key.to_string(), Arc::clone(&op));
        Ok(op)
    }

    pub fn end_call(&self, binding_id: &str, request_key: &str) {
        let mut all = lock(&self.ops);
        if let Some(ops) = all.get_mut(binding_id) {
            ops.remove(request_key);
            if ops.is_empty() {
                all.remove(binding_id);
            }
        }
    }

    /// `notifications/cancelled`：取消这个请求；已派发的 CDP 调用不能撤销，忽略迟到回调。
    pub fn cancel_request(&self, binding_id: &str, request_key: &str) {
        if let Some(op) = lock(&self.ops)
            .get(binding_id)
            .and_then(|ops| ops.get(request_key))
        {
            op.cancel();
        }
    }

    /// 接管、隐藏、关标签、禁用、后台代际变化共用的取消路径。
    pub fn cancel_tab_ops(&self, tab_id: &str) {
        for ops in lock(&self.ops).values() {
            for op in ops.values() {
                if op
                    .tab_id
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .as_deref()
                    == Some(tab_id)
                {
                    op.cancel();
                }
            }
        }
    }

    // ── 标签 ──

    pub fn tab(&self, id: &str) -> Option<Arc<AgentTab>> {
        lock(&self.tabs).get(id).cloned()
    }

    pub fn tabs_of(&self, root: &str, actor: Option<&str>) -> Vec<Arc<AgentTab>> {
        let mut out: Vec<Arc<AgentTab>> = lock(&self.tabs)
            .values()
            .filter(|tab| tab.root == root && tab.live.load(Ordering::SeqCst))
            .filter(|tab| actor.is_none_or(|actor| tab.actor == actor))
            .cloned()
            .collect();
        out.sort_by(|a, b| a.created.cmp(&b.created));
        out
    }

    pub fn live_count(&self) -> usize {
        self.tabs_of_all().len() + self.platform.live_webviews()
    }

    fn tabs_of_all(&self) -> Vec<Arc<AgentTab>> {
        lock(&self.tabs)
            .values()
            .filter(|tab| tab.live.load(Ordering::SeqCst))
            .cloned()
            .collect()
    }

    pub fn capacity_available(&self) -> bool {
        self.live_count() < MAX_LIVE_BROWSERS
    }

    /// 预留并创建标签。`present` 由调用方在前台会话时决定是否发。
    pub fn create_tab(
        self: &Arc<Self>,
        binding_id: &str,
        root: &str,
        actor: &str,
        url: &str,
    ) -> Result<Arc<AgentTab>, &'static str> {
        if !self.capacity_available() {
            return Err("browser_capacity");
        }
        let id = random_hex(12).ok_or("random")?;
        let browser_id = self.next_browser_id();
        let tab = Arc::new(AgentTab {
            id: format!("t_{id}"),
            root: root.to_string(),
            actor: actor.to_string(),
            binding_id: binding_id.to_string(),
            label: format!("nct-agent-{browser_id}"),
            url: Mutex::new(url.to_string()),
            title: Mutex::new(String::new()),
            loading: AtomicBool::new(true),
            live: AtomicBool::new(true),
            state: AtomicU8::new(STATE_AGENT),
            operation: Mutex::new(None),
            generation: AtomicU64::new(1),
            snapshot: Mutex::new(None),
            dialog: Mutex::new(None),
            notice: Mutex::new(None),
            download_blocked: AtomicBool::new(false),
            back: AtomicBool::new(false),
            forward: AtomicBool::new(false),
            focused: AtomicBool::new(false),
            ignore_focus_until: Mutex::new(Instant::now() + Duration::from_millis(800)),
            bounds: Mutex::new(None),
            busy: Mutex::new(()),
            created: Instant::now(),
        });
        lock(&self.tabs).insert(tab.id.clone(), Arc::clone(&tab));
        if let Err(error) = self.platform.create(&tab) {
            tab.live.store(false, Ordering::SeqCst);
            tab.state.store(STATE_ENDED, Ordering::SeqCst);
            lock(&self.tabs).remove(&tab.id);
            return Err(if error == "browser_capacity" {
                "browser_capacity"
            } else {
                "browser_failed"
            });
        }
        *lock(&tab.bounds) = Some(Rect::offscreen());
        self.notify_tabs();
        Ok(tab)
    }

    fn next_browser_id(&self) -> u32 {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        // 进程内递减分配，避免与用户浏览器 id 冲突（标签不同也无妨）
        u32::try_from(NEXT.fetch_add(1, Ordering::SeqCst)).unwrap_or(1)
    }

    pub fn close_tab(self: &Arc<Self>, tab: &Arc<AgentTab>) {
        self.cancel_tab_ops(&tab.id);
        tab.state.store(STATE_ENDED, Ordering::SeqCst);
        tab.live.store(false, Ordering::SeqCst);
        lock(&self.tabs).remove(&tab.id);
        lock(&self.closed).insert(tab.id.clone(), tab.actor.clone());
        self.platform.destroy(tab);
        self.notify_tabs();
    }

    pub fn closed_by(&self, tab_id: &str, actor: &str) -> bool {
        lock(&self.closed)
            .get(tab_id)
            .is_some_and(|owner| owner == actor)
    }

    // ── MCP 传输 session ──

    pub fn new_mcp_session(&self, binding_id: &str) -> String {
        let id = random_hex(16).unwrap_or_else(|| format!("s{}", self.next_revision()));
        lock(&self.mcp_sessions).insert(id.clone(), binding_id.to_string());
        id
    }

    pub fn mcp_session_valid(&self, binding_id: &str, session: &str) -> bool {
        if session.is_empty() {
            return false;
        }
        lock(&self.mcp_sessions)
            .get(session)
            .is_some_and(|id| id == binding_id)
    }

    pub fn drop_mcp_session(&self, binding_id: &str, session: &str) {
        let mut sessions = lock(&self.mcp_sessions);
        if sessions.get(session).is_some_and(|id| id == binding_id) {
            sessions.remove(session);
        }
    }

    #[cfg(test)]
    pub fn mcp_sessions_for_test(&self, binding_id: &str) -> Vec<String> {
        lock(&self.mcp_sessions)
            .iter()
            .filter(|(_, id)| id.as_str() == binding_id)
            .map(|(session, _)| session.clone())
            .collect()
    }

    pub fn destroy_all(&self) {
        let tabs: Vec<Arc<AgentTab>> = {
            let mut map = lock(&self.tabs);
            let ids: Vec<String> = map.keys().cloned().collect();
            ids.iter().filter_map(|id| map.remove(id)).collect()
        };
        for tab in tabs {
            self.cancel_tab_ops(&tab.id);
            tab.state.store(STATE_ENDED, Ordering::SeqCst);
            tab.live.store(false, Ordering::SeqCst);
            self.platform.destroy(&tab);
        }
    }

    // ── 呈现与布局 ──

    pub fn snapshot(&self) -> WatchSnapshot {
        WatchSnapshot {
            shell_generation: self.shell_generation(),
            revision: self.revision.load(Ordering::SeqCst),
            enabled: self.enabled(),
            tabs: self.serialize_tabs(),
        }
    }

    pub fn serialize_tabs(&self) -> Vec<AgentBrowserTab> {
        self.tabs_of_all()
            .into_iter()
            .map(|tab| AgentBrowserTab {
                tab_id: tab.id.clone(),
                root_session_id: tab.root.clone(),
                actor_session_id: tab.actor.clone(),
                title: tab.title_text(),
                url: tab.url_text(),
                live: tab.live.load(Ordering::SeqCst),
                pinned: true,
                state: state_name(tab.tab_state()),
                operation: lock(&tab.operation).clone(),
                child: tab.actor != tab.root,
                notice: lock(&tab.notice).clone(),
                dialog: lock(&tab.dialog).as_ref().map(|dialog| DialogView {
                    kind: dialog.kind.clone(),
                    uri: dialog.uri.clone(),
                    message: dialog.message.clone(),
                    default_text: dialog.default_text.clone(),
                }),
            })
            .collect()
    }

    pub fn session_foreground(&self, root: &str) -> bool {
        let ui = lock(&self.ui);
        ui.route == "session"
            && ui.panel_open
            && ui.session_id.as_deref() == Some(root)
            && !ui.covered
    }

    pub fn set_watch(&self, channel: Channel<WatchMessage>) {
        *lock(&self.watch) = Some(channel);
        // 新的 watch 替换旧 watch：不重发旧快照，前端按返回值继续
    }

    pub fn notify_tabs(&self) {
        let revision = self.next_revision();
        let snapshot = self.snapshot();
        let tabs = snapshot.tabs;
        self.send(WatchMessage::Tabs {
            shell_generation: self.shell_generation(),
            revision,
            tabs,
        });
    }

    pub fn notify_operation(
        &self,
        tab_id: &str,
        operation_id: &str,
        state: &'static str,
        operation: &str,
        error_code: Option<&str>,
    ) {
        let revision = self.next_revision();
        self.send(WatchMessage::Operation {
            shell_generation: self.shell_generation(),
            revision,
            tab_id: tab_id.to_string(),
            operation_id: operation_id.to_string(),
            state,
            operation: operation.to_string(),
            error_code: error_code.map(str::to_string),
        });
    }

    fn send(&self, message: WatchMessage) {
        let mut watch = lock(&self.watch);
        let Some(channel) = watch.as_ref() else {
            return;
        };
        if channel.send(message).is_err() {
            *watch = None;
        }
    }

    /// `open` 在所属会话正显示在面前时请求前端插入标签并切换过去。
    pub fn present(&self, tab: &Arc<AgentTab>) -> Result<(), &'static str> {
        let operation_id = format!("op_{}", random_hex(8).ok_or("random")?);
        let revision = self.next_revision();
        let (tx, rx) = std::sync::mpsc::channel();
        lock(&self.pending_present).insert(operation_id.clone(), tx);
        self.send(WatchMessage::Present {
            shell_generation: self.shell_generation(),
            revision,
            operation_id: operation_id.clone(),
            tab_id: tab.id.clone(),
        });
        let result = rx.recv_timeout(PRESENT_TIMEOUT);
        lock(&self.pending_present).remove(&operation_id);
        match result {
            Ok(()) => Ok(()),
            Err(_) => Err("browser_not_ready"),
        }
    }

    pub fn confirm_present(&self, operation_id: &str, tab_id: &str) {
        let sender = lock(&self.pending_present).get(operation_id).cloned();
        if sender.is_none() {
            return;
        }
        let exists = self.tab(tab_id).is_some();
        if !exists {
            return;
        }
        if let Some(sender) = sender {
            let _ = sender.send(());
        }
    }

    pub fn apply_ui_state(&self, next: UiState) -> Result<(), &'static str> {
        if next.shell_generation != self.shell_generation() {
            return Err("stale_generation");
        }
        let last = self.ui_revision.load(Ordering::SeqCst);
        if next.revision < last {
            return Err("stale_revision");
        }
        self.ui_revision.store(next.revision, Ordering::SeqCst);
        let mut ui = next;
        if let Some(layout) = &ui.layout {
            let last = self.layout_version.load(Ordering::SeqCst);
            if layout.version < last {
                // 迟到的旧布局不覆盖新布局
                ui.layout = None;
            } else {
                self.layout_version.store(layout.version, Ordering::SeqCst);
            }
        }
        ui.applied = Some(Instant::now());
        *lock(&self.ui) = ui;
        self.relayout();
        Ok(())
    }

    /// 按最近一次 UI 状态摆放 agent 标签：正在显示的那一个放到面板占位区，其余移到
    /// 可见区域之外（保持 shown，不 hide）。离屏标签不参与浮层遮挡。
    pub fn relayout(&self) {
        let ui = lock(&self.ui).clone();
        for tab in self.tabs_of_all() {
            let visible = ui.route == "session"
                && !ui.covered
                && ui.panel_open
                && ui.session_id.as_deref() == Some(tab.root.as_str())
                && ui.active_tab_id.as_deref() == Some(tab.id.as_str())
                && ui
                    .layout
                    .as_ref()
                    .is_some_and(|layout| layout.tab_id == tab.id);
            let bounds = match (&ui.layout, visible) {
                (Some(layout), true)
                    if layout.bounds.width >= 1.0 && layout.bounds.height >= 1.0 =>
                {
                    layout.bounds
                }
                _ => {
                    // 记住面板里的尺寸，离屏时仍按它给视口
                    let last = *lock(&tab.bounds);
                    match last {
                        Some(rect) if rect.x != OFFSCREEN_X => Rect {
                            x: OFFSCREEN_X,
                            y: 0.0,
                            width: rect.width.max(1.0),
                            height: rect.height.max(1.0),
                        },
                        _ => Rect::offscreen(),
                    }
                }
            };
            let changed = *lock(&tab.bounds) != Some(bounds);
            if changed {
                *lock(&tab.bounds) = Some(bounds);
                let _ = self.platform.set_bounds(&tab, bounds);
            }
        }
    }

    // ── 接管与交回 ──

    /// 撤销 agent 的控制权：取消在途/排队动作、清 refs、把状态标成 taken_over。
    /// 之后的动作被拒绝（`browser_taken_over`）。不伪造 Turn interrupt。
    pub fn takeover(&self, tab: &Arc<AgentTab>) -> bool {
        if tab.tab_state() == STATE_TAKEN_OVER {
            return false;
        }
        tab.state.store(STATE_TAKEN_OVER, Ordering::SeqCst);
        tab.bump_generation();
        *lock(&tab.snapshot) = None;
        self.cancel_tab_ops(&tab.id);
        self.notify_tabs();
        true
    }

    /// 用户点进 agent 标签、子 webview 拿到原生焦点：撤销控制权（不是权限批准）。
    pub fn auto_takeover(&self, tab_id: &str) {
        let Some(tab) = self.tab(tab_id) else { return };
        if tab.should_ignore_focus() {
            return;
        }
        if tab.tab_state() == STATE_TAKEN_OVER || tab.tab_state() == STATE_ENDED {
            return;
        }
        self.takeover(&tab);
    }

    /// 交回：先把原生键盘焦点移回主界面，确认 child 不再持有焦点，再恢复租约。
    pub fn give_back(&self, tab: &Arc<AgentTab>) -> Result<(), &'static str> {
        if tab.tab_state() != STATE_TAKEN_OVER {
            return Ok(());
        }
        self.platform.focus_main().map_err(|_| "browser_failed")?;
        let deadline = Instant::now() + Duration::from_millis(400);
        while Instant::now() < deadline {
            if !self.platform.child_focused(tab) {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        if self.platform.child_focused(tab) {
            return Err("focus_busy");
        }
        *lock(&tab.ignore_focus_until) = Instant::now() + Duration::from_millis(600);
        tab.bump_generation();
        *lock(&tab.snapshot) = None;
        tab.state.store(STATE_AGENT, Ordering::SeqCst);
        self.notify_tabs();
        Ok(())
    }

    // ── 脚本对话框 ──

    /// 网页弹出脚本对话框：记下内容推给主界面。网页脚本停在对话框上，直到用户在横幅里处理；
    /// 期间 agent 的网页动作返回 `dialog_open`。
    pub fn dialog_opened(&self, tab: &Arc<AgentTab>, dialog: DialogInfo) {
        *lock(&tab.dialog) = Some(dialog);
        self.notify_tabs();
    }

    /// 用户在横幅里点了确定或取消。答复后 agent 可以继续（refs 照旧，网页可能已经变化，应重新 read）。
    pub fn resolve_dialog(
        &self,
        tab: &Arc<AgentTab>,
        accept: bool,
        text: Option<String>,
    ) -> Result<(), &'static str> {
        let kind = match lock(&tab.dialog).as_ref() {
            Some(dialog) => dialog.kind.clone(),
            None => return Err("no_dialog"),
        };
        // 只有 prompt 带输入；其他类型忽略 text
        let text = if accept && kind == "prompt" {
            Some(text.unwrap_or_default())
        } else {
            None
        };
        self.platform
            .resolve_dialog(tab, accept, text)
            .map_err(|_| "browser_failed")?;
        *lock(&tab.dialog) = None;
        self.notify_tabs();
        Ok(())
    }

    /// 页面提交：文档换了，旧 refs 与 capture 全部失效。
    pub fn document_changed(&self, tab: &Arc<AgentTab>, url: &str) {
        *lock(&tab.url) = url.to_string();
        *lock(&tab.snapshot) = None;
        tab.bump_generation();
        self.notify_tabs();
    }

    pub fn set_tab_loading(&self, tab: &Arc<AgentTab>, loading: bool) {
        tab.loading.store(loading, Ordering::SeqCst);
        if !loading {
            self.notify_tabs();
        }
    }

    pub fn set_tab_title(&self, tab: &Arc<AgentTab>, title: &str) {
        *lock(&tab.title) = title.to_string();
        self.notify_tabs();
    }
}

/// 常量时间比较，避免 token 比较的时序侧信道。
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

// ── Tauri 命令 ──

#[tauri::command]
pub fn agent_browser_watch(
    state: State<'_, Arc<AgentBrowserState>>,
    channel: Channel<WatchMessage>,
) -> WatchSnapshot {
    state.set_watch(channel);
    state.snapshot()
}

#[tauri::command]
pub fn agent_browser_ui_state(
    state: State<'_, Arc<AgentBrowserState>>,
    ui: UiState,
) -> Result<(), String> {
    state.apply_ui_state(ui).map_err(str::to_string)
}

#[tauri::command]
pub fn agent_browser_presented(
    state: State<'_, Arc<AgentBrowserState>>,
    shell_generation: u64,
    operation_id: String,
    tab_id: String,
    layout_version: u64,
) -> Result<(), String> {
    if shell_generation != state.shell_generation() {
        return Err("stale_generation".into());
    }
    let _ = layout_version;
    state.confirm_present(&operation_id, &tab_id);
    Ok(())
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ControlAction {
    Takeover,
    Return,
    Close,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlResult {
    pub revision: u64,
    pub state: Option<&'static str>,
}

#[tauri::command]
pub fn agent_browser_control(
    state: State<'_, Arc<AgentBrowserState>>,
    tab_id: String,
    action: ControlAction,
) -> Result<ControlResult, String> {
    let tab = state
        .tab(&tab_id)
        .ok_or_else(|| "unknown_tab".to_string())?;
    match action {
        ControlAction::Takeover => {
            state.takeover(&tab);
        }
        ControlAction::Return => {
            state.give_back(&tab).map_err(str::to_string)?;
        }
        ControlAction::Close => {
            state.close_tab(&tab);
        }
    }
    Ok(ControlResult {
        revision: state.next_revision(),
        state: Some(state_name(tab.tab_state())),
    })
}

/// 用户在 agent 标签的横幅里答复脚本对话框。
#[tauri::command]
pub fn agent_browser_dialog(
    state: State<'_, Arc<AgentBrowserState>>,
    tab_id: String,
    accept: bool,
    text: Option<String>,
) -> Result<(), String> {
    let tab = state
        .tab(&tab_id)
        .ok_or_else(|| "unknown_tab".to_string())?;
    state
        .resolve_dialog(&tab, accept, text)
        .map_err(str::to_string)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnabledResult {
    pub enabled: bool,
    /// 需要重启后台才生效（启停都不在现有后台伪造或悄悄撤掉凭证）
    pub restart_required: bool,
}

#[tauri::command]
pub fn agent_browser_set_enabled(
    state: State<'_, Arc<AgentBrowserState>>,
    enabled: bool,
) -> Result<EnabledResult, String> {
    let restart_required = state.enabled() != enabled;
    if enabled && !state.enabled() {
        state.start_server()?;
    } else if !enabled && state.enabled() {
        state.stop_server();
    }
    state.persist_enabled(state.enabled());
    Ok(EnabledResult {
        enabled: state.enabled(),
        restart_required,
    })
}

/// 主界面重新加载：旧页面代际的绑定、标签、watch 全部作废。先撤绑定再关 webview。
pub fn page_reloaded(state: &AgentBrowserState) {
    state.revoke_all();
    state.destroy_all();
    state.shell_generation.fetch_add(1, Ordering::SeqCst);
    *lock(&state.watch) = None;
    *lock(&state.ui) = UiState::default();
    state.notify_tabs();
}

#[cfg(test)]
pub mod testing {
    //! 单元测试用的假平台：记录 CDP 调用、模拟导航与容量。

    use super::*;
    use serde_json::json;
    use std::sync::atomic::AtomicUsize;

    #[derive(Default)]
    pub struct MockPlatform {
        pub created: Mutex<Vec<String>>,
        pub destroyed: Mutex<Vec<String>>,
        pub bounds: Mutex<HashMap<String, Rect>>,
        pub calls: Mutex<Vec<(String, String, Value)>>,
        pub live: AtomicUsize,
        pub focused: AtomicBool,
        pub main_focused: AtomicU64,
        pub navigate_error: Mutex<Option<String>>,
        pub cdp_error: Mutex<Option<String>>,
        pub ax_nodes: Mutex<Vec<Value>>,
        pub ready: AtomicBool,
        /// 下一次松开鼠标时网页弹出的对话框（模拟 ScriptDialogOpening）
        pub dialog_on_click: Mutex<Option<DialogInfo>>,
        /// 外壳收到的对话框答复：(tabId, 确定, prompt 文字)
        pub resolved: Mutex<Vec<(String, bool, Option<String>)>>,
        pub state: Mutex<Option<std::sync::Weak<AgentBrowserState>>>,
    }

    impl MockPlatform {
        pub fn new() -> Arc<Self> {
            let platform = Arc::new(Self::default());
            platform.ready.store(true, Ordering::SeqCst);
            platform
        }

        pub fn set_ax(&self, nodes: Vec<Value>) {
            *lock(&self.ax_nodes) = nodes;
        }

        pub fn bounds_of(&self, tab_id: &str) -> Option<Rect> {
            lock(&self.bounds).get(tab_id).copied()
        }

        /// 默认的 CDP 回复：只认 read/screenshot 需要的最小集合。
        fn canned(&self, method: &str, params: &Value) -> Result<Value, String> {
            match method {
                "Page.getLayoutMetrics" => Ok(json!({
                    "cssLayoutViewport": { "clientWidth": 900, "clientHeight": 700, "pageScaleFactor": 1.0 },
                    "cssContentSize": { "x": 0, "y": 0, "width": 900, "height": 1400 }
                })),
                "Accessibility.getFullAXTree" => {
                    Ok(json!({ "nodes": lock(&self.ax_nodes).clone() }))
                }
                "Page.captureScreenshot" => Ok(json!({ "data": PNG_1X1_BASE64 })),
                "DOM.getBoxModel" => Ok(json!({
                    "model": { "content": [10.0, 10.0, 50.0, 10.0, 50.0, 30.0, 10.0, 30.0] }
                })),
                "DOM.resolveNode" => Ok(json!({ "object": { "objectId": "obj-1" } })),
                "Runtime.callFunctionOn" => Ok(json!({
                    "result": { "type": "object", "value": { "ok": true, "length": 3, "value": "abc" } },
                    "exceptionDetails": Value::Null
                })),
                "Runtime.evaluate" => {
                    let expression = params
                        .get("expression")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if expression.contains("devicePixelRatio") {
                        Ok(json!({ "result": { "type": "number", "value": 1.0 } }))
                    } else if expression.contains("readyState") {
                        Ok(json!({ "result": { "type": "string", "value": "complete" } }))
                    } else {
                        Ok(json!({ "result": { "type": "string", "value": "ok" } }))
                    }
                }
                _ => Ok(json!({})),
            }
        }
    }

    pub const PNG_1X1_BASE64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    impl AgentPlatform for MockPlatform {
        fn create(&self, tab: &Arc<AgentTab>) -> Result<(), String> {
            lock(&self.created).push(tab.id.clone());
            lock(&self.bounds).insert(tab.id.clone(), Rect::offscreen());
            self.live.fetch_add(1, Ordering::SeqCst);
            // 假平台立即「加载完成」，open 不必等 20 秒
            tab.loading.store(false, Ordering::SeqCst);
            Ok(())
        }

        fn destroy(&self, tab: &Arc<AgentTab>) {
            lock(&self.destroyed).push(tab.id.clone());
            self.live.fetch_sub(1, Ordering::SeqCst);
        }

        fn set_bounds(&self, tab: &Arc<AgentTab>, bounds: Rect) -> Result<(), String> {
            lock(&self.bounds).insert(tab.id.clone(), bounds);
            Ok(())
        }

        fn navigate(&self, tab: &Arc<AgentTab>, url: &str) -> Result<(), String> {
            if let Some(error) = lock(&self.navigate_error).clone() {
                return Err(error);
            }
            *lock(&tab.url) = url.to_string();
            tab.loading.store(false, Ordering::SeqCst);
            Ok(())
        }

        fn history(&self, _: &Arc<AgentTab>, _: bool) -> Result<(), String> {
            Ok(())
        }

        fn cdp(&self, tab: &Arc<AgentTab>, method: &str, params: Value) -> Result<Value, String> {
            if let Some(error) = lock(&self.cdp_error).clone() {
                return Err(error);
            }
            lock(&self.calls).push((tab.id.clone(), method.to_string(), params.clone()));
            if method == "Input.dispatchMouseEvent" && params["type"] == "mouseReleased" {
                if let Some(dialog) = lock(&self.dialog_on_click).take() {
                    // 真实外壳里 CDP 回调要等对话框关掉才回来；这里直接报未完成
                    let state = lock(&self.state)
                        .as_ref()
                        .and_then(std::sync::Weak::upgrade);
                    match state {
                        Some(state) => state.dialog_opened(tab, dialog),
                        None => *lock(&tab.dialog) = Some(dialog),
                    }
                    return Err("网页弹出了对话框".into());
                }
            }
            self.canned(method, &params)
        }

        fn resolve_dialog(
            &self,
            tab: &Arc<AgentTab>,
            accept: bool,
            text: Option<String>,
        ) -> Result<(), String> {
            lock(&self.resolved).push((tab.id.clone(), accept, text));
            Ok(())
        }

        fn focus_main(&self) -> Result<(), String> {
            self.main_focused.fetch_add(1, Ordering::SeqCst);
            self.focused.store(false, Ordering::SeqCst);
            Ok(())
        }

        fn child_focused(&self, _: &Arc<AgentTab>) -> bool {
            self.focused.load(Ordering::SeqCst)
        }

        fn live_webviews(&self) -> usize {
            0
        }

        fn dev_url(&self) -> Option<tauri::Url> {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::{MockPlatform, PNG_1X1_BASE64};
    use super::*;
    use serde_json::json;

    fn setup() -> (Arc<AgentBrowserState>, Arc<MockPlatform>) {
        let platform = MockPlatform::new();
        let state = AgentBrowserState::new(platform.clone(), None);
        state.enabled.store(true, Ordering::SeqCst);
        (state, platform)
    }

    fn bound(state: &Arc<AgentBrowserState>) -> (String, String) {
        state.open_binding("root-a").unwrap()
    }

    #[test]
    fn watch_messages_use_camel_case_fields() {
        // 主界面按 desktop-browser.md 第 3 节读 camelCase 字段
        let tabs = serde_json::to_value(WatchMessage::Tabs {
            shell_generation: 3,
            revision: 7,
            tabs: Vec::new(),
        })
        .unwrap();
        assert_eq!(
            tabs,
            json!({ "kind": "tabs", "shellGeneration": 3, "revision": 7, "tabs": [] })
        );
        let present = serde_json::to_value(WatchMessage::Present {
            shell_generation: 3,
            revision: 8,
            operation_id: "op_1".into(),
            tab_id: "t_1".into(),
        })
        .unwrap();
        assert_eq!(
            present,
            json!({
                "kind": "present",
                "shellGeneration": 3,
                "revision": 8,
                "operationId": "op_1",
                "tabId": "t_1"
            })
        );
        let operation = serde_json::to_value(WatchMessage::Operation {
            shell_generation: 3,
            revision: 9,
            tab_id: "t_1".into(),
            operation_id: "op_2".into(),
            state: "completed",
            operation: "click".into(),
            error_code: Some("taken_over".into()),
        })
        .unwrap();
        assert_eq!(
            operation,
            json!({
                "kind": "operation",
                "shellGeneration": 3,
                "revision": 9,
                "tabId": "t_1",
                "operationId": "op_2",
                "state": "completed",
                "operation": "click",
                "errorCode": "taken_over"
            })
        );
    }

    #[test]
    fn host_and_origin_rules() {
        // 保留 http::validate_host 的用例在 http 模块；这里只确认随机源不可猜
        let a = random_hex(16).unwrap();
        let b = random_hex(16).unwrap();
        assert_eq!(a.len(), 32);
        assert_ne!(a, b);
    }

    #[test]
    fn bindings_are_per_root_and_revocable() {
        let (state, _) = setup();
        let (id, bearer) = bound(&state);
        assert!(state.bearer_valid(&id, &bearer));
        assert!(!state.bearer_valid(&id, "wrong"));
        // 同代同根重复申请撤销旧绑定
        let (id2, _) = bound(&state);
        assert_ne!(id, id2);
        assert!(!state.bearer_valid(&id, &bearer));
        state.revoke_binding(&id2);
        assert!(state.binding_root(&id2).is_none());
    }

    #[test]
    fn capacity_is_five_and_pinned_tabs_count() {
        let (state, platform) = setup();
        let (id, _) = bound(&state);
        let mut created = Vec::new();
        for _ in 0..MAX_LIVE_BROWSERS {
            let tab = state
                .create_tab(&id, "root-a", "root-a", "about:blank")
                .unwrap();
            created.push(tab);
        }
        assert_eq!(state.live_count(), MAX_LIVE_BROWSERS);
        assert_eq!(
            state
                .create_tab(&id, "root-a", "root-a", "about:blank")
                .err(),
            Some("browser_capacity")
        );
        // pinned 不参与回收：关掉一个才腾出位置
        state.close_tab(&created[0]);
        assert!(state
            .create_tab(&id, "root-a", "root-a", "about:blank")
            .is_ok());
        assert_eq!(lock(&platform.destroyed).len(), 1);
    }

    #[test]
    fn takeover_rejects_actions_and_cancels_in_flight() {
        let (state, platform) = setup();
        let (id, _) = bound(&state);
        let tab = state
            .create_tab(&id, "root-a", "root-a", "https://example.test/")
            .unwrap();
        let op = state.begin_call(&id, "1", "root-a/t1/c1").unwrap();
        *lock(&op.tab_id) = Some(tab.id.clone());
        assert!(crate::agent_browser::check_agent_control(
            tab.tab_state() == STATE_TAKEN_OVER,
            op.cancelled()
        )
        .is_ok());
        state.takeover(&tab);
        assert_eq!(tab.tab_state(), STATE_TAKEN_OVER);
        assert!(op.cancelled());
        assert_eq!(
            crate::agent_browser::check_agent_control(true, false),
            Err("taken_over")
        );
        // 交回：焦点先回主界面，状态恢复
        state.give_back(&tab).unwrap();
        assert_eq!(tab.tab_state(), STATE_AGENT);
        assert_eq!(platform.main_focused.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn cancelled_operations_stop_dispatch() {
        let (state, _) = setup();
        let (id, _) = bound(&state);
        let tab = state
            .create_tab(&id, "root-a", "root-a", "https://example.test/")
            .unwrap();
        let op = state.begin_call(&id, "7", "root-a/t1/c1").unwrap();
        *lock(&op.tab_id) = Some(tab.id.clone());
        state.cancel_request(&id, "7");
        assert!(op.cancelled());
        assert_eq!(
            crate::agent_browser::check_agent_control(false, op.cancelled()),
            Err("cancelled")
        );
        state.end_call(&id, "7");
        // 结束以后重复取消不产生新动作
        state.cancel_request(&id, "7");
        assert!(op.cancelled());
    }

    #[test]
    fn ui_state_places_active_tab_and_moves_the_rest_offscreen() {
        let (state, platform) = setup();
        let (id, _) = bound(&state);
        let a = state
            .create_tab(&id, "root-a", "root-a", "https://a.test/")
            .unwrap();
        let b = state
            .create_tab(&id, "root-b", "root-b", "https://b.test/")
            .unwrap();
        state
            .apply_ui_state(UiState {
                shell_generation: state.shell_generation(),
                revision: 1,
                route: "session".into(),
                session_id: Some("root-a".into()),
                panel_open: true,
                active_tab_id: Some(a.id.clone()),
                layout: Some(LayoutRef {
                    tab_id: a.id.clone(),
                    version: 1,
                    bounds: Rect {
                        x: 1200.0,
                        y: 100.0,
                        width: 520.0,
                        height: 700.0,
                    },
                }),
                ..UiState::default()
            })
            .unwrap();
        assert_eq!(
            platform.bounds_of(&a.id),
            Some(Rect {
                x: 1200.0,
                y: 100.0,
                width: 520.0,
                height: 700.0
            })
        );
        // 别的会话的标签始终在离屏位置，不盖主界面
        let b_bounds = platform.bounds_of(&b.id).unwrap();
        assert_eq!(b_bounds.x, OFFSCREEN_X);
        assert!(b_bounds.width >= 1.0 && b_bounds.height >= 1.0);

        // 切到别的标签：原来的标签移到离屏位置，尺寸保留
        state
            .apply_ui_state(UiState {
                shell_generation: state.shell_generation(),
                revision: 2,
                route: "session".into(),
                session_id: Some("root-a".into()),
                panel_open: true,
                active_tab_id: Some("new-tab".into()),
                layout: None,
                ..UiState::default()
            })
            .unwrap();
        let a_bounds = platform.bounds_of(&a.id).unwrap();
        assert_eq!(a_bounds.x, OFFSCREEN_X);
        assert_eq!(a_bounds.width, 520.0);
    }

    #[test]
    fn old_generation_ui_state_is_rejected() {
        let (state, _) = setup();
        let generation = state.shell_generation();
        assert_eq!(
            state.apply_ui_state(UiState {
                shell_generation: generation + 1,
                revision: 1,
                ..UiState::default()
            }),
            Err("stale_generation")
        );
        assert!(state
            .apply_ui_state(UiState {
                shell_generation: generation,
                revision: 5,
                ..UiState::default()
            })
            .is_ok());
        assert_eq!(
            state.apply_ui_state(UiState {
                shell_generation: generation,
                revision: 4,
                ..UiState::default()
            }),
            Err("stale_revision")
        );
    }

    #[test]
    fn duplicate_caller_is_rejected() {
        let (state, _) = setup();
        let (id, _) = bound(&state);
        let _first = state.begin_call(&id, "1", "root-a/t1/c1").unwrap();
        assert_eq!(
            state.begin_call(&id, "2", "root-a/t1/c1").err(),
            Some("duplicate_call")
        );
    }

    #[test]
    fn page_reload_revokes_bindings_and_closes_tabs() {
        let (state, platform) = setup();
        let (id, bearer) = bound(&state);
        let tab = state
            .create_tab(&id, "root-a", "root-a", "https://a.test/")
            .unwrap();
        page_reloaded(&state);
        assert!(!state.bearer_valid(&id, &bearer));
        assert!(state.tab(&tab.id).is_none());
        assert!(lock(&platform.destroyed).contains(&tab.id));
    }

    #[test]
    fn bootstrap_env_is_only_present_while_enabled() {
        let (state, _) = setup();
        // 未启动服务器时没有启动凭证
        assert!(state.bootstrap_env().is_none());
        let port = state.start_server().unwrap();
        let (key, value) = state.bootstrap_env().unwrap();
        assert_eq!(key, "NOCTURNE_DESKTOP_BROWSER_BOOTSTRAP");
        let json: Value = serde_json::from_str(&value).unwrap();
        assert_eq!(json["version"], 1);
        assert_eq!(json["port"], port);
        assert!(json["secret"].as_str().unwrap().len() >= 32);
        state.stop_server();
        assert!(state.bootstrap_env().is_none());
        assert!(!state.enabled());
    }

    #[test]
    fn screenshot_size_is_known_to_the_mock() {
        // 假平台与真实截图共用 PNG 头解析（tools::image_size）
        let bytes = base64_decode(PNG_1X1_BASE64).unwrap();
        assert_eq!(tools::png_size(&bytes), Some((1, 1)));
    }

    use crate::agent_browser::http::base64_decode;

    #[test]
    fn ax_snapshot_refs_are_per_document() {
        let (state, platform) = setup();
        let (id, _) = bound(&state);
        let tab = state
            .create_tab(&id, "root-a", "root-a", "https://example.test/")
            .unwrap();
        platform.set_ax(vec![
            json!({
                "nodeId": "0", "ignored": false,
                "role": { "type": "role", "value": "RootWebArea" },
                "name": { "type": "computedString", "value": "Example" },
                "childIds": ["1"]
            }),
            json!({
                "nodeId": "1", "ignored": false,
                "role": { "type": "role", "value": "button" },
                "name": { "type": "computedString", "value": "Go" },
                "backendDOMNodeId": 9, "childIds": []
            }),
        ]);
        let mut ctx = tools::CallCtx {
            binding_id: id.clone(),
            root: "root-a".into(),
            actor: "root-a".into(),
            op: state.begin_call(&id, "1", "root-a/t1/c1").unwrap(),
        };
        let result = tools::call(&state, &mut ctx, "read", &json!({ "tabId": tab.id })).unwrap();
        let snapshot_id = result.structured["snapshotId"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(result.text.contains("[ref=e1]"));
        // 导航后旧 refs 失效
        state.document_changed(&tab, "https://example.test/next");
        let err = tools::call(
            &state,
            &mut ctx,
            "click",
            &json!({ "tabId": tab.id, "target": { "snapshotId": snapshot_id, "ref": "e1" } }),
        )
        .unwrap_err();
        assert_eq!(err.code, "stale_snapshot");
        state.end_call(&id, "1");
    }
}
