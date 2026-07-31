import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, rename, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { ServiceError } from './errors.mjs';
import { resolveDirectoryPath, resolveScriptPath } from './paths.mjs';

export const sha256 = (content) => `sha256:${createHash('sha256').update(content).digest('hex')}`;

export function createStorage(root, { maxFileBytes }) {
  async function readScript(relativePath) {
    const absolute = await resolveScriptPath(root, relativePath);
    const info = await lstat(absolute);
    if (!info.isFile()) throw new ServiceError(400, 'INVALID_PATH', '目标不是普通文件');
    if (info.size > maxFileBytes) throw new ServiceError(413, 'PAYLOAD_TOO_LARGE', '脚本文件过大');
    const content = await readFile(absolute, 'utf8');
    return {
      path: relativePath,
      content,
      size: Buffer.byteLength(content),
      mtimeMs: info.mtimeMs,
      sha256: sha256(content),
    };
  }

  async function walk(absolute, relative = '') {
    const entries = await readdir(absolute, { withFileTypes: true });
    const children = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.metadata' || entry.isSymbolicLink()) continue;
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        children.push({
          name: entry.name,
          path: childRelative,
          kind: 'directory',
          children: (await walk(path.join(absolute, entry.name), childRelative)).children,
        });
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        const value = await readScript(childRelative);
        children.push({
          name: entry.name,
          path: childRelative,
          kind: 'file',
          size: value.size,
          mtimeMs: value.mtimeMs,
          sha256: value.sha256,
        });
      }
    }
    return { name: '', path: relative, kind: 'directory', children };
  }

  async function writeAtomic(target, content) {
    const temporary = `${target}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  return {
    listTree: () => walk(root),
    readFile: readScript,
    async createFolder(relativePath) {
      const absolute = await resolveDirectoryPath(root, relativePath, { mustExist: false });
      try {
        const created = await mkdir(absolute, { recursive: true });
        if (created === undefined) throw new ServiceError(409, 'ALREADY_EXISTS', '目录已存在');
      } catch (error) {
        if (error instanceof ServiceError) throw error;
        if (error?.code === 'EEXIST') throw new ServiceError(409, 'ALREADY_EXISTS', '目录已存在');
        throw error;
      }
      return { path: relativePath };
    },
    async writeFile({ path: relativePath, content, expectedSha256 }) {
      if (typeof content !== 'string' || Buffer.byteLength(content) > maxFileBytes) {
        throw new ServiceError(413, 'PAYLOAD_TOO_LARGE', '脚本文件过大');
      }
      const absolute = await resolveScriptPath(root, relativePath, { mustExist: false });
      let current = null;
      try {
        current = await readScript(relativePath);
      } catch (error) {
        if (error?.code !== 'NOT_FOUND') throw error;
      }
      if (current && expectedSha256 !== current.sha256) {
        throw new ServiceError(409, 'CONTENT_CONFLICT', '磁盘脚本已变化', { currentSha256: current.sha256 });
      }
      if (!current && expectedSha256) {
        throw new ServiceError(409, 'CONTENT_CONFLICT', '脚本已被删除');
      }
      await writeAtomic(absolute, content);
      return readScript(relativePath);
    },
    async deleteFile(relativePath, expectedSha256) {
      const current = await readScript(relativePath);
      if (expectedSha256 && current.sha256 !== expectedSha256) {
        throw new ServiceError(409, 'CONTENT_CONFLICT', '磁盘脚本已变化');
      }
      await rm(await resolveScriptPath(root, relativePath));
      return { deleted: true, path: relativePath };
    },
    async deleteFolder(relativePath, recursive) {
      const absolute = await resolveDirectoryPath(root, relativePath);
      if (recursive) {
        await rm(absolute, { recursive: true });
      } else {
        try {
          await rmdir(absolute);
        } catch (error) {
          if (error?.code === 'ENOTEMPTY') throw new ServiceError(409, 'DIRECTORY_NOT_EMPTY', '目录不为空');
          throw error;
        }
      }
      return { deleted: true, path: relativePath };
    },
  };
}
