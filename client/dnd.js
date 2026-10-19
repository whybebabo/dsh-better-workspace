/**
 * Drag-and-drop filing state.
 *
 * Browsers hide `DataTransfer` payloads during `dragover` (only the mime types are readable),
 * so a drop target cannot decide "would this be allowed?" from the event alone. The drag
 * source publishes a module-local context for the duration of the drag; the payload is still
 * read from `dataTransfer` on drop, which is what makes the actual write correct.
 */
export const DND_MIME = 'application/x-dsh-topic-sessions';

/** Same shape the host sidecar accepts; anything else cannot be a session id. */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

let context = null;

export function beginDrag({ ids, workspaceId, fromTopicId }) {
  context = { ids: [...new Set(ids ?? [])], workspaceId: workspaceId ?? null, fromTopicId: fromTopicId ?? null };
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
