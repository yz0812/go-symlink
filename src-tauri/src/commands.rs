use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::credential_store;
use crate::link_service;
use crate::state_store::{self, AppSettings};
use crate::webdav_service::{self, WebdavBackupFile};

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
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameLinkRequest {
  pub id: String,
  pub name: String,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreWebdavBackupRequest {
  pub file_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteWebdavBackupRequest {
  pub file_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportBackupFileRequest {
  pub file_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestWebdavRequest {
  #[serde(default)]
  pub webdav_enabled: bool,
  #[serde(default)]
  pub webdav_url: String,
  #[serde(default)]
  pub webdav_username: String,
  #[serde(default)]
  pub webdav_remote_dir: String,
  pub webdav_password: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebdavTestResult {
  pub message: String,
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
  #[serde(default)]
  pub webdav_enabled: bool,
  #[serde(default)]
  pub webdav_url: String,
  #[serde(default)]
  pub webdav_username: String,
  #[serde(default)]
  pub webdav_remote_dir: String,
  #[serde(default)]
  pub webdav_auto_backup: bool,
  pub webdav_password: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStateResponse {
  pub settings: AppSettings,
  pub links: Vec<ManagedLinkView>,
  pub storage_path: String,
  pub has_webdav_password: bool,
  pub last_auto_backup_file: Option<String>,
  pub last_auto_backup_error: Option<String>,
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
  let password = settings
    .webdav_password
    .as_deref()
    .map(str::trim)
    .filter(|value| !value.is_empty());
  let credential_status = credential_store::get_status(&app)?;

  let next_settings = AppSettings {
    conflict_strategy: settings.conflict_strategy,
    directory_link_mode: settings.directory_link_mode,
    theme_mode: settings.theme_mode,
    managed_roots,
    webdav_enabled: settings.webdav_enabled,
    webdav_url: settings.webdav_url.trim().to_string(),
    webdav_username: settings.webdav_username.trim().to_string(),
    webdav_remote_dir: normalize_remote_dir(&settings.webdav_remote_dir),
    webdav_auto_backup: settings.webdav_auto_backup,
  };
  validate_settings(&next_settings, password.is_some() || credential_status.has_password)?;

  if let Some(password) = password {
    credential_store::save_password(&app, password)?;
  }

  let storage_path = PathBuf::from(settings.storage_path.trim());
  state_store::validate_state_file_path(&storage_path)?;

  let (mut state, _) = state_store::load_state(&app)?;
  state.settings = next_settings;
  state_store::update_state_file_path(&app, &storage_path)?;
  state_store::save_state(&app, &state)?;

  let auto_backup = webdav_service::auto_backup_if_enabled(&app);
  let (last_auto_backup_file, last_auto_backup_error) = match auto_backup {
    Ok(file_name) => (file_name, None),
    Err(error) => (None, Some(error)),
  };

  build_response_with_webdav_feedback(&app, last_auto_backup_file, last_auto_backup_error)
}

#[tauri::command]
pub fn backup_state_to_webdav(app: AppHandle) -> Result<String, String> {
  webdav_service::backup_current_state(&app)
}

#[tauri::command]
pub fn list_webdav_backups(app: AppHandle) -> Result<Vec<WebdavBackupFile>, String> {
  webdav_service::list_backups(&app)
}

#[tauri::command]
pub fn restore_state_from_webdav(
  app: AppHandle,
  request: RestoreWebdavBackupRequest,
) -> Result<AppStateResponse, String> {
  webdav_service::restore_backup(&app, &request.file_name)?;
  build_response(&app)
}

#[tauri::command]
pub fn delete_webdav_backup(app: AppHandle, request: DeleteWebdavBackupRequest) -> Result<(), String> {
  webdav_service::delete_backup(&app, &request.file_name)
}

#[tauri::command]
pub fn import_backup_file(app: AppHandle, request: ImportBackupFileRequest) -> Result<AppStateResponse, String> {
  let file_path = request.file_path.trim();
  if file_path.is_empty() {
    return Err("备份文件路径不能为空".to_string());
  }

  let path = PathBuf::from(file_path);
  if !path.is_absolute() {
    return Err("备份文件路径必须是绝对路径".to_string());
  }

  if path.extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase() != "json" {
    return Err("备份文件必须是 .json 文件".to_string());
  }

  let bytes = fs::read(&path).map_err(|error| format!("读取备份文件失败：{error}"))?;
  if bytes.is_empty() {
    return Err("备份文件不能为空".to_string());
  }

  webdav_service::import_backup_bytes(&app, &bytes)?;
  build_response(&app)
}

#[tauri::command]
pub fn test_webdav_connection(app: AppHandle, request: TestWebdavRequest) -> Result<WebdavTestResult, String> {
  let password = request
    .webdav_password
    .as_deref()
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .map(str::to_string);

  let next_settings = AppSettings {
    conflict_strategy: "confirm".to_string(),
    directory_link_mode: "junction-first".to_string(),
    theme_mode: "system".to_string(),
    managed_roots: Vec::new(),
    webdav_enabled: request.webdav_enabled,
    webdav_url: request.webdav_url.trim().to_string(),
    webdav_username: request.webdav_username.trim().to_string(),
    webdav_remote_dir: normalize_remote_dir(&request.webdav_remote_dir),
    webdav_auto_backup: false,
  };

  let credential_status = credential_store::get_status(&app)?;
  validate_settings(&next_settings, password.is_some() || credential_status.has_password)?;
  webdav_service::test_connection_with_settings(&next_settings, password.as_deref(), &app)?;
  Ok(WebdavTestResult {
    message: "WebDAV 连接正常，认证通过。".to_string(),
  })
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
pub fn rename_link_job(app: AppHandle, request: RenameLinkRequest) -> Result<AppStateResponse, String> {
  link_service::rename_link_job(&app, request)?;
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
  build_response_with_webdav_feedback(app, None, None)
}

fn build_response_with_webdav_feedback(
  app: &AppHandle,
  last_auto_backup_file: Option<String>,
  last_auto_backup_error: Option<String>,
) -> Result<AppStateResponse, String> {
  let (state, path) = state_store::load_state(app)?;
  let links = state
    .links
    .iter()
    .map(link_service::to_managed_link_view)
    .collect::<Result<Vec<_>, _>>()?;
  let credential_status = credential_store::get_status(app)?;

  Ok(AppStateResponse {
    settings: state.settings,
    links,
    storage_path: path.to_string_lossy().to_string(),
    has_webdav_password: credential_status.has_password,
    last_auto_backup_file,
    last_auto_backup_error,
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

fn validate_settings(settings: &AppSettings, has_password: bool) -> Result<(), String> {
  if settings.conflict_strategy != "confirm" {
    return Err("当前仅支持 confirm 冲突策略".to_string());
  }

  if settings.directory_link_mode != "junction-first" {
    return Err("当前仅支持 junction-first 目录链接模式".to_string());
  }

  if !matches!(settings.theme_mode.as_str(), "light" | "dark" | "system") {
    return Err("主题模式仅支持 light、dark、system".to_string());
  }

  if settings.webdav_auto_backup && !settings.webdav_enabled {
    return Err("自动备份前请先启用 WebDAV 备份".to_string());
  }

  if settings.webdav_enabled {
    if settings.webdav_url.trim().is_empty() {
      return Err("WebDAV 地址不能为空".to_string());
    }

    if reqwest::Url::parse(settings.webdav_url.trim()).is_err() {
      return Err("WebDAV 地址格式不正确".to_string());
    }

    if settings.webdav_username.trim().is_empty() {
      return Err("WebDAV 用户名不能为空".to_string());
    }

    if settings.webdav_remote_dir.trim().is_empty() {
      return Err("WebDAV 远程目录不能为空".to_string());
    }

    if !has_password {
      return Err("请先输入 WebDAV 密码".to_string());
    }
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

fn normalize_remote_dir(value: &str) -> String {
  value
    .trim()
    .replace('\\', "/")
    .split('/')
    .filter_map(|segment| {
      let trimmed = segment.trim();
      if trimmed.is_empty() {
        None
      } else {
        Some(trimmed.to_string())
      }
    })
    .collect::<Vec<_>>()
    .join("/")
}
