<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import RunLogViewer from '$lib/components/run-log-viewer.svelte';
  import { t } from '$lib/i18n.svelte';
  import type { AgentStreamState, AgentTranscriptItem } from '$lib/run-stream.svelte';
  import { followRunLogs, runStatusName, sourceName } from '../../api/runs';
  import { RunLogFeed } from '$lib/run-log-feed.svelte';
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
    onError,
  }: {
    sandboxId: string;
    runs: RunSummary[];
    events: RunEvent[];
    activeStream?: AgentStreamState;
    legacyCells?: SandboxHistoryCell[];
    onError?: (message: string) => void;
  } = $props();

  let query = $state('');
  let loadingEarlier = $state(false);
  let downloading = $state(false);
  let preserveLine = $state(0);
  /** 新建订阅时加一，让依赖订阅列表的派生值重新计算；每个订阅自己的行变化由它内部的状态驱动。 */
  let feedsVersion = $state(0);
  let anchorBeforeLine = 0;
  let loadVersion = 0;
  // Plain collections. A SvelteMap read inside the reset effect retriggers that effect on every stream start.
  /* eslint-disable svelte/prefer-svelte-reactivity -- reactive reads here restart every log stream */
  const feeds = new Map<string, RunLogFeed>();
  const requested = new Set<string>();
  /* eslint-enable svelte/prefer-svelte-reactivity */
  let downloadController: AbortController | null = null;

  const chronologicalRuns = $derived([...runs].reverse());
  const sections = $derived(
    [
      ...chronologicalRuns.map((run) => ({ createdAt: timestampToISOString(run.startedAt || run.createdAt), run })),
      ...legacyCells
        .filter((cell) => cell.source.trim() || cell.output.trim())
        .map((cell) => ({ createdAt: cell.createdAt, cell })),
    ].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt)),
  );
  const lines = $derived(
    sections.flatMap((section) => ('run' in section ? runLines(section.run) : legacyCellLines(section.cell))),
  );
  const hasEarlier = $derived(chronologicalRuns.some((run) => feedFor(run.runId)?.hasEarlier));

  onMount(() => () => {
    resetStreams();
  });

  $effect(() => {
    if (!sandboxId) return;
    untrack(resetForSandbox);
  });

  $effect(() => {
    // Subscribe while the workbench is open. A hidden log tab must not delay the tail request.
    const waiting = chronologicalRuns.filter((run) => !requested.has(run.runId));
    if (!waiting.length) return;
    for (const run of waiting) requested.add(run.runId);
    untrack(() => void loadWaiting(waiting));
  });

  function feedFor(runId: string): RunLogFeed | undefined {
    void feedsVersion;
    return feeds.get(runId);
  }

  function resetForSandbox(): void {
    loadVersion += 1;
    resetStreams();
    feedsVersion += 1;
    loadingEarlier = false;
    preserveLine = 0;
    anchorBeforeLine = 0;
  }

  function resetStreams(): void {
    for (const feed of feeds.values()) feed.stop();
    feeds.clear();
    requested.clear();
    downloadController?.abort();
    downloadController = null;
  }

  async function loadWaiting(waiting: RunSummary[]): Promise<void> {
    const version = loadVersion;
    for (const run of waiting) feeds.set(run.runId, new RunLogFeed(run.runId, run.projectId));
    feedsVersion += 1;
    // 运行中的日志立即跟随；已结束的逐个读取末尾，避免同时打开大量连接。
    for (const run of waiting.filter((item) => item.status === RunStatus.RUNNING)) void startFeed(run, true);
    for (const run of waiting.filter((item) => item.status !== RunStatus.RUNNING)) {
      if (version !== loadVersion) return;
      await startFeed(run, false);
    }
  }

  async function startFeed(run: RunSummary, follow: boolean): Promise<void> {
    const feed = feeds.get(run.runId);
    if (!feed) return;
    await feed.start(follow);
    if (feed.error) onError?.(feed.error);
  }

  async function loadEarlier(): Promise<void> {
    if (loadingEarlier) return;
    loadingEarlier = true;
    try {
      for (const run of chronologicalRuns) {
        const feed = feeds.get(run.runId);
        if (!feed?.hasEarlier) continue;
        // 插在当前视口上方的行要补偿滚动位置，插在下方的不影响屏幕上的内容。
        const startsAboveAnchor = sectionStartLine(run.runId) < anchorBeforeLine;
        const added = await feed.loadEarlier();
        if (startsAboveAnchor) preserveLine += added;
      }
    } finally {
      loadingEarlier = false;
    }
  }

  function sectionStartLine(runId: string): number {
    let offset = 0;
    for (const section of sections) {
      if ('run' in section && section.run.runId === runId) return offset;
      offset += 'run' in section ? runLines(section.run).length : legacyCellLines(section.cell).length;
    }
    return offset;
  }

  function runLines(run: RunSummary): string[] {
    const feed = feedFor(run.runId);
    const body = [...eventLines(run.runId), ...(feed?.lines ?? [])];
    if (run.error && !body.some((line) => line.includes(run.error))) body.push(`${t('错误')}：${run.error}`);
    if (body.length) return [headingFor(run), ...body];
    if (feed?.error) return [headingFor(run), `${t('日志加载失败')}：${feed.error}`];
    return [headingFor(run), t(feed?.loaded ? '没有日志输出' : '正在加载日志…')];
  }

  function headingFor(run: RunSummary): string {
    const at = formatBeijingTime(timestampToISOString(run.startedAt || run.createdAt));
    return `──── ${at} · ${sourceName(run.source)} · ${run.runShortId || compactIdentifier(run.runId)} · ${statusLabel(run)} ────`;
  }

  function legacyCellLines(cell: SandboxHistoryCell): string[] {
    const at = formatBeijingTime(cell.createdAt);
    const heading = `──── ${at} · ${t('执行历史')} · ${compactIdentifier(cell.id)} · ${cell.success ? t('成功') : t('失败')} ────`;
    return [
      heading,
      ...[cell.source.trim(), cell.output.trim(), cell.stopReason.trim()].filter(Boolean).flatMap(splitLines),
    ];
  }

  function eventLines(runId: string): string[] {
    const persisted = events
      .filter(
        (event) =>
          event.runId === runId && (event.kind === RunEventKind.AGENT_ACTIVITY || event.kind === RunEventKind.STATUS),
      )
      .flatMap((event) => splitLines(formatRunEvent(event)));
    const live =
      activeStream?.runId === runId
        ? activeStream.transcript.flatMap((item) => splitLines(formatTranscriptEvent(item)))
        : [];
    return [...persisted, ...live];
  }

  function splitLines(value: string): string[] {
    return value ? value.split('\n') : [];
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

  async function download(): Promise<void> {
    if (downloading) return;
    downloading = true;
    const controller = new AbortController();
    downloadController = controller;
    try {
      const parts: Array<string | Blob> = [];
      for (const run of chronologicalRuns) {
        parts.push(`${headingFor(run)}\n`);
        await followRunLogs(
          run.runId,
          (chunk) => {
            if (chunk.data) parts.push(chunk.data);
          },
          controller.signal,
          { follow: false, projectId: run.projectId, startOffset: 0n },
        );
        parts.push('\n\n');
      }
      for (const cell of legacyCells) {
        if (cell.source.trim() || cell.output.trim()) parts.push(`${legacyCellLines(cell).join('\n')}\n\n`);
      }
      const url = URL.createObjectURL(new Blob(parts, { type: 'text/plain' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `sandbox-${compactIdentifier(sandboxId)}.log`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      if (!controller.signal.aborted) onError?.(cause instanceof Error ? cause.message : t('日志加载失败'));
    } finally {
      downloading = false;
      if (downloadController === controller) downloadController = null;
    }
  }
</script>

<div data-sandbox-log-stream class="flex h-full min-h-0 flex-col">
  <div class="hidden" aria-hidden="true">
    {#each chronologicalRuns as run (run.runId)}
      <span data-log-section={run.runId}>{headingFor(run)}</span>
    {/each}
  </div>
  <RunLogViewer
    {query}
    {lines}
    loadedLineCount={lines.length}
    {hasEarlier}
    {loadingEarlier}
    {downloading}
    {preserveLine}
    onViewportLine={(line) => (anchorBeforeLine = line)}
    onQuery={(value) => (query = value)}
    onDownload={() => void download()}
    onLoadEarlier={() => void loadEarlier()}
  />
</div>
