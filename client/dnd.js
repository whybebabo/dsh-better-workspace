/**
 * Drag-and-drop filing state.
 *
 * Browsers hide `DataTransfer` payloads during `dragover` (only the mime types are readable),
 * so a drop target cannot decide "would this be allowed?" from the event alone. The drag
 * source publishes a module-local context for the duration of the drag; the payload is still
 * read from `dataTransfer` on drop, which is what makes the actual write correct.
 */
export const DND_MIME = 'application/x-dsh-topic-sessions';
/** Payload for "move this row inside its own level" drags (workspace / topic / session). */
export const REORDER_MIME = 'application/x-dsh-better-workspace-reorder';

/** Same shape the host sidecar accepts; anything else cannot be a session id. */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

let context = null;

export function beginDrag({ ids, workspaceId, fromTopicId }) {
  context = { kind: 'file', ids: [...new Set(ids ?? [])], workspaceId: workspaceId ?? null, fromTopicId: fromTopicId ?? null };
  return context;
}

/** Starts a reorder drag: one row moved inside its own level. */
export function beginReorder({ level, id, workspaceId, topicId }) {
  context = { kind: 'reorder', level, id, workspaceId: workspaceId ?? null, topicId: topicId ?? null };
  return context;
}

export function currentDrag() {
  return context;
}

export function endDrag() {
  context = null;
}

/**
 * @param {object|null} drag - the active drag context
 * @param {object} target - { workspaceId, topicId | null } (`null` topic means the unfiled bucket)
 * @returns {{ok: boolean, reason: string|null}}
 */
export function evaluateDrop(drag, target) {
  if (!drag || drag.ids.length === 0) return { ok: false, reason: 'empty' };
  if (!target) return { ok: false, reason: 'no-target' };
  if (drag.workspaceId && target.workspaceId && drag.workspaceId !== target.workspaceId) {
    return { ok: false, reason: 'cross-workspace' };
  }
  if (drag.ids.length === 1 && drag.fromTopicId === target.topicId) return { ok: false, reason: 'already-there' };
  return { ok: true, reason: null };
}

/**
 * Reordering is level-scoped: a workspace moves among workspaces, a topic among the topics
 * of its own workspace, a session among the rows of its own topic. Anything else is refused
 * so a drag can never silently change what a row *means*.
 */
export function reorderVerdict(drag, target) {
  if (!drag || drag.kind !== 'reorder' || !target) return { ok: false, reason: 'not-a-reorder' };
  if (target.level !== drag.level) return { ok: false, reason: 'level' };
  if (target.id === drag.id) return { ok: false, reason: 'self' };
  if (drag.level !== 'workspace' && target.workspaceId !== drag.workspaceId) return { ok: false, reason: 'cross-workspace' };
  if (drag.level === 'session' && target.topicId !== drag.topicId) return { ok: false, reason: 'cross-topic' };
  return { ok: true, reason: null };
}

/** Reads the dropped ids, preferring the structured payload and falling back to plain text. */
export function readDragPayload(dataTransfer) {
  const raw = dataTransfer?.getData?.(DND_MIME) || dataTransfer?.getData?.('text/plain') || '';
  if (!raw) return [];
  const candidates = (() => {
    try {
      const parsed = JSON.parse(raw);
      const ids = Array.isArray(parsed) ? parsed : parsed?.ids;
      if (Array.isArray(ids)) return ids;
    } catch {
      /* not JSON — fall through to the plain-text list */
    }
    return raw.split(',').map((entry) => (typeof entry === 'string' ? entry.trim() : entry));
  })();
  // A drop writes assignments, so foreign payloads (a dragged file, another app's text) must
  // yield nothing rather than a plausible-looking id.
  return [...new Set(candidates.filter((id) => typeof id === 'string' && SESSION_ID_RE.test(id)))];
}

export function writeDragPayload(dataTransfer, ids) {
  const payload = JSON.stringify(ids);
  try {
    dataTransfer.setData(DND_MIME, payload);
    dataTransfer.setData('text/plain', payload);
  } catch {
    /* some browsers lock setData outside of dragstart */
  }
}

export function writeReorderPayload(dataTransfer, payload) {
  try {
    dataTransfer.setData(REORDER_MIME, JSON.stringify(payload));
  } catch {
    /* some browsers lock setData outside of dragstart */
  }
}
