fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "app_note",
            "backend_open",
            "backend_send",
            "backend_close",
            "backend_stderr",
            "node_probe",
            "plain_workspace",
            "shell_log",
            "pick_images",
            "open_skill_directory",
            "detect_editors",
            "open_in_editor",
            "open_with_default",
        ]),
    ))
    .expect("failed to run tauri-build");
}
