/**
 * Hover reveal for a clipped session title.
 *
 * This mirrors the native list's marquee (`useTitleMarquee` in `dsh-client-ui-workspace`):
 * entering a row crawls the title towards its far edge at a constant speed and *stops there*;
 * it does not bounce back and forth. The old implementation delegated this to a CSS keyframe
 * animation with `infinite alternate`, so the title travelled to the end and then all the way
 * back for as long as the pointer rested on the row — visibly different from the stock list,
 * and the reason the row is driven per frame now.
 *
 * The thresholds are the native ones: 0.03 px per millisecond (≈30 px/s) and an 8 px dead
 * zone, because a title clipped by a few pixels crawls a few pixels and reads as jitter rather
 * than as a reveal.
 *
 * The plan is kept as pure math so the threshold can be tested without a browser.
 */
export const MARQUEE_PX_PER_MS = 0.03;
export const MIN_REVEAL_PX = 8;

/**
 * @param {{scrollWidth: number, clientWidth: number}|null} element - a measured title element
 * @returns {{range: number, pxPerMs: number}|null} null when the title fits, or is clipped so
 *   little that moving it would read as jitter
 */
export function marqueePlan(element) {
  if (!element) return null;
  const range = Number(element.scrollWidth) - Number(element.clientWidth);
  if (!Number.isFinite(range) || range <= MIN_REVEAL_PX) return null;
  return { range, pxPerMs: MARQUEE_PX_PER_MS };
}
