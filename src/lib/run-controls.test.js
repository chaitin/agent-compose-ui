import { describe, expect, test } from 'bun:test';
import { RunSandboxCleanupPolicy } from '../gen/agentcompose/v2/agentcompose_pb';
import {
  buildFollowRunLogsRequest,
  buildRunAgentRequest,
  buildStopRunRequest,
} from './run-controls';

describe('buildRunAgentRequest', () => {
  test('builds a command run with temporary overrides', () => {
    const request = buildRunAgentRequest({
      projectId: 'project-1', agentName: '审查员', mode: 'command', input: 'bun test',
      sandboxId: 'sandbox-1', driver: 'docker', cleanupPolicy: RunSandboxCleanupPolicy.KEEP_RUNNING,
      jupyterEnabled: true, jupyterExpose: true,
    });
    expect(request.prompt).toBe('');
    expect(request.command).toBe('bun test');
    expect(request.sandboxId).toBe('sandbox-1');
    expect(request.driver).toBe('docker');
    expect(request.cleanupPolicy).toBe(RunSandboxCleanupPolicy.KEEP_RUNNING);
  });

  test('rejects empty run input', () => {
    expect(() => buildRunAgentRequest({
      projectId: 'project-1', agentName: '审查员', mode: 'prompt', input: ' ',
      sandboxId: '', driver: '', cleanupPolicy: RunSandboxCleanupPolicy.UNSPECIFIED,
      jupyterEnabled: false, jupyterExpose: false,
    })).toThrow('请输入本次运行内容');
  });

  test('keeps prompt and command mutually exclusive', () => {
    const request = buildRunAgentRequest({
      projectId: 'project-1', agentName: ' writer ', mode: 'prompt', input: ' write it ',
      sandboxId: '', driver: '', cleanupPolicy: RunSandboxCleanupPolicy.UNSPECIFIED,
      jupyterEnabled: false, jupyterExpose: false,
    });
    expect(request).toMatchObject({ agentName: 'writer', prompt: 'write it', command: '', sandboxId: '', driver: '' });
  });
});

test('builds follow and stop requests', () => {
  expect(buildFollowRunLogsRequest({ projectId: 'p', runId: 'r', tailLines: 100, follow: true }))
    .toMatchObject({ projectId: 'p', runId: 'r', tailLines: 100, follow: true });
  expect(buildStopRunRequest('r')).toMatchObject({ runId: 'r', reason: '用户从 Web 请求停止' });
});
