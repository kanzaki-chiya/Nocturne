mod background;

use tauri::{Url, WebviewUrl, WebviewWindowBuilder};

/// App 页面随 APK 打包，Tauri 2 安卓上由自定义协议以固定源提供（ADR-0059）。
/// 中继的 WebSocket 入口按这个源放行手机入口，见 docs/protocols/relay.md「Origin 允许表」。
const APP_HOST: &str = "tauri.localhost";

/// WebView 只能停在随包的页面上，不导航到中继或任何外部页面。
/// 调试构建额外允许 `tauri android dev` 的开发服务器。
fn navigation_allowed(url: &Url, dev: Option<&Url>) -> bool {
    if url.scheme() == "about" && url.as_str() == "about:blank" {
        return true;
    }
    if url.scheme() == "http" && url.host_str() == Some(APP_HOST) && url.port().is_none() {
        return true;
    }
    cfg!(debug_assertions) && dev.is_some_and(|dev| url.origin() == dev.origin())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(background::plugin())
        .setup(|app| {
            let dev = app.config().build.dev_url.clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .on_navigation(move |url| navigation_allowed(url, dev.as_ref()))
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Nocturne");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    #[test]
    fn app_pages_are_allowed() {
        assert!(navigation_allowed(&url("http://tauri.localhost/"), None));
        assert!(navigation_allowed(&url("http://tauri.localhost/index.html#x"), None));
        assert!(navigation_allowed(&url("about:blank"), None));
    }

    #[test]
    fn external_pages_are_blocked() {
        for blocked in [
            "https://tauri.localhost/",
            "http://tauri.localhost:8787/",
            "http://tauri.localhost.evil.example/",
            "https://relay.example/",
            "http://127.0.0.1:8787/",
            "file:///data/data/x/index.html",
            "javascript:alert(1)",
        ] {
            assert!(!navigation_allowed(&url(blocked), None), "{blocked}");
        }
    }

    #[test]
    fn dev_server_only_in_debug_builds() {
        let dev = url("http://192.168.1.5:31421");
        assert_eq!(
            navigation_allowed(&url("http://192.168.1.5:31421/"), Some(&dev)),
            cfg!(debug_assertions)
        );
        assert!(!navigation_allowed(&url("http://192.168.1.6:31421/"), Some(&dev)));
    }
}
