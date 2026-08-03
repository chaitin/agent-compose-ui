export type AgentRecordCategory = 'conversation' | 'tool' | 'activity' | 'error' | 'system';

export type AgentRecordEvent = {
  id: string;
  timestamp: string;
  type: string;
  category: AgentRecordCategory;
  title: string;
  summary: string;
  raw: string;
  formatted: string;
};

type JsonObject = Record<string, unknown>;

export function parseAgentRecordEvents(content: string, provider: string): AgentRecordEvent[] {
  const events: AgentRecordEvent[] = [];
  for (const [index, line] of content.split('\n').entries()) {
    const raw = line.trim();
    if (!raw) continue;
    try {
      const value = JSON.parse(raw) as JsonObject;
      events.push(normalizeEvent(value, provider, raw, index));
    } catch {
      events.push({
        id: `raw:${index}`,
        timestamp: '',
        type: 'raw',
        category: 'system',
        title: '原始记录',
        summary: raw,
        raw,
        formatted: raw,
      });
    }
  }
  return deduplicate(events);
}

export function agentRecordEventMatches(event: AgentRecordEvent, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [event.title, event.type, event.summary, event.raw].some((value) =>
    value.toLocaleLowerCase().includes(needle),
  );
}

function normalizeEvent(value: JsonObject, provider: string, raw: string, index: number): AgentRecordEvent {
  const payload = objectValue(value.payload);
  const type = stringValue(value.type) || stringValue(payload.type) || 'event';
  const timestamp = stringValue(value.timestamp) || stringValue(value.created_at) || stringValue(payload.timestamp);
  const classification =
    provider.toLowerCase() === 'claude' ? classifyClaude(type, payload) : classifyCodex(type, payload);
  const summary = summarize(type, payload, value, classification.category);
  return {
    id: `${timestamp || 'event'}:${type}:${index}`,
    timestamp,
    type: classification.type,
    category: classification.category,
    title: classification.title,
    summary,
    raw,
    formatted: JSON.stringify(value, null, 2),
  };
}

function classifyCodex(type: string, payload: JsonObject): Pick<AgentRecordEvent, 'category' | 'title' | 'type'> {
  const nestedType = stringValue(payload.type);
  const item = objectValue(payload.item);
  const itemType = stringValue(item.type);
  const role = stringValue(payload.role);
  const effective = itemType || nestedType || type;
  const messageText = contentText(payload.content) || stringValue(payload.message);
  if (effective.includes('error') || effective.includes('failed'))
    return { category: 'error', title: '错误', type: effective };
  if (effective === 'message' && role === 'user' && isInternalContext(messageText))
    return { category: 'system', title: '运行上下文', type: effective };
  if (effective === 'user_message' || (effective === 'message' && role === 'user'))
    return { category: 'conversation', title: '用户输入', type: effective };
  if (effective === 'agent_message' || (effective === 'message' && role === 'assistant'))
    return { category: 'conversation', title: '智能体输出', type: effective };
  if (
    ['command_execution', 'mcp_tool_call', 'web_search', 'file_change', 'function_call', 'tool_call'].includes(
      effective,
    ) ||
    effective.includes('tool_call') ||
    effective.includes('patch_apply')
  )
    return { category: 'tool', title: toolTitle(effective), type: effective };
  if (effective.includes('reasoning') || effective.includes('thinking'))
    return { category: 'activity', title: '思考过程', type: effective };
  if (effective === 'task_started') return { category: 'activity', title: '任务开始', type: effective };
  if (effective === 'task_complete' || effective === 'turn_completed')
    return { category: 'activity', title: '任务完成', type: effective };
  if (effective === 'message' && (role === 'system' || role === 'developer'))
    return { category: 'system', title: role === 'developer' ? '开发者指令' : '系统指令', type: effective };
  if (type === 'session_meta') return { category: 'system', title: '会话开始', type };
  if (['world_state', 'turn_context'].includes(type)) return { category: 'system', title: '运行上下文', type };
  return { category: 'system', title: '系统信息', type: effective };
}

function classifyClaude(type: string, payload: JsonObject): Pick<AgentRecordEvent, 'category' | 'title' | 'type'> {
  const effective = stringValue(payload.type) || type;
  if (effective.includes('error') || effective.includes('failed'))
    return { category: 'error', title: '错误', type: effective };
  if (effective === 'user') return { category: 'conversation', title: '用户输入', type: effective };
  if (effective === 'assistant') return { category: 'conversation', title: '智能体输出', type: effective };
  if (effective.includes('tool')) return { category: 'tool', title: '工具调用', type: effective };
  if (effective.includes('thinking')) return { category: 'activity', title: '思考过程', type: effective };
  if (effective === 'result') return { category: 'activity', title: '任务完成', type: effective };
  if (effective === 'system') return { category: 'system', title: '系统信息', type: effective };
  return { category: 'system', title: '系统信息', type: effective };
}

function summarize(type: string, payload: JsonObject, value: JsonObject, category: AgentRecordCategory): string {
  const item = objectValue(payload.item);
  const direct = firstText(
    payload.message,
    payload.text,
    payload.input,
    payload.stdout,
    payload.stderr,
    item.text,
    item.command,
    value.message,
    value.text,
  );
  if (direct) return compact(direct);
  const content = contentText(payload.content) || contentText(payload.output) || contentText(item.content);
  if (content) return compact(content);
  if (category === 'tool') {
    const name = firstText(item.name, payload.name, payload.tool_name);
    const input = payload.input ?? item.input ?? payload.arguments;
    return compact([name, jsonText(input)].filter(Boolean).join(' · '));
  }
  if (type === 'session_meta') {
    return [
      stringValue(payload.model),
      stringValue(payload.model_provider),
      stringValue(payload.cwd),
      stringValue(payload.cli_version),
    ]
      .filter(Boolean)
      .join(' · ');
  }
  if (stringValue(payload.type) === 'task_started') return '开始处理本轮请求';
  const duration = payload.duration_ms ?? payload.durationMs;
  if (duration !== undefined) return `耗时 ${String(duration)} ms`;
  return compact(jsonText(payload) || jsonText(value));
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((item) => {
      const object = objectValue(item);
      return firstText(object.text, object.input_text, object.output_text, object.thinking);
    })
    .filter(Boolean)
    .join('\n');
}

function toolTitle(type: string): string {
  if (type === 'command_execution') return '命令执行';
  if (type === 'file_change' || type.includes('patch_apply')) return '文件修改';
  if (type === 'web_search') return '网页搜索';
  if (type.includes('output')) return '工具结果';
  return '工具调用';
}

function isInternalContext(value: string): boolean {
  const text = value.trimStart();
  return (
    text.startsWith('<environment_context>') ||
    text.startsWith('<permissions instructions>') ||
    text.startsWith('<collaboration_mode>')
  );
}

function deduplicate(events: AgentRecordEvent[]): AgentRecordEvent[] {
  return events.filter((event, index) => {
    const previous = events[index - 1];
    return !previous || previous.title !== event.title || previous.summary !== event.summary;
  });
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function firstText(...values: unknown[]): string {
  return (values.find((value) => typeof value === 'string' && value.trim()) as string | undefined) || '';
}

function jsonText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function compact(value: string, limit = 280): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}
