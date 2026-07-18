import {
  ListRunEventsRequest,
  RunEventKind,
  type ListRunEventsResponse,
  type RunEvent,
} from '../gen/agentcompose/v2/agentcompose_pb';

export type AgentRunTranscriptKind = 'process' | 'command' | 'tool' | 'file' | 'diagnostic';

export interface AgentRunTranscriptSegment {
  kind: AgentRunTranscriptKind;
  label: string;
  content: string;
}

export interface StructuredRunTranscriptEntry extends AgentRunTranscriptSegment {
  id: string;
  seq: bigint;
  timestamp: string;
  agent: string;
  name: string;
}

export async function listAllRunEvents(
  runId: string,
  fetchPage: (request: ListRunEventsRequest) => Promise<ListRunEventsResponse>,
): Promise<{ events: RunEvent[]; historyAvailable: boolean }> {
  const events: RunEvent[] = [];
  const seenCursors = new Set<string>();
  let cursor = '';
  let historyAvailable = true;

  do {
    const response = await fetchPage(new ListRunEventsRequest({ runId, limit: 100, cursor }));
    events.push(...response.events);
    historyAvailable &&= response.historyAvailable;
    if (!response.nextCursor || seenCursors.has(response.nextCursor)) break;
    seenCursors.add(response.nextCursor);
    cursor = response.nextCursor;
  } while (cursor);

  return {
    events: events.sort((left, right) => left.seq < right.seq ? -1 : left.seq > right.seq ? 1 : 0),
    historyAvailable,
  };
}

function structuredLabel(event: RunEvent): Pick<AgentRunTranscriptSegment, 'kind' | 'label'> {
  switch (event.kind) {
    case RunEventKind.USER_MESSAGE:
      return { kind: 'process', label: '用户消息' };
    case RunEventKind.AGENT_MESSAGE:
      return { kind: 'process', label: event.agent ? `智能体消息 · ${event.agent}` : '智能体消息' };
    case RunEventKind.AGENT_ACTIVITY:
      return event.name.toLowerCase().includes('command')
        ? { kind: 'command', label: '命令执行' }
        : { kind: 'tool', label: event.name ? `智能体活动 · ${event.name}` : '智能体活动' };
    case RunEventKind.STATUS:
      return { kind: event.success ? 'process' : 'diagnostic', label: '运行状态' };
    default:
      return { kind: 'process', label: event.name || '运行事件' };
  }
}

function eventTimestamp(event: RunEvent): string {
  if (!event.createdAt) return '';
  return new Date(Number(event.createdAt.seconds) * 1000 + event.createdAt.nanos / 1_000_000).toISOString();
}

function eventContent(event: RunEvent): string {
  const parts = [event.text, event.payloadJson];
  if (event.kind === RunEventKind.AGENT_ACTIVITY || event.kind === RunEventKind.STATUS) {
    parts.push(`${event.success ? '成功' : '失败'} · 退出码 ${event.exitCode}`);
  }
  if (event.stopReason) parts.push(`停止原因：${event.stopReason}`);
  return parts.filter(Boolean).join('\n');
}

export function mapRunEventsToTranscript(events: RunEvent[]): StructuredRunTranscriptEntry[] {
  return [...events]
    .sort((left, right) => left.seq < right.seq ? -1 : left.seq > right.seq ? 1 : 0)
    .map((event) => ({
      ...structuredLabel(event),
      id: event.id || `run-event-${event.seq}`,
      seq: event.seq,
      timestamp: eventTimestamp(event),
      agent: event.agent,
      name: event.name,
      content: eventContent(event),
    }));
}

function classify(line: string): Omit<AgentRunTranscriptSegment, 'content'> | null {
  const text = line.replace(/\r?\n$/, '');
  if (/^\$\s+/.test(text)) return { kind: 'command', label: '命令执行' };
  const tool = text.match(/^\[tool:([^\]]+)]\s*$/);
  if (tool) return { kind: 'tool', label: `工具 · ${tool[1]}` };
  const mcp = text.match(/^\[mcp:([^\]]+)]\s*$/);
  if (mcp) return { kind: 'tool', label: `MCP · ${mcp[1]}` };
  if (/^\[web_search](?:\s|$)/.test(text)) return { kind: 'tool', label: 'Web Search' };
  if (/^\[file_change]\s*$/.test(text)) return { kind: 'file', label: '文件变更' };
  if (/^\[todo]\s*$/.test(text)) return { kind: 'process', label: '任务进度' };
  if (/^\[hook:[^\]]+]\s*$/.test(text)) return { kind: 'tool', label: 'Hook' };
  if (/^(?:error|fatal|panic)(?:\b|:)/i.test(text)) return { kind: 'diagnostic', label: '执行错误' };
  return null;
}

export function parseAgentRunTranscript(content: string): AgentRunTranscriptSegment[] {
  if (!content) return [];
  const lines = content.match(/.*?(?:\r\n|\n|$)/g)?.filter(Boolean) ?? [content];
  const segments: AgentRunTranscriptSegment[] = [];
  let blockEnded = false;

  for (const line of lines) {
    const classified = classify(line);
    if (classified) {
      segments.push({ ...classified, content: line });
      blockEnded = false;
      continue;
    }
    const current = segments.at(-1);
    if (current && current.kind !== 'diagnostic' && !blockEnded) {
      current.content += line;
    } else {
      segments.push({ kind: 'process', label: '执行输出', content: line });
    }
    const active = segments.at(-1);
    blockEnded = Boolean(active && active.kind !== 'process' && /^\s*$/.test(line));
  }
  return segments;
}

export function joinAgentRunTranscriptSegments(segments: AgentRunTranscriptSegment[]): string {
  return segments.map((segment) => segment.content).join('');
}
