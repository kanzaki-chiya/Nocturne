//! 回复内嵌页面（ADR-0088）的安卓端隔离空壳协议与子框架 IPC 封锁。
//!
//! 与桌面端 `sandbox.rs` 对称：
//! 1. `nct-sandbox` 协议仅对精确的 `GET`/`HEAD` `/sandbox.html` 返回静态空壳页及独立严格 CSP，
//!    其余路径、带查询串或非只读方法一律返回 404。
//! 2. Android WebView 的 `addDocumentStartJavaScript(..., setOf("*"))` 与 `@JavascriptInterface`
//!    (`window.ipc`) 对所有子框架均可见，且 `Ipc.kt` 上报给 Rust 的 URL 为主框架 `currentUrl`。
//!    通过 `Builder::invoke_system` 仅在 `window === window.top` 绑定 `__INVOKE_KEY__`，子框架
//!    既无法经 `invoke` 发起调用，直接调用 `window.ipc.postMessage` 也会因缺少正确密钥在 Rust
//!    `Webview::on_message` 入口被直接丢弃。

use tauri::http::{header, Method, Request, Response, StatusCode};

pub const SANDBOX_SCHEME: &str = "nct-sandbox";
pub const SANDBOX_HOST: &str = "nct-sandbox.localhost";

const SANDBOX_HTML: &str = include_str!("../../../desktop/public-web/sandbox.html");

#[cfg(debug_assertions)]
const FRAME_ANCESTORS: &str = "frame-ancestors http://tauri.localhost http://localhost:31421";

#[cfg(not(debug_assertions))]
const FRAME_ANCESTORS: &str = "frame-ancestors http://tauri.localhost";

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
        assert!(csp.contains("frame-ancestors http://tauri.localhost"));
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
