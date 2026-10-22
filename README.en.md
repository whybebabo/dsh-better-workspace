English | [简体中文](./README.md)

# dsh-better-workspace

`dsh-better-workspace` is a **topic groups** plugin for the DeepSeek Harness sidebar. It layers over the native Workspace area instead of replacing the official list: sessions stay owned by the host, and the plugin only re-organizes how that area is displayed, adding the bulk actions and safe deletion the host does not ship.

With it, sessions scattered across workspaces can be filed the way you actually think about them:

- **Topic groups** — one tree per workspace, with emoji-marked "group" folders holding sessions, plus a system default group and an Archived bucket;
- **Filter and search** — a workspace dropdown, in-panel local search, and "only this group";
- **Bulk actions** — archive / unarchive / move to group / permanent delete, carried by a single row of native icon buttons in the header while selection mode is on;
- **Safe deletion** — DSH has no host-side delete command, so the plugin implements one, and the rule is "refuse rather than risk it" (see [Deletion safety boundaries](#deletion-safety-boundaries));
- **Native look** — status dots, pinning that actually floats rows up, hover cards, row hover actions, scheduled-task clock marks, icons and colors all follow the host's own implementation.

The plugin does not take over the rest of DSH: when the sidebar is collapsed to the rail, the viewport is narrow, or the host routes are unreachable, the panel **hides completely and hands the native UI back** (see [Fallback behavior](#fallback-behavior)).

## Preview

![dsh-better-workspace sidebar: workspace filter, emoji group tree, session status dots and row actions](https://cdn.jsdelivr.net/gh/whybebabo/dsh-better-workspace@main/docs/assets/preview.png)

## How it works

- **Overlay, not replacement** — the panel renders in `shell.overlay`, locates the native Workspace region through structural selectors, and covers exactly that region's own box. The covered region gets `inert` + `aria-hidden`, released automatically while an official dialog is open.
- **Topic data lives on its own** — groups and assignments are stored in a single sidecar file, `<DSH_HOME>/dsh-better-workspace/topics.v1.json`, so you can back it up and upgrade the host independently. Data survives uninstalling the plugin.
- **Two kinds of ordering** — group order is written to the sidecar (shared across windows); workspace and session drag order lives in local `localStorage` preferences.
- **Official commands only** — opening sessions, archiving, pinning, renaming, forking and creating workspaces all go through the host's `uiWorkspace` / `workspaces` services. The plugin does not declare or borrow another package's slots.

## Installation

### Requirements

- DeepSeek Harness Desktop or Web `0.2.1-rc.x`, `@deepseek-ai/cordis` 4.0.5;
- Node.js ≥ 22.19;
- Git available locally (for the `github:` install path).

### From npm (recommended)

```bash
dsh plugin --profile web add @whybebabo/dsh-better-workspace
```

DSH installs the plugin into the Web profile and registers `@whybebabo/dsh-better-workspace` in `dsh.profile.bundles`. No cloning, no manual dependency install, no client build.

Without a global `dsh` command, use `npx`:

```bash
npx @deepseek-ai/dsh plugin --profile web add @whybebabo/dsh-better-workspace
```

The install command needs [Git](https://git-scm.com/) and pnpm on the machine; `npx` also needs Node.js.

Desktop modifies the `desktop` profile, so back up `cordis.patch.yml` / `package.json` / `pnpm-lock.yaml` first:

```bash
dsh plugin --profile desktop add @whybebabo/dsh-better-workspace
```

### From GitHub

Install a tagged release straight from the repository, without npm:

```bash
dsh plugin --profile web add github:whybebabo/dsh-better-workspace#v0.1.3
```

Replace `#v0.1.3` with the tag you want. This path also needs Git and pnpm, and still needs no clone.

### From source

For changing the code or tracking `main`:

```bash
git clone https://github.com/whybebabo/dsh-better-workspace.git
cd dsh-better-workspace
npm install && npm run build
```

Verify it in an isolated profile first, without touching your existing one:

```bash
dsh --profile topic-e2e --from-default-profile web --dump-config
dsh plugin --profile topic-e2e add "link:$(pwd)"
dsh --profile topic-e2e --no-open --port 8791      # prints a tokenized URL
```

Once that looks right, install into the profile you actually use:

```bash
dsh plugin --profile web add "link:$(pwd)"
```

With a `link:` install the host always reads the current directory's artifacts: after editing code, run `npm run build` and restart — no need to `add` again.

### Start or restart DSH

Close the old DSH Web process and start it again:

```bash
dsh web
```

Or via `npx`:

```bash
npx @deepseek-ai/dsh web
```

Open the sidebar and click the ▾ next to the Workspace heading, or hover "Workspaces" — if you see the workspace dropdown and the group tree, the plugin is loaded.

### Upgrading

After a new release, re-run the install command:

```bash
dsh plugin --profile web add @whybebabo/dsh-better-workspace
```

Then restart DSH. Source installs instead use:

```bash
git pull && npm install && npm run build
```

### Uninstalling

```bash
dsh plugin --profile web remove @whybebabo/dsh-better-workspace
```

Topic data stays in `<DSH_HOME>/dsh-better-workspace/`; delete that directory yourself if you want it gone.

### Verifying the install

The plugin registers a read-only `GET /state` route. Visit it in a browser (use your actual port):

```powershell
Invoke-WebRequest 'http://127.0.0.1:3080/dsh-better-workspace/api/state' | Select-Object StatusCode
```

Expect `200`, with `ok: true` and your group data under `result.workspaces`.

> The route only accepts loopback + same-origin requests. A `403` from another machine is the guard working, not a fault.

## Usage

### Groups

- **Create** — from the workspace `⋯` menu, or the "new topic and put it in…" item in the header ＋ menu; you can also drag a session onto a group to file it. A new group takes the top slot in its workspace's group list, so you do not have to scroll to the bottom to find it.
- **New session** — the ＋ on a group row starts a session directly in that group (a workspace row's ＋ starts one in that workspace).
- **Rename** — double-click a group name to edit inline (duplicates and illegal characters are reported immediately, and the save is disabled).
- **Reorder** — drag a group row; dropping on the upper or lower half of a target row decides the insert position, with an insertion line while dragging.
- **Only this group** — the filter in a group's `⋯` menu also locks to that group's workspace, so identically named groups never bleed across workspaces.
- **Delete** — clears assignments only; sessions return to the system default group. No sessions are deleted.

Every workspace has a system default group. It cannot be renamed or deleted, but it reorders like any other group.

### Sessions

- **Double-click** to rename (same as the desktop app);
- **Hover** for the native hover card: full title, relative time, idle/working/waiting status, and an archived marker when archived;
- **Hover a clipped title**: like the native list, it crawls to its far edge at ~30 px/s and **rests there** (no bounce, no back-and-forth); leaving returns it to the start at once. Overflow under 8 px is left alone (it would read as jitter), and reduced-motion jumps straight to the end;
- **Row hover** reveals `⋯ / archive / pin`, with the inline timestamp yielding to them;
- **Drag** — onto another workspace is refused (guard); onto another group files the session there;
- **Pin** actually floats the row to the top of its group (host pin order, most recent first).

### Where a new session lands

- The header ＋ "new session", a workspace row's ＋, and the rail's "new session" all leave the session with **no group assignment written**, so it stays in the system default group and sorts first inside that bucket — the same placement the official list gives it;
- A group row's ＋, or an explicitly chosen group in the ＋ flow: the session is created and then filed into that group;
- Creating one while "only this group" is active files it into that group, since it is the place you are looking at;
- Earlier versions filed implicit new sessions into the "most recently created group". Groups used to render oldest-first, so that group was usually the last one, which dropped the new row at the bottom of the workspace. That behavior is gone; a newly created group now leads the list instead.

> The default group itself is still draggable (like the native list: it cannot be renamed or deleted, but it can be reordered). Drag it to the bottom and ungrouped sessions sit down there with it — that is your own ordering, not the plugin pushing new sessions to the end again; drag it back up to restore the placement.

### Manual order vs. newer sessions

A drag's order applies only to the ids it names: those ids permute among the slots they already occupied, and any session missing from the saved order (for example one created after the last drag) keeps the position the host gave it instead of being demoted to the end. So "drag once, then create a session" no longer pushes the new session to the bottom.

### Bulk actions

Click "select" in the header. Selection mode takes over the header: exit, selected count, archive/unarchive/move/permanent delete as one row of native icon buttons that does not wrap in a narrow sidebar.

- Mixing **archived** rows into the selection disables archive and move; mixing **unarchived** rows disables unarchive; mixing **ungrouped** sessions disables move;
- The toolbar states the reason below the row, and hovering shows the same;
- The provisional "new session" row never joins a selection;
- **"Select all" only spans the rows on screen**: the group checkbox, the topic ⋯ menu and the workspace ⋯ menu all consume one derivation (`selectableIds`), so a bucket past "show all 60" reports "selected N; M more are not shown yet" and asks you to expand it — it never quietly pulls rows that were never rendered into a batch permanent delete;
- A session removed by another window drops out of the batch targets instead of failing the whole batch with "no such session";
- Leaving selection mode clears the selection.

Everything except `/delete/*` runs item by item, reports per-item results, and can retry failures.

### Permanent deletion

**Deletion removes the session records on disk and cannot be undone** (workspace files themselves are untouched). The flow is: `/delete/preview` returns per-item verdicts → you confirm in a dialog → `/delete/execute` runs.

- A running session is stopped the official way (`agent.cancel({kind:'user'})`) and given up to 3 seconds to leave `running`; if it does not, nothing is deleted;
- A session with subagent children is refused — delete the parent instead (children are cascaded and counted in the preview);
- A user fork (with `parentSession` but no `origin`) is a top-level session: it deletes on its own and is never treated as a subagent;
- Deleting the session you are viewing switches to a fresh blank session.

### Collapsed rail

Once the sidebar is collapsed to the rail, the host's own "new session / add workspace / search" buttons still run the stock implementation, so the plugin intercepts them in the capture phase: new session expands the sidebar first, then calls exactly the same `uiWorkspace.startSession()` the expanded button calls; "add workspace" only expands the sidebar and does not swallow the event, so the host's directory picker continues normally; search expands the sidebar and opens the panel's own search field.

## Data and files

| Location | Purpose |
|---|---|
| `<DSH_HOME>/dsh-better-workspace/topics.v1.json` | Groups and assignments (one file, easy to back up) |
| `<DSH_HOME>/dsh-better-workspace/topics.v1.json.bak` | Copy of the last successful write |
| `<DSH_HOME>/dsh-better-workspace/topics.v1.json.corrupt-<ts>` | Damaged copy kept for manual salvage when the primary cannot be parsed |
| `<DSH_HOME>/dsh-better-workspace/topics.v1.lock` | Cross-process write lock (contents: `<pid>-<random>` token) |
| `localStorage["dsh-better-workspace:prefs:v1"]` | Workspace/group filters, collapse state, search, drag order |

Writes go temporary file → `fsync` → `rename`, keeping `.bak` from the previous write. If the primary is corrupt, the store falls back to the backup and enters **read-only mode** (banner at the top of the panel); that recovery write does not overwrite `.bak` with the broken file. If **neither** the primary nor the backup can be parsed, every write is refused rather than starting from an empty document, and read-only mode clears itself as soon as the file is repaired — no host restart needed.

The lock is released only by its owner: the lock file carries a token that is compared before unlinking. A lock is reclaimed only when its `mtime` exceeds `staleLockMs` **and** the PID in its token is gone, so a slow writer is never evicted mid-write.

**Topic rules:** a session belongs to at most one group; groups are scoped per workspace; deleting a group only clears assignments; every workspace (including ones that have not been written to the sidecar yet) has a virtual system default group; archiving does not change assignment; deleting a session cleans up its assignment. The virtual "ungrouped" bucket only holds **unarchived** sessions with no workspace; archived sessions appear only in their workspace's Archived bucket.

### Workspace membership repair

Which workspace a session belongs to is the host's decision: if the artifact header's `cwd` canonicalizes to a registered workspace path, that workspace should account for the session in its `sessionIds`. The host only does that on its own `session.create` path, so a session can end up with a matching `cwd` and no accounting slot when:

- a workspace was deleted and re-created (`sessionIds` went with the old record);
- the host crashed or the window closed between the header write and `attachSession`;
- the session was resumed through a different path (for example reusing an older blank record).

The native list treats those as "no workspace accounts for it" and shows them in the trailing Ungrouped bucket. No data is lost, but it looks lost — especially after the plugin is removed, where they simply stay in Ungrouped. On the panel's first on-screen pass the plugin calls `/sessions/adopt` once, which uses only the official `workspace.attachSession(id)` to put **those and only those** sessions back (that command re-validates `cwd`, refuses a mismatch, and prepends the id, so a repaired session lands first in its workspace, exactly like a new one). Subagent children, archived sessions, sessions that already have a workspace, and sessions whose `cwd` no longer resolves are never touched; a refused attach is reported per id instead of forced. The panel reports "restored N session(s) to their workspace".

## Host routes

Prefix `/dsh-better-workspace/api`, registered on both `webServer` (browser) and `connection.fetch` (the Desktop portless carrier; the client uses `/api/...`). Loopback + same-origin only.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/state` | Read the group document and read-only state |
| `POST` | `/topics/create` | Create a group (optionally filing sessions into it) |
| `POST` | `/topics/update` | Rename / change icon / change order |
| `POST` | `/topics/delete` | Delete a group (sessions return to the default group) |
| `POST` | `/topics/reorder` | Reorder groups |
| `POST` | `/assign` | File sessions into a group |
| `POST` | `/sessions/adopt` | Re-attach sessions whose `cwd` belongs to a workspace but which the host never accounted (idempotent; safe to repeat) |
| `POST` | `/delete/preview` | Per-item deletion verdicts |
| `POST` | `/delete/execute` | Perform the deletion |

Every write **must** carry `expectedRevision` (missing → `400 revision-required`); a mismatch returns `409` with `currentRevision`, after which the client reloads and retries. `/delete/*` are imperative operations and do not participate in revision checks.

## Fallback behavior

The panel renders in `shell.overlay`, locating the native Workspace region structurally (`[role="tree"]` up to its column, then the region element containing it; the `_regionArea` class suffix is only a hint), so it does **not** depend on CSS-module hashed class names. The cover rectangle is the region's own box (matching the official `WorkspaceBrowser` placeholder exactly, section header included) rather than the full column. The covered region gets `inert` + `aria-hidden` while the panel is visible, released while an official dialog appears there.

The client entry declares only `inject: ['slots']`: cordis throws on property access to an undeclared service (`cannot get property ... without inject`), which was the direct cause of an earlier `topic-e2e` profile boot failure (reading `ctx.shortcuts` threw, and the whole web boot reported "1 entry did not activate").

The panel **hides completely and hands the native UI back** whenever: the sidebar is collapsed to the rail, the viewport is narrower than 1024, the region is narrower than 180, region measurement fails, host routes are unreachable, or `config.enabled: false`.

## Deletion safety boundaries

DSH has no host-side command to delete a session, so the plugin implements one with a "refuse rather than risk it" rule. After removing the log it clears the host's in-memory session, workspace accounting, archive/pin records and projection cache through the `sessions` / `workspaceRegistry` / `storageDomain` services, so a deleted session does not linger in the sidebar or search. The boundaries:

1. The session id must be a single safe path segment (no `/`, `\`, `..`);
2. The directory must live under `<DSH_HOME>/sessions`, with every path level checked via `lstat` + `realpath`, rejecting symlinks/junctions; a sessions root that is itself a link is refused outright;
3. The first line (header) of `session.v3.jsonl[.zstd]` must be read and confirm `header.id === sessionId` — a directory-name match alone never deletes;
4. A session whose artifact was **appended to recently** is blocked (subagent sessions are blocked too, and are cascaded by their parent with a count in the preview); a user fork carrying only `parentSession` is not a subagent. Note that DSH's write lease is *not* "a lock file exists": Windows uses a named kernel semaphore, and on POSIX `session.lock` is never removed once created — so this checks the artifact's recent modification time (a 15-second quiet window) rather than `*.lock` filenames;
5. A running session is stopped the official way (`agent.cancel({kind:'user'})`) and given up to 3 seconds to leave `running`; if it does not, nothing is deleted;
6. Removal first `rename`s the target into a `.trash-<pid>-<rand>` quarantine inside the root, then deletes the quarantine — `rename` is atomic and resolves the path once, which closes the window where a parent directory swapped for a junction would redirect a recursive delete; afterwards `lstat` proves the directory is really gone;
7. Batches preflight as a whole, then execute item by item without rolling back successes, returning `deleted/skipped/partial/failed` per item; `partial` means the parent was deleted but some children were not (`subagentsFailed` lists them).

## Switching off and rollback

- **Temporarily disable** — set the plugin's `config.enabled` to `false` in the profile's `cordis.patch.yml`; after a restart the official UI is fully restored;
- **Disable deletion only** — `config.enableDelete: false` (routes return 403, and the batch toolbar hides the delete button);
- **Uninstall** — see Uninstalling above; topic data stays in `<DSH_HOME>/dsh-better-workspace/`.

Both switches are configuration only and need no rebuild. Deleting the sidecar directory returns the plugin to a clean state (you lose groups, but sessions themselves are untouched).

## Development

```bash
npm install
npm run build     # esbuild -> lib/client.js (window.__ModuleLoader__.load shell; externalizes react/react-dom/host primitives)
npm run check     # loads lib/*.js as a real module graph and checks the bundle's registration id (not node --check)
npm test          # 206 tests
```

`client/` is the source; `lib/client.js` is the artifact (shipped in the package, do not edit by hand). `react`/`react-dom`/`jsdom` in the test setup are **dev dependencies only**: at runtime `require('react')` resolves to the instance the host already loaded (React 18.3.1, same as DSH 0.2.1), so a second React is never bundled.

`test/` covers: sidecar locking/atomic writes/revisions/corruption recovery, **cross-process** concurrent writes (two forked node processes), the selection scope (`selectableIds`, shared by all three "select all" entry points), tree derivation and status aggregation, batch archive classification, deletion safety boundaries (including a deterministic directory swap between preview and execute, and a failed quarantine), drag and rename, the panel's jsdom integration (loading the **built artifact**, with fabricated layout and `fetch`), scheduled-task frequency and the hover block, and zh/en key-set symmetry.

Every safety fix in this round was **mutation-checked**: revert the implementation to the old behaviour and the corresponding test must go red. Do the same after touching safety-related code — adding happy-path cases alone easily yields tests that "look like they guard, but stay green when the code is deleted" (in the second review round 21 of 56 mutations still survived; see `review/round2/`).

All six behaviour fixes in this round have guarding tests, and each was mutation-checked: reverting `orderBy` to "unlisted ids last", `samePath` to strict equality, the implicit new-session path to filing into the newest group, removing the cross-workspace guard, restoring the ping-pong marquee, and zeroing the dead-zone threshold all turn their tests red.

> The mutation script needs verifying too: its first version reported two **false greens**, because the working tree is CRLF (a `\n}\n` anchor silently missed) and one injection landed after a `continue` (dead code). It now requires the anchor to hit, the mutated source to still build, and the target test to have actually run and failed — otherwise it reports "the check was vacuous" instead of `ok`. Check those three things yourself rather than trusting a printed `ok`.

### Layout

```
lib/              Node side: entry, sidecar store, deletion, session file parsing, emoji table
client/           Browser source (.js logic + .jsx components + styles.css)
lib/client.js     Built artifact, generated by client/build.mjs
test/             node --test suites
docs/assets/      README screenshots (not shipped in the npm package; the README links the raw URL)
cordis.patch.yml  Profile patch (the enabled / enableDelete switches)
```

### Publishing

The package is `@whybebabo/dsh-better-workspace` with `publishConfig.access: public`; the `files` allowlist ships only `lib`, `cordis.patch.yml`, `README.md`, `README.en.md`, `LICENSE` and `THIRD_PARTY_NOTICES.md` (no source; `docs/` is excluded too, so the preview uses an absolute GitHub raw URL — a relative path would 404 on the npmjs page).

The shipped `lib/client.js` must register with `__ModuleLoader__` under the **package name**, not the short `id` in `cordis.patch.yml`: the host builds the plugin graph from the package name, and a mismatched id makes it report `loaded without registering` and fail the whole Web boot. `client/build.mjs` reads that id from `package.json`, and `test/client-registration.test.mjs` pins the contract.

```bash
npm run build          # build first: lib/client.js in the package is an artifact
npm pack --dry-run     # inspect the file list
npm publish            # publish to npm
git tag v0.1.3 && git push --tags
```

The `github:...#v0.1.3` install path only works once a tag exists; the two are independent, but publish them with the same version.

## Known limits

- The **workspace** order is stored in local preferences only, so it is not shared across windows (group order is);
- The official Workspace header's search/sort buttons are covered; the panel provides its own local search (local matching, not the remote `sessions.search`);
- The session row menu is drawn by the plugin (it cannot borrow the official entry, see above), but order, wording, icons and shortcut hints match the original item by item; hints come from the host's current default bindings, so rebinding them in settings leaves the hint text stale (the action itself still goes through official commands);
- The group row's ＋ "new session" relies on the host marking new sessions as `blank`; if a future version stops doing that it degrades to "not auto-filed" (still movable), never to modifying existing sessions;
- Permanent deletion depends on host-internal service names (`sessions`/`agents`/`workspaceRegistry`/`storageDomain` with `session_projcache` and `workspace`), which need re-checking on every DSH major version; if a cleanup service is missing the log is still deleted and failures are recorded in the result;
- The cross-process "being written" check is a **conservative approximation**: the plugin cannot query the kernel lease from the browser or host process, so it uses the artifact's recent modification time (15-second quiet window). A session that just finished writing may be refused for up to 15 seconds (the preview reports `locked`; retry shortly), and conversely a quiet but still-running session may be missed — this boundary prefers to let something through rather than delete the wrong thing;
- Inline rename and drag ordering depend on native DOM/junction behaviour; jsdom covers structure but not visuals ("status yields to the caret" is pure CSS, so deleting those rules leaves tests green and needs eyeballing);
- The scheduled-task clock and hover block are drawn from `remote.schedule.catalog()`: the host's `sidebar.session.row.leading` / `.hover` slots can only be rendered by the declaring entry, so an overlay cannot borrow them; `cron` rules keep the host's raw `Cron {expression}（zone）` form without a human-readable preview. Note the namespace is an **independent cordis service** (`ctx.get('remote.schedule')`), not a property of `remote` — reading it as a property throws `cannot get property "remote.schedule" without inject`, which turns "service exists" into "service missing"; a resolution failure warns once via `console.warn`. If catalog fields are renamed in a later version these two surfaces stay blank, without affecting the rest of the panel;
- The npm package ships the built artifact; to track `main` or change the code, use the source install and `npm run build`;
- The membership repair goes through the host's `workspace.attachSession`, which validates `cwd` by `realpath`: if the session's directory is gone or moved the attach is refused (the panel never forces it), and that session stays in Ungrouped — it can still be filed into a group, but its workspace membership cannot be restored. When `workspaceRegistry` / `sessionPersistence` are missing the route answers `available: false` and the panel silently skips;
- "A new session stays in the default group" relies on the host marking it `blank` and putting it in `workspace.sessionIds`; without that it is still shown, just without a guaranteed first-bucket position;

## License

MIT. Third-party acknowledgements: [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
