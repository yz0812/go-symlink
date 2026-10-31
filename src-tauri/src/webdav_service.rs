use std::borrow::Cow;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use chrono::Local;
use quick_xml::escape::unescape;
use quick_xml::events::Event;
use quick_xml::Reader;
use reqwest::blocking::{Client, RequestBuilder};
use reqwest::{Method, StatusCode, Url};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::credential_store;
use crate::state_store::{self, AppSettings};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebdavBackupFile {
  pub name: String,
  pub modified_at: Option<String>,
  pub size: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebdavBackupPage {
  pub files: Vec<WebdavBackupFile>,
  pub total: usize,
}

#[derive(Debug, Clone)]
struct WebdavConfig {
  base_url: Url,
  username: String,
  password: String,
  remote_dir: String,
}

#[derive(Debug, Default)]
struct PartialBackupFile {
  href: Option<String>,
  modified_at: Option<String>,
  size: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoBackupEvent {
  pub file_name: Option<String>,
  pub error: Option<String>,
}

pub const AUTO_BACKUP_EVENT: &str = "auto-backup";

static AUTO_BACKUP_RUNNING: AtomicBool = AtomicBool::new(false);
static AUTO_BACKUP_PENDING: AtomicBool = AtomicBool::new(false);

/// 在后台线程执行自动备份，结果通过 `auto-backup` 事件通知前端。
/// 备份进行中再次触发时只记一个待办标记，当前备份结束后再补一次，避免并发上传。
pub fn spawn_auto_backup(app: &AppHandle) {
  AUTO_BACKUP_PENDING.store(true, Ordering::SeqCst);
  if AUTO_BACKUP_RUNNING.swap(true, Ordering::SeqCst) {
    return;
  }

  let app = app.clone();
  thread::spawn(move || loop {
    AUTO_BACKUP_PENDING.store(false, Ordering::SeqCst);

    let event = match auto_backup_if_enabled(&app) {
      Ok(Some(file_name)) => Some(AutoBackupEvent {
        file_name: Some(file_name),
        error: None,
      }),
      Ok(None) => None,
      Err(error) => Some(AutoBackupEvent {
        file_name: None,
        error: Some(error),
      }),
    };
    if let Some(event) = event {
      let _ = app.emit(AUTO_BACKUP_EVENT, event);
    }

    AUTO_BACKUP_RUNNING.store(false, Ordering::SeqCst);
    if !AUTO_BACKUP_PENDING.load(Ordering::SeqCst) || AUTO_BACKUP_RUNNING.swap(true, Ordering::SeqCst) {
      break;
    }
  });
}

fn auto_backup_if_enabled(app: &AppHandle) -> Result<Option<String>, String> {
  let (state, _) = state_store::load_state(app)?;

  if !state.settings.webdav_enabled || !state.settings.webdav_auto_backup {
    return Ok(None);
  }

  if !has_required_fields(&state.settings) {
    return Ok(None);
  }

  let Some(password) = credential_store::load_password(app)? else {
    return Ok(None);
  };

  let config = build_config(&state.settings, password)?;
  upload_state(&config, &state).map(Some)
}

pub fn backup_current_state(app: &AppHandle) -> Result<String, String> {
  let config = load_complete_config(app)?;
  let (state, _) = state_store::load_state(app)?;
  upload_state(&config, &state)
}

/// 上传一份状态备份，成功后按保留数量清理本机的旧备份
fn upload_state(config: &WebdavConfig, state: &state_store::StoredState) -> Result<String, String> {
  let payload = state_store::serialize_state(state)?;
  let file_name = build_backup_file_name();
  upload_bytes(config, &file_name, payload)?;

  // 清理失败不影响本次备份结果，只记日志
  if let Err(error) = apply_retention(config, state.settings.webdav_retention) {
    log::warn!("清理旧 WebDAV 备份失败：{error}");
  }

  Ok(file_name)
}

fn apply_retention(config: &WebdavConfig, keep: u32) -> Result<(), String> {
  if keep == 0 {
    return Ok(());
  }

  let files = parse_backup_files(&read_backup_list_xml(config)?)?;
  for name in select_expired_backups(&files, &machine_prefix(), keep as usize) {
    delete_file(config, &name)?;
  }
  Ok(())
}

/// 只挑出本机前缀、且文件名带时间戳的备份；其他机器或手动上传的文件一律不动。`files` 需已按新到旧排序。
fn select_expired_backups(files: &[WebdavBackupFile], prefix: &str, keep: usize) -> Vec<String> {
  files
    .iter()
    .filter(|file| file.name.starts_with(prefix) && backup_timestamp_from_name(&file.name).is_some())
    .skip(keep)
    .map(|file| file.name.clone())
    .collect()
}

pub fn list_backups(app: &AppHandle, offset: usize, limit: usize) -> Result<WebdavBackupPage, String> {
  let config = load_complete_config(app)?;
  let body = read_backup_list_xml(&config)?;
  let files = parse_backup_files(&body)?;
  let total = files.len();
  Ok(WebdavBackupPage {
    files: files.into_iter().skip(offset).take(limit).collect(),
    total,
  })
}

pub fn test_connection_with_settings(
  settings: &AppSettings,
  password: Option<&str>,
  app: &AppHandle,
) -> Result<(), String> {
  let password = match password {
    Some(value) => value.to_string(),
    None => credential_store::load_password(app)?.ok_or_else(|| "请先保存 WebDAV 密码".to_string())?,
  };
  let config = build_config(settings, password)?;
  test_connection_with_config(&config)
}

pub fn restore_backup(app: &AppHandle, file_name: &str) -> Result<Option<std::path::PathBuf>, String> {
  let bytes = download_backup(app, file_name)?;
  state_store::replace_state_from_bytes(app, &bytes)
}

pub fn download_backup(app: &AppHandle, file_name: &str) -> Result<Vec<u8>, String> {
  validate_backup_file_name(file_name)?;
  let config = load_complete_config(app)?;
  let client = build_client()?;
  let response = apply_auth(client.get(file_url(&config, file_name)), &config)
    .send()
    .map_err(|error| format!("下载 WebDAV 备份失败：{error}"))?;

  let status = response.status();
  let bytes = response
    .bytes()
    .map_err(|error| format!("读取 WebDAV 备份数据失败：{error}"))?;

  if !status.is_success() {
    let message = String::from_utf8_lossy(bytes.as_ref()).to_string();
    return Err(format!("下载 WebDAV 备份失败：HTTP {status}，{message}"));
  }

  Ok(bytes.to_vec())
}

pub fn delete_backup(app: &AppHandle, file_name: &str) -> Result<(), String> {
  validate_backup_file_name(file_name)?;
  let config = load_complete_config(app)?;
  delete_file(&config, file_name)
}

fn delete_file(config: &WebdavConfig, file_name: &str) -> Result<(), String> {
  let client = build_client()?;
  let response = apply_auth(client.delete(file_url(config, file_name)), config)
    .send()
    .map_err(|error| format!("删除 WebDAV 备份失败：{error}"))?;

  let status = response.status();
  if status.is_success() {
    return Ok(());
  }

  let body = response
    .text()
    .map_err(|error| format!("读取 WebDAV 删除响应失败：{error}"))?;
  Err(format!("删除 WebDAV 备份失败：HTTP {status}，{body}"))
}

fn load_complete_config(app: &AppHandle) -> Result<WebdavConfig, String> {
  let (state, _) = state_store::load_state(app)?;
  let Some(password) = credential_store::load_password(app)? else {
    return Err("请先保存 WebDAV 密码".to_string());
  };

  build_config(&state.settings, password)
}

fn read_backup_list_xml(config: &WebdavConfig) -> Result<String, String> {
  let client = build_client()?;
  let method = Method::from_bytes(b"PROPFIND").map_err(|error| format!("创建 WebDAV 请求失败：{error}"))?;
  let response = apply_auth(
    client
      .request(method, directory_url(config))
      .header("Depth", "1")
      .header("Content-Type", "application/xml; charset=utf-8")
      .body("<?xml version=\"1.0\" encoding=\"utf-8\"?><propfind xmlns=\"DAV:\"><prop><getlastmodified/><getcontentlength/></prop></propfind>"),
    config,
  )
  .send()
  .map_err(|error| format!("读取 WebDAV 备份列表失败：{error}"))?;

  let status = response.status();
  let body = response
    .text()
    .map_err(|error| format!("读取 WebDAV 列表响应失败：{error}"))?;

  if !status.is_success() {
    return Err(format!("读取 WebDAV 备份列表失败：HTTP {status}，{body}"));
  }

  Ok(body)
}

fn test_connection_with_config(config: &WebdavConfig) -> Result<(), String> {
  ensure_remote_directory(config)?;
  let body = read_backup_list_xml(config)?;
  let _ = parse_backup_files(&body)?;
  Ok(())
}

fn build_config(settings: &AppSettings, password: String) -> Result<WebdavConfig, String> {
  if !settings.webdav_enabled {
    return Err("请先启用 WebDAV 备份".to_string());
  }

  if !has_required_fields(settings) {
    return Err("请先填写完整的 WebDAV 地址、用户名和远程目录".to_string());
  }

  let base_url = validate_webdav_url(settings.webdav_url.trim())?;

  Ok(WebdavConfig {
    base_url,
    username: settings.webdav_username.trim().to_string(),
    password,
    remote_dir: normalize_remote_dir(&settings.webdav_remote_dir),
  })
}

pub fn validate_webdav_url(value: &str) -> Result<Url, String> {
  let url = Url::parse(value).map_err(|error| format!("WebDAV 地址无效：{error}"))?;

  if !matches!(url.scheme(), "https" | "http") {
    return Err("WebDAV 地址仅支持 http 或 https".to_string());
  }

  if url.scheme() == "http" && !is_local_http_host(&url) {
    return Err("WebDAV 地址使用 http 时仅允许 localhost 或 127.0.0.1".to_string());
  }

  if url.query().is_some() || url.fragment().is_some() {
    return Err("WebDAV 地址不能包含 query 或 fragment".to_string());
  }

  Ok(url)
}

fn is_local_http_host(url: &Url) -> bool {
  matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"))
}

fn has_required_fields(settings: &AppSettings) -> bool {
  !settings.webdav_url.trim().is_empty()
    && !settings.webdav_username.trim().is_empty()
    && !normalize_remote_dir(&settings.webdav_remote_dir).is_empty()
}

fn upload_bytes(config: &WebdavConfig, file_name: &str, payload: Vec<u8>) -> Result<(), String> {
  validate_backup_file_name(file_name)?;
  ensure_remote_directory(config)?;

  let client = build_client()?;
  let response = apply_auth(
    client
      .put(file_url(config, file_name))
      .header("Content-Type", "application/json; charset=utf-8")
      .body(payload),
    config,
  )
  .send()
  .map_err(|error| format!("上传 WebDAV 备份失败：{error}"))?;

  let status = response.status();
  if status.is_success() {
    return Ok(());
  }

  let body = response
    .text()
    .map_err(|error| format!("读取 WebDAV 上传响应失败：{error}"))?;
  Err(format!("上传 WebDAV 备份失败：HTTP {status}，{body}"))
}

fn ensure_remote_directory(config: &WebdavConfig) -> Result<(), String> {
  let client = build_client()?;
  let method = Method::from_bytes(b"MKCOL").map_err(|error| format!("创建 WebDAV 请求失败：{error}"))?;
  let response = apply_auth(client.request(method, directory_url(config)), config)
    .send()
    .map_err(|error| format!("创建 WebDAV 目录失败：{error}"))?;

  match response.status() {
    StatusCode::CREATED | StatusCode::METHOD_NOT_ALLOWED | StatusCode::OK | StatusCode::NO_CONTENT => Ok(()),
    status => {
      let body = response
        .text()
        .map_err(|error| format!("读取 WebDAV 目录响应失败：{error}"))?;
      Err(format!("创建 WebDAV 目录失败：HTTP {status}，{body}"))
    }
  }
}

fn build_client() -> Result<Client, String> {
  Client::builder()
    .timeout(Duration::from_secs(30))
    .build()
    .map_err(|error| format!("创建 WebDAV 客户端失败：{error}"))
}

fn apply_auth(builder: RequestBuilder, config: &WebdavConfig) -> RequestBuilder {
  builder.basic_auth(&config.username, Some(&config.password))
}

/// 本机备份文件名前缀，形如 `MY-PC_`
fn machine_prefix() -> String {
  let machine_name =
    sanitize_machine_name(&std::env::var("COMPUTERNAME").unwrap_or_else(|_| "unknown-machine".to_string()));
  format!("{machine_name}_")
}

fn build_backup_file_name() -> String {
  let now = Local::now();
  let timestamp = now.format("%Y%m%d%H%M%S").to_string();
  format!(
    "{}{timestamp}{:03}.json",
    machine_prefix(),
    now.timestamp_subsec_millis()
  )
}

fn sanitize_machine_name(value: &str) -> String {
  let sanitized = value
    .trim()
    .chars()
    .map(|ch| {
      if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
        ch
      } else {
        '-'
      }
    })
    .collect::<String>()
    .trim_matches('-')
    .to_string();

  if sanitized.is_empty() {
    "unknown-machine".to_string()
  } else {
    sanitized
  }
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

fn directory_url(config: &WebdavConfig) -> Url {
  let mut url = config.base_url.clone();
  {
    let mut segments = url
      .path_segments_mut()
      .expect("validated WebDAV URL must support path segments");
    for segment in config.remote_dir.split('/').filter(|segment| !segment.is_empty()) {
      segments.push(segment);
    }
    segments.push("");
  }
  url
}

fn file_url(config: &WebdavConfig, file_name: &str) -> Url {
  let mut url = directory_url(config);
  url
    .path_segments_mut()
    .expect("validated WebDAV URL must support path segments")
    .pop_if_empty()
    .push(file_name);
  url
}

fn validate_backup_file_name(file_name: &str) -> Result<(), String> {
  let trimmed = file_name.trim();
  if trimmed.is_empty() {
    return Err("备份文件名不能为空".to_string());
  }

  if trimmed.contains('/') || trimmed.contains('\\') {
    return Err("备份文件名不合法".to_string());
  }

  if !trimmed.to_ascii_lowercase().ends_with(".json") {
    return Err("备份文件必须是 .json 文件".to_string());
  }

  Ok(())
}

fn parse_backup_files(xml: &str) -> Result<Vec<WebdavBackupFile>, String> {
  let mut reader = Reader::from_str(xml);
  reader.config_mut().trim_text(true);

  let mut buf = Vec::new();
  let mut current_tag: Option<Vec<u8>> = None;
  let mut current = PartialBackupFile::default();
  let mut in_response = false;
  let mut items = Vec::new();

  loop {
    match reader.read_event_into(&mut buf) {
      Ok(Event::Start(event)) => {
        let tag = event.local_name().as_ref().to_vec();
        if tag.as_slice() == b"response" {
          current = PartialBackupFile::default();
          in_response = true;
        }
        current_tag = Some(tag);
      }
      Ok(Event::End(event)) => {
        if event.local_name().as_ref() == b"response" {
          if let Some(item) = finalize_backup_item(current.take())? {
            items.push(item);
          }
          in_response = false;
        }
        current_tag = None;
      }
      Ok(Event::Text(event)) => {
        if in_response {
          let text = xml_unescape(String::from_utf8_lossy(event.as_ref()));
          assign_xml_value(&mut current, current_tag.as_deref(), text.as_ref());
        }
      }
      Ok(Event::CData(event)) => {
        if in_response {
          let text = String::from_utf8_lossy(event.as_ref()).to_string();
          assign_xml_value(&mut current, current_tag.as_deref(), &text);
        }
      }
      Ok(Event::Eof) => break,
      Err(error) => return Err(format!("解析 WebDAV 列表失败：{error}")),
      _ => {}
    }

    buf.clear();
  }

  items.sort_by_key(|item| std::cmp::Reverse(backup_sort_key(item)));
  Ok(items)
}

fn backup_sort_key(file: &WebdavBackupFile) -> String {
  backup_timestamp_from_name(&file.name)
    .or_else(|| file.modified_at.clone())
    .unwrap_or_else(|| file.name.clone())
}

fn backup_timestamp_from_name(name: &str) -> Option<String> {
  let stem = name.strip_suffix(".json")?;
  let timestamp = stem.rsplit('_').next()?;
  if timestamp.len() < 14 || !timestamp.chars().all(|ch| ch.is_ascii_digit()) {
    return None;
  }

  Some(timestamp.to_string())
}

fn assign_xml_value(current: &mut PartialBackupFile, current_tag: Option<&[u8]>, value: &str) {
  let trimmed = value.trim();
  if trimmed.is_empty() {
    return;
  }

  match current_tag {
    Some(b"href") => current.href = Some(trimmed.to_string()),
    Some(b"getlastmodified") => current.modified_at = Some(trimmed.to_string()),
    Some(b"getcontentlength") => current.size = trimmed.parse::<u64>().ok(),
    _ => {}
  }
}

fn finalize_backup_item(current: PartialBackupFile) -> Result<Option<WebdavBackupFile>, String> {
  let Some(href) = current.href else {
    return Ok(None);
  };

  let decoded = match urlencoding::decode(href.trim()) {
    Ok(value) => value.into_owned(),
    Err(_) => href,
  };
  let name = decoded
    .trim_end_matches('/')
    .rsplit('/')
    .next()
    .unwrap_or_default()
    .trim()
    .to_string();

  if name.is_empty() || !name.to_ascii_lowercase().ends_with(".json") {
    return Ok(None);
  }

  validate_backup_file_name(&name)?;

  Ok(Some(WebdavBackupFile {
    name,
    modified_at: current.modified_at,
    size: current.size,
  }))
}

fn xml_unescape(value: Cow<'_, str>) -> String {
  match unescape(value.as_ref()) {
    Ok(text) => text.into_owned(),
    Err(_) => value.into_owned(),
  }
}

trait TakeValue {
  fn take(&mut self) -> Self;
}

impl TakeValue for PartialBackupFile {
  fn take(&mut self) -> Self {
    std::mem::take(self)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  const PROPFIND_SAMPLE: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/dav/go-symlink/</d:href>
    <d:propstat><d:prop><d:getlastmodified>Mon, 01 Jan 2026 00:00:00 GMT</d:getlastmodified></d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/go-symlink/PC-A_20260101080000000.json</d:href>
    <d:propstat><d:prop>
      <d:getlastmodified>Thu, 01 Jan 2026 08:00:00 GMT</d:getlastmodified>
      <d:getcontentlength>120</d:getcontentlength>
    </d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/go-symlink/PC%20B_20260301080000000.json</d:href>
    <d:propstat><d:prop><d:getcontentlength>64</d:getcontentlength></d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/go-symlink/notes.txt</d:href>
  </d:response>
</d:multistatus>"#;

  #[test]
  fn parses_propfind_and_sorts_newest_first() {
    let files = parse_backup_files(PROPFIND_SAMPLE).unwrap();
    let names = files.iter().map(|file| file.name.as_str()).collect::<Vec<_>>();

    assert_eq!(
      names,
      vec!["PC B_20260301080000000.json", "PC-A_20260101080000000.json"]
    );
    assert_eq!(files[0].size, Some(64));
    assert_eq!(files[1].size, Some(120));
    assert!(files[1].modified_at.is_some());
  }

  #[test]
  fn validates_webdav_url() {
    assert!(validate_webdav_url("https://dav.example.com/remote.php/dav").is_ok());
    assert!(validate_webdav_url("http://localhost:8080/dav").is_ok());
    assert!(validate_webdav_url("http://192.168.1.2/dav").is_err());
    assert!(validate_webdav_url("ftp://example.com").is_err());
    assert!(validate_webdav_url("https://example.com/dav?token=1").is_err());
    assert!(validate_webdav_url("not a url").is_err());
  }

  #[test]
  fn normalizes_remote_dir() {
    assert_eq!(normalize_remote_dir(r" \backup\\go-symlink/ "), "backup/go-symlink");
    assert_eq!(normalize_remote_dir("/"), "");
  }

  #[test]
  fn validates_backup_file_name() {
    assert!(validate_backup_file_name("PC_20260101.json").is_ok());
    assert!(validate_backup_file_name("../state.json").is_err());
    assert!(validate_backup_file_name(r"a\b.json").is_err());
    assert!(validate_backup_file_name("state.txt").is_err());
    assert!(validate_backup_file_name("  ").is_err());
  }

  #[test]
  fn extracts_timestamp_from_backup_name() {
    assert_eq!(
      backup_timestamp_from_name("my_pc_20260101080000123.json").as_deref(),
      Some("20260101080000123")
    );
    assert_eq!(backup_timestamp_from_name("manual.json"), None);
  }

  #[test]
  fn selects_only_own_expired_backups() {
    let file = |name: &str| WebdavBackupFile {
      name: name.to_string(),
      modified_at: None,
      size: None,
    };
    let files = [
      file("PC_20260103000000000.json"),
      file("OTHER_20260102500000000.json"),
      file("PC_20260102000000000.json"),
      file("PC_manual.json"),
      file("PC_20260101000000000.json"),
    ];

    assert_eq!(
      select_expired_backups(&files, "PC_", 1),
      ["PC_20260102000000000.json", "PC_20260101000000000.json"]
    );
    assert!(select_expired_backups(&files, "PC_", 3).is_empty());
  }

  #[test]
  fn sanitizes_machine_name() {
    assert_eq!(sanitize_machine_name(" 我的电脑 "), "unknown-machine");
    assert_eq!(sanitize_machine_name("PC 01"), "PC-01");
    assert_eq!(sanitize_machine_name("DESKTOP-01"), "DESKTOP-01");
    assert_eq!(sanitize_machine_name(""), "unknown-machine");
  }
}
