/**
 * Topic dialogs: create (with optional back-filing of existing sessions), edit, move-to-topic
 * and delete confirmation. Creating a topic can attach sessions in the same write so the
 * "新建分组时选择会话" and "老会话加入分组" flows share one round trip.
 */
import * as React from 'react';
import { cx, Dialog, Button, TextInput, Checkbox, Icon, TopicMark } from './widgets.jsx';
import { t } from './i18n.js';

/** Offline fallback; every glyph is also present in the host's Zen-sourced list. */
export const FALLBACK_EMOJIS = ['\u{1F4C1}', '\u{1F4A1}', '\u{1F3A8}', '\u{1F6E0}\u{FE0F}', '\u{1F9EA}', '\u{1F41E}', '\u{1F680}', '\u{1F4DD}'];

/** Control characters are the only glyphs the sidecar strips, so they are the illegal set. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Why a topic name cannot be used right now, or `null` when it can. The host stays the
 * authority — this answers before the round trip so the field, not a silent dead button,
 * explains the problem.
 */
function nameProblem({ name, workspaceId, topicsFor, ignoreId }) {
  const trimmed = name.trim();
  if (trimmed === '') return 'empty';
  if (CONTROL_CHARS.test(name)) return 'illegal';
  const taken = (topicsFor?.(workspaceId) ?? []).some(
    (topic) => topic.id !== ignoreId && String(topic.name ?? '').trim().toLowerCase() === trimmed.toLowerCase(),
  );
  return taken ? 'taken' : null;
}

function problemText(problem) {
  if (problem === 'empty') return t('topic.nameRequired');
  if (problem === 'illegal') return t('topic.nameIllegal');
  if (problem === 'taken') return t('topic.nameTaken');
  return null;
}

/** Marker picker: the host's glyphs (Zen's emoji set) plus a "no marker" option rendered as '-'. */
export function EmojiPicker({ emojis, value, onChange, name }) {
  return (
    <div className="dts-emojis" role="radiogroup" aria-label={name}>
      <button
        type="button"
        role="radio"
        aria-checked={value === ''}
        className={cx('dts-emojis__item', value === '' && 'is-active')}
        title={t('topic.noIcon')}
        onClick={() => onChange('')}
      >
        <span className="dts-dash" aria-hidden="true">-</span>
      </button>
      {emojis.map((glyph) => (
        <button
          key={glyph}
          type="button"
          role="radio"
          aria-checked={value === glyph}
          className={cx('dts-emojis__item', value === glyph && 'is-active')}
          onClick={() => onChange(glyph)}
        >
          {glyph}
        </button>
      ))}
    </div>
  );
}

function SessionPicker({ rows, selected, onToggle, onSelectAll, query, onQuery }) {
  const [needle, setNeedle] = React.useState('');
  const text = (query ?? needle).trim().toLowerCase();
  // The picker is already scoped to one workspace, so the trailing label names each row's
  // current group — the one fact that differs inside the list and that attaching will change.
  const matches = text
    ? rows.filter((row) => `${row.title} ${row.workspaceTitle ?? ''} ${row.topicName ?? ''}`.toLowerCase().includes(text))
    : rows;
  return (
    <div className="dts-picker">
      <TextInput value={needle} placeholder={t('search.placeholder')} onChange={(value) => { setNeedle(value); onQuery?.(value); }} />
      <div className="dts-picker__bar">
        <span className="dts-picker__count">{t('topic.selectedCount', { n: selected.size })}</span>
        <button type="button" className="dts-linkbtn" onClick={() => onSelectAll(matches.map((row) => row.id))}>
          {selected.size === 0 ? t('action.selectAll') : t('action.clearSelection')}
        </button>
      </div>
      <div className="dts-picker__list">
        {matches.length === 0 ? <div className="dts-picker__empty">{t('topic.noSessions')}</div> : null}
        {matches.map((row) => (
          <label key={row.id} className={cx('dts-picker__row', selected.has(row.id) && 'is-on')}>
            <Checkbox checked={selected.has(row.id)} onChange={() => onToggle(row.id)} label={row.title} />
            <span className="dts-picker__title" title={row.title}>
              {row.title}
            </span>
            <span className="dts-picker__group">{row.topicName}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

/**
 * Create a topic; optionally attach existing sessions in the same request. The workspace is
 * chosen here when the caller could not resolve one, so the flow never dead-ends on a
 * greyed-out control.
 */
export function CreateTopicDialog({ workspaces = [], workspaceId, rowsFor, topicsFor, emojis, onSubmit, onClose }) {
  const [name, setName] = React.useState('');
  const [nameTouched, setNameTouched] = React.useState(false);
  const [emoji, setEmoji] = React.useState(emojis?.[0] ?? '');
  const [chosen, setChosen] = React.useState(workspaceId ?? (workspaces.length === 1 ? workspaces[0].workspaceId : null));
  const [selected, setSelected] = React.useState(() => new Set());
  const [error, setError] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const rows = chosen ? (rowsFor?.(chosen) ?? []) : [];
  // The create button greys out on a bad name; the hint explains why instead of leaving the
  // user guessing.
  const problem = nameProblem({ name, workspaceId: chosen, topicsFor, ignoreId: null });
  const problemLabel = problemText(problem);
  const nameInvalid = Boolean(problem) && (problem !== 'empty' || nameTouched);

  const toggle = (id) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submit = async () => {
    const trimmed = name.trim();
    if (!chosen) {
      setError(t('topic.pickWorkspace'));
      return;
    }
    if (problem) {
      setError(problemLabel);
      return;
    }
    setBusy(true);
    try {
      await onSubmit({ workspaceId: chosen, name: trimmed, emoji, sessionIds: [...selected] });
      onClose();
    } catch (caught) {
      setBusy(false);
      setError(caught?.code === 'topic-name-taken' ? t('topic.nameTaken') : caught?.message ?? String(caught));
    }
  };

  return (
    <Dialog
      title={t('topic.new')}
      description={t('topic.createDescription')}
      className="dts-dialog--settings"
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('action.cancel')}</Button>
          <Button variant="primary" disabled={busy || Boolean(problem) || !chosen} onClick={submit}>
            {busy ? t('state.loading') : t('action.create')}
          </Button>
        </>
      }
    >
      <div className="dts-field">
        <span className="dts-field__label">{t('section.workspaces')}</span>
        {workspaces.length > 1 ? (
          <div className="dts-select">
            <select
              value={chosen ?? ''}
              aria-label={t('section.workspaces')}
              onChange={(event) => {
                setChosen(event.target.value || null);
                setSelected(new Set());
                setError(null);
              }}
            >
              {chosen ? null : <option value="" disabled>{t('topic.pickWorkspace')}</option>}
              {workspaces.map((workspace) => (
                <option key={workspace.workspaceId} value={workspace.workspaceId} title={workspace.path}>
                  {workspace.title}
                </option>
              ))}
            </select>
            <Icon name="chevronDown" className="dts-select__caret" size={14} />
          </div>
        ) : (
          <span className="dts-settings-value" title={workspaces.find((workspace) => workspace.workspaceId === chosen)?.path ?? ''}>
            {chosen ? workspaces.find((workspace) => workspace.workspaceId === chosen)?.title ?? '' : ''}
          </span>
        )}
      </div>
      <label className="dts-field">
        <span className="dts-field__label">{t('topic.name')}</span>
        <TextInput
          autoFocus
          value={name}
          onChange={(value) => { setName(value); setError(null); }}
          placeholder={t('topic.namePlaceholder')}
          maxLength={40}
          onEnter={submit}
          onBlur={() => setNameTouched(true)}
          invalid={nameInvalid}
        />
        {nameInvalid ? <span className="dts-field__hint is-error">{problemLabel}</span> : null}
      </label>
      <div className="dts-field">
        <span className="dts-field__label">{t('topic.icon')}</span>
        <EmojiPicker emojis={emojis ?? FALLBACK_EMOJIS} value={emoji} onChange={setEmoji} name={t('topic.icon')} />
      </div>
      {chosen && rows.length > 0 ? (
        <div className="dts-field">
          <span className="dts-field__label">{t('topic.attach')}</span>
          <span className="dts-field__hint">{t('topic.attachHint', { name: name.trim() || t('topic.new') })}</span>
          <SessionPicker
            rows={rows}
            selected={selected}
            onToggle={toggle}
            onSelectAll={(ids) => setSelected(selected.size === 0 ? new Set(ids) : new Set())}
          />
        </div>
      ) : null}
      {chosen && rows.length === 0 ? <p className="dts-dialog__hint">{t('topic.noSessions')}</p> : null}
      {error ? <p className="dts-error">{error}</p> : null}
    </Dialog>
  );
}

export function EditTopicDialog({ topic, workspaceId, topicsFor, emojis, onSubmit, onDelete, onClose }) {
  const [name, setName] = React.useState(topic.name);
  const [emoji, setEmoji] = React.useState(topic.emoji ?? '');
  const [error, setError] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const dirty = name.trim() !== topic.name || emoji !== topic.emoji;
  const problem = nameProblem({ name, workspaceId, topicsFor, ignoreId: topic.id });
  const problemLabel = problemText(problem);

  const submit = async () => {
    if (problem) {
      setError(problemLabel);
      return;
    }
    setBusy(true);
    try {
      await onSubmit({ name: name.trim(), emoji });
      onClose();
    } catch (caught) {
      setBusy(false);
      setError(caught?.code === 'topic-name-taken' ? t('topic.nameTaken') : caught?.message ?? String(caught));
    }
  };

  return (
    <Dialog
      title={t('topic.rename')}
      onClose={onClose}
      width={380}
      footer={
        <>
          {onDelete ? (
            <Button variant="danger-ghost" onClick={() => onDelete(topic)}>
              {t('topic.delete')}
            </Button>
          ) : null}
          <span className="dts-spacer" />
          <Button onClick={onClose}>{t('action.cancel')}</Button>
          <Button variant="primary" disabled={busy || !dirty || Boolean(problem)} onClick={submit}>
            {t('action.save')}
          </Button>
        </>
      }
    >
      <label className="dts-field">
        <span className="dts-field__label">{t('topic.name')}</span>
        <TextInput autoFocus value={name} onChange={setName} maxLength={40} onEnter={submit} invalid={Boolean(problem)} />
        {problem ? <span className="dts-field__hint is-error">{problemLabel}</span> : null}
      </label>
      <label className="dts-field">
        <span className="dts-field__label">{t('topic.icon')}</span>
        <EmojiPicker emojis={emojis ?? FALLBACK_EMOJIS} value={emoji} onChange={setEmoji} name={t('topic.icon')} />
      </label>
      {error ? <p className="dts-error">{error}</p> : null}
    </Dialog>
  );
}

export function DeleteTopicDialog({ topic, count, onConfirm, onClose }) {
  const [busy, setBusy] = React.useState(false);
  return (
    <Dialog
      title={t('topic.deleteConfirm', { name: topic.name })}
      onClose={onClose}
      width={380}
      footer={
        <>
          <Button onClick={onClose}>{t('action.cancel')}</Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                onClose();
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('action.delete')}
          </Button>
        </>
      }
    >
      <p className="dts-dialog__text">{t('topic.deleteBody', { n: count })}</p>
    </Dialog>
  );
}

/** Rename a workspace (native menu parity: one field, duplicate names blocked in place). */
export function RenameWorkspaceDialog({ workspace, workspaces = [], onSubmit, onClose }) {
  const [title, setTitle] = React.useState(workspace.title ?? '');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const trimmed = title.trim();
  const duplicate = trimmed !== '' && workspaces.some((entry) => entry.workspaceId !== workspace.workspaceId && entry.title === trimmed);
  const blocked = busy || !trimmed || trimmed === workspace.title || duplicate;
  const close = () => {
    if (!busy) onClose();
  };
  const commit = async () => {
    if (blocked) return;
    setBusy(true);
    try {
      await onSubmit(trimmed);
      onClose();
    } catch (caught) {
      setBusy(false);
      setError(caught?.message ?? String(caught));
    }
  };
  return (
    <Dialog
      title={t('workspace.renameTitle')}
      onClose={close}
      width={400}
      footer={
        <>
          <Button onClick={close}>{t('action.cancel')}</Button>
          <Button variant="primary" disabled={blocked} onClick={commit}>
            {t('action.rename')}
          </Button>
        </>
      }
    >
      <label className="dts-field">
        <span className="dts-field__label">{t('workspace.name')}</span>
        <TextInput
          autoFocus
          value={title}
          onChange={(value) => { setTitle(value); setError(null); }}
          onEnter={commit}
          invalid={duplicate}
          maxLength={200}
          aria-label={t('workspace.name')}
        />
        {duplicate ? <span className="dts-field__hint is-error">{t('workspace.renameConflict', { name: trimmed })}</span> : null}
      </label>
      {error ? <p className="dts-error">{error}</p> : null}
    </Dialog>
  );
}

/** Remove a workspace from the host list; the folder and session logs stay on disk. */
export function DeleteWorkspaceDialog({ workspace, onConfirm, onClose }) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const close = () => {
    if (!busy) onClose();
  };
  return (
    <Dialog
      title={t('workspace.deleteTitle')}
      description={t('workspace.deleteBody', { name: workspace.title })}
      onClose={close}
      width={420}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={close}>{t('action.cancel')}</Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onConfirm();
                onClose();
              } catch (caught) {
                setBusy(false);
                setError(caught?.message ?? String(caught));
              }
            }}
          >
            {busy ? t('workspace.deleting') : t('workspace.deleteTitle')}
          </Button>
        </>
      }
    >
      {error ? <p className="dts-error">{error}</p> : null}
    </Dialog>
  );
}

/** Rename a session the way the native row menu does: one text field, Enter commits. */
export function RenameSessionDialog({ row, onSubmit, onClose }) {
  const [title, setTitle] = React.useState(row.title ?? '');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const trimmed = title.trim();
  const commit = async () => {
    if (!trimmed || trimmed === row.title) {
      onClose();
      return;
    }
    setBusy(true);
    try {
      await onSubmit(trimmed);
      onClose();
    } catch (caught) {
      setBusy(false);
      setError(caught?.message ?? String(caught));
    }
  };
  return (
    <Dialog
      title={t('session.rename')}
      onClose={onClose}
      width={400}
      footer={
        <>
          <Button onClick={onClose}>{t('action.cancel')}</Button>
          <Button variant="primary" disabled={busy || !trimmed} onClick={commit}>
            {t('action.save')}
          </Button>
        </>
      }
    >
      <label className="dts-field">
        <span className="dts-field__label">{t('session.title')}</span>
        <TextInput autoFocus value={title} onChange={setTitle} maxLength={120} onEnter={commit} />
      </label>
      {error ? <p className="dts-error">{error}</p> : null}
    </Dialog>
  );
}

/** Move one or many sessions into a topic (the default group included) or into a brand-new one. */
export function MoveToTopicDialog({ count, topics, emojis, onMove, onCreate, onClose }) {
  const [creating, setCreating] = React.useState(false);
  const [name, setName] = React.useState('');
  const [emoji, setEmoji] = React.useState(emojis?.[0] ?? '');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  // Same rules as the create dialog: the new name has to be unique in this workspace.
  const problem = nameProblem({ name, workspaceId: null, topicsFor: () => topics, ignoreId: null });
  const problemLabel = problemText(problem);

  const run = async (topicId) => {
    setBusy(true);
    try {
      await onMove(topicId);
      onClose();
    } catch (caught) {
      setBusy(false);
      setError(caught?.message ?? String(caught));
    }
  };

  if (creating) {
    return (
      <Dialog
        title={t('topic.moveHere', { n: count })}
        onClose={() => setCreating(false)}
        width={380}
        footer={
          <>
            <Button onClick={() => setCreating(false)}>{t('action.cancel')}</Button>
            <Button
              variant="primary"
              disabled={busy || Boolean(problem)}
              onClick={async () => {
                if (problem) {
                  setError(problemLabel);
                  return;
                }
                setBusy(true);
                try {
                  const topic = await onCreate({ name: name.trim(), emoji, sessionIds: [] });
                  await onMove(topic.id);
                  onClose();
                } catch (caught) {
                  setBusy(false);
                  setError(caught?.code === 'topic-name-taken' ? t('topic.nameTaken') : caught?.message ?? String(caught));
                }
              }}
            >
              {t('action.create')}
            </Button>
          </>
        }
      >
        <label className="dts-field">
          <span className="dts-field__label">{t('topic.name')}</span>
          <TextInput autoFocus value={name} onChange={setName} maxLength={40} invalid={Boolean(problem)} />
          {problem ? <span className="dts-field__hint is-error">{problemLabel}</span> : null}
        </label>
        <EmojiPicker emojis={emojis ?? FALLBACK_EMOJIS} value={emoji} onChange={setEmoji} name={t('topic.icon')} />
        {error ? <p className="dts-error">{error}</p> : null}
      </Dialog>
    );
  }

  return (
    <Dialog
      title={t('picker.topic', { n: count })}
      onClose={onClose}
      width={380}
      footer={
        <>
          <Button onClick={onClose}>{t('action.cancel')}</Button>
          <Button onClick={() => setCreating(true)}>{t('topic.moveHere')}</Button>
        </>
      }
    >
      <div className="dts-list">
        {topics.length === 0 ? <div className="dts-list__empty">{t('topic.emptyHere')}</div> : null}
        {topics.map((topic) => (
          <button key={topic.id} type="button" className="dts-list__item" onClick={() => run(topic.id)} disabled={busy}>
            <TopicMark emoji={topic.emoji} />
            <span className="dts-list__label">{topic.name}</span>
            <span className="dts-list__count">{topic.count ?? ''}</span>
          </button>
        ))}
      </div>
      {error ? <p className="dts-error">{error}</p> : null}
    </Dialog>
  );
}
