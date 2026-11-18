/**
 * Merge successive permanent-delete result pages.
 *
 * A failed batch can be retried from the result dialog with only the failed ids. Replacing the
 * page with the retry's result made the earlier successes disappear (the dialog still claimed
 * "delete N sessions"), so the user could not tell what had already been removed. The host
 * result is per-session, which makes a by-id merge safe.
 */

function summarize(items) {
  const count = (status) => items.filter((item) => item.status === status).length;
  return {
    deleted: count('deleted'),
    skipped: count('skipped'),
    failed: count('failed'),
    partial: count('partial'),
    subagents: items.reduce((total, item) => total + (item.subagentsRemoved?.length ?? 0), 0),
  };
}

/**
 * Resolves a partial parent after its surviving subagents were retried.
 *
 * The host reports a partial parent once: `subagentsFailed` lists the children that survived
 * the cascade. A retry only sends those child ids, so the parent entry is not replaced and its
 * old list would otherwise keep offering an already-deleted child forever. A child whose own
 * artifact is gone (`deleted`/`partial`) is no longer a failed child of the parent.
 */
function resolvePartialParents(items) {
  const byId = new Map(items.map((item) => [item.sessionId, item]));
  let changed = false;
  const resolved = items.map((item) => {
    if (!Array.isArray(item.subagentsFailed) || item.subagentsFailed.length === 0) return item;
    const remaining = item.subagentsFailed.filter((id) => {
      const child = byId.get(id);
      return !(child && (child.status === 'deleted' || child.status === 'partial'));
    });
    if (remaining.length === item.subagentsFailed.length) return item;
    changed = true;
    const next = { ...item, subagentsFailed: remaining };
    if (next.status === 'partial' && remaining.length === 0) {
      next.status = 'deleted';
      next.code = null;
      next.error = null;
    }
    return next;
  });
  return changed ? resolved : items;
}

/**
 * @param {object|null} previous - earlier result page, if any
 * @param {object} next - the retry's result page
 * @returns {object} a cumulative result with one entry per session id
 */
export function mergeDeleteOutcomes(previous, next) {
  if (!previous) return next;
  const items = new Map();
  for (const item of previous.items ?? []) items.set(item.sessionId, item);
  for (const item of next.items ?? []) items.set(item.sessionId, item);
  const merged = resolvePartialParents([...items.values()]);
  return {
    ...next,
    items: merged,
    summary: summarize(merged),
    // Keep the earlier cleanup warning when the retry did not report one: a re-read can fix the
    // sidecar later without making the original failure untrue.
    assignmentCleanup: next.assignmentCleanup ?? previous.assignmentCleanup,
  };
}