//! Windows 系统通知（ADR-0056）：会话需要确认、出错停止或跑完时提醒用户。
//!
//! 为什么自己写而不是用 `tauri-plugin-notification`：桌面端要求「点通知切到那个
//! 会话」，插件在桌面端不提供点击回调。为什么不经 `tauri-winrt-notification`：
//! 0.8.1 的公开 API 只能发通知，设不了 toast 的 tag/group，也就做不到「同一会话
//! 的新通知替换旧的」与「用户切到该会话时撤掉它」；这里直接用 `windows` crate 的
//! WinRT 绑定（`UI_Notifications`），做法与那个库内部一致，另外补上 tag/group、
//! 撤销与通知权限查询。
//!
//! AppUserModelID：安装版（release 构建，随 NSIS 安装器分发）直接用 Tauri bundle
//! identifier——NSIS 安装器把同一 id 写进开始菜单快捷方式的 AppUserModelID，
//! Windows 凭快捷方式显示应用名与图标，不需要在注册表里另有登记；只查
//! `HKCU\Software\Classes\AppUserModelId` 会把「仅写了快捷方式」的安装版误判成
//! 未注册而退回 PowerShell 署名。开发模式的 debug 构建才做注册表探测：本机没
//! 登记时退回库的默认 AUMID（PowerShell 的），通知照常出现，只是署名与图标不对
//! ——不因为没注册就崩或静默不发。
//!
//! 非 Windows 平台：命令照常存在（前端只发布 Windows），调用直接返回
//! `shown: false, reason: "unsupported"`，编译与运行都不受影响。

use serde::Serialize;
use tauri::AppHandle;

/// 通知结果：`disabled` = 系统关掉了本应用的通知；`unsupported` = 平台不支持；
/// `error` = 调用失败（`detail` 带原文，供诊断，不上界面）。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyOutcome {
    pub shown: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl NotifyOutcome {
    #[cfg(windows)]
    fn failed(reason: &'static str, detail: impl Into<String>) -> Self {
        Self { shown: false, reason: Some(reason), detail: Some(detail.into()) }
    }

    #[cfg(not(windows))]
    fn unsupported() -> Self {
        Self { shown: false, reason: Some("unsupported"), detail: None }
    }
}

/// 外壳持有的通知状态：每个会话当前那条 toast 的对象必须活着，Windows 才会在
/// 用户点它时回调 `Activated`（对象一 drop，handler 就没了）。
#[derive(Default)]
pub struct NotifyState {
    #[cfg(windows)]
    live: std::sync::Mutex<std::collections::HashMap<String, windows::UI::Notifications::ToastNotification>>,
}

#[cfg(windows)]
impl NotifyState {
    /// 收下某个会话当前那条 toast；同 tag 的旧对象在这里被替换（回调随之失效）。
    fn keep(&self, tag: String, toast: windows::UI::Notifications::ToastNotification) {
        lock(&self.live).insert(tag, toast);
    }

    /// 取走某个会话的 toast（撤销）：调用方先 Hide 再放掉，对象与它的点击回调一起结束。
    fn take(&self, tag: &str) -> Option<windows::UI::Notifications::ToastNotification> {
        lock(&self.live).remove(tag)
    }
}

#[cfg(windows)]
fn lock<T>(m: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(windows)]
mod imp {
    use super::{AppHandle, NotifyOutcome, NotifyState};
    use tauri::{Emitter, Manager};
    use windows::core::HSTRING;
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Foundation::TypedEventHandler;
    use windows::UI::Notifications::{
        NotificationSetting, ToastNotification, ToastNotificationManager, ToastNotifier,
    };

    /// 未注册 AUMID 时退回的 toast 应用标识（PowerShell 的；tauri-winrt-notification
    /// 的默认值，通知照常显示，只是署名不对）。
    const FALLBACK_AUMID: &str = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\
                                 \\WindowsPowerShell\\v1.0\\powershell.exe";

    /// 通知被点击时给前端的 Tauri 事件名（前端据此切到对应会话）。
    pub const ACTIVATED_EVENT: &str = "notify-activated";

    /// toast 的 tag/group 与 Windows 侧长度上限一致（注入 payload 时的护栏）。
    const MAX_ID_CHARS: usize = 64;

    fn toast_id(session_id: &str) -> String {
        session_id.chars().take(MAX_ID_CHARS).collect()
    }

    /// 开发构建才需要探测注册表：安装版（release）直接用 bundle identifier。
    /// NSIS 安装器把同一 id 写进开始菜单快捷方式的 AppUserModelID 即够用，
    /// 快捷方式不写注册表 `Software\Classes\AppUserModelId`，只查它会误判。
    #[cfg(debug_assertions)]
    fn aumid_registered(app_id: &str) -> bool {
        use windows_sys::Win32::System::Registry::{
            RegCloseKey, RegOpenKeyExW, HKEY_CURRENT_USER, KEY_READ,
        };
        let subkey = format!("Software\\Classes\\AppUserModelId\\{app_id}");
        let subkey: Vec<u16> = subkey.encode_utf16().chain(std::iter::once(0)).collect();
        let mut key = std::ptr::null_mut();
        // SAFETY: subkey 以 NUL 结尾；key 只在打开成功时有效，紧接着关闭。
        let opened =
            unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, subkey.as_ptr(), 0, KEY_READ, &mut key) };
        if opened != 0 {
            return false;
        }
        unsafe { RegCloseKey(key) };
        true
    }

    /// 通知使用的 AUMID：安装版直接用 bundle identifier（与 NSIS 快捷方式一致）；
    /// 只有开发构建才探测注册表，未登记退回 PowerShell 默认。
    fn app_user_model_id(app: &AppHandle) -> String {
        let identifier = app.config().identifier.clone();
        #[cfg(debug_assertions)]
        if !aumid_registered(&identifier) {
            return FALLBACK_AUMID.to_string();
        }
        identifier
    }

    /// XML 不允许控制字符（标题里带 \x07 之类会让整条通知建不出来）：替换成空格。
    fn xml_safe(text: &str) -> String {
        text.chars()
            .map(|c| if c.is_control() && c != '\t' { ' ' } else { c })
            .collect()
    }

    /// ToastGeneric 的标题 + 正文；`sound = false` 时加 `<audio silent="true"/>`。
    fn template(title: &str, body: &str, sound: bool) -> windows::core::Result<ToastNotification> {
        let xml = XmlDocument::new()?;
        let toast = xml.CreateElement(&HSTRING::from("toast"))?;
        let visual = xml.CreateElement(&HSTRING::from("visual"))?;
        let binding = xml.CreateElement(&HSTRING::from("binding"))?;
        binding.SetAttribute(&HSTRING::from("template"), &HSTRING::from("ToastGeneric"))?;
        for (id, text) in [("1", title), ("2", body)] {
            let element = xml.CreateElement(&HSTRING::from("text"))?;
            element.SetAttribute(&HSTRING::from("id"), &HSTRING::from(id))?;
            element.SetInnerText(&HSTRING::from(xml_safe(text)))?;
            binding.AppendChild(&element)?;
        }
        visual.AppendChild(&binding)?;
        toast.AppendChild(&visual)?;
        if !sound {
            let audio = xml.CreateElement(&HSTRING::from("audio"))?;
            audio.SetAttribute(&HSTRING::from("silent"), &HSTRING::from("true"))?;
            toast.AppendChild(&audio)?;
        }
        xml.AppendChild(&toast)?;
        ToastNotification::CreateToastNotification(&xml)
    }

    fn notifier(app_id: &str) -> windows::core::Result<ToastNotifier> {
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id))
    }

    /// 发一条通知：tag/group 都是会话 id，同一会话的新通知替换旧的（Windows 按
    /// tag 就地替换，这里同时放掉上一版对象）；对象存进 `NotifyState` 让点击回调有效。
    pub fn show(
        app: &AppHandle,
        session_id: &str,
        title: &str,
        body: &str,
        sound: bool,
    ) -> NotifyOutcome {
        let app_id = app_user_model_id(app);
        let notifier = match notifier(&app_id) {
            Ok(notifier) => notifier,
            Err(error) => return NotifyOutcome::failed("error", error.message()),
        };
        match notifier.Setting() {
            Ok(NotificationSetting::Enabled) => {}
            Ok(_) => return NotifyOutcome { shown: false, reason: Some("disabled"), detail: None },
            // 查不到就照发：Windows 自己会吞掉它，比误报「被关掉」好
            Err(_) => {}
        }
        let tag = toast_id(session_id);
        let toast = match template(title, body, sound) {
            Ok(toast) => toast,
            Err(error) => return NotifyOutcome::failed("error", error.message()),
        };
        if let Err(error) = toast.SetTag(&HSTRING::from(&tag)) {
            return NotifyOutcome::failed("error", error.message());
        }
        if let Err(error) = toast.SetGroup(&HSTRING::from(&tag)) {
            return NotifyOutcome::failed("error", error.message());
        }
        let handle = app.clone();
        let activated_session = tag.clone();
        // 点击：窗口带到前台 + 通知前端切会话（会话列表只有前端有，外壳不猜）
        let handler = TypedEventHandler::new(move |_, _| {
            if let Some(window) = handle.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            let _ = handle.emit(ACTIVATED_EVENT, activated_session.clone());
            Ok(())
        });
        if let Err(error) = toast.Activated(&handler) {
            return NotifyOutcome::failed("error", error.message());
        }
        if let Err(error) = notifier.Show(&toast) {
            return NotifyOutcome::failed("error", error.message());
        }
        app.state::<NotifyState>().keep(tag, toast);
        NotifyOutcome { shown: true, reason: None, detail: None }
    }

    /// 撤掉某个会话的通知：先 Hide 原 toast 对象（屏幕上那条立刻消失），
    /// 再按 tag/group 清通知中心历史；最后放掉对象（点击回调随之失效）。
    pub fn dismiss(app: &AppHandle, session_id: &str) {
        let tag = toast_id(session_id);
        let app_id = app_user_model_id(app);
        let toast = app.state::<NotifyState>().take(&tag);
        if let Ok(notifier) = notifier(&app_id) {
            if let Some(previous) = toast.as_ref() {
                let _ = notifier.Hide(previous);
            }
        }
        if let Ok(history) = ToastNotificationManager::History() {
            let _ = history.RemoveGroupedTagWithId(
                &HSTRING::from(&tag),
                &HSTRING::from(&tag),
                &HSTRING::from(app_id),
            );
        }
    }
}

/// 发一条系统通知（前端 `notify_show`）。
#[tauri::command]
pub fn notify_show(
    app: AppHandle,
    session_id: String,
    title: String,
    body: String,
    sound: bool,
) -> NotifyOutcome {
    #[cfg(windows)]
    {
        imp::show(&app, &session_id, &title, &body, sound)
    }
    #[cfg(not(windows))]
    {
        let _ = (&app, &session_id, &title, &body, sound);
        NotifyOutcome::unsupported()
    }
}

/// 撤掉某个会话的通知（前端切到该会话时调用）。
#[tauri::command]
pub fn notify_dismiss(app: AppHandle, session_id: String) {
    #[cfg(windows)]
    {
        imp::dismiss(&app, &session_id);
    }
    #[cfg(not(windows))]
    {
        let _ = (&app, &session_id);
    }
}
