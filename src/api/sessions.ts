import { agentClient, kernelClient, llmClient, sessionClient } from './client';
import { CellType, SendAgentMessageStreamEventType, WatchSessionEventType } from '@chaitin-ai/agent-compose-client/agentcompose/v1/agentcompose_pb.js';

export type WorkSession = {
  id: string;
  title: string;
  status: string;
  driver: string;
  guestImage: string;
  workspacePath: string;
  triggerSource: string;
  createdAt: string;
  updatedAt: string;
  cellCount: number;
  eventCount: number;
  tags: Array<{ name: string; value: string }>;
};

export type WorkSessionDetail = WorkSession & {
  proxyPath: string;
  notebookUrl: string;
};

export type WorkSessionCell = {
  id: string;
  source: string;
  output: string;
  type: CellType;
  exitCode: number;
  success: boolean;
  createdAt: string;
  agent: string;
  agentSessionId: string;
  stopReason: string;
  running: boolean;
};

export type WorkSessionEvent = {
  id: string;
  type: string;
  level: string;
  message: string;
  createdAt: string;
};

export type CreateWorkSessionInput = {
  agentName: string;
  defaultAgent: string;
  workspaceId: string;
  task: string;
};

export type WorkSessionWatchEvent =
  | { type: 'session'; session: WorkSession }
  | { type: 'event'; event: WorkSessionEvent }
  | { type: 'cell'; cell: WorkSessionCell }
  | { type: 'chunk'; cellId: string; chunk: string; isStderr: boolean };

export async function listWorkSessions(limit = 50, offset = 0): Promise<{ sessions: WorkSession[]; hasMore: boolean; totalCount: number }> {
  const response = await sessionClient.listSessions({ limit, offset });
  return {
    sessions: response.sessions.map(sessionFromSummary),
    hasMore: response.hasMore,
    totalCount: response.totalCount,
  };
}

export async function getWorkSession(id: string, options: { includeProxy?: boolean } = {}): Promise<WorkSessionDetail> {
  const sessionResponse = await sessionClient.getSession({ sessionId: id });
  if (!sessionResponse.session?.summary) {
    throw new Error('工作会话不存在');
  }
  const summary = sessionResponse.session.summary;
  const proxyResponse = options.includeProxy !== false && summary.vmStatus === 'RUNNING'
    ? await sessionClient.getSessionProxy({ sessionId: id }).catch(() => null)
    : null;
  return {
    ...sessionFromSummary(summary),
    proxyPath: proxyResponse?.proxyPath || summary.proxyPath,
    notebookUrl: proxyResponse?.notebookUrl || '',
  };
}

export async function getWorkSessionProxy(id: string): Promise<{ proxyPath: string; notebookUrl: string }> {
  const response = await sessionClient.getSessionProxy({ sessionId: id });
  return {
    proxyPath: response.proxyPath,
    notebookUrl: response.notebookUrl,
  };
}

export async function getWorkSessionStatus(id: string): Promise<WorkSession> {
  const response = await sessionClient.getSession({ sessionId: id });
  if (!response.session?.summary) {
    throw new Error('工作会话不存在');
  }
  return sessionFromSummary(response.session.summary);
}

export async function stopWorkSession(id: string): Promise<WorkSession> {
  const response = await sessionClient.stopSession({ sessionId: id });
  if (!response.session?.summary) {
    throw new Error('停止会话失败');
  }
  return sessionFromSummary(response.session.summary);
}

export async function resumeWorkSession(id: string): Promise<WorkSession> {
  const response = await sessionClient.resumeSession({ sessionId: id });
  if (!response.session?.summary) {
    throw new Error('恢复会话失败');
  }
  return sessionFromSummary(response.session.summary);
}

export async function listWorkSessionCells(id: string): Promise<WorkSessionCell[]> {
  const response = await kernelClient.listCells({ sessionId: id });
  return response.cells.map((item) => ({
    id: item.id,
    source: item.source,
    output: item.output,
    type: item.type,
    exitCode: item.exitCode,
    success: item.success,
    createdAt: item.createdAt,
    agent: item.agent,
    agentSessionId: item.agentSessionId,
    stopReason: item.stopReason,
    running: item.running,
  }));
}

export async function listWorkSessionEvents(id: string): Promise<WorkSessionEvent[]> {
  const response = await agentClient.listSessionEvents({ sessionId: id });
  return response.events.map((item) => ({
    id: item.id,
    type: item.type,
    level: item.level,
    message: item.message,
    createdAt: item.createdAt,
  }));
}

export async function sendWorkSessionMessage(id: string, agent: string, message: string): Promise<void> {
  await agentClient.sendAgentMessage({
    sessionId: id,
    agent,
    message,
  });
}

export async function sendWorkSessionMessageStream(
  id: string,
  agent: string,
  message: string,
  onEvent: (event: {
    type: 'started' | 'chunk' | 'completed';
    runId: string;
    chunk?: string;
    isStderr?: boolean;
    run?: {
      id: string;
      agent: string;
      message: string;
      output: string;
      exitCode: number;
      success: boolean;
      createdAt: string;
      agentSessionId: string;
      stopReason: string;
      running: boolean;
    };
  }) => void,
  signal?: AbortSignal,
): Promise<void> {
  for await (const event of agentClient.sendAgentMessageStream({ sessionId: id, agent, message }, { signal })) {
    if (event.eventType === SendAgentMessageStreamEventType.STARTED) {
      onEvent({ type: 'started', runId: event.runId });
    } else if (event.eventType === SendAgentMessageStreamEventType.OUTPUT && event.chunk) {
      onEvent({ type: 'chunk', runId: event.runId, chunk: event.chunk, isStderr: event.isStderr });
    } else if (event.eventType === SendAgentMessageStreamEventType.COMPLETED) {
      onEvent({
        type: 'completed',
        runId: event.runId,
        run: event.run ? {
          id: event.run.id,
          agent: event.run.agent,
          message: event.run.message,
          output: event.run.output,
          exitCode: event.run.exitCode,
          success: event.run.success,
          createdAt: event.run.createdAt,
          agentSessionId: event.run.agentSessionId,
          stopReason: event.run.stopReason,
          running: event.run.running,
        } : undefined,
      });
    }
  }
}

export async function executeWorkSessionCell(id: string, source: string, type: CellType = CellType.JAVASCRIPT): Promise<WorkSessionCell> {
  const response = await kernelClient.executeCell({ sessionId: id, source, type });
  if (!response.cell) {
    throw new Error('执行 cell 失败');
  }
  return {
    id: response.cell.id,
    source: response.cell.source,
    output: response.cell.output,
    type: response.cell.type,
    exitCode: response.cell.exitCode,
    success: response.cell.success,
    createdAt: response.cell.createdAt,
    agent: response.cell.agent,
    agentSessionId: response.cell.agentSessionId,
    stopReason: response.cell.stopReason,
    running: response.cell.running,
  };
}

export async function executeWorkSessionCellStream(
  id: string,
  source: string,
  onChunk: (chunk: string) => void,
  type: CellType = CellType.JAVASCRIPT,
  signal?: AbortSignal,
): Promise<WorkSessionCell | null> {
  let cell: WorkSessionCell | null = null;
  for await (const event of kernelClient.executeCellStream({ sessionId: id, source, type }, { signal })) {
    if (event.chunk) {
      onChunk(event.chunk);
    }
    if (event.cell) {
      cell = {
        id: event.cell.id,
        source: event.cell.source,
        output: event.cell.output,
        type: event.cell.type,
        exitCode: event.cell.exitCode,
        success: event.cell.success,
        createdAt: event.cell.createdAt,
        agent: event.cell.agent,
        agentSessionId: event.cell.agentSessionId,
        stopReason: event.cell.stopReason,
        running: event.cell.running,
      };
    }
  }
  return cell;
}

export async function generateLLMText(prompt: string, model = '', outputSchema = ''): Promise<string> {
  const response = await llmClient.generate({ prompt, model, outputSchema });
  return response.text || response.json;
}

export async function watchWorkSession(
  id: string,
  onEvent: (event: WorkSessionWatchEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  for await (const event of sessionClient.watchSession({ sessionId: id }, { signal })) {
    if (event.eventType === WatchSessionEventType.SESSION_UPDATED && event.session) {
      onEvent({ type: 'session', session: sessionFromSummary(event.session) });
    } else if (event.eventType === WatchSessionEventType.EVENT_ADDED && event.event) {
      onEvent({
        type: 'event',
        event: {
          id: event.event.id,
          type: event.event.type,
          level: event.event.level,
          message: event.event.message,
          createdAt: event.event.createdAt,
        },
      });
    } else if ((event.eventType === WatchSessionEventType.CELL_STARTED || event.eventType === WatchSessionEventType.CELL_COMPLETED) && event.cell) {
      onEvent({
        type: 'cell',
        cell: {
          id: event.cell.id,
          source: event.cell.source,
          output: event.cell.output,
          type: event.cell.type,
          exitCode: event.cell.exitCode,
          success: event.cell.success,
          createdAt: event.cell.createdAt,
          agent: event.cell.agent,
          agentSessionId: event.cell.agentSessionId,
          stopReason: event.cell.stopReason,
          running: event.cell.running,
        },
      });
    } else if (event.eventType === WatchSessionEventType.CELL_OUTPUT && event.chunk) {
      onEvent({ type: 'chunk', cellId: event.cellId, chunk: event.chunk, isStderr: event.isStderr });
    }
  }
}

export async function createWorkSession(input: CreateWorkSessionInput): Promise<string> {
  const title = `${input.agentName} ${formatSessionTime(new Date())}`;
  const response = await sessionClient.createSession({
    title,
    workspaceId: input.workspaceId,
    tags: [
      { name: 'run_type', value: 'work_session' },
      { name: 'agent_definition', value: input.agentName },
    ],
    envItems: [{ name: 'AGENT_COMPOSE_AGENT_NAME', value: input.agentName, secret: false }],
  });

  const sessionId = response.session?.summary?.sessionId ?? '';
  if (sessionId && input.task.trim()) {
    await agentClient.sendAgentMessage({
      sessionId,
      agent: input.defaultAgent,
      message: input.task.trim(),
    });
  }
  return sessionId;
}

function sessionFromSummary(item: {
  sessionId: string;
  title: string;
  vmStatus: string;
  driver: string;
  guestImage: string;
  workspacePath: string;
  triggerSource: string;
  createdAt: string;
  updatedAt: string;
  cellCount: number;
  eventCount: number;
  tags: Array<{ name: string; value: string }>;
}): WorkSession {
  return {
    id: item.sessionId,
    title: item.title,
    status: item.vmStatus,
    driver: item.driver,
    guestImage: item.guestImage,
    workspacePath: item.workspacePath,
    triggerSource: item.triggerSource,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    cellCount: Number(item.cellCount),
    eventCount: Number(item.eventCount),
    tags: item.tags.map((tag) => ({ name: tag.name, value: tag.value })),
  };
}

function formatSessionTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
