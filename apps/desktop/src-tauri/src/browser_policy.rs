//! 内置浏览器的规则（ADR-0060 第 5 节、修订（四））：导航白名单、webview 标签、数据目录、
//! 拦回主界面的快捷键。全是纯函数，单测覆盖；browser.rs 只负责把它们接到 webview 上。
//!
//! 导航白名单是第二道防线：第一道是 capability 只按 webview 标签匹配 `main`，浏览器
//! webview 的标签与之错开，任何命令都过不了 ACL。

use std::path::{Path, PathBuf};
use tauri::Url;

/// Tauri 自定义协议在 Windows 上映射成的地址（`http(s)://<scheme>.localhost`）：
/// 浏览器 webview 也注册了这些协议，能读到应用自己的资源，一律不让进。
const APP_HOSTS: &[&str] = &["tauri.localhost", "ipc.localhost", "asset.localhost"];

/// 应用内部用的协议：拦下时说「应用内部地址」，不说「外部程序」。
const INTERNAL_SCHEMES: &[&str] = &["tauri", "ipc", "asset"];

/// 浏览器自己认得、但不在白名单里的协议：拦下时说「不支持」，不说「外部程序」。
const BROWSER_SCHEMES: &[&str] = &[
    "javascript",
    "data",
    "blob",
    "about",
    "view-source",
    "chrome",
    "edge",
    "devtools",
    "filesystem",
    "ws",
    "wss",
];

/// 被拦下的原因；`reason()` 是发给前端的标识，前端据此显示提示。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Blocked {
    /// 解析不了的地址
    Invalid,
    /// 自定义协议（`vscode:`、`ms-settings:` …）：不交给系统打开
    External { scheme: String },
    /// 应用自己的地址（自定义协议、`devUrl`）
    Internal,
    /// 网页从 http(s) 跳到本地文件
    File,
    /// `javascript:`、`data:` 等白名单外的浏览器协议
    Unsupported { scheme: String },
}

impl Blocked {
    pub fn reason(&self) -> &'static str {
        match self {
            Self::Invalid => "invalid",
            Self::External { .. } => "external",
            Self::Internal => "internal",
            Self::File => "file",
            Self::Unsupported { .. } => "unsupported",
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::Invalid => "网址格式不对".into(),
            Self::External { scheme } => format!("已阻止打开外部程序（{scheme}:）"),
            Self::Internal => "不能打开应用内部地址".into(),
            Self::File => "网页不能跳转到本地文件".into(),
            Self::Unsupported { scheme } => format!("不支持 {scheme}: 地址"),
        }
    }
}

/// 同一个源（协议、主机、端口）；localhost、127.0.0.1、[::1] 视为同一主机。
fn same_origin(a: &Url, b: &Url) -> bool {
    let host = |url: &Url| match url.host_str() {
        Some("127.0.0.1" | "[::1]" | "localhost") => Some("localhost".to_string()),
        other => other.map(str::to_ascii_lowercase),
    };
    a.scheme() == b.scheme()
        && host(a) == host(b)
        && a.port_or_known_default() == b.port_or_known_default()
}

/// 地址本身是否在白名单里：http、https、file、about:blank；应用自己的地址除外。
/// 不看来源，「网页从 http(s) 跳到 file」由 [`allow_navigation`] 判断。
pub fn check_target(url: &Url, dev_url: Option<&Url>) -> Result<(), Blocked> {
    let scheme = url.scheme().to_ascii_lowercase();
    match scheme.as_str() {
        "http" | "https" => {
            let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
            if APP_HOSTS.contains(&host.as_str())
                || dev_url.is_some_and(|dev| same_origin(url, dev))
            {
                Err(Blocked::Internal)
            } else {
                Ok(())
            }
        }
        "file" => Ok(()),
        "about" if url.as_str() == "about:blank" => Ok(()),
        _ if INTERNAL_SCHEMES.contains(&scheme.as_str()) => Err(Blocked::Internal),
        _ if BROWSER_SCHEMES.contains(&scheme.as_str()) => Err(Blocked::Unsupported { scheme }),
        _ => Err(Blocked::External { scheme }),
    }
}

/// 我们自己发起的打开（地址栏、外壳导航命令、引用左键、新窗口请求）：解析并过白名单。
/// `file:` 在这里放行，因为是用户主动打开的。
pub fn parse_user_url(input: &str, dev_url: Option<&Url>) -> Result<Url, Blocked> {
    let url = Url::parse(input.trim()).map_err(|_| Blocked::Invalid)?;
    check_target(&url, dev_url)?;
    Ok(url)
}

/// 同一个地址；本地文件按路径比较（Windows 不分大小写）。
pub fn same_target(a: &Url, b: &Url) -> bool {
    match (a.to_file_path(), b.to_file_path()) {
        (Ok(a), Ok(b)) => a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase(),
        _ => a == b,
    }
}

/// 离开当前文档的导航（含重定向）：白名单之外，`file:` 只允许
/// - 用户自己要打开的那个文件（`user_target`），或
/// - 当前文档本来就是本地文件 / 空白页（本地 HTML 之间互相链接）。
///
/// 网页从 http(s) 跳到 `file:`（链接、脚本、重定向）一律拦下。
pub fn allow_navigation(
    target: &Url,
    current: Option<&Url>,
    user_target: Option<&Url>,
    dev_url: Option<&Url>,
) -> Result<(), Blocked> {
    check_target(target, dev_url)?;
    if target.scheme() != "file" {
        return Ok(());
    }
    if user_target.is_some_and(|user| user.scheme() == "file" && same_target(user, target)) {
        return Ok(());
    }
    match current.map(Url::scheme) {
        None | Some("file") | Some("about") => Ok(()),
        Some(_) => Err(Blocked::File),
    }
}

/// 浏览器 webview 的标签。capability 只认 `main`（修订（四）），这里的格式与之彻底错开。
pub fn browser_label(id: u32) -> String {
    format!("nct-browser-{id}")
}

/// 浏览器的 cookie 和存储目录：应用本地数据下的 `browser`（WebView2 在里面建
/// `EBWebView`）。主界面用 Tauri 默认的 `<应用本地数据>/EBWebView`，两者分开；
/// 退出不清空，登录过的网站下次还在。
///
/// 启动时设了 `WEBVIEW2_USER_DATA_FOLDER`（测试、开发时的隔离）：主界面改用这个目录
/// （[`take_user_data_override`]），浏览器跟着放到它下面的 `browser`，仍与主界面分开，
/// 也不写进应用本地数据。
pub fn browser_data_dir(app_local_data: &Path, user_data_override: Option<&Path>) -> PathBuf {
    user_data_override.unwrap_or(app_local_data).join("browser")
}

/// `WEBVIEW2_USER_DATA_FOLDER` 由 WebView2 加载器在每次创建环境时读取，并直接替换传入的
/// 数据目录（WebView2 文档 CreateCoreWebView2EnvironmentWithOptions：「use the
/// browserExecutableFolder and userDataFolder values as replacements」）。留着它，浏览器
/// 和主界面就会共用一个目录。启动时读出来、从进程环境里删掉，主界面显式用它。
/// 空值视为没设。
pub fn user_data_override(value: Option<std::ffi::OsString>) -> Option<PathBuf> {
    value.filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// 读出并删掉 `WEBVIEW2_USER_DATA_FOLDER`。只能在启动、还没有别的线程时调用。
pub fn take_user_data_override() -> Option<PathBuf> {
    const KEY: &str = "WEBVIEW2_USER_DATA_FOLDER";
    let value = user_data_override(std::env::var_os(KEY));
    if value.is_some() {
        std::env::remove_var(KEY);
    }
    value
}

/// 下载结果提示（发给前端的 `Download` 消息）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DownloadReport {
    Finished(String),
    Failed(String),
}

/// 取消的下载最多记这么多条，防止一直没有结束事件时越积越多。
const MAX_CANCELLED: usize = 16;

/// 下载登记：外壳只拿得到地址，同一个地址可能同时有几次下载。
///
/// - 选好保存位置的按地址排队登记，结束事件按先来先到配对；成功时用 WebView2 给的
///   路径取文件名，失败时 WebView2 不给路径，用登记时选的文件名；
/// - 在另存为里取消时 WebView2 也会报一次失败的结束：取消时记下地址，这次失败的结束
///   只消掉这条记录，不提示，也不去配对同地址正在进行的下载；
/// - 没登记过的结束不提示。
#[derive(Debug, Default)]
pub struct Downloads {
    started: Vec<(String, String)>,
    cancelled: Vec<String>,
}

impl Downloads {
    /// 选好了保存位置，开始下载。
    pub fn chosen(&mut self, url: &str, name: String) {
        self.started.push((url.to_string(), name));
    }

    /// 在另存为里取消了。
    pub fn cancelled(&mut self, url: &str) {
        if self.cancelled.len() >= MAX_CANCELLED {
            self.cancelled.remove(0);
        }
        self.cancelled.push(url.to_string());
    }

    /// 下载结束；返回要提示的结果。`file_name` 是 WebView2 给的保存路径里的文件名。
    pub fn finished(
        &mut self,
        url: &str,
        file_name: Option<String>,
        success: bool,
    ) -> Option<DownloadReport> {
        if !success {
            if let Some(index) = self.cancelled.iter().position(|u| u == url) {
                self.cancelled.remove(index);
                return None;
            }
        }
        let index = self.started.iter().position(|(u, _)| u == url)?;
        let (_, chosen) = self.started.remove(index);
        let name = file_name.unwrap_or(chosen);
        Some(if success {
            DownloadReport::Finished(name)
        } else {
            DownloadReport::Failed(name)
        })
    }
}

const VK_B: u32 = 0x42;
const VK_P: u32 = 0x50;
const VK_T: u32 = 0x54;
const VK_OEM_3: u32 = 0xC0;

/// 焦点在网页里时拦回主界面的快捷键（修订（四）实现说明）：Ctrl+B / Ctrl+T / Ctrl+P /
/// Ctrl+`。Ctrl+C、Ctrl+V、Ctrl+F 等编辑键留给网页；Esc 也留给网页（区分不了网页
/// 是否处理过它）。返回值与前端 PanelHost 的快捷键名一致。
pub fn app_shortcut(virtual_key: u32, ctrl: bool, shift: bool, alt: bool) -> Option<&'static str> {
    if !ctrl || shift || alt {
        return None;
    }
    match virtual_key {
        VK_B => Some("b"),
        VK_T => Some("t"),
        VK_P => Some("p"),
        VK_OEM_3 => Some("backquote"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    fn dev() -> Url {
        url("http://localhost:31420")
    }

    #[test]
    fn whitelist_allows_web_file_and_blank() {
        for ok in [
            "https://developer.mozilla.org/en-US/",
            "http://example.com/",
            "http://localhost:5173/",
            "file:///Z:/nocturne-mockups/side-panel-mockup.html",
            "about:blank",
        ] {
            assert_eq!(
                parse_user_url(ok, Some(&dev())).map(|u| u.to_string()),
                Ok(url(ok).to_string()),
                "{ok}"
            );
        }
    }

    #[test]
    fn user_urls_reject_javascript_and_other_schemes() {
        assert_eq!(
            parse_user_url("javascript:alert(1)", None),
            Err(Blocked::Unsupported {
                scheme: "javascript".into()
            })
        );
        assert_eq!(
            parse_user_url("data:text/html,<b>x</b>", None),
            Err(Blocked::Unsupported {
                scheme: "data".into()
            })
        );
        assert_eq!(
            parse_user_url("about:srcdoc", None),
            Err(Blocked::Unsupported {
                scheme: "about".into()
            })
        );
        assert_eq!(parse_user_url("not a url", None), Err(Blocked::Invalid));
    }

    #[test]
    fn custom_protocols_are_external_and_not_launched() {
        for (input, scheme) in [
            ("vscode://file/z:/x", "vscode"),
            ("ms-settings:display", "ms-settings"),
            ("mailto:a@example.com", "mailto"),
        ] {
            let blocked = parse_user_url(input, None).unwrap_err();
            assert_eq!(
                blocked,
                Blocked::External {
                    scheme: scheme.into()
                }
            );
            assert_eq!(blocked.reason(), "external");
        }
    }

    #[test]
    fn app_addresses_are_internal() {
        for input in [
            "http://tauri.localhost/index.html",
            "https://tauri.localhost/",
            "http://ipc.localhost/plugin%3Aapp%7Cversion",
            "http://asset.localhost/x",
            "tauri://localhost/",
            "ipc://localhost/x",
            "http://localhost:31420/",
            "http://127.0.0.1:31420/src/main.tsx",
        ] {
            assert_eq!(
                parse_user_url(input, Some(&dev())),
                Err(Blocked::Internal),
                "{input}"
            );
        }
        // 没有 devUrl（正式包）时，localhost:31420 只是普通本机地址
        assert!(parse_user_url("http://localhost:31420/", None).is_ok());
        // 别的端口照常
        assert!(parse_user_url("http://localhost:3000/", Some(&dev())).is_ok());
    }

    #[test]
    fn page_cannot_jump_from_web_to_file() {
        let file = url("file:///C:/Users/me/secret.html");
        let web = url("https://example.com/");
        assert_eq!(
            allow_navigation(&file, Some(&web), None, None),
            Err(Blocked::File)
        );
        // 重定向同样走这里：用户要的是网页，跳成了文件
        assert_eq!(
            allow_navigation(&file, Some(&web), Some(&web), None),
            Err(Blocked::File)
        );
        // 网页之间照常
        assert!(allow_navigation(&url("https://example.org/"), Some(&web), None, None).is_ok());
    }

    #[test]
    fn user_opened_file_and_local_links_are_allowed() {
        let file = url("file:///Z:/proj/index.html");
        let web = url("https://example.com/");
        // 用户在网页标签里输入本地路径：放行，路径不分大小写
        assert!(allow_navigation(
            &file,
            Some(&web),
            Some(&url("file:///z:/PROJ/index.html")),
            None
        )
        .is_ok());
        // 本地 HTML 之间互相链接
        let other = url("file:///Z:/proj/about.html");
        assert!(allow_navigation(&other, Some(&file), None, None).is_ok());
        // 新建的 webview 先是空白页
        assert!(allow_navigation(&file, Some(&url("about:blank")), None, None).is_ok());
        assert!(allow_navigation(&file, None, None, None).is_ok());
        // 本地页面也不能去应用地址
        assert_eq!(
            allow_navigation(&url("http://tauri.localhost/"), Some(&file), None, None),
            Err(Blocked::Internal)
        );
    }

    #[test]
    fn labels_never_match_the_main_webview() {
        for id in [0, 1, 42, u32::MAX] {
            let label = browser_label(id);
            assert_ne!(label, "main");
            assert!(!label.starts_with("main"));
            // Tauri 标签只能含字母数字和 - / : _
            assert!(label
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-/:_".contains(c)));
        }
        assert_ne!(browser_label(1), browser_label(2));
    }

    #[test]
    fn data_directory_is_separate_from_main() {
        let base = Path::new(r"C:\Users\me\AppData\Local\io.github.kanzaki-chiya.nocturne");
        let dir = browser_data_dir(base, None);
        assert!(dir.starts_with(base));
        // 主界面的 WebView2 数据在 <base>/EBWebView
        assert!(!dir.starts_with(base.join("EBWebView")));
        assert_ne!(dir, base);

        // 设了 WEBVIEW2_USER_DATA_FOLDER：主界面用 <它>/EBWebView，浏览器在 <它>/browser，
        // 不写进应用本地数据
        let over = Path::new(r"Z:\sp-work\webview3");
        let dir = browser_data_dir(base, Some(over));
        assert_eq!(dir, over.join("browser"));
        assert!(!dir.starts_with(over.join("EBWebView")));
        assert!(!dir.starts_with(base));
    }

    #[test]
    fn empty_user_data_override_is_ignored() {
        assert_eq!(user_data_override(None), None);
        assert_eq!(user_data_override(Some("".into())), None);
        assert_eq!(
            user_data_override(Some(r"Z:\sp-work\webview3".into())),
            Some(PathBuf::from(r"Z:\sp-work\webview3"))
        );
    }

    #[test]
    fn shortcuts_forwarded_to_the_app() {
        assert_eq!(app_shortcut(0x42, true, false, false), Some("b"));
        assert_eq!(app_shortcut(0x54, true, false, false), Some("t"));
        assert_eq!(app_shortcut(0x50, true, false, false), Some("p"));
        assert_eq!(app_shortcut(0xC0, true, false, false), Some("backquote"));
        // 编辑键留给网页
        for key in [0x43, 0x56, 0x46, 0x58, 0x5A, 0x41] {
            assert_eq!(app_shortcut(key, true, false, false), None);
        }
        // Esc、不带 Ctrl、带 Shift / Alt 都不拦
        assert_eq!(app_shortcut(0x1B, false, false, false), None);
        assert_eq!(app_shortcut(0x42, false, false, false), None);
        assert_eq!(app_shortcut(0x42, true, true, false), None);
        assert_eq!(app_shortcut(0x50, true, false, true), None);
    }

    #[test]
    fn capabilities_match_webviews_only() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
        let mut count = 0;
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            count += 1;
            let text = std::fs::read_to_string(&path).unwrap();
            let json: serde_json::Value = serde_json::from_str(&text).unwrap();
            assert!(
                json.get("windows").is_none(),
                "{} 不得按窗口匹配",
                path.display()
            );
            let webviews = json["webviews"].as_array().expect("必须写 webviews");
            assert!(!webviews.is_empty());
            for label in webviews {
                let label = label.as_str().unwrap();
                assert!(!label.contains('*'), "{} 不得用通配符", path.display());
                assert!(
                    !label.starts_with("nct-browser"),
                    "{} 不得授权给浏览器",
                    path.display()
                );
            }
            // 也不给远程来源授权
            assert!(
                json.get("remote").is_none(),
                "{} 不得授权远程来源",
                path.display()
            );
        }
        assert!(count > 0);
    }

    #[test]
    fn downloads_report_every_saved_download_once() {
        let mut d = Downloads::default();
        let url = "http://127.0.0.1:31791/dl.txt";
        d.chosen(url, "dl-test.txt".into());
        assert_eq!(
            d.finished(url, Some("dl-test.txt".into()), true),
            Some(DownloadReport::Finished("dl-test.txt".into()))
        );
        // 同一个地址再存一次，照样提示
        d.chosen(url, "dl-test2.txt".into());
        assert_eq!(
            d.finished(url, Some("dl-test2.txt".into()), true),
            Some(DownloadReport::Finished("dl-test2.txt".into()))
        );
        // 没登记过的结束不提示
        assert_eq!(d.finished(url, None, true), None);
    }

    #[test]
    fn downloads_failure_uses_the_chosen_name() {
        let mut d = Downloads::default();
        d.chosen("https://example.com/a.zip", "a (1).zip".into());
        assert_eq!(
            d.finished("https://example.com/a.zip", None, false),
            Some(DownloadReport::Failed("a (1).zip".into()))
        );
    }

    #[test]
    fn downloads_cancel_does_not_steal_a_running_download() {
        let mut d = Downloads::default();
        let url = "https://example.com/big.iso";
        // 第一次存下了，还在下载；第二次在另存为里取消
        d.chosen(url, "big.iso".into());
        d.cancelled(url);
        // 取消那次报的失败结束：不提示，也不消掉第一次的登记
        assert_eq!(d.finished(url, None, false), None);
        assert_eq!(
            d.finished(url, Some("big.iso".into()), true),
            Some(DownloadReport::Finished("big.iso".into()))
        );
    }

    #[test]
    fn downloads_same_url_twice_pair_in_order() {
        let mut d = Downloads::default();
        let url = "https://example.com/r.txt";
        d.chosen(url, "r1.txt".into());
        d.chosen(url, "r2.txt".into());
        assert_eq!(
            d.finished(url, None, false),
            Some(DownloadReport::Failed("r1.txt".into()))
        );
        assert_eq!(
            d.finished(url, Some("r2.txt".into()), true),
            Some(DownloadReport::Finished("r2.txt".into()))
        );
        assert_eq!(d.finished(url, None, true), None);
    }

    #[test]
    fn downloads_cancelled_list_is_bounded() {
        let mut d = Downloads::default();
        for _ in 0..100 {
            d.cancelled("https://example.com/x");
        }
        assert!(d.cancelled.len() <= MAX_CANCELLED);
    }
}
