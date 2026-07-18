import {
  FollowRunLogsRequest,
  RunAgentRequest,
  RunJupyterSpec,
  RunSandboxCleanupPolicy,
  RunSource,
  StopRunRequest,
} from '../gen/agentcompose/v2/agentcompose_pb';

export type RunInputMode = 'prompt' | 'command';

export interface RunRequestInput {
  projectId: string;
  agentName: string;
  mode: RunInputMode;
  input: string;
  sandboxId: string;
  driver: string;
  cleanupPolicy: RunSandboxCleanupPolicy;
  jupyterEnabled: boolean;
  jupyterExpose: boolean;
}

export function buildRunAgentRequest(input: RunRequestInput): RunAgentRequest {
  const value = input.input.trim();
  if (!value) throw new Error('请输入本次运行内容');
  return new RunAgentRequest({
    projectId: input.projectId,
    agentName: input.agentName.trim(),
    source: RunSource.MANUAL,
    prompt: input.mode === 'prompt' ? value : '',
    command: input.mode === 'command' ? value : '',
    sandboxId: input.sandboxId.trim(),
    driver: input.driver.trim(),
    cleanupPolicy: input.cleanupPolicy,
    jupyter: input.jupyterEnabled
      ? new RunJupyterSpec({ enabled: true, expose: input.jupyterExpose })
      : undefined,
  });
}

export function buildFollowRunLogsRequest(input: {
  projectId: string;
  runId: string;
  tailLines: number;
  follow: boolean;
}): FollowRunLogsRequest {
  return new FollowRunLogsRequest(input);
}

export function buildStopRunRequest(runId: string): StopRunRequest {
  return new StopRunRequest({ runId, reason: '用户从 Web 请求停止' });
}
