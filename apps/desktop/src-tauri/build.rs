fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "backend_open",
                "backend_send",
                "backend_close",
                "backend_stderr",
                "node_probe",
                "plain_workspace",
                "pick_images",
            ]),
        ),
    )
    .expect("failed to run tauri-build");
}
