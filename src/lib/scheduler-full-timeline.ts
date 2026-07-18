import {
  RunEventKind,
  type RunDetail,
  type RunEvent,
  type SandboxHistoryCell,
  type SchedulerEvent,
} from '../gen/agentcompose/v2/agentcompose_pb';
import type {
  RuntimeTimelineEntry,
  RuntimeTimelineFilterTag,
  RuntimeTimelineKind,
} from './runtime-timeline';

export type FullExecutionSource = 'scheduler-event' | 'sandbox' | 'cell' | 'run-detail' | 'run-event' | 'run-log' | 'source-status';

export interface FullExecutionTimelineEntry extends RuntimeTimelineEntry {
  sourceType: FullExecutionSource;
  sourceId: string;
  parentSourceIds: string[];
  raw: string;
}

export type SourceCompletenessState = 'complete' | 'unavailable' | 'failed' | 'not-applicable';

export interface SourceCompleteness {
  source: string;
  resourceId: string;
  state: SourceCompletenessState;
  error: string;
}

export interface SchedulerExecutionRawData {
  schedulerEvents: SchedulerEvent[];
  sandboxes: Array<{ sandboxId: string; value: unknown; parentSourceIds: string[] }>;
  cells: Array<{ sandboxId: string; cellId: string; value: SandboxHistoryCell; parentSourceIds: string[] }>;
  runDetails: Array<{ runId: string; value: RunDetail; parentSourceIds: string[] }>;
  runEvents: Array<{ runId: string; value: RunEvent; parentSourceIds: string[] }>;
  runLogs: Array<{ runId: string; offset: bigint; data: string; createdAt: string; parentSourceIds: string[] }>;
  sourceStatuses: SourceCompleteness[];
}

interface PendingEntry extends Omit<FullExecutionTimelineEntry, 'id' | 'sequence' | 'sortTime'> {
  stableId: string;
  sourceSequence: bigint;
}

function plainValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plainValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plainValue(child)]));
}

function jsonValue(value: unknown): unknown {
  if (value && typeof value === 'object' && 'toJson' in value && typeof value.toJson === 'function') {
    try {
      return value.toJson();
    } catch {
      return plainValue(value);
    }
  }
  return value;
}

function serialize(value: unknown): string {
  return JSON.stringify(jsonValue(value), (_key, child) => typeof child === 'bigint' ? child.toString() : child, 2) ?? 'null';
}

function protobufTimestamp(value: { seconds: bigint; nanos: number } | undefined): string {
  if (!value) return '';
  if (value.seconds < -62_135_596_800n || value.seconds > 253_402_300_799n) return '';
  if (!Number.isInteger(value.nanos) || value.nanos < 0 || value.nanos > 999_999_999) return '';
  const milliseconds = Number(value.seconds) * 1000 + value.nanos / 1_000_000;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function validTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !value || Number.isNaN(Date.parse(value))) return '';
  return value;
}

function objectTimestamp(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  for (const key of ['createdAt', 'startedAt', 'updatedAt', 'completedAt', 'sampledAt']) {
    const timestamp = validTimestamp(record[key]);
    if (timestamp) return timestamp;
  }
  return '';
}

function uniqueTags(...tags: Array<RuntimeTimelineFilterTag | false>): RuntimeTimelineFilterTag[] {
  return [...new Set(tags.filter((tag): tag is RuntimeTimelineFilterTag => Boolean(tag)))];
}

function levelFrom(error: boolean, warning = false): RuntimeTimelineEntry['level'] {
  return error ? 'error' : warning ? 'warning' : 'info';
}

function derivedSourceId(sourceType: FullExecutionSource, parents: string[], sequence: bigint, raw: string): string {
  return `${parents.join(',')}|${sequence}|${raw}`;
}

function makePending(options: {
  sourceType: FullExecutionSource;
  sourceId: string;
  parentSourceIds: string[];
  raw: string;
  timestamp: string;
  sourceSequence?: bigint;
  kind: RuntimeTimelineKind;
  source: string;
  level?: RuntimeTimelineEntry['level'];
  content: string;
  filterTags: RuntimeTimelineFilterTag[];
  offset?: bigint;
  identityId?: string;
}): PendingEntry {
  const sourceSequence = options.sourceSequence ?? 0n;
  const sourceId = options.sourceId || derivedSourceId(options.sourceType, options.parentSourceIds, sourceSequence, options.raw);
  return {
    stableId: `${options.sourceType}:${options.identityId ?? sourceId}`,
    sourceType: options.sourceType,
    sourceId,
    parentSourceIds: [...options.parentSourceIds],
    raw: options.raw,
    timestamp: validTimestamp(options.timestamp),
    sourceSequence,
    kind: options.kind,
    source: options.source,
    level: options.level ?? 'info',
    content: options.content || options.raw,
    timestampInferred: false,
    filterTags: options.filterTags,
    ...(options.offset === undefined ? {} : { offset: options.offset }),
  };
}

function comparePending(left: PendingEntry, right: PendingEntry): number {
  const leftTime = left.timestamp ? Date.parse(left.timestamp) : Number.POSITIVE_INFINITY;
  const rightTime = right.timestamp ? Date.parse(right.timestamp) : Number.POSITIVE_INFINITY;
  if (leftTime !== rightTime) return leftTime - rightTime;
  if (left.sourceSequence !== right.sourceSequence) return left.sourceSequence < right.sourceSequence ? -1 : 1;
  return left.stableId < right.stableId ? -1 : left.stableId > right.stableId ? 1 : 0;
}

export function buildFullExecutionTimeline(data: SchedulerExecutionRawData): FullExecutionTimelineEntry[] {
  const pending: PendingEntry[] = [];

  data.schedulerEvents.forEach((event) => {
    const raw = serialize(event);
    const error = /error|fatal/i.test(event.level) || event.type.endsWith('.failed');
    const warning = /warn/i.test(event.level) || event.type.endsWith('.warning');
    pending.push(makePending({
      sourceType: 'scheduler-event', sourceId: event.id, parentSourceIds: [], raw,
      timestamp: protobufTimestamp(event.createdAt),
      kind: event.type.startsWith('loader.run.') ? 'run' : event.type.startsWith('loader.sandbox.') ? 'sandbox' : error ? 'error' : 'scheduler',
      source: event.type || 'scheduler', level: levelFrom(error, warning),
      content: [event.message, event.payloadJson].filter(Boolean).join('\n') || raw,
      filterTags: uniqueTags(event.type.startsWith('loader.') ? 'run' : 'activity', Boolean(event.payloadJson) && 'artifact', (error || warning) && 'problem'),
    }));
  });

  data.sandboxes.forEach((item) => {
    const raw = serialize(item.value);
    pending.push(makePending({
      sourceType: 'sandbox', sourceId: item.sandboxId, parentSourceIds: item.parentSourceIds, raw,
      timestamp: objectTimestamp(jsonValue(item.value)), kind: 'sandbox', source: 'sandbox',
      content: raw, filterTags: ['run'],
    }));
  });

  data.cells.forEach((item) => {
    const cell = item.value;
    const raw = serialize(cell);
    const hasProblem = Boolean(cell.stderr) || (!cell.running && !cell.success && cell.exitCode !== 0);
    pending.push(makePending({
      sourceType: 'cell', sourceId: item.cellId || cell.id, parentSourceIds: item.parentSourceIds, raw,
      identityId: `${item.sandboxId}:${item.cellId || cell.id}`,
      timestamp: protobufTimestamp(cell.createdAt),
      kind: hasProblem ? 'error' : cell.output ? 'output' : 'sandbox', source: cell.type || 'sandbox cell',
      level: levelFrom(hasProblem), content: [cell.source, cell.stdout, cell.stderr, cell.output, cell.stopReason].filter(Boolean).join('\n') || raw,
      filterTags: uniqueTags('run', Boolean(cell.source || cell.output) && 'message', 'activity', Boolean(cell.stdout || cell.stderr || cell.output) && 'artifact', hasProblem && 'problem'),
    }));
  });

  data.runDetails.forEach((item) => {
    const detail = item.value;
    const raw = serialize(detail);
    const problem = Boolean(detail.summary?.error || detail.cleanupError || detail.warnings.length);
    pending.push(makePending({
      sourceType: 'run-detail', sourceId: item.runId, parentSourceIds: item.parentSourceIds, raw,
      timestamp: objectTimestamp(detail.summary), kind: problem ? 'error' : 'run', source: 'run detail',
      level: levelFrom(Boolean(detail.summary?.error || detail.cleanupError), detail.warnings.length > 0),
      content: [detail.prompt, detail.output, detail.resultJson, ...detail.warnings, detail.summary?.error, detail.cleanupError].filter(Boolean).join('\n') || raw,
      filterTags: uniqueTags('run', Boolean(detail.prompt || detail.output) && 'message', Boolean(detail.output || detail.resultJson || detail.artifactsDir) && 'artifact', problem && 'problem'),
    }));
  });

  data.runEvents.forEach((item) => {
    const event = item.value;
    const raw = serialize(event);
    const message = event.kind === RunEventKind.USER_MESSAGE || event.kind === RunEventKind.AGENT_MESSAGE;
    const problem = (event.kind === RunEventKind.STATUS || event.kind === RunEventKind.AGENT_ACTIVITY) && !event.success;
    pending.push(makePending({
      sourceType: 'run-event', sourceId: event.id, parentSourceIds: item.parentSourceIds, raw,
      timestamp: protobufTimestamp(event.createdAt), sourceSequence: event.seq, kind: problem ? 'error' : message ? 'process' : 'tool',
      source: event.name || event.agent || 'run event', level: levelFrom(problem),
      content: [event.text, event.payloadJson, event.stopReason].filter(Boolean).join('\n') || raw,
      filterTags: uniqueTags('run', message && 'message', !message && 'activity', Boolean(event.payloadJson) && 'artifact', problem && 'problem'),
    }));
  });

  data.runLogs.forEach((item) => {
    const raw = serialize(item);
    pending.push(makePending({
      sourceType: 'run-log', sourceId: `${item.runId}:${item.offset}`, parentSourceIds: item.parentSourceIds, raw,
      timestamp: item.createdAt, sourceSequence: item.offset, kind: 'log', source: 'run log', content: item.data,
      filterTags: uniqueTags('run', 'activity', 'artifact', /(?:error|fatal|panic)/i.test(item.data) && 'problem'), offset: item.offset,
    }));
  });

  data.sourceStatuses.forEach((status) => {
    if (status.state === 'not-applicable') return;
    const raw = serialize(status);
    const problem = status.state === 'failed' || status.state === 'unavailable';
    pending.push(makePending({
      sourceType: 'source-status', sourceId: `${status.source}:${status.resourceId}`, parentSourceIds: [], raw,
      timestamp: '', kind: problem ? 'warning' : 'run', source: status.source,
      level: levelFrom(status.state === 'failed', status.state === 'unavailable'),
      content: [status.state, status.error].filter(Boolean).join('\n'), filterTags: uniqueTags('run', problem && 'problem'),
    }));
  });

  const unique = new Map<string, PendingEntry>();
  for (const entry of pending) if (!unique.has(entry.stableId)) unique.set(entry.stableId, entry);
  return [...unique.values()].sort(comparePending).map(({ stableId, sourceSequence: _sourceSequence, ...entry }, sequence) => ({
    ...entry,
    id: stableId,
    sortTime: entry.timestamp ? Date.parse(entry.timestamp) : Number.POSITIVE_INFINITY,
    sequence,
  }));
}
