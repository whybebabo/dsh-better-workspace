# 修复记录

基线：`23427c8`，`npm test` 从 141 项 → **155 项全绿**；`lib/client.js` 已重建且构建幂等。
验证方式：每条修复对应的守护测试见第四节；这些测试都用变异法自检过——把实现改回旧行为，测试必须变红（10/10）。

## 一、数据安全（宿主端）

### 1. 锁被抢 / 释放误删 → 静默丢数据
`lib/store.js` `acquireLock` / `releaseLock` / `evictStaleLock`

- 锁文件写入 `<pid>-<rand>` 令牌，`releaseLock` **先读回比对**，只有持有者能删锁。
- 过期回收不再"`rm` 后 `continue`"：改为 `rename` 到 `*.stale.<pid>.<rand>` 原子夺锁（只有一方能赢），失败方把新持有者的锁放回去。
- 判定"过期"不再只看 `mtime`：还要求令牌里的 PID 已不存在（`process.kill(pid, 0)`，`EPERM` 视为存活）。**活着的慢写入者因此永远不会被顶掉**。
- 循环开头先判超时，修掉 `rm` 失败导致的无限自旋；锁路径不是普通文件时直接报错。

实测：三方并发 → `wa, wb` 均落盘、`revision 2`（修复前只剩一方、`revision 1`）。

### 2. 损坏时用空状态覆盖全量数据
`lib/store.js` `readState` / `mutate`

- `readState` 在"文件存在但完全读不出"时返回 `state: null` 哨兵，不再返回 `fresh()`。
- `mutate` 见到哨兵直接 `store-read-only` 拒绝写；损坏主文件另存 `topics.v1.json.corrupt-<ts>` 供抢救。
- `snapshot()` 对哨兵返回只读 + 空视图 + 警告，不崩溃。

### 3. 恢复写污染备份
`lib/store.js` `writeState(state, { skipBackup })`

- 从 `.bak` 恢复的那次写入跳过备份（否则会把刚判定为垃圾的主文件复制成新备份，毁掉唯一可用副本）。
- 备份改为 `copyFile` 到临时名再 `rename`，避免写出半截备份。

### 4. 只读模式粘滞
`lib/store.js` `mutate`

- 去掉入口处基于进程级标志的拒绝，改为**每次调用从磁盘重新判定**；成功写入后复位 `corrupt`。
- 修好文件后只读状态立即解除，不需要重启宿主。

实测：损坏 → 首次写成功（带 warning、备份仍合法）→ 第二次写成功、`readOnly: false`。

### 5. CAS 可被"不带 revision"绕过
`lib/store.js` `mutateWrite` + `lib/index.js`

- 新增 `mutateWrite`：五个客户端写操作（create/update/delete/reorder/assign）强制要求 `expectedRevision`，缺失返回 `400 revision-required`。
- `forgetSessions`（删除后清理归属）保持内部 `mutate(null)`。

### 6. 错误码映射
`lib/index.js` `CLIENT_ERROR_STATUS`

- `body-too-large → 413`、`bad-json`/各类 `bad-*` → `400`、`delete-disabled → 403`，不再一律 500（500 会让客户端判定"宿主不可达"）。

### 7. 路由注册泄漏
`lib/index.js`

- 逐条注册到 `disposers`，中途失败先回滚已注册项再抛，避免残留路由指向已 dispose 的闭包。

## 二、删除安全（宿主端）

### 8. 写租约判定两端全错
`lib/session-files.js` `hasWriteLease`

原实现用 `readdir` 找 `*.lock`。核实 DSH 本体后确认：**Windows 用命名内核信号量、不落任何文件；POSIX 的 `session.lock` 一经创建永不删除**（"Release never removes the POSIX lock file"）——于是 Windows 恒 false、POSIX 恒 true。

改为看 artifact 最近修改时间（15 秒静默窗口）。这是保守近似（静默但仍在运行的会话可能漏判），但两个方向的失效都不再是"永远错"。README「已知边界」已写清取舍。

### 9. 检查后删除的 TOCTOU
`lib/session-files.js` `removeVerifiedDir`

改为：`rename` 进根内 `.trash-<pid>-<rand>` 隔离区 → 确认隔离项仍是普通目录 → 删隔离区。`rename` 原子且只解析一次路径，消除了"检查通过后父组件被换成 junction"的窗口。

实测：删除前父目录已是 junction → 拒绝、外部文件完好；删除正常路径仍成功。

### 10. 删除顺序与部分失败
`lib/delete.js` `executeDelete`

- 先删主目录并**证明确实消失**，再删子会话（原顺序相反：主删失败时子会话已不可恢复，而结果只说 "failed"）。
- 子会话有失败时返回新的 `partial` 状态 + `subagentsFailed` 列表，`summary` 增加 `partial` 计数。

## 三、客户端

### 11. 外部拖拽写入幽灵数据
`client/dnd.js` `readDragPayload` + `client/topic-tree.jsx`

- 只读私有 MIME，删除 `text/plain` 回退（`README.md`、`package.json`、`12345` 都曾通过 id 形状检查）。
- `onDragOver` 只在 `verdict.ok` 时 `preventDefault`；`onDrop` 要求 `currentDrag()` 非空，不再为外来拖拽编造工作区范围。

### 12. 全选作用于未渲染的行
`client/topic-tree.jsx`

- 分组头的全选改用 `visible`（用户真正看得到的行）；仍有未展开行时 aria-label 明说"仅已显示的 N 条，另有 M 条未展开"。

### 13. mutation 并发 + 只读不刷新
`client/store.js`

- `runMutation` 串行化：每个写请求拿到前一个产出的 revision，并发自动归档不再互相 409。
- 失败时按 `store-read-only` / `store-unreadable` / `store-write-failed` / `store-locked` / 503 重新 `load()`，让 `readOnly` 与警告横幅跟上真实状态。

### 14. 错误没有 UI 出口
`client/overlay.jsx`

- 顶部横幅改为"有任何 `state.error` 就显示"（`conflict` 仍用本地化文案），不再只渲染冲突一种。

### 15. 拖拽重排污染隐藏行
`client/overlay.jsx`

- 重排基准从"当前过滤后可见的 rows"改为 `allSessionIdsInWorkspace()`（工作区全量会话）。`orderBy` 会把未列出的 id 降到末尾，旧实现因此在搜索/筛选态下把隐藏行整体重排并持久化。

### 16. Popover 收不起来
`client/widgets.jsx` `Popover` + `header.jsx`

- 触发按钮（元素本身）被排除在 outside-pointer 判定之外，并存的是元素而不是 rect（顺带修掉定位随滚动漂移）。修前 `pointerdown` 关闭、随后 `click` 又重新打开，菜单看起来永远关不掉。

### 17. 对话框关闭后焦点掉到 body
`client/widgets.jsx` `Dialog`

- 在**首次渲染**时捕获 `document.activeElement`（早于 React 的 autoFocus），关闭时只在 `isConnected` 时还原；顺带清掉未清理的 30ms focus 定时器。

### 18. 自动归档 effect 每次渲染全量扫描
`client/overlay.jsx`

- 补依赖数组 `[list, options, store, state.workspaces]`。

## 四、测试

新增守护（每条都验证过"删掉实现就变红"）：

| 测试 | 守护的实现 |
|---|---|
| `release never deletes a lock that changed hands while we held it` | 令牌校验 |
| `a live slow holder is never evicted mid-write` | PID 存活判定 |
| `a lock left by a dead process is reclaimed` | 过期回收 |
| `two store instances serialize on the file lock` | 跨实例锁 |
| `an entirely unreadable document is never overwritten` | 空状态哨兵 |
| `a recovery write never overwrites the backup` | `skipBackup` |
| `a store leaves read-only mode after a successful repair write` | `corrupt` 复位 |
| `a write without expectedRevision is refused` | CAS 强制 |
| `removal goes through a quarantine directory inside the root` | quarantine 机制 |
| `removal cannot be redirected by swapping a parent component for a link` | 链接逃逸 |
| `a plain-text or file payload is never read as session ids` | dnd 载荷通道 |
| `clicking the menu trigger again closes the popover` | 触发元素排除 |
| `the rename dialog gives focus back to the element that opened it` | 焦点还原 |

同时**修正了 3 处旧断言**，它们原本把 bug 当成期望行为：
- `text/plain list` 被当成合法拖拽载荷；
- 损坏回退后"写入应被永久拒绝"（实际应允许恢复写并解除只读）；
- 会话重排持久化 `['ses_2','ses_1','ses_0']`（把 `ses_0` 从顺序里弄丢了）。

## 五、未修（已记录，属设计/环境取舍）

- `hintProject` 从未传入，preview 与 execute 各做一次全树扫描（性能，非正确性）；
- `resolveDshHome` 未 `resolve()`/展开 `~`，与 DSH 本体不一致；
- zstd header 的 64 KiB 读取窗口是硬编码假设（当前 165/165 真实会话可读，属潜在风险）；
- `findDescendants` / `locateSessionDir` 为死代码；
- `lib/index.js` 路由层仍无单测（同源守卫、Desktop carrier）；
- `package.json` 缺 LICENSE 文件与 repository 元数据；jsdom 30 要求 Node ≥22.22.2 与 `engines >=22.19` 不一致。
