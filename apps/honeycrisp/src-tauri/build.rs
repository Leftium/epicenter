//! Generates one permission per shell command, so a window reaches a command
//! only through a capability that names it.

include!("src/command_names.rs");

fn main() {
    let manifest = tauri_build::AppManifest::new().commands(COMMANDS);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("failed to build Honeycrisp's Tauri manifest");
}
