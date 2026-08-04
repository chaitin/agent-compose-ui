import { describe, expect, test } from 'vitest';
import { CACHE_PRESETS } from './cache-presets';

describe('CACHE_PRESETS', () => {
  test('provides the approved cache target and suffix mappings', () => {
    expect(CACHE_PRESETS).toEqual({
      npm: { target: '/root/.npm', suffix: 'npm-cache' },
      pip: { target: '/root/.cache/pip', suffix: 'pip-cache' },
      tools: { target: '/root/.cache', suffix: 'tools-cache' },
    });
  });

  test('uses a unique suffix for every preset', () => {
    const suffixes = Object.values(CACHE_PRESETS).map(({ suffix }) => suffix);
    expect(new Set(suffixes).size).toBe(suffixes.length);
  });

  test('is deeply frozen at runtime', () => {
    expect(Object.isFrozen(CACHE_PRESETS)).toBe(true);
    expect(Object.values(CACHE_PRESETS).every(Object.isFrozen)).toBe(true);

    expect(Reflect.set(CACHE_PRESETS, 'npm', { target: '/changed', suffix: 'changed' })).toBe(false);
    expect(Reflect.set(CACHE_PRESETS, 'extra', { target: '/extra', suffix: 'extra' })).toBe(false);
    expect(Reflect.set(CACHE_PRESETS.npm, 'target', '/changed')).toBe(false);
    expect(CACHE_PRESETS).toEqual({
      npm: { target: '/root/.npm', suffix: 'npm-cache' },
      pip: { target: '/root/.cache/pip', suffix: 'pip-cache' },
      tools: { target: '/root/.cache', suffix: 'tools-cache' },
    });
  });
});
