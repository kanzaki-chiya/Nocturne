fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "backend_open",
                "backend_send",
                "backend_close",
                "node_probe",
                "plain_workspace",
            ]),
        ),
    )
    .expect("failed to run tauri-build");
}
