<script lang="ts">
  import { Code, ConnectError } from '@connectrpc/connect';
  import { untrack } from 'svelte';
  import { execService, projectService, runService, sandboxService } from '../../lib/rpc';
  import { GetRunRequest, GetSchedulerRunRequest, ListSandboxHistoryRequest, ListSandboxRunEventsRequest, RunStatus, RunSource, type RunDetail, type RunEvent, type SandboxHistoryCell, type SchedulerEvent } from '../../gen/agentcompose/v2/agentcompose_pb';
  import {
    listAllRunEvents,
    mapRunEventsToTranscript,
    type StructuredRunTranscriptEntry,
  } from '../../lib/agent-run-transcript';
  import { buildFollowRunLogsRequest } from '../../lib/run-controls';
  import {
    buildRuntimeTimeline,
    type RuntimeTimelineEntry,
  } from '../../lib/runtime-timeline';
  import RunExecutionTimelineEntry from './RunExecutionTimelineEntry.svelte';
  import {
    appendLiveRunLogChunk,
    beginRunLogLoad,
    initialRunLogWindow,
    nextRunLogScope,
    replaceRunLogWindow,
    type RunLogScope,
  } from '../../lib/run-log-window';
  import { findSchedulerRunEvidence } from '../../lib/run-scheduler-evidence';
  import { schedulerRunEventId } from '../../lib/scheduler-run-event';
  import { buildConfirmedEvidenceTimeline, confirmedCell, confirmedSandboxRunEvents, resultCellId } from '../../lib/run-confirmed-evidence';
  import { discoverWorkspaceArtifacts, type WorkspaceArtifactFile } from '../../lib/workspace-artifacts';
  import { store } from '../../lib/stores.svelte';

  let {
    projectId,
    agentName,
    runId,
    embedded = false,
    refreshVersion = 0,
    onDetail = () => {},
    onEventId = () => {},
    onSettled = () => {},
  }: {
    projectId: string;
    agentName: string;
    runId: string;
    embedded?: boolean;
    refreshVersion?: number;
    onDetail?: (detail: RunDetail | null) => void;
    onEventId?: (eventId: string) => void;
    onSettled?: (status: RunStatus, completedAt: string) => void;
  } = $props();

  let runDetail: RunDetail | null = $state(null);
  let structuredEvents: StructuredRunTranscriptEntry[] = $state([]);
  let confirmedEvidence: RuntimeTimelineEntry[] = $state([]);
  let historyAvailable: boolean | undefined = $state(undefined);
  let detailLoading = $state(true);
  let detailError = $state('');
  let detailNotFound = $state(false);
  let eventsError = $state('');
  let evidenceError = $state('');
  let workspaceArtifacts: WorkspaceArtifactFile[] = $state([]);
  let workspaceArtifactNotice = $state('');
  let logWindow = $state(initialRunLogWindow());
  let logError = $state('');
  let logFollowing = $state(false);
  let logTransitioning = $state(false);
  let logLoadSucceeded = $state(false);
  let logFollowEnabled = $state(false);
  let failedLogScope: RunLogScope | undefined = $state(undefined);
  let identityAbort: AbortController | null = null;
  let logAbort: AbortController | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let detailGeneration = 0;
  type TimelineFilter = 'all' | 'message' | 'activity' | 'run' | 'artifact' | 'problem';
  const timelineFilterLabels: Record<TimelineFilter, string> = {
    all: '全部',
    message: '消息',
    activity: '活动',
    run: '运行',
    artifact: '产物',
    problem: '问题',
  };
  const timelineFilters = Object.keys(timelineFilterLabels) as TimelineFilter[];
  let activeTimelineFilter = $state<TimelineFilter>('all');

  $effect(() => {
    void refreshVersion;
    const requestedProjectId = projectId;
    const requestedRunId = runId;
    const requestedAgent = agentName;
    const generation = ++detailGeneration;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = undefined;
    identityAbort?.abort();
    logAbort?.abort();
    logAbort = null;
    identityAbort = new AbortController();
    runDetail = null;
    detailError = '';
    detailNotFound = false;
    eventsError = '';
    evidenceError = '';
    workspaceArtifacts = [];
    workspaceArtifactNotice = '';
    onDetail(null);
    onEventId('');
    structuredEvents = [];
    confirmedEvidence = [];
    historyAvailable = undefined;
    logWindow = initialRunLogWindow();
    logError = '';
    logFollowing = false;
    logTransitioning = false;
    logLoadSucceeded = false;
    logFollowEnabled = false;
    failedLogScope = undefined;
    if (!requestedProjectId || !requestedRunId) {
      detailLoading = false;
      return;
    }

    detailLoading = true;
    untrack(() => {
      void fetchDetail(generation, requestedProjectId, requestedRunId, requestedAgent);
      void fetchEvents(generation, requestedProjectId, requestedRunId, requestedAgent);
    });
  });

  async function fetchEvents(generation: number, projectId: string, requestedRunId: string, requestedAgent: string) {
    try {
      eventsError = '';
      const result = await listAllRunEvents(requestedRunId, request => runService.listRunEvents(request, { signal: identitySignal() }) as any);
      if (!isCurrentDetail(generation, projectId, requestedRunId, requestedAgent)) return;
      historyAvailable = result.historyAvailable;
      structuredEvents = mapRunEventsToTranscript(result.events);
      if (!result.historyAvailable) {
        void fetchLogs(generation, projectId, requestedRunId, requestedAgent, 'tail-100');
      }
    } catch (error: any) {
      if (identityAbort?.signal.aborted || !isCurrentDetail(generation, projectId, requestedRunId, requestedAgent)) return;
      eventsError = error?.message || '加载结构化运行事件失败';
      historyAvailable = true;
      structuredEvents = [];
    }
  }

  async function fetchDetail(generation: number, projectId: string, requestedRunId: string, requestedAgent: string) {
    try {
      detailError = '';
      detailNotFound = false;
      const resp: any = await runService.getRun(new GetRunRequest({ runId: requestedRunId, projectId }), { signal: identitySignal() });
      if (!isCurrentDetail(generation, projectId, requestedRunId, requestedAgent)) return;
      runDetail = resp.run || null;
      onDetail(runDetail);
      if (runDetail) void fetchConfirmedEvidence(generation, projectId, requestedRunId, requestedAgent, runDetail);
      if (runDetail?.summary?.sandboxId && runDetail.summary.startedAt) {
        void fetchWorkspaceArtifacts(generation, projectId, requestedRunId, requestedAgent, runDetail);
      }
      if (runDetail?.summary && isTerminalStatus(runDetail.summary.status)) {
        onSettled(runDetail.summary.status, runDetail.summary.completedAt || '');
      }
      const followEnabled = runDetail?.summary?.status === RunStatus.RUNNING;
      if (followEnabled !== logFollowEnabled) {
        logFollowEnabled = followEnabled;
        if (followEnabled && historyAvailable === false && !logTransitioning && !logFollowing) {
          void followLogs(generation, projectId, requestedRunId, requestedAgent, logWindow.scope);
        }
      }
      const status = runDetail?.summary?.status ?? RunStatus.UNSPECIFIED;
      if (status === RunStatus.PENDING || status === RunStatus.RUNNING) {
        scheduleRefresh(generation, projectId, requestedRunId, requestedAgent);
      }
    } catch (error: any) {
      if (identityAbort?.signal.aborted || !isCurrentDetail(generation, projectId, requestedRunId, requestedAgent)) return;
      runDetail = null;
      onDetail(null);
      if (ConnectError.from(error).code === Code.NotFound) detailNotFound = true;
      else detailError = error?.message || '加载运行详情失败';
    } finally {
      if (isCurrentDetail(generation, projectId, requestedRunId, requestedAgent)) detailLoading = false;
    }
  }

  async function fetchWorkspaceArtifacts(
    generation: number,
    projectId: string,
    requestedRunId: string,
    requestedAgent: string,
    detail: RunDetail,
  ) {
    const summary = detail.summary!;
    const result = await discoverWorkspaceArtifacts({
      sandboxId: summary.sandboxId,
      startedAt: summary.startedAt,
      completedAt: summary.completedAt,
      now: () => new Date(),
      getSandbox: (request, options) => sandboxService.getSandbox(request, options),
      execStream: (request, options) => execService.execStream(request, options),
      signal: identitySignal(),
    });
    if (!isCurrentDetail(generation, projectId, requestedRunId, requestedAgent)) return;
    workspaceArtifacts = result.files;
    if (result.status === 'stopped') workspaceArtifactNotice = 'Sandbox 已停止，请先手动恢复后刷新产物';
    else if (result.status === 'removed') workspaceArtifactNotice = '产物所在 Sandbox 已删除，无法读取 Workspace 文件';
    else if (result.status === 'error') workspaceArtifactNotice = `Workspace 产物加载失败：${result.message}`;
    else if (result.truncated) workspaceArtifactNotice = 'Workspace 文件列表已截断';
    else workspaceArtifactNotice = '';
  }

  async function fetchConfirmedEvidence(
    generation: number,
    projectId: string,
    requestedRunId: string,
    requestedAgent: string,
    detail: RunDetail,
  ) {
    evidenceError = '';
    const summary = detail.summary;
    if (!summary) return;
    let schedulerEvents: SchedulerEvent[] = [];
    let cell: SandboxHistoryCell | undefined;
    let sandboxRunEvents: RunEvent[] = [];

    const mayHaveSchedulerParent = summary.source === RunSource.SCHEDULER ||
      summary.source === RunSource.MANUAL || Boolean(summary.schedulerId || summary.triggerId);
    if (mayHaveSchedulerParent) {
      try {
        const evidence = await findSchedulerRunEvidence({
          projectId,
          agentName: summary.agentName || requestedAgent,
          triggerId: summary.triggerId,
          projectRunId: requestedRunId,
        }, request => projectService.listSchedulerEvents(request, { signal: identitySignal() }));
        schedulerEvents = evidence.events;
        if (evidence.loaderRunId) {
          try {
            const response = await projectService.getSchedulerRun(new GetSchedulerRunRequest({
              project: { projectId },
              runId: evidence.loaderRunId,
            }), { signal: identitySignal() });
            if (isCurrentDetail(generation, projectId, requestedRunId, requestedAgent)) {
              onEventId(schedulerRunEventId(response.run?.payloadJson ?? ''));
            }
          } catch {
            // Event metadata is optional; confirmed Scheduler evidence remains usable without it.
          }
        }
      } catch (error: any) {
        if (!identityAbort?.signal.aborted && ConnectError.from(error).code !== Code.NotFound && isCurrentDetail(generation, projectId, requestedRunId, requestedAgent)) {
          evidenceError = error?.message || '加载本次调度事件失败';
        }
      }
    }

    if (summary.sandboxId) {
      const cellId = resultCellId(detail.resultJson);
      if (cellId) {
        try {
          const history = await sandboxService.listSandboxHistory(new ListSandboxHistoryRequest({ sandboxId: summary.sandboxId }), { signal: identitySignal() });
          cell = confirmedCell(history.cells, detail.resultJson);
        } catch (error: any) {
          // run 取消/结束后 sandbox 可能已被清理，metadata.json 不存在属正常情况，静默忽略 NotFound。
          if (!identityAbort?.signal.aborted && ConnectError.from(error).code !== Code.NotFound && isCurrentDetail(generation, projectId, requestedRunId, requestedAgent)) {
            evidenceError = error?.message || '加载本次 Agent Cell 失败';
          }
        }
      }
      try {
        const events: RunEvent[] = [];
        const seenCursors = new Set<string>();
        let cursor = '';
        while (true) {
          const page = await runService.listSandboxRunEvents(new ListSandboxRunEventsRequest({ sandboxId: summary.sandboxId, limit: 500, cursor }), { signal: identitySignal() });
          events.push(...page.events);
          if (!page.nextCursor) break;
          if (seenCursors.has(page.nextCursor)) throw new Error('Sandbox Run event pagination returned repeated cursor');
          seenCursors.add(page.nextCursor);
          cursor = page.nextCursor;
        }
        sandboxRunEvents = confirmedSandboxRunEvents(events, requestedRunId);
      } catch (error: any) {
        // sandbox 已被清理时后端可能返回 NotFound，此时无 Run 事件可加载属正常，静默忽略。
        if (!identityAbort?.signal.aborted && ConnectError.from(error).code !== Code.NotFound && isCurrentDetail(generation, projectId, requestedRunId, requestedAgent)) {
          evidenceError = error?.message || '加载本次 Sandbox Run 事件失败';
        }
      }
    }

    if (identityAbort?.signal.aborted || !isCurrentDetail(generation, projectId, requestedRunId, requestedAgent)) return;
    confirmedEvidence = buildConfirmedEvidenceTimeline({
      schedulerEvents,
      cell,
      sandboxRunEvents,
      existingRunEventIds: new Set(structuredEvents.map(event => event.id)),
      existingRunEventContents: new Set(structuredEvents.map(event => event.content)),
      output: detail.output,
      resultJson: detail.resultJson,
      logsPath: detail.logsPath,
      artifactsDir: detail.artifactsDir,
      completedAt: summary.completedAt,
      updatedAt: summary.updatedAt,
      startedAt: summary.startedAt,
    });
  }

  function scheduleRefresh(generation: number, projectId: string, requestedRunId: string, requestedAgent: string) {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      if (!isCurrentDetail(generation, projectId, requestedRunId, requestedAgent)) return;
      void fetchDetail(generation, projectId, requestedRunId, requestedAgent);
      void fetchEvents(generation, projectId, requestedRunId, requestedAgent);
    }, 2000);
  }

  function isCurrentDetail(generation: number, requestedProjectId: string, requestedRunId: string, requestedAgent: string) {
    return generation === detailGeneration && requestedProjectId === projectId && requestedRunId === runId && requestedAgent === agentName;
  }

  function identitySignal() {
    if (!identityAbort) identityAbort = new AbortController();
    return identityAbort.signal;
  }

  function beginLogOperation() {
    logAbort?.abort();
    const controller = new AbortController();
    logAbort = controller;
    const identity = identitySignal();
    if (identity.aborted) controller.abort(identity.reason);
    else identity.addEventListener('abort', () => controller.abort(identity.reason), { once: true });
    return controller;
  }

  function retryDetail() {
    detailLoading = true;
    detailError = '';
    detailNotFound = false;
    void fetchDetail(detailGeneration, projectId, runId, agentName);
  }

  async function fetchLogs(
    generation: number,
    projectId: string,
    requestedRunId: string,
    requestedAgent: string,
    scope: RunLogScope,
  ) {
    const controller = beginLogOperation();
    const signal = controller.signal;
    logWindow = beginRunLogLoad(logWindow, scope);
    logError = '';
    failedLogScope = undefined;
    logFollowing = false;
    logTransitioning = true;
    logLoadSucceeded = false;
    const received: any[] = [];
    try {
      const req = buildFollowRunLogsRequest({
        projectId,
        runId: requestedRunId,
        tailLines: scope === 'tail-100' ? 100 : scope === 'tail-500' ? 500 : 0,
        follow: false,
      });
      const stream = runService.followRunLogs(req, { signal }) as any as AsyncIterable<any>;
      for await (const chunk of stream) {
        if (signal.aborted || !isCurrentDetail(generation, projectId, requestedRunId, requestedAgent)) return;
        if (!chunk.data) continue;
        const item = { data: chunk.data, createdAt: chunk.createdAt || '', offset: chunk.offset ?? 0n };
        received.push(item);
      }
      if (!isCurrentDetail(generation, projectId, requestedRunId, requestedAgent)) return;
      logWindow = replaceRunLogWindow(logWindow, scope, received);
      failedLogScope = undefined;
      logLoadSucceeded = true;
      logTransitioning = false;
      if (logFollowEnabled) void followLogs(generation, projectId, requestedRunId, requestedAgent, scope);
    } catch (error: any) {
      if (signal.aborted || !isCurrentDetail(generation, projectId, requestedRunId, requestedAgent)) return;
      logError = error instanceof Error ? error.message : String(error || '日志加载失败');
      failedLogScope = scope;
      logWindow = { ...logWindow, loadingScope: undefined, pendingLiveChunks: [] };
      logTransitioning = false;
    } finally {
      if (isCurrentDetail(generation, projectId, requestedRunId, requestedAgent) && logAbort === controller) {
        logTransitioning = false;
      }
    }
  }

  async function followLogs(
    generation: number,
    projectId: string,
    requestedRunId: string,
    requestedAgent: string,
    scope: RunLogScope,
  ) {
    if (!logFollowEnabled || !isCurrentDetail(generation, projectId, requestedRunId, requestedAgent)) return;
    const controller = beginLogOperation();
    const signal = controller.signal;
    logFollowing = true;
    try {
      const req = buildFollowRunLogsRequest({
        projectId,
        runId: requestedRunId,
        tailLines: scope === 'tail-100' ? 100 : scope === 'tail-500' ? 500 : 0,
        follow: true,
      });
      const stream = runService.followRunLogs(req, { signal }) as any as AsyncIterable<any>;
      for await (const chunk of stream) {
        if (signal.aborted || !isCurrentDetail(generation, projectId, requestedRunId, requestedAgent)) return;
        if (!chunk.data) continue;
        logWindow = appendLiveRunLogChunk(logWindow, {
          data: chunk.data,
          createdAt: chunk.createdAt || '',
          offset: chunk.offset ?? 0n,
        });
      }
    } catch (error: any) {
      if (signal.aborted || !isCurrentDetail(generation, projectId, requestedRunId, requestedAgent)) return;
      logError = error instanceof Error ? error.message : String(error || '日志加载失败');
      failedLogScope = scope;
    } finally {
      if (isCurrentDetail(generation, projectId, requestedRunId, requestedAgent) && logAbort === controller) {
        logFollowing = false;
        logAbort = null;
      }
    }
  }

  function loadNextLogScope() {
    if (logTransitioning || logWindow.fullyLoaded) return;
    void fetchLogs(detailGeneration, projectId, runId, agentName, nextRunLogScope(logWindow.scope));
  }

  function retryLogs() {
    const scope = failedLogScope ?? logWindow.loadingScope ?? nextRunLogScope(logWindow.scope);
    void fetchLogs(detailGeneration, projectId, runId, agentName, scope);
  }

  function timelineFor(detail: RunDetail | null) {
    let base: RuntimeTimelineEntry[];
    if (historyAvailable !== false) {
      const startTimestamp = detail?.summary?.startedAt ?? '';
      base = structuredEvents.map((event, index) => ({
        id: event.id,
        timestamp: event.timestamp || startTimestamp,
        sortTime: event.timestamp ? Date.parse(event.timestamp) : 0,
        sequence: Number(event.seq),
        kind: event.kind === 'tool' ? 'tool' as const : event.kind === 'diagnostic' ? 'error' as const : 'process' as const,
        source: event.label,
        level: event.kind === 'diagnostic' ? 'error' as const : 'info' as const,
        content: event.content,
        timestampInferred: !event.timestamp,
        ...(!event.timestamp ? { timestampBasis: 'run-start' as const } : {}),
        offset: BigInt(index),
        filterTags: event.kind === 'tool'
          ? ['activity']
          : event.kind === 'diagnostic'
            ? ['run', 'problem']
            : event.label.startsWith('智能体消息')
              ? ['message', 'artifact']
              : event.label === '用户消息'
                ? ['message']
                : ['activity'],
      }));
    } else {
      base = buildRuntimeTimeline({
        summary: detail?.summary ?? {},
        terminal: isTerminalStatus(detail?.summary?.status ?? RunStatus.UNSPECIFIED),
        sourceText: sourceLabel(detail?.summary?.source ?? RunSource.UNSPECIFIED),
        statusText: statusLabel(detail?.summary?.status ?? RunStatus.UNSPECIFIED),
        actualPrompt: detail?.prompt ?? '',
        output: detail?.output ?? '',
        resultJson: detail?.resultJson ?? '',
        warnings: [...(detail?.summary?.warnings ?? []), ...(detail?.warnings ?? [])],
        cleanupError: detail?.cleanupError ?? '',
        logError,
        logChunks: logWindow.chunks,
      });
    }
    const baseIds = new Set(structuredEvents.map(event => event.id));
    const evidence = confirmedEvidence.filter(entry => !entry.id.startsWith('sandbox-run:') || !baseIds.has(entry.id.slice('sandbox-run:'.length)));
    const sandboxId = detail?.summary?.sandboxId;
    const workspaceEntries: RuntimeTimelineEntry[] = sandboxId ? workspaceArtifacts.map((file, index) => ({
      id: `workspace-file:${file.path}`,
      timestamp: file.modifiedAt,
      sortTime: file.modifiedAtMs,
      sequence: 20_000 + index,
      kind: 'result',
      source: 'Workspace 文件',
      level: 'info',
      content: file.path,
      timestampInferred: false,
      filterTags: ['artifact'],
      artifactTarget: { sandboxId, path: file.path },
    })) : [];
    return [...base, ...evidence, ...workspaceEntries].sort((left, right) => left.sortTime - right.sortTime || left.sequence - right.sequence || left.id.localeCompare(right.id));
  }

  function openWorkspaceArtifact(target: { sandboxId: string; path: string }) {
    store.navigateTo('sandbox-detail', { sandboxId: target.sandboxId });
    const url = new URL(window.location.href);
    url.searchParams.set('sandboxTab', 'files');
    url.searchParams.set('sandboxPath', target.path);
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }

  let timelineEntries = $derived(timelineFor(runDetail));
  let visibleTimelineEntries = $derived(timelineEntries.filter(entry => activeTimelineFilter === 'all' || timelineFilterTags(entry).includes(activeTimelineFilter)));
  let logScopeLabel = $derived(historyAvailable === true ? '结构化事件' : logWindow.fullyLoaded ? '全部日志' : logWindow.scope === 'tail-500' ? '显示最近 500 行' : '显示最近 100 行');
  let timelineComplete = $derived(historyAvailable === true || (historyAvailable === false && logWindow.fullyLoaded && !logError));

  function timelineFilterFor(entry: RuntimeTimelineEntry): Exclude<TimelineFilter, 'all' | 'artifact'> {
    if (entry.kind === 'warning' || entry.kind === 'error') return 'problem';
    if (entry.kind === 'run' || entry.kind === 'scheduler' || entry.kind === 'sandbox') return 'run';
    if (entry.kind === 'prompt' || entry.kind === 'output' || entry.kind === 'result') return 'message';
    if (entry.kind === 'process' && (entry.source === '用户消息' || entry.source.startsWith('智能体消息'))) return 'message';
    return 'activity';
  }

  function timelineFilterTags(entry: RuntimeTimelineEntry): Array<Exclude<TimelineFilter, 'all'>> {
    return entry.filterTags?.length ? entry.filterTags : [timelineFilterFor(entry)];
  }

  function timestampBasisLabel(basis?: string) {
    if (basis === 'run-end') return '时间依据：运行结束时间';
    if (basis === 'run-updated') return '时间依据：运行更新时间';
    return '时间依据：运行开始时间';
  }


  function statusLabel(status: RunStatus): string {
    switch (status) {
      case RunStatus.PENDING: return '等待执行';
      case RunStatus.RUNNING: return '运行中';
      case RunStatus.SUCCEEDED: return '成功';
      case RunStatus.FAILED: return '失败';
      case RunStatus.CANCELED: return '已取消';
      default: return '未知';
    }
  }
  function sourceLabel(source: RunSource): string {
    if (source === RunSource.MANUAL) return '手动';
    if (source === RunSource.SCHEDULER) return '调度器';
    if (source === RunSource.API) return 'API';
    return '-';
  }
  function isTerminalStatus(status: RunStatus) {
    return status === RunStatus.SUCCEEDED || status === RunStatus.FAILED || status === RunStatus.CANCELED;
  }
  function formatTime(timestamp: string): string {
    if (!timestamp) return '-';
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString();
  }
  function formatElapsed(startTimestamp: string, timestamp: string): string {
    const start = Date.parse(startTimestamp);
    const current = Date.parse(timestamp);
    if (Number.isNaN(start) || Number.isNaN(current)) return '-';
    const elapsed = Math.max(0, current - start);
    if (elapsed < 1000) return `+${elapsed}ms`;
    if (elapsed < 60000) return `+${(elapsed / 1000).toFixed(1)}s`;
    return `+${(elapsed / 60000).toFixed(1)}m`;
  }

  $effect(() => () => {
    logAbort?.abort();
    identityAbort?.abort();
    if (refreshTimer) clearTimeout(refreshTimer);
  });
</script>

{#if detailLoading}
  <div class="loading">加载运行详情中...</div>
{:else if detailError}
  <div class="process-error" role="alert"><span>{detailError}</span><button type="button" onclick={retryDetail}>重试运行详情</button></div>
{:else if detailNotFound}
  <div class="loading">未找到运行记录</div>
{:else if !runDetail}
  <div class="loading">未找到运行记录</div>
{:else}
        {#if eventsError}<div class="process-error" role="alert">结构化运行事件加载失败：{eventsError}</div>{/if}
        {#if evidenceError}<div class="process-error" role="alert">运行证据加载失败：{evidenceError}</div>{/if}
        {#if workspaceArtifactNotice}<div class="workspace-artifact-notice">{workspaceArtifactNotice}</div>{/if}
        <div class="section-heading" class:embedded><span>执行过程</span><span class="heading-time">{formatTime(runDetail.summary?.startedAt ?? '')} → {formatTime(runDetail.summary?.completedAt ?? '')}</span></div>
        <section class="timeline-panel" class:embedded>
        <header class="timeline-toolbar">
          <div class="timeline-filters" aria-label="时间线类型筛选">
            {#each timelineFilters as filter}<button class:active={activeTimelineFilter === filter} aria-pressed={activeTimelineFilter === filter} onclick={() => activeTimelineFilter = filter}>{timelineFilterLabels[filter]}</button>{/each}
          </div>
          <span>{timelineComplete ? '全量加载完成' : logScopeLabel} · 已展示 {visibleTimelineEntries.length} / {timelineEntries.length} 条</span>
        </header>
        {#if historyAvailable === false}
          <div class="earlier-log-notice">结构化历史不可用，以下内容根据文本日志推断{logWindow.fullyLoaded ? '' : ' · 可能存在更早日志'}</div>
          <div class="log-actions">
            {#if logLoadSucceeded && logWindow.chunks.length === 0}<span>日志接口返回 0 行</span>{/if}
            {#if logWindow.fullyLoaded}<span>已加载全部日志</span>{:else}<button disabled={logTransitioning} onclick={loadNextLogScope}>{logWindow.scope === 'tail-100' ? '加载更多（显示最近 500 行）' : '加载全部日志'}</button>{/if}
          </div>
        {/if}
        <div class="timeline-list">
          {#each visibleTimelineEntries as entry (entry.id)}
            <div class="timeline-entry-growth">
            <article class="timeline-entry {entry.kind} {entry.level}">
              <time title={entry.timestamp}><span>{formatTime(entry.timestamp)}</span><small>{formatElapsed(runDetail.summary?.startedAt ?? '', entry.timestamp)}</small></time>
              <RunExecutionTimelineEntry {entry} onOpenArtifact={openWorkspaceArtifact}>
                {#snippet lead()}{#if entry.timestampInferred}<small class="te-lead-note">{timestampBasisLabel(entry.timestampBasis)}</small>{/if}{/snippet}
                {#snippet trailing()}{#if entry.kind === 'error' && entry.source === 'log'}<div class="te-entry-actions"><button onclick={retryLogs}>重试日志加载</button></div>{/if}{/snippet}
              </RunExecutionTimelineEntry>
            </article>
            </div>
          {/each}
          {#if visibleTimelineEntries.length === 0 && activeTimelineFilter === 'artifact'}<div class="timeline-empty">本次执行没有可确认的产物记录</div>{/if}
        </div>
        </section>
{/if}

<style>
  button { cursor: pointer; }
  .section-heading { display: flex; align-items: center; margin: 13px 1px 7px; color: var(--text-secondary); font-size: var(--font-size-xs); font-weight: 700; }.heading-time { margin-left: auto; color: var(--text-muted); font-family: var(--font-mono); font-weight: 400; }
  .timeline-panel { overflow: hidden; border: 1px solid var(--border-color); border-radius: 6px; background: var(--bg-secondary); }
  .section-heading.embedded { margin: 0; padding: 11px 14px 8px; }
  .timeline-panel.embedded { border: 0; border-radius: 0; background: transparent; }
  .timeline-toolbar { display: flex; align-items: center; gap: 12px; padding: 8px; border-bottom: 1px solid var(--border-color); color: var(--text-muted); font-size: var(--font-size-xs); }.timeline-toolbar > span { margin-left: auto; white-space: nowrap; }
  .timeline-filters { display: flex; flex-wrap: wrap; gap: 4px; }.timeline-filters button, .log-actions button { padding: 3px 6px; border: 1px solid var(--border-color); border-radius: 3px; background: var(--bg-tertiary); color: var(--text-muted); font-size: var(--font-size-xs); }.timeline-filters button.active { border-color: var(--accent-blue); color: var(--accent-blue); }
  .earlier-log-notice { padding: 6px 9px; border-bottom: 1px solid var(--border-color); color: var(--accent-yellow); font-size: var(--font-size-xs); }
  .workspace-artifact-notice { padding:6px 9px; color:var(--accent-yellow); font-size:var(--font-size-xs); }
  .log-actions { display: flex; align-items: center; gap: 8px; padding: 7px 9px; border-bottom: 1px solid var(--border-color); color: var(--text-muted); font-size: var(--font-size-xs); }.timeline-error { white-space: pre-wrap; color: var(--accent-red); }
  .timeline-list { display: grid; }.timeline-entry-growth { display: grid; grid-template-rows: 1fr; min-width: 0; animation: timeline-grow 180ms ease-out both; }.timeline-entry { display: grid; min-height: 0; overflow: hidden; grid-template-columns: 145px minmax(0, 1fr); border-bottom: 1px solid var(--border-color); }.timeline-entry-growth:last-child .timeline-entry { border-bottom: 0; }.timeline-entry > time { display: grid; align-content: start; gap: 3px; padding: 10px; color: var(--text-muted); font-family: var(--font-mono); font-size: var(--font-size-xs); }.timeline-entry > time small { color: var(--text-secondary); font-size: var(--font-size-xs); }
  .timeline-empty { padding: 18px; color: var(--text-muted); font-size: var(--font-size-xs); text-align: center; }
  .loading { display: grid; flex: 1; place-items: center; color: var(--text-muted); font-size: var(--font-size-md); }
  .process-error { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 14px; color: var(--danger, #ef4444); font-size: var(--font-size-sm); }
  @keyframes timeline-grow { from { grid-template-rows: 0fr; opacity: 0; transform: translateY(-4px); } to { grid-template-rows: 1fr; opacity: 1; transform: translateY(0); } }
  @media (max-width: 760px) { .timeline-entry { grid-template-columns: 100px minmax(0, 1fr); }.heading-time { display: none; } }
  @media (prefers-reduced-motion: reduce) { .timeline-entry-growth { animation: none; } }
</style>
