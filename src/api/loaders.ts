import { apiFetchJson } from './http';
import { projectClient } from './client';
import { EventTriggerSpec, ProjectValidationSeverity, SchedulerRunStatus, TriggerSpec, type Project, type ResolvedTrigger, type SchedulerRun, type SchedulerSummary } from '../gen/agentcompose/v2/agentcompose_pb.js';
import { toLegacySessionPolicy, toProjectSandboxPolicy, type LegacySessionPolicy } from '../model/sandbox-policy';

export type AutomationTask = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  runtime: string;
  workspaceId: string;
  agentId: string;
  agentName: string;
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
  sessionPolicy: LegacySessionPolicy;
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
  name: string;
  prompt: string;
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
  sessionPolicy: LegacySessionPolicy;
  concurrencyPolicy: string;
  enabled: boolean;
  envItems?: Array<{ name: string; value: string; secret: boolean }>;
  triggers?: AutomationTriggerInput[];
};

export type AutomationTriggerInput = {
  name: string;
  kind: string;
  cron?: string;
  interval?: string;
  timeout?: string;
  topic?: string;
  prompt?: string;
  sandboxPolicy?: string;
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
  return (await listAllSchedulers()).map(taskFromV2);
}

export async function getAutomationTask(id: string): Promise<AutomationTaskDetail> {
  const found = await findScheduler(id); if (!found) throw new Error('自动化任务不存在');
  const response = await projectClient.getScheduler({ project: { projectId: found.projectId }, agentName: found.agentName });
  const summary = taskFromV2(found);
  return {
    ...summary,
    name: response.spec?.displayName.trim() || response.scheduler?.displayName.trim() || summary.name,
    description: response.spec?.description.trim() || response.scheduler?.description.trim() || summary.description,
    sessionPolicy: toLegacySessionPolicy(response.spec?.sandboxPolicy || summary.sessionPolicy),
    script: response.spec?.script ?? '',
    triggers: response.triggers.map(triggerFromResolved),
    envItems: [],
  };
}

export async function resolveAutomationSessionTarget(id:string):Promise<{projectId:string;agentName:string}|undefined>{const found=await findScheduler(id);return found?{projectId:found.projectId,agentName:found.agentName}:undefined}

export async function saveAutomationTask(input: SaveAutomationTaskInput): Promise<AutomationTaskDetail> {
  const target = input.id ? await findScheduler(input.id) : await findProjectAgent(input.agentId || input.defaultAgent); if (!target) throw new Error('自动化任务必须关联项目智能体');
  const project = await loadProject(target.projectId); const agents = (project.spec?.agents ?? []).map((agent) => agent.name === target.agentName ? { ...agent, scheduler: { enabled: input.enabled, displayName: input.name.trim(), description: input.description.trim(), script: input.script, sandboxPolicy: toProjectSandboxPolicy(input.sessionPolicy), triggers: (input.triggers ?? []).map(triggerSpecFromInput) } } : agent);
  await projectClient.applyProject({ spec: { ...project.spec!, agents } });
  const refreshed = await findSchedulerByAgent(target.projectId, target.agentName); if (!refreshed) throw new Error('自动化任务保存失败'); return getAutomationTask(refreshed.schedulerId);
}

export async function deleteAutomationTask(id: string): Promise<void> {
  const found=await findScheduler(id);if(!found)return;const project=await loadProject(found.projectId);const agents=(project.spec?.agents??[]).map((agent)=>agent.name===found.agentName?{...agent,scheduler:undefined}:agent);await projectClient.applyProject({spec:{...project.spec!,agents}});
}

export async function setAutomationTaskEnabled(id: string, enabled: boolean): Promise<AutomationTask> {
  const found=await findScheduler(id);if(!found)throw new Error('自动化任务不存在');await projectClient.setSchedulerEnabled({project:{projectId:found.projectId},agentName:found.agentName,enabled});return{...taskFromV2(found),enabled};
}

export async function setAutomationTriggerEnabled(loaderId: string, triggerId: string, enabled: boolean): Promise<AutomationTaskDetail> {
  const found=await findScheduler(loaderId);if(!found)throw new Error('自动化任务不存在');await projectClient.setSchedulerTriggerEnabled({project:{projectId:found.projectId},agentName:found.agentName,triggerId,enabled});return getAutomationTask(loaderId);
}

export async function validateAutomationTask(script: string, runtime: string): Promise<ValidateAutomationTaskResult> {
  if (runtime !== 'scheduler') throw new Error(`不支持的自动化运行时：${runtime}`);
  const response = await projectClient.validateProject({
    spec: {
      name: 'ui-automation-validation',
      agents: [{
        name: 'automation',
        provider: 'codex',
        scheduler: { enabled: true, script, sandboxPolicy: 'sticky', triggers: [] },
      }],
    },
  });
  const errors = response.issues.filter((issue) => issue.severity === ProjectValidationSeverity.ERROR);
  if (!response.valid || errors.length > 0) {
    const details = (errors.length > 0 ? errors : response.issues)
      .map((issue) => issue.path ? `${issue.path}: ${issue.message}` : issue.message)
      .filter(Boolean)
      .join('\n');
    throw new Error(details || '自动化脚本校验失败');
  }
  return {
    triggers: [],
    warnings: response.issues
      .filter((issue) => issue.severity === ProjectValidationSeverity.WARNING)
      .map((issue) => issue.path ? `${issue.path}: ${issue.message}` : issue.message),
  };
}

export async function runAutomationTaskNow(loaderId: string, payloadJson: string, triggerId = ''): Promise<AutomationRun> {
  const scheduler = await requireScheduler(loaderId);
  const response = await projectClient.runScheduler({
    project: { projectId: scheduler.projectId },
    agentName: scheduler.agentName,
    triggerId,
    payloadJson,
  });
  if (!response.run) throw new Error('自动化任务运行失败');
  return runFromScheduler(response.run);
}

export async function getAutomationRun(loaderId: string, runId: string): Promise<AutomationRun> {
  const scheduler = await requireScheduler(loaderId);
  const response = await projectClient.getSchedulerRun({ project: { projectId: scheduler.projectId }, runId });
  if (!response.run) throw new Error('自动化运行不存在');
  return runFromScheduler(response.run);
}

export async function listRecentAutomationRuns(loaderIds: string[], limit = 10): Promise<AutomationRun[]> {
  if (loaderIds.length === 0 || limit <= 0) return [];
  const requestedIds = new Set(loaderIds);
  const schedulers = (await listAllSchedulers()).filter((item) => requestedIds.has(item.schedulerId));
  const responses = await Promise.all(schedulers.map((scheduler) => projectClient.listSchedulerRuns({
    project: { projectId: scheduler.projectId },
    agentName: scheduler.agentName,
    limit: Math.min(Math.ceil(limit), 500),
  })));
  const uniqueRuns = new Map<string, SchedulerRun>();
  for (const response of responses) {
    for (const run of response.runs) {
      uniqueRuns.set(run.runId, run);
    }
  }
  return [...uniqueRuns.values()]
    .map(runFromScheduler)
    .sort((left, right) => compareDateDesc(left.startedAt, right.startedAt))
    .slice(0, limit);
}

export async function stopAutomationRun(loaderId: string, runId: string, reason = ''): Promise<{ run: AutomationRun; stopRequested: boolean }> {
  const scheduler = await requireScheduler(loaderId);
  const response = await projectClient.stopSchedulerRun({
    project: { projectId: scheduler.projectId },
    runId,
    reason,
  });
  if (!response.run) throw new Error('自动化运行不存在');
  return { run: runFromScheduler(response.run), stopRequested: response.stopRequested };
}

export async function listAutomationEvents(loaderId: string, limit = 50): Promise<AutomationEvent[]> {
  const found=await findScheduler(loaderId);if(!found)return[];const response = await projectClient.listSchedulerEvents({ project:{projectId:found.projectId},agentName:found.agentName,limit });
  return response.events.map((item) => ({
    id: item.id,
    loaderId,
    runId: item.runId,
    triggerId: item.triggerId,
    type: item.type,
    level: item.level,
    message: item.message,
    payloadJson: item.payloadJson,
    linkedSessionId: '', linkedCellId: '', linkedAgentSessionId: '',
    createdAt: timestampString(item.createdAt),
    topicEventId: topicEventIdFromPayload(item.payloadJson),
  }));
}

async function listAllSchedulers():Promise<SchedulerSummary[]>{const result:SchedulerSummary[]=[];let token='';do{const response=await projectClient.listSchedulers({limit:500,cursor:token});result.push(...response.schedulers);token=response.nextCursor}while(token);return result}
async function findScheduler(id:string):Promise<SchedulerSummary|undefined>{return (await listAllSchedulers()).find((value)=>value.schedulerId===id)}
async function requireScheduler(id: string): Promise<SchedulerSummary> {
  const scheduler = await findScheduler(id);
  if (!scheduler) throw new Error('自动化任务不存在');
  return scheduler;
}
async function findSchedulerByAgent(projectId:string,agentName:string){return (await listAllSchedulers()).find((value)=>value.projectId===projectId&&value.agentName===agentName)}
async function loadProject(projectId:string):Promise<Project>{const response=await projectClient.getProject({project:{projectId},includeSpec:true});if(!response.project)throw new Error('项目不存在');return response.project}
async function findProjectAgent(id:string):Promise<{projectId:string;agentName:string}|undefined>{let offset=0;for(;;){const listed=await projectClient.listProjects({limit:200,offset});for(const summary of listed.projects){const project=await loadProject(summary.projectId);const agent=project.agents.find((value)=>value.managedAgentId===id||value.agentName===id);if(agent)return{projectId:summary.projectId,agentName:agent.agentName}}if(!listed.hasMore)return undefined;offset=listed.nextOffset}}
function taskFromV2(item:SchedulerSummary):AutomationTask{return{id:item.schedulerId,name:item.displayName.trim()||item.agentName,description:item.description.trim(),enabled:item.enabled,runtime:'scheduler',workspaceId:'',agentId:item.agentName,agentName:item.agentName,capsetIds:[],defaultAgent:'',triggerCount:item.triggerCount,runCount:item.runCount,eventCount:0,latestRunAt:timestampString(item.latestRunAt),lastError:item.lastError,createdAt:'',updatedAt:'',driver:'',guestImage:'',sessionPolicy:'new_session',concurrencyPolicy:'skip'}}
function triggerSpecFromInput(input:AutomationTriggerInput):TriggerSpec{const sandboxPolicy=input.sandboxPolicy?.trim()??'';return new TriggerSpec({name:input.name.trim(),kind:input.kind.trim(),cron:input.cron?.trim()??'',interval:input.interval?.trim()??'',timeout:input.timeout?.trim()??'',event:input.kind.trim()==='event'?new EventTriggerSpec({topic:input.topic?.trim()??''}):undefined,prompt:input.prompt?.trim()??'',sandboxPolicy:sandboxPolicy?toProjectSandboxPolicy(sandboxPolicy):''})}
function triggerFromResolved(item:ResolvedTrigger):AutomationTrigger{const spec=item.spec;const duration=spec?.interval||spec?.timeout||'';return{loaderId:'',triggerId:item.triggerId,kind:spec?.kind??'',topic:spec?.event?.topic??'',intervalMs:duration?parseDuration(duration):0,enabled:item.enabled,autoId:false,specJson:spec?JSON.stringify(spec.toJson()):'',nextFireAt:timestampString(item.nextFireAt),lastFiredAt:timestampString(item.lastFiredAt),name:spec?.name??'',prompt:spec?.prompt??''}}
function runFromScheduler(item: SchedulerRun): AutomationRun {
  return {
    id: item.runId,
    loaderId: item.schedulerId,
    triggerId: item.triggerId,
    triggerKind: item.triggerKind,
    triggerSource: item.triggerSource,
    status: schedulerRunStatus(item.status),
    startedAt: timestampString(item.startedAt),
    completedAt: timestampString(item.completedAt),
    durationMs: Number(item.durationMs),
    error: item.error,
    resultJson: item.resultJson,
    payloadJson: item.payloadJson,
    artifactsDir: item.artifactsDir,
  };
}

function schedulerRunStatus(status: SchedulerRunStatus): string {
  switch (status) {
    case SchedulerRunStatus.RUNNING: return 'RUNNING';
    case SchedulerRunStatus.SUCCEEDED: return 'SUCCEEDED';
    case SchedulerRunStatus.FAILED: return 'FAILED';
    case SchedulerRunStatus.CANCELED: return 'CANCELED';
    case SchedulerRunStatus.SKIPPED: return 'SKIPPED';
    default: return 'UNSPECIFIED';
  }
}
function timestampString(value?:{seconds:bigint;nanos:number}){return value?new Date(Number(value.seconds)*1000+value.nanos/1e6).toISOString():''}
function parseDuration(value:string){const match=value.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/);if(!match)return 0;const multiplier={ms:1,s:1000,m:60000,h:3600000}[match[2] as 'ms'|'s'|'m'|'h'];return Number(match[1])*multiplier}

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
  // Older daemons return sessions/session_id, while newer daemons use
  // sandboxes/sandbox_id after the session-to-sandbox rename.
  const response = await apiFetchJson<TopicEventSessionsResponse>(`/api/events/${encodeURIComponent(eventId)}/sessions`);
  const items = Array.isArray(response.sessions)
    ? response.sessions
    : Array.isArray(response.sandboxes)
      ? response.sandboxes
      : [];
  return items.map((item) => ({
    sessionId: item.session_id || item.sandbox_id || '',
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
    agentName: item.agentId,
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
    sessionPolicy: toLegacySessionPolicy(item.sessionPolicy),
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
  session_id?: string;
  sandbox_id?: string;
  relation: string;
  loader_id?: string;
  run_id?: string;
  trigger_id?: string;
  loader_event_id?: string;
  event_id: string;
  created_at: string;
};

type TopicEventSessionsResponse = {
  sessions?: TopicEventSessionResponse[];
  sandboxes?: TopicEventSessionResponse[];
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
