# dsh-archive-manager

DSH Web GUI 的「历史归档」管理插件：侧边栏新增「历史归档」入口，列出已归档的会话并支持一键恢复回工作区。

- 侧边栏「历史归档」入口（跟随 DSH 侧边栏样式）
- 面板列出所有归档会话（显示真实会话标题）
- 每条记录一个「恢复」按钮，一键取消归档、回到工作区列表
- 面板打开时自动刷新 + 打开状态下每 3 秒轮询，归档/恢复无需刷新页面

## 背景

DSH 官方提供「归档会话」（`workspace.archiveSession`），但**没有恢复（unarchive）入口**——归档后的会话会从工作区列表隐藏，官方没有任何界面能把它放回来。本插件补上这个缺口：

- 宿主端注册 `/api/archive-manager/list` 与 `/api/archive-manager/unarchive`
- 客户端注入侧边栏入口 + 面板

## 安装

### 方式一：bundle 激活（本仓库自带脚本）

1. 把整个仓库复制到 `~/.dsh/profiles/web/node_modules/dsh-archive-manager/`
2. 运行 `node activate.mjs`（把 `dsh-archive-manager` 加入 profile 的 `dsh.profile.bundles`）
3. 重启 `dsh web`

### 方式二：dsh plugin（pnpm）

```bash
cd ~/.dsh/profiles/web
pnpm add dsh-archive-manager  # 需要包已发布到 npm 或指向 git 仓库
dsh plugin --profile web ...
```

## 构建（修改客户端源码后）

```bash
node build-client.mjs   # src/client/client.js → lib/client.js（__ModuleLoader__ 包装）
```

验证：`node host-test.mjs`、`node loader-test.mjs`、`node _precheck.mjs`

## 修复记录

本仓库基于本地安装的 dsh-archive-manager v0.1.0 维护，修复了以下问题（`lib/` 与 `src/` 已同步）：

| # | 问题 | 修复 |
|---|---|---|
| 1 | `/api/archive-manager/list` 返回 500 `domain 'workspace' is already open`——重复打开官方已占用的存储域 | `_domain()` 先 `storageDomain.get("workspace")` 复用已打开的域，取不到才 `open` |
| 2 | 点「恢复」后会话不立即回到工作区列表，必须刷新页面 | `unarchive` 改走 `registry.setState`，同步 registry 内存态，触发 `host/archived-sessions-changed` |
| 3 | 归档列表只显示「会话+随机后缀」，看不到真实标题 | `list` 接口通过 `sessionPersistence.inspect` 读取会话日志中的 `session/title` 事件，返回 `items: [{sessionId, title}]`；客户端优先渲染真实标题 |
| 4 | 归档后历史归档面板不立即显示新记录（要刷新页面） | 面板每次打开时重新拉取 `list` |
| 5 | 面板保持打开时归档/恢复不刷新 | 面板打开状态下每 3 秒轮询（DOM 移除后自动停止） |

## 反馈与贡献

欢迎提 issue 或 PR：

- 发现 bug（包括上面的修复是否有副作用）、想要新功能，直接开 [issue](https://github.com/LianbinZhou/dsh-archive-manager/issues)
- 本仓库已包含完整修复；如果插件原作者发布了新版本，欢迎把本仓库的修复合并过去
- 安装/使用问题也可以在 issue 里提问

## 许可

MIT。上游为本地安装的 `dsh-archive-manager` v0.1.0（MIT），原作者未在包内署名；本仓库为修复维护版。
