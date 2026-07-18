import { parseAgentRunTranscript } from './agent-run-transcript';

export type RuntimeTimelineKind =
  | 'run'
  | 'prompt'
  | 'scheduler'
  | 'sandbox'
  | 'process'
  | 'tool'
  | 'log'
  | 'output'
  | 'result'
  | 'warning'
  | 'error';

export type RuntimeTimelineFilterTag = 'message' | 'activity' | 'run' | 'artifact' | 'problem';

export interface RuntimeTimelineSummary {
  startedAt?: string;
  completedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  exitCode?: number;
  error?: string;
  schedulerId?: string;
  triggerId?: string;
  sandboxId?: string;
}

export interface RuntimeLogChunk {
  data: string;
  createdAt: string;
  sequence: number;
  offset?: bigint;
}

export interface RuntimeTimelineEntry {
  id: string;
  timestamp: string;
  sortTime: number;
  sequence: number;
  kind: RuntimeTimelineKind;
  source: string;
  level: 'debug' | 'info' | 'warning' | 'error';
  content: string;
  timestampInferred: boolean;
  timestampBasis?: 'run-start' | 'run-end' | 'run-updated';
  offset?: bigint;
  filterTags?: RuntimeTimelineFilterTag[];
}

export interface BuildRuntimeTimelineOptions {
  summary: RuntimeTimelineSummary;
  terminal: boolean;
  sourceText: string;
  statusText: string;
  actualPrompt: string;
  output: string;
  resultJson: string;
  warnings: string[];
  cleanupError: string;
  logError: string;
  logChunks: RuntimeLogChunk[];
}

export const runtimeTimelineLabels: Record<RuntimeTimelineKind, string> = {
  run: 'RUN',
  prompt: 'PROMPT',
  scheduler: 'SCHEDULER',
  sandbox: 'SANDBOX',
  process: 'PROCESS',
  tool: 'TOOL',
  log: 'LOG',
  output: 'OUTPUT',
  result: 'RESULT',
  warning: 'WARNING',
  error: 'ERROR',
};

function timestampValue(timestamp: string, fallback: number): number {
  const value = Date.parse(timestamp);
  return Number.isNaN(value) ? fallback : value;
}

function defaultFilterTags(kind: RuntimeTimelineKind): RuntimeTimelineFilterTag[] {
  switch (kind) {
    case 'prompt': return ['message'];
    case 'output': return ['message', 'artifact'];
    case 'result': return ['artifact'];
    case 'log':
    case 'process': return ['activity', 'artifact'];
    case 'tool': return ['activity'];
    case 'warning': return ['problem'];
    case 'error': return ['run', 'problem'];
    case 'run':
    case 'scheduler':
    case 'sandbox': return ['run'];
  }
}

export function buildRuntimeTimeline(options: BuildRuntimeTimelineOptions): RuntimeTimelineEntry[] {
  const { summary } = options;
  const startTimestamp = summary.startedAt || summary.createdAt || summary.updatedAt || '';
  const terminalTimestamp = summary.completedAt || summary.updatedAt || startTimestamp;
  const startTime = timestampValue(startTimestamp, 0);
  const terminalBasis = summary.completedAt ? 'run-end' : 'run-updated';
  const entries: RuntimeTimelineEntry[] = [];
  let sequence = 0;

  function add(
    kind: RuntimeTimelineKind,
    source: string,
    level: RuntimeTimelineEntry['level'],
    content: string,
    timestamp: string,
    timestampInferred: boolean,
    timestampBasis?: RuntimeTimelineEntry['timestampBasis'],
    offset?: bigint,
  ) {
    if (!content) return;
    const itemSequence = sequence++;
    entries.push({
      id: `${kind}-${timestamp || 'unknown'}-${itemSequence}`,
      timestamp,
      sortTime: timestampValue(timestamp, startTime),
      sequence: itemSequence,
      kind,
      source,
      level,
      content,
      timestampInferred,
      ...(timestampBasis ? { timestampBasis } : {}),
      ...(offset === undefined ? {} : { offset }),
      filterTags: defaultFilterTags(kind),
    });
  }

  const hasStartedAt = Boolean(summary.startedAt);
  add('run', 'run', 'info', `运行开始 · ${options.sourceText}`, startTimestamp, !hasStartedAt, hasStartedAt ? undefined : 'run-start');
  add('prompt', 'prompt', 'info', options.actualPrompt, startTimestamp, true, 'run-start');
  add('scheduler', 'scheduler', 'info', summary.schedulerId || '', startTimestamp, true, 'run-start');
  add('scheduler', 'trigger', 'info', summary.triggerId || '', startTimestamp, true, 'run-start');
  add('sandbox', 'sandbox', 'info', summary.sandboxId || '', startTimestamp, true, 'run-start');

  for (const chunk of options.logChunks) {
    const hasTimestamp = Boolean(chunk.createdAt);
    for (const segment of parseAgentRunTranscript(chunk.data)) {
      add(
        segment.kind === 'tool' ? 'tool' : segment.kind === 'diagnostic' ? 'error' : 'process',
        segment.label,
        segment.kind === 'diagnostic' ? 'error' : 'info',
        segment.content,
        chunk.createdAt || startTimestamp,
        !hasTimestamp,
        hasTimestamp ? undefined : 'run-start',
        chunk.offset,
      );
    }
  }

  add('output', 'output', 'info', options.output, terminalTimestamp, true, terminalBasis);
  add('result', 'result', 'info', options.resultJson, terminalTimestamp, true, terminalBasis);
  for (const warning of options.warnings) {
    add('warning', 'run', 'warning', warning, terminalTimestamp, true, terminalBasis);
  }
  add('error', 'run', 'error', summary.error || '', terminalTimestamp, true, terminalBasis);
  add('error', 'cleanup', 'error', options.cleanupError, terminalTimestamp, true, terminalBasis);
  add('error', 'log', 'error', options.logError, terminalTimestamp, true, terminalBasis);
  if (options.terminal && summary.exitCode !== undefined) {
    add('run', 'run', summary.exitCode === 0 ? 'info' : 'error', `退出码 ${summary.exitCode}`, terminalTimestamp, true, terminalBasis);
  }
  if (summary.completedAt) {
    add('run', 'run', summary.error ? 'error' : 'info', `运行结束 · ${options.statusText}`, terminalTimestamp, false);
  }

  return entries.sort((left, right) => left.sortTime - right.sortTime || left.sequence - right.sequence);
}
