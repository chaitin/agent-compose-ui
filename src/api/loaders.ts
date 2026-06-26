import { apiFetchJson } from './http';
import { loaderClient } from './client';

export type AutomationTask = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  runtime: string;
  workspaceId: string;
  agentId: string;
  capsetIds: string[];
  defaultAgent: string;
  triggerCount: number;
  runCount: number;
  eventCount: number;
  latestRunAt: string;
  lastError: string;
  createdAt: string;
  updatedAt: string;
  driver: string;
  guestImage: string;
  sessionPolicy: string;
  concurrencyPolicy: string;
};

export type AutomationTrigger = {
  loaderId: string;
  triggerId: string;
  kind: string;
  topic: string;
  intervalMs: number;
  enabled: boolean;
  autoId: boolean;
  specJson: string;
  nextFireAt: string;
  lastFiredAt: string;
};

export type AutomationTaskDetail = AutomationTask & {
  script: string;
  triggers: AutomationTrigger[];
  envItems: Array<{ name: string; value: string; secret: boolean }>;
};

export type SaveAutomationTaskInput = {
  id?: string;
  name: string;
  description: string;
  runtime: string;
  script: string;
  workspaceId: string;
  driver: string;
  guestImage: string;
  agentId: string;
  capsetIds: string[];
  defaultAgent: string;
  sessionPolicy: string;
  concurrencyPolicy: string;
  enabled: boolean;
  envItems?: Array<{ name: string; value: string; secret: boolean }>;
};

export type ValidateAutomationTaskResult = {
  triggers: AutomationTrigger[];
  warnings: string[];
};

export type AutomationRun = {
  id: string;
  loaderId: string;
  triggerId: string;
  triggerKind: string;
  triggerSource: string;
  status: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  error: string;
  resultJson: string;
  payloadJson: string;
  artifactsDir: string;
};

export type AutomationEvent = {
  id: string;
  loaderId: string;
  runId: string;
  triggerId: string;
  type: string;
  level: string;
  message: string;
  payloadJson: string;
  linkedSessionId: string;
  linkedCellId: string;
  linkedAgentSessionId: string;
  createdAt: string;
  topicEventId: string;
};

export type TopicEvent = {
  eventId: string;
  sequence: number;
  topic: string;
  source: string;
  provider: string;
  intent: string;
  correlationId: string;
  idempotencyKey: string;
  deliveryId: string;
  dispatchStatus: string;
  parentEventId: string;
  publisherType: string;
  publisherId: string;
  publisherRunId: string;
  createdAt: string;
  dispatchedAt: string;
  payload: Record<string, unknown>;
};

export type TopicEventRun = {
  eventId: string;
  loaderId: string;
  runId: string;
  triggerId: string;
  status: string;
  error: string;
  createdAt: string;
  updatedAt: string;
};

export type TopicEventSession = {
  sessionId: string;
  relation: string;
  loaderId: string;
  runId: string;
  triggerId: string;
  loaderEventId: string;
  eventId: string;
  createdAt: string;
};

export async function listAutomationTasks(): Promise<AutomationTask[]> {
  const response = await loaderClient.listLoaders({});
  return response.loaders.map(taskFromSummary);
}

export async function getAutomationTask(id: string): Promise<AutomationTaskDetail> {
  const response = await loaderClient.getLoader({ loaderId: id });
  if (!response.loader?.summary) {
    throw new Error('自动化任务不存在');
  }
  return {
    ...taskFromSummary(response.loader.summary),
    script: response.loader.script,
    triggers: response.loader.triggers.map(triggerFromResponse),
    envItems: response.loader.envItems.map((item) => ({
      name: item.name,
      value: item.value,
      secret: item.secret,
    })),
  };
}

export async function saveAutomationTask(input: SaveAutomationTaskInput): Promise<AutomationTaskDetail> {
  const payload = {
    name: input.name.trim(),
    description: input.description.trim(),
    runtime: input.runtime,
    script: input.script,
    workspaceId: input.workspaceId.trim(),
    driver: input.driver.trim(),
    guestImage: input.guestImage.trim(),
    agentId: input.agentId.trim(),
    capsetIds: input.capsetIds,
    defaultAgent: input.defaultAgent.trim(),
    sessionPolicy: input.sessionPolicy,
    concurrencyPolicy: input.concurrencyPolicy,
    enabled: input.enabled,
    envItems: (input.envItems || []).filter((item) => item.name.trim()).map((item) => ({
      name: item.name.trim(),
      value: item.value,
      secret: item.secret,
    })),
  };
  const response = input.id
    ? await loaderClient.updateLoader({ loaderId: input.id, ...payload })
    : await loaderClient.createLoader(payload);
  if (!response.loader?.summary) {
    throw new Error('自动化任务保存失败');
  }
  return {
    ...taskFromSummary(response.loader.summary),
    script: response.loader.script,
    triggers: response.loader.triggers.map(triggerFromResponse),
    envItems: response.loader.envItems.map((item) => ({
      name: item.name,
      value: item.value,
      secret: item.secret,
    })),
  };
}

export async function deleteAutomationTask(id: string): Promise<void> {
  await loaderClient.deleteLoader({ loaderId: id });
}

export async function setAutomationTaskEnabled(id: string, enabled: boolean): Promise<AutomationTask> {
  const response = await loaderClient.setLoaderEnabled({ loaderId: id, enabled });
  if (!response.loader?.summary) {
    throw new Error('自动化任务状态更新失败');
  }
  return taskFromSummary(response.loader.summary);
}

export async function setAutomationTriggerEnabled(loaderId: string, triggerId: string, enabled: boolean): Promise<AutomationTaskDetail> {
  const response = await loaderClient.setLoaderTriggerEnabled({ loaderId, triggerId, enabled });
  if (!response.loader?.summary) {
    throw new Error('触发规则状态更新失败');
  }
  return {
    ...taskFromSummary(response.loader.summary),
    script: response.loader.script,
    triggers: response.loader.triggers.map(triggerFromResponse),
    envItems: response.loader.envItems.map((item) => ({
      name: item.name,
      value: item.value,
      secret: item.secret,
    })),
  };
}

export async function validateAutomationTask(script: string, runtime: string): Promise<ValidateAutomationTaskResult> {
  const response = await loaderClient.validateLoader({ script, runtime });
  return {
    triggers: response.triggers.map(triggerFromResponse),
    warnings: response.warnings,
  };
}

export async function runAutomationTaskNow(loaderId: string, payloadJson: string, triggerId = ''): Promise<AutomationRun> {
  const response = await loaderClient.runLoaderNow({
    loaderId,
    triggerId,
    payloadJson,
    timeout: '',
  });
  if (!response.run?.summary) {
    throw new Error('自动化任务运行失败');
  }
  return runFromSummary(response.run.summary);
}

export async function getAutomationRun(loaderId: string, runId: string): Promise<AutomationRun> {
  const response = await loaderClient.getLoaderRun({ loaderId, runId });
  if (!response.run?.summary) {
    throw new Error('自动化运行不存在');
  }
  return runFromSummary(response.run.summary);
}

export async function listRecentAutomationRuns(loaderIds: string[], limit = 10): Promise<AutomationRun[]> {
  const runs = await Promise.all(
    loaderIds.map(async (loaderId) => {
      const response = await loaderClient.listLoaderRuns({ loaderId, limit });
      return response.runs.map(runFromSummary);
    }),
  );
  return runs.flat().sort((left, right) => compareDateDesc(left.startedAt, right.startedAt));
}

export async function listAutomationEvents(loaderId: string, limit = 50): Promise<AutomationEvent[]> {
  const response = await loaderClient.listLoaderEvents({ loaderId, limit });
  return response.events.map((item) => ({
    id: item.id,
    loaderId: item.loaderId,
    runId: item.runId,
    triggerId: item.triggerId,
    type: item.type,
    level: item.level,
    message: item.message,
    payloadJson: item.payloadJson,
    linkedSessionId: item.linkedSessionId,
    linkedCellId: item.linkedCellId,
    linkedAgentSessionId: item.linkedAgentSessionId,
    createdAt: item.createdAt,
    topicEventId: topicEventIdFromPayload(item.payloadJson),
  }));
}

export async function getTopicEvent(eventId: string): Promise<TopicEvent> {
  const response = await apiFetchJson<{ event: TopicEventResponse }>(`/api/events/${encodeURIComponent(eventId)}`);
  return topicEventFromResponse(response.event);
}

export async function listTopicEventRuns(eventId: string): Promise<TopicEventRun[]> {
  const response = await apiFetchJson<{ runs: TopicEventRunResponse[] }>(`/api/events/${encodeURIComponent(eventId)}/runs`);
  return response.runs.map((item) => ({
    eventId: item.event_id,
    loaderId: item.loader_id,
    runId: item.run_id || '',
    triggerId: item.trigger_id,
    status: item.status,
    error: item.error || '',
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  }));
}

export async function listTopicEventSessions(eventId: string): Promise<TopicEventSession[]> {
  const response = await apiFetchJson<{ sessions: TopicEventSessionResponse[] }>(`/api/events/${encodeURIComponent(eventId)}/sessions`);
  return response.sessions.map((item) => ({
    sessionId: item.session_id,
    relation: item.relation,
    loaderId: item.loader_id || '',
    runId: item.run_id || '',
    triggerId: item.trigger_id || '',
    loaderEventId: item.loader_event_id || '',
    eventId: item.event_id,
    createdAt: item.created_at,
  }));
}

function taskFromSummary(item: {
  loaderId: string;
  name: string;
  description: string;
  enabled: boolean;
  runtime: string;
  workspaceId: string;
  agentId: string;
  capsetIds: string[];
  driver: string;
  guestImage: string;
  defaultAgent: string;
  sessionPolicy: string;
  concurrencyPolicy: string;
  createdAt: string;
  updatedAt: string;
  lastError: string;
  triggerCount: number;
  runCount: number;
  eventCount: number;
  latestRunAt: string;
}): AutomationTask {
  return {
    id: item.loaderId,
    name: item.name,
    description: item.description,
    enabled: item.enabled,
    runtime: item.runtime,
    workspaceId: item.workspaceId,
    agentId: item.agentId,
    capsetIds: item.capsetIds,
    defaultAgent: item.defaultAgent,
    triggerCount: Number(item.triggerCount),
    runCount: Number(item.runCount),
    eventCount: Number(item.eventCount),
    latestRunAt: item.latestRunAt,
    lastError: item.lastError,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    driver: item.driver,
    guestImage: item.guestImage,
    sessionPolicy: item.sessionPolicy,
    concurrencyPolicy: item.concurrencyPolicy,
  };
}

function triggerFromResponse(item: {
  loaderId: string;
  triggerId: string;
  kind: unknown;
  topic: string;
  intervalMs: bigint | number | string;
  enabled: boolean;
  autoId: boolean;
  specJson: string;
  nextFireAt: string;
  lastFiredAt: string;
}): AutomationTrigger {
  return {
    loaderId: item.loaderId,
    triggerId: item.triggerId,
    kind: String(item.kind),
    topic: item.topic,
    intervalMs: Number(item.intervalMs),
    enabled: item.enabled,
    autoId: item.autoId,
    specJson: item.specJson,
    nextFireAt: item.nextFireAt,
    lastFiredAt: item.lastFiredAt,
  };
}

function runFromSummary(item: {
  runId: string;
  loaderId: string;
  triggerId: string;
  triggerKind: unknown;
  triggerSource: string;
  status: string;
  startedAt: string;
  completedAt: string;
  durationMs: bigint | number | string;
  error: string;
  resultJson: string;
  payloadJson: string;
  artifactsDir: string;
}): AutomationRun {
  return {
    id: item.runId,
    loaderId: item.loaderId,
    triggerId: item.triggerId,
    triggerKind: String(item.triggerKind),
    triggerSource: item.triggerSource,
    status: item.status,
    startedAt: item.startedAt,
    completedAt: item.completedAt,
    durationMs: Number(item.durationMs),
    error: item.error,
    resultJson: item.resultJson,
    payloadJson: item.payloadJson,
    artifactsDir: item.artifactsDir,
  };
}

function topicEventIdFromPayload(raw: string): string {
  if (!raw.trim()) {
    return '';
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const direct = parsed.eventId ?? parsed.event_id;
    if (typeof direct === 'string') {
      return direct;
    }
    const event = parsed.event;
    if (event && typeof event === 'object') {
      const nested = (event as Record<string, unknown>).eventId ?? (event as Record<string, unknown>).event_id;
      return typeof nested === 'string' ? nested : '';
    }
  } catch {
    return '';
  }
  return '';
}

type TopicEventResponse = {
  event_id: string;
  sequence: number;
  topic: string;
  source: string;
  provider?: string;
  intent?: string;
  correlation_id: string;
  idempotency_key?: string;
  delivery_id?: string;
  dispatch_status: string;
  parent_event_id?: string;
  publisher_type?: string;
  publisher_id?: string;
  publisher_run_id?: string;
  created_at: string;
  dispatched_at?: string;
  payload?: Record<string, unknown>;
};

type TopicEventRunResponse = {
  event_id: string;
  loader_id: string;
  run_id?: string;
  trigger_id: string;
  status: string;
  error?: string;
  created_at: string;
  updated_at: string;
};

type TopicEventSessionResponse = {
  session_id: string;
  relation: string;
  loader_id?: string;
  run_id?: string;
  trigger_id?: string;
  loader_event_id?: string;
  event_id: string;
  created_at: string;
};

function topicEventFromResponse(item: TopicEventResponse): TopicEvent {
  return {
    eventId: item.event_id,
    sequence: Number(item.sequence || 0),
    topic: item.topic,
    source: item.source,
    provider: item.provider || '',
    intent: item.intent || '',
    correlationId: item.correlation_id,
    idempotencyKey: item.idempotency_key || '',
    deliveryId: item.delivery_id || '',
    dispatchStatus: item.dispatch_status,
    parentEventId: item.parent_event_id || '',
    publisherType: item.publisher_type || '',
    publisherId: item.publisher_id || '',
    publisherRunId: item.publisher_run_id || '',
    createdAt: item.created_at,
    dispatchedAt: item.dispatched_at || '',
    payload: item.payload || {},
  };
}

function compareDateDesc(left: string, right: string): number {
  return new Date(right || 0).getTime() - new Date(left || 0).getTime();
}
