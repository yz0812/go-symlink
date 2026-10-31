use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

use crate::error::{AppError, AppResult, ErrorCode};
use crate::link_service::{self, current_timestamp, normalize_path, path_exists_no_follow};
use crate::state_store::{self, LinkKind, ManagedLinkRecord, ManagementMode};

pub const MIGRATE_PROGRESS_EVENT: &str = "migrate-progress";

const ERROR_NOT_SAME_DEVICE: i32 = 17;
const STAGING_SUFFIX: &str = ".go-symlink-moving";
const PROGRESS_INTERVAL: Duration = Duration::from_millis(150);

static MOVE_RUNNING: AtomicBool = AtomicBool::new(false);
static MOVE_CANCELLED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrateRequest {
  pub source_path: String,
  pub destination_dir: String,
  pub name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertLinkRequest {
  pub id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveProgress {
  pub copied_bytes: u64,
  pub total_bytes: u64,
  pub current_path: String,
}

/// 迁移/撤销完成后，未能自动完成的清理事项（例如暂存目录删除失败）。
#[derive(Debug, Default)]
pub struct MoveOutcome {
  pub warning: Option<String>,
}

/// 把真实文件/目录移动到目标目录，并在原位置创建链接指向新位置。
pub fn migrate_and_link(app: &AppHandle, request: MigrateRequest) -> AppResult<MoveOutcome> {
  let source = link_service::parse_absolute_path("源路径", &request.source_path)
    .map_err(|error| AppError::new(ErrorCode::InvalidInput, error).with_field("sourcePath"))?;
  let destination_dir = link_service::parse_absolute_path("目标目录", &request.destination_dir)
    .map_err(|error| AppError::new(ErrorCode::InvalidInput, error).with_field("destinationDir"))?;

  let metadata = fs::symlink_metadata(&source).map_err(|_| {
    AppError::new(ErrorCode::NotFound, format!("源路径不存在：{}", source.display())).with_field("sourcePath")
  })?;
  if link_service::is_reparse_point(&metadata) {
    return Err(AppError::new(ErrorCode::InvalidInput, "源路径本身已经是链接，无需迁移").with_field("sourcePath"));
  }
  ensure_movable_location(&source)?;

  if !destination_dir.is_dir() {
    return Err(
      AppError::new(
        ErrorCode::NotFound,
        format!("目标目录不存在：{}", destination_dir.display()),
      )
      .with_field("destinationDir"),
    );
  }

  let file_name = source
    .file_name()
    .ok_or_else(|| AppError::new(ErrorCode::InvalidInput, "源路径必须包含名称").with_field("sourcePath"))?;
  let destination = destination_dir.join(file_name);
  if path_exists_no_follow(&destination)? {
    return Err(
      AppError::new(
        ErrorCode::Conflict,
        format!("目标位置已存在同名内容：{}", destination.display()),
      )
      .with_field("destinationDir"),
    );
  }
  if is_same_or_inside(&destination, &source) {
    return Err(AppError::new(ErrorCode::InvalidInput, "目标目录不能位于源路径内部").with_field("destinationDir"));
  }

  ensure_not_managed(app, &source)?;

  let is_directory = metadata.is_dir();
  let name = request
    .name
    .as_deref()
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .map(ToOwned::to_owned)
    .unwrap_or_else(|| file_name.to_string_lossy().to_string());

  let _running = MoveGuard::acquire()?;
  let pending = move_path(app, &source, &destination)?;

  let link_type = match link_service::create_managed_link(&source, &destination, is_directory) {
    Ok(link_type) => link_type,
    Err(error) => {
      return Err(with_rollback(error, pending.rollback()));
    }
  };

  let record = ManagedLinkRecord {
    id: state_store::new_record_id(),
    name,
    kind: if is_directory {
      LinkKind::Directory
    } else {
      LinkKind::File
    },
    link_path: source.to_string_lossy().to_string(),
    target_path: destination.to_string_lossy().to_string(),
    link_type,
    management_mode: ManagementMode::Managed,
    created_at: current_timestamp()?,
  };

  let saved = {
    let _guard = state_store::lock_state(app);
    state_store::load_state(app).and_then(|(mut state, _)| {
      state.links.push(record.clone());
      state_store::save_state(app, &state).map(|_| ())
    })
  };

  if let Err(error) = saved {
    let _ = link_service::remove_link_only(&record);
    return Err(with_rollback(
      format!("保存状态失败：{error}").into(),
      pending.rollback(),
    ));
  }

  Ok(MoveOutcome {
    warning: pending.commit(),
  })
}

/// 撤销迁移：删除链接，把真实内容移回链接所在位置，并移除记录。
pub fn revert_link_job(app: &AppHandle, request: RevertLinkRequest) -> AppResult<MoveOutcome> {
  let (state, _) = state_store::load_state(app)?;
  let record = state
    .links
    .iter()
    .find(|record| record.id == request.id)
    .cloned()
    .ok_or_else(|| AppError::new(ErrorCode::NotFound, "未找到要撤销的链接记录"))?;

  if record.management_mode != ManagementMode::Managed {
    return Err(AppError::new(
      ErrorCode::InvalidInput,
      "仅记录的链接不是由本应用创建，不支持撤销",
    ));
  }

  let link_path = PathBuf::from(&record.link_path);
  let target_path = PathBuf::from(&record.target_path);
  if !link_service::is_expected_link(&record, &link_path)?
    || !link_service::link_points_to_target(&record, &link_path, &target_path)?
    || !target_path.exists()
  {
    return Err(AppError::new(
      ErrorCode::InvalidInput,
      "链接状态不正常，无法撤销；请先刷新状态或修复链接",
    ));
  }
  ensure_movable_location(&target_path)?;

  let _running = MoveGuard::acquire()?;
  link_service::remove_link_only(&record)?;

  let pending = match move_path(app, &target_path, &link_path) {
    Ok(pending) => pending,
    Err(error) => {
      let restored = link_service::create_link_of_type(&link_path, &target_path, record.link_type)
        .map_err(|restore_error| format!("重建原链接失败：{restore_error}"));
      return Err(with_rollback(error, restored));
    }
  };

  let saved = {
    let _guard = state_store::lock_state(app);
    state_store::load_state(app).and_then(|(mut state, _)| {
      state.links.retain(|item| item.id != record.id);
      state_store::save_state(app, &state).map(|_| ())
    })
  };

  if let Err(error) = saved {
    let rollback = pending.rollback().and_then(|_| {
      link_service::create_link_of_type(&link_path, &target_path, record.link_type)
        .map_err(|restore_error| format!("重建原链接失败：{restore_error}"))
    });
    return Err(with_rollback(format!("保存状态失败：{error}").into(), rollback));
  }

  Ok(MoveOutcome {
    warning: pending.commit(),
  })
}

pub fn cancel_move() {
  if MOVE_RUNNING.load(Ordering::SeqCst) {
    MOVE_CANCELLED.store(true, Ordering::SeqCst);
  }
}

/// 同一时间只允许一个迁移/撤销任务，取消标志随任务开始重置。
struct MoveGuard;

impl MoveGuard {
  fn acquire() -> AppResult<Self> {
    if MOVE_RUNNING.swap(true, Ordering::SeqCst) {
      return Err(AppError::new(ErrorCode::Conflict, "已有迁移任务正在进行，请等待完成"));
    }
    MOVE_CANCELLED.store(false, Ordering::SeqCst);
    Ok(Self)
  }
}

impl Drop for MoveGuard {
  fn drop(&mut self) {
    MOVE_RUNNING.store(false, Ordering::SeqCst);
  }
}

/// 已完成移动但尚未最终确认的操作；后续步骤失败时可回滚。
enum PendingMove {
  /// 同卷移动，直接 rename
  Renamed { from: PathBuf, to: PathBuf },
  /// 跨卷移动：源已改名为暂存路径，内容复制到了目标位置
  Copied {
    original: PathBuf,
    staging: PathBuf,
    destination: PathBuf,
  },
}

impl PendingMove {
  fn rollback(self) -> Result<(), String> {
    match self {
      Self::Renamed { from, to } => {
        fs::rename(&to, &from).map_err(|error| format!("移回 {} 失败：{error}", from.display()))
      }
      Self::Copied {
        original,
        staging,
        destination,
      } => {
        remove_path(&destination).map_err(|error| format!("清理目标副本失败：{}，{error}", destination.display()))?;
        fs::rename(&staging, &original).map_err(|error| format!("恢复源路径失败：{}，{error}", original.display()))
      }
    }
  }

  fn commit(self) -> Option<String> {
    match self {
      Self::Renamed { .. } => None,
      Self::Copied { staging, .. } => remove_path(&staging).err().map(|error| {
        format!(
          "迁移已完成，但原内容的暂存副本删除失败，请手动删除：{}（{error}）",
          staging.display()
        )
      }),
    }
  }
}

fn move_path(app: &AppHandle, source: &Path, destination: &Path) -> AppResult<PendingMove> {
  match fs::rename(source, destination) {
    Ok(()) => {
      return Ok(PendingMove::Renamed {
        from: source.to_path_buf(),
        to: destination.to_path_buf(),
      })
    }
    Err(error) if error.raw_os_error() == Some(ERROR_NOT_SAME_DEVICE) => {}
    Err(error) => return Err(describe_move_error(source, &error)),
  }

  let total_bytes = measure_size(source)?;
  let destination_parent = destination.parent().unwrap_or(destination);
  if let Some(free) = free_space(destination_parent) {
    if free < total_bytes {
      return Err(AppError::new(
        ErrorCode::InvalidInput,
        format!(
          "目标磁盘空间不足：需要 {}，可用 {}",
          format_bytes(total_bytes),
          format_bytes(free)
        ),
      ));
    }
  }

  // 先把源改名为同目录下的暂存路径：如果有文件被占用会在这里直接失败，避免复制到一半才发现无法删除
  let staging = staging_path(source);
  fs::rename(source, &staging).map_err(|error| describe_move_error(source, &error))?;

  let mut progress = ProgressReporter::new(total_bytes, |progress| {
    let _ = app.emit(MIGRATE_PROGRESS_EVENT, progress);
  });
  if let Err(error) = copy_recursive(&staging, destination, &mut progress) {
    let _ = remove_path(destination);
    let restored = fs::rename(&staging, source)
      .map_err(|restore_error| format!("恢复源路径失败，原内容位于 {}：{restore_error}", staging.display()));
    return Err(with_rollback(error, restored));
  }
  progress.finish();

  Ok(PendingMove::Copied {
    original: source.to_path_buf(),
    staging,
    destination: destination.to_path_buf(),
  })
}

fn copy_recursive(source: &Path, destination: &Path, progress: &mut ProgressReporter) -> AppResult<()> {
  if MOVE_CANCELLED.load(Ordering::SeqCst) {
    return Err(AppError::new(ErrorCode::Conflict, "迁移已取消"));
  }

  let metadata = fs::symlink_metadata(source).map_err(|error| io_error("读取", source, &error))?;

  if link_service::is_reparse_point(&metadata) {
    // 内部的链接按原样重建，而不是复制链接指向的内容
    let existing = link_service::detect_existing_link(source)?.ok_or_else(|| {
      AppError::new(
        ErrorCode::InvalidInput,
        format!("包含不支持的特殊文件（如云盘占位文件），无法迁移：{}", source.display()),
      )
    })?;
    return link_service::create_link_of_type(destination, &existing.target_path, existing.link_type)
      .map_err(|error| io_error("重建内部链接", destination, &error));
  }

  if metadata.is_dir() {
    fs::create_dir(destination).map_err(|error| io_error("创建目录", destination, &error))?;
    let entries = fs::read_dir(source).map_err(|error| io_error("读取目录", source, &error))?;
    for entry in entries {
      let entry = entry.map_err(|error| io_error("读取目录", source, &error))?;
      copy_recursive(&entry.path(), &destination.join(entry.file_name()), progress)?;
    }
    return Ok(());
  }

  progress.report(source, 0);
  fs::copy(source, destination).map_err(|error| io_error("复制文件", source, &error))?;
  progress.report(source, metadata.len());
  Ok(())
}

fn measure_size(path: &Path) -> AppResult<u64> {
  let metadata = fs::symlink_metadata(path).map_err(|error| io_error("读取", path, &error))?;
  if link_service::is_reparse_point(&metadata) {
    return Ok(0);
  }
  if !metadata.is_dir() {
    return Ok(metadata.len());
  }

  let mut total = 0;
  for entry in fs::read_dir(path).map_err(|error| io_error("读取目录", path, &error))? {
    let entry = entry.map_err(|error| io_error("读取目录", path, &error))?;
    total += measure_size(&entry.path())?;
  }
  Ok(total)
}

fn remove_path(path: &Path) -> io::Result<()> {
  match fs::symlink_metadata(path) {
    Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
    Err(error) => Err(error),
    // remove_dir_all 不会跟随内部的 junction / 符号链接，只删除链接本身
    Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(path),
    Ok(_) => fs::remove_file(path),
  }
}

fn staging_path(source: &Path) -> PathBuf {
  let mut text = source.as_os_str().to_os_string();
  text.push(STAGING_SUFFIX);
  PathBuf::from(text)
}

fn free_space(directory: &Path) -> Option<u64> {
  let wide = directory
    .as_os_str()
    .to_string_lossy()
    .encode_utf16()
    .chain(std::iter::once(0))
    .collect::<Vec<u16>>();
  let mut available = 0u64;
  let ok = unsafe {
    GetDiskFreeSpaceExW(
      wide.as_ptr(),
      &mut available,
      std::ptr::null_mut(),
      std::ptr::null_mut(),
    )
  };
  (ok != 0).then_some(available)
}

/// 拒绝迁移盘符根目录、系统目录和用户目录本身，避免破坏系统。
fn ensure_movable_location(path: &Path) -> AppResult<()> {
  let normalized = normalize_path(path);
  if path.parent().is_none() || normalized.len() <= 3 {
    return Err(AppError::new(ErrorCode::InvalidInput, "不能迁移盘符根目录"));
  }

  let protected_vars = ["SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"];
  for var in protected_vars {
    if let Ok(value) = std::env::var(var) {
      if is_same_or_inside(path, Path::new(&value)) {
        return Err(AppError::new(
          ErrorCode::InvalidInput,
          format!("不能迁移系统目录中的内容：{value}"),
        ));
      }
    }
  }

  for var in ["USERPROFILE", "PUBLIC"] {
    if let Ok(value) = std::env::var(var) {
      let protected = Path::new(&value);
      if normalize_path(path) == normalize_path(protected)
        || protected
          .parent()
          .is_some_and(|parent| normalize_path(path) == normalize_path(parent))
      {
        return Err(AppError::new(ErrorCode::InvalidInput, "不能迁移用户目录本身"));
      }
    }
  }

  Ok(())
}

fn ensure_not_managed(app: &AppHandle, path: &Path) -> AppResult<()> {
  let (state, _) = state_store::load_state(app)?;
  let normalized = normalize_path(path);
  let managed = state.links.iter().any(|record| {
    normalize_path(Path::new(&record.link_path)) == normalized
      || normalize_path(Path::new(&record.target_path)) == normalized
  });

  if managed {
    return Err(AppError::new(ErrorCode::Conflict, "该路径已经存在受管记录").with_field("sourcePath"));
  }
  Ok(())
}

fn is_same_or_inside(path: &Path, base: &Path) -> bool {
  let path = normalize_path(path);
  let base = normalize_path(base);
  path == base || path.starts_with(&format!("{}\\", base.trim_end_matches('\\')))
}

fn describe_move_error(path: &Path, error: &io::Error) -> AppError {
  // 5 = ERROR_ACCESS_DENIED, 32 = ERROR_SHARING_VIOLATION
  if matches!(error.raw_os_error(), Some(5 | 32)) {
    return AppError::new(
      ErrorCode::PermissionDenied,
      format!(
        "无法移动 {}：文件被占用或没有权限，请关闭正在使用它的程序后重试（{error}）",
        path.display()
      ),
    );
  }
  io_error("移动", path, error)
}

fn io_error(action: &str, path: &Path, error: &io::Error) -> AppError {
  AppError::from(format!("{action}失败：{}，{error}", path.display()))
}

fn with_rollback(error: AppError, rollback: Result<(), String>) -> AppError {
  match rollback {
    Ok(()) => error,
    Err(rollback_error) => AppError {
      message: format!("{}；回滚也失败了：{rollback_error}", error.message),
      ..error
    },
  }
}

fn format_bytes(bytes: u64) -> String {
  const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
  let mut value = bytes as f64;
  let mut unit = 0;
  while value >= 1024.0 && unit < UNITS.len() - 1 {
    value /= 1024.0;
    unit += 1;
  }
  format!("{value:.1} {}", UNITS[unit])
}

struct ProgressReporter<'a> {
  sink: Box<dyn FnMut(MoveProgress) + 'a>,
  copied: u64,
  total: u64,
  last_emit: Option<Instant>,
}

impl<'a> ProgressReporter<'a> {
  fn new(total: u64, sink: impl FnMut(MoveProgress) + 'a) -> Self {
    Self {
      sink: Box::new(sink),
      copied: 0,
      total,
      last_emit: None,
    }
  }

  fn report(&mut self, current: &Path, copied_delta: u64) {
    self.copied += copied_delta;
    if self.last_emit.is_some_and(|last| last.elapsed() < PROGRESS_INTERVAL) {
      return;
    }
    self.last_emit = Some(Instant::now());
    self.emit(current.to_string_lossy().to_string());
  }

  fn finish(&mut self) {
    self.copied = self.total;
    self.emit(String::new());
  }

  fn emit(&mut self, current_path: String) {
    (self.sink)(MoveProgress {
      copied_bytes: self.copied,
      total_bytes: self.total,
      current_path,
    });
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn detects_nested_paths() {
    assert!(is_same_or_inside(Path::new(r"C:\a\b"), Path::new(r"C:\a")));
    assert!(is_same_or_inside(Path::new(r"C:\A"), Path::new(r"c:\a\")));
    assert!(!is_same_or_inside(Path::new(r"C:\ab"), Path::new(r"C:\a")));
  }

  #[test]
  fn rejects_protected_locations() {
    assert!(ensure_movable_location(Path::new(r"C:\")).is_err());
    if let Ok(system_root) = std::env::var("SystemRoot") {
      assert!(ensure_movable_location(&Path::new(&system_root).join("Temp")).is_err());
    }
    if let Ok(profile) = std::env::var("USERPROFILE") {
      assert!(ensure_movable_location(Path::new(&profile)).is_err());
      assert!(ensure_movable_location(&Path::new(&profile).join("Downloads")).is_ok());
    }
  }

  #[test]
  fn formats_bytes() {
    assert_eq!(format_bytes(512), "512.0 B");
    assert_eq!(format_bytes(1536), "1.5 KB");
    assert_eq!(format_bytes(3 * 1024 * 1024 * 1024), "3.0 GB");
  }

  fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("go-symlink-test-{label}-{}", state_store::new_record_id()));
    fs::create_dir_all(&dir).unwrap();
    dir
  }

  #[test]
  fn copies_tree_and_recreates_inner_links() {
    let dir = temp_dir("copy");
    let source = dir.join("source");
    let outside = dir.join("outside");
    fs::create_dir_all(source.join("sub")).unwrap();
    fs::create_dir(&outside).unwrap();
    fs::write(source.join("a.txt"), b"aaaa").unwrap();
    fs::write(source.join("sub").join("b.txt"), b"bb").unwrap();
    link_service::create_link_of_type(&source.join("inner"), &outside, crate::state_store::LinkType::Junction).unwrap();

    assert_eq!(measure_size(&source).unwrap(), 6);

    let destination = dir.join("destination");
    let mut events = Vec::new();
    let mut progress = ProgressReporter::new(6, |event| events.push(event));
    copy_recursive(&source, &destination, &mut progress).unwrap();
    progress.finish();
    drop(progress);

    assert_eq!(fs::read(destination.join("sub").join("b.txt")).unwrap(), b"bb");
    let inner = link_service::detect_existing_link(&destination.join("inner"))
      .unwrap()
      .unwrap();
    assert_eq!(normalize_path(&inner.target_path), normalize_path(&outside));
    assert_eq!(events.last().unwrap().copied_bytes, 6);

    // 回滚：删除副本并把暂存目录改回原名；remove_dir_all 不能删到 junction 指向的外部目录
    let staging = staging_path(&source);
    fs::rename(&source, &staging).unwrap();
    fs::write(outside.join("keep.txt"), b"keep").unwrap();
    PendingMove::Copied {
      original: source.clone(),
      staging: staging.clone(),
      destination: destination.clone(),
    }
    .rollback()
    .unwrap();
    assert!(source.join("a.txt").exists());
    assert!(!destination.exists());
    assert!(!staging.exists());
    assert!(outside.join("keep.txt").exists());

    let _ = fs::remove_dir_all(dir);
  }

  #[test]
  fn staging_path_is_sibling() {
    assert_eq!(
      staging_path(Path::new(r"C:\data\cache")),
      PathBuf::from(r"C:\data\cache.go-symlink-moving")
    );
  }
}
