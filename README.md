# dsh-better-workspace

[English](./README.en.md) | 简体中文

`dsh-better-workspace` 是 DeepSeek Harness 的侧边栏**主题分组**插件。它叠加在原生"工作区"区域之上，不替换官方列表：会话仍由宿主管理，插件只在这块区域上重新组织显示，并补上宿主没有的批量操作与安全删除。

有了它，散落在各个工作区里的会话可以按自己的习惯归类：

- **主题分组**：每个工作区内部是一棵树，用 emoji 标记的"分组"文件夹收纳会话，另有系统默认分组与「已归档」桶；
- **筛选与搜索**：工作区下拉筛选、面板内本地搜索、「只看此分组」；
- **批量操作**：归档 / 取消归档 / 移动到分组 / 永久删除，在选择模式下由标题栏一行原生图标按钮承载；
- **安全删除**：DSH 本身没有删除会话的命令，插件自行实现，规则是"宁可拒删"（见[永久删除的安全边界](#永久删除的安全边界)）；
- **与原生一致**：状态点、置顶上浮、行内悬浮卡、行尾操作条、定时任务时钟、图标与配色，都对齐宿主自己的实现。

插件不会接管 DSH 的其余部分：侧栏折叠、窄视口或路由不可达时，面板会**完全隐藏并交还原生 UI**（见[失效保护](#覆盖策略与失效保护)）。

## 界面预览

![dsh-better-workspace 侧边栏：工作区筛选、emoji 分组树、会话状态点与行尾操作](docs/assets/preview.png)

## 工作方式

- **叠加而非替换**：面板渲染在 `shell.overlay`，用结构选择器定位原生工作区区域，覆盖矩形与该区域自身盒子重合。被覆盖区域加上 `inert` + `aria-hidden`，官方弹窗出现时自动释放。
- **主题数据单独存放**：分组与归属关系写在 `<DSH_HOME>/dsh-better-workspace/topics.v1.json` 这个单文件 sidecar 里，可直接备份、可与宿主升级解耦；卸载插件后数据仍在。
- **顺序分两种**：分组顺序写入 sidecar（跨窗口共享）；工作区与会话的拖拽顺序存在本地偏好 `localStorage`。
- **全部走官方命令**：打开会话、归档、置顶、重命名、分叉、建工作区都调用宿主 `uiWorkspace` / `workspaces` 服务，插件不声明、不借用其它包的插槽。

## 安装

### 环境要求

- DeepSeek Harness Desktop 或 Web `0.2.1-rc.x`，`@deepseek-ai/cordis` 4.0.5；
- Node.js ≥ 22.19；
- 本机可用 Git（以 `github:` 方式安装时）。

### 从 npm 安装（推荐）

```bash
dsh plugin --profile web add @whybebabo/dsh-better-workspace
```

DSH 会把插件装进 Web profile，并把 `@whybebabo/dsh-better-workspace` 注册到 `dsh.profile.bundles`，不需要克隆仓库、手动安装依赖或构建客户端。

没有全局 `dsh` 命令时，用 `npx` 执行：

```bash
npx @deepseek-ai/dsh plugin --profile web add @whybebabo/dsh-better-workspace
```

安装命令需要本机可以使用 [Git](https://git-scm.com/) 与 pnpm；使用 `npx` 时还需要 Node.js。

Desktop 会修改 `desktop` profile，装之前建议先备份 `cordis.patch.yml` / `package.json` / `pnpm-lock.yaml`：

```bash
dsh plugin --profile desktop add @whybebabo/dsh-better-workspace
```

### 从 GitHub 安装

不经过 npm，直接从仓库安装某个发布版本：

```bash
dsh plugin --profile web add github:whybebabo/dsh-better-workspace#v0.1.0
```

把 `#v0.1.0` 换成你要的 tag。这条路径同样需要 Git 与 pnpm，也不需要克隆仓库。

### 从源码安装

需要改代码或跟 `main` 分支时：

```bash
git clone https://github.com/whybebabo/dsh-better-workspace.git
cd dsh-better-workspace
npm install && npm run build
```

先在不影响现有 profile 的隔离环境里验证一遍：

```bash
dsh --profile topic-e2e --from-default-profile web --dump-config
dsh plugin --profile topic-e2e add "link:$(pwd)"
dsh --profile topic-e2e --no-open --port 8791      # 打印带 token 的 URL
```

确认无误后装到日常使用的 profile：

```bash
dsh plugin --profile web add "link:$(pwd)"
```

以 `link:` 方式安装时，宿主读取的始终是当前目录的产物：改完代码 `npm run build` 并重启即可，不必重新 `add`。

### 启动或重启 DSH

安装后关闭旧的 DSH Web 进程并重新启动：

```bash
dsh web
```

使用 `npx` 的启动方式：

```bash
npx @deepseek-ai/dsh web
```

打开侧栏，点「工作区」标题旁出现的 ▾，或把鼠标移到「工作区」上——看到工作区下拉与分组树，说明插件已加载。

### 升级

发布新版本后重新执行安装命令并替换版本：

```bash
dsh plugin --profile web add @whybebabo/dsh-better-workspace
```

随后重启 DSH。以源码方式安装的则用：

```bash
git pull && npm install && npm run build
```

### 卸载

```bash
dsh plugin --profile web remove @whybebabo/dsh-better-workspace
```

主题数据保留在 `<DSH_HOME>/dsh-better-workspace/`，需要清除请手动删除该目录。

### 验证安装

插件在宿主上注册了只读的 `GET /state`。浏览器访问（端口换成你实际使用的）：

```powershell
Invoke-WebRequest 'http://127.0.0.1:3080/dsh-better-workspace/api/state' | Select-Object StatusCode
```

预期状态码 `200`，返回体里 `ok: true`、`result.workspaces` 是你的分组数据。

> 该路由只接受本机回环 + 同源请求，用别的机器访问会拿到 `403`，这不是故障。

## 用法

### 分组

- **新建分组**：工作区 `⋯` 菜单，或标题栏 ＋ 菜单里的「新建主题并放入…」；也可以把会话拖到目标分组来实现归类。
- **改名**：双击分组名直接内联编辑（重名与非法字符会即时提示并禁用保存）。
- **排序**：拖动分组行，拖到目标行的上/下半区决定插入位置，拖动时显示插入指示线。
- **只看此分组**：分组 `⋯` 菜单里的筛选会同时锁定它所属的工作区——同名分组不会跨工作区串味。
- **删除分组**：只清除归属，组内会话回到系统默认分组，不删会话。

每个工作区都有系统默认分组，不能改名或删除，但可以像普通分组一样拖动排序。

### 会话

- **双击**重命名（与桌面端一致）；
- **悬停**出现原版同款悬浮卡：完整标题、相对时间、空闲/进行中/待回答状态，已归档则显示归档标记；
- **行尾 hover** 出现 `⋯ / 归档 / 置顶`，悬停时行内时间让位；
- **拖拽**：拖到别的工作区会拒绝（护栏），拖到别的分组则直接归入；
- **置顶**会真正上浮到所属分组顶部（按宿主置顶顺序，最近置顶在前）。

### 批量操作

点标题栏的「选择」进入选择模式，选择模式接管标题栏：退出、已选数量、归档/取消归档/移动/永久删除排成一行原生图标按钮，窄侧栏不折行。

- 选择混入**已归档**条目时，归档与移动置灰；混入**未归档**条目时取消归档置灰；混入**未分组**会话时移动置灰；
- 工具栏下方直接说明置灰原因，悬停也有提示；
- 暂存中的「新会话」占位行不参与批量选择；
- 退出选择模式自动清空选择。

`/delete/*` 之外的操作逐条执行，失败可重试，逐条返回结果。

### 永久删除

**删除会移除磁盘上的会话记录，无法恢复**（工作区文件本身不受影响）。流程是：调 `/delete/preview` 拿逐条判定 → 用户在对话框里确认 → 调 `/delete/execute` 执行。

- 会话正在运行 → 先按官方方式 `agent.cancel({kind:'user'})` 并等待离开 running（上限 3 秒），停不下来就不删；
- 有子智能体会话 → 拦下，请删除主会话（会级联清理并在 preview 中计数）；
- 用户分叉（带 `parentSession`、`origin` 为空）是顶层会话，可单独删除，不会被当成子智能体；
- 删除当前正在看的会话后，自动切到一个新的空白会话。

### 折叠态与快捷键

侧栏折叠成窄轨后，rail 上的「新建会话 / 添加工作区 / 搜索」仍走宿主旧实现，插件在捕获阶段接管：新建会话先展开侧栏再调用与展开态完全相同的 `uiWorkspace.startSession()`；「添加工作区」只展开侧栏、不吞事件，宿主的目录选择照常继续；搜索则展开侧栏并打开面板自己的搜索框。

## 数据与文件

| 位置 | 作用 |
|---|---|
| `<DSH_HOME>/dsh-better-workspace/topics.v1.json` | 分组与归属关系（单文件，可直接备份） |
| `<DSH_HOME>/dsh-better-workspace/topics.v1.json.bak` | 上一次成功写入的副本 |
| `<DSH_HOME>/dsh-better-workspace/topics.v1.json.corrupt-<ts>` | 主文件无法解析时保留的损坏副本，供人工抢救 |
| `<DSH_HOME>/dsh-better-workspace/topics.v1.lock` | 跨进程写锁（内容为 `<pid>-<随机>` 令牌） |
| `localStorage["dsh-better-workspace:prefs:v1"]` | 工作区/分组筛选、折叠、搜索、拖拽顺序 |

写入采用 临时文件 → `fsync` → `rename`，并在覆盖前保留 `.bak`。主文件损坏时自动回退备份并进入**只读模式**（面板顶部横幅提示）；回退期间发生的那次写入不会再拿损坏的主文件覆盖 `.bak`。主文件与备份**同时**不可解析时拒绝一切写入（不会用空状态覆盖磁盘），修好文件后只读模式自动解除，无需重启宿主。

写锁释放前校验令牌，**只有持有者能删锁**；`mtime` 超过 `staleLockMs` 且令牌中的 PID 已不存在的锁才会被回收（回收用 `rename` 原子夺锁，不会误删活跃进程的锁），因此慢写入不会被判成过期而被顶掉。

**主题规则**：一个会话最多属于一个分组；分组按工作区隔离；删除分组只清除归属；每个工作区（包括尚未写入 sidecar 的新工作区）都有一个虚拟补齐的系统默认分组；归档/取消归档不改变归属；删除会话时同步清理其归属记录。虚拟「未分组」只承接没有工作区的**未归档**会话；已归档会话只出现在所属工作区的「已归档」桶里。

## 宿主路由

前缀 `/dsh-better-workspace/api`，同时注册到 `webServer`（浏览器）与 `connection.fetch`（Desktop 无端口 carrier，客户端走 `/api/...`）。仅接受本机回环 + 同源请求。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/state` | 读当前分组文档与只读状态 |
| `POST` | `/topics/create` | 新建分组（可选：同时归入若干会话） |
| `POST` | `/topics/update` | 改名 / 改图标 / 改顺序 |
| `POST` | `/topics/delete` | 删除分组（会话回到默认分组） |
| `POST` | `/topics/reorder` | 重排分组顺序 |
| `POST` | `/assign` | 把会话归入分组 |
| `POST` | `/delete/preview` | 逐条给出删除判定 |
| `POST` | `/delete/execute` | 执行删除 |

所有写请求**必须**带 `expectedRevision`（缺失返回 `400 revision-required`），不一致返回 `409` 并附 `currentRevision`，客户端重新拉取后重试。`/delete/*` 是命令式操作，不参与 revision 校验。

## 覆盖策略与失效保护

面板渲染在 `shell.overlay`，用结构选择器定位原生工作区区域（`[role="tree"]` 向上找到所属列，再取包含它的区域元素；`_regionArea` 类名后缀仅作提示），因此**不依赖 CSS module 哈希类名**。覆盖矩形取区域自身的盒子（与官方 `WorkspaceBrowser` 占位完全重合，含 section header），不再按整列铺满。被覆盖区域在面板可见时加上 `inert` + `aria-hidden`，官方弹窗出现在该区域时自动释放。

客户端入口只声明 `inject: ['slots']`：cordis 对未声明服务的属性访问会抛 `cannot get property ... without inject`，这正是此前 `topic-e2e` profile 启动失败的直接原因（读 `ctx.shortcuts` 时抛错，整个 web boot 报 "1 entry did not activate"）。

以下任一情况面板会**完全隐藏并交还原生 UI**：侧栏折叠为窄轨、视口宽 < 1024、区域宽 < 180、区域测量失败、宿主路由不可达、`config.enabled: false`。

## 永久删除的安全边界

DSH 不提供删除会话的宿主命令，插件自行实现，规则是"宁可拒删"。删除日志后，插件通过宿主的 `sessions`/`workspaceRegistry`/`storageDomain` 服务清理内存会话、工作区记账、归档/置顶记录与投影缓存，避免删完仍残留在侧栏或搜索里。具体边界：

1. 会话 id 必须是单段安全字符（拒绝 `/`、`\`、`..`）；
2. 目录必须位于 `<DSH_HOME>/sessions` 之下，路径每一级都经 `lstat` + `realpath` 校验，拒绝 symlink/junction；sessions 根本身是链接时直接拒绝；
3. 必须读取 `session.v3.jsonl[.zstd]` 首行 header 并确认 `header.id === sessionId`，仅凭目录名匹配**不删**；
4. 会话文件**最近仍在写入**时拦下（子智能体会话同样拦下，由主会话级联删除并在 preview 中计数）；仅带 `parentSession` 的用户分叉不算子智能体。注意 DSH 的写租约不是"锁文件存在与否"：Windows 用命名内核信号量、POSIX 的 `session.lock` 一经创建永不删除，所以这里改看 artifact 的最近修改时间（15 秒静默窗口），而不是 `*.lock` 文件名；
5. 运行中的会话先按官方方式 `agent.cancel({kind:'user'})` 并等待其离开 running（上限 3 秒），停不下来就不删；
6. 删除时先把目标目录 `rename` 进根内的 `.trash-<pid>-<rand>` 隔离区，再删隔离区——`rename` 是原子的且只解析一次路径，从而消除"检查通过后父目录被换成 junction"的窗口；删除后再次 `lstat` 确认目录确实消失；
7. 批量先整体 preflight 再逐条执行，部分失败不回滚已成功项，逐条返回 `deleted/skipped/partial/failed`；`partial` 表示主会话已删但有子会话未删成功（`subagentsFailed` 列出）。

## 开关与回滚

- **临时停用**：在 profile 的 `cordis.patch.yml` 里把该插件 `config.enabled` 设为 `false`，重启后官方 UI 完全恢复；
- **只关删除**：`config.enableDelete: false`（路由返回 403，批量选择工具栏不显示删除按钮）；
- **卸载**：见上面的卸载一节，主题数据文件保留在 `<DSH_HOME>/dsh-better-workspace/`。

前两项都只是改配置，不需要重新构建；插件出问题时也可以直接删除 sidecar 目录回到初始状态（会丢失分组，但会话本身不受影响）。

## 开发

```bash
npm install
npm run build     # esbuild -> lib/client.js（window.__ModuleLoader__.load 壳，外部化 react/react-dom/宿主 primitives）
npm run check     # node --check 校验 Node 端三个文件
npm test          # 155 项
```

`client/` 是源码，`lib/client.js` 是产物（已随包发布，勿手改）。测试里的 `react`/`react-dom`/`jsdom` 只是**开发依赖**：产物运行时 `require('react')` 用的是宿主已加载的实例（与 DSH 0.2.1 同为 React 18.3.1），不会打包第二份 React。

`test/` 覆盖：sidecar 的锁/原子写/revision/损坏恢复、树派生与状态汇总、批量归档分类、删除安全边界、拖拽与改名、面板在 jsdom 下的集成渲染（直接加载**构建产物**，伪造布局与 `fetch`）、定时任务频率与悬浮段、中英键集对称。

本轮的每一条安全修复都做过**变异自检**：把实现改回旧行为，对应测试必须变红。改完安全相关的代码后建议照做一遍——只加 happy-path 用例而不做这一步，很容易得到"看起来被守护、实际删掉也全绿"的测试（本轮审查就发现了 6 处这样的断言）。

### 目录结构

```
lib/              Node 端：入口、sidecar 存储、删除、会话文件解析、emoji 表
client/           浏览器端源码（.js 逻辑层 + .jsx 组件层 + styles.css）
lib/client.js     构建产物，由 client/build.mjs 生成
test/             node --test 用例
docs/assets/      README 截图
cordis.patch.yml  profile 插桩（enabled / enableDelete 开关）
```

### 发布

包名 `@whybebabo/dsh-better-workspace`，`publishConfig.access: public`，`files` 白名单只带 `lib`、`cordis.patch.yml`、`README.md`、`LICENSE` 与 `THIRD_PARTY_NOTICES.md`（源码不入包）。

```bash
npm run build          # 先构建，包里的 lib/client.js 是产物
npm pack --dry-run     # 确认文件清单
npm publish            # 发布到 npm
git tag v0.1.0 && git push --tags
```

打 tag 之后 `dsh plugin add github:whybebabo/dsh-better-workspace#v0.1.0` 这条路径才可用；两者互不影响，同版本号建议一起发布。

## 已知边界

- 分组的拖拽排序已实现，但**工作区**顺序仅存本地偏好，不跨窗口共享；
- 官方"工作区"标题栏的搜索/排序按钮被覆盖，对应能力由面板内的本地搜索提供（本地匹配，不调用远端 `sessions.search`）；
- 会话行菜单的按钮由插件自绘（不能借用官方条目，见上），但顺序、文案、图标与快捷键提示逐项对齐原版；快捷键提示取自宿主当前默认绑定，若在设置里改键，提示文字会滞后（动作本身仍走官方命令）；
- "在此分组下新建会话"依赖宿主把新会话标记为 `blank`，若某版本不再标记则退化为"不自动归组"（可手动移动），不会误改既有会话；
- 永久删除依赖 `sessions`/`agents`/`workspaceRegistry`/`storageDomain`（`session_projcache`、`workspace`）等宿主内部服务名，DSH 主版本变更时需要重新核对；缺失某个清理服务时日志仍会删除，清理失败会记录在返回结果里；
- 跨进程"正在写入"判定是**保守近似**：插件无法从浏览器/宿主进程直接查询内核租约，因此用 artifact 的最近修改时间（15 秒静默窗口）判断。刚结束写入的会话在 15 秒内可能被判为"仍在写"而暂时拒绝删除（preview 会给出 `locked` 提示，稍后重试即可）；反之一个静默但仍在运行的会话可能被漏判——这条边界宁可漏放也不误删；
- 侧栏的内联改名、拖拽排序等交互依赖浏览器原生 DOM/junction 行为，jsdom 只能覆盖结构而不覆盖视觉（"状态让位"是纯 CSS，删掉规则测试也不会红，靠人眼验收）；
- 定时任务的行首时钟与悬浮段由插件读取 `remote.schedule.catalog()` 后自绘：宿主的 `sidebar.session.row.leading` / `.hover` 两个 slot 只能由声明者（原生列表）渲染，覆盖层无法借用；`cron` 规则按宿主的原文形式 `Cron {expression}（zone）` 显示，不做人类可读的 cron 预览。注意命名空间是**独立的 cordis 服务**（`ctx.get('remote.schedule')`），不是 `remote` 的属性——后者未在 `inject` 里声明时会抛 `cannot get property "remote.schedule" without inject`，按属性读会把"服务存在"误判成"服务缺失"；解析失败时插件会 `console.warn` 一次，便于定位。catalog 字段若在后续版本改名，这两处不显示，不影响面板其它部分；
- npm 上装的是打包产物；要跟 `main` 分支或改代码，用上面的源码安装并 `npm run build`；

## 许可证

MIT。第三方致谢见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
