import {
  StreamAgentRunEventType,
  RunSandboxCleanupPolicy,
  RunSource,
  RunStatus,
  StdioStream,
  type TranscriptEvent,
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
export type AgentTranscriptItem = {
  id: string;
  stream: StdioStream;
  text: string;
  name: string;
  payloadJson: string;
  createdAt: string;
};

export class AgentStreamState {
  readonly operationId = createOperationId();
  readonly projectId: string;
  readonly agentName: string;
  readonly prompt: string;
  readonly command: string;
  runId = $state('');
  sandboxId = $state('');
  output = $state('');
  // stdout / stderr 只用于最终结果，不驱动界面，不做成响应式，避免每个数据块都触发更新。
  stdout = '';
  stderr = '';
  transcript = $state<AgentTranscriptItem[]>([]);
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

/**
 * 流式输出合并进界面的间隔。数据块往往又小又密，逐块写入响应式状态会让对话整段重算、重绘；
 * 先攒在普通变量里，按这个间隔合并一次。第一块和结束时立即合并，不影响首字和收尾的响应。
 */
const STREAM_FLUSH_MS = 100;

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

    let pendingOutput = '';
    let pendingTranscript: AgentTranscriptItem[] = [];
    let flushTimer = 0;
    const flush = (): void => {
      window.clearTimeout(flushTimer);
      flushTimer = 0;
      if (pendingOutput) {
        state.output += pendingOutput;
        pendingOutput = '';
      }
      if (pendingTranscript.length) {
        state.transcript = [...state.transcript, ...pendingTranscript];
        pendingTranscript = [];
      }
    };
    const scheduleFlush = (): void => {
      if (!flushTimer) flushTimer = window.setTimeout(flush, STREAM_FLUSH_MS);
    };

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
        if (event.eventType === StreamAgentRunEventType.STARTED) {
          state.phase = 'streaming';
          state.startedAt = new Date().toISOString();
          this.touch();
          onStarted?.(state);
        } else if (event.eventType === StreamAgentRunEventType.OUTPUT && event.chunk) {
          pendingOutput += event.chunk;
          if (event.stream === StdioStream.STDERR) state.stderr += event.chunk;
          else state.stdout += event.chunk;
          if (!state.firstChunkAt) {
            state.firstChunkAt = new Date().toISOString();
            flush();
          } else scheduleFlush();
        } else if (event.eventType === StreamAgentRunEventType.COMPLETED) {
          flush();
          state.phase = event.run?.status === RunStatus.SUCCEEDED ? 'completed' : 'failed';
          state.error = event.run?.error ?? '';
          state.completedAt = new Date().toISOString();
        }
        if (event.transcript) {
          pendingTranscript.push(transcriptItem(event.transcript, event.runId));
          scheduleFlush();
        }
      }
      flush();
      if (state.running) {
        state.phase = 'failed';
        state.error = t('流式响应在完成事件前结束');
      }
    } catch (cause) {
      flush();
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

function transcriptItem(event: TranscriptEvent, runId: string): AgentTranscriptItem {
  const createdAt = event.createdAt?.toDate().toISOString() ?? new Date().toISOString();
  return {
    id: `${runId}:${createdAt}:${event.name}:${event.text.length}`,
    stream: event.stream,
    text: event.text,
    name: event.name,
    payloadJson: event.payloadJson,
    createdAt,
  };
}

const globalStreams = globalThis as typeof globalThis & {
  __agentComposeRunStreams?: RunStreamCoordinator;
};

export const runStreams = (globalStreams.__agentComposeRunStreams ??= new RunStreamCoordinator());
