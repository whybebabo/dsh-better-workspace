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
  isSubagentHeader,
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
  return { stopped: true, notes };
}

/**
 * Flushes and detaches a live store entry before its log is removed. This also covers
 * sessions that are open in a tab but idle; a later flush would otherwise recreate the
 * directory. Cold sessions simply have no store entry.
 */
async function detachSessionStore(ctx, sessionId) {
  const notes = [];
  const sessions = optionalService(ctx, 'sessions');
  const entered = sessions?.store?.get?.(sessionId);
  if (!entered) return notes;
  if (entered.session && typeof sessions?.flush === 'function') {
    try {
      await sessions.flush(entered.session);
      notes.push('已 flush session');
    } catch (error) {
      notes.push(`session flush 失败: ${error?.message || error}`);
    }
  }
  try {
    if (typeof entered.detach === 'function') {
      entered.detach();
      notes.push('已从 session store detach');
    } else if (typeof sessions?.store?.delete === 'function') {
      sessions.store.delete(sessionId);
      notes.push('已从 session store 移除');
    }
  } catch (error) {
    notes.push(`session detach 失败: ${error?.message || error}`);
  }
  return notes;
}

/**
 * Removes the durable bookkeeping the native UI keeps for a session that no longer has a
 * log: its workspace account, the registry-global archive/pin sets, and its projection
 * cache. These are host services, not sidecar edits; a missing service or a stale id is a
 * no-op, and a cleanup failure must not turn a completed artifact deletion into a failure.
 */
async function cleanupHostRecords(ctx, sessionIds) {
  const ids = new Set(sessionIds);
  const notes = [];
  const failures = [];
  if (ids.size === 0) return { notes, failures };
  const registry = optionalService(ctx, 'workspaceRegistry');
  const storage = optionalService(ctx, 'storageDomain');

  const table = registry?.table ?? storage?.get?.('workspace')?.table?.('workspaces') ?? null;
  if (table && typeof table.keys === 'function' && typeof table.get === 'function') {
    try {
      for (const key of [...table.keys()]) {
        const record = table.get(key);
        const hits = (record?.sessionIds ?? []).filter((id) => ids.has(id));
        if (hits.length === 0) continue;
        const entity = registry?.get?.(key);
        if (entity && typeof entity.detachSession === 'function') {
          for (const id of hits) await entity.detachSession(id);
        } else if (typeof table.update === 'function') {
          await table.update(key, (current) => ({
            ...current,
            sessionIds: (current.sessionIds ?? []).filter((id) => !ids.has(id)),
          }));
        } else {
          failures.push('工作区记录不支持更新');
          continue;
        }
        notes.push(`已从工作区 ${record?.title ?? key} 移除 ${hits.length} 个会话`);
      }
    } catch (error) {
      failures.push(`工作区记录清理失败: ${error?.message || error}`);
    }
  }

  // unarchiveSession/unpinSession never require the session to still exist, so they are the
  // official way to drop ids after the log is gone.
  for (const id of ids) {
    if (typeof registry?.unarchiveSession === 'function') {
      try {
        await registry.unarchiveSession(id);
      } catch (error) {
        failures.push(`归档记录清理失败: ${error?.message || error}`);
      }
    }
    if (typeof registry?.unpinSession === 'function') {
      try {
        await registry.unpinSession(id);
      } catch (error) {
        failures.push(`置顶记录清理失败: ${error?.message || error}`);
      }
    }
  }
  const global = registry?.global ?? storage?.get?.('workspace')?.global ?? null;
  if (global && typeof global.get === 'function' && typeof global.set === 'function') {
    try {
      const state = global.get();
      if (state) {
        const archived = state.archivedSessionIds ?? [];
        const pinned = state.pinnedSessionIds ?? [];
        const nextArchived = archived.filter((id) => !ids.has(id));
        const nextPinned = pinned.filter((id) => !ids.has(id));
        if (nextArchived.length !== archived.length || nextPinned.length !== pinned.length) {
          await global.set({ ...state, archivedSessionIds: nextArchived, pinnedSessionIds: nextPinned });
          notes.push('已清理归档/置顶记录');
        }
      }
    } catch (error) {
      failures.push(`归档/置顶记录清理失败: ${error?.message || error}`);
    }
  }

  const projection = storage?.get?.('session_projcache')?.table?.('sessions') ?? null;
  if (projection && typeof projection.delete === 'function') {
    let removed = 0;
    for (const id of ids) {
      try {
        if (await projection.delete(id)) removed += 1;
      } catch (error) {
        failures.push(`投影缓存清理失败: ${error?.message || error}`);
      }
    }
    if (removed > 0) notes.push(`已清理 ${removed} 个投影缓存`);
  }

  return { notes, failures };
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
    item.subagent = isSubagentHeader(match.header);
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
      outcome.notes.push(...await detachSessionStore(ctx, item.sessionId));
      // Remove and *prove* the primary artifact before touching its subagents: the old order
      // deleted children first, so a failed primary left them gone while the result said
      // "failed" — and a retry then had nothing left to act on.
      try {
        await removeVerifiedDir({ rootResolved: rootInfo.resolved, dir: item.dir });
      } catch (error) {
        outcome.code = error?.code ?? 'delete-failed';
        outcome.error = error?.message ?? String(error);
        continue;
      }
      if (await lstat(item.dir).then(() => true, () => false)) {
        outcome.code = 'delete-incomplete';
        outcome.error = '删除后会话目录仍然存在,数据已保留';
        continue;
      }
      outcome.notes.push(`已删除 ${item.dir.slice(rootInfo.resolved.length + 1)}`);

      const descendants = descendantsOf(index, item.sessionId);
      const failedChildren = [];
      for (const child of descendants) {
        const removed = await removeVerifiedDir({ rootResolved: rootInfo.resolved, dir: child.dir }).then(() => true).catch((error) => {
          outcome.notes.push(`子会话 ${child.id} 删除失败: ${error?.message || error}`);
          failedChildren.push(child.id);
          return false;
        });
        if (removed) outcome.subagentsRemoved.push(child.id);
      }
      const cleanup = await cleanupHostRecords(ctx, [item.sessionId, ...outcome.subagentsRemoved]);
      outcome.notes.push(...cleanup.notes);
      if (cleanup.failures.length > 0) outcome.cleanup = { failed: true, error: cleanup.failures.join('; ') };
      if (failedChildren.length > 0) {
        // The session itself is gone but some children survived: report it as such instead of
        // claiming a clean delete (a retry would find nothing to do for the parent).
        outcome.subagentsFailed = failedChildren;
        outcome.status = 'partial';
        outcome.code = 'subagents-failed';
        outcome.error = `${failedChildren.length} 个子会话未能删除`;
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
    partial: results.filter((entry) => entry.status === 'partial').length,
    subagents: results.reduce((total, entry) => total + entry.subagentsRemoved.length, 0),
  };
  return { summary, items: results };
}
