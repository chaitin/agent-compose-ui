import { expect, test } from 'bun:test';
import {
  appendLiveRunLogChunk,
  beginRunLogLoad,
  initialRunLogWindow,
  nextRunLogScope,
  replaceRunLogWindow,
} from './run-log-window';

const chunk = (data, offset, sequence = 0) => ({ data, offset, sequence, createdAt: '2026-07-15T01:00:00Z' });
const stateWith = (chunks) => ({ ...initialRunLogWindow(), chunks: chunks.map((item, index) => chunk(item.data, item.offset, index)) });

test('advances from 100 to 500 to all and only all is complete', () => {
  expect(initialRunLogWindow()).toMatchObject({ scope: 'tail-100', tailLines: 100, fullyLoaded: false });
  expect(nextRunLogScope('tail-100')).toBe('tail-500');
  expect(nextRunLogScope('tail-500')).toBe('all');
  expect(nextRunLogScope('all')).toBe('all');
  expect(replaceRunLogWindow(initialRunLogWindow(), 'tail-500', [])).toMatchObject({ tailLines: 500, fullyLoaded: false });
  expect(replaceRunLogWindow(initialRunLogWindow(), 'all', [])).toMatchObject({ tailLines: 0, fullyLoaded: true });
});

test('replaces overlapping windows instead of appending duplicates', () => {
  const current = stateWith([{ data: 'new', offset: 20n }]);
  const replaced = replaceRunLogWindow(current, 'tail-500', [
    { data: 'old', offset: 10n },
    { data: 'new', offset: 20n },
  ]);
  expect(replaced.chunks.map((chunk) => chunk.data)).toEqual(['old', 'new']);
  expect(replaced.fullyLoaded).toBe(false);
});

test('keeps live chunks that arrive while a wider window is loading', () => {
  const loading = beginRunLogLoad(stateWith([{ data: 'base', offset: 10n }]), 'tail-500');
  const withLive = appendLiveRunLogChunk(loading, { data: 'live', offset: 30n });
  const completed = replaceRunLogWindow(withLive, 'tail-500', [
    { data: 'older', offset: 0n },
    { data: 'base', offset: 10n },
  ]);
  expect(completed.chunks.map((chunk) => chunk.data)).toEqual(['older', 'base', 'live']);
});

test('beginning a replacement load preserves pending live chunks', () => {
  const loading = beginRunLogLoad(stateWith([]), 'tail-500');
  const withLive = appendLiveRunLogChunk(loading, { data: 'live', offset: 30n });
  const restarted = beginRunLogLoad(withLive, 'all');
  expect(restarted.pendingLiveChunks.map((item) => item.data)).toEqual(['live']);
});

test('keeps identical text at distinct offsets', () => {
  const replaced = replaceRunLogWindow(initialRunLogWindow(), 'all', [
    { data: 'same', offset: 10n },
    { data: 'same', offset: 20n },
  ]);
  expect(replaced.chunks.map((item) => [item.data, item.offset])).toEqual([['same', 10n], ['same', 20n]]);
});
