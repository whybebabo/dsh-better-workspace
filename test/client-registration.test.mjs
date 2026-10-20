/**
 * The client-modules loader contract, checked against the shipped bundle.
 *
 * A plugin's browser half is addressed by the `name` in its own package.json: the loader
 * composes a graph row for that id and, after the bundle script runs, looks for a factory
 * registered under exactly that id. A bundle that registers any other id makes the loader
 * throw `client-modules: could not load "<name>": ... loaded without registering`, and the
 * whole Web boot fails (`Failed to load plugins`).
 *
 * That is what shipped as 0.1.0: the package was renamed to the scoped
 * `@whybebabo/dsh-better-workspace`, but `client/build.mjs` kept the pre-rename
 * `dsh-better-workspace` literal in `__ModuleLoader__.load({ id })`. Under the unscoped name
 * the two matched by luck; after the rename they never could. These checks pin the invariant
 * so a future rename cannot silently break the install again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const BUNDLE = join(root, 'lib', 'client.js');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const source = readFileSync(BUNDLE, 'utf8');

/** The ids the bundle registers, captured exactly as the page-level loader would see them. */
function registeredIds() {
  const registrations = [];
  const window = { __ModuleLoader__: { load: (entry) => registrations.push(entry) } };
  // Only the registration shell runs here; the factory stays unmaterialized, like the loader's
  // own arrival check, so no DOM or React is needed.
  new Function('window', source)(window);
  return registrations.map((entry) => entry.id);
}

/** The loader normalizes a trailing `/client` before comparing; mirror that. */
const normalize = (id) => (id.endsWith('/client') ? id.slice(0, -7) : id);

test('the bundle registers exactly the id the loader derives from package.json', () => {
  const ids = registeredIds().map(normalize);
  assert.deepEqual(
    ids,
    [pkg.name],
    `lib/client.js must register "${pkg.name}" (the package name the loader keys plugins by); `
      + `it registered ${JSON.stringify(ids)}. Run \`npm run build\` after renaming the package or editing client/build.mjs.`,
  );
});

test('the bundle registers once (a second registration aborts the boot)', () => {
  assert.equal(registeredIds().length, 1, 'the loader rejects a bundle that registers twice');
});

test('the stylesheet is tagged with the same id the loader files it under', () => {
  // The loader inventories every <style data-plugin="<id>"> a factory injects, keyed by the
  // same id, so a second hand-maintained literal for the style tag would drift the same way.
  const escaped = pkg.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(
    source,
    new RegExp(`STYLE_ID\\s*=\\s*"${escaped}"`),
    `the client half must tag its <style> with "${pkg.name}", not a short historical id`,
  );
});

test('the host half still names the plugin row and sidecar directory', () => {
  // The row id is a *different* string from the package name on purpose: cordis.patch.yml
  // inserts `name: @whybebabo/...` with `id: dsh-better-workspace`, and that id names the
  // sidecar directory. Changing it would strand existing topic data, so it must stay put even
  // though the client module id had to follow the package name.
  const host = readFileSync(join(root, 'lib', 'index.js'), 'utf8');
  assert.match(host, /export const name = 'dsh-better-workspace'/);
});
