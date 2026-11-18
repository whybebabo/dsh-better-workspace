# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project overview

`@whybebabo/dsh-better-workspace` is a **cordis plugin for DeepSeek Harness (DSH)**: it overlays the
native sidebar Workspace region with a topic-group tree (emoji folders, a per-workspace default group,
an archived bucket), plus bulk archive/move and a permanent session deletion DSH does not ship.
Version 0.1.12, MIT, `type: module`, `engines.node >= 22.22.2`.

Two halves that never share code:

- **Host half** (`lib/`, Node ESM) — plugin entry, topic sidecar store, HTTP routes under
  `/dsh-better-workspace/api`, deletion engine. Only `node:` builtins and relative imports.
- **Browser half** (`client/`, React 18) — the overlay panel, built by esbuild into the committed
  artifact `lib/client.js`. `react`, `react-dom` and `@deepseek-ai/*` are esbuild `external`s: at
  runtime they resolve to the host's already-loaded copies, never a second React.

There is no runtime dependency block; `esbuild`, `jsdom`, `react`, `react-dom` are dev-only.

## Common commands

```bash
npm install              # dev toolchain only
npm run build            # esbuild client/index.jsx -> lib/client.js (committed artifact)
npm run check            # imports every lib/*.js as a real module graph + checks the bundle id
npm test                 # node --test test/*.test.mjs — 355 tests, ~47 s
npm pack --dry-run       # inspect the 13 files that would be published
npm publish              # prepublishOnly = build && check && test
git tag vX.Y.Z && git push --tags
```

- **Build before check and test.** `scripts/check.mjs` fails if `lib/client.js` is missing or registers
  the wrong id, and `test/panel.test.mjs` / `test/client-registration.test.mjs` load the built bundle
  (the latter at module load). All other suites import sources directly. `npm run check` exists because
  `node --check` parses one file and cannot see a missing import; it imports every host module and
  asserts `lib/index.js` exports `name` plus the plugin function.
- There is **no linter, formatter, tsconfig or CI**. Do not add lint steps without being asked.
- Dev install: `dsh plugin --profile <p> add "link:/abs/path"`; the host re-reads the directory, so
  after editing just `npm run build` and restart (no re-`add`).

## Architecture contracts

- **Routes**: `/dsh-better-workspace/api` on both carriers — `webServer` for browser profiles and
  `connection.fetch`, which serves each route under `/api<path>` for the Desktop shell. `GET /state`;
  `GET /emojis`; `POST /topics/{create,update,delete,reorder}`, `/assign`, `/sessions/adopt`,
  `/delete/{preview,execute}`.
- **Guards to keep**: loopback `Host` + same-origin `Origin` (`Origin: null` refused); `POST` needs
  `content-type: application/json` (else 415); 64 KiB body cap (413); method gate (405). Every sidecar
  write needs `expectedRevision` — missing → `400 revision-required`, stale → `409` with
  `currentRevision`. `/delete/*` are imperative and skip revisions.
- **Client errors must never become 5xx** (`CLIENT_ERROR_STATUS` in `lib/index.js`): the panel reads a
  5xx as "host unreachable" and hides itself.
- **Config from `cordis.patch.yml`**: `enabled` (false registers only `/state` so the panel can hand the
  region back and hide), `enableDelete` (false → 403 on delete routes, delete button hidden), `storageHome`.
- **Cordis wiring**: host uses `ctx.inject(['webServer'])` / `ctx.inject(['connection'])`; `agents`,
  `sessions`, `workspaceRegistry`, `storageDomain`, `sessionPersistence` are resolved via `ctx.get()`
  in try/catch and are all optional, so headless boots still start. The browser entry declares only
  `export const inject = ['slots']` — reading any other service through `ctx.*` throws in cordis, so use
  `ctx.get()`. `remote.schedule` is an independent service (`ctx.get('remote.schedule')`).
- **Client id coupling** (a wrong id breaks the whole Web boot): `lib/client.js` registers under the
  `package.json` `name`, and `client/build.mjs` derives both that id and `__DSH_CLIENT_ID__` from it.
  The `id` in `cordis.patch.yml` (`dsh-better-workspace`) is the plugin row id and sidecar directory
  name: keep it short, never use it as the client id.

## Data and deletion

- State lives in `<DSH_HOME>/dsh-better-workspace/`: `topics.v1.json`, `.bak`, `.corrupt-<ts>`,
  `topics.v1.lock` (token `<pid>-<rand>`), `<pid>.<rand>.tmp` staging files. `DSH_HOME` resolves as
  `config.storageHome` → `process.env.DSH_HOME` → `~/.dsh`.
- Writes go tmp → `fsync` → `.bak` copy → atomic `rename` (retried on Windows `EBUSY`/`EPERM`). A
  corrupt primary falls back to `.bak` and goes **read-only**; if neither parses, writes are refused
  rather than starting from an empty document. A recovery write must never copy the broken primary
  over the good backup.
- `lib/delete.js` + `lib/session-files.js` are the only code that removes session artifacts, and
  regressions there delete user data. Preserve every boundary: single safe path segment ids; paths
  anchored to the `realpath` of `<DSH_HOME>/sessions` (symlinks/junctions refused); the header must
  confirm `header.id === sessionId`; a running session is cancelled with `agent.cancel({kind:'user'})`
  and gets 3 s to leave `running`; subagent children are refused (the parent cascades); a user fork
  (`parentSession` without `origin: 'subagent'`) is top-level; removal renames into a
  `<DSH_HOME>/dsh-better-workspace/trash/.trash-<pid>-<rand>` quarantine outside the sessions root
  (never below it: DSH enumerates every directory there) and proves the directory gone. Preview runs before
  execute, and a partial batch never rolls back successes.
- The "being appended to" check is a 15 s quiet window on mtime, not a lock-file probe: DSH's write
  lease is a named kernel semaphore on Windows and a never-removed `session.lock` on POSIX.

## Code style and conventions

- ESM only; `node:` prefixes for builtins; explicit `.js`/`.jsx` on relative imports. 2-space indent,
  semicolons, single quotes, trailing commas. `.js` for logic, `.jsx` for components.
- Keep DOM-free logic in plain `.js` modules (`model.js`, `batch.js`, `dnd.js`, `schedule.js`,
  `marquee.js`) and components thin. Exported helpers carry JSDoc.
- Every module opens with a block comment explaining the failure it prevents. Comments are mixed
  English/Chinese — match the surrounding file. No user-facing string in code: all go through `t('key')`.
- `client/i18n.js` holds `zh` (default) and `en`. Both dictionaries must have the same key set and the
  same `{placeholder}` names; `test/i18n.test.mjs` enforces it, so edit both together.
- Styling is one plain `client/styles.css` (no CSS modules): own selectors use the `dts-` prefix, colors
  and metrics come from `--dsw-*` host tokens with a literal fallback. Never target host elements by
  hashed CSS-module class — match structural selectors or class *suffixes* only.
- Payload shapes: `{ ok, result }` / `{ ok: false, error, code }`. Validate ids and names at the store
  boundary (`lib/store.js` regexes, `TOPIC_NAME_MAX`, `BATCH_MAX`).
- Commits use conventional prefixes (`feat:`, `fix:`, `perf:`, `docs:`, `chore:`,
  `chore(release):`) with a lowercase imperative subject and a bullet body. A release bumps
  `package.json` + lockfile, retargets the README install examples, and tags `vX.Y.Z`.
- `README.md` (Chinese) and `README.en.md` (English) are parallel and both shipped; keep their section
  structure and facts in sync.

## Directory guide

```
lib/                host half (Node ESM); lib/client.js is the generated bundle — never edit
  index.js          entry: routes, guards, error mapping
  store.js          topic sidecar: lock, revisions, atomic write, corruption recovery
  delete.js         preview/execute permanent deletion
  session-files.js  artifact layout, id/path safety, header verify, quarantine
  adopt.js          re-attach orphaned sessions via workspace.attachSession
  emojis.js         glyph list copied in order from Zen Browser (MPL-2.0)
client/             browser source: index.jsx (registration), overlay.jsx (panel root),
  header/topic-tree/session-row/dialogs/results/batch-bar/widgets .jsx (components),
  model.js (pure tree + selectableIds), keyboard.js (IME guard), delete-results.js (retry merge),
  store.js (mirror + localStorage prefs), api.js (transport), actions.js (host commands),
  geometry.js (region + inert),
  composer.js (chip seat), plus i18n dnd batch schedule marquee time shortcut-hints
  styles.css build.mjs
scripts/check.mjs   pre-publish module-graph + bundle-id check
test/               node:test suites
cordis.patch.yml    profile patch row: id, name, config switches
docs/assets/        README screenshot (not shipped; README links a jsDelivr URL)
review/, .tmp/      local notes and probes — gitignored, never shipped
```

## Testing

- `node --test test/*.test.mjs` with `node:test` + `node:assert/strict` only; pure modules are imported
  directly, no framework or mocking library. `test/panel.test.mjs` is the integration suite: jsdom
  renders the **built** `lib/client.js`, answers `getBoundingClientRect` from a class-name table (jsdom
  does no layout), stubs `fetch` and the host `ctx`, and asserts on DOM text, `data-reason` and `inert`.
  `store-crossprocess.test.mjs` forks two real processes to prove the file lock serializes writers.
- Safety and behaviour fixes are expected to be **mutation-checked**: revert the fix in a scratch copy
  and confirm the new test goes red. A test that stays green when the code is deleted guards nothing.

## Gotchas

- `lib/client.js` is generated and committed: edit `client/` and rebuild; never patch the bundle.
- Both READMEs and the suite report **355** tests. Update the number in both READMEs when touching them.
- The working tree is CRLF (`core.autocrlf=true`, no `.gitattributes`) while esbuild writes LF. Scripts
  anchoring on `\n}\n` must tolerate CRLF or the mutation silently misses.
- `jsdom@30.1.3` declares `engines: ^22.22.2 || ^24.15.0 || >=26`; `package.json` now matches
  (`>=22.22.2`) so the install no longer prints `EBADENGINE`.
- `.npmrc` holds a live npm token; it is gitignored (that ignore line is itself a local, uncommitted
  change), as are `review/` and `.tmp/`. Never commit or print either, and nothing there ships.
- Deletion and membership repair depend on host internals that are not public API: re-verify
  `sessions` / `agents` / `workspaceRegistry` / `storageDomain` / `sessionPersistence` on each DSH
  major version.
- The panel hides and hands the stock UI back on a collapsed rail, viewport < 1024 px, region < 180 px
  wide or < 64 px tall, an unresolvable region, unreachable routes, or `config.enabled: false`. Keep
  that fallback intact when touching geometry. jsdom covers structure only: CSS yields, animation
  timing and visual fidelity need a real browser.
- `README.md` uses `$(pwd)` in the `link:` install examples — bash-only (`$PWD` or `%CD%` elsewhere).
