import {
  FollowRunLogsRequest, GetRunRequest, GetSandboxRequest, ListRunEventsRequest,
  ListSandboxHistoryRequest, ListSandboxRunEventsRequest, ListSchedulerEventsRequest,
  type GetRunResponse, type GetSandboxResponse, type ListRunEventsResponse,
  type ListSandboxHistoryResponse, type ListSandboxRunEventsResponse,
  type ListSchedulerEventsResponse, type RunLogChunk,
} from '../gen/agentcompose/v2/agentcompose_pb';
import { Code, ConnectError } from '@connectrpc/connect';
import { groupSchedulerExecutions, type SchedulerOwnedExecution } from './agent-owned-executions';
import { extractSchedulerExecutionLinks, type LinkedResourceId } from './scheduler-execution-links';
import {
  buildFullExecutionTimeline,
  type FullExecutionTimelineEntry,
  type SchedulerExecutionRawData,
} from './scheduler-full-timeline';
import { loadSchedulerRunEvents } from './scheduler-run-timeline';
import { stableProjectRunId } from './run-scheduler-evidence';

export interface FullExecutionDependencies {
  listSchedulerEvents(request: ListSchedulerEventsRequest, options?: { signal?: AbortSignal }): Promise<ListSchedulerEventsResponse>;
  getSandbox(request: GetSandboxRequest, options?: { signal?: AbortSignal }): Promise<GetSandboxResponse>;
  listSandboxHistory(request: ListSandboxHistoryRequest, options?: { signal?: AbortSignal }): Promise<ListSandboxHistoryResponse>;
  listSandboxRunEvents(request: ListSandboxRunEventsRequest, options?: { signal?: AbortSignal }): Promise<ListSandboxRunEventsResponse>;
  getRun(request: GetRunRequest, options?: { signal?: AbortSignal }): Promise<GetRunResponse>;
  listRunEvents(request: ListRunEventsRequest, options?: { signal?: AbortSignal }): Promise<ListRunEventsResponse>;
  followRunLogs(request: FollowRunLogsRequest, options?: { signal?: AbortSignal }): AsyncIterable<RunLogChunk>;
}

export interface FullSchedulerExecutionInput {
  projectId: string;
  agentName: string;
  schedulerRunId: string;
  signal?: AbortSignal;
}

export type SourceCompletenessState = 'complete' | 'unavailable' | 'failed' | 'not-applicable';
export interface SourceCompleteness {
  source: string;
  resourceId: string;
  state: SourceCompletenessState;
  error: string;
}
export type AggregationPhase = 'scheduler' | 'discovering' | 'sandbox' | 'run' | 'merging';
export interface FullSchedulerExecutionResult {
  execution?: SchedulerOwnedExecution;
  sandboxIds: string[];
  entries: FullExecutionTimelineEntry[];
  sourceStatuses: SourceCompleteness[];
  complete: boolean;
  snapshotAt: string;
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError');
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// sandbox/run 结束后底层资源可能已被清理，后端对这些资源返回 NotFound（如 read session metadata ... no such file）。
// 这属于正常终态而非加载失败，标记为不可用并给出友好提示，避免把原始 [not_found] 错误透出到界面。
function classifySourceError(error: unknown, notFoundHint: string): { state: SourceCompletenessState; error: string } {
  if (ConnectError.from(error).code === Code.NotFound) {
    return { state: 'unavailable', error: notFoundHint };
  }
  return { state: 'failed', error: errorMessage(error) };
}

async function exhaustCursor<T>(
  source: string,
  fetchPage: (cursor: string) => Promise<{ values: T[]; nextCursor: string; available?: boolean }>,
): Promise<{ values: T[]; available: boolean }> {
  const values: T[] = [];
  const seen = new Set<string>();
  let available = true;
  let cursor = '';
  while (true) {
    const page = await fetchPage(cursor);
    values.push(...page.values);
    available = available && page.available !== false;
    if (!page.nextCursor) return { values, available };
    if (seen.has(page.nextCursor)) throw new Error(`${source} returned repeated cursor`);
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

async function runPool(tasks: Array<() => Promise<void>>, signal?: AbortSignal): Promise<void> {
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      checkAbort(signal);
      const index = next++;
      if (index >= tasks.length) return;
      await tasks[index]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, tasks.length) }, worker));
}

function parents(link: Pick<LinkedResourceId, 'introducedBy'>): string[] {
  return link.introducedBy.map(id => `scheduler-event:${id}`);
}

export async function loadFullSchedulerExecution(
  input: FullSchedulerExecutionInput,
  dependencies: FullExecutionDependencies,
  onProgress: (phase: AggregationPhase) => void = () => {},
): Promise<FullSchedulerExecutionResult> {
  const { signal } = input;
  onProgress('scheduler');
  checkAbort(signal);
  const schedulerEvents = await loadSchedulerRunEvents(input.schedulerRunId, request => {
    checkAbort(signal);
    return dependencies.listSchedulerEvents(new ListSchedulerEventsRequest({
      ...request, project: { projectId: input.projectId }, agentName: input.agentName,
    }), { signal });
  });
  checkAbort(signal);
  const execution = groupSchedulerExecutions(schedulerEvents).find(value => value.schedulerRunId === input.schedulerRunId);
  const statuses: SourceCompleteness[] = [{
    source: 'scheduler-events', resourceId: input.schedulerRunId,
    state: execution ? 'complete' : 'not-applicable', error: execution ? '' : 'Scheduler execution was not found',
  }];
  const raw: SchedulerExecutionRawData = {
    schedulerEvents, sandboxes: [], cells: [], runDetails: [], runEvents: [], runLogs: [], sourceStatuses: statuses,
  };

  if (!execution) {
    onProgress('merging');
    return { execution: undefined, sandboxIds: [], entries: buildFullExecutionTimeline(raw), sourceStatuses: statuses, complete: false, snapshotAt: new Date().toISOString() };
  }

  onProgress('discovering');
  const links = extractSchedulerExecutionLinks(schedulerEvents);
  const sandboxIds = new Set(links.sandboxes.map(link => link.id));
  for (const warning of links.warnings) statuses.push({
    source: 'scheduler-link', resourceId: warning.eventId, state: 'unavailable', error: warning.message,
  });
  const runLinks = links.runs.map(link => ({ ...link, introducedBy: [...link.introducedBy] }));
  const agentEventIds = schedulerEvents.filter(event => event.type.startsWith('loader.agent.')).map(event => event.id);
  if (agentEventIds.length) {
    const terminalAgentRunCount = schedulerEvents.filter(event => event.type === 'loader.agent.completed' || event.type === 'loader.agent.failed').length;
    for (let sequence = 1; sequence <= Math.max(1, terminalAgentRunCount); sequence++) {
      const clientRequestId = `${input.schedulerRunId}:agent:${sequence}`;
      const stableRunId = await stableProjectRunId(input.projectId, input.agentName, 'scheduler', clientRequestId);
      const existing = runLinks.find(link => link.id === stableRunId);
      if (existing) existing.introducedBy = [...new Set([...existing.introducedBy, ...agentEventIds])];
      else runLinks.push({ id: stableRunId, introducedBy: agentEventIds });
    }
  }
  runLinks.sort((left, right) => left.id.localeCompare(right.id));
  if (!links.sandboxes.length) {
    for (const source of ['sandbox-detail', 'sandbox-history', 'sandbox-run-events']) {
      statuses.push({ source, resourceId: '', state: 'not-applicable', error: '' });
    }
  }
  if (!runLinks.length) {
    for (const source of ['run-detail', 'run-events', 'run-log']) {
      statuses.push({ source, resourceId: '', state: 'not-applicable', error: '' });
    }
  }

  onProgress('sandbox');
  await runPool(links.sandboxes.map(link => async () => {
    const sandboxParents = parents(link);
    const relevantRunIds = links.sandboxRuns
      .filter(pair => pair.sandboxId === link.id)
      .map(pair => pair.runId);
    const relevantRunIdSet = new Set(relevantRunIds);
    const relevantCellParents = new Map(
      links.sandboxCells.filter(pair => pair.sandboxId === link.id).map(pair => [pair.cellId, parents(pair)]),
    );
    try {
      checkAbort(signal);
      const response = await dependencies.getSandbox(new GetSandboxRequest({ sandboxId: link.id }), { signal });
      if (response.sandbox) raw.sandboxes.push({ sandboxId: link.id, value: response.sandbox, parentSourceIds: sandboxParents });
      statuses.push({ source: 'sandbox-detail', resourceId: link.id, state: response.sandbox ? 'complete' : 'unavailable', error: response.sandbox ? '' : 'Sandbox detail was not returned' });
    } catch (error) {
      if (signal?.aborted) throw abortError();
      statuses.push({ source: 'sandbox-detail', resourceId: link.id, ...classifySourceError(error, 'Sandbox 已被清理，详情不可用') });
    }
    try {
      checkAbort(signal);
      const history = await dependencies.listSandboxHistory(new ListSandboxHistoryRequest({ sandboxId: link.id }), { signal });
      for (const cell of history.cells) {
        const cellParents = relevantCellParents.get(cell.id);
        if (cellParents) raw.cells.push({
          sandboxId: link.id,
          cellId: cell.id,
          value: cell,
          parentSourceIds: [...new Set([`sandbox:${link.id}`, ...sandboxParents, ...cellParents])],
        });
      }
      statuses.push({ source: 'sandbox-history', resourceId: link.id, state: 'complete', error: '' });
    } catch (error) {
      if (signal?.aborted) throw abortError();
      statuses.push({ source: 'sandbox-history', resourceId: link.id, ...classifySourceError(error, 'Sandbox 已被清理，单元历史不可用') });
    }
    try {
      const availableRunIds = new Set<string>();
      const result = await exhaustCursor(`sandbox-run-events:${link.id}`, async cursor => {
        checkAbort(signal);
        const page = await dependencies.listSandboxRunEvents(new ListSandboxRunEventsRequest({ sandboxId: link.id, limit: 500, cursor }), { signal });
        for (const runId of page.historyAvailableRunIds) availableRunIds.add(runId);
        return { values: page.events, nextCursor: page.nextCursor };
      });
      for (const event of result.values) if (relevantRunIdSet.has(event.runId)) raw.runEvents.push({ runId: event.runId, value: event, parentSourceIds: [`sandbox:${link.id}`, `run-detail:${event.runId}`] });
      const unavailableRunIds = relevantRunIds.filter(runId => !availableRunIds.has(runId));
      statuses.push({
        source: 'sandbox-run-events', resourceId: link.id,
        state: unavailableRunIds.length ? 'unavailable' : 'complete',
        error: unavailableRunIds.length ? `Run event history is unavailable for: ${unavailableRunIds.join(', ')}` : '',
      });
    } catch (error) {
      if (signal?.aborted) throw abortError();
      statuses.push({ source: 'sandbox-run-events', resourceId: link.id, ...classifySourceError(error, 'Sandbox 已被清理，Run 事件不可用') });
    }
  }), signal);

  onProgress('run');
  await runPool(runLinks.map(link => async () => {
    const runParents = parents(link);
    try {
      checkAbort(signal);
      const response = await dependencies.getRun(new GetRunRequest({ projectId: input.projectId, runId: link.id }), { signal });
      if (response.run) {
        raw.runDetails.push({ runId: link.id, value: response.run, parentSourceIds: runParents });
        const sandboxId = response.run.summary?.sandboxId.trim();
        if (sandboxId) sandboxIds.add(sandboxId);
      }
      statuses.push({ source: 'run-detail', resourceId: link.id, state: response.run ? 'complete' : 'unavailable', error: response.run ? '' : 'Run detail was not returned' });
    } catch (error) {
      if (signal?.aborted) throw abortError();
      statuses.push({ source: 'run-detail', resourceId: link.id, ...classifySourceError(error, '运行记录不存在或已被清理') });
    }
    try {
      const result = await exhaustCursor(`run-events:${link.id}`, async cursor => {
        checkAbort(signal);
        const page = await dependencies.listRunEvents(new ListRunEventsRequest({ runId: link.id, limit: 500, cursor }), { signal });
        return { values: page.events, nextCursor: page.nextCursor, available: page.historyAvailable };
      });
      for (const event of result.values) if (event.runId === link.id) raw.runEvents.push({ runId: link.id, value: event, parentSourceIds: [`run-detail:${link.id}`] });
      statuses.push({ source: 'run-events', resourceId: link.id, state: result.available ? 'complete' : 'unavailable', error: result.available ? '' : 'Run event history is unavailable' });
    } catch (error) {
      if (signal?.aborted) throw abortError();
      statuses.push({ source: 'run-events', resourceId: link.id, ...classifySourceError(error, '运行事件记录不存在') });
    }
    try {
      checkAbort(signal);
      let final = false;
      const stream = dependencies.followRunLogs(new FollowRunLogsRequest({ projectId: input.projectId, runId: link.id, startOffset: 0n, follow: false }), { signal });
      for await (const chunk of stream) {
        checkAbort(signal);
        raw.runLogs.push({ runId: link.id, offset: chunk.offset, data: chunk.data, createdAt: chunk.createdAt, parentSourceIds: [`run-detail:${link.id}`] });
        if (chunk.isFinal) { final = true; break; }
      }
      statuses.push({ source: 'run-log', resourceId: link.id, state: final ? 'complete' : 'unavailable', error: final ? '' : 'Run log stream ended before a final chunk' });
    } catch (error) {
      if (signal?.aborted) throw abortError();
      statuses.push({ source: 'run-log', resourceId: link.id, ...classifySourceError(error, '运行日志不可用') });
    }
  }), signal);

  checkAbort(signal);
  onProgress('merging');
  const entries = buildFullExecutionTimeline(raw);
  return {
    execution, sandboxIds: [...sandboxIds].sort(), entries, sourceStatuses: statuses,
    complete: statuses.every(status => status.state === 'complete' || status.state === 'not-applicable'),
    snapshotAt: new Date().toISOString(),
  };
}
