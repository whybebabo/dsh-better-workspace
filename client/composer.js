/**
 * Anchors the composer's workspace row and owns the seat for the topic chip.
 *
 * The native "选择工作区" button lives in a flex row inside the conversation body, followed
 * by the mode chip. There is no slot for extra composer controls, so the plugin inserts one
 * empty `<span>` immediately after that button and renders into it (React portal from the
 * panel). Only that one node is added — the host's own elements are never moved or rewritten,
 * and if the row cannot be located the chip simply does not appear.
 */
// The class hash changes per build, and the row is `..._heroWorkspaceRow` in the welcome
// view and `..._workspaceRow` inside a conversation — match the suffix, not the prefix.
const ROW_SELECTOR = '[class*="WorkspaceRow"], [class*="workspaceRow"]';
const PICKER_SELECTOR = '[class*="_workspace"]';

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
  let last = null;
  let timer = null;

  const read = () => {
    const row = findRow();
    const picker = row?.querySelector(PICKER_SELECTOR) ?? null;
    if (!row || !picker) {
      if (container?.isConnected) container.remove();
      return { container: null, workspaceTitle: null };
    }
    if (!container) {
      container = document.createElement('span');
      container.className = 'dts-composer-slot';
    }
    try {
      if (picker.nextSibling !== container) picker.after(container);
    } catch {
      return { container: null, workspaceTitle: null };
    }
    return {
      container,
      workspaceTitle: (picker.textContent ?? '').trim() || null,
    };
  };

  const emit = () => {
    const next = read();
    const key = `${next.workspaceTitle ?? ''}:${Boolean(next.container)}`;
    if (key === last) return;
    last = key;
    onChange(next);
  };

  const schedule = () => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      emit();
    }, 60);
  };

  emit();
  const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(schedule);
  observer?.observe(document.documentElement, { childList: true, subtree: true });
  if (typeof window !== 'undefined') window.addEventListener('resize', schedule);
  const interval = setInterval(emit, 1000);

  return () => {
    observer?.disconnect();
    clearInterval(interval);
    if (timer !== null) clearTimeout(timer);
    if (typeof window !== 'undefined') window.removeEventListener('resize', schedule);
    if (container?.isConnected) container.remove();
    container = null;
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
