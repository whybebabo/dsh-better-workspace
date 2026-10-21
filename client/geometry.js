/**
 * Locates the native "工作区" region and tracks its geometry.
 *
 * Selection is structural, never by hashed CSS class: the sidebar column is the frame's
 * leftmost column that contains the session `[role="tree"]`, and the region root is that
 * tree's topmost ancestor directly under the column. Suffix hints (`_regionArea`) are only
 * used to break ties, so an app rebuild that changes CSS-module hashes cannot mis-target
 * the cover. When anything cannot be resolved the panel hides itself and the stock UI stays
 * in charge.
 *
 * Observation is scoped to what is actually measured — the frame, that one column, the
 * region. The document at large used to be watched with `subtree: true`, which turned every
 * streamed token into a full re-measure; the conversation is not something geometry can be
 * affected by, so it is not watched.
 */
const MIN_REGION_WIDTH = 180;
const NARROW_VIEWPORT = 1024;
const CLASS_HINTS = {
  region: '[class*="_regionArea"]',
  header: '[class*="_sectionHeader"]',
};
/**
 * 恢复轮询间隔。收窄观察范围后只剩一个盲区:挂在 frame / 列 / region 上的观察器都看不见的变化
 * (frame 被整块换掉、CSS hash 重建后 region 又能被找到、祖先元素挪动列却不触发 resize)。
 * 800ms 让最坏恢复时间仍在一秒以内 —— 侧栏展开/切会话本身就有 ~200ms 动画,更密的轮询买不到
 * 可感知的收益;稳态下这项检查只读 isConnected 与 contains,不碰布局,所以流式输出期间 0 次
 * getBoundingClientRect,长期收在 rail 的窗口每秒也只付一次属性检查。
 */
const RECOVERY_POLL_MS = 800;
/**
 * 每 10 个心跳(≈8s)做一次无条件重测。观察器只能看见「结构/属性/尺寸」的变化,看不见
 * 祖先元素把 region 整体平移这类纯布局变化;旧实现靠 900ms 无条件重测兜住它。现在把这份
 * 保险降到 ~8s 一次,换取流式输出期间真正 0 次测量 —— 覆盖层错位几秒是可见但不致命的,
 * 而每 16ms 一个 token 时的每帧测量是卡顿的直接来源。选 8s 而不是更短,是为了让一次典型
 * 的流式回答(数秒到十几秒)最多只多付一两次测量。
 */
const DEEP_RECHECK_BEATS = 10;

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
  let current = null;
  let scheduled = 0;
  let timer = null;
  let poll = null;
  let disposed = false;
  // 观察器当前挂载的目标。只有目标真的变了才重绑,否则会白白切断 ResizeObserver 的合并,
  // 并把 emit 拖进心跳里 —— 旧实现每 900ms 无条件 disconnect 再 connect 一遍。
  const watching = { frame: null, col: null, region: null };
  let roTargets = [];
  /**
   * region 的身份序号。覆盖率只看 rect,但宿主可能用同样尺寸的新 region 换掉旧的:这时 rect
   * 相同而 DOM 节点已换,调用方必须重新拿到 regionEl,否则 inert 会留在已经脱离文档的旧节点上,
   * 新列表就重新暴露在 tab 里。序号进 key 只在身份变化时多一次 onChange。
   */
  let regionSeq = 0;
  let lastRegionEl = null;

  const state = () => {
    const roots = queryFrameRoots();
    if (!roots) {
      return { visible: false, rect: null, reason: 'no-overlay', regionEl: null, treeEl: null, sidebarCol: null, frameEl: null, layerEl: null };
    }
    const { layer, frame } = roots;
    if (typeof window !== 'undefined' && window.innerWidth < NARROW_VIEWPORT) {
      return { visible: false, rect: null, reason: 'narrow-viewport', regionEl: null, treeEl: null, sidebarCol: null, frameEl: frame, layerEl: layer };
    }
    if (frame.hasAttribute('data-sidebar-collapsed')) {
      return { visible: false, rect: null, reason: 'rail', regionEl: null, treeEl: null, sidebarCol: null, frameEl: frame, layerEl: layer };
    }
    const sidebarCol = findSidebarColumn(frame, layer);
    if (!sidebarCol || isHiddenOrZero(sidebarCol)) {
      // 列本身也要留着观察:宿主把工作区整块替换时,新节点就长在这一列里。
      return { visible: false, rect: null, reason: 'no-column', regionEl: null, treeEl: null, sidebarCol, frameEl: frame, layerEl: layer };
    }
    const found = findRegionRoot(sidebarCol);
    if (!found) {
      return { visible: false, rect: null, reason: 'no-region', regionEl: null, treeEl: null, sidebarCol, frameEl: frame, layerEl: layer };
    }
    const { region, tree } = found;
    const rect = measure(layer, sidebarCol, region);
    if (rect.width < MIN_REGION_WIDTH || rect.height < 64) {
      return { visible: false, rect: null, reason: 'too-small', regionEl: region, treeEl: tree, sidebarCol, frameEl: frame, layerEl: layer };
    }
    return { visible: true, rect, reason: 'ok', regionEl: region, treeEl: tree, sidebarCol, frameEl: frame, layerEl: layer };
  };

  /**
   * 把观察器搬到当前的目标上。每一层只负责它真正能改变结论的事:
   *   frame  —— rail 开关 / 平台 / 内联布局,以及直接子节点被换掉;
   *   列     —— 宿主重建工作区、树或 region 被整块替换(会话行增删也落在这里,但那是用户
   *             操作级频率,不是 token 级);
   *   region —— 自身的 class/style 变化(尺寸由 ResizeObserver 负责)。
   * 目标没变就一个都不动。
   */
  const sync = () => {
    const frameEl = current?.frameEl ?? null;
    // 解析暂时失败不等于目标消失了:宿主重建工作区时树会先被摘掉,新节点就长在原来那一列里。
    // 继续盯着上一个仍在文档里的目标,才能在下一次 childList 就恢复,而不是等到心跳。
    const colEl = current?.sidebarCol ?? (watching.col?.isConnected ? watching.col : null);
    const regionEl = current?.regionEl ?? (watching.region?.isConnected ? watching.region : null);

    if (frameObserver && frameEl !== watching.frame) {
      frameObserver.disconnect();
      if (frameEl) {
        // subtree 关掉:frame 的直接子节点只有列和 overlay 层,聊天内容永远在更深的地方,
        // 它再怎么写都不该叫醒几何测量。
        frameObserver.observe(frameEl, {
          attributes: true,
          attributeFilter: ['data-sidebar-collapsed', 'data-platform', 'style'],
          childList: true,
          subtree: false,
        });
      }
      watching.frame = frameEl;
    }

    if (colObserver && colEl !== watching.col) {
      colObserver.disconnect();
      if (colEl) {
        // 只看结构:会话行增删、region 被重建、树被替换都在这一列里。属性变化留给 region 自己
        // 管,否则列表里每次 hover/选中换 class 都会陪一轮完整测量。
        colObserver.observe(colEl, { childList: true, subtree: true });
      }
      watching.col = colEl;
    }

    if (regionObserver && regionEl !== watching.region) {
      regionObserver.disconnect();
      if (regionEl) regionObserver.observe(regionEl, { attributes: true, attributeFilter: ['class', 'style'] });
      watching.region = regionEl;
    }

    if (resizeObserver) {
      const want = [frameEl, colEl, regionEl].filter(Boolean);
      const same = want.length === roTargets.length && want.every((el, index) => el === roTargets[index]);
      if (!same) {
        resizeObserver.disconnect();
        for (const el of want) resizeObserver.observe(el);
        roTargets = want;
      }
    }

    // 连 frame 都还没有时不挂观察器:除它之外最窄的目标就是 documentElement,而面板自己的宿主
    // overlay 层都没出现时,任何文档级观察都只是在替心跳做重复工作。这种情况交给下面的
    // RECOVERY_POLL_MS 心跳重新解析(不可见时每次都重新解析),恢复上限就是一个心跳周期。
  };

  const emit = () => {
    if (disposed) return;
    if (scheduled) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(scheduled);
      scheduled = 0;
    }
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const next = state();
    current = next;
    sync();
    // region 换了节点就换一个序号,让「尺寸一模一样但已被替换」也被当作变化上报。
    if (next.regionEl && next.regionEl !== lastRegionEl) {
      lastRegionEl = next.regionEl;
      regionSeq += 1;
    }
    const key = JSON.stringify({ visible: next.visible, rect: next.rect, reason: next.reason, region: regionSeq });
    if (key === last) return;
    last = key;
    onChange(next);
  };

  const schedule = () => {
    // rAF alone is not enough: a hidden or occluded tab freezes it, which would strand the
    // cover at a stale rect after a sidebar collapse. The timer keeps geometry correct when
    // the frame is not painting; the rAF keeps it smooth when it is.
    if (disposed || scheduled || timer !== null) return;
    if (typeof requestAnimationFrame === 'function') scheduled = requestAnimationFrame(emit);
    timer = setTimeout(emit, 80);
  };

  /**
   * 只有能移动 region 的滚动才值得重新测量。捕获阶段会收到所有可滚动祖先的 scroll ——
   * 会话区每吐一个 token 都会自动滚一下,旧的实现每次都陪一轮几何测量。target 是 region
   * 自身或它的祖先时,覆盖层才会错位。
   */
  const affectsLayout = (target) => {
    if (!target || target === window || target === document || target === document.body || target === document.documentElement) return true;
    if (current?.regionEl && (target === current.regionEl || target.contains?.(current.regionEl))) return true;
    if (current?.sidebarCol && (target === current.sidebarCol || target.contains?.(current.sidebarCol))) return true;
    return false;
  };

  const onScroll = (event) => {
    if (affectsLayout(event?.target)) schedule();
  };

  /**
   * 唯一常驻心跳。可见时只做身份检查:当初测量所用的 frame / overlay 层 / 列 / region / 树
   * 必须还是文档里那一套,否则覆盖层已经错位,必须重新测量。这项检查只读属性、不碰布局。
   * 不可见时用同一频率重新解析 —— 这是所有观察器都看不见的变化的恢复路径(frame 被换掉、
   * CSS hash 重建、region 以无法观察的方式重现)。
   */
  let beat = 0;
  const heartbeat = () => {
    if (disposed) return;
    if (!current || !current.visible) {
      schedule();
      return;
    }
    if (++beat % DEEP_RECHECK_BEATS === 0) {
      schedule();
      return;
    }
    const { frameEl, layerEl, sidebarCol, regionEl, treeEl } = current;
    const intact = Boolean(
      frameEl?.isConnected
      && layerEl?.isConnected
      && layerEl.parentElement === frameEl
      && sidebarCol?.isConnected
      && regionEl?.isConnected
      && treeEl?.isConnected
      && sidebarCol.contains(regionEl)
      && regionEl.contains(treeEl),
    );
    if (!intact) schedule();
  };

  const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
  const frameObserver = typeof MutationObserver === 'undefined' ? null : new MutationObserver(schedule);
  const colObserver = typeof MutationObserver === 'undefined' ? null : new MutationObserver(schedule);
  const regionObserver = typeof MutationObserver === 'undefined' ? null : new MutationObserver(schedule);

  current = state();
  lastRegionEl = current.regionEl;
  if (lastRegionEl) regionSeq = 1;
  last = JSON.stringify({ visible: current.visible, rect: current.rect, reason: current.reason, region: regionSeq });
  sync();
  onChange(current);

  if (typeof window !== 'undefined') {
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', onScroll, true);
  }
  poll = setInterval(heartbeat, RECOVERY_POLL_MS);

  return () => {
    if (disposed) return;
    disposed = true;
    resizeObserver?.disconnect();
    frameObserver?.disconnect();
    colObserver?.disconnect();
    regionObserver?.disconnect();
    clearInterval(poll);
    if (scheduled && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(scheduled);
    scheduled = 0;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', onScroll, true);
    }
  };
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
