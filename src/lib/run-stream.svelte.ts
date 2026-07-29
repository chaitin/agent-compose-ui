import {
  RunAgentStreamEventType,
  RunSandboxCleanupPolicy,
  RunSource,
  RunStatus,
  StdioStream,
} from '../gen/agentcompose/v2/agentcompose_pb.js';
import { streamAgentRun } from '../api/run-stream';
import { createOperationId } from './id';
import { t } from './i18n.svelte';

export type AgentStreamRequest = {
  projectId: string;
  agentName: string;
  prompt?: string;
  displayPrompt?: string;
  command?: string;
  sandboxId?: string;
  driver?: string;
};

export type AgentStreamPhase = 'starting' | 'streaming' | 'completed' | 'failed' | 'canceled';

export class AgentStreamState {
  readonly operationId = createOperationId();
  readonly projectId: string;
  readonly agentName: string;
  readonly prompt: string;
  readonly command: string;
  runId = $state('');
  sandboxId = $state('');
  output = $state('');
  stdout = $state('');
  stderr = $state('');
  phase = $state<AgentStreamPhase>('starting');
  error = $state('');
  startedAt = $state('');
  firstChunkAt = $state('');
  completedAt = $state('');

  constructor(request: AgentStreamRequest) {
    this.projectId = request.projectId;
    this.agentName = request.agentName;
    this.prompt = request.displayPrompt ?? request.prompt ?? '';
    this.command = request.command ?? '';
    this.sandboxId = request.sandboxId ?? '';
  }

  get running(): boolean {
    return this.phase === 'starting' || this.phase === 'streaming';
  }

  get statusText(): string {
    if (this.phase === 'starting') return t('正在发送…');
    if (this.phase === 'streaming') return t('回复中…');
    if (this.phase === 'completed') return t('已完成');
    if (this.phase === 'canceled') return t('已取消');
    return this.error || t('回复失败');
  }
}

class RunStreamCoordinator {
  private version = $state(0);
  private readonly byOperation = new Map<string, AgentStreamState>();
  private readonly byRun = new Map<string, AgentStreamState>();
  private readonly bySandbox = new Map<string, AgentStreamState>();
  private readonly controllers = new Map<string, AbortController>();

  forRun(runId: string): AgentStreamState | undefined {
    void this.version;
    return this.byRun.get(runId);
  }

  forSandbox(sandboxId: string): AgentStreamState | undefined {
    void this.version;
    return this.bySandbox.get(sandboxId);
  }

  async start(request: AgentStreamRequest, onStarted?: (state: AgentStreamState) => void): Promise<AgentStreamState> {
    const state = new AgentStreamState(request);
    const controller = new AbortController();
    this.byOperation.set(state.operationId, state);
    this.controllers.set(state.operationId, controller);
    if (state.sandboxId) this.bySandbox.set(state.sandboxId, state);
    this.touch();

    try {
      for await (const event of streamAgentRun(
        {
          projectId: request.projectId,
          agentName: request.agentName,
          prompt: request.prompt,
          command: request.command,
          sandboxId: request.sandboxId,
          driver: request.driver,
          source: RunSource.MANUAL,
          cleanupPolicy: RunSandboxCleanupPolicy.KEEP_RUNNING,
        },
        controller.signal,
      )) {
        if (event.runId && event.runId !== state.runId) {
          state.runId = event.runId;
          this.byRun.set(event.runId, state);
        }
        if (event.run?.sandboxId && event.run.sandboxId !== state.sandboxId) {
          state.sandboxId = event.run.sandboxId;
          this.bySandbox.set(event.run.sandboxId, state);
        }
        if (event.eventType === RunAgentStreamEventType.STARTED) {
          state.phase = 'streaming';
          state.startedAt = new Date().toISOString();
          this.touch();
          onStarted?.(state);
        } else if (event.eventType === RunAgentStreamEventType.OUTPUT && event.chunk) {
          if (!state.firstChunkAt) state.firstChunkAt = new Date().toISOString();
          state.output += event.chunk;
          if (event.stream === StdioStream.STDERR) state.stderr += event.chunk;
          else state.stdout += event.chunk;
        } else if (event.eventType === RunAgentStreamEventType.COMPLETED) {
          state.phase = event.run?.status === RunStatus.SUCCEEDED ? 'completed' : 'failed';
          state.error = event.run?.error ?? '';
          state.completedAt = new Date().toISOString();
        }
      }
      if (state.running) {
        state.phase = 'failed';
        state.error = t('流式响应在完成事件前结束');
      }
    } catch (cause) {
      state.phase = controller.signal.aborted ? 'canceled' : 'failed';
      state.error = cause instanceof Error ? cause.message : t('流式执行失败');
    } finally {
      this.controllers.delete(state.operationId);
      this.scheduleCleanup(state);
    }
    return state;
  }

  cancel(state: AgentStreamState): void {
    this.controllers.get(state.operationId)?.abort();
  }

  dismiss(state: AgentStreamState): void {
    if (state.running) return;
    this.byOperation.delete(state.operationId);
    if (state.runId && this.byRun.get(state.runId) === state) this.byRun.delete(state.runId);
    if (state.sandboxId && this.bySandbox.get(state.sandboxId) === state) this.bySandbox.delete(state.sandboxId);
    this.touch();
  }

  private touch(): void {
    this.version += 1;
  }

  private scheduleCleanup(state: AgentStreamState): void {
    window.setTimeout(() => {
      if (this.byOperation.get(state.operationId) === state && !state.running) this.dismiss(state);
    }, 10 * 60_000);
  }
}

const globalStreams = globalThis as typeof globalThis & {
  __agentComposeRunStreams?: RunStreamCoordinator;
};

export const runStreams = (globalStreams.__agentComposeRunStreams ??= new RunStreamCoordinator());
