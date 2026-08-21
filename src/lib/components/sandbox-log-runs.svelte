<script lang="ts">
  import { onMount } from 'svelte';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';
  import RunLogViewer from '$lib/components/run-log-viewer.svelte';
  import { t } from '$lib/i18n.svelte';
  import type { AgentStreamState, AgentTranscriptItem } from '$lib/run-stream.svelte';
  import { followRunLogs, runStatusName, sourceName } from '../../api/runs';
  import {
    RunEventKind,
    RunStatus,
    type RunEvent,
    type RunSummary,
  } from '../../gen/agentcompose/v2/agentcompose_pb.js';
  import type { SandboxHistoryCell } from '../../api/sessions';
  import { compactIdentifier } from '../../model/identifiers';
  import { timestampToISOString } from '../../model/timestamps';
  import { formatBeijingTime } from '../../time';

  let {
    sandboxId,
    runs,
    events,
    activeStream,
    legacyCells = [],
  }: {
    sandboxId: string;
    runs: RunSummary[];
    events: RunEvent[];
    activeStream?: AgentStreamState;
    legacyCells?: SandboxHistoryCell[];
  } = $props();

  let logs = $state<Record<string, string>>({});
  let errors = $state<Record<string, string>>({});
  let loaded = $state<Record<string, boolean>>({});
  let query = $state('');
  const controllers = new SvelteMap<string, AbortController>();
  const requested = new SvelteSet<string>();

  const chronologicalRuns = $derived([...runs].reverse());
  const logSections = $derived(
    [
      ...chronologicalRuns.map((run) => ({
        createdAt: timestampToISOString(run.startedAt || run.createdAt),
        content: runSection(run),
      })),
      ...legacyCells
        .filter((cell) => cell.source.trim() || cell.output.trim())
        .map((cell) => ({ createdAt: cell.createdAt, content: legacyCellSection(cell) })),
    ].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt)),
  );
  const content = $derived(logSections.map((section) => section.content).join('\n\n'));
  const visibleContent = $derived(
    query.trim()
      ? content
          .split('\n')
          .filter((line) => line.toLowerCase().includes(query.toLowerCase()))
          .join('\n')
      : content,
  );
  const lineCount = $derived(content ? content.split('\n').length : 0);

  onMount(() => () => controllers.forEach((controller) => controller.abort()));

  $effect(() => {
    const pending = chronologicalRuns.filter((run) => !requested.has(run.runId));
    if (!pending.length) return;
    for (const run of pending) requested.add(run.runId);
    void loadRuns(pending);
  });

  async function loadRuns(items: RunSummary[]): Promise<void> {
    const completed = items.filter((run) => run.status !== RunStatus.RUNNING);
    const running = items.filter((run) => run.status === RunStatus.RUNNING);
    for (const run of completed) await load(run.runId, false);
    for (const run of running) void load(run.runId, true);
  }

  async function load(runId: string, follow: boolean): Promise<void> {
    const controller = new AbortController();
    controllers.set(runId, controller);
    logs = { ...logs, [runId]: '' };
    try {
      await followRunLogs(
        runId,
        (chunk) => (logs = { ...logs, [runId]: `${logs[runId] ?? ''}${chunk}` }),
        controller.signal,
        follow,
      );
    } catch (cause) {
      if (!controller.signal.aborted)
        errors = { ...errors, [runId]: cause instanceof Error ? cause.message : t('日志加载失败') };
    } finally {
      loaded = { ...loaded, [runId]: true };
      controllers.delete(runId);
    }
  }

  function runSection(run: RunSummary): string {
    const at = formatBeijingTime(timestampToISOString(run.startedAt || run.createdAt));
    const shortRunId = run.runShortId || compactIdentifier(run.runId);
    const heading = `──── ${at} · ${sourceName(run.source)} · ${shortRunId} · ${statusLabel(run)} ────`;
    const raw = logs[run.runId] || liveOutput(run.runId);
    const body = [
      eventSection(run.runId),
      raw.trimEnd(),
      run.error && !raw.includes(run.error) ? `${t('错误')}：${run.error}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    if (body) return `${heading}\n${body}`;
    if (errors[run.runId]) return `${heading}\n${t('日志加载失败')}：${errors[run.runId]}`;
    return `${heading}\n${t(loaded[run.runId] ? '没有日志输出' : '正在加载日志…')}`;
  }

  function legacyCellSection(cell: SandboxHistoryCell): string {
    const at = formatBeijingTime(cell.createdAt);
    const shortCellId = compactIdentifier(cell.id);
    const heading = `──── ${at} · ${t('执行历史')} · ${shortCellId} · ${cell.success ? t('成功') : t('失败')} ────`;
    const body = [cell.source.trim(), cell.output.trim(), cell.stopReason.trim()].filter(Boolean).join('\n');
    return `${heading}\n${body}`;
  }

  function eventSection(runId: string): string {
    const persisted = events
      .filter(
        (event) =>
          event.runId === runId && (event.kind === RunEventKind.AGENT_ACTIVITY || event.kind === RunEventKind.STATUS),
      )
      .map(formatRunEvent);
    const live = activeStream?.runId === runId ? activeStream.transcript.map(formatTranscriptEvent) : [];
    const lines = [...persisted, ...live].filter(Boolean);
    return lines.length ? lines.join('\n') : '';
  }

  function formatRunEvent(event: RunEvent): string {
    const at = formatBeijingTime(timestampToISOString(event.createdAt));
    if (event.kind === RunEventKind.AGENT_ACTIVITY)
      return `[${at}] ${t('智能体活动')}${event.text ? `\n${event.text.trim()}` : ''}`;
    const payload = parsePayload(event.payloadJson);
    const detail = [payload.agent, payload.stopReason, payload.success === true ? t('成功') : '']
      .filter(Boolean)
      .join(' · ');
    return `[${at}] ${t('状态')}${detail ? ` · ${detail}` : ''}`;
  }

  function formatTranscriptEvent(event: AgentTranscriptItem): string {
    const at = formatBeijingTime(event.createdAt);
    const text = event.text.trim();
    const payload = event.payloadJson.trim();
    return [`[${at}] ${transcriptLabel(event.name)}`, text, payload && payload !== text ? payload : '']
      .filter(Boolean)
      .join('\n');
  }

  function transcriptLabel(name: string): string {
    const value = name.toLowerCase();
    if (value.includes('command')) return t('命令');
    if (value.includes('tool') || value.includes('mcp')) return t('工具调用');
    if (value.includes('reason')) return t('思考过程');
    if (value.includes('file')) return t('文件修改');
    if (value.includes('search')) return t('搜索');
    if (value.includes('error') || value.includes('stderr')) return t('错误');
    return t('智能体活动');
  }

  function parsePayload(value: string): Record<string, unknown> {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  function liveOutput(runId: string): string {
    return activeStream?.runId === runId ? `${activeStream.stdout}${activeStream.stderr}` : '';
  }

  function statusLabel(run: RunSummary): string {
    const status = runStatusName(run.status);
    return t(
      status === 'running'
        ? '运行中'
        : status === 'success'
          ? '成功'
          : status === 'failed'
            ? '失败'
            : status === 'stopped'
              ? '已停止'
              : '等待中',
    );
  }

  function download(): void {
    const url = URL.createObjectURL(new Blob([content], { type: 'text/plain' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `sandbox-${compactIdentifier(sandboxId)}.log`;
    anchor.click();
    URL.revokeObjectURL(url);
  }
</script>

<div data-sandbox-log-stream class="h-full min-h-0">
  <RunLogViewer
    {query}
    content={visibleContent}
    {lineCount}
    onQuery={(value) => (query = value)}
    onDownload={download}
  />
</div>
