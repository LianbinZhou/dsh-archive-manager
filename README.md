# dsh-archive-manager

DSH Web GUI 的「历史归档」管理插件：侧边栏新增「历史归档」入口，列出已归档的会话，支持一键恢复回工作区，以及**带二次确认的物理删除**。

- 侧边栏「历史归档」入口（跟随 DSH 侧边栏样式）
- 面板列出所有归档会话（显示真实会话标题 + 归档时间）
- 每条记录一个「恢复」按钮，一键取消归档、回到工作区列表
- 每条记录一个「删除」按钮，二次确认后彻底删除会话（不可恢复）
- 面板打开时自动刷新 + 打开状态下每 3 秒轮询，归档/恢复/删除无需刷新页面

## 背景

DSH 官方提供「归档会话」（`workspace.archiveSession`），但**既没有恢复（unarchive）入口，也没有物理删除入口**——归档后的会话会从工作区列表隐藏，官方没有任何界面能把它放回来，更没有办法真正删掉它。本插件补上这两个缺口：

- 宿主端注册 `/api/archive-manager/list`、`/api/archive-manager/unarchive`、`/api/archive-manager/delete`
- 客户端注入侧边栏入口 + 面板

## 删除的语义与安全边界

**物理删除不可恢复。** 插件按下面的顺序执行，任一步失败都不会留下"半删除"的会话：

1. **归档标记**：从 workspace 存储域的 `archivedSessionIds` 中移除（复用恢复的写入路径，侧边栏与已连接的浏览器立即同步）
2. **工作区记录**：从每个工作区实体的 `sessionIds` 名册中移除（尽力而为，失败不阻塞后续步骤）
3. **存储目录**：删除 `$DSH_HOME/sessions/<project>/<session-id>/`（含 `session.v3.jsonl.zstd`）
4. **投影缓存**：清理 `storages/session_projcache.json` 的索引行，以及该会话的逐会话缓存文件

安全约束：

- **只有已归档的会话能被删除。** 正在使用的会话在归档之前不可达，误发或重放的请求也删不掉它。
- 删除前对路径做 **realpath 二次校验**，拒绝任何位于 `$DSH_HOME/sessions` 之外的路径。
- **不跟随逃逸符号链接**：指向 sessions 根之外的链接既不会被索引，也不会被删除。
- 会话 id 先做格式校验（拒绝 `..`、路径分隔符、超长输入）才触碰文件系统。
- 客户端只提交会话 ID，从不提交文件路径。

**共享的内容寻址附件（`$DSH_HOME/attachments`）不会被回收**：它们可能被其他会话引用，孤儿附件清理不在本插件职责内。

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

## 构建与测试

```bash
node build.mjs          # 一次构建：src/host/*.js → lib/*.js，src/client/client.js → lib/client.js
node delete-test.mjs    # 删除路径的安全测试（24 项：路径逃逸、符号链接逃逸、缓存清理、损坏容错）
```

只想重建客户端产物时可以用 `node build-client.mjs`（等价于 `build.mjs` 的后半段）。

其它验证：`node host-test.mjs`、`node loader-test.mjs`、`node _precheck.mjs`、`node title-test.mjs`

`title-test.mjs` 是标题解析的离线测试（vm + 桩服务，不需要启动 dsh），覆盖批量接口命中、单条失败回退原始日志、无 sessionQuery 时整批回退、取最新一条 `session/title`、缓存与并发去重。

## 修复与新增记录

本仓库基于本地安装的 dsh-archive-manager v0.1.0 维护（`lib/` 与 `src/` 已同步）：

| # | 问题 | 修复 |
|---|---|---|
| 1 | `/api/archive-manager/list` 返回 500 `domain 'workspace' is already open`——重复打开官方已占用的存储域 | `_domain()` 先 `storageDomain.get("workspace")` 复用已打开的域，取不到才 `open` |
| 2 | 点「恢复」后会话不立即回到工作区列表，必须刷新页面 | `unarchive` 改走 `registry.setState`，同步 registry 内存态，触发 `host/archived-sessions-changed` |
| 3 | 归档列表只显示「会话+随机后缀」，看不到真实标题 | `list` 接口通过 `sessionPersistence.inspect` 读取会话日志中的 `session/title` 事件，返回 `items: [{sessionId, title}]`；客户端优先渲染真实标题 |
| 4 | 归档后历史归档面板不立即显示新记录（要刷新页面） | 面板每次打开时重新拉取 `list` |
| 5 | 面板保持打开时归档/恢复不刷新 | 面板打开状态下每 3 秒轮询（DOM 移除后自动停止） |
| 6 | DSH 升级到 0.1.5 后归档列表又只剩「未取到标题 · id 尾号」：官方已删除 `sessionPersistence.inspect()`，旧调用静默返回 undefined | `list` 改走当前官方读法 `sessionQuery.readTitleSnapshots(ids)`（一次列出全部、折叠最新 `session/title`），并保留 `sessionPersistence.open(id, 'read')` + 日志折叠作为回退；标题按会话缓存（无标题的 30 秒后重试），避免面板轮询反复解压会话日志 |
| 7 | **官方没有物理删除入口**：会话被归档后只能一直躺在磁盘上，占空间且无法清理 | **v0.2.0 新增「删除」**：二次确认 + 四步清理管线（归档标记 → 工作区记录 → 存储目录 → 投影缓存），realpath 校验路径、拒绝逃逸符号链接、仅允许删除已归档会话；纯逻辑抽到 `src/host/paths.js` 并由 `delete-test.mjs` 覆盖 |
| 8 | **面板打开时，某些侧栏按钮"点了没反应"**：必须随便点一条会话才能恢复。原因是关闭逻辑**按名字枚举兄弟面板**（只认 `ssh` / `taskboard` 的激活事件与 `data-dsh-*-active` 属性）；任何别的面板——其它第三方面板，或**不发该自定义事件的官方面板（如内置的「插件」「技能中心」）**——都不会触发关闭。而面板打开时给主区域其他子元素上了 `display:none !important`，于是那些按钮看起来是死的 | **v0.2.1 改为「凡不是我，一律让路」**：删掉枚举式名单，改用一个点击外部判定——只要点击不在**本插件自己的入口**（`[data-dsh-archive-entry]`）或**本插件自己的面板**（`[data-dsh-archive-view]`）之内就关闭。不认识任何插件名、不依赖任何自定义事件，因此对所有插件组合都成立；原有的 `dsh-panel-activate` 事件契约与 `ssh`/`taskboard` 互斥逻辑全部保留 |

## 反馈与贡献

欢迎提 issue 或 PR：

- 发现 bug（包括上面的修复是否有副作用）、想要新功能，直接开 [issue](https://github.com/LianbinZhou/dsh-archive-manager/issues)
- 本仓库已包含完整修复；如果插件原作者发布了新版本，欢迎把本仓库的修复合并过去
- 安装/使用问题也可以在 issue 里提问

## 许可

MIT。上游为本地安装的 `dsh-archive-manager` v0.1.0（MIT），原作者未在包内署名；本仓库为修复维护版（当前 v0.2.1）。
