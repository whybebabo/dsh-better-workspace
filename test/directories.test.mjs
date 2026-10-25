/**
 * Directory browsing behind the panel's own add-workspace picker.
 *
 * The picker exists because the host's native Web face is a detached macOS panel; these
 * helpers are the only way it sees the host's folders, so their validation and failure
 * codes are part of the feature, not an implementation detail.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createDirectory, DirectoryError, listDirectories } from '../lib/directories.js';

async function withTree(run) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-directories-'));
  try {
    await mkdir(join(root, 'alpha'));
    await mkdir(join(root, 'Beta'));
    await mkdir(join(root, '.hidden'));
    await writeFile(join(root, 'note.txt'), 'x');
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('a listing contains folders only, sorted, without dot folders', async () => {
  await withTree(async (root) => {
    const listing = await listDirectories(root);
    assert.equal(listing.path, root);
    assert.equal(listing.parent, dirname(root));
    assert.equal(listing.home, homedir());
    assert.equal(listing.truncated, false);
    assert.deepEqual(listing.entries.map((entry) => entry.name), ['alpha', 'Beta']);
    assert.deepEqual(listing.entries.map((entry) => entry.path), [join(root, 'alpha'), join(root, 'Beta')]);
  });
});

test('an omitted path lists the home directory', async () => {
  const listing = await listDirectories(undefined);
  assert.equal(listing.path, homedir());
});

test('listing rejects relative paths and non-directories', async () => {
  await withTree(async (root) => {
    await assert.rejects(listDirectories('relative/path'), (error) => error instanceof DirectoryError && error.code === 'path-not-absolute');
    await assert.rejects(listDirectories(join(root, 'note.txt')), (error) => error instanceof DirectoryError && error.code === 'not-a-directory');
    await assert.rejects(listDirectories(join(root, 'missing')), (error) => error instanceof DirectoryError && error.code === 'directory-missing');
  });
});

test('creating a folder returns its path and refuses duplicates and traversal names', async () => {
  await withTree(async (root) => {
    const created = await createDirectory(root, 'project');
    assert.equal(created.path, join(root, 'project'));
    assert.equal((await listDirectories(root)).entries.some((entry) => entry.name === 'project'), true);

    await assert.rejects(createDirectory(root, 'project'), (error) => error instanceof DirectoryError && error.code === 'directory-exists');
    for (const name of ['', '..', '../escape', 'nested/name', 'nested\\name']) {
      await assert.rejects(createDirectory(root, name), (error) => error instanceof DirectoryError && error.code === 'bad-directory-name');
    }
  });
});
