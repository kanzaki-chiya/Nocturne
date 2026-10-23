//! 第一版工具（desktop-browser.md 第 4 节）。所有网页工具显式带 `tabId`，动作只接受
//! `{snapshotId, ref}` 或（截图上）坐标；不开放任意 JavaScript、上传、下载、cookie 导出。
//!
//! 执行顺序固定：校验绑定/actor/租约 → 检查是否已接管或取消 → 进 UI 线程等 CDP →
//! 结果回到调用线程。每个动作派发前都复核一次，取消以后不再派发。

use super::ax;
use super::{check_agent_control, state_name};
use super::{AgentBrowserState, AgentTab, Op, STATE_AGENT, STATE_BUSY, STATE_TAKEN_OVER};
use crate::browser_policy;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Debug)]
pub struct ToolError {
    pub code: &'static str,
    pub message: String,
    pub hint: String,
    /// 并进 structuredContent 的附加字段（如 `dialog`）
    pub data: Option<Value>,
}

impl ToolError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            hint: String::new(),
            data: None,
        }
    }

    pub fn hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = hint.into();
        self
    }

    pub fn data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }
}

#[derive(Debug)]
pub struct ToolImage {
    pub data: String,
    pub mime_type: &'static str,
}

#[derive(Debug)]
pub struct ToolOutcome {
    pub text: String,
    pub structured: Value,
    pub images: Vec<ToolImage>,
}

impl ToolOutcome {
    fn text(text: impl Into<String>, structured: Value) -> Self {
        Self {
            text: text.into(),
            structured,
            images: Vec::new(),
        }
    }
}

/// 一次 `tools/call` 的调用者上下文。`root` 来自绑定，`actor` 来自受信的 `_meta`。
pub struct CallCtx {
    pub binding_id: String,
    pub root: String,
    pub actor: String,
    pub op: Arc<Op>,
}

impl CallCtx {
    fn cancelled(&self) -> bool {
        self.op.cancelled()
    }

    fn check(&self, tab: &Arc<AgentTab>) -> Result<(), ToolError> {
        check_agent_control(tab.tab_state() == STATE_TAKEN_OVER, self.cancelled()).map_err(|code| {
            match code {
                "taken_over" => ToolError::new(
                    "browser_taken_over",
                    "用户已接管这个标签，agent 的控制权已撤销",
                )
                .hint("需要用户点「交给 agent」后再重新 read"),
                _ => cancelled_error(),
            }
        })
    }
}

fn cancelled_error() -> ToolError {
    ToolError::new("cancelled", "操作已取消，不再派发后续动作")
}

/// 网页挂着脚本对话框时的错误：带上类型和文字。用户在面板里处理之前，这个标签的网页动作都返回它。
fn dialog_error(tab: &Arc<AgentTab>) -> Option<ToolError> {
    let dialog = tab.dialog.lock().unwrap_or_else(|p| p.into_inner());
    let dialog = dialog.as_ref()?;
    let mut data = json!({ "kind": dialog.kind, "message": dialog.message, "uri": dialog.uri });
    if dialog.kind == "prompt" {
        data["defaultText"] = json!(dialog.default_text);
    }
    Some(
        ToolError::new(
            "dialog_open",
            format!(
                "网页弹出了 {} 对话框：「{}」，正在等用户在面板里处理",
                dialog.kind, dialog.message
            ),
        )
        .hint("agent 不能代为确定或取消；用户处理后重新 read 再继续")
        .data(json!({ "tabId": tab.id, "dialog": data })),
    )
}

fn invalid(message: impl Into<String>) -> ToolError {
    ToolError::new("invalid_arguments", message)
}

fn arg_str<'a>(args: &'a Value, name: &str) -> Result<&'a str, ToolError> {
    args.get(name)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| invalid(format!("缺少参数 {name}")))
}

fn opt_u32(args: &Value, name: &str) -> Result<Option<u32>, ToolError> {
    match args.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .map(Some)
            .ok_or_else(|| invalid(format!("参数 {name} 必须是整数"))),
    }
}

fn opt_f64(args: &Value, name: &str) -> Result<Option<f64>, ToolError> {
    match args.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_f64()
            .filter(|n| n.is_finite())
            .map(Some)
            .ok_or_else(|| invalid(format!("参数 {name} 必须是数字"))),
    }
}

/// 工具清单（`tools/list`）。顺序固定，便于测试与阅读。
pub fn schemas() -> Vec<Value> {
    fn tab(name: &str) -> Value {
        json!({ "type": "string", "description": format!("{name}") })
    }
    let target = json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["snapshotId", "ref"],
        "properties": {
            "snapshotId": { "type": "string" },
            "ref": { "type": "string", "description": "最近一次 read 返回的 ref，例如 e3" }
        }
    });
    fn schema(properties: Value, required: Vec<&str>) -> Value {
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": required,
            "properties": properties
        })
    }
    vec![
        json!({
            "name": "open",
            "description": "打开一个网页，返回新的 tabId。只接受 http(s) 与 about:blank；总是新建标签。",
            "inputSchema": schema(json!({
                "url": { "type": "string" }
            }), vec!["url"]),
            "annotations": { "readOnlyHint": false }
        }),
        json!({
            "name": "navigate",
            "description": "让已有标签导航到新地址；返回提交的地址与加载状态。",
            "inputSchema": schema(json!({
                "tabId": tab("标签 id"),
                "url": { "type": "string" }
            }), vec!["tabId", "url"]),
            "annotations": { "readOnlyHint": false }
        }),
        json!({
            "name": "screenshot",
            "description": "截当前视口，返回 PNG（作为图片附件）与 captureId。",
            "inputSchema": schema(json!({ "tabId": tab("标签 id") }), vec!["tabId"]),
            "annotations": { "readOnlyHint": true }
        }),
        json!({
            "name": "read",
            "description": "读取可访问性树的有界文本快照，返回 snapshotId 与 refs。target 可定向读取已观察子树。",
            "inputSchema": schema(json!({
                "tabId": tab("标签 id"),
                "target": target
            }), vec!["tabId"]),
            "annotations": { "readOnlyHint": true }
        }),
        json!({
            "name": "click",
            "description": "在 ref 指向的元素上派发鼠标点击。",
            "inputSchema": schema(json!({
                "tabId": tab("标签 id"),
                "target": target,
                "button": { "type": "string", "enum": ["left", "right"] },
                "clickCount": { "type": "integer", "enum": [1, 2] }
            }), vec!["tabId", "target"]),
            "annotations": { "readOnlyHint": false }
        }),
        json!({
            "name": "type",
            "description": "向 ref 指向的输入框写入文本；replace 缺省为 true。不回显正文。",
            "inputSchema": schema(json!({
                "tabId": tab("标签 id"),
                "target": target,
                "text": { "type": "string" },
                "replace": { "type": "boolean" }
            }), vec!["tabId", "target", "text"]),
            "annotations": { "readOnlyHint": false }
        }),
        json!({
            "name": "press",
            "description": "向 ref 指向的元素按一个网页键（Enter、Tab、方向键等）。",
            "inputSchema": schema(json!({
                "tabId": tab("标签 id"),
                "target": target,
                "key": { "type": "string" }
            }), vec!["tabId", "target", "key"]),
            "annotations": { "readOnlyHint": false }
        }),
        json!({
            "name": "scroll",
            "description": "在视口或 ref 指向的元素上滚动；每轴最多 2000 CSS px。",
            "inputSchema": schema(json!({
                "tabId": tab("标签 id"),
                "target": target,
                "deltaX": { "type": "number" },
                "deltaY": { "type": "number" }
            }), vec!["tabId"]),
            "annotations": { "readOnlyHint": false }
        }),
        json!({
            "name": "wait",
            "description": "等网页里出现某段文字或某个 ref；不导航、不点击。",
            "inputSchema": schema(json!({
                "tabId": tab("标签 id"),
                "text": { "type": "string" },
                "target": target,
                "timeoutMs": { "type": "integer", "minimum": 1, "maximum": 10000 }
            }), vec!["tabId"]),
            "annotations": { "readOnlyHint": true }
        }),
        json!({
            "name": "back",
            "description": "后退；没有历史时是明确的 no-op。",
            "inputSchema": schema(json!({ "tabId": tab("标签 id") }), vec!["tabId"]),
            "annotations": { "readOnlyHint": false }
        }),
        json!({
            "name": "forward",
            "description": "前进；没有历史时是明确的 no-op。",
            "inputSchema": schema(json!({ "tabId": tab("标签 id") }), vec!["tabId"]),
            "annotations": { "readOnlyHint": false }
        }),
        json!({
            "name": "list_tabs",
            "description": "列出当前 actor 的 agent 标签与状态。",
            "inputSchema": schema(json!({}), vec![]),
            "annotations": { "readOnlyHint": true }
        }),
        json!({
            "name": "close_tab",
            "description": "关闭本 actor 的一个 agent 标签。",
            "inputSchema": schema(json!({ "tabId": tab("标签 id") }), vec!["tabId"]),
            "annotations": { "readOnlyHint": false }
        }),
    ]
}

/// 能力入口：调用工具。未知工具按协议错误返回，不执行任何动作。
pub fn call(
    state: &Arc<AgentBrowserState>,
    ctx: &mut CallCtx,
    name: &str,
    args: &Value,
) -> Result<ToolOutcome, ToolError> {
    if !args.is_object() && name != "list_tabs" {
        return Err(invalid("arguments 必须是对象"));
    }
    match name {
        "open" => open(state, ctx, args),
        "navigate" => navigate(state, ctx, args),
        "screenshot" => screenshot(state, ctx, args),
        "read" => read(state, ctx, args),
        "click" => click(state, ctx, args),
        "type" => type_text(state, ctx, args),
        "press" => press(state, ctx, args),
        "scroll" => scroll(state, ctx, args),
        "wait" => wait(state, ctx, args),
        "back" => history(state, ctx, args, false),
        "forward" => history(state, ctx, args, true),
        "list_tabs" => list_tabs(state, ctx),
        "close_tab" => close_tab(state, ctx, args),
        _ => Err(ToolError::new(
            "unknown_tool",
            format!("没有这个工具：{name}"),
        )),
    }
}

fn busy<T>(
    state: &Arc<AgentBrowserState>,
    ctx: &CallCtx,
    tab: &Arc<AgentTab>,
    operation: &str,
    body: impl FnOnce() -> Result<T, ToolError>,
) -> Result<T, ToolError> {
    ctx.check(tab)?;
    if let Some(error) = dialog_error(tab) {
        return Err(error);
    }
    let _guard = tab.busy.lock().unwrap_or_else(|p| p.into_inner());
    ctx.check(tab)?;
    if tab.tab_state() == STATE_AGENT {
        tab.state.store(STATE_BUSY, Ordering::SeqCst);
    }
    *tab.operation.lock().unwrap_or_else(|p| p.into_inner()) = Some(operation.to_string());
    state.notify_operation(&tab.id, &ctx.op.request_key, "started", operation, None);
    // 动作中途弹出对话框：不管动作本身报了什么（CDP 等不到回复），都如实返回 dialog_open
    let result = match (body(), dialog_error(tab)) {
        (_, Some(error)) => Err(error),
        (result, None) => result,
    };
    let cancelled = ctx.cancelled();
    *tab.operation.lock().unwrap_or_else(|p| p.into_inner()) = None;
    if tab.tab_state() == STATE_BUSY {
        tab.state.store(STATE_AGENT, Ordering::SeqCst);
    }
    let (kind, code) = match &result {
        Ok(_) => ("completed", None),
        Err(error) => (
            if cancelled { "cancelled" } else { "completed" },
            Some(error.code),
        ),
    };
    state.notify_operation(&tab.id, &ctx.op.request_key, kind, operation, code);
    state.notify_tabs();
    result
}

fn owned_tab(
    state: &Arc<AgentBrowserState>,
    ctx: &CallCtx,
    args: &Value,
) -> Result<Arc<AgentTab>, ToolError> {
    let id = arg_str(args, "tabId")?;
    let tab = state
        .tab(id)
        .filter(|tab| tab.live.load(Ordering::SeqCst))
        .ok_or_else(|| {
            ToolError::new("tab_not_found", "没有这个标签").hint("用 list_tabs 查看自己的标签")
        })?;
    if !tab.bound_to(&ctx.root, &ctx.actor) {
        return Err(ToolError::new(
            "tab_not_owned",
            "这个标签不属于当前会话或 actor",
        ));
    }
    if tab.binding_id != ctx.binding_id {
        return Err(ToolError::new("tab_not_owned", "标签不属于当前绑定"));
    }
    *ctx.op.tab_id.lock().unwrap_or_else(|p| p.into_inner()) = Some(tab.id.clone());
    ctx.check(&tab)?;
    Ok(tab)
}

fn dev_url(state: &Arc<AgentBrowserState>) -> Option<tauri::Url> {
    state.platform().dev_url()
}

fn agent_url(state: &Arc<AgentBrowserState>, input: &str) -> Result<tauri::Url, ToolError> {
    let url = tauri::Url::parse(input.trim())
        .map_err(|_| invalid("网址格式不对").hint("需要完整的 http(s) 地址或 about:blank"))?;
    let dev = dev_url(state);
    browser_policy::agent_allow_navigation(&url, None, None, dev.as_ref(), state.server_port())
        .map_err(|blocked| {
            ToolError::new(
                "navigation_blocked",
                format!("不能打开这个地址：{}", blocked.message()),
            )
            .hint("agent 只允许 http(s) 与 about:blank；file://、应用地址和启动端口拒绝，本机 http 可用")
        })?;
    if !matches!(url.scheme(), "http" | "https") && url.as_str() != "about:blank" {
        return Err(ToolError::new(
            "navigation_blocked",
            "只允许 http(s) 与 about:blank",
        ));
    }
    Ok(url)
}

fn wait_loading(tab: &Arc<AgentTab>, deadline: Instant, op: &Op) -> Result<(), ToolError> {
    while tab.loading.load(Ordering::SeqCst) {
        if op.cancelled() {
            return Err(cancelled_error());
        }
        // 加载中弹出对话框：网页停在对话框上，不再等加载完成
        if let Some(error) = dialog_error(tab) {
            return Err(error);
        }
        if Instant::now() > deadline {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(40));
    }
    Ok(())
}

fn open(
    state: &Arc<AgentBrowserState>,
    ctx: &CallCtx,
    args: &Value,
) -> Result<ToolOutcome, ToolError> {
    let url = agent_url(state, arg_str(args, "url")?)?;
    if ctx.cancelled() {
        return Err(cancelled_error());
    }
    let foreground = state.session_foreground(&ctx.root);
    let tab = state
        .create_tab(&ctx.binding_id, &ctx.root, &ctx.actor, url.as_str())
        .map_err(|code| match code {
            "browser_capacity" => {
                ToolError::new("browser_capacity", "面板里同时存活的浏览器已达到 5 个上限")
                    .hint("关闭不用的标签后再试；agent 标签固定，不会被回收")
            }
            "random" => ToolError::new("browser_failed", "无法生成标签 id"),
            _ => ToolError::new("browser_failed", "无法创建浏览器标签"),
        })?;
    *ctx.op.tab_id.lock().unwrap_or_else(|p| p.into_inner()) = Some(tab.id.clone());
    if foreground {
        if let Err(code) = state.present(&tab) {
            state.close_tab(&tab);
            return Err(ToolError::new(code, "主界面没有在限定时间内确认标签布局")
                .hint("确认会话面板没有关闭后重试"));
        }
    }
    let deadline = Instant::now() + Duration::from_secs(20);
    wait_loading(&tab, deadline, &ctx.op)?;
    if let Some(error) = dialog_error(&tab) {
        return Err(error);
    }
    let url = tab.url_text();
    let title = tab.title_text();
    let outcome = ToolOutcome::text(
        format!(
            "已打开 tabId={} url={} title={} loading={}",
            tab.id,
            url,
            if title.is_empty() {
                "（无标题）"
            } else {
                title.as_str()
            },
            tab.loading.load(Ordering::SeqCst)
        ),
        json!({
            "tabId": tab.id,
            "url": url,
            "title": title,
            "outcome": "opened",
            "loading": tab.loading.load(Ordering::SeqCst)
        }),
    );
    Ok(outcome)
}

fn navigate(
    state: &Arc<AgentBrowserState>,
    ctx: &CallCtx,
    args: &Value,
) -> Result<ToolOutcome, ToolError> {
    let tab = owned_tab(state, ctx, args)?;
    let url = agent_url(state, arg_str(args, "url")?)?;
    busy(state, ctx, &tab, "navigate", || {
        ctx.check(&tab)?;
        state
            .platform()
            .navigate(&tab, url.as_str())
            .map_err(|_| ToolError::new("browser_failed", "导航失败"))?;
        let deadline = Instant::now() + Duration::from_secs(20);
        wait_loading(&tab, deadline, &ctx.op)?;
        let current = tab.url_text();
        Ok(ToolOutcome::text(
            format!("已导航到 {current}"),
            json!({ "tabId": tab.id, "url": current, "outcome": "navigated" }),
        ))
    })
}

fn layout_metrics(state: &Arc<AgentBrowserState>, tab: &Arc<AgentTab>) -> Result<Value, ToolError> {
    state
        .platform()
        .cdp(tab, "Page.getLayoutMetrics", json!({}))
        .map_err(|error| ToolError::new("browser_failed", error))
}

fn viewport_of(metrics: &Value) -> (u32, u32) {
    let viewport = metrics
        .get("cssLayoutViewport")
        .or_else(|| metrics.get("layoutViewport"));
    let width = viewport
        .and_then(|v| v.get("clientWidth"))
        .and_then(Value::as_f64)
        .unwrap_or(900.0);
    let height = viewport
        .and_then(|v| v.get("clientHeight"))
        .and_then(Value::as_f64)
        .unwrap_or(700.0);
    (
        width.max(1.0).round() as u32,
        height.max(1.0).round() as u32,
    )
}

fn device_scale(state: &Arc<AgentBrowserState>, tab: &Arc<AgentTab>) -> f64 {
    // 固定脚本：只读 devicePixelRatio，不接受模型 JS
    state
        .platform()
        .cdp(
            tab,
            "Runtime.evaluate",
            json!({
                "expression": "window.devicePixelRatio",
                "returnByValue": true
            }),
        )
        .ok()
        .and_then(|value| value.pointer("/result/value").and_then(Value::as_f64))
        .filter(|scale| *scale > 0.1 && *scale < 8.0)
        .unwrap_or(1.0)
}

/// PNG 尺寸（IHDR）；不是合法 PNG 时返回 None。
pub fn png_size(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" || &bytes[12..16] != b"IHDR" {
        return None;
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    Some((width, height))
}

fn screenshot(
    state: &Arc<AgentBrowserState>,
    ctx: &CallCtx,
    args: &Value,
) -> Result<ToolOutcome, ToolError> {
    let tab = owned_tab(state, ctx, args)?;
    busy(state, ctx, &tab, "screenshot", || {
        let metrics = layout_metrics(state, &tab)?;
        let viewport = viewport_of(&metrics);
        let scale = device_scale(state, &tab);
        ctx.check(&tab)?;
        let shot = state
            .platform()
            .cdp(
                &tab,
                "Page.captureScreenshot",
                json!({ "format": "png", "captureBeyondViewport": false }),
            )
            .map_err(|error| ToolError::new("browser_failed", error))?;
        let data = shot
            .get("data")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::new("browser_failed", "截图没有返回数据"))?
            .to_string();
        let bytes = super::http::base64_decode(&data)
            .ok_or_else(|| ToolError::new("browser_failed", "截图数据不是合法 base64"))?;
        if bytes.len() > 5 * 1024 * 1024 {
            return Err(ToolError::new("image_too_large", "截图超过 5 MiB 上限")
                .hint("缩小窗口或改用 read 文本快照"));
        }
        let (width, height) =
            png_size(&bytes).ok_or_else(|| ToolError::new("browser_failed", "截图不是合法 PNG"))?;
        if width > 8000 || height > 8000 {
            return Err(ToolError::new(
                "image_too_large",
                "截图的任一边超过 8000 像素",
            ));
        }
        let capture_id = format!(
            "c_{}",
            super::random_hex(8).ok_or_else(|| ToolError::new("browser_failed", "随机数不可用"))?
        );
        Ok(ToolOutcome {
            text: format!(
                "网页截图（不可信内容）：tabId={} captureId={} viewport={}x{} CSS px，图片 {}x{} 物理像素，imageScale={}",
                tab.id, capture_id, viewport.0, viewport.1, width, height, scale
            ),
            structured: json!({
                "tabId": tab.id,
                "url": tab.url_text(),
                "title": tab.title_text(),
                "captureId": capture_id,
                "viewport": { "width": viewport.0, "height": viewport.1 },
                "image": { "width": width, "height": height },
                "imageScale": scale,
                "outcome": "captured"
            }),
            images: vec![ToolImage {
                data,
                mime_type: "image/png",
            }],
        })
    })
}

fn document_id(tab: &Arc<AgentTab>) -> String {
    format!(
        "g{}|{}",
        tab.generation.load(Ordering::SeqCst),
        tab.url_text()
    )
}

fn ax_tree(state: &Arc<AgentBrowserState>, tab: &Arc<AgentTab>) -> Result<Vec<Value>, ToolError> {
    let value = state
        .platform()
        .cdp(tab, "Accessibility.getFullAXTree", json!({}))
        .map_err(|error| ToolError::new("browser_failed", error))?;
    Ok(value
        .get("nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

fn read(
    state: &Arc<AgentBrowserState>,
    ctx: &CallCtx,
    args: &Value,
) -> Result<ToolOutcome, ToolError> {
    let tab = owned_tab(state, ctx, args)?;
    busy(state, ctx, &tab, "read", || {
        if let Some(target) = args.get("target").filter(|value| !value.is_null()) {
            let snapshot_id = target
                .get("snapshotId")
                .and_then(Value::as_str)
                .unwrap_or("");
            let ref_id = target.get("ref").and_then(Value::as_str).unwrap_or("");
            let snapshot = tab.snapshot.lock().unwrap_or_else(|p| p.into_inner());
            let Some(snapshot) = snapshot.as_ref() else {
                return Err(ToolError::new(
                    "stale_snapshot",
                    "还没有可用的快照，或快照已因导航/接管失效",
                )
                .hint("重新 read"));
            };
            if snapshot.snapshot_id != snapshot_id || snapshot.doc != document_id(&tab) {
                return Err(ToolError::new("stale_snapshot", "这个快照已失效")
                    .hint("重新 read 后再用新的 ref"));
            }
            let text = snapshot.subtree(ref_id).ok_or_else(|| {
                ToolError::new("stale_ref", "ref 不在这次快照里").hint("重新 read")
            })?;
            return Ok(ToolOutcome::text(
                text,
                json!({
                    "tabId": tab.id,
                    "url": snapshot.url,
                    "title": snapshot.title,
                    "snapshotId": snapshot.snapshot_id,
                    "outcome": "read"
                }),
            ));
        }
        let metrics = layout_metrics(state, &tab)?;
        let viewport = viewport_of(&metrics);
        let scale = device_scale(state, &tab);
        let ready = state
            .platform()
            .cdp(
                &tab,
                "Runtime.evaluate",
                json!({ "expression": "document.readyState", "returnByValue": true }),
            )
            .ok()
            .and_then(|value| {
                value
                    .pointer("/result/value")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| "complete".into());
        let _ = ready;
        ctx.check(&tab)?;
        let nodes = ax_tree(state, &tab)?;
        let doc = document_id(&tab);
        let snapshot_id = format!(
            "s_{}",
            super::random_hex(8).ok_or_else(|| ToolError::new("browser_failed", "随机数不可用"))?
        );
        let snapshot = ax::format_tree(
            &nodes,
            &doc,
            &snapshot_id,
            &tab.url_text(),
            &tab.title_text(),
            viewport,
            scale,
        );
        let text = snapshot
            .text
            .replace("tabId=…", &format!("tabId={}", tab.id));
        let truncated = snapshot.truncated;
        let snapshot_id = snapshot.snapshot_id.clone();
        *tab.snapshot.lock().unwrap_or_else(|p| p.into_inner()) = Some(snapshot);
        Ok(ToolOutcome::text(
            text,
            json!({
                "tabId": tab.id,
                "url": tab.url_text(),
                "title": tab.title_text(),
                "snapshotId": snapshot_id,
                "viewport": { "width": viewport.0, "height": viewport.1 },
                "truncated": truncated,
                "outcome": "read"
            }),
        ))
    })
}

struct Resolved {
    backend: i64,
}

fn resolve_target(
    state: &Arc<AgentBrowserState>,
    tab: &Arc<AgentTab>,
    args: &Value,
) -> Result<Resolved, ToolError> {
    let target = args
        .get("target")
        .filter(|value| value.is_object())
        .ok_or_else(|| invalid("缺少 target"))?;
    let snapshot_id = target
        .get("snapshotId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let ref_id = target.get("ref").and_then(Value::as_str).unwrap_or("");
    let snapshot = tab.snapshot.lock().unwrap_or_else(|p| p.into_inner());
    let Some(snapshot) = snapshot.as_ref() else {
        return Err(ToolError::new("stale_snapshot", "还没有可用的快照").hint("先 read"));
    };
    if snapshot.snapshot_id != snapshot_id || snapshot.doc != document_id(tab) {
        return Err(ToolError::new("stale_snapshot", "这个快照已失效").hint("重新 read"));
    }
    let Some(target) = snapshot.ref_target(ref_id) else {
        return Err(ToolError::new("stale_ref", "ref 不在这次快照里").hint("重新 read"));
    };
    let _ = state;
    Ok(Resolved {
        backend: target.backend_node_id,
    })
}

fn box_center(
    state: &Arc<AgentBrowserState>,
    tab: &Arc<AgentTab>,
    backend: i64,
) -> Result<(f64, f64), ToolError> {
    let model = state
        .platform()
        .cdp(tab, "DOM.getBoxModel", json!({ "backendNodeId": backend }))
        .map_err(|_| ToolError::new("stale_ref", "元素已不可见或不在当前文档").hint("重新 read"))?;
    let quad = model
        .pointer("/model/content")
        .and_then(Value::as_array)
        .ok_or_else(|| ToolError::new("stale_ref", "元素没有可点击的几何"))?;
    let nums: Vec<f64> = quad.iter().filter_map(Value::as_f64).collect();
    if nums.len() < 8 {
        return Err(ToolError::new("stale_ref", "元素几何不完整"));
    }
    let x = (nums[0] + nums[2] + nums[4] + nums[6]) / 4.0;
    let y = (nums[1] + nums[3] + nums[5] + nums[7]) / 4.0;
    Ok((x, y))
}

fn dispatch_mouse(
    state: &Arc<AgentBrowserState>,
    ctx: &CallCtx,
    tab: &Arc<AgentTab>,
    action: MouseAction<'_>,
) -> Result<(), ToolError> {
    ctx.check(tab)?;
    raw_mouse(state, tab, action)
}

struct MouseAction<'a> {
    kind: &'a str,
    x: f64,
    y: f64,
    button: &'a str,
    count: u32,
}

/// 已经按下的动作必须送 release，不再检查取消，避免网页停在按住状态。
fn raw_mouse(
    state: &Arc<AgentBrowserState>,
    tab: &Arc<AgentTab>,
    action: MouseAction<'_>,
) -> Result<(), ToolError> {
    state
        .platform()
        .cdp(
            tab,
            "Input.dispatchMouseEvent",
            json!({
                "type": action.kind,
                "x": action.x,
                "y": action.y,
                "button": action.button,
                "clickCount": action.count,
                "buttons": if action.kind == "mousePressed" { 1 } else { 0 }
            }),
        )
        .map_err(|error| ToolError::new("browser_failed", error))?;
    Ok(())
}

fn click(
    state: &Arc<AgentBrowserState>,
    ctx: &CallCtx,
    args: &Value,
) -> Result<ToolOutcome, ToolError> {
    let tab = owned_tab(state, ctx, args)?;
    busy(state, ctx, &tab, "click", || {
        let resolved = resolve_target(state, &tab, args)?;
        let button = match args.get("button").and_then(Value::as_str) {
            Some("right") => "right",
            None | Some("left") => "left",
            Some(other) => return Err(invalid(format!("不支持的鼠标键：{other}"))),
        };
        let count = opt_u32(args, "clickCount")?.unwrap_or(1).clamp(1, 2);
        let (x, y) = box_center(state, &tab, resolved.backend)?;
        for index in 1..=count {
            let press = MouseAction {
                kind: "mousePressed",
                x,
                y,
                button,
                count: index,
            };
            dispatch_mouse(state, ctx, &tab, press)?;
            // 按下后即使取消也要松开，避免网页停在按住状态
            raw_mouse(
                state,
                &tab,
                MouseAction {
                    kind: "mouseReleased",
                    x,
                    y,
                    button,
                    count: index,
                },
            )?;
        }
        Ok(ToolOutcome::text(
            format!(
                "已点击（{}，{} 次） tabId={} url={}",
                button,
                count,
                tab.id,
                tab.url_text()
            ),
            json!({
                "tabId": tab.id,
                "url": tab.url_text(),
                "button": button,
                "clickCount": count,
                "outcome": "dispatched"
            }),
        ))
    })
}

fn resolve_object(
    state: &Arc<AgentBrowserState>,
    tab: &Arc<AgentTab>,
    backend: i64,
) -> Result<String, ToolError> {
    let value = state
        .platform()
        .cdp(tab, "DOM.resolveNode", json!({ "backendNodeId": backend }))
        .map_err(|_| ToolError::new("stale_ref", "元素已不在当前文档").hint("重新 read"))?;
    value
        .pointer("/object/objectId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| ToolError::new("stale_ref", "无法解析元素"))
}

fn call_function(
    state: &Arc<AgentBrowserState>,
    tab: &Arc<AgentTab>,
    object_id: &str,
    function: &str,
    arguments: Value,
) -> Result<Value, ToolError> {
    state
        .platform()
        .cdp(
            tab,
            "Runtime.callFunctionOn",
            json!({
                "objectId": object_id,
                "functionDeclaration": function,
                "arguments": arguments,
                "returnByValue": true,
                "awaitPromise": false
            }),
        )
        .map_err(|error| ToolError::new("browser_failed", error))
}

const SELECT_ALL: &str = "function(){ const el=this; if (typeof el.select==='function') { el.select(); return true; } if (el.isContentEditable) { const range=document.createRange(); range.selectNodeContents(el); const sel=window.getSelection(); sel.removeAllRanges(); sel.addRange(range); return true; } return false; }";

const READ_VALUE: &str = "function(expected){ const el=this; const value = (typeof el.value==='string') ? el.value : (el.isContentEditable ? el.innerText : null); if (value===null) return {ok:false}; return {ok:true, length:value.length, matches:value===expected}; }";

fn type_text(
    state: &Arc<AgentBrowserState>,
    ctx: &CallCtx,
    args: &Value,
) -> Result<ToolOutcome, ToolError> {
    let tab = owned_tab(state, ctx, args)?;
    let text = args
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("缺少参数 text"))?;
    let replace = args.get("replace").and_then(Value::as_bool).unwrap_or(true);
    busy(state, ctx, &tab, "type", || {
        let resolved = resolve_target(state, &tab, args)?;
        let object = resolve_object(state, &tab, resolved.backend)?;
        if replace {
            let _ = call_function(state, &tab, &object, SELECT_ALL, json!([]))?;
        }
        ctx.check(&tab)?;
        state
            .platform()
            .cdp(&tab, "Input.insertText", json!({ "text": text }))
            .map_err(|error| ToolError::new("browser_failed", error))?;
        // 只读回长度与是否匹配，不回显正文
        let verified = call_function(state, &tab, &object, READ_VALUE, json!([{ "value": text }]))
            .ok()
            .and_then(|value| value.pointer("/result/value").cloned())
            .map(|value| {
                json!({
                    "verified": value.get("ok").and_then(Value::as_bool).unwrap_or(false),
                    "matches": value.get("matches").and_then(Value::as_bool).unwrap_or(false),
                    "length": value.get("length").and_then(Value::as_u64).unwrap_or(0)
                })
            })
            .unwrap_or_else(|| json!({ "verified": false }));
        let matches = verified
            .get("matches")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let verified_flag = verified
            .get("verified")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        Ok(ToolOutcome::text(
            if !verified_flag {
                format!("已输入 {} 个字符（无法核对）", text.chars().count())
            } else if matches {
                format!("已输入 {} 个字符（已核对）", text.chars().count())
            } else {
                format!("已输入 {} 个字符（读回与输入不一致）", text.chars().count())
            },
            json!({
                "tabId": tab.id,
                "url": tab.url_text(),
                "verified": verified_flag,
                "matches": matches,
                "chars": text.chars().count(),
                "outcome": "inserted"
            }),
        ))
    })
}

/// 网页键白名单：不提供系统快捷键、剪贴板组合、F 键或任意 modifiers。
struct KeySpec {
    key: &'static str,
    code: &'static str,
    vk: i64,
    text: Option<&'static str>,
    modifiers: i64,
}

fn key_spec(input: &str) -> Option<KeySpec> {
    let spec = |key, code, vk, text, modifiers| KeySpec {
        key,
        code,
        vk,
        text,
        modifiers,
    };
    Some(match input {
        "Enter" => spec("Enter", "Enter", 13, Some("\r"), 0),
        "Tab" => spec("Tab", "Tab", 9, Some("\t"), 0),
        "Escape" => spec("Escape", "Escape", 27, None, 0),
        "Backspace" => spec("Backspace", "Backspace", 8, None, 0),
        "Delete" => spec("Delete", "Delete", 46, None, 0),
        "Space" => spec(" ", "Space", 32, Some(" "), 0),
        "ArrowUp" => spec("ArrowUp", "ArrowUp", 38, None, 0),
        "ArrowDown" => spec("ArrowDown", "ArrowDown", 40, None, 0),
        "ArrowLeft" => spec("ArrowLeft", "ArrowLeft", 37, None, 0),
        "ArrowRight" => spec("ArrowRight", "ArrowRight", 39, None, 0),
        "Home" => spec("Home", "Home", 36, None, 0),
        "End" => spec("End", "End", 35, None, 0),
        "PageUp" => spec("PageUp", "PageUp", 33, None, 0),
        "PageDown" => spec("PageDown", "PageDown", 34, None, 0),
        // 只用于选择文本，不作为通用快捷键
        "Ctrl+A" | "Control+A" => spec("a", "KeyA", 65, None, 2),
        "Meta+A" => spec("a", "KeyA", 65, None, 4),
        _ => return None,
    })
}

fn press(
    state: &Arc<AgentBrowserState>,
    ctx: &CallCtx,
    args: &Value,
) -> Result<ToolOutcome, ToolError> {
    let tab = owned_tab(state, ctx, args)?;
    let key_name = arg_str(args, "key")?;
    let spec = key_spec(key_name).ok_or_else(|| {
        invalid(format!("不支持的键：{key_name}"))
            .hint("支持 Enter、Tab、Escape、方向键、Home/End、PageUp/Down、Backspace/Delete、Space、Ctrl+A")
    })?;
    busy(state, ctx, &tab, "press", || {
        let resolved = resolve_target(state, &tab, args)?;
        let (x, y) = box_center(state, &tab, resolved.backend)?;
        // 先点一下元素，确保按下的是它（不改变滚动位置）
        dispatch_mouse(
            state,
            ctx,
            &tab,
            MouseAction {
                kind: "mousePressed",
                x,
                y,
                button: "left",
                count: 1,
            },
        )?;
        raw_mouse(
            state,
            &tab,
            MouseAction {
                kind: "mouseReleased",
                x,
                y,
                button: "left",
                count: 1,
            },
        )?;
        ctx.check(&tab)?;
        let down = json!({
            "type": if spec.text.is_some() { "keyDown" } else { "rawKeyDown" },
            "key": spec.key,
            "code": spec.code,
            "windowsVirtualKeyCode": spec.vk,
            "nativeVirtualKeyCode": spec.vk,
            "modifiers": spec.modifiers,
            "text": spec.text,
        });
        let pressed = state.platform().cdp(&tab, "Input.dispatchKeyEvent", down);
        // 无论按下是否成功、是否已取消，都保证对应 keyUp
        let _ = state.platform().cdp(
            &tab,
            "Input.dispatchKeyEvent",
            json!({
                "type": "keyUp",
                "key": spec.key,
                "code": spec.code,
                "windowsVirtualKeyCode": spec.vk,
                "nativeVirtualKeyCode": spec.vk,
                "modifiers": spec.modifiers
            }),
        );
        pressed.map_err(|error| ToolError::new("browser_failed", error))?;
        Ok(ToolOutcome::text(
            format!("已按键 {key_name}"),
            json!({
                "tabId": tab.id,
                "url": tab.url_text(),
                "key": key_name,
                "outcome": "dispatched"
            }),
        ))
    })
}

fn scroll(
    state: &Arc<AgentBrowserState>,
    ctx: &CallCtx,
    args: &Value,
) -> Result<ToolOutcome, ToolError> {
    let tab = owned_tab(state, ctx, args)?;
    let dx = opt_f64(args, "deltaX")?
        .unwrap_or(0.0)
        .clamp(-2000.0, 2000.0);
    let dy = opt_f64(args, "deltaY")?
        .unwrap_or(0.0)
        .clamp(-2000.0, 2000.0);
    if dx == 0.0 && dy == 0.0 {
        return Err(invalid("deltaX 与 deltaY 不能都是 0"));
    }
    busy(state, ctx, &tab, "scroll", || {
        let (x, y) = if args.get("target").is_some_and(|value| !value.is_null()) {
            let resolved = resolve_target(state, &tab, args)?;
            box_center(state, &tab, resolved.backend)?
        } else {
            let metrics = layout_metrics(state, &tab)?;
            let (w, h) = viewport_of(&metrics);
            (w as f64 / 2.0, h as f64 / 2.0)
        };
        let before = state
            .platform()
            .cdp(
                &tab,
                "Runtime.evaluate",
                json!({ "expression": "window.scrollY", "returnByValue": true }),
            )
            .ok()
            .and_then(|value| value.pointer("/result/value").and_then(Value::as_f64));
        ctx.check(&tab)?;
        state
            .platform()
            .cdp(
                &tab,
                "Input.dispatchMouseEvent",
                json!({
                    "type": "mouseWheel",
                    "x": x,
                    "y": y,
                    "deltaX": dx,
                    "deltaY": dy,
                    "modifiers": 0
                }),
            )
            .map_err(|error| ToolError::new("browser_failed", error))?;
        std::thread::sleep(Duration::from_millis(60));
        let after = state
            .platform()
            .cdp(
                &tab,
                "Runtime.evaluate",
                json!({ "expression": "window.scrollY", "returnByValue": true }),
            )
            .ok()
            .and_then(|value| value.pointer("/result/value").and_then(Value::as_f64));
        let moved = match (before, after) {
            (Some(before), Some(after)) => Some(after - before),
            _ => None,
        };
        Ok(ToolOutcome::text(
            match moved {
                Some(moved) => format!("已滚动，可见位移 {moved:.0} px"),
                None => "已派发滚动".to_string(),
            },
            json!({
                "tabId": tab.id,
                "url": tab.url_text(),
                "scrolled": moved,
                "outcome": "dispatched"
            }),
        ))
    })
}

fn wait(
    state: &Arc<AgentBrowserState>,
    ctx: &CallCtx,
    args: &Value,
) -> Result<ToolOutcome, ToolError> {
    let tab = owned_tab(state, ctx, args)?;
    let text = args
        .get("text")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty());
    let target = args.get("target").filter(|value| value.is_object());
    if text.is_none() == target.is_none() {
        return Err(invalid("text 与 target 必须二选一"));
    }
    let timeout = opt_u32(args, "timeoutMs")?.unwrap_or(5000).clamp(1, 10_000);
    busy(state, ctx, &tab, "wait", || {
        let deadline = Instant::now() + Duration::from_millis(u64::from(timeout));
        let mut last_truncated = false;
        loop {
            ctx.check(&tab)?;
            if let Some(target) = target {
                let snapshot_id = target
                    .get("snapshotId")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let ref_id = target.get("ref").and_then(Value::as_str).unwrap_or("");
                let snapshot = tab.snapshot.lock().unwrap_or_else(|p| p.into_inner());
                let Some(snapshot) = snapshot.as_ref() else {
                    return Err(
                        ToolError::new("stale_snapshot", "还没有可用的快照").hint("先 read")
                    );
                };
                if snapshot.snapshot_id != snapshot_id || snapshot.doc != document_id(&tab) {
                    return Err(ToolError::new("stale_snapshot", "快照在等待期间失效了"));
                }
                let matched = snapshot.refs.contains_key(ref_id);
                if matched {
                    return Ok(ToolOutcome::text(
                        format!("找到了 ref={ref_id}"),
                        json!({ "tabId": tab.id, "matched": true, "outcome": "waited" }),
                    ));
                }
                // 目标已经不在这次快照里：重新读一次，仍然没有就继续等
            } else if let Some(text) = text {
                let nodes = ax_tree(state, &tab)?;
                let snapshot = ax::format_tree(
                    &nodes,
                    &document_id(&tab),
                    "wait",
                    &tab.url_text(),
                    &tab.title_text(),
                    viewport_of(&layout_metrics(state, &tab)?),
                    1.0,
                );
                last_truncated = snapshot.truncated;
                let matched = snapshot.text.contains(text);
                if matched {
                    return Ok(ToolOutcome::text(
                        format!("网页里出现了「{text}」"),
                        json!({ "tabId": tab.id, "url": tab.url_text(), "matched": true, "outcome": "waited" }),
                    ));
                }
                if snapshot.truncated {
                    return Err(ToolError::new(
                        "wait_incomplete",
                        "可访问性快照超出预算，无法确认整页都没有这段文字",
                    )
                    .hint("用 read 查看已观察范围，或改用 target"));
                }
            }
            if Instant::now() >= deadline {
                let _ = last_truncated;
                return Ok(ToolOutcome::text(
                    format!("等待 {timeout} ms 后仍未出现"),
                    json!({ "tabId": tab.id, "url": tab.url_text(), "matched": false, "outcome": "waited" }),
                ));
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    })
}

fn history(
    state: &Arc<AgentBrowserState>,
    ctx: &CallCtx,
    args: &Value,
    forward: bool,
) -> Result<ToolOutcome, ToolError> {
    let tab = owned_tab(state, ctx, args)?;
    let available = if forward {
        tab.forward.load(Ordering::SeqCst)
    } else {
        tab.back.load(Ordering::SeqCst)
    };
    if !available {
        return Ok(ToolOutcome::text(
            if forward {
                "没有可前进的历史（no-op）"
            } else {
                "没有可后退的历史（no-op）"
            },
            json!({
                "tabId": tab.id,
                "url": tab.url_text(),
                "moved": false,
                "outcome": "noop"
            }),
        ));
    }
    busy(
        state,
        ctx,
        &tab,
        if forward { "forward" } else { "back" },
        || {
            state
                .platform()
                .history(&tab, forward)
                .map_err(|_| ToolError::new("browser_failed", "历史导航失败"))?;
            let deadline = Instant::now() + Duration::from_secs(20);
            wait_loading(&tab, deadline, &ctx.op)?;
            Ok(ToolOutcome::text(
                format!(
                    "已{}到 {}",
                    if forward { "前进" } else { "后退" },
                    tab.url_text()
                ),
                json!({
                    "tabId": tab.id,
                    "url": tab.url_text(),
                    "moved": true,
                    "canBack": tab.back.load(Ordering::SeqCst),
                    "canForward": tab.forward.load(Ordering::SeqCst),
                    "outcome": "moved"
                }),
            ))
        },
    )
}

fn list_tabs(state: &Arc<AgentBrowserState>, ctx: &CallCtx) -> Result<ToolOutcome, ToolError> {
    if ctx.cancelled() {
        return Err(cancelled_error());
    }
    let tabs = state.tabs_of(&ctx.root, Some(&ctx.actor));
    let mut lines = vec![format!("自己的 agent 标签（{} 个）：", tabs.len())];
    let mut items = Vec::new();
    for tab in &tabs {
        let state_name = state_name(tab.tab_state());
        let dialog = tab
            .dialog
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .map(|dialog| dialog.kind.clone());
        lines.push(format!(
            "- {} {} pinned=true live={} state={}{} title={}",
            tab.id,
            tab.url_text(),
            tab.live.load(Ordering::SeqCst),
            state_name,
            dialog
                .as_deref()
                .map(|kind| format!(" dialog={kind}"))
                .unwrap_or_default(),
            tab.title_text()
        ));
        let mut item = json!({
            "tabId": tab.id,
            "url": tab.url_text(),
            "title": tab.title_text(),
            "state": state_name,
            "live": tab.live.load(Ordering::SeqCst),
            "pinned": true
        });
        if let Some(kind) = dialog {
            item["dialog"] = json!(kind);
        }
        items.push(item);
    }
    lines.push(format!(
        "面板里一共 {} 个浏览器（上限 5，agent 标签不参与回收）",
        state.live_count()
    ));
    Ok(ToolOutcome::text(
        lines.join("\n"),
        json!({ "tabs": items, "live": state.live_count(), "outcome": "listed" }),
    ))
}

fn close_tab(
    state: &Arc<AgentBrowserState>,
    ctx: &CallCtx,
    args: &Value,
) -> Result<ToolOutcome, ToolError> {
    let id = arg_str(args, "tabId")?;
    let Some(tab) = state.tab(id) else {
        if state.closed_by(id, &ctx.actor) {
            return Ok(ToolOutcome::text(
                format!("标签 {id} 已关闭"),
                json!({ "tabId": id, "outcome": "closed" }),
            ));
        }
        return Err(ToolError::new("tab_not_found", "没有这个标签"));
    };
    if !tab.bound_to(&ctx.root, &ctx.actor) {
        return Err(ToolError::new("tab_not_owned", "这个标签不属于当前 actor"));
    }
    ctx.check(&tab)?;
    state.close_tab(&tab);
    Ok(ToolOutcome::text(
        format!("已关闭 {id}"),
        json!({ "tabId": id, "outcome": "closed" }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_browser::testing::{MockPlatform, PNG_1X1_BASE64};
    use serde_json::json;

    fn setup() -> (Arc<AgentBrowserState>, Arc<MockPlatform>, CallCtx) {
        let platform = MockPlatform::new();
        let state = AgentBrowserState::new(platform.clone(), None);
        state.enabled.store(true, Ordering::SeqCst);
        let (binding, _) = state.open_binding("root-a").unwrap();
        let op = state.begin_call(&binding, "1", "root-a/t1/c1").unwrap();
        (
            state,
            platform,
            CallCtx {
                binding_id: binding,
                root: "root-a".into(),
                actor: "root-a".into(),
                op,
            },
        )
    }

    fn open_tab(state: &Arc<AgentBrowserState>, ctx: &mut CallCtx) -> String {
        let out = call(
            state,
            ctx,
            "open",
            &json!({ "url": "https://example.test/" }),
        )
        .unwrap();
        out.structured["tabId"].as_str().unwrap().to_string()
    }

    fn with_ax(platform: &MockPlatform) {
        platform.set_ax(vec![
            json!({
                "nodeId": "0", "ignored": false,
                "role": { "type": "role", "value": "RootWebArea" },
                "name": { "type": "computedString", "value": "Example" },
                "childIds": ["1", "2"]
            }),
            json!({
                "nodeId": "1", "ignored": false,
                "role": { "type": "role", "value": "textbox" },
                "name": { "type": "computedString", "value": "Search" },
                "backendDOMNodeId": 7, "childIds": []
            }),
            json!({
                "nodeId": "2", "ignored": false,
                "role": { "type": "role", "value": "button" },
                "name": { "type": "computedString", "value": "Go" },
                "backendDOMNodeId": 9, "childIds": []
            }),
        ]);
    }

    #[test]
    fn open_rejects_file_and_app_but_allows_loopback() {
        let (state, _, mut ctx) = setup();
        for url in [
            "file:///C:/secret.txt",
            "http://tauri.localhost/",
            "javascript:alert(1)",
        ] {
            let error = call(&state, &mut ctx, "open", &json!({ "url": url })).unwrap_err();
            assert_eq!(error.code, "navigation_blocked", "{url}");
        }
        // 本机 http 开发服务允许（文档第 5 节）
        for url in ["http://127.0.0.1:31420/", "http://localhost:3000/"] {
            assert!(
                call(&state, &mut ctx, "open", &json!({ "url": url })).is_ok(),
                "{url}"
            );
        }
        // about:blank 允许
        assert!(call(&state, &mut ctx, "open", &json!({ "url": "about:blank" })).is_ok());
    }

    #[test]
    fn read_click_type_press_round_trip() {
        let (state, platform, mut ctx) = setup();
        with_ax(&platform);
        let tab = open_tab(&state, &mut ctx);
        let read = call(&state, &mut ctx, "read", &json!({ "tabId": tab })).unwrap();
        let snapshot = read.structured["snapshotId"].as_str().unwrap().to_string();
        assert!(read.text.contains("button \"Go\" [ref=e2]"));
        let target = json!({ "snapshotId": snapshot, "ref": "e2" });
        let click = call(
            &state,
            &mut ctx,
            "click",
            &json!({ "tabId": tab, "target": target }),
        )
        .unwrap();
        assert_eq!(click.structured["outcome"], "dispatched");
        let type_target = json!({ "snapshotId": snapshot, "ref": "e1" });
        let typed = call(
            &state,
            &mut ctx,
            "type",
            &json!({ "tabId": tab, "target": type_target, "text": "中文输入" }),
        )
        .unwrap();
        assert!(typed.text.contains("已输入 4 个字符"));
        // 正文不回显
        assert!(!typed.text.contains("中文输入"));
        let pressed = call(
            &state,
            &mut ctx,
            "press",
            &json!({ "tabId": tab, "target": type_target, "key": "Enter" }),
        )
        .unwrap();
        assert_eq!(pressed.structured["key"], "Enter");
        // 每个 keyDown 都有 keyUp
        let keys: Vec<String> = platform
            .calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, method, _)| method == "Input.dispatchKeyEvent")
            .map(|(_, _, params)| params["type"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(keys, ["keyDown", "keyUp"]);
    }

    #[test]
    fn stale_refs_and_snapshots_are_rejected() {
        let (state, platform, mut ctx) = setup();
        with_ax(&platform);
        let tab = open_tab(&state, &mut ctx);
        let read = call(&state, &mut ctx, "read", &json!({ "tabId": tab })).unwrap();
        let snapshot = read.structured["snapshotId"].as_str().unwrap().to_string();
        state.document_changed(&state.tab(&tab).unwrap(), "https://example.test/next");
        let error = call(
            &state,
            &mut ctx,
            "click",
            &json!({ "tabId": tab, "target": { "snapshotId": snapshot, "ref": "e2" } }),
        )
        .unwrap_err();
        assert_eq!(error.code, "stale_snapshot");
        // 不存在的 ref
        let read = call(&state, &mut ctx, "read", &json!({ "tabId": tab })).unwrap();
        let snapshot = read.structured["snapshotId"].as_str().unwrap().to_string();
        let error = call(
            &state,
            &mut ctx,
            "click",
            &json!({ "tabId": tab, "target": { "snapshotId": snapshot, "ref": "e99" } }),
        )
        .unwrap_err();
        assert_eq!(error.code, "stale_ref");
    }

    #[test]
    fn screenshot_returns_image_and_capture_id() {
        let (state, _platform, mut ctx) = setup();
        let tab = open_tab(&state, &mut ctx);
        let shot = call(&state, &mut ctx, "screenshot", &json!({ "tabId": tab })).unwrap();
        assert_eq!(shot.images.len(), 1);
        assert_eq!(shot.images[0].data, PNG_1X1_BASE64);
        assert!(shot.structured["captureId"]
            .as_str()
            .unwrap()
            .starts_with("c_"));
        assert_eq!(shot.structured["viewport"]["width"], 900);
        assert_eq!(shot.structured["image"]["width"], 1);
        assert!(shot.text.contains("imageScale"));
    }

    #[test]
    fn tabs_are_per_actor() {
        let (state, _platform, mut ctx) = setup();
        let own = open_tab(&state, &mut ctx);
        // 子 actor 用自己的凭证：同一 binding，不同 actor
        let mut child = CallCtx {
            binding_id: ctx.binding_id.clone(),
            root: "root-a".into(),
            actor: "child-1".into(),
            op: state
                .begin_call(&ctx.binding_id, "2", "child-1/t2/c2")
                .unwrap(),
        };
        let error = call(&state, &mut child, "read", &json!({ "tabId": own })).unwrap_err();
        assert_eq!(error.code, "tab_not_owned");
        let list = call(&state, &mut child, "list_tabs", &json!({})).unwrap();
        assert_eq!(list.structured["tabs"].as_array().unwrap().len(), 0);
        // 子 actor 自己的标签只列自己的
        let child_tab = open_tab(&state, &mut child);
        let list = call(&state, &mut child, "list_tabs", &json!({})).unwrap();
        assert_eq!(list.structured["tabs"].as_array().unwrap().len(), 1);
        assert_eq!(list.structured["tabs"][0]["tabId"], child_tab);
        let list = call(&state, &mut ctx, "list_tabs", &json!({})).unwrap();
        assert_eq!(list.structured["tabs"].as_array().unwrap().len(), 1);
    }

    fn pop_dialog(platform: &MockPlatform, kind: &str, message: &str, default_text: &str) {
        *platform.dialog_on_click.lock().unwrap() = Some(crate::agent_browser::DialogInfo {
            kind: kind.into(),
            uri: "https://example.test/".into(),
            message: message.into(),
            default_text: default_text.into(),
        });
    }

    fn click_go(state: &Arc<AgentBrowserState>, ctx: &mut CallCtx, tab: &str) -> ToolError {
        let read = call(state, ctx, "read", &json!({ "tabId": tab })).unwrap();
        let snapshot = read.structured["snapshotId"].as_str().unwrap().to_string();
        call(
            state,
            ctx,
            "click",
            &json!({ "tabId": tab, "target": { "snapshotId": snapshot, "ref": "e2" } }),
        )
        .unwrap_err()
    }

    #[test]
    fn dialog_pauses_the_tab_until_the_user_answers() {
        let (state, platform, mut ctx) = setup();
        *platform.state.lock().unwrap() = Some(Arc::downgrade(&state));
        with_ax(&platform);
        let tab = open_tab(&state, &mut ctx);
        let tab_ref = state.tab(&tab).unwrap();

        // 点击触发 confirm：不自动取消后报成功，如实返回 dialog_open，带类型和文字
        pop_dialog(&platform, "confirm", "确定删除这一项？", "");
        let error = click_go(&state, &mut ctx, &tab);
        assert_eq!(error.code, "dialog_open");
        assert!(error.message.contains("confirm"), "{}", error.message);
        assert!(
            error.message.contains("确定删除这一项？"),
            "{}",
            error.message
        );
        let data = error.data.unwrap();
        assert_eq!(data["tabId"], tab);
        assert_eq!(data["dialog"]["kind"], "confirm");
        assert_eq!(data["dialog"]["message"], "确定删除这一项？");
        assert!(data["dialog"].get("defaultText").is_none());
        // 状态回到 agent，不卡在 busy；横幅能拿到对话框内容
        assert_eq!(tab_ref.tab_state(), STATE_AGENT);
        let tabs = serde_json::to_value(state.serialize_tabs()).unwrap();
        assert_eq!(tabs[0]["dialog"]["message"], "确定删除这一项？");

        // 用户处理前，这个标签的网页动作都返回 dialog_open；list_tabs 标出来
        let error = call(&state, &mut ctx, "read", &json!({ "tabId": tab })).unwrap_err();
        assert_eq!(error.code, "dialog_open");
        let list = call(&state, &mut ctx, "list_tabs", &json!({})).unwrap();
        assert_eq!(list.structured["tabs"][0]["dialog"], "confirm");
        assert!(list.text.contains("dialog=confirm"));

        // 接管不会替用户答复对话框
        state.takeover(&tab_ref);
        assert!(platform.resolved.lock().unwrap().is_empty());
        assert!(tab_ref.dialog.lock().unwrap().is_some());
        state.give_back(&tab_ref).unwrap();

        // 用户点确定：confirm 不带文字；之后 agent 能继续
        state
            .resolve_dialog(&tab_ref, true, Some("忽略".into()))
            .unwrap();
        assert_eq!(
            *platform.resolved.lock().unwrap(),
            [(tab.clone(), true, None)]
        );
        assert!(tab_ref.dialog.lock().unwrap().is_none());
        ctx.op = state
            .begin_call(&ctx.binding_id, "2", "root-a/t2/c2")
            .unwrap();
        call(&state, &mut ctx, "read", &json!({ "tabId": tab })).unwrap();
        assert_eq!(state.resolve_dialog(&tab_ref, true, None), Err("no_dialog"));
    }

    #[test]
    fn prompt_and_alert_answers_reach_the_page() {
        let (state, platform, mut ctx) = setup();
        *platform.state.lock().unwrap() = Some(Arc::downgrade(&state));
        with_ax(&platform);
        let tab = open_tab(&state, &mut ctx);
        let tab_ref = state.tab(&tab).unwrap();

        pop_dialog(&platform, "prompt", "你的名字？", "默认名");
        let error = click_go(&state, &mut ctx, &tab);
        assert_eq!(error.code, "dialog_open");
        assert_eq!(error.data.unwrap()["dialog"]["defaultText"], "默认名");
        state
            .resolve_dialog(&tab_ref, true, Some("中文名字".into()))
            .unwrap();

        pop_dialog(&platform, "prompt", "再输一次？", "");
        ctx.op = state
            .begin_call(&ctx.binding_id, "2", "root-a/t2/c2")
            .unwrap();
        assert_eq!(click_go(&state, &mut ctx, &tab).code, "dialog_open");
        state
            .resolve_dialog(&tab_ref, false, Some("不送".into()))
            .unwrap();

        pop_dialog(&platform, "alert", "保存成功", "");
        ctx.op = state
            .begin_call(&ctx.binding_id, "3", "root-a/t3/c3")
            .unwrap();
        let error = click_go(&state, &mut ctx, &tab);
        assert!(error.message.contains("alert"));
        state.resolve_dialog(&tab_ref, true, None).unwrap();

        assert_eq!(
            *platform.resolved.lock().unwrap(),
            [
                (tab.clone(), true, Some("中文名字".to_string())),
                (tab.clone(), false, None),
                (tab.clone(), true, None),
            ]
        );
    }

    #[test]
    fn takeover_rejects_further_actions() {
        let (state, _platform, mut ctx) = setup();
        let tab = open_tab(&state, &mut ctx);
        let tab_ref = state.tab(&tab).unwrap();
        state.takeover(&tab_ref);
        let error = call(&state, &mut ctx, "read", &json!({ "tabId": tab })).unwrap_err();
        assert_eq!(error.code, "browser_taken_over");
        // 交回后重新可用，但旧 refs 已失效
        state.give_back(&tab_ref).unwrap();
        ctx.op = state
            .begin_call(&ctx.binding_id, "2", "root-a/t2/c2")
            .unwrap();
        call(&state, &mut ctx, "read", &json!({ "tabId": tab })).unwrap();
    }

    #[test]
    fn cancel_before_dispatch_stops_the_action() {
        let (state, _platform, mut ctx) = setup();
        let tab = open_tab(&state, &mut ctx);
        let read = call(&state, &mut ctx, "read", &json!({ "tabId": tab })).unwrap();
        let snapshot = read.structured["snapshotId"].as_str().unwrap().to_string();
        state.cancel_request(&ctx.binding_id, "1");
        let error = call(
            &state,
            &mut ctx,
            "click",
            &json!({ "tabId": tab, "target": { "snapshotId": snapshot, "ref": "e2" } }),
        )
        .unwrap_err();
        assert_eq!(error.code, "cancelled");
    }

    #[test]
    fn close_tab_is_idempotent_for_the_same_actor() {
        let (state, platform, mut ctx) = setup();
        let tab = open_tab(&state, &mut ctx);
        call(&state, &mut ctx, "close_tab", &json!({ "tabId": tab })).unwrap();
        assert!(lock(&platform.destroyed).contains(&tab));
        // 新的请求：关闭动作会取消当前操作，同一调用不会再用
        ctx.op = state
            .begin_call(&ctx.binding_id, "2", "root-a/t2/c2")
            .unwrap();
        let again = call(&state, &mut ctx, "close_tab", &json!({ "tabId": tab })).unwrap();
        assert_eq!(again.structured["outcome"], "closed");
        // 别的 actor 不能靠猜 id 幂等成功
        let mut child = CallCtx {
            binding_id: ctx.binding_id.clone(),
            root: "root-a".into(),
            actor: "child-1".into(),
            op: state
                .begin_call(&ctx.binding_id, "3", "child-1/t3/c3")
                .unwrap(),
        };
        let error = call(&state, &mut child, "close_tab", &json!({ "tabId": tab })).unwrap_err();
        assert_eq!(error.code, "tab_not_found");
    }

    #[test]
    fn wait_matches_text_and_times_out() {
        let (state, platform, mut ctx) = setup();
        with_ax(&platform);
        let tab = open_tab(&state, &mut ctx);
        let matched = call(
            &state,
            &mut ctx,
            "wait",
            &json!({ "tabId": tab, "text": "Go", "timeoutMs": 1000 }),
        )
        .unwrap();
        assert_eq!(matched.structured["matched"], true);
        let missed = call(
            &state,
            &mut ctx,
            "wait",
            &json!({ "tabId": tab, "text": "never-there", "timeoutMs": 300 }),
        )
        .unwrap();
        assert_eq!(missed.structured["matched"], false);
    }

    #[test]
    fn png_size_reads_ihdr() {
        let bytes = crate::agent_browser::http::base64_decode(PNG_1X1_BASE64).unwrap();
        assert_eq!(png_size(&bytes), Some((1, 1)));
        assert_eq!(png_size(b"not a png"), None);
    }

    use super::super::lock;
}
