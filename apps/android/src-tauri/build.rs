fn main() {
    // Android 15+ 的 16 KB 页面设备要求原生库按 16 KB 对齐，NDK 27 默认 4 KB。
    // 用 link-arg 而不是 .cargo/config.toml：后者按 cargo 的工作目录查找，经 Gradle 调用时不一定命中。
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        println!("cargo:rustc-link-arg-cdylib=-Wl,-z,max-page-size=16384");
    }
    tauri_build::build();
}
