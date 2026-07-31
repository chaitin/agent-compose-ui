import { RunSource, type RunSummary } from '../gen/agentcompose/v2/agentcompose_pb.js';
import { timestampToISOString } from '../model/timestamps';
import { listAutomationTasks, listRecentAutomationRuns, type AutomationRun, type AutomationTask } from './loaders';
import { listRuns, runStatusName } from './runs';

const ACTIVITY_LIMIT = 20;
const SOURCE_LIMIT = 60;

export type DashboardActivity = {
  id: string;
  name: string;
  status: string;
  triggerKind: string;
  triggerSource: string;
  startedAt: string;
  updatedAt: string;
  durationMs: number;
  projectRunId: string;
  schedulerRunId: string;
  schedulerId: string;
  sandboxId: string;
};

export type DashboardOverview = {
  runningCount: number;
  recentCount: number;
  attentionCount: number;
  updatedAt: string;
  activities: DashboardActivity[];
};

export async function getDashboardOverview(): Promise<DashboardOverview> {
  const [projectRuns, tasks] = await Promise.all([listRuns({ limit: SOURCE_LIMIT }), listAutomationTasks()]);
  const schedulerRuns = await listRecentAutomationRuns(
    tasks.map((task) => task.id),
    SOURCE_LIMIT,
  );
  return buildDashboardOverview(projectRuns, schedulerRuns, tasks);
}

function buildDashboardOverview(
  projectRuns: RunSummary[],
  schedulerRuns: AutomationRun[],
  tasks: AutomationTask[],
): DashboardOverview {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const representedSchedulerRuns = new Set<string>();
  const projectActivities = projectRuns.map((run) => {
    const linkedSchedulerRun = findLinkedSchedulerRun(run, schedulerRuns, tasksById);
    if (linkedSchedulerRun) representedSchedulerRuns.add(linkedSchedulerRun.id);
    return projectActivity(run, linkedSchedulerRun);
  });
  const schedulerActivities = schedulerRuns
    .filter((run) => !representedSchedulerRuns.has(run.id))
    .map((run) => schedulerActivity(run, tasksById.get(run.loaderId)));
  const allActivities = [...projectActivities, ...schedulerActivities].sort(
    (left, right) => activityTimestamp(right) - activityTimestamp(left),
  );

  return {
    runningCount: allActivities.filter((activity) => isRunning(activity.status)).length,
    recentCount: allActivities.length,
    attentionCount: allActivities.filter((activity) => needsAttention(activity.status)).length,
    updatedAt: new Date().toISOString(),
    activities: allActivities.slice(0, ACTIVITY_LIMIT),
  };
}

function projectActivity(run: RunSummary, linkedSchedulerRun?: AutomationRun): DashboardActivity {
  const startedAt = timestampToISOString(run.startedAt || run.createdAt);
  return {
    id: `project:${run.runId}`,
    name: displayName(run.projectName, run.agentName),
    status: runStatusName(run.status),
    triggerKind: linkedSchedulerRun?.triggerKind ?? '',
    triggerSource: linkedSchedulerRun?.triggerSource ?? runSource(run.source),
    startedAt,
    updatedAt: timestampToISOString(run.updatedAt || run.completedAt || run.startedAt || run.createdAt),
    durationMs: Number(run.durationMs),
    projectRunId: run.runId,
    schedulerRunId: '',
    schedulerId: run.schedulerId,
    sandboxId: run.sandboxId,
  };
}

function schedulerActivity(run: AutomationRun, task?: AutomationTask): DashboardActivity {
  return {
    id: `scheduler:${run.id}`,
    name: displayName(task?.name ?? '', task?.agentName ?? ''),
    status: run.status,
    triggerKind: run.triggerKind,
    triggerSource: run.triggerSource,
    startedAt: run.startedAt,
    updatedAt: run.completedAt || run.startedAt,
    durationMs: run.durationMs,
    projectRunId: '',
    schedulerRunId: run.id,
    schedulerId: run.loaderId,
    sandboxId: '',
  };
}

function findLinkedSchedulerRun(
  projectRun: RunSummary,
  schedulerRuns: AutomationRun[],
  tasksById: Map<string, AutomationTask>,
): AutomationRun | undefined {
  if (projectRun.source !== RunSource.SCHEDULER || !projectRun.schedulerId) return undefined;
  const projectStartedAt = timestampValue(timestampToISOString(projectRun.startedAt || projectRun.createdAt));
  return schedulerRuns.find((schedulerRun) => {
    if (schedulerRun.loaderId !== projectRun.schedulerId) return false;
    if (projectRun.triggerId && schedulerRun.triggerId && projectRun.triggerId !== schedulerRun.triggerId) return false;
    const task = tasksById.get(schedulerRun.loaderId);
    if (task && (task.projectId !== projectRun.projectId || task.agentName !== projectRun.agentName)) return false;
    if (!projectStartedAt) return true;
    const schedulerStartedAt = timestampValue(schedulerRun.startedAt);
    const schedulerCompletedAt = timestampValue(schedulerRun.completedAt) || Date.now();
    return schedulerStartedAt <= projectStartedAt + 5_000 && projectStartedAt <= schedulerCompletedAt + 60_000;
  });
}

function displayName(owner: string, agent: string): string {
  const normalizedOwner = owner.trim();
  const normalizedAgent = agent.trim();
  if (normalizedOwner && normalizedAgent && normalizedOwner !== normalizedAgent) {
    return `${normalizedOwner} / ${normalizedAgent}`;
  }
  return normalizedOwner || normalizedAgent;
}

function runSource(source: RunSource): string {
  if (source === RunSource.MANUAL) return 'manual';
  if (source === RunSource.API) return 'api';
  if (source === RunSource.SCHEDULER) return 'scheduler';
  return '';
}

function activityTimestamp(activity: DashboardActivity): number {
  return timestampValue(activity.updatedAt || activity.startedAt);
}

function timestampValue(value: string): number {
  const timestamp = value ? new Date(value).getTime() : 0;
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function isRunning(status: string): boolean {
  return ['running', 'pending', 'active', 'processing'].includes(status.trim().toLowerCase());
}

function needsAttention(status: string): boolean {
  return ['failed', 'error', 'skipped', 'stopped', 'canceled', 'cancelled'].includes(status.trim().toLowerCase());
}
