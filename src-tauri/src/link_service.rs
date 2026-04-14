use std::collections::HashSet;
use std::fs;
use std::io;
use std::os::windows::fs::{symlink_file, MetadataExt};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::AppHandle;

use crate::commands::{
  CreateLinkRequest, DeleteLinkRequest, ImportExistingLinkItem, ImportExistingLinksRequest,
  ManagedLinkView, RenameLinkRequest, ScannedLinkView,
};
use crate::state_store::{self, ManagedLinkRecord};

const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x0010;

pub fn create_link_job(app: &AppHandle, request: CreateLinkRequest) -> Result<(), String> {
  let link_path = parse_absolute_path("链接路径", &request.link_path)?;
  let target_path = parse_absolute_path("目标路径", &request.target_path)?;

  let target_metadata = fs::metadata(&target_path)
    .map_err(|_| format!("目标路径不存在：{}", target_path.display()))?;
  let is_directory = target_metadata.is_dir();

  if same_path(&link_path, &target_path) {
    return Err("链接路径不能与目标路径相同".to_string());
  }

  let default_name = link_path
    .file_name()
    .ok_or_else(|| "链接路径必须包含名称".to_string())?
    .to_string_lossy()
    .to_string();
  let name = request
    .name
    .as_deref()
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .map(ToOwned::to_owned)
    .unwrap_or(default_name);

  let (mut state, _) = state_store::load_state(app)?;
  if state.links.iter().any(|record| {
    same_path_str(&record.link_path, &link_path) || same_path_str(&record.target_path, &target_path)
  }) {
    return Err("该路径已经存在受管记录，请先删除旧记录".to_string());
  }

  let parent = link_path
    .parent()
    .ok_or_else(|| format!("链接路径缺少父目录：{}", link_path.display()))?;
  let parent_metadata = fs::metadata(parent)
    .map_err(|_| format!("链接父目录不存在：{}", parent.display()))?;
  if !parent_metadata.is_dir() {
    return Err(format!("链接父路径不是目录：{}", parent.display()));
  }

  if path_exists_no_follow(&link_path)? {
    let occupant = detect_path_occupant(&link_path)?;

    if !occupant.can_overwrite_as_link(is_directory) {
      let reason = if matches!(occupant, PathOccupant::EmptyDirectory) {
        "链接路径当前是空真实目录，但真实目标不是目录，不能在此处创建目录链接"
      } else {
        "链接路径已被占用，当前版本不会改动现有内容"
      };

      return Err(format!("{}：{}", reason, link_path.display()));
    }

    if !request.overwrite_conflict {
      let action = if matches!(occupant, PathOccupant::EmptyDirectory) {
        "确认后会先删除该空目录，再创建新的目录链接。"
      } else {
        "确认后会先删除现有链接，再创建新的受管链接。"
      };

      return Err(format!(
        "CONFLICT:链接路径文件存在：{}。{}",
        link_path.display(),
        action
      ));
    }

    if matches!(occupant, PathOccupant::EmptyDirectory) {
      fs::remove_dir(&link_path)
        .map_err(|error| format!("删除空目录失败：{}，{error}", link_path.display()))?;
    } else {
      remove_link_path(&link_path)?;
    }
  }

  let link_type = create_managed_link(&link_path, &target_path, is_directory)?;

  let record = ManagedLinkRecord {
    id: build_record_id(&name),
    name,
    kind: if is_directory {
      "directory".to_string()
    } else {
      "file".to_string()
    },
    link_path: link_path.to_string_lossy().to_string(),
    target_path: target_path.to_string_lossy().to_string(),
    link_type,
    management_mode: "managed".to_string(),
    created_at: current_timestamp()?,
  };

  state.links.push(record.clone());

  if let Err(error) = state_store::save_state(app, &state) {
    let _ = remove_link_only(&record);
    return Err(format!("保存状态失败：{error}"));
  }

  Ok(())
}

pub fn delete_link_job(app: &AppHandle, request: DeleteLinkRequest) -> Result<(), String> {
  let (mut state, _) = state_store::load_state(app)?;
  let index = state
    .links
    .iter()
    .position(|record| record.id == request.id)
    .ok_or_else(|| "未找到要删除的受管链接记录".to_string())?;

  let record = state.links[index].clone();
  let link_path = PathBuf::from(&record.link_path);

  if path_exists_no_follow(&link_path)? {
    if !is_expected_link(&record, &link_path)? {
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

pub fn scan_existing_links(app: &AppHandle, roots: Vec<String>) -> Result<Vec<ScannedLinkView>, String> {
  let (state, _) = state_store::load_state(app)?;
  let managed_paths = state
    .links
    .iter()
    .map(|record| normalize_path(Path::new(&record.link_path)))
    .collect::<HashSet<_>>();
  let mut seen = HashSet::new();
  let mut results = Vec::new();

  for root in roots {
    let root_path = PathBuf::from(&root);
    scan_directory(&root_path, &root, &managed_paths, &mut seen, &mut results)?;
  }

  results.sort_by(|left, right| left.link_path.cmp(&right.link_path));
  Ok(results)
}

pub fn import_existing_links(app: &AppHandle, request: ImportExistingLinksRequest) -> Result<(), String> {
  if request.items.is_empty() {
    return Err("至少选择一个扫描结果".to_string());
  }

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
      id: build_record_id(&item.name),
      name: item.name,
      kind: item.kind,
      link_path: item.link_path,
      target_path: item.target_path,
      link_type: item.link_type,
      management_mode: "tracked".to_string(),
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
    kind: record.kind.clone(),
    link_path: record.link_path.clone(),
    target_path: record.target_path.clone(),
    link_type: record.link_type.clone(),
    management_mode: record.management_mode.clone(),
    created_at: record.created_at,
    status: status.to_string(),
    status_text: status_text.to_string(),
  })
}

fn normalize_import_item(item: ImportExistingLinkItem) -> Result<ImportExistingLinkItem, String> {
  if item.name.trim().is_empty() {
    return Err("导入项名称不能为空".to_string());
  }

  let kind = match item.kind.as_str() {
    "file" | "directory" => item.kind,
    _ => return Err(format!("不支持的导入类型：{}", item.kind)),
  };

  let link_type = match item.link_type.as_str() {
    "file-symlink" | "directory-symlink" | "junction" => item.link_type,
    _ => return Err(format!("不支持的链接类型：{}", item.link_type)),
  };

  let link_path = parse_absolute_path("链接路径", &item.link_path)?;
  let target_path = parse_absolute_path("真实目标", &item.target_path)?;

  Ok(ImportExistingLinkItem {
    name: item.name.trim().to_string(),
    kind,
    link_path: normalize_path(&link_path),
    target_path: normalize_path(&target_path),
    link_type,
  })
}

fn scan_directory(
  directory: &Path,
  scan_root: &str,
  managed_paths: &HashSet<String>,
  seen: &mut HashSet<String>,
  results: &mut Vec<ScannedLinkView>,
) -> Result<(), String> {
  let entries = fs::read_dir(directory)
    .map_err(|error| format!("读取目录失败：{}，{error}", directory.display()))?;

  for entry in entries {
    let entry = entry.map_err(|error| format!("读取目录项失败：{error}"))?;
    let path = entry.path();
    let metadata = fs::symlink_metadata(&path)
      .map_err(|error| format!("读取路径信息失败：{}，{error}", path.display()))?;

    if is_reparse_point(&metadata) {
      if let Some(scanned) = detect_existing_link(&path)? {
        let normalized_link = normalize_path(&path);
        if seen.insert(normalized_link.clone()) {
          results.push(ScannedLinkView {
            id: normalized_link.clone(),
            name: scanned.name,
            kind: scanned.kind,
            link_path: normalized_link.clone(),
            target_path: normalize_path(&scanned.target_path),
            link_type: scanned.link_type,
            scan_root: scan_root.to_string(),
            target_exists: scanned.target_exists,
            already_managed: managed_paths.contains(&normalized_link),
          });
        }
      }

      continue;
    }

    if metadata.is_dir() {
      scan_directory(&path, scan_root, managed_paths, seen, results)?;
    }
  }

  Ok(())
}

struct ExistingLink {
  name: String,
  kind: String,
  link_type: String,
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
      kind: "directory".to_string(),
      link_type: "junction".to_string(),
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
      kind: if is_directory { "directory" } else { "file" }.to_string(),
      link_type: if is_directory { "directory-symlink" } else { "file-symlink" }.to_string(),
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

fn create_managed_link(link_path: &Path, target_path: &Path, is_directory: bool) -> Result<String, String> {
  if is_directory {
    junction::create(target_path, link_path).map_err(|error| {
      format!(
        "创建目录 junction 失败：{} -> {}，{error}",
        link_path.display(),
        target_path.display()
      )
    })?;

    return Ok("junction".to_string());
  }

  symlink_file(target_path, link_path).map_err(|error| {
    format!(
      "创建文件符号链接失败：{} -> {}，{error}",
      link_path.display(),
      target_path.display()
    )
  })?;

  Ok("file-symlink".to_string())
}

fn remove_link_only(record: &ManagedLinkRecord) -> Result<(), String> {
  let link_path = PathBuf::from(&record.link_path);
  if !path_exists_no_follow(&link_path)? {
    return Ok(());
  }

  match record.link_type.as_str() {
    "junction" => junction::delete(&link_path)
      .map_err(|error| format!("删除 junction 失败：{}，{error}", link_path.display())),
    "file-symlink" | "directory-symlink" => {
      if record.link_type == "directory-symlink" {
        fs::remove_dir(&link_path)
          .map_err(|error| format!("删除目录符号链接失败：{}，{error}", link_path.display()))
      } else {
        fs::remove_file(&link_path)
          .map_err(|error| format!("删除文件符号链接失败：{}，{error}", link_path.display()))
      }
    }
    _ => Err("未知链接类型，无法删除".to_string()),
  }
}

fn remove_link_path(path: &Path) -> Result<(), String> {
  let metadata = fs::symlink_metadata(path)
    .map_err(|error| format!("读取路径信息失败：{}，{error}", path.display()))?;

  if junction::exists(path).unwrap_or(false) {
    return junction::delete(path)
      .map_err(|error| format!("删除 junction 失败：{}，{error}", path.display()));
  }

  if metadata.file_type().is_symlink() {
    return fs::remove_file(path)
      .or_else(|_| fs::remove_dir(path))
      .map_err(|error| format!("删除链接失败：{}，{error}", path.display()));
  }

  Err(format!("路径不是链接，无法删除：{}", path.display()))
}

fn is_expected_link(record: &ManagedLinkRecord, link_path: &Path) -> Result<bool, String> {
  if !path_exists_no_follow(link_path)? {
    return Ok(false);
  }

  match record.link_type.as_str() {
    "junction" => Ok(junction::exists(link_path).unwrap_or(false)),
    "file-symlink" | "directory-symlink" => Ok(fs::symlink_metadata(link_path)
      .map(|metadata| metadata.file_type().is_symlink())
      .unwrap_or(false)),
    _ => Err("未知链接类型，无法判断状态".to_string()),
  }
}

fn link_points_to_target(
  record: &ManagedLinkRecord,
  link_path: &Path,
  target_path: &Path,
) -> Result<bool, String> {
  let actual_target = match record.link_type.as_str() {
    "junction" => junction::get_target(link_path).map_err(|error| {
      format!("读取 junction 目标失败：{}，{error}", link_path.display())
    })?,
    "file-symlink" | "directory-symlink" => fs::read_link(link_path)
      .map_err(|error| format!("读取符号链接目标失败：{}，{error}", link_path.display()))?,
    _ => return Err("未知链接类型，无法检查目标".to_string()),
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

fn build_record_id(name: &str) -> String {
  format!("{}-{}", current_timestamp().unwrap_or_default(), name)
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
