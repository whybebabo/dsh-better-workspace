/**
 * Permanent session deletion.
 *
 * DSH ships no host-side delete, so this is the only place in the plugin that touches
 * session artifacts on disk. It is deliberately conservative:
 *   - ids are validated, then resolved by header identity (not by name alone);
 *   - every path is re-verified against the realpath of `<DSH_HOME>/sessions` before `rm`;
 *   - a live session is only removed after its agent has actually stopped;
 *   - `preview` runs before `execute`, and a partial failure never rolls back a success.
 */
import { lstat } from 'node:fs/promises';
import {
  isSafeSessionId,
  resolveSessionsRoot,
  scanSessionIndex,
  descendantsOf,
  verifySessionDir,
  hasWriteLease,
  directorySize,
  removeVerifiedDir,
} from './session-files.js';

const STOP_WAIT_MS = 3000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function optionalService(ctx, name) {
  try {
    return ctx?.get?.(name) ?? null;
  } catch {
    return null;
  }
}

function lookupAgent(ctx, sessionId) {
  const registry = optionalService(ctx, 'agents');
  if (!registry || typeof registry.get !== 'function') return { registry, agent: null, probed: false };
  return { registry, agent: registry.get(sessionId) ?? null, probed: true };
}

/** Live status when the host exposes the agent registry; `null` when it cannot be known. */
export function liveStatus(ctx, sessionId) {
  const { agent, probed } = lookupAgent(ctx, sessionId);
  if (!probed) return null;
  if (!agent) return 'idle';
  return agent.status === 'running' ? 'running' : 'idle';
}

/**
 * Cancels a running turn the way the stop button does, then waits for the agent to leave
 * `running`. Returns a note describing what happened; never throws for a missing service.
 */
export async function stopLiveSession(ctx, sessionId) {
  const notes = [];
  const { agent } = lookupAgent(ctx, sessionId);
  if (agent && agent.status === 'running') {
    if (typeof agent.cancel === 'function') {
      try {
        await agent.cancel({ kind: 'user' });
        notes.push('agent.cancel');
      } catch (error) {
        notes.push(`agent.cancel 失败: ${error?.message || error}`);
      }
    } else {
      notes.push('运行中的 agent 不支持取消');
    }
    const deadline = Date.now() + STOP_WAIT_MS;
    while (Date.now() < deadline && agent.status === 'running') await sleep(80);
    if (agent.status === 'running') return { stopped: false, notes };
    notes.push('已停止');
  } else if (agent) {
    notes.push('未在运行');
  } else {
    notes.push('host 无活跃 agent');
  }

  const sessions = optionalService(ctx, 'sessions');
  const entered = sessions?.store?.get?.(sessionId);
  if (entered && typeof entered.detach === 'function') {
    try {
      entered.detach();
      notes.push('已从 session store detach');
    } catch (error) {
      notes.push(`session detach 失败: ${error?.message || error}`);
    }
  }

  const registry = optionalService(ctx, 'workspaceRegistry');
  if (registry && typeof registry.list === 'function') {
    try {
      for (const workspace of registry.list() ?? []) {
        if (typeof workspace?.detachSession !== 'function') continue;
        if (!(workspace.sessionIds ?? []).includes(sessionId)) continue;
        await workspace.detachSession(sessionId);
        notes.push(`已从工作区 ${workspace.id ?? '?'} detach`);
      }
    } catch (error) {
      notes.push(`workspace detach 失败: ${error?.message || error}`);
    }
  }
  return { stopped: true, notes };
}

/** `hard` blockers stop the delete; `soft` ones only require the caller to have confirmed. */
export async function previewDelete({ home, ctx, sessionIds, hintProject }) {
  const { items, rootInfo } = await analyze({ home, ctx, sessionIds, hintProject });
  return summarize(items, rootInfo);
}

/**
 * Builds the per-id verdicts from a single tree scan. `dir` stays on the item so a following
 * `execute` can re-verify the same location instead of scanning the tree again.
 */
async function analyze({ home, ctx, sessionIds, hintProject }) {
  const items = [];
  const rootInfo = await resolveSessionsRoot(home);
  const index = rootInfo
    ? await scanSessionIndex({ rootResolved: rootInfo.resolved, projects: typeof hintProject === 'string' && hintProject !== '' ? [hintProject] : null })
    : null;

  for (const sessionId of sessionIds) {
    const item = {
      sessionId,
      exists: false,
      running: false,
      subagent: false,
      subagentCount: 0,
      bytes: 0,
      cwd: null,
      title: null,
      updatedAt: null,
      blockers: [],
      dir: null,
    };
    items.push(item);

    if (!isSafeSessionId(sessionId)) {
      item.blockers.push({ code: 'bad-id', severity: 'hard', message: '会话标识不合法,已拒绝' });
      continue;
    }
    if (!rootInfo || !index) {
      item.blockers.push({ code: 'root-unavailable', severity: 'hard', message: `未找到 sessions 目录: ${home}` });
      continue;
    }
    const status = liveStatus(ctx, sessionId);
    item.running = status === 'running';
    if (item.running) item.blockers.push({ code: 'running', severity: 'soft', message: '会话正在运行,删除前会先停止它' });

    const match = index.byId.get(sessionId) ?? null;
    if (!match) {
      item.blockers.push({ code: 'not-verified', severity: 'hard', message: '未能通过 artifact header 确认该会话的文件,拒绝删除' });
      continue;
    }
    item.exists = true;
    item.dir = match.dir;
    item.cwd = match.header?.cwd ?? null;
    item.bytes = await directorySize(match.dir).catch(() => 0);
    item.subagent = match.header?.origin === 'subagent' || typeof match.header?.parentSession === 'string';
    if (item.subagent) item.blockers.push({ code: 'subagent', severity: 'hard', message: '这是子智能体会话,请删除其主会话(会级联清理)' });
    if (await hasWriteLease(match.dir)) item.blockers.push({ code: 'locked', severity: 'hard', message: '会话文件正被写入(存在写锁),请稍后重试' });

    if (!item.subagent) item.subagentCount = descendantsOf(index, sessionId).length;
  }
  return { items, rootInfo, index };
}

function summarize(items, rootInfo) {
  const count = (predicate) => items.filter(predicate).length;
  return {
    items: items.map(({ dir, ...item }) => item),
    rootAvailable: Boolean(rootInfo),
    hardBlocked: items.some((item) => item.blockers.some((blocker) => blocker.severity === 'hard')),
    running: count((item) => item.running),
    subagents: items.reduce((total, item) => total + item.subagentCount, 0),
    bytes: items.reduce((total, item) => total + item.bytes, 0),
  };
}

export async function executeDelete({ home, ctx, sessionIds, hintProject, confirm, stopActivity = true }) {
  if (confirm !== true) {
    throw Object.assign(new Error('删除会话需要明确确认'), { code: 'confirm-required' });
  }
  const { items, rootInfo, index } = await analyze({ home, ctx, sessionIds, hintProject });
  const results = [];

  for (const item of items) {
    const outcome = { sessionId: item.sessionId, status: 'failed', code: null, error: null, notes: [], subagentsRemoved: [] };
    results.push(outcome);
    const hard = item.blockers.filter((blocker) => blocker.severity === 'hard');
    if (hard.length > 0) {
      outcome.status = 'skipped';
      outcome.code = hard[0].code;
      outcome.error = hard.map((blocker) => blocker.message).join('; ');
      continue;
    }
    if (!rootInfo || !item.dir) {
      outcome.code = 'root-unavailable';
      outcome.error = '未找到 sessions 目录';
      continue;
    }
    try {
      if (item.running) {
        if (!stopActivity) {
          outcome.status = 'skipped';
          outcome.code = 'running';
          outcome.error = '会话正在运行,已跳过';
          continue;
        }
        const stop = await stopLiveSession(ctx, item.sessionId);
        outcome.notes.push(...stop.notes);
        if (!stop.stopped) {
          outcome.code = 'stop-failed';
          outcome.error = '无法停止运行中的会话,数据已保留';
          continue;
        }
      }
      // The location came from the scan; re-verify this one directory right before removing it.
      if (!(await verifySessionDir({ rootResolved: rootInfo.resolved, dir: item.dir, sessionId: item.sessionId }))) {
        outcome.code = 'not-verified';
        outcome.error = '执行前重新校验未通过,数据已保留';
        continue;
      }
      const descendants = descendantsOf(index, item.sessionId);
      await removeVerifiedDir({ rootResolved: rootInfo.resolved, dir: item.dir });
      outcome.notes.push(`已删除 ${item.dir.slice(rootInfo.resolved.length + 1)}`);
      for (const child of descendants) {
        const removed = await removeVerifiedDir({ rootResolved: rootInfo.resolved, dir: child.dir }).then(() => true).catch((error) => {
          outcome.notes.push(`子会话 ${child.id} 删除失败: ${error?.message || error}`);
          return false;
        });
        if (removed) outcome.subagentsRemoved.push(child.id);
      }
      // Only report success once the primary artifact is provably gone.
      if (await lstat(item.dir).then(() => true, () => false)) {
        outcome.code = 'delete-incomplete';
        outcome.error = '删除后会话目录仍然存在,数据已保留';
        continue;
      }
      outcome.status = 'deleted';
      outcome.code = null;
    } catch (error) {
      outcome.code = error?.code ?? 'error';
      outcome.error = error?.message ?? String(error);
    }
  }

  const summary = {
    deleted: results.filter((entry) => entry.status === 'deleted').length,
    skipped: results.filter((entry) => entry.status === 'skipped').length,
    failed: results.filter((entry) => entry.status === 'failed').length,
    subagents: results.reduce((total, entry) => total + entry.subagentsRemoved.length, 0),
  };
  return { summary, items: results };
}
