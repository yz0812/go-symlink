fn main() {
  tauri_build::try_build(
    tauri_build::Attributes::new()
      .app_manifest(
        tauri_build::AppManifest::new().commands(&[
          "get_app_state",
          "update_settings",
          "create_link_job",
          "delete_link_job",
          "refresh_link_status",
          "open_in_explorer",
        ]),
      ),
  )
  .expect("failed to run tauri build")
}
