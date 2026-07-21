import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('RPC abort signal lifecycle', () => {
  test('uses the shared fetch transport for every RPC client', () => {
    const source = readFileSync('src/lib/rpc.ts', 'utf8');

    expect(source).toContain("import { transportFetch } from './rpc-fetch'");
    expect(source).not.toContain('function transportFetch(');
  });

  test('keeps runtime project reads on the binary transport', () => {
    const source = readFileSync('src/lib/rpc.ts', 'utf8');

    expect(source).toMatch(/const runtimeProjectTransport[\s\S]*useBinaryFormat:\s*true/);
    expect(source).toMatch(/export const runtimeProjectService = createClient\(ProjectService, runtimeProjectTransport\)/);
  });
});
