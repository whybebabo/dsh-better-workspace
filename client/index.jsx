/**
 * dsh-better-workspace — browser half.
 *
 * Registers the panel into `shell.overlay`, which the shell renders inside
 * `[data-shell-overlay]` (z-index above the frame, `pointer-events: none` with direct
 * children re-enabled). The component is that direct child: it positions itself over the
 * measured workspace region, leaves the official list in the DOM underneath, and marks it
 * `inert` so keyboard focus cannot reach the covered controls.
 *
 * Only `slots` is injected: reading any other service through `ctx.*` without declaring it
 * throws in cordis, and everything else the panel needs is resolved lazily through
 * `ctx.get()` inside `createHostActions`.
 */
import { createHostActions } from './actions.js';
import { OverlayPanel } from './overlay.jsx';
import { createScheduleStore } from './schedule.js';
import { setLanguage } from './i18n.js';
import css from './styles.css';

export const inject = ['slots'];

const STYLE_ATTRIBUTE = 'data-plugin';
/**
 * The loader keys styles by the same id it keys the bundle by (the package name), so the
 * <style> tag claims that id instead of a second, hand-maintained one. `build.mjs` replaces
 * this identifier with the package name at build time.
 */
const STYLE_ID = __DSH_CLIENT_ID__;

/**
 * Follows the host language. The locale service is authoritative when present; `<html lang>`
 * is kept in sync by the host itself, so watching it also covers a composition where the
 * service is named differently or absent.
 */
function watchLanguage(ctx) {
  let locale = null;
  try {
    locale = ctx.get?.('locale') ?? null;
  } catch {
    locale = null;
  }
  const disposers = [];
  if (locale && typeof locale.getSnapshot === 'function') {
    const read = () => {
      const active = locale.getSnapshot?.()?.active;
      if (active) setLanguage(active);
    };
    read();
    if (typeof locale.subscribe === 'function') {
      const unsubscribe = locale.subscribe(read);
      disposers.push(() => unsubscribe?.());
    }
  }
  const readAttribute = () => setLanguage(document.documentElement?.lang);
  readAttribute();
  if (typeof MutationObserver !== 'undefined' && document?.documentElement) {
    const observer = new MutationObserver(readAttribute);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    disposers.push(() => observer.disconnect());
  }
  return () => disposers.forEach((dispose) => {
    try {
      dispose();
    } catch { /* already torn down */ }
  });
}

function applyStyles() {
  if (typeof document === 'undefined') return () => {};
  const existing = document.head.querySelector(`style[${STYLE_ATTRIBUTE}="${STYLE_ID}"]`);
  if (existing) {
    // Someone's node already claims this id (a previous instance, or the loader's HMR
    // inventory). Keep it current, but do not hand out a disposer for a node this call did not
    // create: removing it on teardown would blank the styles of whichever instance is live.
    if (existing.textContent !== css) existing.textContent = css;
    return () => {};
  }
  const node = document.createElement('style');
  node.setAttribute(STYLE_ATTRIBUTE, STYLE_ID);
  node.textContent = css;
  document.head.append(node);
  return () => node.remove();
}

export function apply(ctx) {
  try {
    boot(ctx);
  } catch (error) {
    // The shell only reports "entry did not activate"; keep the real cause in the console.
    console.error('[dsh-better-workspace] apply failed:', error?.stack ?? error);
    throw error;
  }
}

function boot(ctx) {
  const actions = createHostActions(ctx);
  const schedules = createScheduleStore(ctx);

  ctx.effect(() => applyStyles(), 'dsh-better-workspace: styles');
  ctx.effect(() => watchLanguage(ctx), 'dsh-better-workspace: language');
  ctx.effect(() => () => schedules.dispose(), 'dsh-better-workspace: schedules');

  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    {
      name: 'shell.overlay',
      id: 'topic-sidebar-panel',
      order: 40,
      label: () => '分组',
      inject: () => ({ actions, schedules }),
    },
    OverlayPanel,
  ));
}
