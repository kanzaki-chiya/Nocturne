//! 回环 Streamable HTTP MCP 服务器（desktop-browser.md 第 1、2 节）。
//!
//! - 只绑定 `127.0.0.1:0`，端口随机；不监听 IPv6、不通配；
//! - 所有路由先校验精确 Host、Origin、请求方法与 body 上限，再校验 bearer；
//! - 不重定向、不发 CORS、不接受 cookie/查询串鉴权；
//! - `/bindings` 只认启动凭证，`/mcp/*` 只认该根会话的 bearer；
//! - MCP 第一版只做 POST + JSON 响应，GET 405（不启用独立 SSE 推送）。
//!
//! 日志只记分类、耗时与大小，不记头、body、页面正文或截图。

use super::tools::{self, CallCtx, ToolError, ToolOutcome};
use super::{constant_time_eq, AgentBrowserState};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// 请求头上限（含请求行）。
pub const MAX_HEAD: usize = 16 * 1024;
/// POST body 上限。
pub const MAX_BODY: usize = 1024 * 1024;
/// 响应上限：截图等附件不能把内存撑爆。
pub const MAX_RESPONSE: usize = 8 * 1024 * 1024;
/// 同时处理的连接数上限；超过直接 503，不排队。
pub const MAX_CONNECTIONS: usize = 32;
const SOCKET_TIMEOUT: Duration = Duration::from_secs(15);

pub const PROTOCOL_VERSION: &str = "2025-06-18";

// ── 基础工具 ──

const B64: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    let mut padding = 0;
    for byte in text.bytes() {
        if byte == b'=' {
            padding += 1;
            continue;
        }
        if padding > 0 {
            // 填充之后不允许再有字符
            return None;
        }
        let value = B64.iter().position(|c| *c == byte)? as u32;
        acc = (acc << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(u8::try_from((acc >> bits) & 0xff).ok()?);
        }
    }
    Some(out)
}

#[cfg(test)]
pub fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64[((n >> 18) & 63) as usize] as char);
        out.push(B64[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            B64[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
fn base64_round_trips(bytes: &[u8]) -> bool {
    base64_decode(&base64_encode(bytes)).as_deref() == Some(bytes)
}

/// Host 必须精确等于本服务器监听的 `127.0.0.1:<port>`（大小写不敏感）。
pub fn validate_host(host: Option<&str>, port: u16) -> bool {
    let Some(raw) = host else { return false };
    raw.trim()
        .eq_ignore_ascii_case(&format!("127.0.0.1:{port}"))
}

/// 网页的 Origin 一律拒绝；缺席或 Tauri 本地来源放行。网页从 `fetch` 回环端口会带
/// 自己的 Origin，因此被拒绝。
pub fn validate_origin(origin: Option<&str>) -> bool {
    let Some(raw) = origin else { return true };
    let value = raw.trim();
    matches!(
        value,
        "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost"
    )
}

// ── HTTP 编解码 ──

#[derive(Debug)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .get(&name.to_ascii_lowercase())
            .map(String::as_str)
    }
}

#[derive(Debug)]
pub struct Response {
    pub status: u16,
    pub content_type: &'static str,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    fn json(status: u16, value: &Value) -> Self {
        Self {
            status,
            content_type: "application/json",
            headers: Vec::new(),
            body: serde_json::to_vec(value).unwrap_or_else(|_| b"{}".to_vec()),
        }
    }

    fn empty(status: u16) -> Self {
        Self {
            status,
            content_type: "text/plain; charset=utf-8",
            headers: Vec::new(),
            body: Vec::new(),
        }
    }

    fn text(status: u16, text: &str) -> Self {
        Self {
            status,
            content_type: "text/plain; charset=utf-8",
            headers: Vec::new(),
            body: text.as_bytes().to_vec(),
        }
    }
}

fn read_request(stream: &mut TcpStream) -> Result<Request, Response> {
    let mut buffer = Vec::with_capacity(1024);
    let mut chunk = [0u8; 4096];
    let head_end;
    loop {
        let read = stream
            .read(&mut chunk)
            .map_err(|_| Response::text(400, "bad request"))?;
        if read == 0 {
            return Err(Response::text(400, "bad request"));
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(at) = find_head_end(&buffer) {
            head_end = at;
            break;
        }
        if buffer.len() > MAX_HEAD {
            return Err(Response::text(431, "request head too large"));
        }
    }
    let head = String::from_utf8_lossy(&buffer[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();
    let version = parts.next().unwrap_or_default();
    if method.is_empty() || !version.starts_with("HTTP/1.") {
        return Err(Response::text(400, "bad request line"));
    }
    // 只接受 origin-form 路径，查询串丢弃（不接受查询串鉴权）
    let path = path.split('?').next().unwrap_or("").to_string();
    if !path.starts_with('/') {
        return Err(Response::text(400, "bad path"));
    }
    let mut headers = HashMap::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let Some((name, value)) = line.split_once(':') else {
            return Err(Response::text(400, "bad header"));
        };
        let name = name.trim().to_ascii_lowercase();
        if name.is_empty() || name.contains(' ') {
            return Err(Response::text(400, "bad header"));
        }
        if headers.contains_key(&name) {
            // 重复的 Host/Content-Length 等容易造成解释差异：一律拒绝
            return Err(Response::text(400, "duplicate header"));
        }
        headers.insert(name, value.trim().to_string());
    }
    if headers.contains_key("transfer-encoding") {
        return Err(Response::text(411, "transfer-encoding not accepted"));
    }
    let length = match headers.get("content-length") {
        Some(value) => value
            .parse::<usize>()
            .map_err(|_| Response::text(400, "bad content-length"))?,
        None => 0,
    };
    let mut body = buffer[head_end + 4..].to_vec();
    // 超限也先排掉一段（有界），再干净地回 413，避免对端只看到连接重置
    let drain = if length > MAX_BODY {
        length.min(MAX_BODY * 2)
    } else {
        length
    };
    while body.len() < drain {
        let read = stream
            .read(&mut chunk)
            .map_err(|_| Response::text(400, "bad body"))?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
    }
    if length > MAX_BODY {
        return Err(Response::text(413, "body too large"));
    }
    if body.len() < length {
        return Err(Response::text(400, "truncated body"));
    }
    body.truncate(length);
    Ok(Request {
        method,
        path,
        headers,
        body,
    })
}

fn find_head_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|w| w == b"\r\n\r\n")
}

fn write_response(stream: &mut TcpStream, response: &Response) -> std::io::Result<()> {
    let mut head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n",
        response.status,
        reason(response.status),
        response.content_type,
        response.body.len()
    );
    for (name, value) in &response.headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes())?;
    stream.write_all(&response.body)?;
    stream.flush()
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        202 => "Accepted",
        204 => "No Content",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        411 => "Length Required",
        413 => "Payload Too Large",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "Error",
    }
}

/// 启动监听线程。返回真实端口；`stop` 置位后由一次自连接唤醒 accept。
pub fn serve(
    state: Arc<AgentBrowserState>,
    secret: String,
    stop: Arc<AtomicBool>,
) -> Result<u16, String> {
    let listener =
        TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("无法监听回环端口：{e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let stop_accept = Arc::clone(&stop);
    std::thread::Builder::new()
        .name("agent-browser-http".into())
        .spawn(move || {
            let active = Arc::new(AtomicUsize::new(0));
            for incoming in listener.incoming() {
                if stop_accept.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(stream) = incoming else { continue };
                if active.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
                    active.fetch_sub(1, Ordering::SeqCst);
                    let mut stream = stream;
                    let _ = write_response(&mut stream, &Response::text(503, "busy"));
                    continue;
                }
                let state = Arc::clone(&state);
                let secret = secret.clone();
                let active = Arc::clone(&active);
                std::thread::Builder::new()
                    .name("agent-browser-http-conn".into())
                    .spawn(move || {
                        handle_connection(&state, &secret, port, stream);
                        active.fetch_sub(1, Ordering::SeqCst);
                    })
                    .ok();
            }
        })
        .map_err(|e| format!("无法启动回环服务器线程：{e}"))?;
    Ok(port)
}

fn handle_connection(
    state: &Arc<AgentBrowserState>,
    secret: &str,
    port: u16,
    mut stream: TcpStream,
) {
    let _ = stream.set_read_timeout(Some(SOCKET_TIMEOUT));
    let _ = stream.set_write_timeout(Some(SOCKET_TIMEOUT));
    let response = match read_request(&mut stream) {
        Ok(request) => handle(state, secret, port, &request),
        Err(response) => response,
    };
    let _ = write_response(&mut stream, &response);
}

/// 路由：鉴权顺序固定为 Host → Origin → 方法/路径 → body 上限（解析时）→ bearer。
pub fn handle(
    state: &Arc<AgentBrowserState>,
    secret: &str,
    port: u16,
    request: &Request,
) -> Response {
    if !validate_host(request.header("host"), port) {
        return Response::text(403, "bad host");
    }
    if !validate_origin(request.header("origin")) {
        return Response::text(403, "bad origin");
    }
    if request.method == "OPTIONS" {
        return Response::text(405, "cors is not supported");
    }
    let path = request.path.as_str();
    if let Some(binding_id) = path.strip_prefix("/mcp/") {
        return handle_mcp(state, binding_id, request);
    }
    if path == "/bindings" {
        if request.method != "POST" {
            return Response::text(405, "method not allowed");
        }
        let Some(auth) = request.header("authorization") else {
            return Response::text(403, "missing bearer");
        };
        if !bearer_matches(auth, secret) {
            return Response::text(403, "bad bearer");
        }
        let Ok(body) = serde_json::from_slice::<Value>(&request.body) else {
            return Response::text(400, "bad json");
        };
        let Some(root) = body.get("rootSessionId").and_then(Value::as_str) else {
            return Response::text(400, "missing rootSessionId");
        };
        if root.is_empty() || root.len() > 200 {
            return Response::text(400, "bad rootSessionId");
        }
        return match state.open_binding(root) {
            Ok((binding_id, bearer)) => {
                Response::json(200, &json!({ "bindingId": binding_id, "bearer": bearer }))
            }
            Err(error) => Response::text(403, error),
        };
    }
    if let Some(binding_id) = path.strip_prefix("/bindings/") {
        if request.method != "DELETE" {
            return Response::text(405, "method not allowed");
        }
        let Some(auth) = request.header("authorization") else {
            return Response::text(403, "missing bearer");
        };
        let token = auth.strip_prefix("Bearer ").unwrap_or("");
        // 启动凭证可撤销任意绑定；绑定自己的 bearer 也能撤销自己（CLI 关会话时用）
        if !bearer_matches(auth, secret) && !state.bearer_valid(binding_id, token) {
            return Response::text(403, "bad bearer");
        }
        state.revoke_binding(binding_id);
        return Response::empty(204);
    }
    Response::text(404, "not found")
}

fn bearer_matches(header: &str, expected: &str) -> bool {
    let Some(token) = header.strip_prefix("Bearer ") else {
        return false;
    };
    !token.is_empty() && constant_time_eq(token.as_bytes(), expected.as_bytes())
}

fn handle_mcp(state: &Arc<AgentBrowserState>, binding_id: &str, request: &Request) -> Response {
    if binding_id.is_empty() {
        return Response::text(404, "not found");
    }
    let Some(root) = state.binding_root(binding_id) else {
        return Response::text(403, "unknown binding");
    };
    let Some(auth) = request.header("authorization") else {
        return Response::text(403, "missing bearer");
    };
    let bearer = auth.strip_prefix("Bearer ").unwrap_or("");
    if !state.bearer_valid(binding_id, bearer) {
        return Response::text(403, "bad bearer");
    }
    let _ = root;
    match request.method.as_str() {
        // 第一版不启用独立 SSE 推送
        "GET" => Response::text(405, "sse not supported"),
        "DELETE" => {
            if let Some(session) = request.header("mcp-session-id") {
                state.drop_mcp_session(binding_id, session);
            }
            Response::empty(204)
        }
        "POST" => handle_rpc(state, binding_id, request),
        _ => Response::text(405, "method not allowed"),
    }
}

fn handle_rpc(state: &Arc<AgentBrowserState>, binding_id: &str, request: &Request) -> Response {
    let Ok(message) = serde_json::from_slice::<Value>(&request.body) else {
        return rpc_error(Value::Null, -32700, "parse error");
    };
    let (value, session) = match message {
        Value::Array(items) => {
            // 批量请求：逐条处理，通知不产生响应
            let mut responses = Vec::new();
            let mut session = None;
            for item in items {
                let (maybe, minted) = handle_message(state, binding_id, request, &item);
                if let Some(minted) = minted {
                    session = Some(minted);
                }
                if let Some(value) = maybe {
                    responses.push(value);
                }
            }
            if responses.is_empty() {
                return Response::empty(202);
            }
            (Value::Array(responses), session)
        }
        single => {
            let (maybe, session) = handle_message(state, binding_id, request, &single);
            let Some(value) = maybe else {
                return Response::empty(202);
            };
            (value, session)
        }
    };
    let body = match serde_json::to_vec(&value) {
        Ok(body) => body,
        Err(_) => return rpc_error(Value::Null, -32603, "serialize failed"),
    };
    if body.len() > MAX_RESPONSE {
        return Response::json(
            200,
            &json!({
                "jsonrpc": "2.0",
                "id": Value::Null,
                "error": { "code": -32603, "message": "响应超过 8 MiB，请改用 read 文本快照" }
            }),
        );
    }
    let mut response = Response {
        status: 200,
        content_type: "application/json",
        headers: Vec::new(),
        body,
    };
    if let Some(session) = session {
        response.headers.push(("Mcp-Session-Id".into(), session));
    }
    response
}

/// 返回 (响应, 新分配的 MCP session id)。
fn handle_message(
    state: &Arc<AgentBrowserState>,
    binding_id: &str,
    request: &Request,
    message: &Value,
) -> (Option<Value>, Option<String>) {
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let id = message.get("id").cloned();
    let is_initialize = method == "initialize";
    if !is_initialize {
        // 非 initialize 请求必须带本绑定下仍存活的 MCP session id
        let session = request.header("mcp-session-id").unwrap_or("");
        if !state.mcp_session_valid(binding_id, session) {
            return (
                Some(json!({
                    "jsonrpc": "2.0",
                    "id": id.unwrap_or(Value::Null),
                    "error": { "code": -32001, "message": "unknown mcp session" }
                })),
                None,
            );
        }
    }
    let Some(id) = id else {
        // 通知：initialized 之外没有副作用；cancelled 取消对应请求
        if method == "notifications/cancelled" {
            if let Some(request_id) = message
                .pointer("/params/requestId")
                .map(serialize_id)
                .filter(|v| !v.is_empty())
            {
                state.cancel_request(binding_id, &request_id);
            }
        }
        return (None, None);
    };
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let result = match method {
        "initialize" => {
            let version = params
                .get("protocolVersion")
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty())
                .unwrap_or(PROTOCOL_VERSION)
                .to_string();
            let session = state.new_mcp_session(binding_id);
            (
                json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": "desktop_browser", "version": "1.0.0" }
                }),
                Some(session),
            )
        }
        "ping" => (json!({}), None),
        "tools/list" => (json!({ "tools": tools::schemas() }), None),
        "tools/call" => (call_tool(state, binding_id, &id, &params), None),
        _ => {
            return (
                Some(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": { "code": -32601, "message": format!("unsupported method {method}") }
                })),
                None,
            );
        }
    };
    let (result, session) = result;
    (
        Some(json!({ "jsonrpc": "2.0", "id": id, "result": result })),
        session,
    )
}

fn serialize_id(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

fn call_tool(
    state: &Arc<AgentBrowserState>,
    binding_id: &str,
    id: &Value,
    params: &Value,
) -> Value {
    let request_key = serialize_id(id);
    let caller = params.pointer("/_meta/nocturne~1caller").cloned();
    let Some(caller) = caller else {
        return tool_error_result(
            ToolError::new("caller_required", "缺少调用者信息，不能确定会话与 actor"),
            &request_key,
        );
    };
    let session = caller
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let turn = caller.get("turnId").and_then(Value::as_str).unwrap_or("");
    let call = caller.get("callId").and_then(Value::as_str).unwrap_or("");
    if session.is_empty() || turn.is_empty() || call.is_empty() {
        return tool_error_result(
            ToolError::new("caller_required", "调用者信息不完整"),
            &request_key,
        );
    }
    let Some(root) = state.binding_root(binding_id) else {
        return tool_error_result(ToolError::new("forbidden", "绑定已撤销"), &request_key);
    };
    if !state.touch_actor(binding_id, session) {
        return tool_error_result(ToolError::new("forbidden", "绑定已撤销"), &request_key);
    }
    let caller_key = format!("{session}/{turn}/{call}");
    let op = match state.begin_call(binding_id, &request_key, &caller_key) {
        Ok(op) => op,
        Err(code) => {
            return tool_error_result(
                ToolError::new(code, "同一调用已经在途；不自动重放结果或副作用"),
                &request_key,
            );
        }
    };
    let name = params.get("name").and_then(Value::as_str).unwrap_or("");
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let started = Instant::now();
    let mut ctx = CallCtx {
        binding_id: binding_id.to_string(),
        root,
        actor: session.to_string(),
        op: Arc::clone(&op),
    };
    let outcome = tools::call(state, &mut ctx, name, &arguments);
    state.end_call(binding_id, &request_key);
    let elapsed = started.elapsed();
    let _ = elapsed;
    match outcome {
        Ok(outcome) => success_result(state, outcome),
        Err(error) => tool_error_result(error, &request_key),
    }
}

fn success_result(state: &Arc<AgentBrowserState>, outcome: ToolOutcome) -> Value {
    let mut content = vec![json!({ "type": "text", "text": outcome.text })];
    for image in outcome.images {
        content.push(json!({
            "type": "image",
            "data": image.data,
            "mimeType": image.mime_type
        }));
    }
    let _ = state;
    json!({
        "content": content,
        "structuredContent": outcome.structured,
        "isError": false
    })
}

fn tool_error_result(error: ToolError, request_key: &str) -> Value {
    let _ = request_key;
    let text = if error.hint.is_empty() {
        format!("{}: {}", error.code, error.message)
    } else {
        format!("{}: {}（{}）", error.code, error.message, error.hint)
    };
    json!({
        "content": [{ "type": "text", "text": text }],
        "structuredContent": { "outcome": "error", "errorCode": error.code },
        "isError": true
    })
}

fn rpc_error(id: Value, code: i64, message: &str) -> Response {
    Response::json(
        400,
        &json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_browser::testing::{MockPlatform, PNG_1X1_BASE64};
    use crate::agent_browser::AgentBrowserState;

    struct Client {
        port: u16,
        secret: String,
    }

    impl Client {
        fn start() -> (Arc<AgentBrowserState>, Arc<MockPlatform>, Client) {
            let platform = MockPlatform::new();
            let state = AgentBrowserState::new(platform.clone(), None);
            let port = state.start_server().unwrap();
            let secret = state.bootstrap_env().unwrap().1;
            let secret: Value = serde_json::from_str(&secret).unwrap();
            let secret = secret["secret"].as_str().unwrap().to_string();
            (state, platform, Client { port, secret })
        }

        fn raw(&self, bytes: &[u8]) -> (u16, Vec<u8>) {
            let mut stream = TcpStream::connect(("127.0.0.1", self.port)).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            stream.write_all(bytes).unwrap();
            let mut out = Vec::new();
            stream.read_to_end(&mut out).unwrap();
            let split = out
                .windows(4)
                .position(|w| w == b"\r\n\r\n")
                .expect("response head");
            let head = String::from_utf8_lossy(&out[..split]);
            let status = head
                .split_whitespace()
                .nth(1)
                .and_then(|s| s.parse().ok())
                .unwrap();
            (status, out[split + 4..].to_vec())
        }

        fn request(
            &self,
            method: &str,
            path: &str,
            headers: &[(&str, &str)],
            body: &[u8],
        ) -> (u16, Vec<u8>) {
            let mut text = format!(
                "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Length: {}\r\n",
                self.port,
                body.len()
            );
            for (name, value) in headers {
                text.push_str(&format!("{name}: {value}\r\n"));
            }
            text.push_str("\r\n");
            let mut bytes = text.into_bytes();
            bytes.extend_from_slice(body);
            self.raw(&bytes)
        }

        fn binding(&self, root: &str) -> (String, String) {
            let body = json!({ "rootSessionId": root }).to_string();
            let (status, out) = self.request(
                "POST",
                "/bindings",
                &[
                    ("Authorization", &format!("Bearer {}", self.secret)),
                    ("Content-Type", "application/json"),
                ],
                body.as_bytes(),
            );
            assert_eq!(status, 200, "{}", String::from_utf8_lossy(&out));
            let value: Value = serde_json::from_slice(&out).unwrap();
            (
                value["bindingId"].as_str().unwrap().to_string(),
                value["bearer"].as_str().unwrap().to_string(),
            )
        }

        fn rpc(
            &self,
            binding: &str,
            bearer: &str,
            session: Option<&str>,
            message: &Value,
        ) -> (u16, Value) {
            let mut headers: Vec<(&str, String)> = vec![
                ("Authorization", format!("Bearer {bearer}")),
                ("Content-Type", "application/json".to_string()),
            ];
            if let Some(session) = session {
                headers.push(("Mcp-Session-Id", session.to_string()));
            }
            let refs: Vec<(&str, &str)> = headers.iter().map(|(a, b)| (*a, b.as_str())).collect();
            let (status, out) = self.request(
                "POST",
                &format!("/mcp/{binding}"),
                &refs,
                message.to_string().as_bytes(),
            );
            let value = serde_json::from_slice(&out).unwrap_or(Value::Null);
            (status, value)
        }
    }

    #[test]
    fn base64_round_trips_bytes() {
        for bytes in [b"".as_slice(), b"a", b"ab", b"abc", &[0u8, 255, 128, 1]] {
            assert!(base64_round_trips(bytes));
        }
    }

    #[test]
    fn rejects_missing_and_wrong_tokens_hosts_and_origins() {
        let (_state, _platform, client) = Client::start();
        // 不带 token
        let (status, _) = client.request("POST", "/bindings", &[], b"{\"rootSessionId\":\"r\"}");
        assert_eq!(status, 403);
        // 错误 token
        let (status, _) = client.request(
            "POST",
            "/bindings",
            &[("Authorization", "Bearer wrong")],
            b"{\"rootSessionId\":\"r\"}",
        );
        assert_eq!(status, 403);
        // 恶意 Host（DNS rebinding 换入别名）
        let (status, _) = client
            .raw(b"POST /bindings HTTP/1.1\r\nHost: evil.test:1234\r\nContent-Length: 2\r\n\r\n{}");
        assert_eq!(status, 403);
        // 网页 Origin 被拒绝（网页 fetch 回环端口）
        let body = json!({ "rootSessionId": "r" }).to_string();
        let (status, _) = client.request(
            "POST",
            "/bindings",
            &[
                ("Authorization", &format!("Bearer {}", client.secret)),
                ("Origin", "https://evil.example"),
            ],
            body.as_bytes(),
        );
        assert_eq!(status, 403);
        // CORS 预检不提供
        let (status, _) = client.request("OPTIONS", "/bindings", &[], b"");
        assert_eq!(status, 405);
    }

    #[test]
    fn bootstrap_and_mcp_credentials_are_separate() {
        let (_state, _platform, client) = Client::start();
        let (binding, bearer) = client.binding("root-a");
        // 启动凭证不能调 MCP
        let (status, _) = client.request(
            "POST",
            &format!("/mcp/{binding}"),
            &[("Authorization", &format!("Bearer {}", client.secret))],
            b"{}",
        );
        assert_eq!(status, 403);
        // bearer 不能申请新绑定
        let (status, _) = client.request(
            "POST",
            "/bindings",
            &[("Authorization", &format!("Bearer {bearer}"))],
            b"{\"rootSessionId\":\"r\"}",
        );
        assert_eq!(status, 403);
    }

    #[test]
    fn body_limit_and_paths() {
        let (_state, _platform, client) = Client::start();
        let big = vec![b'a'; MAX_BODY + 1];
        let head = format!(
            "POST /bindings HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Length: {}\r\n\r\n",
            client.port,
            big.len()
        );
        let mut bytes = head.into_bytes();
        bytes.extend_from_slice(&big);
        let (status, _) = client.raw(&bytes);
        assert_eq!(status, 413);
        let (status, _) = client.request("GET", "/bindings", &[], b"");
        assert_eq!(status, 405);
        let (status, _) = client.request("GET", "/nope", &[], b"");
        assert_eq!(status, 404);
    }

    #[test]
    fn mcp_requires_session_after_initialize() {
        let (_state, _platform, client) = Client::start();
        let (binding, bearer) = client.binding("root-a");
        let (status, out) = client.rpc(
            &binding,
            &bearer,
            None,
            &json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }),
        );
        assert_eq!(status, 200);
        assert_eq!(out["error"]["code"], -32001);
        // GET 不启用 SSE
        let (status, _) = client.request(
            "GET",
            &format!("/mcp/{binding}"),
            &[("Authorization", &format!("Bearer {bearer}"))],
            b"",
        );
        assert_eq!(status, 405);
        // 撤销后旧 bearer 立即失效
        let _state = _state;
        _state.revoke_binding(&binding);
        let (status, _) = client.request(
            "POST",
            &format!("/mcp/{binding}"),
            &[("Authorization", &format!("Bearer {bearer}"))],
            b"{}",
        );
        assert_eq!(status, 403);
    }

    #[test]
    fn tools_list_has_the_first_version_surface() {
        let (_state, _platform, client) = Client::start();
        let (binding, bearer) = client.binding("root-a");
        let (status, out) = client.rpc(
            &binding,
            &bearer,
            None,
            &json!({
                "jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": { "protocolVersion": "2025-06-18", "capabilities": {} }
            }),
        );
        assert_eq!(status, 200);
        let session = out; // 响应体里没有 session；从 header 拿不到，这里直接查状态
        let _ = session;
        let sessions = _state.mcp_sessions_for_test(&binding);
        assert_eq!(sessions.len(), 1);
        let (status, out) = client.rpc(
            &binding,
            &bearer,
            Some(&sessions[0]),
            &json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
        );
        assert_eq!(status, 200);
        let tools = out["result"]["tools"].as_array().unwrap();
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        for expected in [
            "open",
            "navigate",
            "screenshot",
            "read",
            "click",
            "type",
            "press",
            "scroll",
            "wait",
            "back",
            "forward",
            "list_tabs",
            "close_tab",
        ] {
            assert!(names.contains(&expected), "{expected}");
        }
        // 不开放任意 JS
        assert!(!names.contains(&"evaluate"));
    }

    fn call(
        client: &Client,
        state: &Arc<AgentBrowserState>,
        binding: &str,
        bearer: &str,
        id: u64,
        name: &str,
        args: Value,
    ) -> Value {
        let sessions = state.mcp_sessions_for_test(binding);
        let session = sessions.last().unwrap().clone();
        let (status, out) = client.rpc(
            binding,
            bearer,
            Some(&session),
            &json!({
                "jsonrpc": "2.0", "id": id, "method": "tools/call",
                "params": {
                    "name": name,
                    "arguments": args,
                    "_meta": { "nocturne/caller": { "sessionId": "root-a", "turnId": "turn-1", "callId": format!("call-{id}") } }
                }
            }),
        );
        assert_eq!(status, 200);
        out
    }

    #[test]
    fn open_and_read_round_trip_through_http() {
        let (state, platform, client) = Client::start();
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
        let (binding, bearer) = client.binding("root-a");
        let _ = client.rpc(
            &binding,
            &bearer,
            None,
            &json!({
                "jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": { "protocolVersion": "2025-06-18", "capabilities": {} }
            }),
        );
        let out = call(
            &client,
            &state,
            &binding,
            &bearer,
            2,
            "open",
            json!({ "url": "https://example.test/" }),
        );
        assert_eq!(out["result"]["isError"], false, "{out}");
        let tab_id = out["result"]["structuredContent"]["tabId"]
            .as_str()
            .unwrap()
            .to_string();
        let out = call(
            &client,
            &state,
            &binding,
            &bearer,
            3,
            "read",
            json!({ "tabId": tab_id }),
        );
        assert_eq!(out["result"]["isError"], false, "{out}");
        assert!(
            out["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("[ref=e1]"),
            "{out}"
        );
        assert!(out["result"]["structuredContent"]["snapshotId"].is_string());
    }

    #[test]
    fn image_result_is_base64_and_errors_are_structured() {
        let (state, _platform, client) = Client::start();
        let (binding, bearer) = client.binding("root-a");
        let _ = client.rpc(
            &binding,
            &bearer,
            None,
            &json!({
                "jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": { "protocolVersion": "2025-06-18", "capabilities": {} }
            }),
        );
        let out = call(
            &client,
            &state,
            &binding,
            &bearer,
            2,
            "open",
            json!({ "url": "https://example.test/" }),
        );
        let tab_id = out["result"]["structuredContent"]["tabId"]
            .as_str()
            .unwrap()
            .to_string();
        let out = call(
            &client,
            &state,
            &binding,
            &bearer,
            3,
            "screenshot",
            json!({ "tabId": tab_id }),
        );
        assert_eq!(out["result"]["isError"], false, "{out}");
        let image = &out["result"]["content"][1];
        assert_eq!(image["type"], "image");
        assert_eq!(image["mimeType"], "image/png");
        assert_eq!(image["data"], PNG_1X1_BASE64);
        // 别的 actor 不能操作这个标签
        let sessions = state.mcp_sessions_for_test(&binding);
        let (_, out) = client.rpc(
            &binding,
            &bearer,
            Some(&sessions[0]),
            &json!({
                "jsonrpc": "2.0", "id": 9, "method": "tools/call",
                "params": {
                    "name": "read",
                    "arguments": { "tabId": tab_id },
                    "_meta": { "nocturne/caller": { "sessionId": "child-x", "turnId": "t", "callId": "c" } }
                }
            }),
        );
        assert_eq!(out["result"]["isError"], true);
        assert_eq!(
            out["result"]["structuredContent"]["errorCode"],
            "tab_not_owned"
        );
        // 没有调用者信息直接拒绝
        let (_, out) = client.rpc(
            &binding,
            &bearer,
            Some(&sessions[0]),
            &json!({
                "jsonrpc": "2.0", "id": 10, "method": "tools/call",
                "params": { "name": "list_tabs", "arguments": {} }
            }),
        );
        assert_eq!(
            out["result"]["structuredContent"]["errorCode"],
            "caller_required"
        );
    }

    #[test]
    fn cancellation_stops_waiting_and_late_actions() {
        let (state, _platform, client) = Client::start();
        let (binding, bearer) = client.binding("root-a");
        let _ = client.rpc(
            &binding,
            &bearer,
            None,
            &json!({
                "jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": { "protocolVersion": "2025-06-18", "capabilities": {} }
            }),
        );
        let out = call(
            &client,
            &state,
            &binding,
            &bearer,
            2,
            "open",
            json!({ "url": "https://example.test/" }),
        );
        let tab_id = out["result"]["structuredContent"]["tabId"]
            .as_str()
            .unwrap()
            .to_string();
        let sessions = state.mcp_sessions_for_test(&binding);
        let session = sessions[0].clone();
        // 起一个 5 秒的 wait，然后在另一条连接上取消
        let binding_thread = binding.clone();
        let bearer_thread = bearer.clone();
        let session_thread = session.clone();
        let port = client.port;
        let waiter = std::thread::spawn(move || {
            let client = Client {
                port,
                secret: String::new(),
            };
            let (status, out) = client.rpc(
                &binding_thread,
                &bearer_thread,
                Some(&session_thread),
                &json!({
                    "jsonrpc": "2.0", "id": 11, "method": "tools/call",
                    "params": {
                        "name": "wait",
                        "arguments": { "tabId": tab_id, "text": "never", "timeoutMs": 5000 },
                        "_meta": { "nocturne/caller": { "sessionId": "root-a", "turnId": "t", "callId": "c" } }
                    }
                }),
            );
            (status, out)
        });
        std::thread::sleep(Duration::from_millis(250));
        state.cancel_request(&binding, "11");
        let started = Instant::now();
        let (_status, out) = waiter.join().unwrap();
        assert!(started.elapsed() < Duration::from_secs(3));
        assert_eq!(
            out["result"]["structuredContent"]["errorCode"], "cancelled",
            "{out}"
        );
    }
}
