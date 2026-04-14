mod commands;
mod credential_store;
mod link_service;
mod state_store;
mod webdav_service;

use commands::{
  backup_state_to_webdav, create_link_job, delete_link_job, delete_webdav_backup, get_app_state,
  import_backup_file, import_existing_links, list_webdav_backups, open_in_explorer,
  refresh_link_status, rename_link_job, restore_state_from_webdav, scan_existing_links,
  test_webdav_connection, update_settings,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
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
      open_in_explorer
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
