//! 回复内嵌页面（ADR-0088）的隔离空壳协议与子框架 IPC 封锁。
//!
//! 1. `nct-sandbox` 自定义协议只返回静态空壳页 `/sandbox.html`，响应头带独立严格的
//!    Content-Security-Policy（禁止任何网络请求，只允许内联脚本/样式与 `data:`/`blob:` 媒体资源，
//!    并带 `sandbox allow-scripts` 与受限的 `frame-ancestors`）。其余路径或方法一律返回 404。
//! 2. Windows WebView2 与 Android WebView 的底层初始化脚本机制不区分主框架与子框架，会把
//!    `window.__TAURI_INTERNALS__` 与 `window.ipc` 注入所有子框架，且 Tauri 把用户注册的自定义
//!    协议视为本地源。通过 `Builder::invoke_system` 将持有 `__INVOKE_KEY__` 的桥接脚本限制在
//!    `window === window.top` 执行：子框架拿不到调用密钥，`invoke` 立即失败，伪造底层
//!    `window.ipc.postMessage` 也会在 Rust 侧因密钥不匹配被直接丢弃。

use tauri::http::{header, Method, Request, Response, StatusCode};

pub const SANDBOX_SCHEME: &str = "nct-sandbox";

const SANDBOX_HTML: &str = include_str!("../../public-web/sandbox.html");

#[cfg(debug_assertions)]
const FRAME_ANCESTORS: &str =
    "frame-ancestors http://tauri.localhost tauri://localhost http://localhost:31420";

#[cfg(not(debug_assertions))]
const FRAME_ANCESTORS: &str = "frame-ancestors http://tauri.localhost tauri://localhost";

pub fn sandbox_csp() -> String {
    format!(
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; {FRAME_ANCESTORS}; sandbox allow-scripts"
    )
}

pub fn handle_request(request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let method = request.method();
    let uri = request.uri();
    if (method != Method::GET && method != Method::HEAD)
        || uri.path() != "/sandbox.html"
        || uri.query().is_some()
    {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
            .header(header::CACHE_CONTROL, "no-store")
            .header("X-Content-Type-Options", "nosniff")
            .body(Vec::new())
            .expect("static 404 response headers are valid");
    }

    let body = if method == Method::HEAD {
        Vec::new()
    } else {
        SANDBOX_HTML.as_bytes().to_vec()
    };

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CONTENT_SECURITY_POLICY, sandbox_csp())
        .header(header::CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .body(body)
        .expect("static sandbox response headers are valid")
}

const PROCESS_IPC_MESSAGE_FN: &str = r#"(function (message) {
  if (
    message instanceof ArrayBuffer
    || ArrayBuffer.isView(message)
    || Array.isArray(message)
  ) {
    return {
      contentType: 'application/octet-stream',
      data: message
    };
  } else {
    const data = JSON.stringify(message, (_k, val) => {
      const SERIALIZE_TO_IPC_FN = '__TAURI_TO_IPC_KEY__';
      if (val instanceof Map) {
        return Object.fromEntries(val.entries());
      } else if (val instanceof Uint8Array) {
        return Array.from(val);
      } else if (val instanceof ArrayBuffer) {
        return Array.from(new Uint8Array(val));
      } else if (
        typeof val === 'object'
        && val !== null
        && SERIALIZE_TO_IPC_FN in val
      ) {
        return val[SERIALIZE_TO_IPC_FN]();
      } else {
        return val;
      }
    });
    return {
      contentType: 'application/json',
      data
    };
  }
})"#;

const FETCH_CHANNEL_DATA_COMMAND: &str = "plugin:__TAURI_CHANNEL__|fetch";

/// 仅供 `Builder::invoke_system` 使用：只在 `window === window.top` 绑定 `__INVOKE_KEY__`，
/// 子框架（含沙箱 iframe 及其内部动态创建的任意子 iframe）拿不到密钥且调用立即被拒。
pub fn main_frame_only_invoke_script() -> String {
    let os_name = std::env::consts::OS;
    let process_ipc = PROCESS_IPC_MESSAGE_FN;
    let fetch_channel_cmd = FETCH_CHANNEL_DATA_COMMAND;
    format!(
        r#"(function () {{
  if (window !== window.top) {{
    if (window.__TAURI_INTERNALS__) {{
      Object.defineProperty(window.__TAURI_INTERNALS__, 'postMessage', {{
        value: function (message) {{
          if (message && typeof message.error === 'number' && window.__TAURI_INTERNALS__.runCallback) {{
            Promise.resolve().then(function () {{
              window.__TAURI_INTERNALS__.runCallback(message.error, 'Tauri IPC is disabled in subframes');
            }});
          }}
        }}
      }});
    }}
    return;
  }}
  const __TAURI_INVOKE_KEY__ = __INVOKE_KEY__;
  const processIpcMessage = {process_ipc};
  const osName = {os_name:?};
  const fetchChannelDataCommand = {fetch_channel_cmd:?};
  let customProtocolIpcFailed = false;
  const canUseCustomProtocol = osName !== 'android';

  function sendIpcMessage(message) {{
    const {{ cmd, callback, error, payload, options }} = message;
    if (!customProtocolIpcFailed && (canUseCustomProtocol || cmd === fetchChannelDataCommand)) {{
      const {{ contentType, data }} = processIpcMessage(payload);
      const headers = new Headers((options && options.headers) || {{}});
      headers.set('Content-Type', contentType);
      headers.set('Tauri-Callback', callback);
      headers.set('Tauri-Error', error);
      headers.set('Tauri-Invoke-Key', __TAURI_INVOKE_KEY__);
      fetch(window.__TAURI_INTERNALS__.convertFileSrc(cmd, 'ipc'), {{
        method: 'POST',
        body: data,
        headers
      }})
        .then((response) => {{
          const callbackId = response.headers.get('Tauri-Response') === 'ok' ? callback : error;
          switch ((response.headers.get('content-type') || '').split(',')[0]) {{
            case 'application/json':
              return response.json().then((r) => [callbackId, r]);
            case 'text/plain':
              return response.text().then((r) => [callbackId, r]);
            default:
              return response.arrayBuffer().then((r) => [callbackId, r]);
          }}
        }})
        .then(
          ([callbackId, data]) => {{
            window.__TAURI_INTERNALS__.runCallback(callbackId, data);
          }},
          () => {{
            customProtocolIpcFailed = true;
            sendIpcMessage(message);
          }}
        );
    }} else {{
      const {{ data }} = processIpcMessage({{
        cmd,
        callback,
        error,
        options: {{
          ...options,
          customProtocolIpcBlocked: customProtocolIpcFailed
        }},
        payload,
        __TAURI_INVOKE_KEY__
      }});
      window.ipc.postMessage(data);
    }}
  }}

  Object.defineProperty(window.__TAURI_INTERNALS__, 'postMessage', {{
    value: sendIpcMessage
  }});
}})();"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build_req(method: Method, uri: &str) -> Request<Vec<u8>> {
        Request::builder()
            .method(method)
            .uri(uri)
            .body(Vec::new())
            .unwrap()
    }

    #[test]
    fn serves_sandbox_html_with_strict_csp_on_exact_path() {
        let res = handle_request(&build_req(
            Method::GET,
            "http://nct-sandbox.localhost/sandbox.html",
        ));
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            res.headers().get(header::CONTENT_TYPE).unwrap(),
            "text/html; charset=utf-8"
        );
        let csp = res
            .headers()
            .get(header::CONTENT_SECURITY_POLICY)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(csp.contains("default-src 'none'"));
        assert!(csp.contains("script-src 'unsafe-inline'"));
        assert!(csp.contains("style-src 'unsafe-inline'"));
        assert!(csp.contains("img-src data: blob:"));
        assert!(csp.contains("font-src data:"));
        assert!(csp.contains("media-src data: blob:"));
        assert!(csp.contains("frame-ancestors http://tauri.localhost tauri://localhost"));
        assert!(csp.contains("sandbox allow-scripts"));
        assert!(!csp.contains("allow-same-origin"));
        assert!(String::from_utf8_lossy(res.body()).contains("nocturne:inline-html:ready"));
    }

    #[test]
    fn rejects_other_paths_queries_and_methods_with_404() {
        for (method, uri) in [
            (Method::GET, "http://nct-sandbox.localhost/"),
            (Method::GET, "http://nct-sandbox.localhost/index.html"),
            (Method::GET, "http://nct-sandbox.localhost/sandbox.html?x=1"),
            (Method::GET, "http://nct-sandbox.localhost/../sandbox.html"),
            (Method::POST, "http://nct-sandbox.localhost/sandbox.html"),
        ] {
            let res = handle_request(&build_req(method, uri));
            assert_eq!(res.status(), StatusCode::NOT_FOUND, "uri={uri}");
            assert!(res.body().is_empty(), "uri={uri}");
        }
    }

    #[test]
    fn invoke_script_contains_placeholder_and_top_frame_guard() {
        let script = main_frame_only_invoke_script();
        assert!(script.contains("__INVOKE_KEY__"));
        assert!(script.contains("window !== window.top"));
        assert!(script.contains("Tauri IPC is disabled in subframes"));
    }

    #[test]
    fn tauri_version_is_the_reviewed_one() {
        let lock = include_str!("../Cargo.lock");
        assert!(
            lock.contains("name = \"tauri\"\nversion = \"2.12.0\""),
            "tauri upgraded; re-verify sandbox::main_frame_only_invoke_script against tauri's ipc-protocol.js"
        );
    }
}
