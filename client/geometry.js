/**
 * Locates the native "工作区" region and tracks its geometry.
 *
 * Selection is structural, never by hashed CSS class: the sidebar column is the frame's
 * leftmost column that contains the session `[role="tree"]`, and the region root is that
 * tree's topmost ancestor directly under the column. Suffix hints (`_regionArea`) are only
 * used to break ties, so an app rebuild that changes CSS-module hashes cannot mis-target
 * the cover. When anything cannot be resolved the panel hides itself and the stock UI stays
 * in charge.
 */
const MIN_REGION_WIDTH = 180;
const NARROW_VIEWPORT = 1024;
const CLASS_HINTS = {
  region: '[class*="_regionArea"]',
  header: '[class*="_sectionHeader"]',
};

export function queryFrameRoots() {
  if (typeof document === 'undefined') return null;
  const layer = document.querySelector('[data-shell-overlay]');
  const frame = layer?.parentElement;
  if (!layer || !frame) return null;
  return { layer, frame };
}

function isHiddenOrZero(el) {
  if (!el) return true;
  const rect = el.getBoundingClientRect();
  return rect.width <= 0 || rect.height <= 0;
}

/** Left-most column of the frame that owns the session tree, excluding the overlay layer. */
export function findSidebarColumn(frame, layer) {
  const candidates = [...frame.children].filter((child) => child !== layer && child.contains(document.querySelector('[role="tree"]')));
  if (candidates.length === 0) return null;
  candidates.sort((left, right) => {
    const a = left.getBoundingClientRect().left;
    const b = right.getBoundingClientRect().left;
    return a === b ? left.getBoundingClientRect().width - right.getBoundingClientRect().width : a - b;
  });
  return candidates[0] ?? null;
}

/** The workspace region: the column's top-level child that contains the tree. */
export function findRegionRoot(sidebarCol) {
  const tree = sidebarCol.querySelector('[role="tree"]');
  if (!tree) return null;

  const hinted = sidebarCol.querySelector(CLASS_HINTS.region);
  if (hinted && (hinted === tree || hinted.contains(tree)) && !isHiddenOrZero(hinted)) {
    return { region: hinted, tree, header: hinted.querySelector(CLASS_HINTS.header) };
  }

  // Climb to the column's direct child that owns the tree. Real builds wrap the region in
  // a zero-sized layout element, so fall through to the first sized descendant that still
  // contains the tree rather than covering nothing.
  let cursor = tree;
  let guard = 0;
  while (cursor.parentElement && cursor.parentElement !== sidebarCol && guard++ < 24) cursor = cursor.parentElement;
  if (cursor.parentElement !== sidebarCol) return null;
  if (isHiddenOrZero(cursor)) {
    let inner = [...cursor.children].find((child) => child.contains(tree));
    let depth = 0;
    while (inner && isHiddenOrZero(inner) && depth++ < 4) inner = [...inner.children].find((child) => child.contains(tree));
    if (inner && !isHiddenOrZero(inner)) cursor = inner;
    else return null;
  }
  return { region: cursor, tree, header: cursor.querySelector(CLASS_HINTS.header) };
}

// The panel covers the region itself (section header included), not the whole column: the
// region already carries the sidebar's side padding, so its box is the exact seat the stock
// browser occupied.
function measure(layer, sidebarCol, region) {
  const layerRect = layer.getBoundingClientRect();
  const colRect = sidebarCol.getBoundingClientRect();
  const regionRect = region.getBoundingClientRect();
  return {
    left: Math.round(regionRect.left - layerRect.left),
    top: Math.round(regionRect.top - layerRect.top),
    width: Math.round(regionRect.width),
    height: Math.round(regionRect.height),
    regionTop: Math.round(regionRect.top - colRect.top),
  };
}

/**
 * @param {(state: {visible: boolean, rect: object|null, reason: string}) => void} onChange
 * @returns {() => void} unsubscribe
 */
export function observeWorkspaceRegion(onChange) {
  let last = null;
  let frame = null;
  let scheduled = 0;
  let timer = null;

  const state = () => {
    const roots = queryFrameRoots();
    if (!roots) return { visible: false, rect: null, reason: 'no-overlay', regionEl: null, frameEl: null };
    const { layer, frameElement } = { frameElement: roots.frame, layer: roots.layer };
    frame = frameElement;
    if (typeof window !== 'undefined' && window.innerWidth < NARROW_VIEWPORT) {
      return { visible: false, rect: null, reason: 'narrow-viewport', regionEl: null, frameEl: frame };
    }
    if (frame.hasAttribute('data-sidebar-collapsed')) {
      return { visible: false, rect: null, reason: 'rail', regionEl: null, frameEl: frame };
    }
    const sidebarCol = findSidebarColumn(frame, layer);
    if (!sidebarCol || isHiddenOrZero(sidebarCol)) return { visible: false, rect: null, reason: 'no-column', regionEl: null, frameEl: frame };
    const found = findRegionRoot(sidebarCol);
    if (!found) return { visible: false, rect: null, reason: 'no-region', regionEl: null, frameEl: frame };
    const { region, tree } = found;
    const rect = measure(layer, sidebarCol, region);
    if (rect.width < MIN_REGION_WIDTH || rect.height < 64) {
      return { visible: false, rect: null, reason: 'too-small', regionEl: region, frameEl: frame };
    }
    return { visible: true, rect, reason: 'ok', regionEl: region, treeEl: tree, sidebarCol, frameEl: frame };
  };

  const emit = () => {
    scheduled = 0;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const next = state();
    const key = JSON.stringify({ visible: next.visible, rect: next.rect, reason: next.reason });
    if (key === last) return;
    last = key;
    onChange(next);
  };

  const schedule = () => {
    // rAF alone is not enough: a hidden or occluded tab freezes it, which would strand the
    // cover at a stale rect after a sidebar collapse. The timer keeps geometry correct when
    // the frame is not painting; the rAF keeps it smooth when it is.
    if (scheduled) return;
    scheduled = requestAnimationFrame(emit);
    timer = setTimeout(emit, 80);
  };

  const observers = [];
  const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
  const mo = typeof MutationObserver === 'undefined' ? null : new MutationObserver(schedule);
  const treeObserver = typeof MutationObserver === 'undefined' ? null : new MutationObserver(schedule);

  const initial = state();
  last = JSON.stringify({ visible: initial.visible, rect: initial.rect, reason: initial.reason });
  onChange(initial);

  if (typeof window !== 'undefined') {
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
  }
  if (ro && initial.frameEl) ro.observe(initial.frameEl);
  if (mo && initial.frameEl) mo.observe(initial.frameEl, { attributes: true, attributeFilter: ['data-sidebar-collapsed', 'data-platform', 'style'], subtree: false });
  if (treeObserver && document?.documentElement) {
    treeObserver.observe(document.documentElement, { childList: true, subtree: true });
  }
  // Re-attach the size observers to whatever is currently in the DOM, then re-measure.
  // Rebinding also emits: an invisible panel must keep polling, or it could never come back
  // after a rail collapse (the region element it used to watch is gone from the layout).
  const rebind = () => {
    const current = state();
    if (ro) {
      ro.disconnect();
      const roots = queryFrameRoots();
      if (roots?.frame) ro.observe(roots.frame);
      for (const element of [current.sidebarCol, current.regionEl]) {
        if (element) ro.observe(element);
      }
    }
    emit();
    return current;
  };
  rebind();
  const interval = setInterval(rebind, 900);

  observers.push(() => {
    ro?.disconnect();
    mo?.disconnect();
    treeObserver?.disconnect();
    clearInterval(interval);
    if (scheduled) cancelAnimationFrame(scheduled);
    if (timer !== null) clearTimeout(timer);
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
    }
  });

  return () => observers.forEach((dispose) => dispose());
}

/**
 * Neutralises the covered native controls so tab order and clicks cannot reach them.
 * Released while a native dialog renders inside the region (the dialog owns the screen).
 */
export function setRegionInert(regionEl, inert) {
  if (!regionEl) return;
  if (inert && regionEl.querySelector('[aria-modal="true"]')) return;
  if (inert) {
    regionEl.setAttribute('inert', '');
    regionEl.setAttribute('aria-hidden', 'true');
    return;
  }
  regionEl.removeAttribute('inert');
  regionEl.removeAttribute('aria-hidden');
}

/**
 * Reports whether a modal is currently rendered inside the covered region, so the caller can
 * stop inerting while the native rename / add-workspace dialog is open (those portal into the
 * sidebar rather than to `body`).
 */
export function watchRegionModals(regionEl, onChange) {
  if (!regionEl || typeof MutationObserver === 'undefined') return () => {};
  const read = () => Boolean(regionEl.querySelector('[aria-modal="true"], [role="dialog"]'));
  let last = read();
  onChange?.(last);
  const observer = new MutationObserver(() => {
    const next = read();
    if (next !== last) {
      last = next;
      onChange(next);
    }
  });
  observer.observe(regionEl, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-modal', 'role'] });
  return () => observer.disconnect();
}
