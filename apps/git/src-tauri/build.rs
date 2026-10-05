fn main() {
    let manifest = tauri_build::AppManifest::new().commands(&["open_copy", "demo_info"]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("build Git lab");
}
