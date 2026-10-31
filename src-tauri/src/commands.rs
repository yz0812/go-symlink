use std::fs;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::credential_store;
use crate::error::{AppError, AppResult, ErrorCode};
use crate::link_service;
use crate::migrate_service::{self, MigrateRequest, RevertLinkRequest};
use crate::state_store::{self, AppSettings, LinkKind, LinkType, ManagementMode};
use crate::webdav_service::{self, WebdavBackupPage};

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
  pub kind: LinkKind,
  pub link_path: String,
  pub target_path: String,
  pub link_type: LinkType,
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
pub struct ExportBackupFileRequest {
  pub file_path: String,
}

const DEFAULT_BACKUP_PAGE_SIZE: usize = 10;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListBackupsRequest {
  #[serde(default)]
  pub offset: usize,
  pub limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum BackupSource {
  Webdav { file_name: String },
  File { path: String },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewBackupRequest {
  pub source: BackupSource,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResponse {
  pub state: AppStateResponse,
  /// 恢复前自动保存的数据快照路径
  pub snapshot_path: Option<String>,
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
  pub kind: LinkKind,
  pub link_path: String,
  pub target_path: String,
  pub link_type: LinkType,
  pub management_mode: ManagementMode,
  pub created_at: i64,
  pub status: String,
  pub status_text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedLinkView {
  pub id: String,
  pub name: String,
  pub kind: LinkKind,
  pub link_path: String,
  pub target_path: String,
  pub link_type: LinkType,
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
  #[serde(default = "default_webdav_retention")]
  pub webdav_retention: u32,
  pub webdav_password: Option<String>,
}

fn default_webdav_retention() -> u32 {
  state_store::DEFAULT_WEBDAV_RETENTION
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairLinksRequest {
  pub ids: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairFailure {
  pub id: String,
  pub name: String,
  pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairLinksResponse {
  pub state: AppStateResponse,
  pub failures: Vec<RepairFailure>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveResponse {
  pub state: AppStateResponse,
  pub warning: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
  pub items: Vec<ScannedLinkView>,
  pub warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStateResponse {
  pub settings: AppSettings,
  pub links: Vec<ManagedLinkView>,
  pub storage_path: String,
  pub has_webdav_password: bool,
  pub state_warning: Option<String>,
}

/// 命令统一放到阻塞线程池执行，避免文件 IO 和 WebDAV 请求卡住主线程导致窗口无响应。
async fn run_blocking<T, F>(task: F) -> AppResult<T>
where
  T: Send + 'static,
  F: FnOnce() -> AppResult<T> + Send + 'static,
{
  tauri::async_runtime::spawn_blocking(task)
    .await
    .map_err(|error| AppError::from(format!("后台任务执行失败：{error}")))?
}

#[tauri::command]
pub async fn get_app_state(app: AppHandle) -> AppResult<AppStateResponse> {
  run_blocking(move || build_response(&app)).await
}

#[tauri::command]
pub async fn refresh_link_status(app: AppHandle) -> AppResult<AppStateResponse> {
  run_blocking(move || build_response(&app)).await
}

#[tauri::command]
pub async fn update_settings(app: AppHandle, settings: UpdateSettingsRequest) -> AppResult<AppStateResponse> {
  run_blocking(move || {
    apply_settings(&app, settings)?;
    webdav_service::spawn_auto_backup(&app);
    build_response(&app)
  })
  .await
}

fn apply_settings(app: &AppHandle, settings: UpdateSettingsRequest) -> AppResult<()> {
  let managed_roots = validate_managed_roots(&settings.managed_roots)?;
  let password = settings
    .webdav_password
    .as_deref()
    .filter(|value| !value.trim().is_empty());
  let credential_status = credential_store::get_status(app)?;

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
    webdav_retention: settings.webdav_retention,
  };
  validate_settings(&next_settings, password.is_some() || credential_status.has_password)?;

  if let Some(password) = password {
    credential_store::save_password(app, password)?;
  }

  let storage_path = PathBuf::from(settings.storage_path.trim());
  state_store::validate_state_file_path(&storage_path)?;

  let _guard = state_store::lock_state(app);
  let (mut state, _) = state_store::load_state(app)?;
  state.settings = next_settings;
  state_store::update_state_file_path(app, &storage_path)?;
  state_store::save_state(app, &state)?;
  Ok(())
}

#[tauri::command]
pub async fn backup_state_to_webdav(app: AppHandle) -> AppResult<String> {
  run_blocking(move || Ok(webdav_service::backup_current_state(&app)?)).await
}

#[tauri::command]
pub async fn list_webdav_backups(app: AppHandle, request: Option<ListBackupsRequest>) -> AppResult<WebdavBackupPage> {
  let request = request.unwrap_or_default();
  let limit = request.limit.unwrap_or(DEFAULT_BACKUP_PAGE_SIZE).clamp(1, 100);
  run_blocking(move || Ok(webdav_service::list_backups(&app, request.offset, limit)?)).await
}

#[tauri::command]
pub async fn preview_backup(app: AppHandle, request: PreviewBackupRequest) -> AppResult<state_store::StateDiff> {
  run_blocking(move || {
    let bytes = match &request.source {
      BackupSource::Webdav { file_name } => webdav_service::download_backup(&app, file_name)?,
      BackupSource::File { path } => read_backup_file(path)?,
    };
    let incoming = state_store::deserialize_state_bytes(&bytes)?;
    let (current, _) = state_store::load_state(&app)?;
    Ok(state_store::diff_states(&current, &incoming))
  })
  .await
}

#[tauri::command]
pub async fn restore_state_from_webdav(
  app: AppHandle,
  request: RestoreWebdavBackupRequest,
) -> AppResult<RestoreResponse> {
  run_blocking(move || {
    let snapshot = webdav_service::restore_backup(&app, &request.file_name)?;
    build_restore_response(&app, snapshot)
  })
  .await
}

#[tauri::command]
pub async fn delete_webdav_backup(app: AppHandle, request: DeleteWebdavBackupRequest) -> AppResult<()> {
  run_blocking(move || Ok(webdav_service::delete_backup(&app, &request.file_name)?)).await
}

#[tauri::command]
pub async fn import_backup_file(app: AppHandle, request: ImportBackupFileRequest) -> AppResult<RestoreResponse> {
  run_blocking(move || {
    let bytes = read_backup_file(&request.file_path)?;
    let snapshot = state_store::replace_state_from_bytes(&app, &bytes)?;
    build_restore_response(&app, snapshot)
  })
  .await
}

#[tauri::command]
pub async fn export_backup_file(app: AppHandle, request: ExportBackupFileRequest) -> AppResult<()> {
  run_blocking(move || {
    let path = parse_backup_file_path(&request.file_path)?;
    let (state, _) = state_store::load_state(&app)?;
    let payload = state_store::serialize_state(&state)?;
    fs::write(&path, payload).map_err(|error| format!("导出备份失败：{error}"))?;
    Ok(())
  })
  .await
}

fn build_restore_response(app: &AppHandle, snapshot: Option<PathBuf>) -> AppResult<RestoreResponse> {
  Ok(RestoreResponse {
    state: build_response(app)?,
    snapshot_path: snapshot.map(|path| path.display().to_string()),
  })
}

/// 本地备份文件只接受绝对路径的 .json 文件
fn parse_backup_file_path(raw: &str) -> AppResult<PathBuf> {
  let file_path = raw.trim();
  if file_path.is_empty() {
    return Err(AppError::new(ErrorCode::InvalidInput, "备份文件路径不能为空"));
  }

  let path = PathBuf::from(file_path);
  if !path.is_absolute() {
    return Err(AppError::new(ErrorCode::InvalidInput, "备份文件路径必须是绝对路径"));
  }

  if !path
    .extension()
    .and_then(|value| value.to_str())
    .unwrap_or_default()
    .eq_ignore_ascii_case("json")
  {
    return Err(AppError::new(ErrorCode::InvalidInput, "备份文件必须是 .json 文件"));
  }

  Ok(path)
}

fn read_backup_file(raw: &str) -> AppResult<Vec<u8>> {
  let path = parse_backup_file_path(raw)?;
  let bytes = fs::read(&path).map_err(|error| format!("读取备份文件失败：{error}"))?;
  if bytes.is_empty() {
    return Err(AppError::new(ErrorCode::InvalidInput, "备份文件不能为空"));
  }

  Ok(bytes)
}

#[tauri::command]
pub async fn test_webdav_connection(app: AppHandle, request: TestWebdavRequest) -> AppResult<WebdavTestResult> {
  run_blocking(move || {
    let password = request
      .webdav_password
      .as_deref()
      .filter(|value| !value.trim().is_empty())
      .map(str::to_string);

    let next_settings = AppSettings {
      webdav_enabled: request.webdav_enabled,
      webdav_url: request.webdav_url.trim().to_string(),
      webdav_username: request.webdav_username.trim().to_string(),
      webdav_remote_dir: normalize_remote_dir(&request.webdav_remote_dir),
      webdav_auto_backup: false,
      ..AppSettings::default()
    };

    let credential_status = credential_store::get_status(&app)?;
    validate_settings(&next_settings, password.is_some() || credential_status.has_password)?;
    webdav_service::test_connection_with_settings(&next_settings, password.as_deref(), &app)?;
    Ok(WebdavTestResult {
      message: "WebDAV 连接正常，认证通过。".to_string(),
    })
  })
  .await
}

#[tauri::command]
pub async fn create_link_job(app: AppHandle, request: CreateLinkRequest) -> AppResult<AppStateResponse> {
  run_blocking(move || {
    link_service::create_link_job(&app, request)?;
    webdav_service::spawn_auto_backup(&app);
    build_response(&app)
  })
  .await
}

#[tauri::command]
pub async fn delete_link_job(app: AppHandle, request: DeleteLinkRequest) -> AppResult<AppStateResponse> {
  run_blocking(move || {
    link_service::delete_link_job(&app, request)?;
    webdav_service::spawn_auto_backup(&app);
    build_response(&app)
  })
  .await
}

#[tauri::command]
pub async fn rename_link_job(app: AppHandle, request: RenameLinkRequest) -> AppResult<AppStateResponse> {
  run_blocking(move || {
    link_service::rename_link_job(&app, request)?;
    webdav_service::spawn_auto_backup(&app);
    build_response(&app)
  })
  .await
}

#[tauri::command]
pub async fn scan_existing_links(app: AppHandle, request: ScanExistingLinksRequest) -> AppResult<ScanResult> {
  run_blocking(move || {
    let roots = validate_managed_roots(&request.roots)?;
    Ok(link_service::scan_existing_links(&app, roots)?)
  })
  .await
}

#[tauri::command]
pub async fn import_existing_links(app: AppHandle, request: ImportExistingLinksRequest) -> AppResult<AppStateResponse> {
  run_blocking(move || {
    link_service::import_existing_links(&app, request)?;
    webdav_service::spawn_auto_backup(&app);
    build_response(&app)
  })
  .await
}

#[tauri::command]
pub async fn repair_link_jobs(app: AppHandle, request: RepairLinksRequest) -> AppResult<RepairLinksResponse> {
  run_blocking(move || {
    let failures = link_service::repair_link_jobs(&app, &request.ids)?;
    Ok(RepairLinksResponse {
      state: build_response(&app)?,
      failures,
    })
  })
  .await
}

#[tauri::command]
pub async fn migrate_and_link(app: AppHandle, request: MigrateRequest) -> AppResult<MoveResponse> {
  run_blocking(move || {
    let outcome = migrate_service::migrate_and_link(&app, request)?;
    webdav_service::spawn_auto_backup(&app);
    Ok(MoveResponse {
      state: build_response(&app)?,
      warning: outcome.warning,
    })
  })
  .await
}

#[tauri::command]
pub async fn revert_link_job(app: AppHandle, request: RevertLinkRequest) -> AppResult<MoveResponse> {
  run_blocking(move || {
    let outcome = migrate_service::revert_link_job(&app, request)?;
    webdav_service::spawn_auto_backup(&app);
    Ok(MoveResponse {
      state: build_response(&app)?,
      warning: outcome.warning,
    })
  })
  .await
}

#[tauri::command]
pub fn cancel_migration() -> AppResult<()> {
  migrate_service::cancel_move();
  Ok(())
}

/// 在资源管理器中打开路径；`select` 为 true 且路径存在时打开父目录并选中该项。
#[tauri::command]
pub fn open_in_explorer(path: String, select: Option<bool>) -> AppResult<()> {
  let trimmed = path.trim();
  if trimmed.is_empty() {
    return Err(AppError::new(ErrorCode::InvalidInput, "路径不能为空"));
  }

  let raw_path = PathBuf::from(trimmed);
  let mut command = Command::new("explorer");

  // 用 symlink_metadata 判断，这样失效链接本身也能被选中
  if select.unwrap_or(false) && fs::symlink_metadata(&raw_path).is_ok() {
    // explorer 对 /select 参数的引号处理很挑剔，必须原样拼成 /select,"<path>"；Windows 路径不可能含有双引号
    command.raw_arg(format!("/select,\"{}\"", raw_path.display()));
  } else {
    command.arg(resolve_directory_to_open(&raw_path)?.as_os_str());
  }

  command.spawn().map_err(|error| format!("打开目录失败：{error}"))?;

  Ok(())
}

fn build_response(app: &AppHandle) -> AppResult<AppStateResponse> {
  let (state, path, state_warning) = state_store::load_state_with_warning(app)?;
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
    state_warning,
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

  path
    .parent()
    .filter(|parent| parent.exists())
    .map(Path::to_path_buf)
    .ok_or_else(|| format!("目录不存在：{}", path.display()))
}

const MAX_WEBDAV_RETENTION: u32 = 500;

fn validate_settings(settings: &AppSettings, has_password: bool) -> Result<(), String> {
  if !matches!(settings.theme_mode.as_str(), "light" | "dark" | "system") {
    return Err("主题模式仅支持 light、dark、system".to_string());
  }

  if settings.webdav_retention > MAX_WEBDAV_RETENTION {
    return Err(format!("备份保留数量不能超过 {MAX_WEBDAV_RETENTION}"));
  }

  if settings.webdav_auto_backup && !settings.webdav_enabled {
    return Err("自动备份前请先启用 WebDAV 备份".to_string());
  }

  if settings.webdav_enabled {
    if settings.webdav_url.trim().is_empty() {
      return Err("WebDAV 地址不能为空".to_string());
    }

    webdav_service::validate_webdav_url(settings.webdav_url.trim())?;

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
    let metadata = fs::metadata(&root).map_err(|_| format!("固定目录不存在：{}", root.display()))?;

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
