import { describe, expect, test } from 'vitest';
import { assertProjectVolumeKey, MAX_PROJECT_KEY_UTF8_BYTES, managedVolumeName } from './volume-names';

describe('assertProjectVolumeKey', () => {
  test.each(['cache', 'Cache_2', 'a.b-c'])('accepts daemon-compatible key %j', (key) => {
    expect(() => assertProjectVolumeKey(key)).not.toThrow();
  });

  test.each(['', ' has-space', 'has/slash', '__proto__', 'prototype', 'constructor', 'toString', 'a'.repeat(256)])
    ('rejects unsafe key %j', (key) => {
      expect(() => assertProjectVolumeKey(key)).toThrow('卷声明键不是安全的卷名称');
    });
});

describe('managedVolumeName', () => {
  const projectKey = 'ws_0123456789abcdef0123456789abcdef';

  test('creates a deterministic project-isolated daemon-compatible name', async () => {
    const first = await managedVolumeName(projectKey, 'project-memory');
    const second = await managedVolumeName(projectKey, 'project-memory');

    expect(first).toMatch(/^ac-[a-f0-9]{12}-project-memory$/);
    expect(second).toBe(first);
    expect(await managedVolumeName('ws_fedcba9876543210fedcba9876543210', 'project-memory')).not.toBe(first);
  });

  test.each([
    ['ws_0123456789abcdef0123456789abcdef', 'ac-b84f28823e85-project-memory'],
    ['项目-上海', 'ac-8c099eb7d8f9-project-memory'],
  ])('uses the first 12 lowercase hex characters of the UTF-8 SHA-256 digest for %s', async (key, expected) => {
    expect(await managedVolumeName(key, 'project-memory')).toBe(expected);
  });

  test('normalizes safe logical names conservatively', async () => {
    expect(await managedVolumeName(projectKey, ' Project Memory_v2 '))
      .toMatch(/^ac-[a-f0-9]{12}-project-memory_v2$/);
  });

  test('accepts the 200-character logical-name boundary and produces a bounded final name', async () => {
    const result = await managedVolumeName(projectKey, 'a'.repeat(200));

    expect(result).toBe(`ac-b84f28823e85-${'a'.repeat(200)}`);
    expect(result).toHaveLength(216);
  });

  test('rejects logical names beyond 200 characters', async () => {
    await expect(managedVolumeName(projectKey, 'a'.repeat(201))).rejects.toThrow();
  });

  test.each(['', ' ', 'two  spaces', 'two\twords', '.memory', '-memory', 'memory.'])
    ('rejects empty, repeated-whitespace, tab, or edge-punctuation logical name %j', async (logicalName) => {
      await expect(managedVolumeName(projectKey, logicalName)).rejects.toThrow();
    });

  test('accepts a project key at the UTF-8 byte boundary, including Unicode', async () => {
    const key = `${'界'.repeat(341)}a`;
    expect(new TextEncoder().encode(key)).toHaveLength(MAX_PROJECT_KEY_UTF8_BYTES);
    await expect(managedVolumeName(key, 'memory')).resolves.toMatch(/^ac-[a-f0-9]{12}-memory$/);
  });

  test('rejects a project key beyond the UTF-8 byte boundary', async () => {
    const key = `${'界'.repeat(341)}aa`;
    expect(new TextEncoder().encode(key)).toHaveLength(MAX_PROJECT_KEY_UTF8_BYTES + 1);
    await expect(managedVolumeName(key, 'memory')).rejects.toThrow();
  });

  test.each([
    ['', 'memory'],
    ['   ', 'memory'],
    ['contains\nnewline', 'memory'],
    [projectKey, ''],
    [projectKey, '../memory'],
    [projectKey, '记忆'],
  ])('rejects unsafe inputs (%j, %j)', async (key, logicalName) => {
    await expect(managedVolumeName(key, logicalName)).rejects.toThrow();
  });
});
