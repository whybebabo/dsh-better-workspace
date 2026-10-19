/**
 * Shortcut hints, as the stock session menu prints them.
 *
 * These mirror the shipped defaults (DSH 0.2.1): the host stores them per platform in its
 * shortcut registry, which is not a stable public surface, so the panel keeps its own copy.
 * A rebind in settings updates the real action; only this hint text would go stale.
 */
const MAC = typeof navigator !== 'undefined' && /mac/i.test(`${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`);

const HINTS = MAC
  ? { rename: '⌘⌥G', fork: '⌘⇧F', archive: '⌘⌥A' }
  : { rename: 'Ctrl+Alt+G', fork: 'Ctrl+Shift+F', archive: 'Ctrl+Alt+A' };

export function shortcutHint(action) {
  return HINTS[action] ?? '';
}
