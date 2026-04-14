mod commands;
mod link_service;
mod state_store;

use commands::{
  create_link_job, delete_link_job, get_app_state, import_existing_links, open_in_explorer,
  refresh_link_status, rename_link_job, scan_existing_links, update_settings,
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
