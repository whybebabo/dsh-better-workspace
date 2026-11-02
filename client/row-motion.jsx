/**
 * The tree container plus the reorder glide.
 *
 * `TopicTree` hands this component the rendered key order of every level. When that order
 * changes, the previous rects are captured before React mutates the DOM and each row that
 * moved is animated from its old place to its new one — the same 200 ms ease-out the stock
 * sidebar uses, so a drop lands instead of snapping.
 *
 * The snapshot is only taken when a reorder is possible: `candidateLevel` compares the key
 * arrays React already computed (same rows, different order) and names the outermost level
 * that moved, which keeps the layout reads out of ordinary renders, membership changes and
 * the levels that will not animate.
 */
import * as React from 'react';
import { candidateLevel, movedLevel, readMotionRows, ROW_GLIDE_MS } from './motion.js';

function prefersReducedMotion() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export class RowMotion extends React.Component {
  constructor(props) {
    super(props);
    this.host = React.createRef();
    /** In-flight animations keyed by row: a second drop cancels the first instead of stacking. */
    this.animations = new Map();
  }

  getSnapshotBeforeUpdate(previous) {
    const level = candidateLevel(previous.keys, this.props.keys);
    if (!level || prefersReducedMotion()) return null;
    return { level, rows: readMotionRows(this.host.current, level) };
  }

  componentDidUpdate(_previous, _state, before) {
    if (!before || before.rows.length === 0) return;
    const after = readMotionRows(this.host.current, before.level);
    const level = movedLevel(before.rows, after);
    if (!level) return;
    this.cancel();
    const origins = new Map(
      before.rows.filter((row) => row.level === level).map((row) => [row.key, row]),
    );
    for (const row of after) {
      if (row.level !== level) continue;
      const origin = origins.get(row.key);
      if (!origin || typeof row.element.animate !== 'function') continue;
      const dx = origin.left - row.left;
      const dy = origin.top - row.top;
      // A row that did not move has nothing to travel; starting an identity animation would
      // still promote it to its own compositing layer for 200 ms.
      if (dx === 0 && dy === 0) continue;
      const animation = row.element.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
        { duration: ROW_GLIDE_MS, easing: 'ease-out' },
      );
      this.animations.set(row.element, animation);
      animation.onfinish = () => { this.animations.delete(row.element); };
    }
  }

  componentWillUnmount() {
    this.cancel();
  }

  cancel() {
    for (const animation of this.animations.values()) {
      animation.onfinish = null;
      animation.cancel();
    }
    this.animations.clear();
  }

  render() {
    return (
      <div
        ref={this.host}
        className={this.props.className}
        role="tree"
        aria-label={this.props.label}
        aria-multiselectable={this.props.multiselectable ? true : undefined}
      >
        {this.props.children}
      </div>
    );
  }
}
