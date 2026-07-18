import { describe, expect, it } from 'vitest';
import {
  joinAgentRunTranscriptSegments,
  listAllRunEvents,
  mapRunEventsToTranscript,
  parseAgentRunTranscript,
} from './agent-run-transcript';
import {
  ListRunEventsResponse,
  RunEvent,
  RunEventKind,
} from '../gen/agentcompose/v2/agentcompose_pb';

describe('agent run transcript', () => {
  it('classifies known runtime markers without losing a single character', () => {
    const input = [
      '先分析问题\n',
      '$ bun test\npassed\n',
      '[tool:Read]\n{"path":"a.ts"}\n\n',
      '[mcp:server/search]\n{"q":"x"}\nresult\n',
      '[file_change]\nupdate: a.ts\n',
      '[todo]\n[x] inspect\n',
      '[web_search] agent compose\n',
      'ERROR: request failed\n',
    ].join('');

    const segments = parseAgentRunTranscript(input);

    expect(segments.map((segment) => segment.kind)).toEqual([
      'process', 'command', 'tool', 'tool', 'file', 'process', 'tool', 'diagnostic',
    ]);
    expect(joinAgentRunTranscriptSegments(segments)).toBe(input);
  });

  it('keeps unknown and provider-specific text as process output', () => {
    const input = 'Model metadata missing\nprovider-specific payload\n';
    expect(parseAgentRunTranscript(input)).toEqual([{ kind: 'process', label: '执行输出', content: input }]);
  });

  it('ends a tool block at its blank separator and keeps following assistant text visible', () => {
    const input = '[tool:Read]\n{"path":"a.ts"}\n\n这是最终回答\n';
    const segments = parseAgentRunTranscript(input);
    expect(segments).toEqual([
      { kind: 'tool', label: '工具 · Read', content: '[tool:Read]\n{"path":"a.ts"}\n\n' },
      { kind: 'process', label: '执行输出', content: '这是最终回答\n' },
    ]);
    expect(joinAgentRunTranscriptSegments(segments)).toBe(input);
  });
});

describe('structured run events', () => {
  it('loads every cursor page and preserves backend history availability', async () => {
    const requests: Array<{ runId: string; cursor: string; limit: number }> = [];
    const pages = [
      new ListRunEventsResponse({
        events: [new RunEvent({ id: 'event-2', seq: 2n })],
        nextCursor: 'page-2',
        historyAvailable: true,
      }),
      new ListRunEventsResponse({
        events: [new RunEvent({ id: 'event-1', seq: 1n })],
        historyAvailable: true,
      }),
    ];

    const result = await listAllRunEvents('run-1', async (request) => {
      requests.push({ runId: request.runId, cursor: request.cursor, limit: request.limit });
      return pages.shift()!;
    });

    expect(requests).toEqual([
      { runId: 'run-1', cursor: '', limit: 100 },
      { runId: 'run-1', cursor: 'page-2', limit: 100 },
    ]);
    expect(result.historyAvailable).toBe(true);
    expect(result.events.map((event) => event.id)).toEqual(['event-1', 'event-2']);
  });

  it('maps event labels and structured command, agent, and stop evidence directly', () => {
    const entries = mapRunEventsToTranscript([
      new RunEvent({ id: 'status', seq: 4n, kind: RunEventKind.STATUS, success: false, exitCode: 17, stopReason: 'timeout' }),
      new RunEvent({ id: 'agent', seq: 3n, kind: RunEventKind.AGENT_MESSAGE, agent: 'reviewer', text: 'final answer' }),
      new RunEvent({ id: 'command', seq: 2n, kind: RunEventKind.AGENT_ACTIVITY, name: 'command', payloadJson: '{"command":"bun test"}', success: true, exitCode: 0 }),
      new RunEvent({ id: 'user', seq: 1n, kind: RunEventKind.USER_MESSAGE, text: 'ship it' }),
    ]);

    expect(entries.map((entry) => entry.label)).toEqual(['用户消息', '命令执行', '智能体消息 · reviewer', '运行状态']);
    expect(entries[1].content).toContain('{"command":"bun test"}');
    expect(entries[1].content).toContain('成功 · 退出码 0');
    expect(entries[2].content).toBe('final answer');
    expect(entries[3].content).toContain('失败 · 退出码 17');
    expect(entries[3].content).toContain('停止原因：timeout');
  });

  it('sorts equal-timestamp structured events by sequence', () => {
    const entries = mapRunEventsToTranscript([
      new RunEvent({ id: 'second', seq: 2n, text: 'second' }),
      new RunEvent({ id: 'first', seq: 1n, text: 'first' }),
    ]);
    expect(entries.map((entry) => entry.content)).toEqual(['first', 'second']);
  });

  it('reports unavailable history so callers can explicitly use inferred log fallback', async () => {
    const result = await listAllRunEvents('legacy-run', async () => new ListRunEventsResponse({ historyAvailable: false }));
    expect(result).toEqual({ events: [], historyAvailable: false });
  });

  it('reports incomplete history when any fetched page marks history unavailable', async () => {
    const pages = [
      new ListRunEventsResponse({ nextCursor: 'page-2', historyAvailable: true }),
      new ListRunEventsResponse({ historyAvailable: false }),
    ];

    const result = await listAllRunEvents('partially-retained-run', async () => pages.shift()!);

    expect(result.historyAvailable).toBe(false);
  });

  it('stops on a repeated cursor while preserving incomplete-history evidence', async () => {
    const cursors: string[] = [];
    const pages = [
      new ListRunEventsResponse({ nextCursor: 'page-2', historyAvailable: true }),
      new ListRunEventsResponse({ nextCursor: 'page-2', historyAvailable: false }),
    ];

    const result = await listAllRunEvents('looping-run', async (request) => {
      cursors.push(request.cursor);
      return pages.shift()!;
    });

    expect(cursors).toEqual(['', 'page-2']);
    expect(result.historyAvailable).toBe(false);
  });
});
