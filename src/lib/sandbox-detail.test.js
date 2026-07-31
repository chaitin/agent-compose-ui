import { describe, expect, test } from 'bun:test';
import { ListSandboxHistoryResponse, ListSandboxRunEventsResponse, Sandbox, SandboxHistoryCell } from '../gen/agentcompose/v2/agentcompose_pb';
import { buildSandboxDetailSnapshot, buildSandboxTimeline } from './sandbox-detail';

describe('buildSandboxDetailSnapshot', () => {
  test('uses the direct sandbox record and history responses', () => {
    const snapshot = buildSandboxDetailSnapshot(
      new Sandbox({ sandboxId: 'sb-1', status: 'RUNNING' }),
      new ListSandboxHistoryResponse({ cells: [{ id: 'cell-1', source: 'pwd' }], events: [{ id: 'event-1', message: 'ready' }], legacyHistory: true }),
      new ListSandboxRunEventsResponse({ events: [{ id: 'run-event-1', text: 'agent response' }] }),
    );

    expect(snapshot.sandbox.sandboxId).toBe('sb-1');
    expect(snapshot.cells.map(cell => cell.id)).toEqual(['cell-1']);
    expect(snapshot.events.map(event => event.id)).toEqual(['event-1']);
    expect(snapshot.runEvents.map(event => event.id)).toEqual(['run-event-1']);
    expect(snapshot.legacyHistory).toBe(true);
  });

  test('merges cell, sandbox, and run evidence into chronological timeline rows', () => {
    const snapshot = buildSandboxDetailSnapshot(
      new Sandbox({ sandboxId: 'sb-1' }),
      new ListSandboxHistoryResponse({
        cells: [{ id: 'cell-1', source: 'pwd', stdout: '/work', success: true, createdAt: { seconds: 2n } }],
        events: [{ id: 'event-1', type: 'ready', message: 'ready', createdAt: { seconds: 1n } }],
      }),
      new ListSandboxRunEventsResponse({ events: [{ id: 'run-event-1', runId: 'run-1', text: 'answer', success: true, createdAt: { seconds: 3n } }] }),
    );

    expect(buildSandboxTimeline(snapshot).map(entry => [entry.kind, entry.content])).toEqual([
      ['sandbox', 'ready'],
      ['cell', '输入\npwd\n\n标准输出\n/work\n\n退出码 0'],
      ['run', 'answer'],
    ]);
  });
});

describe('buildSandboxTimeline', () => {
  function timelineFor(cell) {
    return buildSandboxTimeline({
      sandbox: new Sandbox({ sandboxId: 'sb-1' }),
      cells: [new SandboxHistoryCell(cell)],
      events: [],
      runEvents: [],
      legacyHistory: false,
    })[0];
  }

  test('hides duplicated stderr for a successful completed agent cell', () => {
    const entry = timelineFor({
      id: 'cell-1', source: '你好', stderr: '你好。', output: '你好。',
      success: true, exitCode: 0, stopReason: 'completed',
    });

    expect(entry.content).toBe('输入\n你好\n\n结果\n你好。\n\n退出码 0 · completed');
    expect(entry.level).toBe('info');
  });

  test('exposes input and result as separate timeline sections', () => {
    const entry = timelineFor({
      id: 'cell-1', source: 'prompt', output: 'answer',
      success: true, exitCode: 0, stopReason: 'completed',
    });

    expect(entry.sections).toEqual([
      { label: '输入', content: 'prompt', collapsible: true },
      { label: '结果', content: 'answer', collapsible: true },
      { label: '状态', content: '退出码 0 · completed', collapsible: false },
    ]);
  });

  test('labels distinct stderr from a successful agent cell as execution process', () => {
    const entry = timelineFor({
      id: 'cell-1', type: 'agent', stderr: 'agent tool trace', output: 'answer',
      success: true, exitCode: 0, stopReason: 'completed',
    });

    expect(entry.content).toContain('执行过程\nagent tool trace');
    expect(entry.content).not.toContain('标准错误');
    expect(entry.content).toContain('结果\nanswer');
    expect(entry.sections).toContainEqual({ label: '执行过程', content: 'agent tool trace', collapsible: true });
    expect(entry.level).toBe('info');
  });

  test('keeps stderr from a successful command cell as standard error', () => {
    const entry = timelineFor({
      id: 'cell-1', type: 'command', stderr: 'command warning', output: 'answer',
      success: true, exitCode: 0, stopReason: 'completed',
    });

    expect(entry.content).toContain('标准错误\ncommand warning');
    expect(entry.level).toBe('error');
  });

  test('keeps duplicated stderr for a failed cell', () => {
    const entry = timelineFor({
      id: 'cell-1', stderr: 'request failed', output: 'request failed',
      success: false, exitCode: 1,
    });

    expect(entry.content).toContain('标准错误\nrequest failed');
    expect(entry.content).toContain('结果\nrequest failed');
    expect(entry.level).toBe('error');
  });
});
