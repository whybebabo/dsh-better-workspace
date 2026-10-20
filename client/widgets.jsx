/**
 * Small self-drawn widgets.
 *
 * The panel deliberately avoids the host's Menu/Modal primitives: their prop contracts are
 * internal to `dsh-client-ui-*` and drift between releases, and a mismatch would take the
 * whole overlay down. These are position:fixed (so the panel's own overflow can never clip
 * them), use official design tokens, and reuse the host's focus/escape conventions.
 */
import * as React from 'react';
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives';
import { getLanguage, subscribeLanguage, t } from './i18n.js';

/**
 * Native iconography.
 *
 * Every glyph is the host's own icon component (`@deepseek-ai/dsh-client-ui-primitives`),
 * so weights, corner radii and optical sizes match the stock menus pixel for pixel. A local
 * 24-grid fallback keeps the panel usable if a build renames an export.
 */
const HOST_ICONS = {
  search: 'IconSearchOutlineRegular',
  select: 'IconChecklistOutlineRegular',
  plus: 'IconPlusOutlineRegular',
  ellipsis: 'IconEllipsisOutlineRegular',
  close: 'IconCloseOutlineRegular',
  check: 'IconCheckOutlineRegular',
  chevronDown: 'IconChevronDownOutlineRegular',
  chevronUp: 'IconChevronUpOutlineRegular',
  chevronLeft: 'IconChevronLeftOutlineRegular',
  chevronRight: 'IconChevronRightOutlineRegular',
  folder: 'IconFolderOpenRegular',
  folderClosed: 'IconFolderCloseRegular',
  archive: 'IconArchiveOutlineRegular',
  unarchive: 'IconUnarchiveOutlineRegular',
  trash: 'IconTrashOutlineRegular',
  filter: 'IconSlidersTwoOutlineRegular',
  edit: 'IconEditOutlineRegular',
  move: 'IconRightUpOutlineRegular',
  topic: 'IconWorkspaceTreeOutlineRegular',
  pin: 'IconPinOutlineRegular',
  pinFilled: 'IconPinFillRegular',
  copy: 'IconCopyOutlineRegular',
  refresh: 'IconRefreshOutlineRegular',
  projectAdd: 'IconProjectAddOutlineRegular',
  newChat: 'IconNewChatOutlineRegular',
  warning: 'IconWarningTriangleOutlineRegular',
  fork: 'IconBranchOutlineRegular',
  caret: 'IconTriangleRightFillRegular',
  clock: 'IconClockOutlineRegular',
};

function fallbackIcon(name, size = 16) {
  const paths = FALLBACK_PATHS[name] ?? [];
  return function FallbackIcon({ className }) {
    return (
      <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
        {paths.map((d) => (
          <path key={d} d={d} />
        ))}
      </svg>
    );
  };
}

/** 16-grid fallbacks, used only when the host build no longer exports the component. */
const FALLBACK_PATHS = {
  search: ['M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z', 'm10.6 10.6 2.9 2.9'],
  plus: ['M8 3v10', 'M3 8h10'],
  close: ['m4 4 8 8', 'm12 4-8 8'],
  check: ['m3 8.5 3.2 3L13 4.8'],
  chevronDown: ['m3.5 6 4.5 4.5L12.5 6'],
  chevronLeft: ['M10 3 5.5 8l4.5 5'],
  chevronRight: ['M6 3l4.5 5L6 13'],
  folder: ['M2 5.2A1.2 1.2 0 0 1 3.2 4h2.6l1.2 1.6h5.8A1.2 1.2 0 0 1 14 6.8v4.4A1.2 1.2 0 0 1 12.8 12.4H3.2A1.2 1.2 0 0 1 2 11.2Z'],
  archive: ['M2 3.5h12', 'M3.2 3.5v9h9.6v-9', 'M6.4 7h3.2'],
  unarchive: ['M2 3.5h12', 'M3.2 3.5v9h9.6v-9', 'M6.4 4.8h3.2', 'M6.4 9h3.2'],
  trash: ['M2.6 4.4h10.8', 'M6 4.4V2.8h4v1.6', 'M4.2 4.4l.7 8.8h6.2l.7-8.8'],
  filter: ['M2 4h12', 'M4.5 8h7', 'M6.5 12h3'],
  edit: ['M3 13h2.6L13 5.6 10.4 3 3 10.4Z', 'm9.6 3.8 2.6 2.6'],
  move: ['M3 11h7.5', 'M8.5 8.5 11 11l-2.5 2.5', 'M13 5H5.5', 'M7.5 2.5 5 5l2.5 2.5'],
  topic: ['M2.5 4.5h4', 'M2.5 8h4', 'M2.5 11.5h4', 'M8.5 4.5H13', 'M8.5 8H13', 'M8.5 11.5H13'],
  pin: ['M6.6 2.4 2.9 6.1l1.6 1.6-1 2.9 2.9-1 1.6 1.6 3.7-3.7L6.6 2.4Z', 'm5.2 10.8-2.4 2.4'],
  copy: ['M5.5 5.5h8v8h-8z', 'M2.5 10.5v-8h8'],
  refresh: ['M13 8a5 5 0 1 1-1.6-3.7', 'M13 2.6v3.2H9.8'],
  projectAdd: ['M2 5.2A1.2 1.2 0 0 1 3.2 4h2.6l1.2 1.6h5.8A1.2 1.2 0 0 1 14 6.8v4.4A1.2 1.2 0 0 1 12.8 12.4H3.2A1.2 1.2 0 0 1 2 11.2Z', 'M8 7.6v3.2', 'M6.4 9.2h3.2'],
  newChat: ['M2.5 3.5h11v7H7l-3.5 3v-3h-1v-7Z', 'M8 5.4v3.4', 'M6.3 7.1h3.4'],
  warning: ['M8 2.4 14 12.8H2Z', 'M8 6.2v3', 'M8 11h.01'],
  fork: ['M2.5 8h4.2c1 0 1.6-.3 2.2-.9L11.6 4.4', 'M2.5 8h4.2c1 0 1.6.3 2.2.9l2.7 2.7'],
  ellipsis: ['M3.2 8h.01', 'M8 8h.01', 'M12.8 8h.01'],
  caret: ['M5.5 3 11 8l-5.5 5Z'],
  clock: ['M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8Z', 'M8 4.6V8l2.4 1.4'],
};

/** Re-renders the caller whenever the UI language changes and returns the active id. */
export function useLanguage() {
  const [, bump] = React.useReducer((count) => count + 1, 0);
  React.useEffect(() => subscribeLanguage(() => bump()), []);
  return getLanguage();
}

export function cx(...parts) {
  return parts.filter(Boolean).join(' ');
}

export function useEscape(active, onEscape) {
  React.useEffect(() => {
    if (!active) return undefined;
    const handler = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onEscape();
      }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [active, onEscape]);
}

export function useOutsidePointer(active, refs, onDismiss) {
  React.useEffect(() => {
    if (!active) return undefined;
    const handler = (event) => {
      const nodes = refs.map((ref) => ref.current).filter(Boolean);
      if (nodes.some((node) => node.contains(event.target))) return;
      onDismiss();
    };
    document.addEventListener('pointerdown', handler, true);
    return () => document.removeEventListener('pointerdown', handler, true);
  }, [active, onDismiss, ...refs]);
}

export function IconButton({ label, onClick, children, active = false, disabled = false, className, title }) {
  return (
    <button
      type="button"
      className={cx('dts-iconbtn', active && 'is-active', className)}
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        if (!disabled) onClick?.(event);
      }}
    >
      {children}
    </button>
  );
}

export function Button({ children, onClick, variant = 'default', disabled = false, autoFocus = false, type = 'button', className, title }) {
  return (
    <button
      type={type}
      className={cx('dts-btn', `dts-btn--${variant}`, disabled && 'is-disabled', className)}
      disabled={disabled}
      autoFocus={autoFocus}
      title={title}
      onClick={(event) => {
        if (disabled) return;
        onClick?.(event);
      }}
    >
      {children}
    </button>
  );
}

export function Checkbox({ checked, indeterminate = false, onChange, label, disabled = false }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate && !checked;
  }, [indeterminate, checked]);
  return (
    <label className={cx('dts-check', disabled && 'is-disabled')} title={label}>
      <input
        ref={ref}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange?.(event.target.checked)}
      />
      <span className="dts-check__box" aria-hidden="true" />
    </label>
  );
}

export function TextInput({ value, onChange, placeholder, autoFocus = false, onEnter, maxLength = 80, 'aria-label': ariaLabel, onBlur, invalid = false }) {
  return (
    <input
      className="dts-input"
      type="text"
      value={value}
      maxLength={maxLength}
      placeholder={placeholder}
      autoFocus={autoFocus}
      aria-label={ariaLabel ?? placeholder}
      aria-invalid={invalid || undefined}
      onBlur={onBlur}
      onChange={(event) => onChange?.(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && onEnter) {
          event.preventDefault();
          onEnter();
        }
      }}
    />
  );
}

/** Topic marker: the chosen glyph, or the '-' symbol when the folder has none (including 默认). */
export function TopicMark({ emoji, className }) {
  return emoji
    ? React.createElement('span', { className: cx('dts-emoji', className), 'aria-hidden': true }, emoji)
    : React.createElement('span', { className: cx('dts-dash', className), 'aria-hidden': true }, '-');
}

function FallbackStateMark({ state }) {
  if (state === 'ongoing') {
    return (
      <svg className="dts-spinner" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
        <g className="dts-spinner__motion">
          <circle className="dts-spinner__track" cx="12" cy="12" r="9.5" />
          <circle className="dts-spinner__arc" cx="12" cy="12" r="9.5" />
        </g>
      </svg>
    );
  }
  return <span className={cx('dts-state-dot', `dts-state-dot--${state}`)} aria-hidden="true" />;
}

/**
 * Session-state marker. The host's StateDot is the original asset (spinner and state dots),
 * so the row reads exactly like the stock list; the local fallback mirrors its geometry.
 */
export function StateMark({ state, className }) {
  const Component = primitives?.StateDot;
  const mark = typeof Component === 'function'
    ? <Component state={state} />
    : <FallbackStateMark state={state} />;
  return (
    <span className={cx('dts-state-mark', className)} aria-hidden="true">
      {mark}
    </span>
  );
}

/**
 * Anchored dropdown surface. `anchor` may be a DOMRect or the trigger element itself.
 *
 * Passing the element is preferred: its rect is measured at render time (so a scrolled or
 * resized trigger stays aligned) and the trigger can be excluded from the outside-pointer
 * test. Without that exclusion a toggling trigger closes the popover on pointerdown and
 * reopens it on the following click, making the menu appear impossible to dismiss.
 */
export function Popover({ anchor, anchorEl, onClose, children, align = 'left', width = 220, className }) {
  const ref = React.useRef(null);
  const trigger = anchorEl ?? (typeof anchor?.nodeType === 'number' ? anchor : null);
  const triggerRef = React.useRef(trigger);
  triggerRef.current = trigger;
  useOutsidePointer(true, [ref, triggerRef], onClose);
  useEscape(true, onClose);
  const rect = anchor && typeof anchor.nodeType === 'number'
    ? anchor.getBoundingClientRect()
    : anchor;
  if (!rect) return null;
  const anchorRect = rect;
  const viewportWidth = typeof window === 'undefined' ? 1280 : window.innerWidth;
  const viewportHeight = typeof window === 'undefined' ? 800 : window.innerHeight;
  const left = align === 'right' ? Math.max(8, Math.min(anchorRect.right - width, viewportWidth - width - 8)) : Math.max(8, Math.min(anchorRect.left, viewportWidth - width - 8));
  const spaceBelow = viewportHeight - anchorRect.bottom;
  const openUp = spaceBelow < 220 && anchorRect.top > spaceBelow;
  const top = openUp ? undefined : anchorRect.bottom + 4;
  const bottom = openUp ? viewportHeight - anchorRect.top + 4 : undefined;
  return (
    <div
      ref={ref}
      className={cx('dts-pop', className)}
      style={{ position: 'fixed', left, width, top, bottom, maxHeight: Math.max(160, (openUp ? anchorRect.top : spaceBelow) - 12) }}
      role="dialog"
      aria-modal="false"
    >
      {children}
    </div>
  );
}

export function MenuItem({ children, onSelect, danger = false, disabled = false, hint, icon, className }) {
  return (
    <button
      type="button"
      className={cx('dts-menu__item', danger && 'is-danger', disabled && 'is-disabled', className)}
      role="menuitem"
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        if (!disabled) onSelect?.(event);
      }}
    >
      {icon ? <span className="dts-menu__icon">{icon}</span> : null}
      <span className="dts-menu__label">{children}</span>
      {hint ? <span className="dts-menu__hint">{hint}</span> : null}
    </button>
  );
}

export function Dialog({ title, description, children, footer, onClose, width = 420, className }) {
  const ref = React.useRef(null);
  useEscape(true, onClose);
  // Captured during the first render, i.e. before React's autoFocus moves focus into the
  // dialog. Reading it in a passive effect would capture the dialog's own input, so closing
  // the dialog would drop focus onto <body> and keyboard users would lose their place.
  const restoreRef = React.useRef(typeof document === 'undefined' ? null : document.activeElement);
  React.useEffect(() => {
    const node = ref.current;
    const first = node?.querySelector('input') ?? node?.querySelector('button');
    const timer = first ? setTimeout(() => first.focus({ preventScroll: true }), 30) : null;
    const previous = restoreRef.current;
    return () => {
      if (timer) clearTimeout(timer);
      if (previous && previous.isConnected && typeof previous.focus === 'function') {
        previous.focus({ preventScroll: true });
      }
    };
  }, []);
  return (
    <div
      className="dts-scrim"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose?.();
      }}
    >
      <div ref={ref} className={cx('dts-dialog', className)} style={{ width }} role="dialog" aria-modal="true" aria-label={title}>
        <header className="dts-dialog__head">
          <h2 className="dts-dialog__title">{title}</h2>
          <IconButton label={t('action.close')} onClick={onClose}>
            <Icon name="close" />
          </IconButton>
        </header>
        {description ? <p className="dts-dialog__description">{description}</p> : null}
        <div className="dts-dialog__body">{children}</div>
        {footer ? <footer className="dts-dialog__foot">{footer}</footer> : null}
      </div>
    </div>
  );
}

/** Folder pair and caret keep their named exports: the tree styles them directly. */
export const IconFolderOpen = (props) => <Icon name="folder" {...props} />;
export const IconFolderClose = (props) => <Icon name="folderClosed" {...props} />;
export const IconCaret = (props) => <Icon name="caret" size={14} {...props} />;

export function Icon({ name, size = 16, className }) {
  const Component = primitives?.[HOST_ICONS[name]];
  if (typeof Component === 'function') {
    return (
      <span className={cx('dts-icon', className)} style={{ width: size, height: size }} aria-hidden="true">
        {React.createElement(Component)}
      </span>
    );
  }
  const Fallback = fallbackIcon(name, size);
  return <Fallback className={cx('dts-icon', className)} />;
}
