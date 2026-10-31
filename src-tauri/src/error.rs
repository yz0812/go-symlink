use serde::Serialize;

/// 前端按 `code` 分支处理错误，`field` 用于把错误定位到表单字段。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorCode {
  Conflict,
  InvalidInput,
  NotFound,
  PermissionDenied,
  Internal,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
  pub code: ErrorCode,
  pub message: String,
  pub field: Option<String>,
}

impl AppError {
  pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
    Self {
      code,
      message: message.into(),
      field: None,
    }
  }

  pub fn with_field(mut self, field: &str) -> Self {
    self.field = Some(field.to_string());
    self
  }
}

impl std::fmt::Display for AppError {
  fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    formatter.write_str(&self.message)
  }
}

/// 尚未细分错误码的旧代码路径统一归为 internal，保证 `?` 可以直接传播 String 错误。
impl From<String> for AppError {
  fn from(message: String) -> Self {
    Self::new(ErrorCode::Internal, message)
  }
}

impl From<&str> for AppError {
  fn from(message: &str) -> Self {
    Self::new(ErrorCode::Internal, message)
  }
}

pub type AppResult<T> = Result<T, AppError>;
