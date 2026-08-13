<script lang="ts">
  import { onMount } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import PageHeader from '$lib/components/page-header.svelte';
  import PageContent from '$lib/components/page-content.svelte';
  import CopyableText from '$lib/components/copyable-text.svelte';
  import CopyLinkButton from '$lib/components/copy-link-button.svelte';
  import StatusBadge from '$lib/components/status-badge.svelte';
  import TechnicalDetails from '$lib/components/technical-details.svelte';
  import Timestamp from '$lib/components/timestamp.svelte';
  import { router } from '$lib/router.svelte';
  import { getAutomationRun, getAutomationRunById, type AutomationRun } from '../api/loaders';
  import { durationName, listRuns, runStatusName } from '../api/runs';
  import type { RunSummary } from '../gen/agentcompose/v2/agentcompose_pb.js';
  import { parseAutomationResult } from '../model/automation-result';
  import { compactIdentifier } from '../model/identifiers';
  import { triggerKindLabel } from '../model/presentation';
  import { timestampToISOString } from '../model/timestamps';
  import { t } from '$lib/i18n.svelte';

  const runId = $derived(decodeURIComponent(router.path.split('/')[2] || ''));
  let run = $state<AutomationRun | null>(null);
  let environments = $state<Array<{ sandboxId: string; runs: RunSummary[] }>>([]);
  let loading = $state(true);
  let error = $state('');
  let loadVersion = 0;
  const result = $derived(parseAutomationResult(run?.resultJson ?? ''));

  onMount(() => {
    const onPop = () => void load();
    window.addEventListener('popstate', onPop);
    void load();
    return () => window.removeEventListener('popstate', onPop);
  });

  async function load(): Promise<void> {
    const version = ++loadVersion;
    loading = true;
    error = '';
    run = null;
    environments = [];
    try {
      const nextRun = await resolveAutomationRun();
      if (version !== loadVersion) return;
      run = nextRun;
      const parsedResult = parseAutomationResult(nextRun.resultJson);
      const sandboxIds = [...new Set([...nextRun.sandboxIds, parsedResult.sandboxId].filter(Boolean))];
      const nextEnvironments = await Promise.all(
        sandboxIds.map(async (sandboxId) => {
          let items: RunSummary[] = [];
          try {
            items = await listRuns({
              sandboxId,
              schedulerId: nextRun.loaderId,
              schedulerRunId: nextRun.id,
              limit: 200,
            });
          } catch {
            // The scheduler result remains useful even if related Agent Runs cannot be loaded.
          }
          if (version !== loadVersion) return { sandboxId, runs: [] };
          return {
            sandboxId,
            runs: items.filter(
              (item) =>
                (!nextRun.triggerId || item.triggerId === nextRun.triggerId) &&
                (item.schedulerRunId ? item.schedulerRunId === nextRun.id : inExecutionWindow(item, nextRun)),
            ),
          };
        }),
      );
      if (version !== loadVersion) return;
      environments = nextEnvironments;
    } catch (cause) {
      if (version === loadVersion) error = cause instanceof Error ? cause.message : '自动化运行加载失败';
    } finally {
      if (version === loadVersion) loading = false;
    }
  }

  async function resolveAutomationRun(): Promise<AutomationRun> {
    const loaderId = decodeURIComponent(new URLSearchParams(location.search).get('loaderId') ?? '');
    if (!loaderId) return getAutomationRunById(runId);
    try {
      return await getAutomationRun(loaderId, runId);
    } catch {
      return getAutomationRunById(runId);
    }
  }

  function inExecutionWindow(item: RunSummary, automationRun: AutomationRun): boolean {
    const itemTime = Date.parse(timestampToISOString(item.startedAt || item.createdAt));
    const startedAt = Date.parse(automationRun.startedAt);
    const completedAt = Date.parse(automationRun.completedAt);
    if (!Number.isFinite(itemTime) || !Number.isFinite(startedAt)) return true;
    if (itemTime < startedAt - 10_000) return false;
    return !Number.isFinite(completedAt) || itemTime <= completedAt + 10_000;
  }
</script>

<PageHeader title={t('自动化运行详情')}>
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

    <section class="rounded-lg border border-border bg-card p-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 class="font-medium">{t('关联执行环境')}</h2>
          <p class="mt-1 text-xs text-muted-foreground">{t('自动化脚本创建或复用的 Sandbox，以及其中的 Agent Run')}</p>
        </div>
        <span class="text-xs text-muted-foreground">{environments.length} {t('个执行环境')}</span>
      </div>
      <div class="mt-3 space-y-3">
        {#each environments as environment (environment.sandboxId)}
          <div class="overflow-hidden rounded-lg border border-border">
            <div class="flex flex-wrap items-center justify-between gap-2 bg-muted/35 px-3 py-2">
              <CopyableText
                value={environment.sandboxId}
                display={compactIdentifier(environment.sandboxId)}
                label={t('执行环境 ID')}
                class="font-mono text-xs"
              />
              <Button variant="outline" size="sm" href={`/sandboxes/${encodeURIComponent(environment.sandboxId)}`}
                >{t('查看执行环境')}</Button
              >
            </div>
            {#if environment.runs.length}
              <div class="divide-y divide-border">
                {#each environment.runs as agentRun (agentRun.runId)}
                  <div class="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                    <StatusBadge status={runStatusName(agentRun.status)} />
                    <div class="min-w-0 flex-1">
                      <div class="truncate font-medium">{agentRun.agentName || '未命名智能体'}</div>
                      <div class="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <CopyableText
                          value={agentRun.runId}
                          display={agentRun.runShortId || compactIdentifier(agentRun.runId)}
                          label={t('运行 ID')}
                          class="font-mono"
                        />
                        <Timestamp value={timestampToISOString(agentRun.startedAt || agentRun.createdAt)} />
                        {#if agentRun.durationMs > 0}<span>{durationName(agentRun.durationMs)}</span>{/if}
                      </div>
                    </div>
                    <Button variant="ghost" size="sm" href={`/runs/${encodeURIComponent(agentRun.runId)}`}
                      >{t('查看 Run')}</Button
                    >
                  </div>
                {/each}
              </div>
            {:else}
              <p class="px-3 py-4 text-sm text-muted-foreground">{t('这个自动化执行没有找到关联的 Agent Run。')}</p>
            {/if}
          </div>
        {:else}
          <p class="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            {t('这个自动化执行没有创建或关联 Sandbox。')}
          </p>
        {/each}
      </div>
    </section>

    <TechnicalDetails
      title="运行标识"
      items={[
        { label: t('运行 ID'), value: run.id },
        { label: t('自动化 ID'), value: run.loaderId },
        { label: t('触发条件 ID'), value: run.triggerId },
        { label: t('执行环境 ID'), value: environments.map((item) => item.sandboxId).join(', ') },
        { label: t('执行单元 ID'), value: result.cellId },
        { label: t('产物目录'), value: run.artifactsDir },
        { label: t('原始结果'), value: result.raw },
      ]}
    />
  {/if}
</PageContent>
