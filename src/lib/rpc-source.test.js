import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('RPC abort signal lifecycle', () => {
  test('removes the source abort listener when a request settles', () => {
    const source = readFileSync('src/lib/rpc.ts', 'utf8');

    expect(source).toContain("sourceSignal.removeEventListener('abort', sourceAbortListener)");
    expect(source).toMatch(/\.finally\(\(\) => \{[\s\S]*clearTimeout\(timeout\)[\s\S]*removeEventListener/);
  });
});
