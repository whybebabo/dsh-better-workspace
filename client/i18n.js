/**
 * Bilingual strings (zh default, en fallback).
 *
 * The panel keeps its own dictionary instead of registering a namespace with the host's
 * locale service: the host's `bind(ns)` translator resolves dotted keys as paths, and this
 * module's keys are dotted literals. Language is still *driven* by the host — `<html lang>`
 * tracks the active locale snapshot, and the locale service is polled when reachable — so
 * switching language in settings re-renders the panel without a reload.
 */
const zh = {
  'section.workspaces': '工作区',
  'group.ungrouped': '未分组',
  'workspace.all': '全部工作区',
  'workspace.add': '添加工作区…',
  'workspace.none': '还没有工作区',
  'workspace.count': '{n} 个会话',
  'workspace.current': '当前工作区',
  'workspace.renameTitle': '重命名工作区',
  'workspace.name': '工作区名称',
  'workspace.renameConflict': '已存在名为「{name}」的工作区。',
  'workspace.deleteTitle': '删除工作区',
  'workspace.deleteBody': '将把「{name}」从工作区列表中移除。文件夹与会话记录会保留,其会话将显示在「未分组」下。',
  'workspace.deleting': '正在删除工作区…',
  'workspace.renamed': '已重命名工作区为「{name}」',
  'workspace.deleted': '已删除工作区「{name}」',
  'workspace.newSession': '新会话',
  'workspace.newSessionAria': '在「{name}」中新建会话',

  'chip.workspace': '工作区:{name}',
  'chip.topic': '分组:{name}',
  'chip.clear': '清除筛选',

  'action.search': '搜索会话',
  'action.select': '批量选择',
  'action.exitSelect': '退出选择',
  'action.addTopic': '新建分组',
  'action.newSession': '新会话',
  'action.newSessionInTopic': '新建会话到分组…',
  'action.addWorkspace': '添加工作区…',
  'action.back': '返回',
  'topic.pickWorkspace': '先选择工作区',
  'action.menu': '更多操作',
  'action.close': '关闭',
  'action.cancel': '取消',
  'action.confirm': '确认',
  'action.create': '创建',
  'action.save': '保存',
  'action.rename': '重命名',
  'action.delete': '删除',
  'action.retry': '重试失败项',
  'action.done': '完成',
  'action.selectAll': '全选',
  'action.clearSelection': '清空选择',
  'action.showAll': '显示全部 {n} 条',
  'action.collapse': '收起',

  'menu.showArchived': '显示已归档',
  'menu.collapseAll': '折叠全部',
  'menu.expandAll': '展开全部',
  'menu.reload': '刷新',
  'menu.newSession': '在当前工作区新建会话',

  'topic.default': '默认分组',
  'topic.archived': '已归档',
  'topic.new': '新建分组',
  'topic.createDescription': '在同一工作区内建立分组，把相关会话收在一起。',
  'topic.name': '分组名称',
  'topic.rename': '重命名分组',
  'topic.icon': '分组图标',
  'topic.noIcon': '无图标(显示为短横)',
  'topic.filter': '只看此分组',
  'topic.batchSelect': '选择此分组全部会话',
  'topic.delete': '删除分组',
  'topic.deleteConfirm': '删除分组「{name}」?',
  'topic.deleteBody': '仅清除分组关系,{n} 个会话不会被删除,它们会回到「默认」。',
  'topic.namePlaceholder': '最多 40 字,同一工作区内不可重名',
  'topic.nameRequired': '请填写分组名称',
  'topic.nameIllegal': '分组名称不能包含控制字符',
  'topic.nameTaken': '该工作区已有同名分组',
  'topic.attach': '把已有会话加入此分组',
  'topic.attachHint': '可搜索标题,选中的会话创建后立即归入「{name}」',
  'topic.noSessions': '该工作区暂时没有可加入的历史会话',
  'topic.pickWorkspaceFirst': '先在标题栏选择一个工作区',
  'topic.selectedCount': '已选 {n} 个会话',
  'topic.emptyHere': '这个工作区还没有分组',
  'topic.moveHere': '新建分组并放入…',
  'topic.newSession': '在此分组下新建会话',
  'topic.dropHere': '拖到这里归入此分组',
  'topic.renameHint': '双击分组名可直接改名',

  'session.moveToTopic': '移动到分组…',
  'session.moveToUngrouped': '移出分组(归入默认分组)',
  'session.archive': '归档会话',
  'session.unarchive': '取消归档',
  'session.delete': '永久删除',
  'session.copyId': '复制 Session ID',
  'session.open': '打开会话',
  'session.rename': '重命名会话',
  'session.title': '会话标题',
  'session.renamed': '已重命名为「{name}」',
  'session.pin': '置顶会话',
  'session.unpin': '取消置顶',
  'session.pinned': '已置顶',
  'session.fork': '分叉会话',
  'session.subagent': '子智能体',
  'session.rowMenu': '会话操作',
  'session.copied': '已复制 Session ID',
  'session.blank': '新会话',
  'session.state.idle': '空闲',
  'session.state.running': '进行中',
  'session.state.completed': '已完成',
  'session.state.waitingApproval': '等待审批',
  'session.state.planReview': '计划待审',
  'session.state.waitingAnswer': '等待回答',
  'session.state.compactApproval': '待审批',
  'session.state.compactPlanReview': '计划待审',
  'session.state.compactAnswer': '待回答',
  'session.dragHint': '拖到分组行即可归组',
  'session.movedTo': '已移动到「{name}」',
  'session.crossWorkspace': '不能跨工作区归组',

  'picker.topic': '把 {n} 个会话移动到分组',
  'picker.newTopic': '新建分组并放入…',

  'batch.selected': '已选 {n} 个会话',
  'batch.archive': '归档',
  'batch.unarchive': '取消归档',
  'batch.move': '移动到分组',
  'batch.delete': '永久删除',
  'batch.limit': '一次最多处理 200 个会话，请缩小选择范围',
  'batch.mixed': '已归档与未归档会话不能一起处理',
  'batch.archiveDisabled': '选中项包含已归档会话',
  'batch.unarchiveDisabled': '选中项包含未归档会话',
  'batch.moveDisabled': '已归档会话不能移动分组',
  'batch.ungroupedMoveDisabled': '未分组会话没有工作区，不能移动到分组',
  'batch.runningTitle': '{n} 个会话正在运行',
  'batch.runningBody': '归档正在运行的会话会先停止它的工作。',
  'batch.stopAndArchive': '停止并归档',
  'batch.progress': '正在处理 {done}/{total}…',
  'batch.aborted': '已取消',

  'delete.title': '永久删除 {n} 个会话?',
  'delete.summary': '共 {n} 个会话,约 {size},其中 {running} 个正在运行、{subagents} 个子智能体会被一并删除。',
  'delete.warning': '删除会移除磁盘上的会话记录,无法恢复。工作区文件本身不受影响。',
  'delete.ack': '我了解此操作不可恢复',
  'delete.confirmButton': '永久删除',
  'delete.blocked': '有 {n} 个会话被安全检查拦下,不会删除。',
  'delete.runningNote': '正在运行,删除前会先停止',
  'delete.results': '删除完成:成功 {ok} 个,跳过 {skipped} 个,失败 {failed} 个。',

  'result.title': '批量操作结果',
  'result.ok': '成功 {n}',
  'result.skipped': '跳过 {n}',
  'result.failed': '失败 {n}',
  'result.none': '没有需要汇报的结果。',

  'state.loading': '正在加载分组数据…',
  'state.unavailable': '分组存储不可用,已交回原生列表。',
  'state.readonly': '分组文件已损坏,当前为只读模式(已尽量回退到备份)。',
  'state.conflict': '分组数据已被其他窗口修改,已重新加载,请重试。',
  'state.emptyTopic': '还没有分组,点击标题栏的“＋分组”新建。',
  'state.noMatch': '没有匹配的会话。',

  'composer.pickTopic': '选择分组',
  'search.placeholder': '搜索标题、工作区、分组',
  'search.limit': '最多显示 {n} 条结果',

  'time.now': '刚刚',
  'time.minutes': '{n}分钟',
  'time.hours': '{n}小时',
  'time.yesterday': '昨天',
  'time.days': '{n}天',
  'time.months': '{n}个月',
  'time.years': '{n}年',

  'host.renameUnsupported': '当前宿主版本不支持重命名会话',
  'host.commandMissing': '宿主缺少对应命令,请更新 DSH 或重试',
};

const en = {
  'section.workspaces': 'Workspaces',
  'group.ungrouped': 'Ungrouped',
  'workspace.all': 'All workspaces',
  'workspace.add': 'Add workspace…',
  'workspace.none': 'No workspaces yet',
  'workspace.count': '{n} sessions',
  'workspace.current': 'Current workspace',
  'workspace.renameTitle': 'Rename workspace',
  'workspace.name': 'Workspace name',
  'workspace.renameConflict': 'A workspace named “{name}” already exists.',
  'workspace.deleteTitle': 'Delete workspace',
  'workspace.deleteBody': 'This removes “{name}” from the workspace list. The folder and session logs will be kept. Its sessions will appear under Ungrouped.',
  'workspace.deleting': 'Deleting workspace…',
  'workspace.renamed': 'Workspace renamed to “{name}”',
  'workspace.deleted': 'Deleted workspace “{name}”',
  'workspace.newSession': 'New session',
  'workspace.newSessionAria': 'New session in {name}',

  'chip.workspace': 'Workspace: {name}',
  'chip.topic': 'Topic: {name}',
  'chip.clear': 'Clear filter',

  'action.search': 'Search sessions',
  'action.select': 'Select multiple',
  'action.exitSelect': 'Exit selection',
  'action.addTopic': 'New topic',
  'action.newSession': 'New session',
  'action.newSessionInTopic': 'New session in a topic…',
  'action.addWorkspace': 'Add workspace…',
  'action.back': 'Back',
  'topic.pickWorkspace': 'Pick a workspace',
  'action.menu': 'More actions',
  'action.close': 'Close',
  'action.cancel': 'Cancel',
  'action.confirm': 'Confirm',
  'action.create': 'Create',
  'action.save': 'Save',
  'action.rename': 'Rename',
  'action.delete': 'Delete',
  'action.retry': 'Retry failed',
  'action.done': 'Done',
  'action.selectAll': 'Select all',
  'action.clearSelection': 'Clear selection',
  'action.showAll': 'Show all {n}',
  'action.collapse': 'Collapse',

  'menu.showArchived': 'Show archived',
  'menu.collapseAll': 'Collapse all',
  'menu.expandAll': 'Expand all',
  'menu.reload': 'Refresh',
  'menu.newSession': 'New session in this workspace',

  'topic.default': 'Default',
  'topic.archived': 'Archived',
  'topic.new': 'New topic',
  'topic.createDescription': 'Create a group inside one workspace and keep related sessions together.',
  'topic.name': 'Topic name',
  'topic.rename': 'Rename topic',
  'topic.icon': 'Topic icon',
  'topic.noIcon': 'No marker (shown as a dash)',
  'topic.filter': 'Show only this topic',
  'topic.batchSelect': 'Select every session in this topic',
  'topic.delete': 'Delete topic',
  'topic.deleteConfirm': 'Delete topic “{name}”?',
  'topic.deleteBody': 'Only the grouping is cleared. {n} sessions are kept and move back to “Default”.',
  'topic.namePlaceholder': 'Up to 40 characters, unique in this workspace',
  'topic.nameRequired': 'A topic name is required',
  'topic.nameIllegal': 'Topic names cannot contain control characters',
  'topic.nameTaken': 'This workspace already has a topic with that name',
  'topic.attach': 'Add existing sessions',
  'topic.attachHint': 'Search titles; checked sessions join “{name}” as soon as it is created',
  'topic.noSessions': 'No sessions available to attach in this workspace',
  'topic.pickWorkspaceFirst': 'Pick a workspace in the header first',
  'topic.selectedCount': '{n} sessions selected',
  'topic.emptyHere': 'This workspace has no topics yet',
  'topic.moveHere': 'Create a topic and move there…',
  'topic.newSession': 'New session in this topic',
  'topic.dropHere': 'Drop here to file into this topic',
  'topic.renameHint': 'Double-click a topic name to rename it',

  'session.moveToTopic': 'Move to topic…',
  'session.moveToUngrouped': 'Move out of topic',
  'session.archive': 'Archive session',
  'session.unarchive': 'Unarchive',
  'session.delete': 'Delete forever',
  'session.copyId': 'Copy session ID',
  'session.open': 'Open session',
  'session.rename': 'Rename session',
  'session.title': 'Session title',
  'session.renamed': 'Renamed to “{name}”',
  'session.pin': 'Pin session',
  'session.unpin': 'Unpin',
  'session.pinned': 'Pinned',
  'session.fork': 'Fork session',
  'session.subagent': 'Subagent',
  'session.rowMenu': 'Session actions',
  'session.copied': 'Session ID copied',
  'session.blank': 'New session',
  'session.state.idle': 'Idle',
  'session.state.running': 'Running',
  'session.state.completed': 'Completed',
  'session.state.waitingApproval': 'Waiting for approval',
  'session.state.planReview': 'Plan awaiting review',
  'session.state.waitingAnswer': 'Waiting for answer',
  'session.state.compactApproval': 'Approval',
  'session.state.compactPlanReview': 'Plan review',
  'session.state.compactAnswer': 'Answer',
  'session.dragHint': 'Drag a session onto a topic to file it',
  'session.movedTo': 'Moved to “{name}”',
  'session.crossWorkspace': 'Sessions cannot cross workspaces',

  'picker.topic': 'Move {n} sessions to a topic',
  'picker.newTopic': 'Create a topic and move there…',

  'batch.selected': '{n} selected',
  'batch.archive': 'Archive',
  'batch.unarchive': 'Unarchive',
  'batch.move': 'Move to topic',
  'batch.delete': 'Delete forever',
  'batch.limit': 'At most 200 sessions per run — narrow the selection',
  'batch.mixed': 'Archived and unarchived sessions cannot be processed together',
  'batch.archiveDisabled': 'Selection includes archived sessions',
  'batch.unarchiveDisabled': 'Selection includes sessions that are not archived',
  'batch.moveDisabled': 'Archived sessions cannot be moved between groups',
  'batch.ungroupedMoveDisabled': 'Ungrouped sessions have no workspace and cannot be moved to a topic',
  'batch.runningTitle': '{n} sessions are running',
  'batch.runningBody': 'Archiving a running session stops its work first.',
  'batch.stopAndArchive': 'Stop and archive',
  'batch.progress': 'Processing {done}/{total}…',
  'batch.aborted': 'Cancelled',

  'delete.title': 'Delete {n} sessions forever?',
  'delete.summary': '{n} sessions, about {size}; {running} running and {subagents} subagents will be removed too.',
  'delete.warning': 'This erases the session records on disk and cannot be undone. Workspace files themselves are untouched.',
  'delete.ack': 'I understand this cannot be undone',
  'delete.confirmButton': 'Delete forever',
  'delete.blocked': '{n} sessions were held back by the safety checks and will not be deleted.',
  'delete.runningNote': 'Running — it will be stopped first',
  'delete.results': 'Delete finished: {ok} removed, {skipped} skipped, {failed} failed.',

  'result.title': 'Bulk action results',
  'result.ok': '{n} done',
  'result.skipped': '{n} skipped',
  'result.failed': '{n} failed',
  'result.none': 'Nothing to report.',

  'state.loading': 'Loading topic data…',
  'state.unavailable': 'Topic storage is unavailable; the native list is back in charge.',
  'state.readonly': 'The topic file is damaged, so the panel is read-only (restored from backup where possible).',
  'state.conflict': 'Topic data changed in another window and was reloaded — please retry.',
  'state.emptyTopic': 'No topics yet. Use “+ topic” in the header to create one.',
  'state.noMatch': 'No sessions match.',

  'composer.pickTopic': 'Choose topic',
  'search.placeholder': 'Search titles, workspaces, topics',
  'search.limit': 'Showing the first {n} matches',

  'time.now': 'just now',
  'time.minutes': '{n}m',
  'time.hours': '{n}h',
  'time.yesterday': 'yesterday',
  'time.days': '{n}d',
  'time.months': '{n}mo',
  'time.years': '{n}y',

  'host.renameUnsupported': 'This host build cannot rename sessions',
  'host.commandMissing': 'The host is missing that command — update DSH or retry',
};

const dictionaries = { zh, en };
const listeners = new Set();
let language = detect();

function detect() {
  if (typeof document === 'undefined') return 'zh';
  const lang = String(document.documentElement?.lang ?? '').toLowerCase();
  if (lang.startsWith('en')) return 'en';
  if (lang.startsWith('zh')) return 'zh';
  return navigator?.language?.toLowerCase?.().startsWith('en') ? 'en' : 'zh';
}

export function t(key, vars) {
  const text = dictionaries[language]?.[key] ?? zh[key] ?? key;
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (match, name) => (vars[name] === undefined ? match : String(vars[name])));
}

export function getLanguage() {
  return language;
}

/** @returns {boolean} whether the switch changed anything */
export function setLanguage(next) {
  const id = String(next ?? '').toLowerCase().startsWith('en') ? 'en' : String(next ?? '').toLowerCase().startsWith('zh') ? 'zh' : null;
  if (!id || id === language || !dictionaries[id]) return false;
  language = id;
  listeners.forEach((listener) => listener(id));
  return true;
}

export function subscribeLanguage(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const locale = { zh, en };
