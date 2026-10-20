# dsh-better-workspace

DeepSeek Harness 侧边栏**主题分组**插件:叠加在原生"工作区"区域之上,不替换官方列表,提供

- 工作区下拉筛选(hover "工作区"标题出现 ▾,选中后只显示该工作区的会话);
- **三级拖动排序**:工作区行、分组行、会话行都可以拖动调整顺序(拖到目标行的上/下半区决定插入位置,拖动时显示插入指示线);会话拖到**别的分组**的会话行上是直接归入那个分组。分组顺序写入 sidecar(跨窗口共享),工作区与会话顺序存在本地偏好(`workspaceOrder` / `sessionOrder`),未排过的条目保持宿主原有顺序;
- 会话标题过长时**鼠标悬停横向滚动**显示(与原版一致),跟随 `prefers-reduced-motion`;
- 每个工作区内部的**主题文件夹树**(emoji 图标标记,选项与 [Zen Browser](https://github.com/zen-browser/desktop/blob/dev/src/zen/common/emojis/ZenEmojisData.min.mjs) 同款;无图标时显示 `-`;折叠、系统默认分组、已归档桶);
- 会话状态与宿主原生一致:待回答/待审批/计划待审显示橙色点和行尾紧凑文案(替代时间),进行中显示宿主原生转圈,已完成待查看显示绿色点;状态按「待确认 > 已完成待查看 > 进行中」汇总到分组行与工作区行:分组放在折叠箭头槽位,工作区用状态替代文件夹,工作区状态汇总整个工作区(不受「只看此分组」与搜索影响),两处都是悬停/聚焦出现箭头时状态自动让位(箭头 > 状态 > 文件夹);状态替代文件夹时用行底色保留当前工作区高亮;
- 会话批量归档 / 取消归档 / 移动到主题(逐条执行、失败可重试);**选择模式接管面板标题栏**,以一行原生图标按钮呈现退出、已选数量与归档/取消归档/移动/永久删除(窄侧栏不再折行),选中行用宿主侧栏的浅蓝强调色,行内悬浮操作条与悬停卡在选择期间让位;**选择混入已归档条目时,归档/移动分组置灰,混入未归档条目时取消归档置灰,混入未分组会话时移动分组置灰**(工具栏下方直接说明原因,悬停也有提示);暂存中的「新会话」占位行不参与批量选择;退出选择模式自动清空选择,避免高亮残留;
- 会话**永久删除**(安全删除日志 + 宿主工作区/归档/置顶/投影记录清理 + 预览确认;删除当前会话后自动切到新的空白会话);
- 历史会话归入主题(右键"移动到主题…"、新建主题时直接勾选、**拖到主题行**、**双击主题名内联改名**);
- 标题栏 ＋ 菜单只保留「新会话 / 添加工作区…」两项:**新会话就是"新会话到主题"**——先选工作区(仅在需要时)再选主题(含「默认分组」与「新建主题并放入…」);
- 宿主自带的左上角**「新会话」按钮**创建的空会话会自动归入它所属工作区**最近创建的分组**(按 `createdAt`;没有分组时留在「默认分组」)。显式「在此分组下新建会话」仍以所选分组为准;面板首次加载前就已存在的未保存空会话不会被重新归档;
- **折叠态(Ctrl+Alt+B)也接管**:侧栏收起后宿主 rail 上的「新建会话 / 添加工作区 / 搜索」仍走旧实现,插件在捕获阶段拦截它们——新建会话先展开侧边栏,再调用与展开态「新会话」按钮完全相同的 `uiWorkspace.startSession()`(不传工作区),因此两条路径落到同一页面,新建的空会话照常被归入最近创建的分组;「添加工作区」只展开侧边栏、不吞事件,宿主的目录选择与新建会话流程照常继续,落地页面与展开态一致;搜索则先展开侧边栏再打开面板自己的搜索框;
- **名称即时校验**:新建/重命名分组时,重名(同一工作区不区分大小写)与非法字符(宿主会静默剔除的控制字符)在字段下方直接给出原因,并禁用创建/保存;空名在失焦后提示。服务端仍是最终裁判;
- **新建分组对话框**沿用宿主 Modal + SettingsForm 的视觉规格:16px/500 标题、13px 三级说明、13px/500 字段标签、34px 细描边输入框、字段间 0.5px 分隔线、工作区用分段控件、深色紧凑主按钮;
- 图标与行样式对齐原生:工作区文件夹开合(`IconFolderOpen/CloseRegular`)、hover 时切换为可旋转三角、文件夹着色跟随视图(筛选优先,否则当前会话所属工作区),但**工作区收起后恢复灰色**,与原生一致;
- **输入框里的主题胶囊**:工作区选择器右边多一枚 chip,显示当前会话所属主题,点开即可改归属(不改动原生控件,只在它后面插入一个空节点做挂载点);
- 工作区高亮跟随视图:设了工作区筛选就点亮被筛选的那个,否则点亮当前会话所属工作区(文件夹被状态替代时改用行底色)。
- 「只看此主题」同时锁定该主题所属工作区——同名主题不会跨工作区串味,其他工作区也不会留下空壳;
- 中英文双语,跟随宿主语言设置热切换;中文界面里这个分组概念叫**分组**(英文仍是 topic);
- 会话行**双击即重命名**(与桌面端一致),鼠标停留出现**原版同款悬浮卡**(完整标题 + 相对时间 + 空闲/进行中/待回答等状态,已归档则显示归档标记);**定时任务(自动化任务)照原版显示**:行首 16px 槽位在会话空闲时显示时钟标记(有待回答/进行中/已完成状态时仍让位给状态点),悬浮卡在相对时间与状态之间列出该会话的活动任务(最多两条,逾期优先,其余合并为「另有 N 个任务」),任务行含标题、频率与下次运行时间(设备时区)及括号内倒计时;文案与频率格式取自宿主 `schedule.catalog`,数据来自同一个全局 `remote.schedule.catalog()` 目录;行内沿用原版的两段式交互:行尾 hover 出现 `⋯ / 归档 / 置顶` 三个按钮,行内时间随之让位;`⋯` 菜单沿用原版的顺序、图标与快捷键提示(置顶会话、重命名 Ctrl+Alt+G、分叉会话 Ctrl+Shift+F、归档会话 Ctrl+Alt+A、复制 Session ID),分隔线之后追加插件自己的「移动到主题…」与「永久删除」;已归档行则完全照原版(重命名/分叉/取消归档/复制 ID,无置顶、无移动),只额外加一条「永久删除」;「新会话」占位行也与原版一致:不显示时间与行尾操作条,双击不重命名、右键不弹菜单。工作区 `⋯` 菜单在插件的筛选/批量/新建分组之后保留原生「重命名」「删除工作区」(走宿主 `workspaces.rename/delete`;删除只移出工作区列表,文件夹与会话记录保留,会话回到「未分组」)。全部走官方 `uiWorkspace` 命令,不声明、不借用其它包的插槽(0.2.1 的槽位注册表对同一槽名只允许一个声明者,重复声明会直接让整个 web boot 失败);
- 工作区行 hover 的 ＋ 与原生一致,表示**在该工作区新建会话**(图标用原生 `IconNewChatOutlineRegular`);「新建分组」保留在工作区 `⋯` 菜单与标题栏 ＋ 菜单中;
- **置顶会真正上浮**:置顶行排到所属分组(含默认分组)的顶部(按宿主 `pinnedSessionIds` 顺序,最近置顶在前),当前"新会话"占位行仍保持最前;取消置顶后回到原来的手动/时间顺序。分组结构不变,置顶行仍留在自己的主题里;
- **图标全部取自宿主自己的图标集**(`@deepseek-ai/dsh-client-ui-primitives` 的 `Icon*Regular`,16px/描边 1),与原生菜单、行尾按钮、标题栏同源;仅当某版本改名时才回退到内置的 16 网格描边图标;
- 长列表分段渐进渲染(单桶超过 60 条折叠,点击展开)。

目标环境:DeepSeek Harness Desktop / Web `0.2.1-rc.x`,`@deepseek-ai/cordis` 4.0.5,Node ≥ 22.19。

## 安装

```bash
git clone https://github.com/whybebabo/dsh-better-workspace.git
cd dsh-better-workspace
npm install && npm run build

# 隔离环境验证(不触碰现有 profile)
dsh --profile topic-e2e --from-default-profile web --dump-config
dsh plugin --profile topic-e2e add "link:$(pwd)"
dsh --profile topic-e2e --no-open --port 8791      # 打印带 token 的 URL

# Desktop(会修改 desktop profile,请先备份 cordis.patch.yml / package.json / pnpm-lock.yaml)
dsh plugin --profile desktop add "link:$(pwd)"
```

仓库为私有。

## 数据与文件

| 位置 | 作用 |
|---|---|
| `<DSH_HOME>/dsh-better-workspace/topics.v1.json` | 主题与归属关系(单文件,可直接备份) |
| `<DSH_HOME>/dsh-better-workspace/topics.v1.json.bak` | 上一次成功写入的副本 |
| `<DSH_HOME>/dsh-better-workspace/topics.v1.lock` | 跨进程写锁,进程异常退出后 10 秒自动失效 |
| `localStorage["dsh-better-workspace:prefs:v1"]` | 工作区/主题筛选、折叠、搜索、选择模式 |

写入采用 临时文件 → `fsync` → `rename`,并在覆盖前保留 `.bak`。主文件损坏时自动回退备份并进入**只读模式**(面板顶部横幅提示);回退期间发生的那次写入不会再拿损坏的主文件覆盖 `.bak`,损坏文件另存为 `topics.v1.json.corrupt-<ts>` 供人工抢救。主文件与备份**同时**不可解析时拒绝一切写入(不会用空状态覆盖磁盘),修好文件后只读模式自动解除,无需重启宿主。

写锁是跨进程文件锁:锁文件内容为 `<pid>-<随机>` 令牌,释放前校验令牌,**只有持有者能删锁**;`mtime` 超过 `staleLockMs` 且令牌中的 PID 已不存在的锁才会被回收(回收用 `rename` 原子夺锁,不会误删活跃进程的锁)。因此慢写入不会被判成过期而被顶掉。

主题规则:一个会话最多属于一个主题;主题按工作区隔离;删除主题只清除归属,会话回到系统默认分组;每个工作区(包括尚未写入 sidecar 的新工作区)都有一个系统默认分组——面板会虚拟补齐,不可重命名或删除,但可以像普通分组一样拖动排序;归档/取消归档不改变归属;删除会话时同步清理其归属记录。虚拟「未分组」只承接没有工作区的**未归档**会话;已归档会话只出现在所属工作区的「已归档」桶里,没有工作区的归档记录不会进入未分组。

## 宿主路由

前缀 `/dsh-better-workspace/api`,同时注册到 `webServer`(浏览器)与 `connection.fetch`(Desktop 无端口 carrier,客户端走 `/api/...`)。仅接受本机回环 + 同源请求。

`GET /state` · `POST /topics/{create,update,delete}` · `POST /topics/reorder` · `POST /assign` · `POST /delete/{preview,execute}`

所有写请求**必须**带 `expectedRevision`(缺失返回 `400 revision-required`),不一致返回 `409` 并附 `currentRevision`,客户端重新拉取后重试。`/delete/*` 是命令式操作,不参与 revision 校验。

## 覆盖策略与失效保护

面板渲染在 `shell.overlay`,用结构选择器定位原生工作区区域(`[role="tree"]` 向上找到所属列,再取包含它的区域元素;`_regionArea` 类名后缀仅作提示),因此**不依赖 CSS module 哈希类名**。覆盖矩形取区域自身的盒子(与官方 `WorkspaceBrowser` 占位完全重合,含 section header),不再按整列铺满。被覆盖区域在面板可见时加上 `inert` + `aria-hidden`,官方弹窗出现在该区域时自动释放。

客户端入口只声明 `inject: ['slots']`:cordis 对未声明服务的属性访问会抛 `cannot get property ... without inject`,这正是此前 `topic-e2e` profile 启动失败的直接原因(读 `ctx.shortcuts` 时抛错,整个 web boot 报 "1 entry did not activate")。

以下任一情况面板会**完全隐藏并交还原生 UI**:侧栏折叠为窄轨、视口宽 < 1024、区域宽 < 180、区域测量失败、宿主路由不可达、`config.enabled: false`。

## 永久删除的安全边界

DSH 不提供删除会话的宿主命令,插件自行实现,规则是"宁可拒删"。删除日志后,插件通过宿主的 `sessions`/`workspaceRegistry`/`storageDomain` 服务清理内存会话、工作区记账、归档/置顶记录与投影缓存,避免删完仍残留在侧栏或搜索里;用户分叉会话(带 `parentSession`、`origin` 为空)是顶层会话,可单独删除,不会被当成子智能体,也不会在主会话删除时被级联。具体边界:

1. 会话 id 必须是单段安全字符(拒绝 `/`、`\`、`..`);
2. 目录必须位于 `<DSH_HOME>/sessions` 之下,路径每一级都经 `lstat` + `realpath` 校验,拒绝 symlink/junction;sessions 根本身是链接时直接拒绝;
3. 必须读取 `session.v3.jsonl[.zstd]` 首行 header 并确认 `header.id === sessionId`,仅凭目录名匹配**不删**;
4. 会话文件**最近仍在写入**时拦下(子智能体会话同样拦下,由主会话级联删除并在 preview 中计数);仅带 `parentSession` 的用户分叉不算子智能体。注意 DSH 的写租约不是"锁文件存在与否":Windows 用命名内核信号量、POSIX 的 `session.lock` 一经创建永不删除,所以这里改看 artifact 的最近修改时间(15 秒静默窗口),而不是 `*.lock` 文件名;
5. 运行中的会话先按官方方式 `agent.cancel({kind:'user'})` 并等待其离开 running(上限 3 秒),停不下来就不删;
6. 删除时先把目标目录 `rename` 进根内的 `.trash-<pid>-<rand>` 隔离区,再删隔离区——`rename` 是原子的且只解析一次路径,从而消除"检查通过后父目录被换成 junction"的窗口;删除后再次 `lstat` 确认目录确实消失;
7. 批量先整体 preflight 再逐条执行,部分失败不回滚已成功项,逐条返回 `deleted/skipped/partial/failed`;`partial` 表示主会话已删但有子会话未删成功(`subagentsFailed` 列出)。

## 开关与回滚

- 临时停用:在 profile 的 `cordis.patch.yml` 里把该插件 `config.enabled` 设为 `false`,重启后官方 UI 完全恢复;
- 只关删除:`config.enableDelete: false`(路由返回 403,批量选择工具栏不显示删除按钮);
- 卸载:`dsh plugin --profile <name> remove dsh-better-workspace`;主题数据文件保留在 `<DSH_HOME>/dsh-better-workspace/`,如需清掉请手动删除该目录。

## 开发

```bash
npm install
npm run build     # esbuild -> lib/client.js(window.__ModuleLoader__.load 壳,外部化 react/react-dom/宿主 primitives)
npm test          # 153 项:sidecar 锁/原子写/revision/损坏恢复、树派生、批量归档分类、删除安全、拖拽/改名/渲染集成、定时任务频率与悬浮段
```

`client/` 是源码,`lib/client.js` 是产物(已随包发布,勿手改)。测试里的 `react`/`react-dom`/`jsdom` 只是**开发依赖**:产物运行时 `require('react')` 用的是宿主已加载的实例(与 DSH 0.2.1 同为 React 18.3.1),不会打包第二份 React。

`test/panel.test.mjs` 直接加载**构建产物**跑 jsdom 集成测试(伪造布局与 `fetch`),覆盖拖拽归组、内联改名、渐进渲染、"主题下新建会话"的认领逻辑、语言热切换、原生图标与回退、折叠让位,以及"注册项不得声明他人的槽位"这一启动安全约束。

本轮的每一条安全修复都做过**变异自检**:把实现改回旧行为,对应测试必须变红。改完安全相关的代码后建议照做一遍——只加 happy-path 用例而不做这一步,很容易得到"看起来被守护、实际删掉也全绿"的测试(本轮审查就发现了 6 处这样的断言)。

## 已知边界

- 主题拖拽排序未做,当前按创建顺序;
- 官方"工作区"标题栏的搜索/排序按钮被覆盖,对应能力由面板内的本地搜索提供(本地匹配,不调用远端 `sessions.search`);
- 会话行菜单的按钮由插件自绘(不能借用官方条目,见上),但顺序、文案、图标与快捷键提示逐项对齐原版;快捷键提示取自宿主当前默认绑定,若在设置里改键,提示文字会滞后(动作本身仍走官方命令);
- "在此主题下新建会话"依赖宿主把新会话标记为 `blank`,若某版本不再标记则退化为"不自动归组"(可手动移动),不会误改既有会话;
- 永久删除依赖 `sessions`/`agents`/`workspaceRegistry`/`storageDomain`(`session_projcache`、`workspace`)等宿主内部服务名,DSH 主版本变更时需要重新核对;缺失某个清理服务时日志仍会删除,清理失败会记录在返回结果里;
- 跨进程"正在写入"判定是**保守近似**:插件无法从浏览器/宿主进程直接查询内核租约,因此用 artifact 的最近修改时间(15 秒静默窗口)判断。刚结束写入的会话在 15 秒内可能被判为"仍在写"而暂时拒绝删除(preview 会给出 `locked` 提示,稍后重试即可);反之一个静默但仍在运行的会话可能被漏判——这条边界宁可漏放也不误删;
- 侧栏的内联改名、拖拽排序等交互依赖浏览器原生 DOM/junction 行为,jsdom 只能覆盖结构而不覆盖视觉("状态让位"是纯 CSS,删掉规则测试也不会红,靠人眼验收);
- 定时任务的行首时钟与悬浮段由插件读取 `remote.schedule.catalog()` 后自绘:宿主的 `sidebar.session.row.leading` / `.hover` 两个 slot 只能由声明者(原生列表)渲染,覆盖层无法借用;`cron` 规则按宿主的原文形式 `Cron {expression}（zone）` 显示,不做人类可读的 cron 预览。注意命名空间是**独立的 cordis 服务**(`ctx.get('remote.schedule')`),不是 `remote` 的属性——后者未在 `inject` 里声明时会抛 `cannot get property "remote.schedule" without inject`,按属性读会把"服务存在"误判成"服务缺失"(2633ab8 即因此实测不生效);解析失败时插件会 `console.warn` 一次,便于定位。catalog 字段若在后续版本改名,这两处不显示,不影响面板其它部分。

许可证:MIT。第三方致谢见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
