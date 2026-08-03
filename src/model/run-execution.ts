import { RunEventKind, type RunEvent } from '../gen/agentcompose/v2/agentcompose_pb.js';
import type { AgentRecordEvent } from './agent-record-events';
import { timestampToISOString } from './timestamps';

export function buildRunExecutionEvents(
  runEvents: RunEvent[],
  agentEvents: AgentRecordEvent[],
  logs: string,
  completedAt: string,
): AgentRecordEvent[] {
  const conversationText = new Set(
    [
      ...runEvents
        .filter((event) => [RunEventKind.USER_MESSAGE, RunEventKind.AGENT_MESSAGE].includes(event.kind))
        .map((event) => normalize(event.text)),
      ...agentEvents.filter((event) => event.category === 'conversation').map((event) => normalize(event.summary)),
    ].filter(Boolean),
  );
  const items = [
    ...agentEvents.filter((event) => ['tool', 'activity', 'error'].includes(event.category)),
    ...runEvents.flatMap(runEventItem),
  ];
  const output = logs.trim();
  const coveredText = new Set([
    ...conversationText,
    ...items.map((item) => normalizeDiagnostic(item.summary)).filter(Boolean),
  ]);
  if (output && !coveredText.has(normalizeDiagnostic(output))) {
    items.push({
      id: 'run-output',
      timestamp: completedAt,
      type: 'run_output',
      category: 'activity',
      title: '运行输出',
      summary: compact(output),
      raw: output,
      formatted: output,
    });
  }
  return deduplicate(items).sort((left, right) => timestampValue(left.timestamp) - timestampValue(right.timestamp));
}

export function eventWithinRange(timestamp: string, from: string, to: string): boolean {
  if (!timestamp) return true;
  const value = Date.parse(timestamp);
  if (!Number.isFinite(value)) return true;
  const lower = Date.parse(from);
  const upper = Date.parse(to);
  return (!Number.isFinite(lower) || value >= lower) && (!Number.isFinite(upper) || value <= upper);
}

function runEventItem(event: RunEvent): AgentRecordEvent[] {
  if (event.kind !== RunEventKind.AGENT_ACTIVITY && event.kind !== RunEventKind.STATUS) return [];
  const status = event.kind === RunEventKind.STATUS;
  const reason = event.text || event.stopReason || event.name || '';
  const failed = status && /fail|error|失败/i.test(reason);
  const stopped = status && /stop|cancel|停止|取消/i.test(reason);
  const title = event.success ? '运行完成' : failed ? '执行失败' : status ? '状态更新' : '工具活动';
  const summary = event.success ? '成功' : failed ? reason : stopped ? '已停止' : reason;
  return [
    {
      id: `run:${event.id}`,
      timestamp: timestampToISOString(event.createdAt),
      type: status ? 'run_status' : event.name || 'agent_activity',
      category: failed ? 'error' : event.success ? 'activity' : status ? 'system' : 'tool',
      title,
      summary,
      raw: event.payloadJson || event.text,
      formatted: formatted(event.payloadJson || event.text),
    },
  ];
}

function deduplicate(items: AgentRecordEvent[]): AgentRecordEvent[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.category}:${normalize(item.title)}:${normalizeDiagnostic(item.summary)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatted(value: string): string {
  if (!value) return '';
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

function normalizeDiagnostic(value: string): string {
  return normalize(value).replace(/^(?:agent execution failed|codex run failed|claude run failed|error):\s*/i, '');
}

function compact(value: string, limit = 280): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}

function timestampValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}
