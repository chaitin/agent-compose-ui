<script lang="ts">
  import { onMount } from 'svelte';
  import { SvelteURLSearchParams } from 'svelte/reactivity';
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import Search from '@lucide/svelte/icons/search';
  import EmptyState from '$lib/components/empty-state.svelte';
  import CopyableText from '$lib/components/copyable-text.svelte';
  import StatusBadge from '$lib/components/status-badge.svelte';
  import { Button } from '$lib/components/ui/button';
  import { navigate, router } from '$lib/router.svelte';
  import { t } from '$lib/i18n.svelte';
  import { listAllSandboxContexts, listSandboxContexts, type SandboxContext } from '../api/sessions';
  import { listRunsPage } from '../api/runs';
  import { listProjectSummaries, listProjectViews } from '../api/projects';
  import { resolveResource } from '../api/resources';
  import { listSandboxActivity } from '../api/tasks';
  import { ResourceKind, type RunSummary } from '../gen/agentcompose/v2/agentcompose_pb.js';
  import { compactIdentifier } from '../model/identifiers';
  import {
    automationExecution,
    directExecution,
    executionDuration,
    type AutomationExecutionRecord,
    type SandboxExecution,
  } from '../model/sandbox-activity';
  import type { TaskLink } from '../model/task-list';
  import { formatBeijingShort, formatBeijingTime } from '../time';

  const PAGE_SIZE = 50;
  const control =
    'h-7 cursor-pointer rounded-md border border-transparent bg-muted px-2.5 text-xs text-foreground outline-none transition-colors hover:bg-accent focus-visible:border-ring';
  const statuses = ['running', 'pending', 'stopped', 'failed', 'deleting'] as const;
  const initial = new URLSearchParams(location.search);
  let sandboxes = $state<SandboxContext[]>([]);
  // 这一页只需要项目名：用 project-summaries（一次 ListProjects），不取每个项目的完整定义。
  let projects = $state<Array<{ id: string; name: string }>>([]);
  /** 默认看列表里的第一个项目；空串是「全部项目」，在地址栏里写成 projectId=all。 */
  const ALL_PROJECTS = 'all';
  const initialProject = initial.get('projectId');
  let defaultProjectId = $state('');
  let projectId = $state(initialProject === null || initialProject === ALL_PROJECTS ? '' : initialProject);
  /** 每个项目里的智能体，供「按智能体筛选」用；项目定义读得慢，页面显示后再补上。 */
  let projectAgents = $state<Array<{ projectId: string; projectName: string; agents: string[] }>>([]);
  let agentName = $state(initial.get('agent') ?? '');
  const agentOptions = $derived(projectAgents.filter((group) => !projectId || group.projectId === projectId));
  /** 按智能体筛选是在读回来的 sandbox 里做的；为 true 时没有读全。 */
  let agentScanTruncated = $state(false);
  /** 默认只看运行中的 sandbox；空串是「全部状态」，在地址栏里写成 status=all。 */
  const DEFAULT_STATUS = 'running';
  const ALL_STATUSES = 'all';
  const initialStatus = initial.get('status') ?? DEFAULT_STATUS;
  let status = $state(initialStatus === ALL_STATUSES ? '' : initialStatus);
  let idQuery = $state('');
  let offset = $state(Number(initial.get('offset') ?? 0) || 0);
  let total = $state(0);
  let loading = $state(true);
  let refreshing = $state(false);
  let error = $state('');
  /** 每个 sandbox 里的运行次数和最近一次运行，按 sandbox_id 查 ListRuns 得到。 */
  let runStats = $state<Record<string, { total: number; latest: RunSummary | undefined }>>({});
  /** 每个 sandbox 最近一次自动化执行（自动化建的 sandbox 没有智能体运行，靠这个说明里面跑得怎么样）。 */
  let automationRuns = $state<Record<string, AutomationExecutionRecord | null>>({});
  /** 每个 sandbox 正在处理的任务，由 UI server 给出；这套部署没配置任务字段时为空。 */
  let tasks = $state<Record<string, TaskLink | null>>({});
  let now = $state(Date.now());
  const COLUMN_COUNT = 6;
  /** 第一页且没有按状态筛选时，运行中的 sandbox 单独查出来放在最上面。 */
  let runningSandboxes = $state<SandboxContext[]>([]);
  /** 排在最上面、按「执行中 / 空闲」分组的运行中 sandbox：只看运行中时就是这一页本身。 */
  const pinned = $derived(status === 'running' ? sandboxes : runningSandboxes);
  const pinnedIds = $derived(new Set(pinned.map((item) => item.id)));
  const rest = $derived(sandboxes.filter((item) => !pinnedIds.has(item.id)));
  /** 最近一次执行还没查完时，只知道这些 sandbox 活着，不知道它们是不是在执行。 */
  const executionsPending = $derived(pinned.some((item) => executionOf(item.id) === undefined));
  /** 运行中的 sandbox 里，正在执行的排前面；活着但没有在执行的（常驻 sandbox）单独一组。 */
  const executing = $derived(executionsPending ? pinned : pinned.filter((item) => executionOf(item.id)?.running));
  const idle = $derived(executionsPending ? [] : pinned.filter((item) => !executionOf(item.id)?.running));

  onMount(() => {
    void start();
    void loadProjectAgents();
  });

  /** 地址栏没有指定项目时，要先知道第一个项目是谁才能查列表。 */
  async function start(): Promise<void> {
    const projectsLoaded = loadProjects();
    if (initialProject === null) {
      await projectsLoaded;
      projectId = defaultProjectId;
    }
    await load();
  }

  async function loadProjects(): Promise<void> {
    try {
      projects = (await listProjectSummaries()).map((project) => ({ id: project.projectId, name: project.name }));
      defaultProjectId = projects[0]?.id ?? '';
    } catch {
      projects = [];
    }
  }

  async function loadProjectAgents(): Promise<void> {
    try {
      projectAgents = (await listProjectViews())
        .map((project) => ({
          projectId: project.projectId,
          projectName: project.name,
          agents: project.agents.map((agent) => agent.agentName),
        }))
        .filter((group) => group.agents.length);
    } catch {
      projectAgents = [];
    }
  }

  /** 一页 sandbox 和置顶的运行中 sandbox。选了智能体时后端筛不了，读回全部后在这里筛和分页。 */
  async function loadPage(
    pinRunning: boolean,
  ): Promise<{ sessions: SandboxContext[]; running: SandboxContext[]; totalCount: number; truncated: boolean }> {
    if (agentName) {
      const all = await listAllSandboxContexts({ projectId, status: status ? [status] : [] });
      const matched = all.sessions.filter((item) => item.agentName === agentName);
      return {
        sessions: matched.slice(offset, offset + PAGE_SIZE),
        running: pinRunning ? matched.filter((item) => item.status === 'running') : [],
        totalCount: matched.length,
        truncated: all.truncated,
      };
    }
    const [response, running] = await Promise.all([
      listSandboxContexts(PAGE_SIZE, offset, { projectId, status: status ? [status] : [] }),
      pinRunning
        ? listSandboxContexts(PAGE_SIZE, 0, { projectId, status: ['running'] }).then((page) => page.sessions)
        : Promise.resolve([]),
    ]);
    return { sessions: response.sessions, running, totalCount: response.totalCount, truncated: false };
  }

  async function load(background = false): Promise<void> {
    if (background) refreshing = true;
    else loading = true;
    error = '';
    try {
      const response = await loadPage(!status && offset === 0);
      const running = response.running;
      sandboxes = response.sessions;
      runningSandboxes = running;
      total = response.totalCount;
      agentScanTruncated = response.truncated;
      now = Date.now();
      syncURL();
      // 手动刷新时重新统计；翻页时沿用已经查过的 sandbox。
      if (background) {
        runStats = {};
        automationRuns = {};
        tasks = {};
      }
      void loadActivity([...running, ...response.sessions]);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : t('请求失败');
    } finally {
      loading = false;
      refreshing = false;
    }
  }

  /** 后端没有批量接口，只能每个 sandbox 查一次；限制并发，避免一页 50 个请求同时打到 daemon。 */
  const RUN_STATS_CONCURRENCY = 4;

  /** 先一次查回自动化执行和任务；只有没有自动化执行的 sandbox 才逐个查智能体运行。 */
  async function loadActivity(items: SandboxContext[]): Promise<void> {
    const unknown = items.filter((item) => !(item.id in automationRuns));
    if (unknown.length) {
      const found = await listSandboxActivity(
        unknown.map((item) => ({ sandboxId: item.id, projectId: item.projectId })),
      ).catch(() => null);
      tasks = { ...tasks, ...Object.fromEntries(unknown.map((item) => [item.id, found?.tasks.get(item.id) ?? null])) };
      automationRuns = {
        ...automationRuns,
        ...Object.fromEntries(unknown.map((item) => [item.id, found?.executions.get(item.id) ?? null])),
      };
    }
    await loadRunStats(items.filter((item) => !automationRuns[item.id]));
  }

  async function loadRunStats(items: SandboxContext[]): Promise<void> {
    const queue = items.filter((item) => !runStats[item.id]);
    const worker = async (): Promise<void> => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        const id = item.id;
        try {
          const page = await listRunsPage({ sandboxId: id, limit: 1 });
          runStats = { ...runStats, [id]: { total: page.total, latest: page.runs[0] } };
        } catch {
          runStats = { ...runStats, [id]: { total: 0, latest: undefined } };
        }
      }
    };
    await Promise.all(Array.from({ length: RUN_STATS_CONCURRENCY }, worker));
  }

  function selectProject(): void {
    agentName = '';
    applyFilters();
  }

  /** 智能体选项的值是「项目 ID + 智能体名」：不同项目里可以有同名的智能体，选中时项目一起定下来。 */
  const AGENT_SEPARATOR = '\n';
  const agentValue = (project: string, agent: string) => `${project}${AGENT_SEPARATOR}${agent}`;

  function selectAgent(value: string): void {
    const [project, agent] = value.split(AGENT_SEPARATOR);
    agentName = agent ?? '';
    if (agentName) projectId = project;
    applyFilters();
  }

  function applyFilters(): void {
    offset = 0;
    void load();
  }

  function syncURL(): void {
    const query = new SvelteURLSearchParams();
    if (projectId !== defaultProjectId) query.set('projectId', projectId || ALL_PROJECTS);
    if (agentName) query.set('agent', agentName);
    if (status !== DEFAULT_STATUS) query.set('status', status || ALL_STATUSES);
    if (offset) query.set('offset', String(offset));
    const value = query.toString();
    router.replace(`/sandboxes${value ? `?${value}` : ''}`);
  }

  async function openResource(): Promise<void> {
    const value = idQuery.trim();
    if (!value) return;
    try {
      const response = await resolveResource(value);
      const target = response.targets.find((item) => item.kind === ResourceKind.SANDBOX);
      if (!target) throw new Error(t('无法解析资源 ID'));
      navigate(`/sandboxes/${encodeURIComponent(target.id)}`);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : t('无法解析资源 ID');
    }
  }

  function previous(): void {
    if (!offset) return;
    offset = Math.max(0, offset - PAGE_SIZE);
    void load();
  }

  function next(): void {
    if (offset + sandboxes.length >= total) return;
    offset += PAGE_SIZE;
    void load();
  }

  function statusLabel(value: string): string {
    return t(
      value === 'running'
        ? '运行中'
        : value === 'pending'
          ? '等待中'
          : value === 'stopped'
            ? '已停止'
            : value === 'failed'
              ? '失败'
              : value === 'deleting'
                ? '删除中'
                : value,
    );
  }

  /** 这个 sandbox 最近一次执行：还在查时为 undefined，没有执行过为 null。 */
  function executionOf(id: string): SandboxExecution | null | undefined {
    const automation = automationRuns[id];
    if (automation) return automationExecution(automation);
    const stats = runStats[id];
    if (automation === undefined || !stats) return undefined;
    return stats.latest ? directExecution(stats.latest) : null;
  }

  function projectName(id: string): string {
    return projects.find((project) => project.id === id)?.name || (id ? compactIdentifier(id) : t('未关联项目'));
  }
</script>

{#snippet sandboxRow(sandbox: SandboxContext)}
  {@const execution = executionOf(sandbox.id)}
  {@const runCount = runStats[sandbox.id]?.total ?? 0}
  {@const task = tasks[sandbox.id]}
  <tr
    class="cursor-pointer border-b border-border transition-colors hover:bg-accent/60"
    onclick={() => navigate(`/sandboxes/${encodeURIComponent(sandbox.id)}`)}
  >
    <td class="h-8 pr-3 pl-4 align-top leading-8 sm:pl-5 xl:pl-6">
      <CopyableText
        value={sandbox.id}
        display={compactIdentifier(sandbox.id)}
        label="Sandbox ID"
        class="font-mono text-[12px] text-foreground"
      />
    </td>
    <td class="min-w-0 py-1.5 pr-3 align-top leading-5">
      <div class="flex min-w-0 items-center gap-2">
        {#if execution}<StatusBadge status={execution.status} label={execution.statusLabel} dotOnly />{/if}
        {#if task}
          <span class="truncate font-medium text-foreground" title={task.title}>{task.title}</span>
          {#if task.url}<a
              href={task.url}
              target="_blank"
              rel="noopener noreferrer"
              title={t('打开任务页面')}
              aria-label={t('打开任务页面')}
              class="shrink-0 text-faint transition-colors hover:text-foreground"
              onclick={(event) => event.stopPropagation()}><ExternalLink class="size-3.5" /></a
            >{/if}
        {:else if execution}
          <span class="truncate text-foreground/80">{execution.origin}</span>
        {:else if execution === null}
          <span class="text-faint">{t('没有运行')}</span>
        {:else}
          <span class="text-faint">…</span>
        {/if}
        {#if runCount > 1}<span class="shrink-0 text-[11px] text-faint tabular-nums"
            >{t('{count} 次', { count: runCount })}</span
          >{/if}
      </div>
      {#if execution?.status === 'failed' && execution.error}
        <div class="truncate pl-3.5 font-mono text-[11.5px] leading-5 text-destructive" title={execution.error}>
          {execution.error}
        </div>
      {/if}
    </td>
    <td class="truncate pr-3 align-top leading-8">
      <span class="text-foreground/80">{sandbox.agentName || t('未命名智能体')}</span>
      <span class="text-muted-foreground"> · {projectName(sandbox.projectId)}</span>
    </td>
    <td class="pr-3 text-right align-top leading-8 tabular-nums text-muted-foreground">
      {#if execution}{executionDuration(execution, now)}{/if}
    </td>
    <td class="truncate pr-3 align-top leading-8 text-muted-foreground">
      {#if execution?.startedAt}<time
          datetime={execution.startedAt}
          title={`${t('最近一次执行')} · ${formatBeijingTime(execution.startedAt)}`}
          class="tabular-nums">{formatBeijingShort(execution.startedAt)}</time
        >{:else if sandbox.updatedAt}<time
          datetime={sandbox.updatedAt}
          title={`${t('没有执行记录，显示 Sandbox 最近更新时间')} · ${formatBeijingTime(sandbox.updatedAt)}`}
          class="text-faint tabular-nums">{formatBeijingShort(sandbox.updatedAt)}</time
        >{:else}<span class="text-faint">—</span>{/if}
    </td>
    <td data-sandbox-status class="truncate pr-4 align-top leading-8 sm:pr-5 xl:pr-6">
      <StatusBadge status={sandbox.status} label={statusLabel(sandbox.status)} />
      {#if sandbox.driver}<span class="ml-1 text-[11px] text-faint">{sandbox.driver}</span>{/if}
    </td>
  </tr>
{/snippet}

{#snippet groupHeading(label: string)}
  <tr>
    <td colspan={COLUMN_COUNT} class="pt-3 pb-1 pl-4 text-[11px] text-faint sm:pl-5 xl:pl-6">{label}</td>
  </tr>
{/snippet}

<div data-page-layout="collection" class="flex h-full min-h-0 flex-col">
  <h1 class="sr-only">{t('活动')}</h1>
  <div
    data-page-header
    class="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-4 py-2.5 sm:px-5 xl:px-6"
  >
    <select bind:value={status} aria-label={t('按状态筛选')} class={control} onchange={applyFilters}>
      <option value="">{t('全部状态')}</option>
      {#each statuses as value (value)}<option {value}>{statusLabel(value)}</option>{/each}
    </select>
    <select bind:value={projectId} aria-label={t('按项目筛选')} class="{control} w-40" onchange={selectProject}>
      <option value="">{t('全部项目')}</option>
      {#each projects as project (project.id)}<option value={project.id}>{project.name}</option>{/each}
    </select>
    <select
      value={agentName ? agentValue(projectId, agentName) : ''}
      aria-label={t('按智能体筛选')}
      class="{control} w-48"
      onchange={(event) => selectAgent(event.currentTarget.value)}
    >
      <option value="">{t('全部智能体')}</option>
      {#each agentOptions as group (group.projectId)}
        <optgroup label={group.projectName}>
          {#each group.agents as agent (agent)}
            <option value={agentValue(group.projectId, agent)}>{agent}</option>
          {/each}
        </optgroup>
      {/each}
    </select>
    <form
      class="flex items-center gap-1.5"
      onsubmit={(event) => {
        event.preventDefault();
        void openResource();
      }}
    >
      <input
        bind:value={idQuery}
        aria-label={t('Sandbox ID')}
        placeholder={t('输入 Sandbox ID')}
        class="{control} w-56 font-mono placeholder:font-sans placeholder:text-faint"
      />
      <Button type="submit" variant="ghost" size="icon-sm" title={t('查找')} aria-label={t('查找')}
        ><Search class="size-4" /></Button
      >
    </form>
    <div class="ml-auto flex items-center gap-1.5 text-[11px] text-faint">
      {#if agentScanTruncated}<span>{t('Sandbox 太多，只在最近的一部分里筛选了智能体')}</span>{/if}
      <span class="tabular-nums"
        >{total ? `${offset + 1}–${offset + sandboxes.length} / ${total}` : t('共 {total} 个', { total })}</span
      >
      {#if total > PAGE_SIZE}
        <Button
          variant="ghost"
          size="icon-sm"
          title={t('上一页')}
          aria-label={t('上一页')}
          disabled={!offset}
          onclick={previous}><ChevronLeft class="size-4" /></Button
        >
        <Button
          variant="ghost"
          size="icon-sm"
          title={t('下一页')}
          aria-label={t('下一页')}
          disabled={offset + sandboxes.length >= total}
          onclick={next}><ChevronRight class="size-4" /></Button
        >
      {/if}
      <Button variant="ghost" size="sm" disabled={refreshing} onclick={() => void load(true)}
        >{t(refreshing ? '刷新中…' : '刷新')}</Button
      >
    </div>
  </div>
  {#if error}<div data-page-error class="shrink-0 bg-destructive/8 px-4 py-2 text-xs text-destructive sm:px-5 xl:px-6">
      {error}
    </div>{/if}

  <div data-scroll-pane data-route-scroll="sandboxes" class="min-h-0 flex-1 overflow-auto">
    {#if loading && !sandboxes.length}
      <p class="px-6 py-10 text-center text-sm text-muted-foreground">{t('正在加载 Sandbox…')}</p>
    {:else if !sandboxes.length}
      <EmptyState title={t('没有匹配的 Sandbox')} />
    {:else}
      <table data-table="dense" class="w-full min-w-[68rem] table-fixed border-collapse text-[13px]">
        <colgroup>
          <col class="w-48" />
          <col />
          <col class="w-[22%]" />
          <col class="w-20" />
          <col class="w-28" />
          <col class="w-44" />
        </colgroup>
        <thead class="sticky top-0 z-10 bg-background">
          <tr class="h-8 text-left text-[11px] text-faint [&>th]:border-b [&>th]:border-border [&>th]:font-normal">
            <th class="pr-3 pl-4 sm:pl-5 xl:pl-6">Sandbox ID</th>
            <th>{t('在做什么')}</th>
            <th>{t('智能体 · 项目')}</th>
            <th class="pr-3 text-right">{t('耗时')}</th>
            <th class="pr-3">{t('最近活动')}</th>
            <th class="pr-4 sm:pr-5 xl:pr-6">{t('状态')}</th>
          </tr>
        </thead>
        {#if executing.length}
          <tbody>
            {@render groupHeading(`${t(executionsPending ? '运行中' : '执行中')} · ${executing.length}`)}
            {#each executing as sandbox (sandbox.id)}{@render sandboxRow(sandbox)}{/each}
          </tbody>
        {/if}
        {#if idle.length}
          <tbody>
            {@render groupHeading(`${t('空闲')} · ${idle.length}`)}
            {#each idle as sandbox (sandbox.id)}{@render sandboxRow(sandbox)}{/each}
          </tbody>
        {/if}
        <tbody>
          {#if pinned.length && rest.length}{@render groupHeading(t('按最近活动'))}{/if}
          {#each rest as sandbox (sandbox.id)}{@render sandboxRow(sandbox)}{/each}
        </tbody>
      </table>
    {/if}
  </div>
</div>
