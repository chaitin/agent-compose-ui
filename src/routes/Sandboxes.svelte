<script lang="ts">
  import { onMount } from 'svelte';
  import { SvelteURLSearchParams } from 'svelte/reactivity';
  import EmptyState from '$lib/components/empty-state.svelte';
  import CopyableText from '$lib/components/copyable-text.svelte';
  import StatusBadge from '$lib/components/status-badge.svelte';
  import { Button } from '$lib/components/ui/button';
  import { navigate, router } from '$lib/router.svelte';
  import { t } from '$lib/i18n.svelte';
  import { listSandboxContexts, type SandboxContext } from '../api/sessions';
  import { listRunsPage } from '../api/runs';
  import { latestAutomationRunsForSandboxes, type AutomationRun } from '../api/loaders';
  import { listProjectSummaries } from '../api/projects';
  import { resolveResource } from '../api/resources';
  import { ResourceKind, type RunSummary } from '../gen/agentcompose/v2/agentcompose_pb.js';
  import { compactIdentifier } from '../model/identifiers';
  import { RUN_STATE_LABEL, runStartedAt, runState } from '../model/run-list';
  import { formatBeijingShort, formatBeijingTime } from '../time';

  const PAGE_SIZE = 50;
  const control =
    'h-7 cursor-pointer rounded-md border border-transparent bg-muted px-2.5 text-xs text-foreground outline-none transition-colors hover:bg-accent focus-visible:border-ring';
  const statuses = ['running', 'pending', 'stopped', 'failed', 'deleting'] as const;
  const initial = new URLSearchParams(location.search);
  let sandboxes = $state<SandboxContext[]>([]);
  // 这一页只需要项目名：用 project-summaries（一次 ListProjects），不取每个项目的完整定义。
  let projects = $state<Array<{ id: string; name: string }>>([]);
  let projectId = $state(initial.get('projectId') ?? '');
  let status = $state(initial.get('status') ?? '');
  let idQuery = $state('');
  let offset = $state(Number(initial.get('offset') ?? 0) || 0);
  let total = $state(0);
  let loading = $state(true);
  let refreshing = $state(false);
  let error = $state('');
  /** 每个 sandbox 里的运行次数和最近一次运行，按 sandbox_id 查 ListRuns 得到。 */
  let runStats = $state<Record<string, { total: number; latest: RunSummary | undefined }>>({});
  /** 每个 sandbox 最近一次自动化执行（自动化建的 sandbox 没有智能体运行，靠这个说明里面跑得怎么样）。 */
  let automationRuns = $state<Record<string, AutomationRun | null>>({});
  /** 第一页且没有按状态筛选时，运行中的 sandbox 单独查出来放在最上面。 */
  let runningSandboxes = $state<SandboxContext[]>([]);
  const pinnedIds = $derived(new Set(runningSandboxes.map((item) => item.id)));
  const rest = $derived(sandboxes.filter((item) => !pinnedIds.has(item.id)));

  onMount(() => {
    void loadProjects();
    void load();
  });

  async function loadProjects(): Promise<void> {
    try {
      projects = (await listProjectSummaries()).map((project) => ({ id: project.projectId, name: project.name }));
    } catch {
      projects = [];
    }
  }

  async function load(background = false): Promise<void> {
    if (background) refreshing = true;
    else loading = true;
    error = '';
    try {
      const pinRunning = !status && offset === 0;
      const [response, running] = await Promise.all([
        listSandboxContexts(PAGE_SIZE, offset, { projectId, status: status ? [status] : [] }),
        pinRunning
          ? listSandboxContexts(PAGE_SIZE, 0, { projectId, status: ['running'] }).then((page) => page.sessions)
          : Promise.resolve([]),
      ]);
      sandboxes = response.sessions;
      runningSandboxes = running;
      total = response.totalCount;
      syncURL();
      // 手动刷新时重新统计；翻页时沿用已经查过的 sandbox。
      if (background) {
        runStats = {};
        automationRuns = {};
      }
      void loadStats([...running, ...response.sessions]);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : t('请求失败');
    } finally {
      loading = false;
      refreshing = false;
    }
  }

  /** 后端没有批量接口，只能每个 sandbox 查一次；限制并发，避免一页 50 个请求同时打到 daemon。 */
  const RUN_STATS_CONCURRENCY = 4;

  /** 先批量查自动化执行（每个项目 1 个请求）；只有没有自动化执行的 sandbox 才逐个查智能体运行。 */
  async function loadStats(items: SandboxContext[]): Promise<void> {
    const unknown = items.filter((item) => !(item.id in automationRuns));
    if (unknown.length) {
      const found = await latestAutomationRunsForSandboxes(
        unknown.map((item) => ({ sandboxId: item.id, projectId: item.projectId })),
      );
      automationRuns = {
        ...automationRuns,
        ...Object.fromEntries(unknown.map((item) => [item.id, found.get(item.id) ?? null])),
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

  function applyFilters(): void {
    offset = 0;
    void load();
  }

  function syncURL(): void {
    const query = new SvelteURLSearchParams();
    if (projectId) query.set('projectId', projectId);
    if (status) query.set('status', status);
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

  function automationStatusLabel(value: string): string {
    const status = value.toLowerCase();
    if (status === 'succeeded') return '成功';
    if (status === 'failed') return '失败';
    if (status === 'running') return '运行中';
    if (status === 'canceled' || status === 'cancelled') return '已取消';
    if (status === 'skipped') return '跳过';
    return '等待中';
  }

  function projectName(id: string): string {
    return projects.find((project) => project.id === id)?.name || (id ? compactIdentifier(id) : t('未关联项目'));
  }
</script>

{#snippet sandboxRow(sandbox: SandboxContext)}
  {@const stats = runStats[sandbox.id]}
  {@const latest = stats?.latest}
  {@const automation = automationRuns[sandbox.id]}
  <tr
    class="h-8 cursor-pointer border-b border-border transition-colors hover:bg-accent/60"
    onclick={() => navigate(`/sandboxes/${encodeURIComponent(sandbox.id)}`)}
  >
    <td class="pl-4 sm:pl-5 xl:pl-6">
      <CopyableText
        value={sandbox.id}
        display={compactIdentifier(sandbox.id)}
        label="Sandbox ID"
        class="font-mono text-[12px] text-foreground"
      />
    </td>
    <td class="truncate pr-3">
      <span class="font-medium">{sandbox.agentName || t('未命名智能体')}</span>
      <span class="text-muted-foreground"> · {projectName(sandbox.projectId)}</span>
    </td>
    <td class="truncate pr-3 text-muted-foreground">
      {#if automation}
        <span class="text-foreground/80">{t('自动化')}</span>
        <span class="px-1 text-faint">·</span>
        <StatusBadge
          status={automation.status.toLowerCase()}
          label={`最近${automationStatusLabel(automation.status)}`}
        />
      {:else if !stats}<span class="text-faint">…</span>
      {:else if !latest}<span class="text-faint">{t('没有运行')}</span>
      {:else}
        <span class="tabular-nums text-foreground/80">{t('{count} 次', { count: stats.total })}</span>
        <span class="px-1 text-faint">·</span>
        <StatusBadge status={runState(latest.status)} label={`最近${RUN_STATE_LABEL[runState(latest.status)]}`} />
      {/if}
    </td>
    <td class="text-muted-foreground">
      {#if automation?.startedAt}<time
          datetime={automation.startedAt}
          title={`${t('最近一次自动化执行')} · ${formatBeijingTime(automation.startedAt)}`}
          class="tabular-nums">{formatBeijingShort(automation.startedAt)}</time
        >{:else if latest}<time
          datetime={runStartedAt(latest)}
          title={`${t('最近一次运行')} · ${formatBeijingTime(runStartedAt(latest))}`}
          class="tabular-nums">{formatBeijingShort(runStartedAt(latest))}</time
        >{:else if sandbox.updatedAt}<time
          datetime={sandbox.updatedAt}
          title={`${t('没有智能体运行，显示 Sandbox 最近更新时间')} · ${formatBeijingTime(sandbox.updatedAt)}`}
          class="text-faint tabular-nums">{formatBeijingShort(sandbox.updatedAt)}</time
        >{:else}<span class="text-faint">—</span>{/if}
    </td>
    <td data-sandbox-status class="pr-4 sm:pr-5 xl:pr-6">
      <StatusBadge status={sandbox.status} label={statusLabel(sandbox.status)} />
      {#if sandbox.driver}<span class="ml-1 text-[11px] text-faint">{sandbox.driver}</span>{/if}
    </td>
  </tr>
{/snippet}

<div data-page-layout="collection" class="flex h-full min-h-0 flex-col">
  <h1 class="sr-only">{t('Sandboxes')}</h1>
  <div
    data-page-header
    class="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-4 py-2.5 sm:px-5 xl:px-6"
  >
    <select bind:value={status} aria-label={t('按状态筛选')} class={control} onchange={applyFilters}>
      <option value="">{t('全部状态')}</option>
      {#each statuses as value (value)}<option {value}>{statusLabel(value)}</option>{/each}
    </select>
    <select bind:value={projectId} aria-label={t('按项目筛选')} class="{control} w-40" onchange={applyFilters}>
      <option value="">{t('全部项目')}</option>
      {#each projects as project (project.id)}<option value={project.id}>{project.name}</option>{/each}
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
      <Button type="submit" variant="ghost" size="sm">{t('查找')}</Button>
    </form>
    <div class="ml-auto flex items-center gap-1.5 text-[11px] text-faint">
      <span class="tabular-nums"
        >{total ? `${offset + 1}–${offset + sandboxes.length} / ${total}` : t('共 {total} 个', { total })}</span
      >
      {#if total > PAGE_SIZE}
        <Button variant="ghost" size="sm" disabled={!offset} onclick={previous}>{t('上一页')}</Button>
        <Button variant="ghost" size="sm" disabled={offset + sandboxes.length >= total} onclick={next}
          >{t('下一页')}</Button
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
      <table data-table="dense" class="w-full min-w-[52rem] table-fixed border-collapse text-[13px]">
        <colgroup>
          <col class="w-52" />
          <col />
          <col class="w-56" />
          <col class="w-28" />
          <col class="w-48" />
        </colgroup>
        <thead class="sticky top-0 z-10 bg-background">
          <tr class="h-8 text-left text-[11px] text-faint [&>th]:border-b [&>th]:border-border [&>th]:font-normal">
            <th class="pl-4 sm:pl-5 xl:pl-6">Sandbox ID</th>
            <th>{t('智能体 · 项目')}</th>
            <th>{t('运行')}</th>
            <th>{t('最近活动')}</th>
            <th class="pr-4 sm:pr-5 xl:pr-6">{t('状态')}</th>
          </tr>
        </thead>
        {#if runningSandboxes.length}
          <tbody>
            <tr>
              <td colspan="5" class="h-7 pb-1 pl-4 align-bottom text-[11px] text-faint sm:pl-5 xl:pl-6">
                {t('运行中')} · {runningSandboxes.length}
              </td>
            </tr>
            {#each runningSandboxes as sandbox (sandbox.id)}{@render sandboxRow(sandbox)}{/each}
          </tbody>
        {/if}
        <tbody>
          {#if runningSandboxes.length && rest.length}
            <tr>
              <td colspan="5" class="h-7 pb-1 pl-4 align-bottom text-[11px] text-faint sm:pl-5 xl:pl-6">
                {t('按最近活动')}
              </td>
            </tr>
          {/if}
          {#each rest as sandbox (sandbox.id)}{@render sandboxRow(sandbox)}{/each}
        </tbody>
      </table>
    {/if}
  </div>
</div>
