/**
 * Pre-publish / CI entry check.
 *
 * `node --check <file>` only parses one file, so it cannot see a missing import: when
 * `lib/adopt.js` was added the command still passed and the host entry failed at boot with
 * `ERR_MODULE_NOT_FOUND`. This walks the real module graph instead — every `lib/*.js` is
 * imported (which resolves its imports and evaluates it), and the client bundle is checked
 * for the registration id the loader keys it by.
 *
 * Exit code is non-zero on the first failure, so `npm run check` and `prepublishOnly` both
 * stop a publish that would ship an entry the host cannot load.
 */
import { readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

/** Host-side modules: importing each one resolves its whole import graph. */
const HOST_MODULES = [
  'lib/index.js',
  'lib/store.js',
  'lib/delete.js',
  'lib/session-files.js',
  'lib/adopt.js',
  'lib/emojis.js',
];

const problems = [];

for (const relative of HOST_MODULES) {
  const path = join(root, relative);
  try {
    await access(path, constants.R_OK);
  } catch {
    problems.push(`${relative}: missing (is it still untracked?)`);
    continue;
  }
  try {
    await import(pathToFileURL(path).href);
  } catch (error) {
    problems.push(`${relative}: failed to load — ${error?.message ?? error}`);
  }
}

// The host entry must expose the plugin name and both export spellings the loader accepts.
try {
  const entry = await import(pathToFileURL(join(root, 'lib/index.js')).href);
  if (entry.default !== undefined && typeof entry.default !== 'function') {
    problems.push('lib/index.js: default export is not the plugin function');
  }
  if (entry.name !== pkg.name.replace(/^@[^/]+\//, '') && entry.name !== pkg.name) {
    problems.push(`lib/index.js: plugin name ${JSON.stringify(entry.name)} does not match package.json`);
  }
} catch (error) {
  problems.push(`lib/index.js: entry assertion failed — ${error?.message ?? error}`);
}

/**
 * The client bundle registers itself under the package name; a stale build or a renamed
 * package makes the loader report "loaded without registering" and the whole Web boot fails.
 * Execute the real loader shell in a throwaway context: a plain `bundle.includes(name)` also
 * matches the file's header comment (and the style id), so it cannot tell a registration id
 * drift from a healthy bundle.
 */
try {
  const bundle = await readFile(join(root, 'lib/client.js'), 'utf8');
  let definition = null;
  runInNewContext(bundle, {
    window: {
      __ModuleLoader__: {
        load(value) { definition = value; },
      },
    },
  }, { timeout: 5_000 });
  if (!definition) {
    problems.push('lib/client.js: never called window.__ModuleLoader__.load (run npm run build)');
  } else {
    if (definition.id !== pkg.name) {
      problems.push(`lib/client.js: registers ${JSON.stringify(definition.id)}, expected ${JSON.stringify(pkg.name)} (run npm run build)`);
    }
    if (typeof definition.factory !== 'function') {
      problems.push('lib/client.js: registration has no factory function');
    }
  }
} catch (error) {
  problems.push(`lib/client.js: missing, unreadable or not loadable — ${error?.message ?? error}`);
}

if (problems.length > 0) {
  console.error(`check failed (${problems.length}):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`check ok: ${HOST_MODULES.length} host modules load, client bundle registers ${pkg.name}`);
