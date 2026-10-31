use std::collections::HashSet;
use std::fs;
use std::io;
use std::os::windows::fs::{symlink_dir, symlink_file, MetadataExt};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::AppHandle;
use windows_sys::Win32::Storage::FileSystem::GetDriveTypeW;

use crate::commands::{
  CreateLinkRequest, DeleteLinkRequest, ImportExistingLinkItem, ImportExistingLinksRequest,
  ManagedLinkView, RenameLinkRequest, ScanResult, ScannedLinkView,
};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::state_store::{self, LinkKind, LinkType, ManagedLinkRecord, ManagementMode};

const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x0010;
const MAX_SCAN_DEPTH: usize = 12;
const ERROR_PRIVILEGE_NOT_HELD: i32 = 1314;
const DRIVE_REMOTE: u32 = 4;

pub fn create_link_job(app: &AppHandle, request: CreateLinkRequest) -> AppResult<()> {
  let link_path = parse_absolute_path("链接路径", &request.link_path)
    .map_err(|error| AppError::new(ErrorCode::InvalidInput, error).with_field("linkPath"))?;
  let target_path = parse_absolute_path("目标路径", &request.target_path)
    .map_err(|error| AppError::new(ErrorCode::InvalidInput, error).with_field("targetPath"))?;

  let target_metadata = fs::metadata(&target_path).map_err(|_| {
    AppError::new(ErrorCode::NotFound, format!("目标路径不存在：{}", target_path.display())).with_field("targetPath")
  })?;
  let is_directory = target_metadata.is_dir();

  if same_path(&link_path, &target_path) {
    return Err(AppError::new(ErrorCode::InvalidInput, "链接路径不能与目标路径相同"));
  }

  let default_name = link_path
    .file_name()
    .ok_or_else(|| AppError::new(ErrorCode::InvalidInput, "链接路径必须包含名称").with_field("linkPath"))?
    .to_string_lossy()
    .to_string();
  let name = request
    .name
    .as_deref()
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .map(ToOwned::to_owned)
    .unwrap_or(default_name);

  let _guard = state_store::lock_state(app);
  let (mut state, _) = state_store::load_state(app)?;
  if state.links.iter().any(|record| {
    same_path_str(&record.link_path, &link_path) || same_path_str(&record.target_path, &target_path)
  }) {
    return Err(AppError::new(ErrorCode::Conflict, "该路径已经存在受管记录，请先删除旧记录"));
  }

  let parent = link_path.parent().ok_or_else(|| {
    AppError::new(ErrorCode::InvalidInput, format!("链接路径缺少父目录：{}", link_path.display())).with_field("linkPath")
  })?;
  let parent_metadata = fs::metadata(parent).map_err(|_| {
    AppError::new(ErrorCode::NotFound, format!("链接父目录不存在：{}", parent.display())).with_field("linkPath")
  })?;
  if !parent_metadata.is_dir() {
    return Err(
      AppError::new(ErrorCode::InvalidInput, format!("链接父路径不是目录：{}", parent.display())).with_field("linkPath"),
    );
  }

  let previous = if path_exists_no_follow(&link_path)? {
    let occupant = detect_path_occupant(&link_path)?;

    if !occupant.can_overwrite_as_link(is_directory) {
      let reason = if matches!(occupant, PathOccupant::EmptyDirectory) {
        "链接路径当前是空真实目录，但真实目标不是目录，不能在此处创建目录链接"
      } else {
        "链接路径已被占用，当前版本不会改动现有内容"
      };

      return Err(
        AppError::new(ErrorCode::InvalidInput, format!("{}：{}", reason, link_path.display())).with_field("linkPath"),
      );
    }

    if !request.overwrite_conflict {
      let action = if matches!(occupant, PathOccupant::EmptyDirectory) {
        "确认后会先删除该空目录，再创建新的目录链接。"
      } else {
        "确认后会先删除现有链接，再创建新的受管链接。"
      };

      return Err(AppError::new(
        ErrorCode::Conflict,
        format!("链接路径文件存在：{}。{}", link_path.display(), action),
      ));
    }

    Some(clear_link_path(&link_path, &occupant)?)
  } else {
    None
  };

  let link_type = match create_managed_link(&link_path, &target_path, is_directory) {
    Ok(link_type) => link_type,
    Err(error) => {
      restore_previous_occupant(&link_path, previous.as_ref());
      return Err(error);
    }
  };

  let record = ManagedLinkRecord {
    id: state_store::new_record_id(),
    name,
    kind: if is_directory { LinkKind::Directory } else { LinkKind::File },
    link_path: link_path.to_string_lossy().to_string(),
    target_path: target_path.to_string_lossy().to_string(),
    link_type,
    management_mode: ManagementMode::Managed,
    created_at: current_timestamp()?,
  };

  state.links.push(record.clone());

  if let Err(error) = state_store::save_state(app, &state) {
    let _ = remove_link_only(&record);
    restore_previous_occupant(&link_path, previous.as_ref());
    return Err(format!("保存状态失败：{error}").into());
  }

  Ok(())
}

/// 覆盖冲突前链接路径上原有的内容，用于后续步骤失败时还原现场。
enum PreviousOccupant {
  EmptyDirectory,
  Link { link_type: LinkType, target_path: PathBuf },
}

fn clear_link_path(link_path: &Path, occupant: &PathOccupant) -> Result<PreviousOccupant, String> {
  if matches!(occupant, PathOccupant::EmptyDirectory) {
    fs::remove_dir(link_path)
      .map_err(|error| format!("删除空目录失败：{}，{error}", link_path.display()))?;
    return Ok(PreviousOccupant::EmptyDirectory);
  }

  let existing = detect_existing_link(link_path)?
    .ok_or_else(|| format!("路径不是链接，无法删除：{}", link_path.display()))?;
  remove_link_path(link_path)?;
  Ok(PreviousOccupant::Link {
    link_type: existing.link_type,
    target_path: existing.target_path,
  })
}

fn restore_previous_occupant(link_path: &Path, previous: Option<&PreviousOccupant>) {
  let result = match previous {
    None => return,
    Some(PreviousOccupant::EmptyDirectory) => fs::create_dir(link_path),
    Some(PreviousOccupant::Link { link_type, target_path }) => create_link_of_type(link_path, target_path, *link_type),
  };

  if let Err(error) = result {
    log::warn!("还原链接路径原有内容失败：{}，{error}", link_path.display());
  }
}

pub fn delete_link_job(app: &AppHandle, request: DeleteLinkRequest) -> Result<(), String> {
  let _guard = state_store::lock_state(app);
  let (mut state, _) = state_store::load_state(app)?;
  let index = state
    .links
    .iter()
    .position(|record| record.id == request.id)
    .ok_or_else(|| "未找到要删除的受管链接记录".to_string())?;

  let record = state.links[index].clone();
  let link_path = PathBuf::from(&record.link_path);

  if path_exists_no_follow(&link_path)? {
    let target_path = PathBuf::from(&record.target_path);
    if !is_expected_link(&record, &link_path)? || !link_points_to_target(&record, &link_path, &target_path)? {
      return Err(format!(
        "路径 {} 不是当前记录对应的链接，已拒绝删除以避免误删其他内容",
        link_path.display()
      ));
    }

    remove_link_only(&record)?;
  }

  state.links.remove(index);
  state_store::save_state(app, &state)?;

  Ok(())
}

pub fn rename_link_job(app: &AppHandle, request: RenameLinkRequest) -> Result<(), String> {
  let name = request.name.trim();
  if name.is_empty() {
    return Err("名称不能为空".to_string());
  }

  let _guard = state_store::lock_state(app);
  let (mut state, _) = state_store::load_state(app)?;
  let record = state
    .links
    .iter_mut()
    .find(|record| record.id == request.id)
    .ok_or_else(|| "未找到要修改的受管链接记录".to_string())?;

  record.name = name.to_string();
  state_store::save_state(app, &state)?;

  Ok(())
}

pub fn scan_existing_links(app: &AppHandle, roots: Vec<String>) -> Result<ScanResult, String> {
  let (state, _) = state_store::load_state(app)?;
  let managed_paths = state
    .links
    .iter()
    .map(|record| normalize_path(Path::new(&record.link_path)))
    .collect::<HashSet<_>>();
  let mut context = ScanContext {
    managed_paths: &managed_paths,
    seen: HashSet::new(),
    items: Vec::new(),
    warnings: Vec::new(),
  };

  for root in roots {
    let root_path = PathBuf::from(&root);
    scan_directory(&root_path, &root, 0, &mut context);
  }

  let ScanContext { mut items, warnings, .. } = context;
  items.sort_by(|left, right| left.link_path.cmp(&right.link_path));
  Ok(ScanResult { items, warnings })
}

pub fn import_existing_links(app: &AppHandle, request: ImportExistingLinksRequest) -> Result<(), String> {
  if request.items.is_empty() {
    return Err("至少选择一个扫描结果".to_string());
  }

  let _guard = state_store::lock_state(app);
  let (mut state, _) = state_store::load_state(app)?;
  let mut seen_link_paths = state
    .links
    .iter()
    .map(|record| normalize_path(Path::new(&record.link_path)))
    .collect::<HashSet<_>>();
  let mut seen_target_paths = state
    .links
    .iter()
    .map(|record| normalize_path(Path::new(&record.target_path)))
    .collect::<HashSet<_>>();

  for item in request.items {
    let item = normalize_import_item(item)?;
    let normalized_link = normalize_path(Path::new(&item.link_path));
    let normalized_target = normalize_path(Path::new(&item.target_path));

    if seen_link_paths.contains(&normalized_link) {
      return Err(format!("链接已在受管列表中：{}", item.link_path));
    }

    if seen_target_paths.contains(&normalized_target) {
      return Err(format!("真实目标已被其他记录占用：{}", item.target_path));
    }

    let link_path = PathBuf::from(&item.link_path);

    if !path_exists_no_follow(&link_path)? {
      return Err(format!("链接已不存在：{}", item.link_path));
    }

    let detected = detect_existing_link(&link_path)?
      .ok_or_else(|| format!("路径不是受支持的软链接：{}", item.link_path))?;

    if detected.kind != item.kind || detected.link_type != item.link_type {
      return Err(format!("链接类型已变化，请重新扫描：{}", item.link_path));
    }

    if normalize_path(&detected.target_path) != normalized_target {
      return Err(format!("链接目标已变化，请重新扫描：{}", item.link_path));
    }

    let record = ManagedLinkRecord {
      id: state_store::new_record_id(),
      name: item.name,
      kind: item.kind,
      link_path: item.link_path,
      target_path: item.target_path,
      link_type: item.link_type,
      management_mode: ManagementMode::Tracked,
      created_at: current_timestamp()?,
    };

    seen_link_paths.insert(normalized_link);
    seen_target_paths.insert(normalized_target);
    state.links.push(record);
  }

  state_store::save_state(app, &state)?;
  Ok(())
}

pub fn to_managed_link_view(record: &ManagedLinkRecord) -> Result<ManagedLinkView, String> {
  let link_path = PathBuf::from(&record.link_path);
  let target_path = PathBuf::from(&record.target_path);
  let occupant_exists = path_exists_no_follow(&link_path)?;
  let target_exists = target_path.exists();
  let expected_link = if occupant_exists {
    is_expected_link(record, &link_path)?
  } else {
    false
  };
  let points_to_target = if expected_link {
    link_points_to_target(record, &link_path, &target_path)?
  } else {
    false
  };

  let (status, status_text) = if expected_link && target_exists && points_to_target {
    ("healthy", "正常")
  } else if !occupant_exists && target_exists {
    ("missing-link", "原链接缺失")
  } else if expected_link && !target_exists {
    ("missing-target", "真实目标缺失")
  } else if occupant_exists && !expected_link {
    ("broken", "原路径已被其他内容占用")
  } else {
    ("broken", "链接状态异常")
  };

  Ok(ManagedLinkView {
    id: record.id.clone(),
    name: record.name.clone(),
    kind: record.kind,
    link_path: record.link_path.clone(),
    target_path: record.target_path.clone(),
    link_type: record.link_type,
    management_mode: record.management_mode,
    created_at: record.created_at,
    status: status.to_string(),
    status_text: status_text.to_string(),
  })
}

fn normalize_import_item(item: ImportExistingLinkItem) -> Result<ImportExistingLinkItem, String> {
  if item.name.trim().is_empty() {
    return Err("导入项名称不能为空".to_string());
  }

  let link_path = parse_absolute_path("链接路径", &item.link_path)?;
  let target_path = parse_absolute_path("真实目标", &item.target_path)?;

  Ok(ImportExistingLinkItem {
    name: item.name.trim().to_string(),
    kind: item.kind,
    link_path: normalize_path(&link_path),
    target_path: normalize_path(&target_path),
    link_type: item.link_type,
  })
}

struct ScanContext<'a> {
  managed_paths: &'a HashSet<String>,
  seen: HashSet<String>,
  items: Vec<ScannedLinkView>,
  warnings: Vec<String>,
}

/// 递归扫描目录；无权限或读取失败的路径记入 warnings 后跳过，不中断整次扫描。
fn scan_directory(directory: &Path, scan_root: &str, depth: usize, context: &mut ScanContext) {
  if depth > MAX_SCAN_DEPTH {
    context
      .warnings
      .push(format!("超过最大扫描深度 {MAX_SCAN_DEPTH}，已跳过：{}", directory.display()));
    return;
  }

  let entries = match fs::read_dir(directory) {
    Ok(entries) => entries,
    Err(error) => {
      context.warnings.push(format!("读取目录失败：{}，{error}", directory.display()));
      return;
    }
  };

  for entry in entries {
    let entry = match entry {
      Ok(entry) => entry,
      Err(error) => {
        context.warnings.push(format!("读取目录项失败：{}，{error}", directory.display()));
        continue;
      }
    };
    let path = entry.path();
    let metadata = match fs::symlink_metadata(&path) {
      Ok(metadata) => metadata,
      Err(error) => {
        context.warnings.push(format!("读取路径信息失败：{}，{error}", path.display()));
        continue;
      }
    };

    if is_reparse_point(&metadata) {
      match detect_existing_link(&path) {
        Ok(Some(scanned)) => {
          let normalized_link = normalize_path(&path);
          if context.seen.insert(normalized_link.clone()) {
            context.items.push(ScannedLinkView {
              id: normalized_link.clone(),
              name: scanned.name,
              kind: scanned.kind,
              link_path: normalized_link.clone(),
              target_path: normalize_path(&scanned.target_path),
              link_type: scanned.link_type,
              scan_root: scan_root.to_string(),
              target_exists: scanned.target_exists,
              already_managed: context.managed_paths.contains(&normalized_link),
            });
          }
        }
        Ok(None) => {}
        Err(error) => context.warnings.push(error),
      }

      continue;
    }

    if metadata.is_dir() {
      scan_directory(&path, scan_root, depth + 1, context);
    }
  }
}

struct ExistingLink {
  name: String,
  kind: LinkKind,
  link_type: LinkType,
  target_path: PathBuf,
  target_exists: bool,
}

enum PathOccupant {
  Junction,
  DirectorySymlink,
  FileSymlink,
  OtherReparsePoint,
  EmptyDirectory,
  Directory,
  File,
}

impl PathOccupant {
  fn can_overwrite_as_link(&self, is_directory_target: bool) -> bool {
    matches!(self, Self::Junction | Self::DirectorySymlink | Self::FileSymlink)
      || (matches!(self, Self::EmptyDirectory) && is_directory_target)
  }
}

fn detect_path_occupant(path: &Path) -> Result<PathOccupant, String> {
  let metadata = fs::symlink_metadata(path)
    .map_err(|error| format!("读取路径信息失败：{}，{error}", path.display()))?;

  if junction::exists(path).unwrap_or(false) {
    return Ok(PathOccupant::Junction);
  }

  if metadata.file_type().is_symlink() {
    let is_directory = metadata.file_attributes() & FILE_ATTRIBUTE_DIRECTORY != 0;
    return Ok(if is_directory {
      PathOccupant::DirectorySymlink
    } else {
      PathOccupant::FileSymlink
    });
  }

  if is_reparse_point(&metadata) {
    return Ok(PathOccupant::OtherReparsePoint);
  }

  if metadata.is_dir() {
    return Ok(if is_empty_directory(path)? {
      PathOccupant::EmptyDirectory
    } else {
      PathOccupant::Directory
    });
  }

  Ok(PathOccupant::File)
}

fn detect_existing_link(path: &Path) -> Result<Option<ExistingLink>, String> {
  let metadata = fs::symlink_metadata(path)
    .map_err(|error| format!("读取路径信息失败：{}，{error}", path.display()))?;

  if !is_reparse_point(&metadata) {
    return Ok(None);
  }

  let name = path
    .file_name()
    .map(|value| value.to_string_lossy().to_string())
    .ok_or_else(|| format!("路径缺少名称：{}", path.display()))?;

  let attributes = metadata.file_attributes();
  let is_directory = attributes & FILE_ATTRIBUTE_DIRECTORY != 0;

  if junction::exists(path).unwrap_or(false) {
    let target_path = junction::get_target(path)
      .map_err(|error| format!("读取 junction 目标失败：{}，{error}", path.display()))?;

    return Ok(Some(ExistingLink {
      name,
      kind: LinkKind::Directory,
      link_type: LinkType::Junction,
      target_exists: target_path.exists(),
      target_path,
    }));
  }

  if metadata.file_type().is_symlink() {
    let target_path = fs::read_link(path)
      .map_err(|error| format!("读取符号链接目标失败：{}，{error}", path.display()))?;
    let absolute_target = absolutize_link_target(path, &target_path);

    return Ok(Some(ExistingLink {
      name,
      kind: if is_directory { LinkKind::Directory } else { LinkKind::File },
      link_type: if is_directory { LinkType::DirectorySymlink } else { LinkType::FileSymlink },
      target_exists: absolute_target.exists(),
      target_path: absolute_target,
    }));
  }

  Ok(None)
}

fn absolutize_link_target(link_path: &Path, target_path: &Path) -> PathBuf {
  if target_path.is_absolute() {
    return target_path.to_path_buf();
  }

  link_path
    .parent()
    .map(|parent| parent.join(target_path))
    .unwrap_or_else(|| target_path.to_path_buf())
}

fn create_managed_link(link_path: &Path, target_path: &Path, is_directory: bool) -> AppResult<LinkType> {
  // junction 只能指向本地卷，网络路径改用目录符号链接
  let link_type = match (is_directory, is_remote_path(target_path)) {
    (true, false) => LinkType::Junction,
    (true, true) => LinkType::DirectorySymlink,
    (false, _) => LinkType::FileSymlink,
  };

  create_link_of_type(link_path, target_path, link_type).map_err(|error| {
    if error.raw_os_error() == Some(ERROR_PRIVILEGE_NOT_HELD) {
      return AppError::new(
        ErrorCode::PermissionDenied,
        "创建符号链接需要额外权限：请在 Windows 设置中开启「开发者模式」，或以管理员身份运行本应用",
      );
    }

    let label = match link_type {
      LinkType::Junction => "目录 junction",
      LinkType::DirectorySymlink => "目录符号链接",
      LinkType::FileSymlink => "文件符号链接",
    };
    AppError::from(format!(
      "创建{label}失败：{} -> {}，{error}",
      link_path.display(),
      target_path.display()
    ))
  })?;

  Ok(link_type)
}

pub(crate) fn create_link_of_type(link_path: &Path, target_path: &Path, link_type: LinkType) -> io::Result<()> {
  match link_type {
    LinkType::Junction => junction::create(target_path, link_path),
    LinkType::DirectorySymlink => symlink_dir(target_path, link_path),
    LinkType::FileSymlink => symlink_file(target_path, link_path),
  }
}

/// UNC 路径或映射的网络驱动器。
fn is_remote_path(path: &Path) -> bool {
  let text = normalize_path(path);
  if text.starts_with(r"\\") {
    return true;
  }

  let Some(drive) = text.get(..2).filter(|prefix| prefix.ends_with(':')) else {
    return false;
  };
  let root = format!("{drive}\\")
    .encode_utf16()
    .chain(std::iter::once(0))
    .collect::<Vec<u16>>();
  unsafe { GetDriveTypeW(root.as_ptr()) == DRIVE_REMOTE }
}

pub(crate) fn remove_link_only(record: &ManagedLinkRecord) -> Result<(), String> {
  let link_path = PathBuf::from(&record.link_path);
  if !path_exists_no_follow(&link_path)? {
    return Ok(());
  }

  match record.link_type {
    LinkType::Junction => delete_junction(&link_path),
    LinkType::DirectorySymlink => fs::remove_dir(&link_path)
      .map_err(|error| format!("删除目录符号链接失败：{}，{error}", link_path.display())),
    LinkType::FileSymlink => fs::remove_file(&link_path)
      .map_err(|error| format!("删除文件符号链接失败：{}，{error}", link_path.display())),
  }
}

/// `junction::delete` 只清除重解析点数据，原位置会残留一个空目录，需要一并移除。
fn delete_junction(path: &Path) -> Result<(), String> {
  junction::delete(path).map_err(|error| format!("删除 junction 失败：{}，{error}", path.display()))?;

  if path.is_dir() && is_empty_directory(path)? {
    fs::remove_dir(path).map_err(|error| format!("删除 junction 失败：{}，{error}", path.display()))?;
  }

  Ok(())
}

fn remove_link_path(path: &Path) -> Result<(), String> {
  let metadata = fs::symlink_metadata(path)
    .map_err(|error| format!("读取路径信息失败：{}，{error}", path.display()))?;

  if junction::exists(path).unwrap_or(false) {
    return delete_junction(path);
  }

  if metadata.file_type().is_symlink() {
    return fs::remove_file(path)
      .or_else(|_| fs::remove_dir(path))
      .map_err(|error| format!("删除链接失败：{}，{error}", path.display()));
  }

  Err(format!("路径不是链接，无法删除：{}", path.display()))
}

pub(crate) fn is_expected_link(record: &ManagedLinkRecord, link_path: &Path) -> Result<bool, String> {
  if !path_exists_no_follow(link_path)? {
    return Ok(false);
  }

  Ok(match record.link_type {
    LinkType::Junction => junction::exists(link_path).unwrap_or(false),
    LinkType::FileSymlink | LinkType::DirectorySymlink => fs::symlink_metadata(link_path)
      .map(|metadata| metadata.file_type().is_symlink())
      .unwrap_or(false),
  })
}

pub(crate) fn link_points_to_target(
  record: &ManagedLinkRecord,
  link_path: &Path,
  target_path: &Path,
) -> Result<bool, String> {
  let actual_target = match record.link_type {
    LinkType::Junction => junction::get_target(link_path).map_err(|error| {
      format!("读取 junction 目标失败：{}，{error}", link_path.display())
    })?,
    LinkType::FileSymlink | LinkType::DirectorySymlink => fs::read_link(link_path)
      .map_err(|error| format!("读取符号链接目标失败：{}，{error}", link_path.display()))?,
  };
  let actual_target = absolutize_link_target(link_path, &actual_target);

  Ok(normalize_path(&actual_target) == normalize_path(target_path))
}

pub fn parse_absolute_path(label: &str, value: &str) -> Result<PathBuf, String> {
  let trimmed = value.trim();
  if trimmed.is_empty() {
    return Err(format!("{label}不能为空"));
  }

  let path = PathBuf::from(trimmed);
  if !path.is_absolute() {
    return Err(format!("{label}必须是绝对路径：{trimmed}"));
  }

  Ok(path)
}

fn path_exists_no_follow(path: &Path) -> Result<bool, String> {
  match fs::symlink_metadata(path) {
    Ok(_) => Ok(true),
    Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
    Err(error) => Err(format!("检查路径失败：{}，{error}", path.display())),
  }
}

fn is_empty_directory(path: &Path) -> Result<bool, String> {
  let mut entries = fs::read_dir(path)
    .map_err(|error| format!("读取目录失败：{}，{error}", path.display()))?;

  Ok(entries.next().is_none())
}


fn current_timestamp() -> Result<i64, String> {
  let duration = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map_err(|error| format!("获取当前时间失败：{error}"))?;

  Ok(duration.as_millis() as i64)
}

fn same_path(left: &Path, right: &Path) -> bool {
  normalize_path(left) == normalize_path(right)
}

fn same_path_str(left: &str, right: &Path) -> bool {
  normalize_path(Path::new(left)) == normalize_path(right)
}

pub fn normalize_path(path: &Path) -> String {
  let mut text = path.to_string_lossy().replace('/', "\\");

  if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
    text = format!(r"\\{}", rest);
  } else if let Some(rest) = text.strip_prefix(r"\\?\") {
    text = rest.to_string();
  }

  while text.ends_with('\\') && text.len() > 3 && !text.ends_with(":\\") {
    text.pop();
  }

  text.make_ascii_lowercase();
  text
}

fn is_reparse_point(metadata: &fs::Metadata) -> bool {
  metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(test)]
mod tests {
  use super::*;

  fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("go-symlink-test-{label}-{}", state_store::new_record_id()));
    fs::create_dir_all(&dir).unwrap();
    dir
  }

  fn record_for(link_path: &Path, target_path: &Path, link_type: LinkType) -> ManagedLinkRecord {
    ManagedLinkRecord {
      id: "test".to_string(),
      name: "test".to_string(),
      kind: LinkKind::Directory,
      link_path: link_path.to_string_lossy().to_string(),
      target_path: target_path.to_string_lossy().to_string(),
      link_type,
      management_mode: ManagementMode::Managed,
      created_at: 0,
    }
  }

  #[test]
  fn normalizes_windows_paths() {
    assert_eq!(normalize_path(Path::new(r"C:\Users\Demo\")), r"c:\users\demo");
    assert_eq!(normalize_path(Path::new(r"C:\")), r"c:\");
    assert_eq!(normalize_path(Path::new("D:/Data/Cache")), r"d:\data\cache");
    assert_eq!(normalize_path(Path::new(r"\\?\C:\Data")), r"c:\data");
    assert_eq!(normalize_path(Path::new(r"\\?\UNC\nas\share")), r"\\nas\share");
  }

  #[test]
  fn absolutizes_relative_link_target() {
    assert_eq!(
      absolutize_link_target(Path::new(r"C:\links\cache"), Path::new(r"..\data")),
      PathBuf::from(r"C:\links\..\data")
    );
    assert_eq!(
      absolutize_link_target(Path::new(r"C:\links\cache"), Path::new(r"D:\data")),
      PathBuf::from(r"D:\data")
    );
  }

  #[test]
  fn requires_absolute_paths() {
    assert!(parse_absolute_path("路径", r"C:\data").is_ok());
    assert!(parse_absolute_path("路径", "data").is_err());
    assert!(parse_absolute_path("路径", "   ").is_err());
  }

  #[test]
  fn detects_remote_paths() {
    assert!(is_remote_path(Path::new(r"\\nas\share\data")));
    assert!(!is_remote_path(&std::env::temp_dir()));
  }

  #[test]
  fn junction_lifecycle() {
    let dir = temp_dir("junction");
    let target = dir.join("target");
    let link = dir.join("link");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("file.txt"), b"hello").unwrap();

    let link_type = create_managed_link(&link, &target, true).unwrap();
    assert_eq!(link_type, LinkType::Junction);
    assert_eq!(fs::read(link.join("file.txt")).unwrap(), b"hello");

    let detected = detect_existing_link(&link).unwrap().unwrap();
    assert_eq!(detected.kind, LinkKind::Directory);
    assert_eq!(detected.link_type, LinkType::Junction);
    assert_eq!(normalize_path(&detected.target_path), normalize_path(&target));
    assert!(matches!(detect_path_occupant(&link).unwrap(), PathOccupant::Junction));

    let record = record_for(&link, &target, LinkType::Junction);
    assert!(is_expected_link(&record, &link).unwrap());
    assert!(link_points_to_target(&record, &link, &target).unwrap());
    assert_eq!(to_managed_link_view(&record).unwrap().status, "healthy");

    remove_link_only(&record).unwrap();
    assert!(!path_exists_no_follow(&link).unwrap());
    assert!(target.join("file.txt").exists(), "删除链接不能影响真实目标");
    assert_eq!(to_managed_link_view(&record).unwrap().status, "missing-link");

    let _ = fs::remove_dir_all(dir);
  }

  #[test]
  fn restores_previous_occupant_after_failure() {
    let dir = temp_dir("restore");
    let old_target = dir.join("old");
    let link = dir.join("link");
    fs::create_dir(&old_target).unwrap();
    create_link_of_type(&link, &old_target, LinkType::Junction).unwrap();

    let occupant = detect_path_occupant(&link).unwrap();
    let previous = clear_link_path(&link, &occupant).unwrap();
    assert!(!path_exists_no_follow(&link).unwrap());

    restore_previous_occupant(&link, Some(&previous));
    let detected = detect_existing_link(&link).unwrap().unwrap();
    assert_eq!(normalize_path(&detected.target_path), normalize_path(&old_target));

    let empty = dir.join("empty");
    fs::create_dir(&empty).unwrap();
    let previous = clear_link_path(&empty, &PathOccupant::EmptyDirectory).unwrap();
    restore_previous_occupant(&empty, Some(&previous));
    assert!(empty.is_dir());

    delete_junction(&link).unwrap();
    let _ = fs::remove_dir_all(dir);
  }

  #[test]
  fn scan_skips_unreadable_paths_and_collects_links() {
    let dir = temp_dir("scan");
    let target = dir.join("target");
    let nested = dir.join("a").join("b");
    fs::create_dir(&target).unwrap();
    fs::create_dir_all(&nested).unwrap();
    create_link_of_type(&nested.join("link"), &target, LinkType::Junction).unwrap();

    let managed = HashSet::new();
    let mut context = ScanContext {
      managed_paths: &managed,
      seen: HashSet::new(),
      items: Vec::new(),
      warnings: Vec::new(),
    };
    let root = dir.to_string_lossy().to_string();
    scan_directory(&dir, &root, 0, &mut context);
    scan_directory(&dir.join("missing"), &root, 0, &mut context);

    assert_eq!(context.items.len(), 1);
    assert_eq!(context.items[0].link_type, LinkType::Junction);
    assert_eq!(context.warnings.len(), 1, "不存在的目录应记为警告而不是报错");

    delete_junction(&nested.join("link")).unwrap();
    let _ = fs::remove_dir_all(dir);
  }
}
