import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

describe('v2-only application boundary', () => {
  test('rpc exports all v2 services and no v1 clients', () => {
    const source = readFileSync('src/lib/rpc.ts', 'utf8');
    const expected = [
      'projectService', 'runService', 'execService', 'imageService', 'cacheService',
      'volumeService', 'sandboxService', 'dashboardService', 'settingsService',
      'capabilityService', 'runtimeProjectService',
    ];
    for (const name of expected) {
      expect(source).toContain(`export const ${name}`);
    }
    const registered = [...source.matchAll(/export const (\w+)\s*=\s*createClient\(/g)].map((match) => match[1]).sort();
    expect(registered).toEqual([...expected].sort());
    expect(source).not.toMatch(/agentcompose\/v1|health\/v1|SessionService|LoaderService|ConfigService|HealthService/);
  });

  test('business source never references agentcompose or health v1', () => {
    const offenders = files('src')
      .filter((path) => !path.includes('/gen/'))
      .filter((path) => !path.endsWith('.test.js') && !path.endsWith('.test.ts'))
      .filter((path) => /\.(svelte|ts|js)$/.test(path))
      .filter((path) => /(?:agentcompose|health)\/v1/.test(readFileSync(path, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
