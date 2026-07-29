import { RunEventKind, type Sandbox } from '../gen/agentcompose/v2/agentcompose_pb.js';
import { runClient, sandboxClient } from './client';
import { timestampToISOString as timestampString } from '../model/timestamps';

export enum CellType {
  UNSPECIFIED = 0,
  SHELL = 1,
  JAVASCRIPT = 2,
  PYTHON = 3,
  AGENT = 4,
}
export type SandboxContext = {
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
export type SandboxContextDetail = SandboxContext & { proxyPath: string; notebookUrl: string };
export type SandboxHistoryCell = {
  id: string;
  runId?: string;
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
export type SandboxHistoryEvent = { id: string; type: string; level: string; message: string; createdAt: string };
export type SandboxRunTarget = { projectId: string; agentName: string };

// Temporary source-compatible aliases for older model helpers. New UI code uses the Sandbox names above.
export type WorkSession = SandboxContext;
export type WorkSessionDetail = SandboxContextDetail;
export type WorkSessionCell = SandboxHistoryCell;
export type WorkSessionEvent = SandboxHistoryEvent;
export type WorkSessionRunTarget = SandboxRunTarget;

export const listSandboxContexts = listWorkSessions;
export const getSandboxContext = getWorkSession;
export const stopSandboxContext = stopWorkSession;
export const resumeSandboxContext = resumeWorkSession;
export const listSandboxHistoryCells = listWorkSessionCells;
export const refreshSandboxHistoryCells = refreshWorkSessionCells;
export const listSandboxHistoryEvents = listWorkSessionEvents;
export const getSandboxRunTarget = getWorkSessionRunTarget;

export async function listWorkSessions(
  limit = 50,
  offset = 0,
): Promise<{ sessions: WorkSession[]; hasMore: boolean; totalCount: number }> {
  let token = '';
  let skipped = 0;
  const sessions: WorkSession[] = [];
  for (;;) {
    const response = await sandboxClient.listSandboxes({ limit: Math.min(500, limit + offset), cursor: token });
    const pageStartCount = sessions.length;
    let usablePageCount = 0;
    for (const item of response.sandboxes) {
      if (skipped++ < offset) continue;
      usablePageCount++;
      if (sessions.length < limit) sessions.push(sessionFromSandbox(item));
    }
    token = response.nextCursor;
    if (!token || sessions.length >= limit)
      return {
        sessions,
        hasMore: Boolean(token) || usablePageCount > limit - pageStartCount,
        totalCount: offset + sessions.length + (token ? 1 : 0),
      };
  }
}
export async function getWorkSession(
  id: string,
  _options: { includeProxy?: boolean } = {},
): Promise<WorkSessionDetail> {
  const response = await sandboxClient.getSandbox({ sandboxId: id });
  if (!response.sandbox) throw new Error('Sandbox 不存在');
  return {
    ...sessionFromSandbox(response.sandbox),
    proxyPath: response.sandbox.proxyPath,
    notebookUrl: response.sandbox.notebookUrl,
  };
}
export async function getWorkSessionProxy(id: string) {
  const value = await getWorkSession(id);
  return { proxyPath: value.proxyPath, notebookUrl: value.notebookUrl };
}
export async function getWorkSessionStatus(id: string): Promise<WorkSession> {
  return getWorkSession(id);
}
export async function stopWorkSession(id: string): Promise<WorkSession> {
  const response = await sandboxClient.stopSandbox({ sandboxId: id });
  if (!response.sandbox) throw new Error('停止 Sandbox 失败');
  return sessionFromSandbox(response.sandbox);
}
export async function resumeWorkSession(id: string): Promise<WorkSession> {
  const response = await sandboxClient.resumeSandbox({ sandboxId: id });
  if (!response.sandbox) throw new Error('恢复 Sandbox 失败');
  return sessionFromSandbox(response.sandbox);
}

type WorkSessionHistory = { cells: WorkSessionCell[]; events: WorkSessionEvent[] };
const historyRequests = new Map<string, Promise<WorkSessionHistory>>();
type SandboxRuns = Awaited<ReturnType<typeof runClient.listRuns>>['runs'];
const sandboxRunRequests = new Map<string, Promise<SandboxRuns>>();

export async function listWorkSessionCells(id: string): Promise<WorkSessionCell[]> {
  return (await workSessionHistory(id)).cells;
}
export async function refreshWorkSessionCells(id: string): Promise<WorkSessionCell[]> {
  historyRequests.delete(id);
  sandboxRunRequests.delete(id);
  return listWorkSessionCells(id);
}
export async function listWorkSessionEvents(id: string): Promise<WorkSessionEvent[]> {
  return (await workSessionHistory(id)).events;
}

function workSessionHistory(id: string): Promise<WorkSessionHistory> {
  const existing = historyRequests.get(id);
  if (existing) return existing;
  const request = loadWorkSessionHistory(id);
  historyRequests.set(id, request);
  const clear = () => setTimeout(() => historyRequests.delete(id), 1000);
  void request.then(clear, clear);
  return request;
}

async function loadWorkSessionHistory(id: string): Promise<WorkSessionHistory> {
  const runs = await runsForSandbox(id);
  const legacyResponse = await sandboxClient.listSandboxHistory({ sandboxId: id });
  const legacyHistory = historyFromSandboxResponse(legacyResponse);
  if (!runs.length) {
    return legacyHistory;
  }
  const firstV2RunAt = timestampString(runs[0].createdAt);
  const cells: WorkSessionCell[] = [];
  const events: WorkSessionEvent[] = [];
  const historyAvailableRunIds = new Set<string>();
  let cursor = '';
  do {
    const response = await runClient.listSandboxRunEvents({ sandboxId: id, limit: 500, cursor });
    for (const runId of response.historyAvailableRunIds) historyAvailableRunIds.add(runId);
    for (const item of response.events) {
      if (item.kind === RunEventKind.USER_MESSAGE || item.kind === RunEventKind.AGENT_MESSAGE)
        cells.push({
          id: item.id,
          runId: item.runId,
          source: item.kind === RunEventKind.USER_MESSAGE ? item.text : '',
          output: item.kind === RunEventKind.AGENT_MESSAGE ? item.text : '',
          type: CellType.AGENT,
          exitCode: item.exitCode,
          success: item.success,
          createdAt: timestampString(item.createdAt),
          agent: item.agent,
          agentSessionId: '',
          stopReason: item.stopReason,
          running: false,
        });
      else if (item.kind === RunEventKind.STATUS)
        events.push({
          id: item.id,
          type: 'run.status',
          level: item.success ? 'info' : 'error',
          message: item.stopReason || item.payloadJson,
          createdAt: timestampString(item.createdAt),
        });
    }
    cursor = response.nextCursor;
  } while (cursor);
  for (const run of runs) {
    if (!historyAvailableRunIds.has(run.runId)) {
      let logs = '';
      for await (const chunk of runClient.followRunLogs({
        runId: run.runId,
        projectId: run.projectId,
        follow: false,
        tailLines: 1000,
      }))
        logs += chunk.data;
      if (logs)
        cells.push({
          id: `${run.runId}-legacy-log`,
          source: '',
          output: logs,
          type: CellType.AGENT,
          exitCode: 0,
          success: true,
          createdAt: timestampString(run.createdAt),
          agent: run.agentName,
          agentSessionId: '',
          stopReason: '旧运行：仅日志记录',
          running: false,
        });
    }
  }
  cells.push(...legacyHistory.cells.filter((cell) => isBeforeV2History(cell.createdAt, firstV2RunAt)));
  events.push(...legacyHistory.events.filter((event) => isBeforeV2History(event.createdAt, firstV2RunAt)));
  cells.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  events.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return { cells, events };
}
export async function getWorkSessionRunTarget(id: string): Promise<WorkSessionRunTarget | undefined> {
  const run = await latestRunForSandbox(id);
  if (run) return { projectId: run.projectId, agentName: run.agentName };
  const response = await sandboxClient.getSandbox({ sandboxId: id });
  const projectId = response.sandbox?.projectId.trim() ?? '';
  const agentName = response.sandbox?.agentName.trim() ?? '';
  return projectId && agentName ? { projectId, agentName } : undefined;
}
async function latestRunForSandbox(id: string) {
  const runs = await runsForSandbox(id);
  return runs[runs.length - 1];
}
async function runsForSandbox(id: string) {
  let request = sandboxRunRequests.get(id);
  if (!request) {
    request = loadRunsForSandbox(id);
    sandboxRunRequests.set(id, request);
    const clear = () => setTimeout(() => sandboxRunRequests.delete(id), 1000);
    void request.then(clear, clear);
  }
  return request;
}
async function loadRunsForSandbox(id: string): Promise<SandboxRuns> {
  const runs: SandboxRuns = [];
  let offset = 0;
  for (;;) {
    const response = await runClient.listRuns({ sandboxId: id, limit: 200, offset });
    runs.push(...response.runs);
    if (response.runs.length < 200) break;
    offset += response.runs.length;
  }
  return runs.sort(
    (left, right) =>
      runTimeValue(timestampString(left.createdAt)) - runTimeValue(timestampString(right.createdAt)) ||
      left.runId.localeCompare(right.runId),
  );
}
function legacyCellType(value: string): CellType {
  switch (value.trim().toLowerCase()) {
    case 'shell':
      return CellType.SHELL;
    case 'javascript':
      return CellType.JAVASCRIPT;
    case 'python':
      return CellType.PYTHON;
    default:
      return CellType.AGENT;
  }
}
function historyFromSandboxResponse(
  response: Awaited<ReturnType<typeof sandboxClient.listSandboxHistory>>,
): WorkSessionHistory {
  return {
    cells: response.cells.map((item) => ({
      id: item.id,
      source: item.source,
      output: item.output || [item.stdout, item.stderr].filter(Boolean).join('\n'),
      type: legacyCellType(item.type),
      exitCode: item.exitCode,
      success: item.success,
      createdAt: timestampString(item.createdAt),
      agent: item.agent,
      agentSessionId: item.agentThreadId,
      stopReason: item.stopReason || '旧 Sandbox 历史',
      running: item.running,
    })),
    events: response.events.map((item) => ({
      id: item.id,
      type: item.type,
      level: item.level,
      message: item.message,
      createdAt: timestampString(item.createdAt),
    })),
  };
}
function isBeforeV2History(createdAt: string, firstV2RunAt: string): boolean {
  return !createdAt || !firstV2RunAt || runTimeValue(createdAt) < runTimeValue(firstV2RunAt);
}
function runTimeValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}
function tagValue(tags: Array<{ name: string; value: string }>, name: string): string {
  return tags.find((tag) => tag.name.trim() === name)?.value.trim() ?? '';
}
function sessionFromSandbox(item: Sandbox): WorkSession {
  return {
    id: item.sandboxId,
    title: item.title,
    status: item.status,
    driver: item.driver,
    guestImage: item.image,
    workspacePath: item.workspacePath,
    triggerSource: item.triggerSource,
    createdAt: timestampString(item.createdAt),
    updatedAt: timestampString(item.updatedAt),
    cellCount: item.cellCount,
    eventCount: item.eventCount,
    tags: item.tags.map((v) => ({ name: v.name, value: v.value })),
  };
}
