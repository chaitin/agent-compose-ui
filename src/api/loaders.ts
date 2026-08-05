import { apiFetchJson } from './http';
import { projectClient, runClient } from './client';
import {
  EventTriggerSpec,
  ProjectValidationSeverity,
  RunSource,
  SchedulerRunStatus,
  TriggerSpec,
  type Project,
  type ProjectScheduler,
  type ResolvedTrigger,
  type SchedulerRun,
} from '../gen/agentcompose/v2/agentcompose_pb.js';
import { toLegacySessionPolicy, toProjectSandboxPolicy, type LegacySessionPolicy } from '../model/sandbox-policy';
import { timestampToISOString as timestampString } from '../model/timestamps';
import {
  getProjectView,
  previewProjectMutation,
  type ProjectDeploymentPreview,
  type SchedulerEditableSpec,
} from './projects';
import { nextPageOffset, projectById } from './project-ref';
import {
  schedulerConcurrencyPolicyToString,
  schedulerSandboxPolicyFromString,
  schedulerSandboxPolicyToString,
  triggerKindFromString,
  triggerKindToString,
} from './proto-enums';

export type AutomationTask = {
  id: string;
  projectId: string;
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
  configuredTriggers: AutomationTriggerInput[];
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
  timezone?: string;
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
  agentRunId: string;
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
  schedulerId: string;
  runId: string;
  triggerId: string;
  status: string;
  error: string;
  createdAt: string;
  updatedAt: string;
};

export type TopicEventSession = {
  sandboxId: string;
  relation: string;
  schedulerId: string;
  runId: string;
  triggerId: string;
  schedulerEventId: string;
  eventId: string;
  createdAt: string;
};

export type EventTopic = {
  topic: string;
  eventCount: number;
  latestEventAt: string;
};

export type TopicEventTraceRun = {
  delivery: TopicEventRun;
  scheduler: { id: string; projectId: string; agentName: string; name: string } | null;
  run: { id: string; status: string; startedAt: string; completedAt: string; durationMs: number; error: string } | null;
  events: AutomationEvent[];
};

export type TopicEventTraceSandbox = {
  link: TopicEventSession;
  sandbox: {
    id: string;
    title: string;
    status: string;
    projectId: string;
    agentName: string;
    createdAt: string;
    updatedAt: string;
  } | null;
};

export type TopicEventTrace = {
  event: TopicEvent;
  runs: TopicEventTraceRun[];
  sandboxes: TopicEventTraceSandbox[];
  descendantsTruncated: boolean;
};

export async function listAutomationTasks(projectId: string): Promise<AutomationTask[]> {
  const project = await loadProject(projectId);
  return Promise.all(
    project.schedulers.map(async (scheduler) => {
      const response = await projectClient.listSchedulerRuns({
        project: projectById(projectId),
        agentName: scheduler.agentName,
        limit: 1,
      });
      return taskFromProjectScheduler(scheduler, response.total, response.runs[0]);
    }),
  );
}

export async function listRecentProjectAutomationRuns(
  limit = 20,
): Promise<{ runs: AutomationRun[]; tasks: AutomationTask[] }> {
  if (limit <= 0) return { runs: [], tasks: [] };

  const projects: Project[] = [];
  let offset = 0;
  for (;;) {
    const page = await projectClient.listProjects({ limit: 200, offset });
    const responses = await Promise.all(
      page.projects.map((summary) =>
        projectClient.getProject({ project: projectById(summary.projectId), includeSpec: false }),
      ),
    );
    projects.push(...responses.flatMap((response) => (response.project ? [response.project] : [])));
    const next = nextPageOffset(offset, page.projects.length, page.total);
    if (next === undefined) break;
    offset = next;
  }

  const targets = projects.flatMap((project) =>
    project.schedulers.map((scheduler) => ({
      projectId: scheduler.projectId || project.summary?.projectId || '',
      scheduler,
    })),
  );
  const responses = await Promise.all(
    targets.map(({ projectId, scheduler }) =>
      projectClient.listSchedulerRuns({
        project: projectById(projectId),
        agentName: scheduler.agentName,
        limit: Math.min(Math.ceil(limit), 500),
      }),
    ),
  );
  const tasks = targets.map(({ scheduler }, index) =>
    taskFromProjectScheduler(scheduler, responses[index].total, responses[index].runs[0]),
  );
  const uniqueRuns = new Map<string, SchedulerRun>();
  for (const response of responses) {
    for (const run of response.runs) uniqueRuns.set(run.runId, run);
  }
  return {
    runs: [...uniqueRuns.values()]
      .map(runFromScheduler)
      .sort((left, right) => compareDateDesc(left.startedAt, right.startedAt))
      .slice(0, limit),
    tasks,
  };
}

export async function getAutomationTask(projectId: string, agentName: string): Promise<AutomationTaskDetail> {
  const [response, project] = await Promise.all([
    projectClient.getScheduler({ project: projectById(projectId), agentName }),
    loadProject(projectId),
  ]);
  if (!response.scheduler) throw new Error('自动化任务不存在');
  const agent = project.spec?.agents.find((item) => item.name === agentName);
  const summary = taskFromProjectScheduler(response.scheduler);
  return {
    ...summary,
    name: response.spec?.displayName.trim() || response.scheduler?.displayName.trim() || summary.name,
    description: response.spec?.description.trim() || response.scheduler?.description.trim() || summary.description,
    capsetIds: [...(agent?.capsetIds ?? [])],
    sessionPolicy: response.spec
      ? toLegacySessionPolicy(schedulerSandboxPolicyToString(response.spec.sandboxPolicy))
      : summary.sessionPolicy,
    concurrencyPolicy: response.spec
      ? schedulerConcurrencyPolicyToString(response.spec.concurrencyPolicy)
      : summary.concurrencyPolicy,
    script: response.spec?.script ?? '',
    triggers: response.triggers.map(triggerFromResolved),
    configuredTriggers: (response.spec?.triggers ?? []).map(triggerInputFromSpec),
    envItems: (agent?.env ?? []).map((item) => ({ name: item.name, value: item.value, secret: item.secret })),
  };
}

export async function previewAutomationTask(
  projectId: string,
  agentName: string,
  input: SaveAutomationTaskInput,
): Promise<ProjectDeploymentPreview> {
  const project = await getProjectView(projectId);
  return previewProjectMutation({
    kind: input.id ? 'update_scheduler' : 'create_scheduler',
    projectId,
    baseSpecHash: project.specHash,
    agentName,
    agent: {
      env: (input.envItems ?? [])
        .map((item) => ({ name: item.name.trim(), value: item.value, secret: item.secret }))
        .filter((item) => item.name),
    },
    scheduler: schedulerSpecFromInput(input),
  });
}

export async function previewDeleteAutomationTask(
  projectId: string,
  agentName: string,
): Promise<ProjectDeploymentPreview> {
  const project = await getProjectView(projectId);
  return previewProjectMutation({
    kind: 'delete_scheduler',
    projectId,
    baseSpecHash: project.specHash,
    agentName,
  });
}

function schedulerSpecFromInput(input: SaveAutomationTaskInput): SchedulerEditableSpec {
  return {
    enabled: input.enabled,
    displayName: input.name.trim(),
    description: input.description.trim(),
    script: input.script,
    sandboxPolicy: toProjectSandboxPolicy(input.sessionPolicy),
    concurrencyPolicy: input.concurrencyPolicy.trim(),
    triggers: (input.triggers ?? []).map(
      (trigger) => triggerSpecFromInput(trigger).toJson() as Record<string, unknown>,
    ),
  };
}

export async function setAutomationTaskEnabled(
  projectId: string,
  agentName: string,
  enabled: boolean,
): Promise<AutomationTask> {
  const response = await projectClient.setSchedulerEnabled({
    project: projectById(projectId),
    agentName,
    enabled,
  });
  if (!response.scheduler) throw new Error('自动化任务不存在');
  return taskFromProjectScheduler(response.scheduler);
}

export async function setAutomationTriggerEnabled(
  projectId: string,
  agentName: string,
  triggerId: string,
  enabled: boolean,
): Promise<AutomationTaskDetail> {
  await projectClient.setSchedulerTriggerEnabled({
    project: projectById(projectId),
    agentName,
    triggerId,
    enabled,
  });
  return getAutomationTask(projectId, agentName);
}

export async function validateAutomationTask(script: string, runtime: string): Promise<ValidateAutomationTaskResult> {
  if (runtime !== 'scheduler') throw new Error(`不支持的自动化运行时：${runtime}`);
  const response = await projectClient.validateProject({
    spec: {
      name: 'ui-automation-validation',
      agents: [
        {
          name: 'automation',
          provider: 'codex',
          scheduler: {
            enabled: true,
            script,
            sandboxPolicy: schedulerSandboxPolicyFromString('sticky'),
            triggers: [],
          },
        },
      ],
    },
  });
  const errors = response.issues.filter((issue) => issue.severity === ProjectValidationSeverity.ERROR);
  if (!response.valid || errors.length > 0) {
    const details = (errors.length > 0 ? errors : response.issues)
      .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
      .filter(Boolean)
      .join('\n');
    throw new Error(details || '自动化脚本校验失败');
  }
  return {
    triggers: [],
    warnings: response.issues
      .filter((issue) => issue.severity === ProjectValidationSeverity.WARNING)
      .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message)),
  };
}

export async function runAutomationTaskNow(
  projectId: string,
  agentName: string,
  payloadJson: string,
  triggerId = '',
): Promise<AutomationRun> {
  const task = await getAutomationTask(projectId, agentName);
  const effectiveTriggerId = triggerId || task.triggers[0]?.triggerId;
  if (!effectiveTriggerId) throw new Error('自动化没有可用的触发条件');
  const response = await projectClient.runScheduler({
    project: projectById(projectId),
    agentName,
    triggerId: effectiveTriggerId,
    payloadJson,
  });
  if (!response.run) throw new Error('自动化任务运行失败');
  const result = runFromScheduler(response.run);
  result.agentRunId = await findLinkedAgentRunId(response.run);
  return result;
}

export async function getAutomationRun(projectId: string, runId: string): Promise<AutomationRun> {
  const response = await projectClient.getSchedulerRun({ project: projectById(projectId), runId });
  if (!response.run) throw new Error('自动化运行不存在');
  return runFromScheduler(response.run);
}

export async function stopAutomationRun(
  projectId: string,
  runId: string,
  reason = '',
): Promise<{ run: AutomationRun; stopRequested: boolean }> {
  const response = await projectClient.stopSchedulerRun({
    project: projectById(projectId),
    runId,
    reason,
  });
  if (!response.run) throw new Error('自动化运行不存在');
  return { run: runFromScheduler(response.run), stopRequested: response.stopRequested };
}

export async function listAutomationEvents(
  projectId: string,
  agentName: string,
  limit = 50,
): Promise<AutomationEvent[]> {
  const response = await projectClient.listSchedulerEvents({
    project: projectById(projectId),
    agentName,
    limit,
  });
  return response.events.map((item) => ({
    id: item.id,
    loaderId: item.schedulerId,
    runId: item.runId,
    triggerId: item.triggerId,
    type: item.type,
    level: item.level,
    message: item.message,
    payloadJson: item.payloadJson,
    linkedSessionId: item.linkedSandboxId,
    linkedCellId: item.linkedCellId,
    linkedAgentSessionId: item.linkedAgentThreadId,
    createdAt: timestampString(item.createdAt),
    topicEventId: topicEventIdFromPayload(item.payloadJson),
  }));
}

async function loadProject(projectId: string): Promise<Project> {
  const response = await projectClient.getProject({ project: projectById(projectId), includeSpec: true });
  if (!response.project) throw new Error('项目不存在');
  return response.project;
}
function taskFromProjectScheduler(item: ProjectScheduler, runCount = 0, latestRun?: SchedulerRun): AutomationTask {
  return {
    id: item.schedulerId,
    projectId: item.projectId,
    name: item.displayName.trim() || item.agentName,
    description: item.description.trim(),
    enabled: item.enabled,
    runtime: 'scheduler',
    workspaceId: '',
    agentId: item.agentName,
    agentName: item.agentName,
    capsetIds: [],
    defaultAgent: '',
    triggerCount: item.triggerCount,
    runCount,
    eventCount: 0,
    latestRunAt: timestampString(latestRun?.startedAt),
    lastError: latestRun?.error ?? '',
    createdAt: '',
    updatedAt: '',
    driver: '',
    guestImage: '',
    sessionPolicy: 'new_session',
    concurrencyPolicy: 'skip',
  };
}
function triggerSpecFromInput(input: AutomationTriggerInput): TriggerSpec {
  const sandboxPolicy = input.sandboxPolicy?.trim() ?? '';
  return new TriggerSpec({
    name: input.name.trim(),
    kind: triggerKindFromString(input.kind),
    cron: input.cron?.trim() ?? '',
    timezone: input.timezone?.trim() ?? '',
    interval: input.interval?.trim() ?? '',
    timeout: input.timeout?.trim() ?? '',
    event: input.kind.trim() === 'event' ? new EventTriggerSpec({ topic: input.topic?.trim() ?? '' }) : undefined,
    prompt: input.prompt?.trim() ?? '',
    sandboxPolicy: sandboxPolicy ? schedulerSandboxPolicyFromString(toProjectSandboxPolicy(sandboxPolicy)) : undefined,
  });
}
function triggerInputFromSpec(spec: TriggerSpec): AutomationTriggerInput {
  return {
    name: spec.name,
    kind: triggerKindToString(spec.kind),
    cron: spec.cron,
    timezone: spec.timezone,
    interval: spec.interval,
    timeout: spec.timeout,
    topic: spec.event?.topic ?? '',
    prompt: spec.prompt,
    sandboxPolicy: schedulerSandboxPolicyToString(spec.sandboxPolicy),
  };
}
function triggerFromResolved(item: ResolvedTrigger): AutomationTrigger {
  const spec = item.spec;
  const duration = spec?.interval || spec?.timeout || '';
  return {
    loaderId: '',
    triggerId: item.triggerId,
    kind: spec ? triggerKindToString(spec.kind) : '',
    topic: spec?.event?.topic ?? '',
    intervalMs: duration ? parseDuration(duration) : 0,
    enabled: item.enabled,
    autoId: false,
    specJson: spec ? JSON.stringify(spec.toJson()) : '',
    nextFireAt: timestampString(item.nextFireAt),
    lastFiredAt: timestampString(item.lastFiredAt),
    name: spec?.name ?? '',
    prompt: spec?.prompt ?? '',
  };
}
function runFromScheduler(item: SchedulerRun): AutomationRun {
  return {
    id: item.runId,
    agentRunId: '',
    loaderId: item.schedulerId,
    triggerId: item.triggerId,
    triggerKind: triggerKindToString(item.triggerKind),
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

async function findLinkedAgentRunId(schedulerRun: SchedulerRun): Promise<string> {
  const sandboxIds = new Set(schedulerRun.sandboxIds);
  const response = await runClient.listRuns({ source: RunSource.SCHEDULER, limit: 200 });
  return (
    response.runs.find(
      (run) =>
        run.projectId === schedulerRun.projectId &&
        run.agentName === schedulerRun.agentName &&
        run.schedulerId === schedulerRun.schedulerId &&
        run.triggerId === schedulerRun.triggerId &&
        (sandboxIds.size === 0 || sandboxIds.has(run.sandboxId)),
    )?.runId ?? ''
  );
}

function schedulerRunStatus(status: SchedulerRunStatus): string {
  switch (status) {
    case SchedulerRunStatus.RUNNING:
      return 'RUNNING';
    case SchedulerRunStatus.SUCCEEDED:
      return 'SUCCEEDED';
    case SchedulerRunStatus.FAILED:
      return 'FAILED';
    case SchedulerRunStatus.CANCELED:
      return 'CANCELED';
    case SchedulerRunStatus.SKIPPED:
      return 'SKIPPED';
    default:
      return 'UNSPECIFIED';
  }
}
function parseDuration(value: string) {
  const match = value.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/);
  if (!match) return 0;
  const multiplier = { ms: 1, s: 1000, m: 60000, h: 3600000 }[match[2] as 'ms' | 's' | 'm' | 'h'];
  return Number(match[1]) * multiplier;
}

export async function getTopicEvent(eventId: string): Promise<TopicEvent> {
  const response = await apiFetchJson<{ event: TopicEventResponse }>(`/api/events/${encodeURIComponent(eventId)}`);
  return topicEventFromResponse(response.event);
}

export async function listTopicEvents(input: {
  topic?: string;
  correlationId?: string;
  offset?: number;
  limit?: number;
}): Promise<{ items: TopicEvent[]; total: number }> {
  const query = new URLSearchParams();
  query.set('source', 'webhook');
  query.set('view', 'summary');
  if (input.topic?.trim()) query.set('topic', input.topic.trim());
  if (input.correlationId?.trim()) query.set('correlation_id', input.correlationId.trim());
  query.set('offset', String(input.offset ?? 0));
  query.set('limit', String(input.limit ?? 100));
  const response = await apiFetchJson<{ items?: TopicEventResponse[]; total?: number }>(
    `/api/events?${query.toString()}`,
  );
  return {
    items: (response.items ?? []).map(topicEventFromResponse),
    total: Number(response.total ?? 0),
  };
}

export async function listEventTopics(): Promise<EventTopic[]> {
  const items: EventTopic[] = [];
  let offset = 0;
  for (;;) {
    const query = new URLSearchParams({ source: 'webhook', offset: String(offset), limit: '500' });
    const response = await apiFetchJson<{ items?: EventTopicResponse[]; total?: number }>(
      `/api/events/topics?${query.toString()}`,
    );
    const page = (response.items ?? []).map((item) => ({
      topic: item.topic,
      eventCount: Number(item.event_count || 0),
      latestEventAt: item.latest_event_at,
    }));
    items.push(...page);
    offset += page.length;
    if (page.length === 0 || offset >= Number(response.total ?? 0)) return items;
  }
}

export async function getTopicEventTrace(eventId: string): Promise<TopicEventTrace> {
  const response = await apiFetchJson<TopicEventTraceResponse>(`/api/events/${encodeURIComponent(eventId)}/trace`);
  const event = topicEventFromResponse(response.event);
  return {
    event,
    descendantsTruncated: Boolean(response.descendants_truncated),
    runs: (response.runs ?? []).map((item) => ({
      delivery: {
        eventId: item.delivery.event_id,
        schedulerId: item.delivery.scheduler_id,
        runId: item.delivery.run_id || '',
        triggerId: item.delivery.trigger_id,
        status: item.delivery.status,
        error: item.delivery.error || '',
        createdAt: item.delivery.created_at,
        updatedAt: item.delivery.updated_at,
      },
      scheduler: item.scheduler
        ? {
            id: item.scheduler.scheduler_id,
            projectId: item.scheduler.project_id,
            agentName: item.scheduler.agent_name,
            name: item.scheduler.name,
          }
        : null,
      run: item.run
        ? {
            id: item.run.run_id,
            status: item.run.status,
            startedAt: item.run.started_at,
            completedAt: item.run.completed_at || '',
            durationMs: Number(item.run.duration_ms || 0),
            error: item.run.error || '',
          }
        : null,
      events: (item.events ?? []).map((schedulerEvent) => ({
        id: schedulerEvent.event_id,
        loaderId: item.delivery.scheduler_id,
        runId: item.delivery.run_id || '',
        triggerId: item.delivery.trigger_id,
        type: schedulerEvent.type,
        level: schedulerEvent.level,
        message: schedulerEvent.message,
        payloadJson: '',
        linkedSessionId: schedulerEvent.linked_sandbox_id || '',
        linkedCellId: '',
        linkedAgentSessionId: '',
        createdAt: schedulerEvent.created_at,
        topicEventId: event.eventId,
      })),
    })),
    sandboxes: (response.sandboxes ?? []).map((item) => ({
      link: {
        sandboxId: item.sandbox_id,
        relation: item.relation,
        schedulerId: item.scheduler_id || '',
        runId: item.run_id || '',
        triggerId: item.trigger_id || '',
        schedulerEventId: item.scheduler_event_id || '',
        eventId: item.event_id,
        createdAt: item.created_at,
      },
      sandbox: item.sandbox
        ? {
            id: item.sandbox.sandbox_id,
            title: item.sandbox.title,
            status: item.sandbox.status,
            projectId: item.sandbox.project_id || '',
            agentName: item.sandbox.agent_name || '',
            createdAt: item.sandbox.created_at,
            updatedAt: item.sandbox.updated_at,
          }
        : null,
    })),
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

type EventTopicResponse = {
  topic: string;
  event_count: number;
  latest_event_at: string;
};

type TopicEventRunResponse = {
  event_id: string;
  scheduler_id: string;
  run_id?: string;
  trigger_id: string;
  status: string;
  error?: string;
  created_at: string;
  updated_at: string;
};

type TopicEventTraceResponse = {
  event: TopicEventResponse;
  descendants_truncated?: boolean;
  runs?: Array<{
    delivery: TopicEventRunResponse;
    scheduler?: { scheduler_id: string; project_id: string; agent_name: string; name: string };
    run?: {
      run_id: string;
      status: string;
      started_at: string;
      completed_at?: string;
      duration_ms: number;
      error?: string;
    };
    events?: Array<{
      event_id: string;
      type: string;
      level: string;
      message: string;
      linked_sandbox_id?: string;
      created_at: string;
    }>;
  }>;
  sandboxes?: Array<{
    event_id: string;
    sandbox_id: string;
    relation: string;
    scheduler_id?: string;
    run_id?: string;
    trigger_id?: string;
    scheduler_event_id?: string;
    created_at: string;
    sandbox?: {
      sandbox_id: string;
      title: string;
      status: string;
      project_id?: string;
      agent_name?: string;
      created_at: string;
      updated_at: string;
    };
  }>;
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
