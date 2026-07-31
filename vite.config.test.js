import { readFileSync } from 'node:fs';
import { expect, test } from 'bun:test';

test('proxies Event HTTP APIs through the authentication gateway', () => {
  const source = readFileSync(new URL('./vite.config.ts', import.meta.url), 'utf8');

  expect(source).toMatch(/['"]\^\/api\/['"]\s*:\s*\{[\s\S]*?target:\s*['"]http:\/\/127\.0\.0\.1:8080['"]/);
});

test('proxies token management without rewriting the same-origin Host', () => {
  const source = readFileSync(new URL('./vite.config.ts', import.meta.url), 'utf8');

  expect(source).toMatch(/['"]\^\/ui-api\/['"]\s*:\s*\{[\s\S]*?target:\s*['"]http:\/\/127\.0\.0\.1:8080['"][\s\S]*?changeOrigin:\s*false/);
});
