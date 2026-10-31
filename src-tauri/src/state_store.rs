use std::collections::HashSet;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

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

  if !path.extension().and_then(|value| value.to_str()).unwrap_or_default().eq_ignore_ascii_case("json") {
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
  let mut state = deserialize_state_bytes(bytes)?;
  dedupe_record_ids(&mut state);

  let _guard = lock_state(app);
  save_state(app, &state)?;
  Ok(())
}

/// 串行化所有“读取 → 修改 → 写回”状态文件的操作，避免并发命令互相覆盖。
pub struct StateLock(pub Mutex<()>);

impl Default for StateLock {
  fn default() -> Self {
    Self(Mutex::new(()))
  }
}

pub fn lock_state(app: &AppHandle) -> MutexGuard<'_, ()> {
  app
    .state::<StateLock>()
    .inner()
    .0
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn backup_path(path: &Path) -> PathBuf {
  path.with_extension("json.bak")
}

fn read_state_from_path(path: &Path) -> Result<StoredState, String> {
  let content = fs::read(path)
    .map_err(|error| format!("读取状态文件失败：{error}"))?;

  deserialize_state_bytes(&content)
}

fn write_state_to_path(path: &Path, state: &StoredState) -> Result<(), String> {
  ensure_parent_dir(path).map_err(|error| format!("创建状态目录失败：{error}"))?;

  let content = serialize_state(state)?;
  let temp_path = path.with_extension("json.tmp");
  {
    let mut file = fs::File::create(&temp_path)
      .map_err(|error| format!("写入状态文件失败：{error}"))?;
    file
      .write_all(&content)
      .and_then(|_| file.sync_all())
      .map_err(|error| format!("写入状态文件失败：{error}"))?;
  }

  // 只在现有文件可解析时才覆盖 .bak，避免用损坏内容冲掉最后一份好备份
  if path.exists() && read_state_from_path(path).is_ok() {
    let _ = fs::copy(path, backup_path(path));
  }

  fs::rename(&temp_path, path).map_err(|error| {
    let _ = fs::remove_file(&temp_path);
    format!("写入状态文件失败：{error}")
  })
}

/// 读取状态；主文件损坏时回退到 `.bak`，并返回提示信息。
pub fn load_state_with_warning(app: &AppHandle) -> Result<(StoredState, PathBuf, Option<String>), String> {
  let path = state_file_path(app)?;

  if !path.exists() {
    return Ok((StoredState::default(), path, None));
  }

  match read_state_from_path(&path) {
    Ok(state) => Ok((state, path, None)),
    Err(error) => {
      let backup = backup_path(&path);
      match read_state_from_path(&backup) {
        Ok(state) => Ok((
          state,
          path,
          Some(format!("{error}，已从备份 {} 读取，下次保存时会修复主文件", backup.display())),
        )),
        Err(_) => Err(error),
      }
    }
  }
}

pub fn load_state(app: &AppHandle) -> Result<(StoredState, PathBuf), String> {
  let (state, path, _) = load_state_with_warning(app)?;
  Ok((state, path))
}

pub fn save_state(app: &AppHandle, state: &StoredState) -> Result<PathBuf, String> {
  let path = state_file_path(app)?;
  write_state_to_path(&path, state)?;
  Ok(path)
}

/// 修正历史数据：旧版本按“毫秒时间戳-名称”生成 id，批量导入同名链接时可能重复。
pub fn dedupe_record_ids(state: &mut StoredState) -> bool {
  let mut seen = HashSet::new();
  let mut changed = false;

  for record in &mut state.links {
    if !seen.insert(record.id.clone()) {
      record.id = new_record_id();
      seen.insert(record.id.clone());
      changed = true;
    }
  }

  changed
}

pub fn new_record_id() -> String {
  Uuid::new_v4().to_string()
}

/// 启动时执行一次的数据迁移。
pub fn migrate_on_startup(app: &AppHandle) -> Result<(), String> {
  let _guard = lock_state(app);
  let (mut state, path, warning) = load_state_with_warning(app)?;

  if (warning.is_some() || dedupe_record_ids(&mut state)) && path.exists() {
    save_state(app, &state)?;
  }

  Ok(())
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

  // 旧文件保留在原位置，避免切换路径时误丢数据
  Ok(next_path)
}

fn ensure_parent_dir(path: &Path) -> io::Result<()> {
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent)?;
  }

  Ok(())
}
