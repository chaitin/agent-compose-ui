import type { SandboxContext, SandboxHistoryCell } from '../api/sessions';

export type ConversationTurn = {
  id: string;
  runId: string;
  prompt: string;
  output: string;
  agent?: string;
  createdAt: string;
  success?: boolean;
  stopReason?: string;
};

export type ConversationSummary = {
  sandboxId: string;
  title: string;
  agentName: string;
  status: string;
  driver: string;
  image: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  eventCount: number;
};

export type FailedConversationTurn = {
  id: string;
  runId: string;
  prompt: string;
  output: string;
  error: string;
  createdAt: string;
};

export function conversationTurns(cells: SandboxHistoryCell[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const byRunId = new Map<string, ConversationTurn>();
  for (const cell of cells) {
    // Runs without semantic message history may expose raw log fallback cells. They belong in Run logs, not chat.
    if (cell.stopReason === '旧运行：仅日志记录' && !cell.source) continue;
    const runId = cell.runId?.trim() ?? '';
    let turn = runId ? byRunId.get(runId) : undefined;
    if (!turn) {
      turn = {
        id: cell.id,
        runId,
        prompt: '',
        output: '',
        agent: cell.agent,
        createdAt: cell.createdAt,
        success: cell.success,
        stopReason: cell.stopReason,
      };
      turns.push(turn);
      if (runId) byRunId.set(runId, turn);
    }
    if (cell.source) turn.prompt = cell.source;
    if (cell.output) turn.output = cell.output;
    if (cell.agent) turn.agent = cell.agent;
    turn.success = cell.success;
    if (cell.stopReason) turn.stopReason = cell.stopReason;
  }
  return turns.filter((turn) => turn.prompt || turn.output);
}

export function withFailedConversationTurn(
  turns: ConversationTurn[],
  failure: FailedConversationTurn,
): ConversationTurn[] {
  if (failure.runId && turns.some((turn) => turn.runId === failure.runId))
    return turns.map((turn) =>
      turn.runId === failure.runId && !turn.stopReason && turn.success !== true
        ? {
            ...turn,
            output: turn.output || failure.output,
            success: false,
            stopReason: failure.error || '请求失败',
          }
        : turn,
    );
  return [
    ...turns,
    {
      id: failure.id,
      runId: failure.runId,
      prompt: failure.prompt,
      output: failure.output,
      createdAt: failure.createdAt,
      success: false,
      stopReason: failure.error || '请求失败',
    },
  ];
}

export function conversationSummary(context: SandboxContext): ConversationSummary {
  return {
    sandboxId: context.id,
    title: context.title || context.id,
    agentName: tagValue(context.tags, 'agent_name') || tagValue(context.tags, 'agent') || '未标记智能体',
    status: context.status,
    driver: context.driver,
    image: context.guestImage,
    createdAt: context.createdAt,
    updatedAt: context.updatedAt,
    messageCount: context.cellCount,
    eventCount: context.eventCount,
  };
}

function tagValue(tags: Array<{ name: string; value: string }>, name: string): string {
  return tags.find((tag) => tag.name.trim() === name)?.value.trim() ?? '';
}
