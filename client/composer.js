/**
 * Anchors the composer's workspace row and owns the seat for the topic chip.
 *
 * The native "选择工作区" button lives in a flex row inside the conversation body, followed
 * by the mode chip. There is no slot for extra composer controls, so the plugin inserts one
 * empty `<span>` immediately after that button and renders into it (React portal from the
 * panel). Only that one node is added — the host's own elements are never moved or rewritten,
 * and if the row cannot be located the chip simply does not appear.
 *
 * Observation is scoped to the seat: the row we inserted into, its parent (where the host
 * swaps the whole row), and a slow identity check. Watching the document turned every
 * streamed token into a full row search; the conversation is not something this module can
 * be affected by, so it is not watched.
 */
// The class hash changes per build, and the row is `..._heroWorkspaceRow` in the welcome
// view and `..._workspaceRow` inside a conversation — match the suffix, not the prefix.
const ROW_SELECTOR = '[class*="WorkspaceRow"], [class*="workspaceRow"]';
const PICKER_SELECTOR = '[class*="_workspace"]';
/**
 * 恢复轮询间隔。收窄观察范围后唯一可能漏掉的是「行还在 DOM 里、但已经换成了别的行」
 * （宿主把旧行留在文档中、只把新行插到更深的位置）。这种替换不触发行内、也不触发行父级
 * 的直接 childList,所以留一条低频身份检查兜底。1s 与宿主切会话/发送动画的节奏差距足够,
 * 且稳态下只读 isConnected,不触发一次布局 —— 与原来 1s 一次的 findRow 相比是净减少。
 */
const RECOVERY_POLL_MS = 1000;
/**
 * 每 6 个心跳(≈6s)做一次完整重定位。观察器只能看见「目标消失/结构变化」,看不见「旧行还在
 * 文档里、但已经不可见,真正该用的小一号」这类纯布局变化 —— 旧实现靠每 1s 一次 findRow 兜住
 * 它,代价是流式输出期间每秒两次查询加两次布局读取。现在把这份保险降到 ~6s 一次:一次典型的
 * 流式回答(数秒到十几秒)最多多付一两次搜索,而每 16ms 一个 token 时是 0 次。
 */
const DEEP_RECHECK_BEATS = 6;

function inSidebar(element) {
  let cursor = element;
  while (cursor) {
    if (cursor.hasAttribute?.('data-shell-overlay')) return false;
    if ((cursor.className || '').toString().includes('_sidebarCol')) return true;
    cursor = cursor.parentElement;
  }
  return false;
}

function findRow() {
  if (typeof document === 'undefined') return null;
  const rows = [...document.querySelectorAll(ROW_SELECTOR)].filter((row) => {
    if (inSidebar(row)) return false;
    const rect = row.getBoundingClientRect();
    return rect.width > 200 && rect.height > 8;
  });
  if (rows.length === 0) return null;
  rows.sort((left, right) => {
    const a = left.getBoundingClientRect();
    const b = right.getBoundingClientRect();
    return b.width * b.height - a.width * a.height;
  });
  return rows[0];
}

/**
 * @param {(state: {container: HTMLElement|null, workspaceTitle: string|null}) => void} onChange
 * @returns {() => void} unsubscribe
 */
export function observeComposerSlot(onChange) {
  let container = null;
  let row = null;
  /** 上一次找到的可视行,用于稳态下避免重复的完整搜索。 */
  let picker = null;
  let last = null;
  let timer = null;
  let disposed = false;
  const watching = { row: null, parent: null };

  const detachContainer = () => {
    if (container?.isConnected) container.remove();
  };

  const read = () => {
    // 优先复用上一行:每次搜索都是对所有候选行的一次布局读取,没必要为同一行反复付。
    let next = row && row.isConnected ? row : null;
    if (!next) {
      next = findRow();
      const nextPicker = next?.querySelector(PICKER_SELECTOR) ?? null;
      if (!next || !nextPicker) {
        detachContainer();
        row = null;
        picker = null;
        return { container: null, workspaceTitle: null };
      }
      row = next;
      picker = nextPicker;
    }
    const foundPicker = picker?.isConnected && row.contains(picker) ? picker : row.querySelector(PICKER_SELECTOR);
    if (!foundPicker) {
      detachContainer();
      row = null;
      picker = null;
      return { container: null, workspaceTitle: null };
    }
    picker = foundPicker;
    if (!container) {
      container = document.createElement('span');
      container.className = 'dts-composer-slot';
    }
    try {
      if (foundPicker.nextSibling !== container) foundPicker.after(container);
    } catch {
      return { container: null, workspaceTitle: null };
    }
    return {
      container,
      workspaceTitle: (foundPicker.textContent ?? '').trim() || null,
    };
  };

  const emit = () => {
    if (disposed) return;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const next = read();
    sync();
    const key = `${next.workspaceTitle ?? ''}:${Boolean(next.container)}`;
    if (key === last) return;
    last = key;
    onChange(next);
  };

  const schedule = () => {
    if (disposed || timer !== null) return;
    timer = setTimeout(emit, 60);
  };

  const mo = typeof MutationObserver === 'undefined' ? null : new MutationObserver(schedule);
  const rowObserver = typeof MutationObserver === 'undefined' ? null : new MutationObserver(schedule);

  /**
   * 只在目标换了的时候重绑。行被宿主换掉时,行内观察器会随旧行一起失效,所以每次全量
   * read 之后都要把观察器搬到新的行及其父级上。
   */
  const sync = () => {
    if (mo && row !== watching.row) {
      mo.disconnect();
      if (row) {
        // 行内只发生三件值得重测的事:slot 被 React 移除、picker 被替换、picker 文案变了。
        mo.observe(row, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'style'] });
      }
      watching.row = row;
    }

    const parent = row?.parentElement ?? null;
    if (rowObserver && parent !== watching.parent) {
      rowObserver.disconnect();
      if (parent) {
        // 行本身被整块换掉时,真正变化的是父级的直接子节点;subtree:false 让同级里不断追加的
        // 聊天节点/浮动层无法把这里吵醒。
        rowObserver.observe(parent, { childList: true });
      }
      watching.parent = parent;
    }
  };

  emit();
  if (typeof window !== 'undefined') window.addEventListener('resize', schedule);

  /**
   * 唯一常驻心跳:slot、picker、行都还在原位就什么都不做(纯属性读取,零布局);任何一样不在
   * 了才重新定位。这是「行被换到观察器看不见的地方」时的恢复路径。
   */
  let beat = 0;
  const heartbeat = () => {
    if (disposed) return;
    if (++beat % DEEP_RECHECK_BEATS === 0) {
      // 周期性完整重定位,用来纠正在文档中但已不再是最佳目标的行。
      row = null;
      picker = null;
      schedule();
      return;
    }
    const intact = Boolean(container?.isConnected && container.parentElement === row && picker?.isConnected && row?.isConnected);
    if (!intact) schedule();
  };
  const interval = setInterval(heartbeat, RECOVERY_POLL_MS);

  return () => {
    if (disposed) return;
    disposed = true;
    mo?.disconnect();
    rowObserver?.disconnect();
    clearInterval(interval);
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (typeof window !== 'undefined') window.removeEventListener('resize', schedule);
    detachContainer();
    container = null;
    row = null;
    picker = null;
  };
}

/**
 * Resolves the workspace shown in the composer against the known list: the picker exposes a
 * title (and the path as its tooltip), never an id, so match on title or path basename and
 * fall back to the only workspace when that is unambiguous.
 */
export function resolveComposerWorkspace(workspaceTitle, options) {
  if (!options?.length) return null;
  if (!workspaceTitle) return options.length === 1 ? options[0].workspaceId : null;
  const needle = String(workspaceTitle).trim().toLowerCase();
  const exact = options.find((option) => String(option.title).toLowerCase() === needle);
  if (exact) return exact.workspaceId;
  const byPath = options.find((option) => String(option.path).toLowerCase().split(/[\\/]/).filter(Boolean).pop() === needle);
  if (byPath) return byPath.workspaceId;
  return options.length === 1 ? options[0].workspaceId : null;
}
