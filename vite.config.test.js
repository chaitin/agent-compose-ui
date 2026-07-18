import { readFileSync } from 'node:fs';
import { expect, test } from 'bun:test';

test('proxies Event HTTP APIs to the Agent Compose backend', () => {
  const source = readFileSync(new URL('./vite.config.ts', import.meta.url), 'utf8');

  expect(source).toMatch(/['"]\/api['"]\s*:\s*\{[\s\S]*?target:\s*['"]http:\/\/127\.0\.0\.1:7410['"]/);
});
