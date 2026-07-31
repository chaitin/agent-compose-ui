import { describe, expect, test } from 'bun:test';
import { buildRuntimeTimeline } from './runtime-timeline';

const summary = {
  startedAt: '2026-07-13T14:32:45.000Z',
  completedAt: '2026-07-13T14:32:58.000Z',
  createdAt: '2026-07-13T14:32:44.000Z',
  updatedAt: '2026-07-13T14:32:59.000Z',
};

function completeOptions(overrides = {}) {
  return {
    summary: { ...summary, exitCode: 0, error: '', schedulerId: '', triggerId: '', sandboxId: '' },
    sourceText: '手动运行',
    statusText: '成功',
    terminal: true,
    actualPrompt: 'prompt',
    output: '',
    resultJson: '',
    warnings: [],
    cleanupError: '',
    logError: '',
    logChunks: [],
    ...overrides,
  };
}

describe('buildRuntimeTimeline', () => {
  test('projects every available run field without hiding or deduplicating content', () => {
    const entries = buildRuntimeTimeline({
      summary: {
        startedAt: '2026-07-15T01:00:00Z',
        completedAt: '2026-07-15T01:01:00Z',
        updatedAt: '2026-07-15T01:01:01Z',
        exitCode: 9,
        error: 'agent failed\nstack line',
        schedulerId: 'scheduler-1',
        triggerId: 'nightly',
        sandboxId: 'sandbox-1',
      },
      sourceText: '调度器运行',
      statusText: '失败',
      terminal: true,
      actualPrompt: 'same',
      output: 'same',
      resultJson: 'same',
      warnings: ['same', 'warning-2'],
      cleanupError: 'cleanup failed',
      logError: 'rpc failed\ntransport detail',
      logChunks: [{ data: 'same', createdAt: '2026-07-15T01:00:30Z', sequence: 0, offset: 4n }],
    });

    expect(entries.filter((entry) => entry.content.includes('same'))).toHaveLength(5);
    expect(entries.map((entry) => entry.kind)).toEqual(expect.arrayContaining([
      'run', 'prompt', 'scheduler', 'sandbox', 'process', 'output', 'result', 'warning', 'error',
    ]));
    expect(entries.filter((entry) => entry.kind === 'error').map((entry) => entry.content)).toEqual(
      expect.arrayContaining(['agent failed\nstack line', 'cleanup failed', 'rpc failed\ntransport detail']),
    );
    expect(entries.some((entry) => entry.content === '退出码 9')).toBe(true);
    expect(entries.find((entry) => entry.kind === 'process')).toMatchObject({
      source: '执行输出',
      level: 'info',
      offset: 4n,
      timestampInferred: false,
    });
    expect(entries.find((entry) => entry.source === 'scheduler')).toMatchObject({ content: 'scheduler-1', kind: 'scheduler' });
    expect(entries.find((entry) => entry.source === 'trigger')).toMatchObject({ content: 'nightly', kind: 'scheduler' });
  });

  test('marks inferred timestamps and preserves receive order for equal timestamps', () => {
    const entries = buildRuntimeTimeline(completeOptions({
      logChunks: [
        { data: 'first', createdAt: summary.completedAt, sequence: 7, offset: 10n },
        { data: 'second', createdAt: summary.completedAt, sequence: 8, offset: 20n },
      ],
    }));

    expect(entries.find((entry) => entry.kind === 'prompt')).toMatchObject({
      timestampInferred: true,
      timestampBasis: 'run-start',
    });
    expect(entries.filter((entry) => entry.kind === 'process').map((entry) => entry.content))
      .toEqual(['first', 'second']);
  });

  test('uses updatedAt as the inferred terminal timestamp for unfinished runs', () => {
    const entries = buildRuntimeTimeline(completeOptions({
      summary: { ...summary, completedAt: '', exitCode: undefined },
      output: 'partial output',
      warnings: ['still running'],
    }));

    expect(entries.find((entry) => entry.kind === 'output')).toMatchObject({
      timestamp: summary.updatedAt,
      timestampInferred: true,
      timestampBasis: 'run-updated',
    });
    expect(entries.find((entry) => entry.kind === 'warning')).toMatchObject({
      timestamp: summary.updatedAt,
      timestampBasis: 'run-updated',
      level: 'warning',
    });
    expect(entries.some((entry) => entry.content.startsWith('运行结束'))).toBe(false);
  });

  test('omits protobuf-default exit code evidence for nonterminal runs', () => {
    const entries = buildRuntimeTimeline(completeOptions({
      terminal: false,
      summary: { ...summary, completedAt: '', exitCode: 0 },
    }));
    expect(entries.some((entry) => entry.content.startsWith('退出码'))).toBe(false);
  });

  test('marks a run start inferred when startedAt falls back to createdAt', () => {
    const entries = buildRuntimeTimeline(completeOptions({
      summary: { ...summary, startedAt: '', exitCode: 0 },
    }));
    expect(entries.find((entry) => entry.content.startsWith('运行开始'))).toMatchObject({
      timestamp: summary.createdAt,
      timestampInferred: true,
      timestampBasis: 'run-start',
    });
  });

  test('adds overlapping artifact tags without removing existing filter meanings', () => {
    const entries = buildRuntimeTimeline(completeOptions({
      output: 'final answer',
      resultJson: '{"ok":true}',
      logChunks: [{ data: 'runtime response', createdAt: summary.completedAt, sequence: 1 }],
      summary: { ...summary, exitCode: 1, error: 'failed' },
    }));

    expect(entries.find((entry) => entry.kind === 'output').filterTags).toEqual(expect.arrayContaining(['message', 'artifact']));
    expect(entries.find((entry) => entry.kind === 'result').filterTags).toEqual(['artifact']);
    expect(entries.find((entry) => entry.content === 'runtime response').filterTags).toContain('artifact');
    expect(entries.find((entry) => entry.content === 'failed').filterTags).toEqual(expect.arrayContaining(['run', 'problem']));
  });
});
