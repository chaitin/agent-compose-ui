import { sha256 } from '../sha256';

const DAEMON_VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
const RESERVED_PROJECT_VOLUME_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'toString']);
const SAFE_LOGICAL_NAME = /^[a-z0-9](?:[a-z0-9_.-]*[a-z0-9])?$/u;
const MAX_LOGICAL_NAME_LENGTH = 200;

// Bound hashing input by encoded size while leaving ample room for normal
// workspace IDs and human-readable Unicode project keys.
export const MAX_PROJECT_KEY_UTF8_BYTES = 1024;

export function assertProjectVolumeKey(key: string): void {
  if (!DAEMON_VOLUME_NAME.test(key) || key.length > 255 || RESERVED_PROJECT_VOLUME_KEYS.has(key)) {
    throw new Error('卷声明键不是安全的卷名称');
  }
}

function encodeProjectKey(projectKey: string): ArrayBuffer {
  if (projectKey.length === 0 || projectKey.trim() !== projectKey || /[\u0000-\u001f\u007f]/u.test(projectKey)) {
    throw new Error('projectKey 必须是非空且不包含控制字符的字符串');
  }
  const encoded = new TextEncoder().encode(projectKey);
  if (encoded.length > MAX_PROJECT_KEY_UTF8_BYTES) {
    throw new Error(`projectKey 的 UTF-8 编码不能超过 ${MAX_PROJECT_KEY_UTF8_BYTES} 字节`);
  }
  const buffer = new ArrayBuffer(encoded.length);
  new Uint8Array(buffer).set(encoded);
  return buffer;
}

function normalizeLogicalName(logicalName: string): string {
  if (/ {2,}/u.test(logicalName)) throw new Error('logicalName 不能包含连续空格');
  const normalized = logicalName.trim().toLowerCase().replace(/[ ]+/gu, '-');
  if (!DAEMON_VOLUME_NAME.test(normalized)
    || !SAFE_LOGICAL_NAME.test(normalized)
    || normalized.length > MAX_LOGICAL_NAME_LENGTH) {
    throw new Error('logicalName 不是安全的卷名称');
  }
  return normalized;
}

export async function managedVolumeName(projectKey: string, logicalName: string): Promise<string> {
  const encodedProjectKey = encodeProjectKey(projectKey);
  const safeLogicalName = normalizeLogicalName(logicalName);
  const digest = await sha256(new Uint8Array(encodedProjectKey));
  const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 12);
  return `ac-${hash}-${safeLogicalName}`;
}
