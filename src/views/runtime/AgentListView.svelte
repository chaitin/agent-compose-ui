<script lang="ts">
  import { projectService, runService } from '../../lib/rpc';
  import { store } from '../../lib/stores.svelte';
  import RuntimeBreadcrumb from './RuntimeBreadcrumb.svelte';
  import { GetProjectRequest, GetSchedulerRequest, ListRunsRequest, ListSchedulerEventsRequest, type RunSummary, type SchedulerEvent } from '../../gen/agentcompose/v2/agentcompose_pb';
  import { groupSchedulerExecutions, mergeAgentOwnedExecutions, type AgentOwnedExecution } from '../../lib/agent-owned-executions';

  interface AgentInfo {
    agentName: string;
    schedulerEnabled: boolean;
    runningRunCount: number;
    latestRun: AgentOwnedExecution | null;
    totalRuns: number | null;
    nextRunAt: Date | null;
    runLoading: boolean;
    runError: boolean;
  }

  let projectName = $derived(
    store.projects.find(p => p.summary.projectId === store.activeProjectId)?.summary.name
    ?? store.activeProjectId
  );

  let agents: AgentInfo[] = $state([]);
  let loading = $state(true);

  $effect(() => {
    void store.runtimeRefreshVersion;
    if (!store.activeProjectId) { loading = false; return; }
    (async () => {
      loading = true;
      try {
        const req = new GetProjectRequest({
          project: { projectId: store.activeProjectId },
          includeSpec: true,
        });
        const resp: any = await projectService.getProject(req);
        const projectAgents = resp.project?.agents || [];
        const specAgents = resp.project?.spec?.agents || [];
        const specMap: Record<string, any> = {};
        for (const s of specAgents) specMap[s.name] = s;

        const list: AgentInfo[] = projectAgents.map((pa: any) => {
          const spec = specMap[pa.agentName];
          return {
            agentName: pa.agentName,
            schedulerEnabled: pa.schedulerEnabled || spec?.scheduler?.enabled || false,
            runningRunCount: Number(pa.currentRun?.runningRunCount ?? 0),
            latestRun: null,
            totalRuns: null,
            nextRunAt: null,
            runLoading: true,
            runError: false,
          };
        });
        agents = list;

        // Fetch operational statistics for each agent.
        for (const a of agents) {
          fetchOperationalStats(a, store.activeProjectId);
        }
      } catch (e: any) {
        store.addToast(e.message || '加载智能体列表失败', 'error');
      } finally {
        loading = false;
      }
    })();
  });

  async function loadProjectRuns(projectId: string, agentName: string): Promise<RunSummary[]> {
    const pageSize = 200;
    const runs: RunSummary[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const resp: any = await runService.listRuns(new ListRunsRequest({ projectId, agentName, offset, limit: pageSize }));
      const page: RunSummary[] = resp.runs || [];
      runs.push(...page);
      if (page.length < pageSize) return runs;
    }
  }

  async function loadSchedulerEvents(projectId: string, agentName: string): Promise<SchedulerEvent[]> {
    const events: SchedulerEvent[] = [];
    const seenCursors = new Set<string>();
    let cursor = '';
    do {
      if (seenCursors.has(cursor)) throw new Error('Scheduler 历史返回了重复游标');
      seenCursors.add(cursor);
      const resp: any = await projectService.listSchedulerEvents(new ListSchedulerEventsRequest({
        project: { projectId }, agentName, limit: 500, cursor,
      }));
      events.push(...(resp.events || []));
      cursor = resp.nextCursor || '';
    } while (cursor);
    return events;
  }

  async function fetchOperationalStats(a: AgentInfo, projectId: string) {
    try {
      const [projectRuns, schedulerEvents] = await Promise.all([
        loadProjectRuns(projectId, a.agentName), loadSchedulerEvents(projectId, a.agentName),
      ]);
      const executions = await mergeAgentOwnedExecutions(
        projectRuns, groupSchedulerExecutions(schedulerEvents), { projectId, agentName: a.agentName },
      );
      a.latestRun = executions[0] ?? null;
      a.totalRuns = executions.length;
      a.runError = false;
    } catch {
      a.runError = true;
    }
    if (a.schedulerEnabled) {
      try {
        const resp: any = await projectService.getScheduler(new GetSchedulerRequest({
          project: { projectId }, agentName: a.agentName,
        }));
        const dates = (resp.triggers || [])
          .filter((trigger: any) => trigger.enabled !== false)
          .map((trigger: any) => timestampToDate(trigger.nextFireAt))
          .filter((date: Date | null): date is Date => date !== null);
        a.nextRunAt = dates.sort((left: Date, right: Date) => left.getTime() - right.getTime())[0] ?? null;
      } catch {
        a.nextRunAt = null;
      }
    }
    a.runLoading = false;
  }

  function timestampToDate(value: any): Date | null {
    if (!value) return null;
    if (value instanceof Date) return value;
    if (typeof value === 'string') {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    if (typeof value.toDate === 'function') return value.toDate();
    if (value.seconds !== undefined) {
      return new Date(Number(value.seconds) * 1000 + Number(value.nanos ?? 0) / 1_000_000);
    }
    return null;
  }

  function statusLabel(s: AgentOwnedExecution['status']): string {
    switch (s) {
      case 'succeeded': return '成功';
      case 'running': return '运行中';
      case 'failed': return '失败';
      case 'pending': return '等待中';
      case 'canceled': return '已取消';
      case 'skipped': return '已跳过';
      default: return '未知';
    }
  }

  function statusClass(s: AgentOwnedExecution['status'] | undefined): string {
    if (s === 'running') return 'status-running';
    if (s === 'succeeded') return 'status-ok';
    if (s === 'failed') return 'status-err';
    return '';
  }

  function formatDateTime(value: string | Date | null): string {
    if (!value) return '-';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    const pad = (part: number) => String(part).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }
</script>

<div class="root">
  <RuntimeBreadcrumb
    eyebrow="智能体列表"
    title={projectName}
    actions={[
      { label: '最近运行结果 →', onclick: () => store.navigateTo('latest-run'), variant: 'back', hidden: true },
    ]}
  />

  {#if loading}
    <div class="loading">加载中...</div>
  {:else if agents.length === 0}
    <div class="empty">暂无智能体。请启用一个项目来查看。</div>
  {:else}
    <div class="agent-list">
      {#each agents as a (a.agentName)}
        <button class="agent-card" class:running={a.runningRunCount > 0} class:failed={a.latestRun?.status === 'failed'} onclick={() => store.navigateTo('agent-detail', { agentName: a.agentName })}>
          <div class="agent-identity">
            <span class="agent-name">{a.agentName}</span>
            <span class="current-status" class:status-idle={a.runningRunCount === 0} class:status-running={a.runningRunCount > 0}>
              <i></i>{a.runningRunCount > 0 ? '运行中' : '空闲'}
            </span>
          </div>
          <div class="card-metrics">
            <span class="metric"><small>最近执行结果</small><b class={a.runError ? 'status-err' : statusClass(a.latestRun?.status)}>{a.runLoading ? '加载中' : a.runError ? '加载失败' : a.latestRun ? statusLabel(a.latestRun.status) : '-'}</b></span>
            <span class="metric"><small>累计运行</small><b>{a.runLoading || a.runError || a.totalRuns === null ? '-' : `${a.totalRuns} 次`}</b></span>
            <span class="metric"><small>最近执行时间</small><b class="mono">{a.runLoading ? '加载中' : formatDateTime(a.latestRun?.startedAt || null)}</b></span>
            <span class="metric"><small>下一次执行时间</small><b class="mono">{a.runLoading ? '加载中' : a.nextRunAt ? formatDateTime(a.nextRunAt) : '未设置'}</b></span>
          </div>
          <span class="arrow">&#8594;</span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .root {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  .loading, .empty {
    padding: 24px;
    color: var(--text-muted);
    text-align: center;
    flex: 1;
  }

  .agent-list {
    flex: 1;
    overflow-y: auto;
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    container-type: inline-size;
  }

  .agent-card {
    position: relative;
    display: grid;
    grid-template-columns: minmax(150px, .68fr) minmax(330px, 1.4fr) 18px;
    align-items: stretch;
    gap: 16px;
    width: 100%;
    padding: 6px 14px 6px 16px;
    overflow: hidden;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    background: var(--bg-secondary);
    cursor: pointer;
    font-family: inherit;
    font-size: inherit;
    color: inherit;
    text-align: left;
    transition: border-color .15s, background .15s, transform .15s;
  }
  .agent-card::before {
    content: '';
    position: absolute;
    inset: 0 auto 0 0;
    width: 2px;
    background: var(--text-muted);
  }
  .agent-card.running::before { background: var(--accent-green); }
  .agent-card.failed::before { background: var(--accent-red); }
  .agent-card:hover { border-color: var(--text-muted); transform: translateY(-1px); }

  .agent-identity {
    display: flex;
    min-width: 0;
    flex-direction: column;
    justify-content: center;
    align-items: flex-start;
    gap: 3px;
  }
  .agent-name {
    max-width: 100%;
    overflow: hidden;
    font-size: var(--font-size-lg);
    font-weight: 700;
    line-height: 1.1;
    color: var(--text-primary);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .current-status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: var(--font-size-xs);
    line-height: 1.1;
    color: var(--text-muted);
  }
  .current-status i {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
  }
  .current-status.status-idle { color: #8badd9; }
  .current-status.status-running { color: var(--accent-green); }
  .current-status.status-running i { animation: pulse 1.2s ease-in-out infinite; }

  .card-metrics {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1px;
    background: var(--border-color);
  }
  .metric {
    min-width: 0;
    padding: 4px 9px;
    background: var(--bg-primary);
  }
  .metric small {
    display: block;
    margin-bottom: 3px;
    font-size: var(--font-size-xs);
    line-height: 1.1;
    color: var(--text-muted);
  }
  .metric b {
    display: block;
    overflow: hidden;
    color: var(--text-primary);
    font-size: var(--font-size-xs);
    font-weight: 500;
    line-height: 1.1;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .metric b.status-ok, .metric b.status-running { color: var(--accent-green); }
  .metric b.status-err { color: var(--accent-red); }
  .arrow {
    align-self: center;
    font-size: 14px;
    color: var(--text-muted);
    transition: transform 0.15s, color 0.15s;
  }
  .agent-card:hover .arrow {
    transform: translateX(3px);
    color: var(--accent-blue);
  }

  .mono { font-family: var(--font-mono); }

  @container (max-width: 560px) {
    .agent-card { grid-template-columns: 1fr 18px; gap: 12px; }
    .agent-identity { grid-column: 1; }
    .card-metrics { grid-column: 1; }
    .arrow { grid-column: 2; grid-row: 1 / span 2; }
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }
</style>
