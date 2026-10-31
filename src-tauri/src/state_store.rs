use std::collections::HashSet;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

/// WebDAV 上每台机器默认保留的备份数量
pub const DEFAULT_WEBDAV_RETENTION: u32 = 20;
/// 恢复/导入前自动保存的快照最多保留几份
const PRE_RESTORE_SNAPSHOT_KEEP: usize = 5;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
  /// 本机备份保留数量，0 表示不清理
  pub webdav_retention: u32,
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
      webdav_retention: DEFAULT_WEBDAV_RETENTION,
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LinkKind {
  File,
  Directory,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LinkType {
  FileSymlink,
  DirectorySymlink,
  Junction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ManagementMode {
  /// 由本应用创建，可以修复、撤销
  #[default]
  Managed,
  /// 扫描导入的已有链接，只做记录
  Tracked,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedLinkRecord {
  pub id: String,
  pub name: String,
  pub kind: LinkKind,
  pub link_path: String,
  pub target_path: String,
  pub link_type: LinkType,
  #[serde(default)]
  pub management_mode: ManagementMode,
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

  let content = fs::read_to_string(&path).map_err(|error| format!("读取状态路径配置失败：{error}"))?;
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

  if !path
    .extension()
    .and_then(|value| value.to_str())
    .unwrap_or_default()
    .eq_ignore_ascii_case("json")
  {
    return Err("数据文件路径必须以 .json 结尾".to_string());
  }

  Ok(())
}

pub fn serialize_state(state: &StoredState) -> Result<Vec<u8>, String> {
  serde_json::to_vec_pretty(state).map_err(|error| format!("序列化状态失败：{error}"))
}

pub fn deserialize_state_bytes(bytes: &[u8]) -> Result<StoredState, String> {
  serde_json::from_slice::<StoredState>(bytes).map_err(|error| format!("解析状态文件失败：{error}"))
}

/// 用备份内容替换当前状态。替换前把当前数据文件另存为快照，返回快照路径，便于误恢复后找回。
pub fn replace_state_from_bytes(app: &AppHandle, bytes: &[u8]) -> Result<Option<PathBuf>, String> {
  let mut state = deserialize_state_bytes(bytes)?;
  dedupe_record_ids(&mut state);

  let _guard = lock_state(app);
  let path = state_file_path(app)?;
  let snapshot = snapshot_before_restore(&path)?;
  write_state_to_path(&path, &state)?;
  Ok(snapshot)
}

fn snapshot_before_restore(path: &Path) -> Result<Option<PathBuf>, String> {
  if !path.exists() {
    return Ok(None);
  }

  let timestamp = chrono::Local::now().format("%Y%m%d%H%M%S");
  let snapshot = path.with_extension(format!("json.pre-restore-{timestamp}.bak"));
  fs::copy(path, &snapshot).map_err(|error| format!("保存恢复前快照失败：{error}"))?;
  prune_snapshots(path, PRE_RESTORE_SNAPSHOT_KEEP);
  Ok(Some(snapshot))
}

/// 只保留最新的若干份恢复前快照；清理失败不影响恢复本身
fn prune_snapshots(path: &Path, keep: usize) {
  let (Some(parent), Some(file_name)) = (path.parent(), path.file_name().and_then(|name| name.to_str())) else {
    return;
  };
  let prefix = format!("{file_name}.pre-restore-");
  let Ok(entries) = fs::read_dir(parent) else {
    return;
  };

  let mut snapshots = entries
    .filter_map(Result::ok)
    .filter_map(|entry| entry.file_name().into_string().ok())
    .filter(|name| name.starts_with(&prefix) && name.ends_with(".bak"))
    .collect::<Vec<_>>();
  // 文件名里的时间戳定长，按字符串倒序即按时间倒序
  snapshots.sort_unstable_by(|a, b| b.cmp(a));

  for name in snapshots.into_iter().skip(keep) {
    let _ = fs::remove_file(parent.join(name));
  }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLink {
  pub name: String,
  pub link_path: String,
  pub target_path: String,
}

/// 恢复备份前展示给用户的差异：以原路径（忽略大小写和分隔符差异）为键比较两份记录
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateDiff {
  pub added: Vec<DiffLink>,
  pub removed: Vec<DiffLink>,
  pub changed: Vec<DiffLink>,
  pub unchanged_count: usize,
  pub settings_changed: bool,
}

fn diff_key(path: &str) -> String {
  path.trim().replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

fn to_diff_link(record: &ManagedLinkRecord) -> DiffLink {
  DiffLink {
    name: record.name.clone(),
    link_path: record.link_path.clone(),
    target_path: record.target_path.clone(),
  }
}

pub fn diff_states(current: &StoredState, incoming: &StoredState) -> StateDiff {
  let current_by_path = current
    .links
    .iter()
    .map(|record| (diff_key(&record.link_path), record))
    .collect::<std::collections::HashMap<_, _>>();
  let incoming_paths = incoming
    .links
    .iter()
    .map(|record| diff_key(&record.link_path))
    .collect::<HashSet<_>>();

  let mut added = Vec::new();
  let mut changed = Vec::new();
  let mut unchanged_count = 0;

  for record in &incoming.links {
    match current_by_path.get(&diff_key(&record.link_path)) {
      None => added.push(to_diff_link(record)),
      Some(existing)
        if diff_key(&existing.target_path) != diff_key(&record.target_path)
          || existing.link_type != record.link_type
          || existing.name != record.name =>
      {
        changed.push(to_diff_link(record))
      }
      Some(_) => unchanged_count += 1,
    }
  }

  let removed = current
    .links
    .iter()
    .filter(|record| !incoming_paths.contains(&diff_key(&record.link_path)))
    .map(to_diff_link)
    .collect();

  StateDiff {
    added,
    removed,
    changed,
    unchanged_count,
    settings_changed: current.settings != incoming.settings,
  }
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
  let content = fs::read(path).map_err(|error| format!("读取状态文件失败：{error}"))?;

  deserialize_state_bytes(&content)
}

fn write_state_to_path(path: &Path, state: &StoredState) -> Result<(), String> {
  ensure_parent_dir(path).map_err(|error| format!("创建状态目录失败：{error}"))?;

  let content = serialize_state(state)?;
  let temp_path = path.with_extension("json.tmp");
  {
    let mut file = fs::File::create(&temp_path).map_err(|error| format!("写入状态文件失败：{error}"))?;
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

  let (state, warning) = read_state_with_fallback(&path)?;
  Ok((state, path, warning))
}

fn read_state_with_fallback(path: &Path) -> Result<(StoredState, Option<String>), String> {
  match read_state_from_path(path) {
    Ok(state) => Ok((state, None)),
    Err(error) => {
      let backup = backup_path(path);
      match read_state_from_path(&backup) {
        Ok(state) => Ok((
          state,
          Some(format!(
            "{error}，已从备份 {} 读取，下次保存时会修复主文件",
            backup.display()
          )),
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

#[cfg(test)]
mod tests {
  use super::*;

  fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("go-symlink-test-{label}-{}", Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    dir
  }

  fn sample_record(id: &str) -> ManagedLinkRecord {
    ManagedLinkRecord {
      id: id.to_string(),
      name: "demo".to_string(),
      kind: LinkKind::Directory,
      link_path: r"C:\link".to_string(),
      target_path: r"D:\target".to_string(),
      link_type: LinkType::Junction,
      management_mode: ManagementMode::Managed,
      created_at: 0,
    }
  }

  #[test]
  fn reads_legacy_state_without_management_mode() {
    let json = br#"{
      "settings": { "themeMode": "dark" },
      "links": [{
        "id": "1700000000000-demo",
        "name": "demo",
        "kind": "file",
        "linkPath": "C:\\a.txt",
        "targetPath": "D:\\a.txt",
        "linkType": "file-symlink",
        "createdAt": 1700000000000
      }]
    }"#;

    let state = deserialize_state_bytes(json).unwrap();
    assert_eq!(state.settings.theme_mode, "dark");
    assert_eq!(state.settings.directory_link_mode, "junction-first");
    assert_eq!(state.links[0].kind, LinkKind::File);
    assert_eq!(state.links[0].link_type, LinkType::FileSymlink);
    assert_eq!(state.links[0].management_mode, ManagementMode::Managed);
  }

  #[test]
  fn enum_fields_serialize_to_legacy_strings() {
    let json = String::from_utf8(
      serialize_state(&StoredState {
        settings: AppSettings::default(),
        links: vec![sample_record("x")],
      })
      .unwrap(),
    )
    .unwrap();

    assert!(json.contains(r#""kind": "directory""#));
    assert!(json.contains(r#""linkType": "junction""#));
    assert!(json.contains(r#""managementMode": "managed""#));
  }

  #[test]
  fn dedupe_reassigns_only_duplicate_ids() {
    let mut state = StoredState {
      settings: AppSettings::default(),
      links: vec![sample_record("a"), sample_record("a"), sample_record("b")],
    };

    assert!(dedupe_record_ids(&mut state));
    assert_eq!(state.links[0].id, "a");
    assert_ne!(state.links[1].id, "a");
    assert_eq!(state.links[2].id, "b");
    assert!(!dedupe_record_ids(&mut state));
  }

  #[test]
  fn atomic_write_keeps_backup_and_recovers_from_corruption() {
    let dir = temp_dir("state");
    let path = dir.join("state.json");

    let mut state = StoredState::default();
    write_state_to_path(&path, &state).unwrap();
    state.links.push(sample_record("second"));
    write_state_to_path(&path, &state).unwrap();

    assert!(!path.with_extension("json.tmp").exists());
    assert_eq!(read_state_from_path(&backup_path(&path)).unwrap().links.len(), 0);

    fs::write(&path, b"{ broken").unwrap();
    let (recovered, warning) = read_state_with_fallback(&path).unwrap();
    assert!(warning.is_some());
    assert_eq!(recovered.links.len(), 0);

    // 主文件损坏时再次写入，不能用坏内容覆盖 .bak
    write_state_to_path(&path, &state).unwrap();
    assert!(read_state_from_path(&backup_path(&path)).is_ok());

    let _ = fs::remove_dir_all(dir);
  }

  #[test]
  fn validates_state_file_path() {
    assert!(validate_state_file_path(Path::new(r"C:\data\state.JSON")).is_ok());
    assert!(validate_state_file_path(Path::new(r"C:\data\state.txt")).is_err());
    assert!(validate_state_file_path(Path::new(r"state.json")).is_err());
  }

  #[test]
  fn diffs_states_by_normalized_link_path() {
    let mut current = StoredState::default();
    current.links.push(sample_record("same"));
    current.links.push(ManagedLinkRecord {
      link_path: r"C:\old".to_string(),
      ..sample_record("old")
    });
    current.links.push(ManagedLinkRecord {
      link_path: r"C:\moved".to_string(),
      ..sample_record("moved")
    });

    let mut incoming = StoredState::default();
    incoming.links.push(ManagedLinkRecord {
      link_path: r"c:/LINK\".to_string(),
      ..sample_record("same-other-id")
    });
    incoming.links.push(ManagedLinkRecord {
      link_path: r"C:\moved".to_string(),
      target_path: r"E:\elsewhere".to_string(),
      ..sample_record("moved")
    });
    incoming.links.push(ManagedLinkRecord {
      link_path: r"C:\new".to_string(),
      ..sample_record("new")
    });
    incoming.settings.theme_mode = "dark".to_string();

    let diff = diff_states(&current, &incoming);
    assert_eq!(diff.unchanged_count, 1);
    assert_eq!(
      diff
        .added
        .iter()
        .map(|item| item.link_path.as_str())
        .collect::<Vec<_>>(),
      [r"C:\new"]
    );
    assert_eq!(
      diff
        .removed
        .iter()
        .map(|item| item.link_path.as_str())
        .collect::<Vec<_>>(),
      [r"C:\old"]
    );
    assert_eq!(diff.changed[0].target_path, r"E:\elsewhere");
    assert!(diff.settings_changed);
  }

  #[test]
  fn keeps_only_latest_restore_snapshots() {
    let dir = temp_dir("snapshot");
    let path = dir.join("state.json");
    fs::write(&path, b"{}").unwrap();
    for index in 0..7 {
      fs::write(
        dir.join(format!("state.json.pre-restore-2026010100000{index}.bak")),
        b"{}",
      )
      .unwrap();
    }
    fs::write(dir.join("other.json.pre-restore-20260101000000.bak"), b"{}").unwrap();

    prune_snapshots(&path, 5);

    let mut names = fs::read_dir(&dir)
      .unwrap()
      .map(|entry| entry.unwrap().file_name().into_string().unwrap())
      .filter(|name| name.starts_with("state.json.pre-restore-"))
      .collect::<Vec<_>>();
    names.sort();
    assert_eq!(names.len(), 5);
    assert_eq!(names[0], "state.json.pre-restore-20260101000002.bak");
    assert!(dir.join("other.json.pre-restore-20260101000000.bak").exists());

    let _ = fs::remove_dir_all(dir);
  }
}
