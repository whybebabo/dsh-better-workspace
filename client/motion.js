/**
 * Row motion for reorder drops — the geometry half, kept free of React so it can be tested.
 *
 * The stock sidebar glides keyed rows to their new slots over 200 ms instead of snapping
 * (`AnimatedRows` in `ui-workspace`). The panel's tree is rebuilt from the store on every
 * publish, so by the time React hands the commit back every row is already in its new place;
 * the only way back to the old geometry is a snapshot taken before the commit, which is what
 * `RowMotion` keeps. These helpers decide what moved and by how much.
 *
 * Levels are checked outermost-first because a workspace move also reorders the topics and
 * sessions inside it: animating every level would travel the same pixels twice, so only the
 * container moves.
 */

/** Matches the stock sidebar's row glide, so a drop here reads like a drop there. */
export const ROW_GLIDE_MS = 200;

/** Outermost first: the first level whose order changed is the one that animates. */
export const MOTION_LEVELS = ['workspace', 'topic', 'session'];

/**
 * The outermost level whose rows kept their keys but changed order, or `null`.
 *
 * Returning the level (not just a boolean) lets `RowMotion` capture and read only that level:
 * a workspace move previously measured every session row twice even though the animation was
 * applied to the six group containers.
 */
export function candidateLevel(previous, next) {
  if (!previous || !next) return null;
  for (const level of MOTION_LEVELS) {
    const before = previous[level] ?? [];
    const after = next[level] ?? [];
    if (before.length < 2 || before.length !== after.length) continue;
    if (before.every((key, index) => key === after[index])) continue;
    const keys = new Set(after);
    if (before.every((key) => keys.has(key))) return level;
  }
  return null;
}

/** Cheap pre-check for "could this commit have moved anything?". */
export function couldReorder(previous, next) {
  return candidateLevel(previous, next) !== null;
}

/** Rendered rows in document order, with the rect each one occupies right now. */
export function readMotionRows(host, level = null) {
  if (!host || typeof host.querySelectorAll !== 'function') return [];
  const rows = [];
  for (const entryLevel of level ? [level] : MOTION_LEVELS) {
    for (const element of host.querySelectorAll(`[data-dts-motion="${entryLevel}"]`)) {
      const key = element.getAttribute('data-dts-key');
      if (!key) continue;
      const rect = element.getBoundingClientRect();
      // The enclosing unit of a higher level: a topic inside its workspace, a session inside
      // its topic. A row that changed parents was moved, not reordered — the glide would have
      // it fly across the list instead of acknowledging the release.
      const parent = element.parentElement?.closest?.('[data-dts-motion]')?.getAttribute('data-dts-key') ?? '';
      rows.push({ level: entryLevel, key, element, top: rect.top, left: rect.left, parent });
    }
  }
  return rows;
}

/**
 * The level whose rows swapped places, or `null` when this update was not a reorder.
 *
 * A membership change (filter, reveal, new session) leaves nothing to animate: the row that
 * appeared has no origin, and the set comparison below refuses it. Collapse/expand keeps the
 * same order too, and is already animated by the grid-row transition — animating it here
 * would fight that transition frame by frame.
 */
export function movedLevel(before, after) {
  for (const level of MOTION_LEVELS) {
    const previous = before.filter((row) => row.level === level);
    const next = after.filter((row) => row.level === level);
    if (previous.length < 2 || previous.length !== next.length) continue;
    if (previous.every((row, index) => row.key === next[index].key)) continue;
    const parents = new Map(previous.map((row) => [row.key, row.parent]));
    if (!next.every((row) => parents.get(row.key) === row.parent)) continue;
    const keys = new Set(previous.map((row) => row.key));
    if (!next.every((row) => keys.has(row.key))) continue;
    return level;
  }
  return null;
}
