use std::borrow::Cow;
use std::time::Duration;

use chrono::Local;
use quick_xml::escape::unescape;
use quick_xml::events::Event;
use quick_xml::Reader;
use reqwest::blocking::{Client, RequestBuilder};
use reqwest::{Method, StatusCode, Url};
use serde::Serialize;
use tauri::AppHandle;

use crate::credential_store;
use crate::state_store::{self, AppSettings};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebdavBackupFile {
  pub name: String,
  pub modified_at: Option<String>,
  pub size: Option<u64>,
}

#[derive(Debug, Clone)]
struct WebdavConfig {
  base_url: String,
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

pub fn auto_backup_if_enabled(app: &AppHandle) -> Result<Option<String>, String> {
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
  let payload = state_store::serialize_state(&state)?;
  let file_name = build_backup_file_name();
  upload_bytes(&config, &file_name, payload)?;
  Ok(Some(file_name))
}

pub fn backup_current_state(app: &AppHandle) -> Result<String, String> {
  let config = load_complete_config(app)?;
  let (state, _) = state_store::load_state(app)?;
  let payload = state_store::serialize_state(&state)?;
  let file_name = build_backup_file_name();
  upload_bytes(&config, &file_name, payload)?;
  Ok(file_name)
}

pub fn list_backups(app: &AppHandle) -> Result<Vec<WebdavBackupFile>, String> {
  let config = load_complete_config(app)?;
  let body = read_backup_list_xml(&config)?;
  let mut files = parse_backup_files(&body)?;
  files.truncate(10);
  Ok(files)
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

pub fn import_backup_bytes(app: &AppHandle, bytes: &[u8]) -> Result<(), String> {
  state_store::replace_state_from_bytes(app, bytes)
}

pub fn restore_backup(app: &AppHandle, file_name: &str) -> Result<(), String> {
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

  let state = state_store::deserialize_state_bytes(bytes.as_ref())?;
  state_store::save_state(app, &state)?;
  Ok(())
}

pub fn delete_backup(app: &AppHandle, file_name: &str) -> Result<(), String> {
  validate_backup_file_name(file_name)?;
  let config = load_complete_config(app)?;
  let client = build_client()?;
  let response = apply_auth(client.delete(file_url(&config, file_name)), &config)
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
  let method = Method::from_bytes(b"PROPFIND")
    .map_err(|error| format!("创建 WebDAV 请求失败：{error}"))?;
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

  Url::parse(settings.webdav_url.trim())
    .map_err(|error| format!("WebDAV 地址无效：{error}"))?;

  Ok(WebdavConfig {
    base_url: settings.webdav_url.trim().trim_end_matches('/').to_string(),
    username: settings.webdav_username.trim().to_string(),
    password,
    remote_dir: normalize_remote_dir(&settings.webdav_remote_dir),
  })
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
  let method = Method::from_bytes(b"MKCOL")
    .map_err(|error| format!("创建 WebDAV 请求失败：{error}"))?;
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

fn build_backup_file_name() -> String {
  let machine_name = sanitize_machine_name(&std::env::var("COMPUTERNAME").unwrap_or_else(|_| "unknown-machine".to_string()));
  let timestamp = Local::now().format("%Y%m%d%H%M%S").to_string();
  format!("{machine_name}_{timestamp}.json")
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

fn directory_url(config: &WebdavConfig) -> String {
  let mut url = config.base_url.clone();
  if !config.remote_dir.is_empty() {
    url.push('/');
    url.push_str(&encode_remote_path(&config.remote_dir));
  }
  if !url.ends_with('/') {
    url.push('/');
  }
  url
}

fn file_url(config: &WebdavConfig, file_name: &str) -> String {
  let mut url = directory_url(config);
  url.push_str(&urlencoding::encode(file_name));
  url
}

fn encode_remote_path(path: &str) -> String {
  path
    .split('/')
    .filter(|segment| !segment.is_empty())
    .map(|segment| urlencoding::encode(segment).into_owned())
    .collect::<Vec<_>>()
    .join("/")
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

  items.sort_by(|left, right| right.name.cmp(&left.name));
  Ok(items)
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
