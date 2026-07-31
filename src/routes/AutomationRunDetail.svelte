<script lang="ts">
  import { onMount } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import PageHeader from '$lib/components/page-header.svelte';
  import PageContent from '$lib/components/page-content.svelte';
  import CopyLinkButton from '$lib/components/copy-link-button.svelte';
  import StatusBadge from '$lib/components/status-badge.svelte';
  import TechnicalDetails from '$lib/components/technical-details.svelte';
  import Timestamp from '$lib/components/timestamp.svelte';
  import { router } from '$lib/router.svelte';
  import { getAutomationRun, type AutomationRun } from '../api/loaders';
  import { parseAutomationResult } from '../model/automation-result';
  import { triggerKindLabel } from '../model/presentation';

  const parts = $derived(router.path.split('/').filter(Boolean));
  const projectId = $derived(decodeURIComponent(parts[1] || ''));
  const runId = $derived(decodeURIComponent(parts[3] || ''));
  let run = $state<AutomationRun | null>(null);
  let loading = $state(true);
  let error = $state('');
  const result = $derived(parseAutomationResult(run?.resultJson ?? ''));

  onMount(async () => {
    try {
      run = await getAutomationRun(projectId, runId);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : '自动化运行加载失败';
    } finally {
      loading = false;
    }
  });
</script>

<PageHeader title="自动化运行详情">
  {#snippet actions()}<CopyLinkButton /><Button variant="outline" size="sm" onclick={() => history.back()}>返回</Button
    >{/snippet}
</PageHeader>

<PageContent class="space-y-4">
  {#if error}
    <div class="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
  {:else if loading}
    <p class="text-sm text-muted-foreground">正在加载自动化运行…</p>
  {:else if run}
    <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      <section class="rounded-lg border border-border bg-card p-4">
        <div class="text-xs text-muted-foreground">状态</div>
        <div class="mt-1"><StatusBadge status={run.status} /></div>
      </section>
      <section class="rounded-lg border border-border bg-card p-4">
        <div class="text-xs text-muted-foreground">触发条件</div>
        <div class="mt-1 text-sm">{triggerKindLabel(run.triggerKind)}</div>
      </section>
      <section class="rounded-lg border border-border bg-card p-4">
        <div class="text-xs text-muted-foreground">触发来源</div>
        <div class="mt-1">{run.triggerSource || run.triggerKind || '—'}</div>
      </section>
      <section class="rounded-lg border border-border bg-card p-4">
        <div class="text-xs text-muted-foreground">耗时</div>
        <div class="mt-1">{run.durationMs} ms</div>
      </section>
    </div>

    <section class="rounded-lg border border-border bg-card p-4">
      <dl class="grid gap-x-4 gap-y-3 text-sm md:grid-cols-[9rem_1fr]">
        <dt class="text-muted-foreground">开始时间</dt>
        <dd><Timestamp value={run.startedAt} mode="full" /></dd>
        <dt class="text-muted-foreground">完成时间</dt>
        <dd><Timestamp value={run.completedAt} mode="full" /></dd>
        <dt class="text-muted-foreground">错误</dt>
        <dd class:text-destructive={Boolean(run.error)}>{run.error || '—'}</dd>
      </dl>
    </section>
    {#if result.output || run.error}<section class="rounded-lg border border-border bg-card p-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h2 class="font-medium">执行结果</h2>
          {#if result.sandboxId}<Button variant="outline" size="sm" href={`/sandboxes/${result.sandboxId}`}
              >查看执行环境</Button
            >{/if}
        </div>
        {#if result.output}<pre
            data-automation-output
            class="mt-3 max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-slate-700 bg-[#0b1018] p-4 font-mono text-xs leading-5 text-[#cdd6e3]">{result.output}</pre>{:else}<p
            class="mt-3 text-sm text-destructive"
          >
            {run.error}
          </p>{/if}
        {#if result.success !== undefined || result.exitCode !== undefined}<div
            class="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"
          >
            {#if result.success !== undefined}<span>{result.success ? '执行成功' : '执行失败'}</span>{/if}
            {#if result.exitCode !== undefined}<span>退出码 {result.exitCode}</span>{/if}
          </div>{/if}
      </section>{/if}
    <TechnicalDetails
      title="运行标识"
      items={[
        { label: '运行 ID', value: run.id },
        { label: '触发条件 ID', value: run.triggerId },
        { label: '执行环境 ID', value: result.sandboxId },
        { label: '执行单元 ID', value: result.cellId },
        { label: '产物目录', value: run.artifactsDir },
        { label: '原始结果', value: result.raw },
      ]}
    />
  {/if}
</PageContent>
