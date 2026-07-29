<script lang="ts">
  import { onMount } from 'svelte';
  import * as Card from '$lib/components/ui/card';
  import { Button } from '$lib/components/ui/button';
  import PageHeader from '$lib/components/page-header.svelte';
  import StatusBadge from '$lib/components/status-badge.svelte';
  import CopyableText from '$lib/components/copyable-text.svelte';
  import Timestamp from '$lib/components/timestamp.svelte';
  import { navigate } from '$lib/router.svelte';
  import { getDashboardOverview } from '../api/dashboard';
  import { getHealthStatus } from '../api/health';
  import { durationName, listRuns, runStatusName } from '../api/runs';
  import { RunStatus } from '../gen/agentcompose/v2/agentcompose_pb.js';
  import { timestampToISOString } from '../model/timestamps';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import Terminal from '@lucide/svelte/icons/terminal';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Activity from '@lucide/svelte/icons/activity';
  import CircleCheck from '@lucide/svelte/icons/circle-check';

  type RunView = {
    id: string;
    fullId: string;
    agent: string;
    status: 'running' | 'success' | 'failed' | 'skipped' | 'pending';
    duration: string;
    startedAt: string;
  };
  type Attention = { title: string; sub: string; runId: string };
  const spineBar: Record<RunView['status'], string> = {
    running: 'bg-info',
    success: 'bg-success',
    failed: 'bg-destructive',
    skipped: 'bg-muted-foreground/40',
    pending: 'bg-muted-foreground/40',
  };

  let runs = $state<RunView[]>([]);
  let attention = $state<Attention[]>([]);
  let health = $state({ status: '连接中', cpu: '—', rss: '—' });
  let dashboard = $state({ runningCount: 0, recentCount: 0, attentionCount: 0, updatedAt: '' });
  let error = $state('');
  let refreshTimer = 0;

  const running = $derived(runs.filter((run) => run.status === 'running'));
  const recent = $derived(runs.filter((run) => run.status !== 'running'));
  const recentPreview = $derived(recent.slice(0, 8));
  const attentionPreview = $derived(attention.slice(0, 4));
  const runningPreview = $derived(running.slice(0, 4));

  onMount(() => {
    void load();
    refreshTimer = window.setInterval(load, 10_000);
    return () => window.clearInterval(refreshTimer);
  });

  async function load(): Promise<void> {
    error = '';
    try {
      const [runningItems, recentItems, dashboardValue, healthValue] = await Promise.all([
        listRuns({ status: RunStatus.RUNNING, limit: 6 }),
        listRuns({ limit: 12 }),
        getDashboardOverview(),
        getHealthStatus(),
      ]);
      const runItems = [...new Map([...runningItems, ...recentItems].map((run) => [run.runId, run])).values()];
      runs = runItems.map((run) => ({
        id: run.runShortId || run.runId,
        fullId: run.runId,
        agent: run.agentName,
        status: runStatusName(run.status),
        duration: durationName(run.durationMs),
        startedAt: timestampToISOString(run.startedAt || run.createdAt),
      }));
      attention = [
        ...runs
          .filter((run) => run.status === 'failed')
          .map((run) => ({
            title: `${run.id} · ${run.agent}`,
            sub: '运行失败',
            runId: run.fullId,
          })),
      ];
      dashboard = dashboardValue;
      health = {
        status: `v${healthValue.version}`,
        cpu: `${healthValue.processCpuPercent.toFixed(0)}%`,
        rss: `${(healthValue.processRssBytes / 1024 / 1024).toFixed(0)}M`,
      };
    } catch (cause) {
      error = cause instanceof Error ? cause.message : '概览加载失败';
    }
  }
</script>

<div data-page-layout="dashboard" class="flex min-h-full flex-col lg:h-full lg:min-h-0 lg:overflow-hidden">
  <PageHeader title="概览" description="运行状态与近期结果">
    {#snippet actions()}
      <Button variant="outline" size="sm" onclick={load}><RefreshCw class="size-3.5" /> 刷新</Button>
    {/snippet}
  </PageHeader>

  <div class="flex min-h-0 flex-1 flex-col gap-3 px-4 py-4 sm:px-5 lg:overflow-hidden xl:px-6">
    {#if error}<div class="shrink-0 rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>{/if}

    <div class="grid shrink-0 grid-cols-2 gap-2 lg:grid-cols-4">
      <button
        type="button"
        onclick={() => navigate('/runs')}
        class="flex min-w-0 items-center gap-3 rounded-lg border border-info/30 bg-info/5 px-3 py-2.5 text-left transition-colors hover:bg-info/10"
      >
        <span class="grid size-8 shrink-0 place-items-center rounded-full bg-info/15 text-info"
          ><Activity class="size-4" /></span
        >
        <span class="min-w-0"
          ><span class="block text-xs text-muted-foreground">运行中</span><span
            class="block text-xl font-semibold tabular-nums text-info">{dashboard.runningCount}</span
          ></span
        >
      </button>
      <button
        type="button"
        onclick={() => navigate('/runs')}
        class="flex min-w-0 items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-left transition-colors hover:bg-destructive/10"
      >
        <span class="grid size-8 shrink-0 place-items-center rounded-full bg-destructive/15 text-destructive"
          ><TriangleAlert class="size-4" /></span
        >
        <span class="min-w-0"
          ><span class="block text-xs text-muted-foreground">近期失败</span><span
            class="block text-xl font-semibold tabular-nums text-destructive">{attention.length}</span
          ></span
        >
      </button>
      <button
        type="button"
        onclick={() => navigate('/runs')}
        class="flex min-w-0 items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition-colors hover:bg-accent/50"
      >
        <span class="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-foreground"
          ><ChevronRight class="size-4" /></span
        >
        <span class="min-w-0"
          ><span class="block text-xs text-muted-foreground">近期运行</span><span
            class="block text-xl font-semibold tabular-nums">{dashboard.recentCount}</span
          ></span
        >
      </button>
      <div class="flex min-w-0 items-center gap-3 rounded-lg border border-success/30 bg-success/5 px-3 py-2.5">
        <span class="grid size-8 shrink-0 place-items-center rounded-full bg-success/15 text-success"
          ><CircleCheck class="size-4" /></span
        >
        <span class="min-w-0"
          ><span class="block truncate text-xs text-muted-foreground">服务 {health.status}</span><span
            class="block truncate text-sm font-semibold text-success">正常 · CPU {health.cpu} · RSS {health.rss}</span
          ></span
        >
      </div>
    </div>

    <div class="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1.45fr)_minmax(18rem,0.75fr)]">
      <Card.Root size="sm" class="min-h-0 gap-0 py-0">
        <Card.Header class="flex-row items-center justify-between border-b border-border py-2.5">
          <div>
            <Card.Title>近期结果</Card.Title>
            <p class="text-xs text-muted-foreground">最近 {recentPreview.length} 条</p>
          </div>
          <button
            type="button"
            onclick={() => navigate('/runs')}
            class="flex items-center gap-0.5 text-xs font-medium text-primary hover:underline"
            >全部运行 <ChevronRight class="size-3.5" /></button
          >
        </Card.Header>
        <Card.Content class="min-h-0 flex-1 overflow-hidden p-0">
          <table class="w-full table-fixed text-sm">
            <tbody class="divide-y divide-border">
              {#each recentPreview as r (r.fullId)}
                <tr
                  class="h-11 cursor-pointer transition-colors hover:bg-accent/50 [&>td]:px-3"
                  onclick={() => navigate(`/runs/${r.fullId}`)}
                >
                  <td class="relative w-36 font-mono text-xs font-medium">
                    <span class="absolute inset-y-0 left-0 w-0.5 {spineBar[r.status]}"></span>
                    <CopyableText value={r.fullId} display={r.id} label="Run ID" />
                  </td>
                  <td class="truncate">{r.agent}</td>
                  <td class="w-24"><StatusBadge status={r.status} /></td>
                  <td class="hidden w-16 tabular-nums text-muted-foreground xl:table-cell">{r.duration}</td>
                  <td class="hidden w-24 text-xs text-muted-foreground 2xl:table-cell"
                    ><Timestamp value={r.startedAt} /></td
                  >
                </tr>
              {:else}
                <tr><td class="p-8 text-center text-sm text-muted-foreground">暂无近期运行</td></tr>
              {/each}
            </tbody>
          </table>
        </Card.Content>
      </Card.Root>

      <div class="grid min-h-0 gap-3 lg:grid-rows-2">
        <Card.Root size="sm" class="min-h-0 gap-0 py-0">
          <Card.Header class="flex-row items-center justify-between border-b border-border py-2.5">
            <Card.Title class="flex items-center gap-2 text-destructive"
              ><TriangleAlert class="size-4" />近期失败</Card.Title
            >
            <span class="text-xs font-semibold tabular-nums text-destructive">{attention.length}</span>
          </Card.Header>
          <Card.Content class="min-h-0 flex-1 overflow-hidden p-1.5">
            {#each attentionPreview as item (item.runId)}
              <div class="flex h-10 items-center gap-2 rounded-md px-2 hover:bg-destructive/5">
                <button type="button" class="min-w-0 flex-1 text-left" onclick={() => navigate(`/runs/${item.runId}`)}>
                  <span class="block truncate font-mono text-xs font-medium">{item.title}</span>
                  <span class="block truncate text-[11px] text-destructive">{item.sub}</span>
                </button>
                <Button
                  variant="ghost"
                  size="icon"
                  class="size-7 shrink-0 text-destructive"
                  onclick={() => navigate(`/runs/${item.runId}/terminal`)}
                  title="进入终端"><Terminal class="size-3.5" /></Button
                >
              </div>
            {:else}<p class="grid h-full place-items-center text-sm text-muted-foreground">暂无失败运行</p>{/each}
          </Card.Content>
        </Card.Root>

        <Card.Root size="sm" class="min-h-0 gap-0 py-0">
          <Card.Header class="flex-row items-center justify-between border-b border-border py-2.5">
            <Card.Title class="flex items-center gap-2 text-info"><Activity class="size-4" />运行中</Card.Title>
            <span class="text-xs font-semibold tabular-nums text-info">{dashboard.runningCount}</span>
          </Card.Header>
          <Card.Content class="min-h-0 flex-1 overflow-hidden p-1.5">
            {#each runningPreview as item (item.fullId)}
              <button
                type="button"
                onclick={() => navigate(`/runs/${item.fullId}`)}
                class="flex h-10 w-full items-center justify-between gap-2 rounded-md px-2 text-left hover:bg-info/5"
              >
                <span class="min-w-0"
                  ><span class="block truncate font-mono text-xs font-medium">{item.id}</span><span
                    class="block truncate text-[11px] text-muted-foreground">{item.agent} · {item.duration}</span
                  ></span
                ><StatusBadge status="running" />
              </button>
            {:else}<p class="grid h-full place-items-center text-sm text-muted-foreground">
                {dashboard.runningCount > 0 ? '运行记录正在同步' : '当前没有运行中的任务'}
              </p>{/each}
          </Card.Content>
        </Card.Root>
      </div>
    </div>
  </div>
</div>
