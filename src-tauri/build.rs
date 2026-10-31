fn main() {
  // 所有命令都必须列在这里：未列出的命令不受 capability 权限约束
  tauri_build::try_build(
    tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
      "get_app_state",
      "update_settings",
      "backup_state_to_webdav",
      "list_webdav_backups",
      "restore_state_from_webdav",
      "delete_webdav_backup",
      "import_backup_file",
      "test_webdav_connection",
      "create_link_job",
      "delete_link_job",
      "rename_link_job",
      "refresh_link_status",
      "scan_existing_links",
      "import_existing_links",
      "open_in_explorer",
      "repair_link_jobs",
      "migrate_and_link",
      "revert_link_job",
      "cancel_migration",
    ])),
  )
  .expect("failed to run tauri build")
}
