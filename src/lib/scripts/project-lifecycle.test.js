import { expect, test } from 'bun:test';
import { hashBrowserContent, restoreProjectScripts } from './project-lifecycle';

const daemonYaml = 'name: demo\nagents:\n  worker:\n    scheduler:\n      script: code\n';

test('returns ref YAML when manifest and contents match', async () => {
  const result = await restoreProjectScripts({
    projectId: 'p1',
    daemonYaml,
    api: {
      readManifest: async () => ({
        version: 1,
        projectId: 'p1',
        projectName: 'demo',
        updatedAt: '',
        references: [{ pointer: '/agents/worker/scheduler/script', path: 'demo/a.js', contentSha256: 'sha256:x' }],
      }),
      readFile: async () => ({ content: 'code', sha256: 'sha256:x' }),
    },
    hashContent: async () => 'sha256:x',
  });
  expect(result.yamlText).toContain('$ref:demo/a.js');
  expect(result.warnings).toEqual([]);
});

test('returns unchanged daemon YAML plus warning when the referenced file is absent', async () => {
  const result = await restoreProjectScripts({
    projectId: 'p1',
    daemonYaml,
    api: {
      readManifest: async () => ({
        version: 1,
        projectId: 'p1',
        projectName: 'demo',
        updatedAt: '',
        references: [{ pointer: '/agents/worker/scheduler/script', path: 'demo/missing.js', contentSha256: 'sha256:code' }],
      }),
      readFile: async () => {
        throw new Error('NOT_FOUND');
      },
    },
    hashContent: async () => 'sha256:code',
  });
  expect(result.yamlText).toContain('script: code');
  expect(result.warnings).toHaveLength(1);
  expect(result.warnings[0].path).toBe('demo/missing.js');
});

test('keeps daemon inline code when daemon hash no longer matches manifest', async () => {
  const result = await restoreProjectScripts({
    projectId: 'p1',
    daemonYaml,
    api: {
      readManifest: async () => ({
        version: 1,
        projectId: 'p1',
        projectName: 'demo',
        updatedAt: '',
        references: [{ pointer: '/agents/worker/scheduler/script', path: 'demo/a.js', contentSha256: 'sha256:original' }],
      }),
      readFile: async () => ({ content: 'code', sha256: 'sha256:original' }),
    },
    hashContent: async () => 'sha256:changed',
  });
  expect(result.yamlText).toContain('script: code');
  expect(result.warnings[0].path).toBe('demo/a.js');
});

test('returns daemon YAML unchanged when manifest is null', async () => {
  const result = await restoreProjectScripts({
    projectId: 'p1',
    daemonYaml,
    api: {
      readManifest: async () => null,
      readFile: async () => { throw new Error('should not read'); },
    },
    hashContent: async () => 'sha256:x',
  });
  expect(result.yamlText).toContain('script: code');
  expect(result.references).toEqual([]);
  expect(result.warnings).toEqual([]);
});

test('hashBrowserContent produces the sha256: hex format matching the backend', async () => {
  const hash = await hashBrowserContent('code');
  expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  const expected = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('code'));
  const hex = Array.from(new Uint8Array(expected)).map((b) => b.toString(16).padStart(2, '0')).join('');
  expect(hash).toBe(`sha256:${hex}`);
});

test('hashBrowserContent works when Web Crypto subtle is unavailable', async () => {
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} });
  try {
    expect(await hashBrowserContent('code')).toBe(
      'sha256:5694d08a2e53ffcae0c3103e5ad6f6076abd960eb1f8a56577040bc1028f702b',
    );
  } finally {
    if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
    else delete globalThis.crypto;
  }
});
