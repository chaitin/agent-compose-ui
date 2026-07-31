import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { invalidPath, ServiceError } from './errors.mjs';

function pathSegments(relativePath) {
  if (
    typeof relativePath !== 'string' ||
    !relativePath ||
    relativePath.includes('\\') ||
    relativePath.includes('\0')
  ) {
    throw invalidPath();
  }

  let decoded;
  try {
    decoded = decodeURIComponent(relativePath);
  } catch {
    throw invalidPath();
  }

  if (decoded !== relativePath || path.posix.isAbsolute(decoded)) {
    throw invalidPath();
  }

  const parts = decoded.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part === '.metadata')) {
    throw invalidPath();
  }
  return parts;
}

async function rejectSymlinks(rootPath, parts, includeLeaf) {
  let current = rootPath;
  const limit = includeLeaf ? parts.length : Math.max(0, parts.length - 1);

  for (let index = 0; index < limit; index += 1) {
    current = path.join(current, parts[index]);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw invalidPath('不允许访问符号链接');
      }
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return;
      }
      throw error;
    }
  }
}

async function resolveUnderRoot(root, relativePath, options = {}) {
  const parts = pathSegments(relativePath);
  const rootPath = await realpath(root);
  const target = path.join(rootPath, ...parts);
  const relativeTarget = path.relative(rootPath, target);

  if (!relativeTarget || relativeTarget === '..' || relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget)) {
    throw invalidPath();
  }

  const mustExist = options?.mustExist !== false;
  await rejectSymlinks(rootPath, parts, mustExist);

  if (mustExist) {
    try {
      await lstat(target);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new ServiceError(404, 'NOT_FOUND', '目标不存在');
      }
      throw error;
    }
  }

  return target;
}

export async function resolveScriptPath(root, relativePath, options = {}) {
  const parts = pathSegments(relativePath);
  if (!parts.at(-1).endsWith('.js')) {
    throw invalidPath('仅允许 .js 文件');
  }
  return resolveUnderRoot(root, relativePath, options);
}

export async function resolveDirectoryPath(root, relativePath, options = {}) {
  return resolveUnderRoot(root, relativePath, options);
}

export function validateProjectDirectoryName(name) {
  const value = String(name ?? '').trim();
  if (
    !value ||
    value === '.' ||
    value === '..' ||
    value === '.metadata' ||
    /[\\/\0-\x1f]/.test(value)
  ) {
    throw invalidPath('项目名称不能用作目录名');
  }
  return value;
}
