//! 后台保持连接的 Tauri 移动端插件（ADR-0059 第 2 节）。
//!
//! Rust 侧只做转发：把前端的 `plugin:background|call` 交给 Kotlin 的 `BackgroundPlugin`
//! （前台服务、系统设置页、探针的原生日志）。身份密钥与会话内容都在 WebView 里，不经过这里。
use serde_json::Value;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

/// Kotlin `BackgroundPlugin` 暴露的命令；其他名字一律拒绝。
const COMMANDS: [&str; 7] = [
    "start",
    "update",
    "stop",
    "status",
    "open_settings",
    "log",
    "clear_log",
];

#[cfg(target_os = "android")]
struct Background<R: Runtime>(tauri::plugin::PluginHandle<R>);

fn known(command: &str) -> bool {
    COMMANDS.contains(&command)
}

#[tauri::command]
async fn call<R: Runtime>(
    app: tauri::AppHandle<R>,
    command: String,
    payload: Option<Value>,
) -> Result<Value, String> {
    if !known(&command) {
        return Err(format!("未知的后台命令：{command}"));
    }
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let background = app.state::<Background<R>>();
        background
            .0
            .run_mobile_plugin(&command, payload.unwrap_or(Value::Null))
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, payload);
        Err("后台服务只在安卓上可用".into())
    }
}

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("background")
        .invoke_handler(tauri::generate_handler![call])
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                let handle = _api
                    .register_android_plugin("io.github.kanzaki_chiya.nocturne.remote", "BackgroundPlugin")?;
                _app.manage(Background(handle));
            }
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_listed_commands_are_forwarded() {
        for command in COMMANDS {
            assert!(known(command));
        }
        for command in ["", "Start", "start ", "registerListener", "shell", "../start"] {
            assert!(!known(command), "{command}");
        }
    }
}
