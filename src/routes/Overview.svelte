<script lang="ts">
  import { onMount } from 'svelte';
  import * as Card from '$lib/components/ui/card';
  import { Button } from '$lib/components/ui/button';
  import PageHeader from '$lib/components/page-header.svelte';
  import StatusBadge from '$lib/components/status-badge.svelte';
  import Timestamp from '$lib/components/timestamp.svelte';
  import { navigate } from '$lib/router.svelte';
  import { getDashboardOverview, type DashboardActivity, type DashboardOverview } from '../api/dashboard';
  import { getHealthStatus } from '../api/health';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Activity from '@lucide/svelte/icons/activity';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import History from '@lucide/svelte/icons/history';
  import { t } from '$lib/i18n.svelte';

  let { canWrite = true }: { canWrite?: boolean } = $props();

  const emptyOverview: DashboardOverview = {
    runningCount: 0,
    recentCount: 0,
    attentionCount: 0,
    updatedAt: '',
    activities: [],
  };

  let overview = $state<DashboardOverview>(emptyOverview);
  let health = $state({ status: '连接中', detail: '—', healthy: false });
  let error = $state('');
  let loading = $state(true);
  let refreshTimer = 0;

  onMount(() => {
    void load();
    refreshTimer = window.setInterval(load, 10_000);
    return () => window.clearInterval(refreshTimer);
  });

  async function load(): Promise<void> {
    loading = true;
    error = '';
    const [overviewResult, healthResult] = await Promise.allSettled([getDashboardOverview(), getHealthStatus()]);
    if (overviewResult.status === 'fulfilled') {
      overview = overviewResult.value;
    } else {
      error = errorMessage(overviewResult.reason, t('概览加载失败'));
    }
    if (healthResult.status === 'fulfilled') {
      const value = healthResult.value;
      health = {
        status: '正常',
        detail: `v${value.version} · CPU ${value.processCpuPercent.toFixed(0)}% · RSS ${formatMemory(value.processRssBytes)}`,
        healthy: true,
      };
    } else {
      health = {
        status: '连接异常',
        detail: errorMessage(healthResult.reason, t('无法连接 UI server')),
        healthy: false,
      };
    }
    loading = false;
  }

  function activityName(activity: DashboardActivity): string {
    return activity.name || t('未命名执行');
  }

  function triggerLabel(activity: DashboardActivity): string {
    const source = activity.triggerSource.trim().toLowerCase();
    const kind = activity.triggerKind.trim().toLowerCase();
    if (source === 'invoke') return 'Invoke';
    if (source === 'manual') return t('手动');
    if (source === 'api') return 'API';
    if (kind === 'cron' || source === 'cron') return 'Cron';
    if (kind === 'interval' || source === 'interval') return t('定时');
    if (kind === 'event' || source === 'event') return t('事件');
    if (kind === 'timeout' || source === 'timeout') return t('超时');
    if (source === 'scheduler') return t('自动化');
    return activity.triggerSource || activity.triggerKind || t('未知来源');
  }

  function durationLabel(activity: DashboardActivity): string {
    let milliseconds = activity.durationMs;
    if (milliseconds <= 0 && isRunning(activity.status) && activity.startedAt) {
      milliseconds = Math.max(0, Date.now() - new Date(activity.startedAt).getTime());
    }
    const seconds = Math.max(0, Math.round(milliseconds / 1000));
    if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
    if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  function activityTime(activity: DashboardActivity): string {
    return activity.startedAt || activity.updatedAt;
  }

  function openActivity(activity: DashboardActivity): void {
    if (activity.projectRunId) {
      navigate(`/runs/${encodeURIComponent(activity.projectRunId)}`);
      return;
    }
    if (activity.schedulerRunId && activity.projectId) {
      navigate(
        `/projects/${encodeURIComponent(activity.projectId)}/automation-runs/${encodeURIComponent(activity.schedulerRunId)}`,
      );
      return;
    }
    if (activity.sandboxId) {
      navigate(`/sandboxes/${encodeURIComponent(activity.sandboxId)}`);
      return;
    }
    navigate(
      activity.projectId
        ? `/projects/${encodeURIComponent(activity.projectId)}/automations${activity.agentName ? `?agent=${encodeURIComponent(activity.agentName)}` : ''}`
        : '/projects',
    );
  }

  function onActivityKeydown(event: KeyboardEvent, activity: DashboardActivity): void {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openActivity(activity);
  }

  function isRunning(status: string): boolean {
    return ['running', 'pending', 'active', 'processing'].includes(status.trim().toLowerCase());
  }

  function formatMemory(bytes: number): string {
    return `${Math.round(bytes / 1024 / 1024)}M`;
  }

  function errorMessage(cause: unknown, fallback: string): string {
    return cause instanceof Error && cause.message ? cause.message : fallback;
  }
</script>

<div
  data-page-layout="dashboard"
  data-readonly={!canWrite}
  class="flex min-h-full flex-col lg:h-full lg:min-h-0 lg:overflow-hidden"
>
  <PageHeader title="概览" description="工作区运行态势与最新执行活动">
    {#snippet actions()}
      <Button variant="outline" size="sm" onclick={load} disabled={loading}>
        <RefreshCw class={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
        {loading ? t('刷新中…') : t('刷新')}
      </Button>
    {/snippet}
  </PageHeader>

  <div
    data-page-frame
    class="mx-auto flex min-h-0 w-full max-w-[112rem] flex-1 flex-col gap-3 px-4 py-4 sm:px-5 lg:overflow-hidden xl:px-6"
  >
    {#if error}<div class="shrink-0 rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>{/if}

    <div class="grid shrink-0 grid-cols-2 gap-2 lg:grid-cols-4">
      <div class="flex min-w-0 items-center gap-3 rounded-lg border border-info/30 bg-info/5 px-3 py-2.5">
        <span class="grid size-8 shrink-0 place-items-center rounded-full bg-info/15 text-info"
          ><Activity class="size-4" /></span
        >
        <span class="min-w-0">
          <span class="block text-xs text-muted-foreground">{t('运行中')}</span>
          <span class="block text-xl font-semibold tabular-nums text-info">{overview.runningCount}</span>
        </span>
      </div>
      <div class="flex min-w-0 items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5">
        <span class="grid size-8 shrink-0 place-items-center rounded-full bg-destructive/15 text-destructive"
          ><TriangleAlert class="size-4" /></span
        >
        <span class="min-w-0">
          <span class="block text-xs text-muted-foreground">{t('需要关注')}</span>
          <span class="block text-xl font-semibold tabular-nums text-destructive">{overview.attentionCount}</span>
        </span>
      </div>
      <div class="flex min-w-0 items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5">
        <span class="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-foreground"
          ><History class="size-4" /></span
        >
        <span class="min-w-0">
          <span class="block text-xs text-muted-foreground">{t('近期活动')}</span>
          <span class="block text-xl font-semibold tabular-nums">{overview.recentCount}</span>
        </span>
      </div>
      <div
        class="flex min-w-0 items-center gap-3 rounded-lg border {health.healthy
          ? 'border-success/30 bg-success/5'
          : 'border-warning/30 bg-warning/5'} px-3 py-2.5"
      >
        <span
          class="grid size-8 shrink-0 place-items-center rounded-full {health.healthy
            ? 'bg-success/15 text-success'
            : 'bg-warning/15 text-warning-foreground'}"><CircleCheck class="size-4" /></span
        >
        <span class="min-w-0">
          <span class="block truncate text-xs text-muted-foreground">{t('服务健康')}</span>
          <span
            class="block truncate text-sm font-semibold {health.healthy ? 'text-success' : 'text-warning-foreground'}"
            >{t(health.status)} · {health.detail}</span
          >
        </span>
      </div>
    </div>

    <Card.Root size="sm" class="min-h-0 flex-1 gap-0 py-0">
      <Card.Header class="flex-row items-center justify-between border-b border-border py-3">
        <div>
          <Card.Title>{t('最近执行')}</Card.Title>
          <p class="text-xs text-muted-foreground">{t('项目运行与自动化运行的最新记录')}</p>
        </div>
      </Card.Header>
      <Card.Content class="min-h-0 flex-1 overflow-auto p-0">
        <table class="w-full min-w-[44rem] table-fixed text-sm">
          <thead class="sticky top-0 z-10 border-b border-border bg-card text-left text-xs text-muted-foreground">
            <tr class="h-9 [&>th]:px-4 [&>th]:font-medium">
              <th>{t('名称')}</th>
              <th class="w-28">{t('状态')}</th>
              <th class="w-28">{t('触发方式')}</th>
              <th class="w-36">{t('时间')}</th>
              <th class="w-24 text-right">{t('耗时')}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border">
            {#each overview.activities as activity (activity.id)}
              <tr
                role="link"
                tabindex="0"
                class="h-12 cursor-pointer outline-none transition-colors hover:bg-accent/50 focus-visible:bg-accent/60 [&>td]:px-4"
                onclick={() => openActivity(activity)}
                onkeydown={(event) => onActivityKeydown(event, activity)}
              >
                <td class="min-w-0">
                  <span class="block truncate font-medium">{activityName(activity)}</span>
                </td>
                <td><StatusBadge status={activity.status} /></td>
                <td class="text-muted-foreground">{triggerLabel(activity)}</td>
                <td class="text-xs text-muted-foreground"><Timestamp value={activityTime(activity)} /></td>
                <td class="text-right tabular-nums text-muted-foreground">{durationLabel(activity)}</td>
              </tr>
            {:else}
              <tr
                ><td colspan="5" class="p-12 text-center text-sm text-muted-foreground"
                  >{loading ? t('正在加载…') : t('暂无执行记录')}</td
                ></tr
              >
            {/each}
          </tbody>
        </table>
      </Card.Content>
    </Card.Root>
  </div>
</div>
