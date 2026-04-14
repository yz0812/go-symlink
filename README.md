# SoftLink

Windows 软连接管理工具，技术栈：Tauri + React + TypeScript + Vite。

## 安装依赖

```bash
npm install
```

## 仅启动前端开发环境

```bash
npm run dev
```

启动后访问：

```text
http://localhost:1420
```

注意：这只是浏览器里的前端页面预览，不能调用 Tauri 的 `invoke` 能力，因此会显示“请使用 `npm run tauri dev` 启动桌面应用”之类提示。

## 构建前端产物

```bash
npm run build
```

构建产物输出到：

```text
dist/
```

## 启动完整桌面应用（Tauri）

```bash
npm run tauri dev
```

## 构建桌面应用

```bash
npm run tauri build
```

## 环境要求

运行 Tauri 前，至少确认以下命令可用：

```bash
node -v
cargo --version
```

如果 `cargo --version` 报错，说明 Rust/Cargo 环境未安装，Tauri 后端无法编译和启动。

## 说明

- 只看前端页面时，执行 `npm run dev` 即可。
- 运行完整桌面应用时，项目会按 `src-tauri/tauri.conf.json` 中的配置自动联动前端开发命令，无需手动分别启动。
