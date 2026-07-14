import { ExecStreamEventType } from '../gen/agentcompose/v2/agentcompose_pb.js';

import { execClient } from './client';

export type RuntimeExecInput = {
  sandboxId?: string;
  runId?: string;
  command: string;
  cwd?: string;
  timeoutMs?: number;
};

export type RuntimeExecResult = {
  execId: string;
  sandboxId: string;
  runId: string;
  command: string;
  cwd: string;
  exitCode: number;
  success: boolean;
  stdout: string;
  stderr: string;
  output: string;
  error: string;
};

export type RuntimeExecEvent =
  | { type: 'started'; execId: string; sandboxId: string; runId: string }
  | { type: 'chunk'; execId: string; sandboxId: string; runId: string; chunk: string; isStderr: boolean }
  | { type: 'completed'; execId: string; sandboxId: string; runId: string; result: RuntimeExecResult | null };

export async function executeRuntimeCommandStream(
  input: RuntimeExecInput,
  onEvent: (event: RuntimeExecEvent) => void,
  signal?: AbortSignal,
): Promise<RuntimeExecResult | null> {
  const source = input.command.trim();
  if (!source) {
    throw new Error('命令不能为空');
  }
  const sandboxId = input.sandboxId?.trim() || '';
  const runId = input.runId?.trim() || '';
  if (!sandboxId && !runId) {
    throw new Error('缺少可执行命令的运行会话');
  }

  let finalResult: RuntimeExecResult | null = null;
  const request = {
    target: sandboxId
      ? { case: 'sandboxId' as const, value: sandboxId }
      : { case: 'runId' as const, value: runId },
    command: {
      command: 'sh',
      args: ['-lc', source],
    },
    cwd: input.cwd?.trim() || '',
    timeoutMs: input.timeoutMs ?? 0,
  };

  for await (const event of execClient.execStream(request, { signal })) {
    if (event.eventType === ExecStreamEventType.STARTED) {
      onEvent({
        type: 'started',
        execId: event.execId,
        sandboxId: event.sandboxId,
        runId: event.runId,
      });
    } else if (event.eventType === ExecStreamEventType.OUTPUT) {
      onEvent({
        type: 'chunk',
        execId: event.execId,
        sandboxId: event.sandboxId,
        runId: event.runId,
        chunk: event.chunk,
        isStderr: event.stream === 2,
      });
    } else if (event.eventType === ExecStreamEventType.COMPLETED) {
      finalResult = event.result ? resultFromProto(event.result) : null;
      onEvent({
        type: 'completed',
        execId: event.execId,
        sandboxId: event.sandboxId,
        runId: event.runId,
        result: finalResult,
      });
    }
  }
  return finalResult;
}

function resultFromProto(item: {
  execId: string;
  sandboxId: string;
  runId: string;
  command?: { command: string; args: string[] };
  cwd: string;
  exitCode: number;
  success: boolean;
  stdout: string;
  stderr: string;
  output: string;
  error: string;
}): RuntimeExecResult {
  return {
    execId: item.execId,
    sandboxId: item.sandboxId,
    runId: item.runId,
    command: item.command ? [item.command.command, ...item.command.args].join(' ') : '',
    cwd: item.cwd,
    exitCode: item.exitCode,
    success: item.success,
    stdout: item.stdout,
    stderr: item.stderr,
    output: item.output,
    error: item.error,
  };
}
