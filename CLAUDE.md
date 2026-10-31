# SoftLink Manager

> 生成时间：2026-04-13T17:17:05+08:00

## 概述

SoftLink Manager 是一个 Windows 软链接管理桌面工具。前端使用 React + TypeScript 提供界面，后端使用 Tauri + Rust 执行本地文件与链接操作，并通过受限命令暴露给前端。

## 技术栈

- 语言：TypeScript、Rust
- 框架：React 19、Tauri 2
- 构建：Vite 8、TypeScript 6、Cargo

## 项目结构

```mermaid
graph TD
    ROOT[SoftLink Manager]
    ROOT --> Frontend[src]
    ROOT --> Backend[src-tauri]
    ROOT --> Static[public]
    Frontend --> Components[src/components]
    Frontend --> Bridge[src/lib]
    Backend --> RustCore[src-tauri/src]
    Backend --> Capability[src-tauri/capabilities]
    Backend --> Permission[src-tauri/permissions]
```

## 模块索引

| 模块 | 路径 | 职责 |
|------|------|------|
| 前端入口 | `src` | React 桌面界面入口，`App.tsx` 负责对话框状态和各类操作调度 |
| UI 组件 | `src/components` | 链接列表、创建/迁移表单、详情对话框、反馈提示 |
| 设置分区 | `src/components/settings` | 设置面板的常规、扫描导入、WebDAV 备份分区及恢复差异预览 |
| Hooks | `src/hooks` | 应用状态加载刷新、反馈提示、主题、Tauri 事件/拖放/焦点订阅、忙碌状态 |
| 前端桥接 | `src/lib` | 封装 Tauri `invoke` 调用、类型定义、结构化错误转换和展示文案 |
| Tauri 后端 | `src-tauri/src` | 注册命令、管理状态文件、创建/修复/迁移链接、WebDAV 备份 |
| 能力配置 | `src-tauri/capabilities` | 将窗口绑定到允许的权限集合 |
| 权限配置 | `src-tauri/permissions` | 声明前端可调用的 Tauri commands |
| 静态资源 | `public` | 存放应用图标和静态资源 |

## 入口文件

- `src/main.tsx` - 前端挂载入口，渲染 `App`
- `src/App.tsx` - 主界面与交互调度中心
- `src-tauri/src/main.rs` - 桌面应用原生入口
- `src-tauri/src/lib.rs` - Tauri Builder、插件、日志和命令注册入口

## 关键实现

| 文件 | 作用 |
|------|------|
| `src/lib/api.ts` | 检查 Tauri 运行环境并统一封装前端到 Rust 的命令调用，`toAppError` 解析结构化错误 |
| `src-tauri/src/commands.rs` | 定义全部命令；命令为 `async fn`，耗时逻辑通过 `run_blocking` 放到阻塞线程池 |
| `src-tauri/src/error.rs` | `AppError { code, message, field }`，前端据 `code`/`field` 区分冲突与字段错误 |
| `src-tauri/src/link_service.rs` | 路径校验、创建/删除/修复链接、覆盖冲突时恢复原内容、扫描已有链接；不移动真实文件 |
| `src-tauri/src/migrate_service.rs` | 迁移并链接、撤销链接：同卷 rename，跨卷带进度复制并可取消、失败回滚 |
| `src-tauri/src/state_store.rs` | 读写 `state.json`：`StateLock` 串行化读改写，原子写入加 `.bak` 回退，恢复前快照与差异计算 |
| `src-tauri/src/webdav_service.rs` | WebDAV 备份上传、分页列表、恢复、按本机前缀的保留清理，后台自动备份 |
| `src-tauri/src/credential_store.rs` | 本地加密保存 WebDAV 密码 |
| `src-tauri/capabilities/default.json` | 将主窗口绑定到默认 capability |
| `src-tauri/permissions/softlink-manager.toml` | 限定前端可调用的命令集合 |

## 安全边界

- 主窗口 capability：`src-tauri/capabilities/default.json`
- 新增命令时要同时修改三处：`lib.rs` 的 `generate_handler!`、`build.rs` 的 `AppManifest` 命令列表（未列出的命令不受 ACL 约束）、`permissions/softlink-manager.toml`
- 当前允许前端调用的命令：`get_app_state`、`update_settings`、`create_link_job`、`delete_link_job`、`rename_link_job`、`refresh_link_status`、`repair_link_jobs`、`migrate_and_link`、`revert_link_job`、`cancel_migration`、`scan_existing_links`、`import_existing_links`、`open_in_explorer`、`backup_state_to_webdav`、`list_webdav_backups`、`preview_backup`、`restore_state_from_webdav`、`delete_webdav_backup`、`import_backup_file`、`export_backup_file`、`test_webdav_connection`
- 后端推送的事件：`auto-backup`（自动备份结果）、`migrate-progress`（迁移/撤销进度）
- 浏览器模式下前端会主动阻止 Tauri 调用，需使用 `npm run tauri dev` 运行完整桌面应用

## 快速命令

```bash
npm install
npm run dev
npm run tauri dev
npm run build
npm run tauri build
npm run lint
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

## 运行说明

- `npm run dev`：仅启动前端预览，不能调用 Tauri `invoke`
- `npm run tauri dev`：启动完整桌面应用
- `npm run build`：构建前端产物到 `dist/`
- `npm run tauri build`：构建桌面应用


## MCP 工具使用优先级

- **语义搜索 / 不确定位置 / 需要理解上下文**：优先用 `ace-tool`
- **已知类、方法、符号**：优先用 `Serena`
- **IDE 原生能力**：优先用 `idea`
- **已知文件或精确关键词**：直接用 `Read` / `Grep` / `Glob` / `Edit`
