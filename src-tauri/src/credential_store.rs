use std::fs;
use std::path::PathBuf;
use std::ptr;
use std::slice;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Cryptography::{
  CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CredentialRecord {
  pub password: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStatus {
  pub has_password: bool,
}

pub fn get_status(app: &AppHandle) -> Result<CredentialStatus, String> {
  Ok(CredentialStatus {
    has_password: credential_file_path(app)?.exists(),
  })
}

pub fn save_password(app: &AppHandle, password: &str) -> Result<(), String> {
  let trimmed = password.trim();
  if trimmed.is_empty() {
    return Err("WebDAV 密码不能为空".to_string());
  }

  let encrypted = encrypt(trimmed.as_bytes())?;
  let record = CredentialRecord {
    password: BASE64.encode(encrypted),
  };
  let content = serde_json::to_vec_pretty(&record)
    .map_err(|error| format!("序列化密码配置失败：{error}"))?;

  let path = credential_file_path(app)?;
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|error| format!("创建密码配置目录失败：{error}"))?;
  }

  fs::write(path, content).map_err(|error| format!("写入密码配置失败：{error}"))
}

pub fn load_password(app: &AppHandle) -> Result<Option<String>, String> {
  let path = credential_file_path(app)?;
  if !path.exists() {
    return Ok(None);
  }

  let content = fs::read(&path)
    .map_err(|error| format!("读取密码配置失败：{error}"))?;
  let record = serde_json::from_slice::<CredentialRecord>(&content)
    .map_err(|error| format!("解析密码配置失败：{error}"))?;

  let encrypted = BASE64.decode(record.password)
    .map_err(|error| format!("解析密码数据失败：{error}"))?;
  let decrypted = decrypt(&encrypted)?;
  String::from_utf8(decrypted)
    .map(Some)
    .map_err(|error| format!("解码密码失败：{error}"))
}

fn credential_file_path(app: &AppHandle) -> Result<PathBuf, String> {
  let base_dir = app
    .path()
    .app_local_data_dir()
    .map_err(|error| format!("无法解析应用本地数据目录：{error}"))?;

  Ok(base_dir.join("webdav-credential.json"))
}

fn encrypt(data: &[u8]) -> Result<Vec<u8>, String> {
  let input = CRYPT_INTEGER_BLOB {
    cbData: data.len() as u32,
    pbData: data.as_ptr() as *mut u8,
  };
  let mut output = CRYPT_INTEGER_BLOB {
    cbData: 0,
    pbData: ptr::null_mut(),
  };

  let result = unsafe {
    CryptProtectData(
      &input,
      ptr::null(),
      ptr::null(),
      ptr::null(),
      ptr::null(),
      0,
      &mut output,
    )
  };

  if result == 0 {
    return Err("Windows 加密失败".to_string());
  }

  let encrypted = unsafe { slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
  unsafe {
    LocalFree(output.pbData.cast());
  }
  Ok(encrypted)
}

fn decrypt(data: &[u8]) -> Result<Vec<u8>, String> {
  let input = CRYPT_INTEGER_BLOB {
    cbData: data.len() as u32,
    pbData: data.as_ptr() as *mut u8,
  };
  let mut output = CRYPT_INTEGER_BLOB {
    cbData: 0,
    pbData: ptr::null_mut(),
  };

  let result = unsafe {
    CryptUnprotectData(
      &input,
      ptr::null_mut(),
      ptr::null(),
      ptr::null(),
      ptr::null(),
      0,
      &mut output,
    )
  };

  if result == 0 {
    return Err("Windows 解密失败".to_string());
  }

  let decrypted = unsafe { slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
  unsafe {
    LocalFree(output.pbData.cast());
  }
  Ok(decrypted)
}
