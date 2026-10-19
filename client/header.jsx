/**
 * Panel header: the "工作区" title with its hover-revealed workspace filter, search,
 * selection mode, the create menu (session / session-in-topic / topic / workspace) and the
 * overflow menu, plus the active-filter chips.
 */
import * as React from 'react';
import { cx, Icon, IconButton, Popover, MenuItem, TextInput, TopicMark } from './widgets.jsx';
import { t } from './i18n.js';

function Chip({ children, onClear, emoji }) {
  return (
    <span className={cx('dts-chip', Boolean(emoji) && 'dts-chip--marked')}>
      {emoji ? <span className="dts-emoji" aria-hidden="true">{emoji}</span> : null}
      <span className="dts-chip__text">{children}</span>
      <button type="button" className="dts-chip__clear" aria-label={t('chip.clear')} onClick={onClear}>
        <Icon name="close" size={14} />
      </button>
    </span>
  );
}

/**
 * The ＋ menu.
 *
 * "新会话" always asks where the session belongs first: the workspace when the list is not
 * already scoped to one, then the topic. Starting a session and filing it are one flow, so
 * there is no separate "new session in a topic" entry to keep in sync.
 */
function CreateMenu({ anchor, onClose, workspaceFilter, workspaces, topicsFor, onCreateSession, onCreateTopic, onAddWorkspace }) {
  const resolved = workspaceFilter ?? (workspaces.length === 1 ? workspaces[0]?.workspaceId ?? null : null);
  const [step, setStep] = React.useState('root');
  const [chosen, setChosen] = React.useState(resolved);
  const workspaceId = resolved ?? chosen;
  const topics = workspaceId ? (topicsFor?.(workspaceId) ?? []) : [];

  const startInto = (topicId) => {
    onCreateSession(workspaceId, topicId);
    onClose();
  };

  if (step === 'root') {
    return (
      <Popover anchor={anchor} onClose={onClose} width={232} className="dts-pop--create">
        <MenuItem icon={<Icon name="plus" />} onSelect={() => setStep(resolved ? 'topic' : 'workspace')}>
          {t('action.newSession')}
        </MenuItem>
        <MenuItem icon={<Icon name="projectAdd" />} onSelect={() => { onClose(); onAddWorkspace(); }}>
          {t('action.addWorkspace')}
        </MenuItem>
      </Popover>
    );
  }

  if (step === 'workspace') {
    return (
      <Popover anchor={anchor} onClose={onClose} width={252} className="dts-pop--create">
        <div className="dts-pop__head">{t('topic.pickWorkspace')}</div>
        <div className="dts-pop__list">
          {workspaces.length === 0 ? <div className="dts-pop__empty">{t('workspace.none')}</div> : null}
          {workspaces.map((workspace) => (
            <MenuItem
              key={workspace.workspaceId}
              icon={<Icon name="folder" />}
              hint={String(workspace.visibleCount ?? 0)}
              onSelect={() => {
                setChosen(workspace.workspaceId);
                setStep('topic');
              }}
            >
              {workspace.title}
            </MenuItem>
          ))}
        </div>
        <div className="dts-pop__foot">
          <MenuItem icon={<Icon name="projectAdd" />} onSelect={() => { onClose(); onAddWorkspace(); }}>
            {t('action.addWorkspace')}
          </MenuItem>
        </div>
      </Popover>
    );
  }

  return (
    <Popover anchor={anchor} onClose={onClose} width={252} className="dts-pop--create">
      <div className="dts-pop__head">{t('action.newSessionInTopic')}</div>
      <div className="dts-pop__list">
        <MenuItem icon={<TopicMark emoji="" />} onSelect={() => startInto(null)}>
          {t('topic.ungrouped')}
        </MenuItem>
        {topics.length === 0 ? <div className="dts-pop__empty">{t('topic.emptyHere')}</div> : null}
        {topics.map((topic) => (
          <MenuItem key={topic.id} icon={<TopicMark emoji={topic.emoji} />} hint={String(topic.count ?? '')} onSelect={() => startInto(topic.id)}>
            {topic.name}
          </MenuItem>
        ))}
      </div>
      <div className="dts-pop__foot">
        <MenuItem
          icon={<Icon name="plus" />}
          onSelect={() => {
            onClose();
            onCreateTopic(workspaceId, { thenStartSession: true });
          }}
        >
          {t('topic.moveHere')}
        </MenuItem>
        {workspaceFilter ? null : (
          <MenuItem icon={<Icon name="chevronLeft" />} onSelect={() => setStep('workspace')}>
            {t('action.back')}
          </MenuItem>
        )}
      </div>
    </Popover>
  );
}

export function Header({
  prefs,
  options,
  topicsFor,
  activeTopic,
  onSetPrefs,
  onPickWorkspace,
  onPickTopic,
  onAddTopic,
  onAddWorkspace,
  onCreateSession,
  onOpenHeaderMenu,
}) {
  const [dropdown, setDropdown] = React.useState(null);
  const [create, setCreate] = React.useState(null);
  const total = options.reduce((sum, option) => sum + (option.visibleCount ?? 0), 0);
  const filtered = Boolean(prefs.workspaceFilter) || Boolean(prefs.topicFilter);

  const pickWorkspace = (workspaceId) => {
    onPickWorkspace(workspaceId);
    setDropdown(null);
  };

  return (
    <header className={cx('dts-header', filtered && 'has-filter', prefs.searchOpen && 'has-search')}>
      <div className="dts-header__row">
        <span className="dts-header__label">{t('section.workspaces')}</span>
        <IconButton
          className="dts-header__filter"
          label={t('workspace.current')}
          title={t('workspace.current')}
          active={Boolean(prefs.workspaceFilter)}
          onClick={(event) => setDropdown(dropdown ? null : event.currentTarget.getBoundingClientRect())}
        >
          <Icon name="chevronDown" size={14} />
        </IconButton>

        <span className="dts-header__spacer" />

        <IconButton
          label={t('action.search')}
          title={t('action.search')}
          active={prefs.searchOpen}
          onClick={() => onSetPrefs(prefs.searchOpen ? { searchOpen: false, search: '' } : { searchOpen: true })}
        >
          <Icon name="search" size={16} />
        </IconButton>
        <IconButton
          label={prefs.selectMode ? t('action.exitSelect') : t('action.select')}
          title={prefs.selectMode ? t('action.exitSelect') : t('action.select')}
          active={prefs.selectMode}
          onClick={() => onSetPrefs({ selectMode: !prefs.selectMode, searchOpen: false, search: '' })}
        >
          <Icon name="select" size={16} />
        </IconButton>
        <IconButton
          label={t('action.create')}
          title={t('action.create')}
          active={Boolean(create)}
          onClick={(event) => setCreate(create ? null : event.currentTarget.getBoundingClientRect())}
        >
          <Icon name="plus" size={16} />
        </IconButton>
        <IconButton label={t('action.menu')} title={t('action.menu')} onClick={(event) => onOpenHeaderMenu(event.currentTarget.getBoundingClientRect())}>
          <Icon name="ellipsis" size={16} />
        </IconButton>
      </div>

      {prefs.searchOpen ? (
        <div className="dts-header__search">
          <TextInput autoFocus value={prefs.search ?? ''} placeholder={t('search.placeholder')} onChange={(value) => onSetPrefs({ search: value })} />
          <IconButton label={t('action.close')} onClick={() => onSetPrefs({ searchOpen: false, search: '' })}>
            <Icon name="close" size={14} />
          </IconButton>
        </div>
      ) : null}

      {filtered ? (
        <div className="dts-header__chips">
          {prefs.workspaceFilter ? (
            <Chip onClear={() => onPickWorkspace(null)}>
              {t('chip.workspace', { name: options.find((option) => option.workspaceId === prefs.workspaceFilter)?.title ?? prefs.workspaceFilter })}
            </Chip>
          ) : null}
          {prefs.topicFilter && activeTopic ? (
            <Chip emoji={activeTopic.emoji} onClear={() => onPickTopic(null)}>
              {t('chip.topic', { name: activeTopic.name })}
            </Chip>
          ) : null}
        </div>
      ) : null}

      {dropdown ? (
        <Popover anchor={dropdown} onClose={() => setDropdown(null)} width={268} align="left" className="dts-pop--workspaces">
          <div className="dts-pop__head">{t('section.workspaces')}</div>
          <MenuItem onSelect={() => pickWorkspace(null)} hint={String(total)} icon={<Icon name="folder" />}>
            {t('workspace.all')}
          </MenuItem>
          <div className="dts-pop__list">
            {options.length === 0 ? <div className="dts-pop__empty">{t('workspace.none')}</div> : null}
            {options.map((option) => (
              <MenuItem
                key={option.workspaceId}
                className="dts-menu__item--workspace"
                onSelect={() => pickWorkspace(option.workspaceId)}
                hint={String(option.visibleCount ?? 0)}
                icon={<Icon name="folder" />}
              >
                <span className="dts-workspace__name">{option.title}</span>
                <span className="dts-workspace__path" title={option.path}>
                  {option.path}
                </span>
              </MenuItem>
            ))}
          </div>
          <div className="dts-pop__foot">
            <MenuItem onSelect={() => { setDropdown(null); onAddWorkspace(); }} icon={<Icon name="projectAdd" />}>
              {t('workspace.add')}
            </MenuItem>
          </div>
        </Popover>
      ) : null}

      {create ? (
        <CreateMenu
          anchor={create}
          onClose={() => setCreate(null)}
          workspaceFilter={prefs.workspaceFilter}
          workspaces={options}
          topicsFor={topicsFor}
          onCreateSession={onCreateSession}
          onCreateTopic={onAddTopic}
          onAddWorkspace={onAddWorkspace}
        />
      ) : null}
    </header>
  );
}
