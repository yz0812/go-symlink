mod commands;
mod credential_store;
mod error;
mod link_service;
mod migrate_service;
mod state_store;
mod webdav_service;

use commands::{
  backup_state_to_webdav, cancel_migration, create_link_job, delete_link_job, delete_webdav_backup, export_backup_file,
  get_app_state, import_backup_file, import_existing_links, list_webdav_backups, migrate_and_link, open_in_explorer,
  preview_backup, refresh_link_status, rename_link_job, repair_link_jobs, restore_state_from_webdav, revert_link_job,
  scan_existing_links, test_webdav_connection, update_settings,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .manage(state_store::StateLock::default())
    .setup(|app| {
      // release 版也写日志文件（默认输出到 stdout 与应用日志目录），便于排查用户现场问题
      app.handle().plugin(
        tauri_plugin_log::Builder::default()
          .level(log::LevelFilter::Info)
          .max_file_size(2 * 1024 * 1024)
          .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
          .build(),
      )?;

      if let Err(error) = state_store::migrate_on_startup(app.handle()) {
        log::warn!("状态迁移失败：{error}");
      }

      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      get_app_state,
      update_settings,
      backup_state_to_webdav,
      list_webdav_backups,
      restore_state_from_webdav,
      delete_webdav_backup,
      import_backup_file,
      test_webdav_connection,
      create_link_job,
      delete_link_job,
      rename_link_job,
      refresh_link_status,
      scan_existing_links,
      import_existing_links,
      open_in_explorer,
      repair_link_jobs,
      migrate_and_link,
      revert_link_job,
      cancel_migration,
      preview_backup,
      export_backup_file
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
