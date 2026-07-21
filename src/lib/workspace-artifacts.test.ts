import { Code, ConnectError } from '@connectrpc/connect';
import { describe, expect, test, vi } from 'vitest';
import { ExecResult, ExecStreamEventType, ExecStreamResponse, StdioStream } from '../gen/agentcompose/v2/agentcompose_pb';
import {
  parseWorkspaceArtifactRecords,
  discoverWorkspaceArtifacts,
  MAX_WORKSPACE_ARTIFACT_FILES,
  WORKSPACE_ARTIFACT_OUTPUT_BYTES,
} from './workspace-artifacts';

describe('parseWorkspaceArtifactRecords', () => {
  test('keeps only files modified inside the inclusive Run window', () => {
    const raw = [
      '1784604600.0000000000\t/workspace/before.md\0',
      '1784604637.2570000000\t/workspace/with space.md\0',
      '1784604690.0000000000\t/workspace/line\nbreak.md\0',
      '1784604751.3040000000\t/workspace/final.md\0',
      '1784604800.0000000000\t/workspace/after.md\0',
    ].join('');
    expect(parseWorkspaceArtifactRecords(raw, {
      startedAt: '2026-07-21T03:30:37.257Z',
      endedAt: '2026-07-21T03:32:31.304Z',
      limit: 5000,
    }).files.map(file => file.path)).toEqual([
      '/workspace/with space.md',
      '/workspace/line\nbreak.md',
      '/workspace/final.md',
    ]);
  });

  test('deduplicates paths by their final record and sorts equal mtimes by path', () => {
    const raw = [
      '1784604640\t/workspace/z.md\0',
      '1784604640\t/workspace/a.md\0',
      '1784604641\t/workspace/z.md\0',
    ].join('');
    const result = parseWorkspaceArtifactRecords(raw, {
      startedAt: '2026-07-21T03:30:37Z',
      endedAt: '2026-07-21T03:32:31Z',
      limit: 5000,
    });
    expect(result.files.map(file => [file.path, file.modifiedAt])).toEqual([
      ['/workspace/a.md', '2026-07-21T03:30:40.000Z'],
      ['/workspace/z.md', '2026-07-21T03:30:41.000Z'],
    ]);
  });
});

describe('discoverWorkspaceArtifacts', () => {
  test('scans a running Sandbox with bounded direct find execution', async () => {
    const requests: any[] = [];
    const result = await discoverWorkspaceArtifacts({
      sandboxId: 'sandbox-1',
      startedAt: '2026-07-21T03:30:37Z',
      completedAt: '2026-07-21T03:32:31Z',
      now: () => new Date('2026-07-21T03:40:00Z'),
      getSandbox: async () => ({ sandbox: { status: 'RUNNING' } }),
      execStream: async function* (request) {
        requests.push(request);
        yield new ExecStreamResponse({ eventType: ExecStreamEventType.OUTPUT, stream: StdioStream.STDOUT, chunk: '1784604640\t/workspace/report.md\0' });
      },
    });
    expect(result.status).toBe('ready');
    expect(result.files.map(file => file.path)).toEqual(['/workspace/report.md']);
    expect(requests[0]).toMatchObject({
      target: { case: 'sandboxId', value: 'sandbox-1' },
      cwd: '/workspace',
      maxOutputBytes: WORKSPACE_ARTIFACT_OUTPUT_BYTES,
      timeoutMs: 30_000,
      command: {
        command: '/usr/bin/find',
        args: ['/workspace', '-type', 'f', '-printf', '%T@\\t%p\\0'],
      },
    });
  });

  test('does not resume or exec a stopped Sandbox', async () => {
    const execStream = vi.fn();
    const result = await discoverWorkspaceArtifacts({
      sandboxId: 'sandbox-1', startedAt: '2026-07-21T03:30:37Z', completedAt: '', now: () => new Date(),
      getSandbox: async () => ({ sandbox: { status: 'STOPPED' } }), execStream,
    });
    expect(result).toMatchObject({ status: 'stopped', files: [] });
    expect(execStream).not.toHaveBeenCalled();
  });

  test('maps GetSandbox NotFound to removed', async () => {
    const execStream = vi.fn();
    const result = await discoverWorkspaceArtifacts({
      sandboxId: 'sandbox-gone', startedAt: '2026-07-21T03:30:37Z', completedAt: '', now: () => new Date(),
      getSandbox: async () => { throw new ConnectError('gone', Code.NotFound); }, execStream,
    });
    expect(result).toMatchObject({ status: 'removed', files: [] });
    expect(execStream).not.toHaveBeenCalled();
  });

  test('maps stderr and a terminal result error to error', async () => {
    for (const event of [
      new ExecStreamResponse({ eventType: ExecStreamEventType.OUTPUT, stream: StdioStream.STDERR, chunk: 'find failed' }),
      new ExecStreamResponse({ eventType: ExecStreamEventType.COMPLETED, result: new ExecResult({ error: 'find failed' }) }),
    ]) {
      const result = await discoverWorkspaceArtifacts({
        sandboxId: 'sandbox-1', startedAt: '2026-07-21T03:30:37Z', completedAt: '', now: () => new Date('2026-07-21T03:32:31Z'),
        getSandbox: async () => ({ sandbox: { status: 'RUNNING' } }),
        execStream: async function* () { yield event; },
      });
      expect(result).toMatchObject({ status: 'error', files: [] });
    }
  });

  test('uses now as the inclusive upper bound while a Run is in progress', async () => {
    const result = await discoverWorkspaceArtifacts({
      sandboxId: 'sandbox-1', startedAt: '2026-07-21T03:30:37Z', completedAt: '', now: () => new Date('2026-07-21T03:30:40Z'),
      getSandbox: async () => ({ sandbox: { status: 'RUNNING' } }),
      execStream: async function* () {
        yield new ExecStreamResponse({ eventType: ExecStreamEventType.OUTPUT, stream: StdioStream.STDOUT, chunk: '1784604640\t/workspace/at-now.md\0' });
      },
    });
    expect(result.files.map(file => file.path)).toEqual(['/workspace/at-now.md']);
  });

  test('bounds output bytes and returned file count', async () => {
    const records = Array.from({ length: MAX_WORKSPACE_ARTIFACT_FILES + 1 }, (_, index) =>
      `1784604640\t/workspace/${String(index).padStart(4, '0')}.md\0`).join('');
    const oversized = records + 'x'.repeat(WORKSPACE_ARTIFACT_OUTPUT_BYTES);
    const result = await discoverWorkspaceArtifacts({
      sandboxId: 'sandbox-1', startedAt: '2026-07-21T03:30:37Z', completedAt: '2026-07-21T03:32:31Z', now: () => new Date(),
      getSandbox: async () => ({ sandbox: { status: 'RUNNING' } }),
      execStream: async function* () {
        yield new ExecStreamResponse({ eventType: ExecStreamEventType.OUTPUT, stream: StdioStream.STDOUT, chunk: oversized });
      },
    });
    expect(result).toMatchObject({ status: 'ready', truncated: true });
    expect(result.files).toHaveLength(MAX_WORKSPACE_ARTIFACT_FILES);
  });

  test('passes the caller signal to both RPCs', async () => {
    const signal = new AbortController().signal;
    const options: unknown[] = [];
    await discoverWorkspaceArtifacts({
      sandboxId: 'sandbox-1', startedAt: '2026-07-21T03:30:37Z', completedAt: '', now: () => new Date('2026-07-21T03:32:31Z'), signal,
      getSandbox: async (_request, callOptions) => { options.push(callOptions); return { sandbox: { status: 'RUNNING' } }; },
      execStream: async function* (_request, callOptions) { options.push(callOptions); },
    });
    expect(options).toEqual([{ signal }, { signal }]);
  });

  test('rejects an invalid time window before calling RPCs', async () => {
    const getSandbox = vi.fn();
    const execStream = vi.fn();
    const result = await discoverWorkspaceArtifacts({
      sandboxId: 'sandbox-1', startedAt: 'invalid', completedAt: '', now: () => new Date(), getSandbox, execStream,
    });
    expect(result).toMatchObject({ status: 'invalid-time', files: [] });
    expect(getSandbox).not.toHaveBeenCalled();
    expect(execStream).not.toHaveBeenCalled();
  });
});
