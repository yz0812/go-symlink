use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::link_service;
use crate::state_store::{self, AppSettings};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateLinkRequest {
  pub name: Option<String>,
  pub link_path: String,
  pub target_path: String,
  #[serde(default)]
  pub overwrite_conflict: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteLinkRequest {
  pub id: String,
  #[serde(default)]
  pub overwrite_conflict: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanExistingLinksRequest {
  #[serde(default)]
  pub roots: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportExistingLinkItem {
  pub name: String,
  pub kind: String,
  pub link_path: String,
  pub target_path: String,
  pub link_type: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportExistingLinksRequest {
  #[serde(default)]
  pub items: Vec<ImportExistingLinkItem>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedLinkView {
  pub id: String,
  pub name: String,
  pub kind: String,
  pub link_path: String,
  pub target_path: String,
  pub link_type: String,
  pub management_mode: String,
  pub created_at: i64,
  pub status: String,
  pub status_text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedLinkView {
  pub id: String,
  pub name: String,
  pub kind: String,
  pub link_path: String,
  pub target_path: String,
  pub link_type: String,
  pub scan_root: String,
  pub target_exists: bool,
  pub already_managed: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSettingsRequest {
  pub conflict_strategy: String,
  pub directory_link_mode: String,
  pub theme_mode: String,
  pub storage_path: String,
  #[serde(default)]
  pub managed_roots: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStateResponse {
  pub settings: AppSettings,
  pub links: Vec<ManagedLinkView>,
  pub storage_path: String,
}

#[tauri::command]
pub fn get_app_state(app: AppHandle) -> Result<AppStateResponse, String> {
  build_response(&app)
}

#[tauri::command]
pub fn refresh_link_status(app: AppHandle) -> Result<AppStateResponse, String> {
  build_response(&app)
}

#[tauri::command]
pub fn update_settings(app: AppHandle, settings: UpdateSettingsRequest) -> Result<AppStateResponse, String> {
  let managed_roots = validate_managed_roots(&settings.managed_roots)?;
  let next_settings = AppSettings {
    conflict_strategy: settings.conflict_strategy,
    directory_link_mode: settings.directory_link_mode,
    theme_mode: settings.theme_mode,
    managed_roots,
  };
  validate_settings(&next_settings)?;

  let storage_path = PathBuf::from(settings.storage_path.trim());
  state_store::validate_state_file_path(&storage_path)?;

  let (mut state, _) = state_store::load_state(&app)?;
  state.settings = next_settings;
  state_store::update_state_file_path(&app, &storage_path)?;
  state_store::save_state(&app, &state)?;
  build_response(&app)
}

#[tauri::command]
pub fn create_link_job(app: AppHandle, request: CreateLinkRequest) -> Result<AppStateResponse, String> {
  link_service::create_link_job(&app, request)?;
  build_response(&app)
}

#[tauri::command]
pub fn delete_link_job(app: AppHandle, request: DeleteLinkRequest) -> Result<AppStateResponse, String> {
  link_service::delete_link_job(&app, request)?;
  build_response(&app)
}

#[tauri::command]
pub fn scan_existing_links(app: AppHandle, request: ScanExistingLinksRequest) -> Result<Vec<ScannedLinkView>, String> {
  let roots = validate_managed_roots(&request.roots)?;
  link_service::scan_existing_links(&app, roots)
}

#[tauri::command]
pub fn import_existing_links(app: AppHandle, request: ImportExistingLinksRequest) -> Result<AppStateResponse, String> {
  link_service::import_existing_links(&app, request)?;
  build_response(&app)
}

#[tauri::command]
pub fn open_in_explorer(path: String) -> Result<(), String> {
  let trimmed = path.trim();
  if trimmed.is_empty() {
    return Err("路径不能为空".to_string());
  }

  let raw_path = PathBuf::from(trimmed);
  let target_dir = resolve_directory_to_open(&raw_path)?;

  Command::new("explorer")
    .arg(target_dir.as_os_str())
    .spawn()
    .map_err(|error| format!("打开目录失败：{error}"))?;

  Ok(())
}

fn build_response(app: &AppHandle) -> Result<AppStateResponse, String> {
  let (state, path) = state_store::load_state(app)?;
  let links = state
    .links
    .iter()
    .map(link_service::to_managed_link_view)
    .collect::<Result<Vec<_>, _>>()?;

  Ok(AppStateResponse {
    settings: state.settings,
    links,
    storage_path: path.to_string_lossy().to_string(),
  })
}

fn resolve_directory_to_open(path: &Path) -> Result<PathBuf, String> {
  if path.is_dir() {
    return Ok(path.to_path_buf());
  }

  if path.exists() {
    return path
      .parent()
      .map(Path::to_path_buf)
      .ok_or_else(|| format!("无法解析父目录：{}", path.display()));
  }

  path.parent()
    .filter(|parent| parent.exists())
    .map(Path::to_path_buf)
    .ok_or_else(|| format!("目录不存在：{}", path.display()))
}

fn validate_settings(settings: &AppSettings) -> Result<(), String> {
  if settings.conflict_strategy != "confirm" {
    return Err("当前仅支持 confirm 冲突策略".to_string());
  }

  if settings.directory_link_mode != "junction-first" {
    return Err("当前仅支持 junction-first 目录链接模式".to_string());
  }

  if !matches!(settings.theme_mode.as_str(), "light" | "dark" | "system") {
    return Err("主题模式仅支持 light、dark、system".to_string());
  }

  Ok(())
}

fn validate_managed_roots(roots: &[String]) -> Result<Vec<String>, String> {
  let mut normalized = Vec::new();

  for raw_root in roots {
    let root = link_service::parse_absolute_path("固定目录", raw_root)?;
    let metadata = fs::metadata(&root)
      .map_err(|_| format!("固定目录不存在：{}", root.display()))?;

    if !metadata.is_dir() {
      return Err(format!("固定目录不是目录：{}", root.display()));
    }

    let text = link_service::normalize_path(&root);
    if normalized.iter().any(|existing| existing == &text) {
      continue;
    }

    normalized.push(text);
  }

  Ok(normalized)
}
