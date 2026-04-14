use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
  pub conflict_strategy: String,
  pub directory_link_mode: String,
  pub theme_mode: String,
  pub managed_roots: Vec<String>,
  pub webdav_enabled: bool,
  pub webdav_url: String,
  pub webdav_username: String,
  pub webdav_remote_dir: String,
  pub webdav_auto_backup: bool,
}

impl Default for AppSettings {
  fn default() -> Self {
    Self {
      conflict_strategy: "confirm".to_string(),
      directory_link_mode: "junction-first".to_string(),
      theme_mode: "system".to_string(),
      managed_roots: Vec::new(),
      webdav_enabled: false,
      webdav_url: String::new(),
      webdav_username: String::new(),
      webdav_remote_dir: String::new(),
      webdav_auto_backup: false,
    }
  }
}

fn default_management_mode() -> String {
  "managed".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedLinkRecord {
  pub id: String,
  pub name: String,
  pub kind: String,
  pub link_path: String,
  pub target_path: String,
  pub link_type: String,
  #[serde(default = "default_management_mode")]
  pub management_mode: String,
  pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StoredState {
  pub settings: AppSettings,
  pub links: Vec<ManagedLinkRecord>,
}

fn default_state_file_path(app: &AppHandle) -> Result<PathBuf, String> {
  let home_dir = app
    .path()
    .home_dir()
    .map_err(|error| format!("无法解析用户主目录：{error}"))?;

  Ok(home_dir.join(".go-symlink").join("state.json"))
}

fn override_path_file(app: &AppHandle) -> Result<PathBuf, String> {
  let base_dir = app
    .path()
    .app_local_data_dir()
    .map_err(|error| format!("无法解析应用本地数据目录：{error}"))?;

  Ok(base_dir.join("state-path.txt"))
}

fn read_override_state_path(app: &AppHandle) -> Result<Option<PathBuf>, String> {
  let path = override_path_file(app)?;

  if !path.exists() {
    return Ok(None);
  }

  let content = fs::read_to_string(&path)
    .map_err(|error| format!("读取状态路径配置失败：{error}"))?;
  let trimmed = content.trim();

  if trimmed.is_empty() {
    return Ok(None);
  }

  Ok(Some(PathBuf::from(trimmed)))
}

fn write_override_state_path(app: &AppHandle, path: &Path) -> Result<(), String> {
  let override_file = override_path_file(app)?;
  ensure_parent_dir(&override_file).map_err(|error| format!("创建状态路径配置目录失败：{error}"))?;
  fs::write(&override_file, path.to_string_lossy().to_string())
    .map_err(|error| format!("写入状态路径配置失败：{error}"))
}

pub fn state_file_path(app: &AppHandle) -> Result<PathBuf, String> {
  if let Some(path) = read_override_state_path(app)? {
    return Ok(path);
  }

  default_state_file_path(app)
}

pub fn validate_state_file_path(path: &Path) -> Result<(), String> {
  if !path.is_absolute() {
    return Err("数据文件路径必须是绝对路径".to_string());
  }

  if path.extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase() != "json" {
    return Err("数据文件路径必须以 .json 结尾".to_string());
  }

  Ok(())
}

pub fn serialize_state(state: &StoredState) -> Result<Vec<u8>, String> {
  serde_json::to_vec_pretty(state)
    .map_err(|error| format!("序列化状态失败：{error}"))
}

pub fn deserialize_state_bytes(bytes: &[u8]) -> Result<StoredState, String> {
  serde_json::from_slice::<StoredState>(bytes)
    .map_err(|error| format!("解析状态文件失败：{error}"))
}

pub fn replace_state_from_bytes(app: &AppHandle, bytes: &[u8]) -> Result<(), String> {
  let state = deserialize_state_bytes(bytes)?;
  save_state(app, &state)?;
  Ok(())
}

fn read_state_from_path(path: &Path) -> Result<StoredState, String> {
  let content = fs::read(path)
    .map_err(|error| format!("读取状态文件失败：{error}"))?;

  deserialize_state_bytes(&content)
}

fn write_state_to_path(path: &Path, state: &StoredState) -> Result<(), String> {
  ensure_parent_dir(path).map_err(|error| format!("创建状态目录失败：{error}"))?;

  let content = serialize_state(state)?;
  fs::write(path, content).map_err(|error| format!("写入状态文件失败：{error}"))
}

pub fn load_state(app: &AppHandle) -> Result<(StoredState, PathBuf), String> {
  let path = state_file_path(app)?;

  if !path.exists() {
    return Ok((StoredState::default(), path));
  }

  let state = read_state_from_path(&path)?;

  Ok((state, path))
}

pub fn save_state(app: &AppHandle, state: &StoredState) -> Result<PathBuf, String> {
  let path = state_file_path(app)?;
  write_state_to_path(&path, state)?;
  Ok(path)
}

pub fn update_state_file_path(app: &AppHandle, next_path: &Path) -> Result<PathBuf, String> {
  validate_state_file_path(next_path)?;

  let next_path = fs::canonicalize(next_path).unwrap_or_else(|_| next_path.to_path_buf());
  let (state, current_path) = load_state(app)?;
  let current_path = fs::canonicalize(&current_path).unwrap_or(current_path);

  if current_path == next_path {
    return Ok(current_path);
  }

  if next_path.exists() {
    return Err(format!("目标数据文件已存在：{}", next_path.display()));
  }

  write_state_to_path(&next_path, &state)?;
  write_override_state_path(app, &next_path)?;

  if current_path.exists() && current_path != next_path {
    let _ = fs::remove_file(&current_path);
  }

  Ok(next_path)
}

fn ensure_parent_dir(path: &Path) -> io::Result<()> {
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent)?;
  }

  Ok(())
}
