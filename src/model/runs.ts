import type { AutomationRun } from '../api/loaders';
import type { CellType } from '../api/sessions';
import type { WorkSession } from '../api/sessions';

export type ProductRun = {
  id: string;
  title: string;
  type: 'work_session' | 'automation_run';
  status: string;
  agentId: string;
  agent: string;
  automationId: string;
  automation: string;
  sourceSessionTags: Array<{ name: string; value: string }>;
  trigger: string;
  capabilitySet: string;
  workspace: string;
  startedAt: string;
  completedAt: string;
  duration: string;
  rawStatus: string;
  agentProvider: string;
  messageCount: number;
  eventCount: number;
  errorSummary: string;
  output: string;
  input: string;
  messages: Array<{
    id?: string;
    runId?: string;
    renderKey?: string;
    role: 'user' | 'agent' | 'system';
    type?: CellType;
    agent?: string;
    source?: string;
    content: string;
    at: string;
    running?: boolean;
    streamingComplete?: boolean;
    failed?: boolean;
    success?: boolean;
    exitCode?: number;
    stopReason?: string;
    agentSessionId?: string;
  }>;
  events: Array<{ type: string; level: string; message: string; createdAt: string }>;
  artifacts: Array<{ name: string; mimeType: string; size: string; source: string }>;
};

export function sessionToRun(session: WorkSession): ProductRun {
  const agentID = tagValue(session.tags, 'agent_id');
  const agentName = tagValue(session.tags, 'agent_name') || tagValue(session.tags, 'agent') || tagValue(session.tags, 'agent_definition') || tagValue(session.tags, 'agent_template');
  const loaderID = tagValue(session.tags, 'loader_id');
  const loaderName = tagValue(session.tags, 'loader_name');
  return {
    id: session.id,
    title: session.title || session.id,
    type: 'work_session',
    status: mapSessionStatus(session.status),
    agentId: agentID,
    agent: agentName,
    automationId: loaderID,
    automation: loaderName || (loaderID ? loaderID : '-'),
    sourceSessionTags: session.tags.map((tag) => ({ name: tag.name, value: tag.value })),
    trigger: mapTriggerLabel(session.triggerSource || 'manual'),
    capabilitySet: '',
    workspace: session.workspacePath,
    startedAt: session.createdAt,
    completedAt: session.updatedAt,
    duration: '-',
    rawStatus: session.status,
    agentProvider: '',
    messageCount: Number(session.cellCount || 0),
    eventCount: Number(session.eventCount || 0),
    errorSummary: '',
    output: '',
    input: '',
    messages: [],
    events: [],
    artifacts: [],
  };
}

export function automationRunToRun(run: AutomationRun): ProductRun {
  return {
    id: run.id,
    title: run.id,
    type: 'automation_run',
    status: mapLoaderRunStatus(run.status),
    agentId: '',
    agent: '',
    automationId: run.loaderId,
    automation: run.loaderId,
    sourceSessionTags: [],
    trigger: mapTriggerLabel(run.triggerSource || run.triggerKind || '-'),
    capabilitySet: '',
    workspace: '',
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    duration: run.durationMs > 0 ? `${Math.round(run.durationMs / 1000)}s` : '-',
    rawStatus: run.status,
    agentProvider: '',
    messageCount: 0,
    eventCount: 0,
    errorSummary: run.error,
    output: run.resultJson || run.error,
    input: run.payloadJson,
    messages: [],
    events: [],
    artifacts: run.artifactsDir ? [{ name: run.artifactsDir, mimeType: 'directory', size: '-', source: 'loader' }] : [],
  };
}

export function mapSessionStatus(status: string): string {
  const normalized = status.toUpperCase();
  if (normalized === 'PENDING') {
    return '等待中';
  }
  if (normalized === 'STARTING') {
    return '启动中';
  }
  if (normalized === 'RUNNING') {
    return '运行中';
  }
  if (normalized === 'FAILED' || normalized === 'START_FAILED') {
    return '启动失败';
  }
  if (normalized === 'STOPPED') {
    return '已停止';
  }
  return status || '未知';
}

export function mapLoaderRunStatus(status: string): string {
  const normalized = status.toUpperCase();
  if (normalized === 'PENDING') {
    return '等待中';
  }
  if (normalized === 'RUNNING') {
    return '运行中';
  }
  if (normalized === 'SUCCEEDED' || normalized === 'SUCCESS') {
    return '成功';
  }
  if (normalized === 'FAILED' || normalized === 'FAILURE') {
    return '失败';
  }
  if (normalized === 'CANCELED' || normalized === 'CANCELLED') {
    return '已取消';
  }
  if (normalized === 'SKIPPED') {
    return '跳过';
  }
  return status || '未知';
}

/**
 * Canonical status -> color tone for badges/pills across the app.
 * In-progress states are blue, terminal-success green, failures red, else gray.
 * Expects a localized status label (e.g. from mapSessionStatus / mapLoaderRunStatus).
 */
export function statusTone(status: string): 'blue' | 'green' | 'red' | 'gray' {
  if (['启动失败', '失败', '跳过', '已取消'].includes(status)) return 'red';
  if (['成功', '已停止'].includes(status)) return 'green';
  if (['运行中'].includes(status)) return 'blue';
  return 'gray';
}

function mapTriggerLabel(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized === '1' || normalized.includes('interval')) return '周期触发';
  if (normalized === '2' || normalized.includes('event')) return '事件触发';
  if (normalized === '3' || normalized.includes('timeout')) return '延迟触发';
  if (normalized === '4' || normalized.includes('cron')) return '定时触发';
  if (normalized.includes('manual') || normalized.includes('对话')) return '手动触发';
  return value || '-';
}

function tagValue(tags: Array<{ name: string; value: string }>, name: string): string {
  return tags.find((tag) => tag.name === name)?.value || '';
}
