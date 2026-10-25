/**
 * Server-side directory browsing for the panel's own add-workspace picker.
 *
 * A browser-hosted macOS deployment composes the host's "native" picker, which is a
 * detached JXA `NSOpenPanel` in a helper process — it can open behind the browser and
 * ignore clicks. The browser half therefore renders its own picker on Web and asks these
 * routes for the host's directories; the paths it shows are the host's, which is also what
 * a tunnelled browser needs (the client's own folders are not the server's).
 */
import { mkdir, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** A listing is a navigation aid, not a filesystem dump: stop at a screenful of folders. */
const MAX_ENTRIES = 300;

export class DirectoryError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = 'DirectoryError';
    this.code = code;
    this.status = status;
  }
}

function absolutePath(value) {
  const text = String(value ?? '').trim();
  if (!text) throw new DirectoryError('缺少目录路径', 'path-required');
  if (!isAbsolute(text)) throw new DirectoryError('目录路径必须是绝对路径', 'path-not-absolute');
  return resolve(text);
}

async function requireDirectory(path) {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) throw new DirectoryError('该路径不是文件夹', 'not-a-directory');
  } catch (error) {
    if (error instanceof DirectoryError) throw error;
    if (error?.code === 'ENOENT') throw new DirectoryError(`文件夹不存在: ${path}`, 'directory-missing', 404);
    if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      throw new DirectoryError(`没有权限读取文件夹: ${path}`, 'directory-unreadable', 403);
    }
    throw new DirectoryError(`无法读取文件夹 ${path}: ${error?.message ?? error}`, 'directory-unreadable', 500);
  }
}

/**
 * One directory level, without dot-directories (the path field is the way into those).
 * @param {string|undefined} target absolute directory, or undefined for the home directory.
 */
export async function listDirectories(target) {
  const path = target === undefined || target === null || target === '' ? homedir() : absolutePath(target);
  await requireDirectory(path);
  let dirents;
  try {
    dirents = await readdir(path, { withFileTypes: true });
  } catch (error) {
    throw new DirectoryError(`无法读取文件夹 ${path}: ${error?.message ?? error}`, 'directory-unreadable', 403);
  }
  const entries = dirents
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => ({ name: entry.name, path: join(path, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' }));
  const parent = dirname(path);
  return {
    path,
    parent: parent === path ? null : parent,
    home: homedir(),
    truncated: entries.length > MAX_ENTRIES,
    entries: entries.slice(0, MAX_ENTRIES),
  };
}

/** Create one child folder of an existing directory; refuses path separators in `name`. */
export async function createDirectory(target, name) {
  const path = absolutePath(target);
  const child = String(name ?? '').trim();
  if (!child || child === '.' || child === '..' || /[/\\]/.test(child)) {
    throw new DirectoryError('文件夹名称必须是单个路径段', 'bad-directory-name');
  }
  await requireDirectory(path);
  const next = join(path, child);
  try {
    await mkdir(next);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new DirectoryError('同名文件夹已存在', 'directory-exists', 409);
    throw new DirectoryError(`创建文件夹失败: ${error?.message ?? error}`, 'directory-create-failed', 500);
  }
  return { path: next };
}
