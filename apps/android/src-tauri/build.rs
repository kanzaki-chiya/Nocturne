fn main() {
    // Android 15+ 的 16 KB 页面设备要求原生库按 16 KB 对齐，NDK 27 默认 4 KB。
    // 用 link-arg 而不是 .cargo/config.toml：后者按 cargo 的工作目录查找，经 Gradle 调用时不一定命中。
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        println!("cargo:rustc-link-arg-cdylib=-Wl,-z,max-page-size=16384");
    }
    // 后台服务插件（src/background.rs）是应用内的内联插件：只有一个 `call` 命令，权限 background:default
    tauri_build::try_build(
        tauri_build::Attributes::new().plugin(
            "background",
            tauri_build::InlinedPlugin::new()
                .commands(&["call"])
                .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
        ),
    )
    .expect("failed to run tauri-build");
}
