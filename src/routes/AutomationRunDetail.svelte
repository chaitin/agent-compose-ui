<script lang="ts">
  import { onMount } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import PageHeader from '$lib/components/page-header.svelte';
  import PageContent from '$lib/components/page-content.svelte';
  import CopyableText from '$lib/components/copyable-text.svelte';
  import CopyLinkButton from '$lib/components/copy-link-button.svelte';
  import Timestamp from '$lib/components/timestamp.svelte';
  import { navigate, router } from '$lib/router.svelte';
  import { getAutomationRunById, type AutomationRun } from '../api/loaders';

  const runId = $derived(decodeURIComponent(router.path.split('/')[2] || ''));
  let run = $state<AutomationRun | null>(null);
  let loading = $state(true);
  let error = $state('');

  onMount(async () => {
    try {
      run = await getAutomationRunById(runId);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : '调度运行加载失败';
    } finally {
      loading = false;
    }
  });
</script>

<PageHeader title="调度运行详情" description={runId}>
  {#snippet actions()}<CopyLinkButton /><Button variant="outline" size="sm" onclick={() => history.back()}>返回</Button
    >{/snippet}
</PageHeader>

<PageContent class="space-y-4">
  {#if error}
    <div class="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
  {:else if loading}
    <p class="text-sm text-muted-foreground">正在加载调度运行…</p>
  {:else if run}
    <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      <section class="rounded-lg border border-border bg-card p-4">
        <div class="text-xs text-muted-foreground">状态</div>
        <div class="mt-1 font-medium">{run.status}</div>
      </section>
      <section class="rounded-lg border border-border bg-card p-4">
        <div class="text-xs text-muted-foreground">Trigger</div>
        <div class="mt-1 font-mono text-sm">{run.triggerId || '—'}</div>
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
        <dt class="text-muted-foreground">运行 ID</dt>
        <dd><CopyableText value={run.id} label="Scheduler Run ID" class="max-w-full font-mono text-xs" /></dd>
        <dt class="text-muted-foreground">开始时间</dt>
        <dd><Timestamp value={run.startedAt} mode="full" /></dd>
        <dt class="text-muted-foreground">完成时间</dt>
        <dd><Timestamp value={run.completedAt} mode="full" /></dd>
        <dt class="text-muted-foreground">错误</dt>
        <dd class:text-destructive={Boolean(run.error)}>{run.error || '—'}</dd>
        <dt class="text-muted-foreground">产物目录</dt>
        <dd class="break-all font-mono text-xs">{run.artifactsDir || '—'}</dd>
      </dl>
    </section>

    <div class="text-xs text-muted-foreground">
      为避免泄露 Webhook 请求内容，本页面不展示调度 payload 或原始 result。
    </div>
    <Button variant="outline" onclick={() => navigate('/automations')}>返回自动化任务列表</Button>
  {/if}
</PageContent>
