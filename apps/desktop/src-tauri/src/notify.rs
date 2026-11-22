//! 桌面系统通知（ADR-0056、ADR-0110）：会话需要确认、出错停止或跑完时提醒用户。
//!
//! 为什么自己写而不是用 `tauri-plugin-notification`：桌面端要求「点通知切到那个
//! 会话」，插件在桌面端不提供点击回调。
//!
//! - **Windows**：直接用 `windows` crate 的 WinRT 绑定（`UI_Notifications`），支持
//!   按会话设置 tag/group（新通知替换旧的、切到该会话时撤掉）以及通知权限查询。
//!   安装版（release）直接用 Tauri bundle identifier 作 AppUserModelID（NSIS 快捷方式
//!   写入同一 id）；开发构建先查注册表，未登记时退回 PowerShell 默认 AUMID。
//! - **macOS**：直接用 `UNUserNotificationCenter`（`objc2-user-notifications`）。
//!   启动时注册常驻 delegate：前台展示回调返回横幅与通知中心列表（`sound = true`
//!   时加声音），点击回调把主窗口带到前台再发 `notify-activated`。无 `.app` bundle
//!   （如 `cargo test`、`tauri dev`）时不调用 `currentNotificationCenter`，直接返回
//!   `unsupported` 以免系统框架崩溃。
//! - **其他平台**：命令照常存在，调用直接返回 `shown: false, reason: "unsupported"`。

use serde::Serialize;
use tauri::AppHandle;

/// 通知被点击时给前端的 Tauri 事件名（前端据此切到对应会话）。
#[cfg(any(windows, target_os = "macos"))]
pub const ACTIVATED_EVENT: &str = "notify-activated";

/// 通知标识与 Windows tag/group 长度上限一致（macOS 沿用同一规则）。
const MAX_ID_CHARS: usize = 64;

/// 同一会话使用同一个通知标识，新通知就地替换旧的。
pub(crate) fn toast_id(session_id: &str) -> String {
    session_id.chars().take(MAX_ID_CHARS).collect()
}

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
    #[cfg(any(windows, target_os = "macos"))]
    fn shown() -> Self {
        Self {
            shown: true,
            reason: None,
            detail: None,
        }
    }

    #[cfg(any(windows, target_os = "macos"))]
    fn disabled() -> Self {
        Self {
            shown: false,
            reason: Some("disabled"),
            detail: None,
        }
    }

    #[cfg(any(windows, target_os = "macos"))]
    fn failed(reason: &'static str, detail: impl Into<String>) -> Self {
        Self {
            shown: false,
            reason: Some(reason),
            detail: Some(detail.into()),
        }
    }

    #[cfg(not(windows))]
    fn unsupported() -> Self {
        Self {
            shown: false,
            reason: Some("unsupported"),
            detail: None,
        }
    }
}

/// 外壳持有的通知状态：
/// - Windows：每个会话当前那条 toast 对象必须活着，点击时 `Activated` 回调才有效；
/// - macOS：通知中心 `delegate` 是弱引用，对象需由外壳长期持有。
#[derive(Default)]
pub struct NotifyState {
    #[cfg(windows)]
    live: std::sync::Mutex<
        std::collections::HashMap<String, windows::UI::Notifications::ToastNotification>,
    >,
    #[cfg(target_os = "macos")]
    delegate: std::sync::Mutex<Option<objc2::rc::Retained<imp::NotificationDelegate>>>,
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

#[cfg(target_os = "macos")]
impl NotifyState {
    fn set_delegate(&self, delegate: objc2::rc::Retained<imp::NotificationDelegate>) {
        *lock(&self.delegate) = Some(delegate);
    }
}

#[cfg(any(windows, target_os = "macos"))]
fn lock<T>(m: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// 启动时初始化平台通知（macOS 注册 `UNUserNotificationCenter` delegate）。
pub fn setup(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    imp::setup(app);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

#[cfg(windows)]
mod imp {
    use super::{toast_id, AppHandle, NotifyOutcome, NotifyState, ACTIVATED_EVENT};
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
            Ok(_) => return NotifyOutcome::disabled(),
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
        NotifyOutcome::shown()
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

#[cfg(target_os = "macos")]
mod imp {
    use std::ptr::NonNull;
    use std::sync::Arc;
    use std::time::Duration;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, NSObject, ProtocolObject};
    use objc2::{define_class, msg_send, AnyThread, DefinedClass};
    use objc2_foundation::{NSArray, NSBundle, NSError, NSObjectProtocol, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent,
        UNNotification, UNNotificationDefaultActionIdentifier, UNNotificationPresentationOptions,
        UNNotificationRequest, UNNotificationResponse, UNNotificationSetting,
        UNNotificationSettings, UNNotificationSound, UNUserNotificationCenter,
        UNUserNotificationCenterDelegate,
    };
    use tauri::{AppHandle, Emitter, Manager};

    use super::{toast_id, NotifyOutcome, NotifyState, ACTIVATED_EVENT};
    use crate::backend::AppState;

    const SETTINGS_TIMEOUT: Duration = Duration::from_secs(5);
    const AUTH_TIMEOUT: Duration = Duration::from_secs(60);
    const ADD_TIMEOUT: Duration = Duration::from_secs(10);

    pub struct DelegateIvars {
        app: AppHandle,
    }

    define_class!(
        // SAFETY:
        // - 父类 NSObject 无额外子类化约束；
        // - NotificationDelegate 不实现 Drop。
        #[unsafe(super(NSObject))]
        #[ivars = DelegateIvars]
        pub struct NotificationDelegate;

        unsafe impl NSObjectProtocol for NotificationDelegate {}

        unsafe impl UNUserNotificationCenterDelegate for NotificationDelegate {
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(
                &self,
                _center: &UNUserNotificationCenter,
                notification: &UNNotification,
                completion_handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                let mut options = UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List;
                if notification.request().content().sound().is_some() {
                    options |= UNNotificationPresentationOptions::Sound;
                }
                completion_handler.call((options,));
            }

            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive_response(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                completion_handler: &block2::DynBlock<dyn Fn()>,
            ) {
                // SAFETY: UNNotificationDefaultActionIdentifier 是 UserNotifications 导出的静态 NSString。
                let is_default = unsafe {
                    response
                        .actionIdentifier()
                        .isEqualToString(UNNotificationDefaultActionIdentifier)
                };
                if is_default {
                    let session_id = response.notification().request().identifier().to_string();
                    let handle = self.ivars().app.clone();
                    if let Some(window) = handle.get_webview_window("main") {
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                    let _ = handle.emit(ACTIVATED_EVENT, session_id);
                }
                completion_handler.call(());
            }
        }
    );

    // SAFETY: `DelegateIvars` 仅持有 `AppHandle`（Send + Sync），创建后只读。
    unsafe impl Send for NotificationDelegate {}
    unsafe impl Sync for NotificationDelegate {}

    impl NotificationDelegate {
        fn new(app: AppHandle) -> Retained<Self> {
            let this = Self::alloc().set_ivars(DelegateIvars { app });
            // SAFETY: 调用 NSObject 指定初始化器 `init`。
            unsafe { msg_send![super(this), init] }
        }
    }

    /// 没有 `.app` bundle（如 `cargo test`、`tauri dev`）时不得调用
    /// `UNUserNotificationCenter::currentNotificationCenter()`，否则框架直接抛异常崩溃。
    fn has_bundle() -> bool {
        NSBundle::mainBundle()
            .bundleIdentifier()
            .is_some_and(|id| !id.to_string().trim().is_empty())
    }

    fn log_note(app: &AppHandle, message: &str) {
        if let Some(state) = app.try_state::<Arc<AppState>>() {
            state.push_shell_note(message);
        }
    }

    /// 启动时注册一次 delegate 并由 `NotifyState` 长期持有；失败只记外壳日志，不影响启动。
    pub fn setup(app: &AppHandle) {
        if !has_bundle() {
            log_note(
                app,
                "[notify] 未在 .app bundle 内运行，跳过 UNUserNotificationCenter delegate 注册",
            );
            return;
        }
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let delegate = NotificationDelegate::new(app.clone());
            let center = UNUserNotificationCenter::currentNotificationCenter();
            center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
            app.state::<NotifyState>().set_delegate(delegate);
        }));
        if result.is_err() {
            log_note(app, "[notify] 注册 UNUserNotificationCenter delegate 失败");
        }
    }

    #[derive(Clone, Copy)]
    enum AuthState {
        Allowed,
        Denied,
        NotDetermined,
    }

    async fn query_auth_state() -> Option<AuthState> {
        // 显式缩小作用域，确保所有 ObjC/block2 对象在 `.await` 前释放，保证 Future 为 Send。
        let rx = {
            let (tx, rx) = std::sync::mpsc::channel::<AuthState>();
            let handler = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
                // SAFETY: UserNotifications 保证回调期间 `settings` 指向有效的 UNNotificationSettings。
                let settings = unsafe { settings.as_ref() };
                let state = match settings.authorizationStatus() {
                    UNAuthorizationStatus::Denied => AuthState::Denied,
                    UNAuthorizationStatus::NotDetermined => AuthState::NotDetermined,
                    _ => {
                        if settings.alertSetting() == UNNotificationSetting::Disabled
                            && settings.notificationCenterSetting()
                                == UNNotificationSetting::Disabled
                        {
                            AuthState::Denied
                        } else {
                            AuthState::Allowed
                        }
                    }
                };
                let _ = tx.send(state);
            });
            UNUserNotificationCenter::currentNotificationCenter()
                .getNotificationSettingsWithCompletionHandler(&handler);
            rx
        };
        tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(SETTINGS_TIMEOUT).ok())
            .await
            .ok()
            .flatten()
    }

    async fn request_authorization() -> Option<Result<bool, String>> {
        let rx = {
            let (tx, rx) = std::sync::mpsc::channel::<Result<bool, String>>();
            let handler = RcBlock::new(move |granted: Bool, error: *mut NSError| {
                let result = if !error.is_null() {
                    // SAFETY: 非空 NSError 指针在回调期间有效。
                    Err(unsafe { &*error }.localizedDescription().to_string())
                } else {
                    Ok(granted.as_bool())
                };
                let _ = tx.send(result);
            });
            let options = UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound;
            UNUserNotificationCenter::currentNotificationCenter()
                .requestAuthorizationWithOptions_completionHandler(options, &handler);
            rx
        };
        tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(AUTH_TIMEOUT).ok())
            .await
            .ok()
            .flatten()
    }

    pub async fn show(
        session_id: &str,
        title: &str,
        body: &str,
        sound: bool,
    ) -> NotifyOutcome {
        if !has_bundle() {
            return NotifyOutcome::unsupported();
        }
        match query_auth_state().await {
            Some(AuthState::Denied) => return NotifyOutcome::disabled(),
            Some(AuthState::NotDetermined) => match request_authorization().await {
                Some(Ok(true)) => {}
                Some(Ok(false)) => return NotifyOutcome::disabled(),
                // 查询或请求失败时按 Windows 的做法照发，不误报 disabled
                Some(Err(_)) | None => {}
            },
            // 已授权或查询失败：照发
            Some(AuthState::Allowed) | None => {}
        }

        let rx = {
            let tag = toast_id(session_id);
            let content = UNMutableNotificationContent::new();
            content.setTitle(&NSString::from_str(title));
            content.setBody(&NSString::from_str(body));
            if sound {
                let default_sound = UNNotificationSound::defaultSound();
                content.setSound(Some(&*default_sound));
            }
            let identifier = NSString::from_str(&tag);
            let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
                &identifier,
                &content,
                None,
            );

            let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
            let handler = RcBlock::new(move |error: *mut NSError| {
                let result = if error.is_null() {
                    Ok(())
                } else {
                    // SAFETY: 非空 NSError 指针在回调期间有效。
                    Err(unsafe { &*error }.localizedDescription().to_string())
                };
                let _ = tx.send(result);
            });
            UNUserNotificationCenter::currentNotificationCenter()
                .addNotificationRequest_withCompletionHandler(&request, Some(&*handler));
            rx
        };

        match tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(ADD_TIMEOUT)).await {
            Ok(Ok(Ok(()))) => NotifyOutcome::shown(),
            Ok(Ok(Err(detail))) => NotifyOutcome::failed("error", detail),
            Ok(Err(_)) => NotifyOutcome::failed("error", "添加系统通知超时"),
            Err(error) => NotifyOutcome::failed("error", error.to_string()),
        }
    }

    pub fn dismiss(session_id: &str) {
        if !has_bundle() {
            return;
        }
        let tag = toast_id(session_id);
        let id = NSString::from_str(&tag);
        let ids = NSArray::from_slice(&[&*id]);
        let center = UNUserNotificationCenter::currentNotificationCenter();
        center.removeDeliveredNotificationsWithIdentifiers(&ids);
        center.removePendingNotificationRequestsWithIdentifiers(&ids);
    }
}

/// 发一条系统通知（前端 `notify_show`）。
///
/// Windows 与其他非 macOS 平台保持同步命令（在 Tauri 主线程执行，维持 WinRT toast
/// 与原有行为一致）；macOS 需要异步等待 `UNUserNotificationCenter` 授权与投递回调，
/// 单独提供 `async` 版本以免阻塞主线程。
#[cfg(not(target_os = "macos"))]
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

/// 发一条系统通知（前端 `notify_show`，macOS 异步版本）。
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn notify_show(
    app: AppHandle,
    session_id: String,
    title: String,
    body: String,
    sound: bool,
) -> NotifyOutcome {
    let _ = &app;
    imp::show(&session_id, &title, &body, sound).await
}

/// 撤掉某个会话的通知（前端切到该会话时调用）。
#[tauri::command]
pub fn notify_dismiss(app: AppHandle, session_id: String) {
    #[cfg(windows)]
    {
        imp::dismiss(&app, &session_id);
    }
    #[cfg(target_os = "macos")]
    {
        let _ = &app;
        imp::dismiss(&session_id);
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = (&app, &session_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toast_id_keeps_short_id_and_truncates_at_64_chars() {
        assert_eq!(toast_id("sess-123"), "sess-123");
        let long = "a".repeat(80);
        assert_eq!(toast_id(&long).chars().count(), MAX_ID_CHARS);
        let utf8 = "测".repeat(70);
        assert_eq!(toast_id(&utf8).chars().count(), MAX_ID_CHARS);
    }
}
