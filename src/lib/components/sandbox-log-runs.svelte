<script lang="ts">
  import { onMount } from 'svelte';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';
  import RunLogViewer from '$lib/components/run-log-viewer.svelte';
  import { t } from '$lib/i18n.svelte';
  import type { AgentStreamState, AgentTranscriptItem } from '$lib/run-stream.svelte';
  import { followRunLogs, runStatusName, sourceName, type RunLogChunk } from '../../api/runs';
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

  // Intentional window, not an unfinished full render. Earlier bytes load on demand; download reads the files separately.
  const TAIL_LINES = 2000;
  const FLUSH_MS = 150;

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

  type LogWindow = {
    lines: string[];
    incomplete: string;
    windowStart: bigint;
    startKnown: boolean;
    hasEarlier: boolean;
    loaded: boolean;
    error: string;
  };

  let windows = $state<Record<string, LogWindow>>({});
  let query = $state('');
  let loadingEarlier = $state(false);
  let downloading = $state(false);
  let preserveLine = $state(0);
  let anchorBeforeLine = 0;
  let loadVersion = 0;
  const controllers = new SvelteMap<string, AbortController>();
  const requested = new SvelteSet<string>();
  const pendingText = new SvelteMap<string, string>();
  const flushTimers = new SvelteMap<string, number>();

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
  const hasEarlier = $derived(chronologicalRuns.some((run) => windows[run.runId]?.hasEarlier));
  const pending = $derived(chronologicalRuns.some((run) => !windows[run.runId]?.loaded && !windows[run.runId]?.error));

  onMount(() => () => {
    controllers.forEach((controller) => controller.abort());
    flushTimers.forEach((timer) => window.clearTimeout(timer));
  });

  $effect(() => {
    if (!sandboxId) return;
    loadVersion += 1;
    controllers.forEach((controller) => controller.abort());
    controllers.clear();
    requested.clear();
    pendingText.clear();
    flushTimers.forEach((timer) => window.clearTimeout(timer));
    flushTimers.clear();
    windows = {};
    loadingEarlier = false;
    preserveLine = 0;
    anchorBeforeLine = 0;
  });

  $effect(() => {
    // Subscribe while the workbench is open. A hidden log tab must not delay the tail request.
    const waiting = chronologicalRuns.filter((run) => !requested.has(run.runId));
    if (!waiting.length) return;
    for (const run of waiting) requested.add(run.runId);
    for (const run of waiting) void loadTail(run);
  });

  async function loadTail(run: RunSummary): Promise<void> {
    const version = loadVersion;
    const follow = run.status === RunStatus.RUNNING;
    await readLogs(run, { follow, tailLines: TAIL_LINES }, (chunk) => {
      if (version !== loadVersion) return;
      noteWindowStart(run.runId, chunk);
      bufferChunk(run.runId, chunk, follow);
    });
    if (version !== loadVersion) return;
    flush(run.runId);
    patchWindow(run.runId, { loaded: true });
  }

  async function loadEarlier(): Promise<void> {
    if (loadingEarlier) return;
    loadingEarlier = true;
    try {
      await Promise.all(chronologicalRuns.filter((run) => windows[run.runId]?.hasEarlier).map(loadEarlierRun));
    } finally {
      loadingEarlier = false;
    }
  }

  async function loadEarlierRun(run: RunSummary): Promise<void> {
    const windowStart = windows[run.runId]?.windowStart ?? 0n;
    if (windowStart <= 0n) return;
    let earlier: string[] = [];
    let incomplete = '';
    const version = loadVersion;
    const result = await readLogs(run, { follow: false, startOffset: 0n }, (chunk) => {
      if (version !== loadVersion) return false;
      const text = textBefore(chunk, windowStart);
      if (text) {
        const parsed = appendText(earlier, incomplete, text);
        earlier = parsed.lines;
        incomplete = parsed.incomplete;
      }
      return chunk.offset >= windowStart;
    });
    // A disconnect aborts the stream too. Only a read that reached the tail window may replace the button.
    if (version !== loadVersion || !result.reached) return;
    if (incomplete) earlier.push(incomplete);
    prependLines(run.runId, earlier);
  }

  async function readLogs(
    run: RunSummary,
    options: { follow: boolean; tailLines?: number; startOffset?: bigint },
    onChunk: (chunk: RunLogChunk) => boolean | void,
  ): Promise<{ reached: boolean }> {
    const controller = new AbortController();
    controllers.set(`${options.follow ? 'tail' : 'earlier'}:${run.runId}`, controller);
    let reached = false;
    try {
      await followRunLogs(
        run.runId,
        (chunk) => {
          if (onChunk(chunk)) reached = true;
          if (reached) controller.abort();
        },
        controller.signal,
        {
          follow: options.follow,
          projectId: run.projectId,
          tailLines: options.tailLines,
          startOffset: options.startOffset,
        },
      );
      return { reached };
    } catch (cause) {
      if (controller.signal.aborted) return { reached };
      const message = cause instanceof Error ? cause.message : t('日志加载失败');
      if (options.tailLines != null) patchWindow(run.runId, { error: message, loaded: true });
      onError?.(message);
      return { reached: false };
    } finally {
      controllers.delete(`${options.follow ? 'tail' : 'earlier'}:${run.runId}`);
    }
  }

  function noteWindowStart(runId: string, chunk: RunLogChunk): void {
    const current = windows[runId] ?? emptyWindow();
    // The first chunk is metadata and has no log bytes. Using it would hide "load earlier".
    if (current.startKnown || !chunk.data) return;
    const start = chunk.offset - BigInt(byteLength(chunk.data));
    const windowStart = start < 0n ? 0n : start;
    patchWindow(runId, { windowStart, startKnown: true, hasEarlier: windowStart > 0n });
  }

  function bufferChunk(runId: string, chunk: RunLogChunk, follow: boolean): void {
    if (!chunk.data) return;
    // Keep chunk copies out of reactive state. Replacing the full string on every 64KB chunk is the jank this avoids.
    pendingText.set(runId, `${pendingText.get(runId) ?? ''}${chunk.data}`);
    if (!follow || flushTimers.has(runId)) return;
    flushTimers.set(
      runId,
      window.setTimeout(() => {
        flushTimers.delete(runId);
        flush(runId);
      }, FLUSH_MS),
    );
  }

  function flush(runId: string): void {
    const timer = flushTimers.get(runId);
    if (timer) window.clearTimeout(timer);
    flushTimers.delete(runId);
    const text = pendingText.get(runId);
    if (!text) return;
    pendingText.delete(runId);
    const current = windows[runId] ?? emptyWindow();
    const parsed = appendText(current.lines, current.incomplete, text);
    patchWindow(runId, { lines: parsed.lines, incomplete: parsed.incomplete });
  }

  function prependLines(runId: string, earlier: string[]): void {
    const current = windows[runId] ?? emptyWindow();
    const addedRows = earlier.length + runHeadingRows(runId);
    const startsAboveAnchor = sectionStartLine(runId) < anchorBeforeLine;
    patchWindow(runId, {
      lines: [...earlier, ...current.lines],
      windowStart: 0n,
      hasEarlier: false,
    });
    // Rows appended below the anchored line do not move the text already on screen.
    if (startsAboveAnchor) preserveLine += addedRows;
  }

  function sectionStartLine(runId: string): number {
    let offset = 0;
    for (const section of sections) {
      if ('run' in section && section.run.runId === runId) return offset;
      offset += 'run' in section ? runLines(section.run).length : legacyCellLines(section.cell).length;
    }
    return offset;
  }

  function runHeadingRows(runId: string): number {
    const current = windows[runId];
    return current && current.lines.length === 0 && !current.incomplete ? 1 : 0;
  }

  function patchWindow(runId: string, patch: Partial<LogWindow>): void {
    windows = { ...windows, [runId]: { ...(windows[runId] ?? emptyWindow()), ...patch } };
  }

  function emptyWindow(): LogWindow {
    return {
      lines: [],
      incomplete: '',
      windowStart: 0n,
      startKnown: false,
      hasEarlier: false,
      loaded: false,
      error: '',
    };
  }

  function appendText(lines: string[], incomplete: string, text: string): { lines: string[]; incomplete: string } {
    const parts = `${incomplete}${text}`.split('\n');
    return { lines: [...lines, ...parts.slice(0, -1)], incomplete: parts.at(-1) ?? '' };
  }

  function textBefore(chunk: RunLogChunk, windowStart: bigint): string {
    if (!chunk.data || chunk.offset <= 0n) return '';
    const size = BigInt(byteLength(chunk.data));
    const chunkStart = chunk.offset - size;
    if (chunkStart >= windowStart) return '';
    if (chunk.offset <= windowStart) return chunk.data;
    const keep = Number(windowStart - chunkStart);
    return new TextDecoder().decode(new TextEncoder().encode(chunk.data).slice(0, keep));
  }

  function byteLength(value: string): number {
    return new TextEncoder().encode(value).length;
  }

  function runLines(run: RunSummary): string[] {
    const window = windows[run.runId];
    const body = [...eventLines(run.runId), ...(window?.lines ?? [])];
    if (window?.incomplete) body.push(window.incomplete);
    if (run.error && !body.some((line) => line.includes(run.error))) body.push(`${t('错误')}：${run.error}`);
    if (body.length) return [headingFor(run), ...body];
    if (window?.error) return [headingFor(run), `${t('日志加载失败')}：${window.error}`];
    return [headingFor(run), t(window?.loaded ? '没有日志输出' : '正在加载日志…')];
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
    }
  }
</script>

<div data-sandbox-log-stream data-log-pending={pending ? 'true' : 'false'} class="flex h-full min-h-0 flex-col">
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
