//! 去掉插件的初始化脚本：Tauri 把插件的初始化脚本无条件注入每一个 webview，包括面板
//! 浏览器里的第三方网页（ADR-0060 第 5 节）。
//!
//! tauri-plugin-dialog 2.8.0 的脚本把 `window.alert` 改成调 `plugin:dialog|message`、
//! `window.confirm` 改成调 `plugin:dialog|confirm` 的 async 函数。在浏览器 webview 里
//! 调用被 ACL 拒绝，alert 不弹框；confirm 返回的 Promise 恒为真，网页拿到的就是「是」。
//! 主界面里同样有害：插件根本没有注册 confirm 命令，主界面的 confirm 也恒为「是」。去掉脚本后，两边都回到 WebView2
//! 自带的脚本对话框（标题写明来源网站，网页冒充不了应用）。插件的命令照常可用。

use tauri::plugin::Plugin;
use tauri::{AppHandle, RunEvent, Runtime, Url, Webview, Window};

/// 包一层插件：除初始化脚本外原样转发。
pub struct WithoutScript<P>(pub P);

impl<R: Runtime, P: Plugin<R>> Plugin<R> for WithoutScript<P> {
    fn name(&self) -> &'static str {
        self.0.name()
    }

    fn initialize(
        &mut self,
        app: &AppHandle<R>,
        config: serde_json::Value,
    ) -> Result<(), Box<dyn std::error::Error>> {
        self.0.initialize(app, config)
    }

    /// `initialization_script_2` 的缺省实现也从这里取，同样为空。
    fn initialization_script(&self) -> Option<String> {
        None
    }

    fn window_created(&mut self, window: Window<R>) {
        self.0.window_created(window);
    }

    fn webview_created(&mut self, webview: Webview<R>) {
        self.0.webview_created(webview);
    }

    fn on_navigation(&mut self, webview: &Webview<R>, url: &Url) -> bool {
        self.0.on_navigation(webview, url)
    }

    fn on_page_load(
        &mut self,
        webview: &Webview<R>,
        payload: &tauri::webview::PageLoadPayload<'_>,
    ) {
        self.0.on_page_load(webview, payload);
    }

    fn on_event(&mut self, app: &AppHandle<R>, event: &RunEvent) {
        self.0.on_event(app, event);
    }

    fn extend_api(&mut self, invoke: tauri::ipc::Invoke<R>) -> bool {
        self.0.extend_api(invoke)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 带脚本的插件。不直接拿 tauri_plugin_dialog::init() 测：它会把 comctl32 v6 的
    /// TaskDialogIndirect 链进测试程序，没有清单的测试程序启动即失败。
    struct Scripted;

    impl<R: Runtime> Plugin<R> for Scripted {
        fn name(&self) -> &'static str {
            "dialog"
        }
        fn initialization_script(&self) -> Option<String> {
            Some("window.alert = () => {}".into())
        }
    }

    #[test]
    fn wrapped_plugin_has_no_script() {
        assert!(Plugin::<tauri::Wry>::initialization_script(&Scripted).is_some());
        let wrapped = WithoutScript(Scripted);
        assert_eq!(Plugin::<tauri::Wry>::name(&wrapped), "dialog");
        assert!(Plugin::<tauri::Wry>::initialization_script(&wrapped).is_none());
        assert!(Plugin::<tauri::Wry>::initialization_script_2(&wrapped).is_none());
    }

    /// 2.8.0 的脚本改写 alert / confirm（见文件头）；插件升级时提醒复核新脚本。
    #[test]
    fn dialog_plugin_version_is_the_reviewed_one() {
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let lock = std::fs::read_to_string(manifest.join("Cargo.lock")).unwrap();
        assert!(
            lock.contains("name = \"tauri-plugin-dialog\"\nversion = \"2.8.0\""),
            "tauri-plugin-dialog 升级了：复核它的初始化脚本和这里的包装"
        );
    }
}
