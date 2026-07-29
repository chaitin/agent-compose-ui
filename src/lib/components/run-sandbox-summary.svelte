<script lang="ts">
  import type { SandboxContextDetail } from '../../api/sessions';
  import type { RunDetail } from '../../gen/agentcompose/v2/agentcompose_pb.js';
  import CopyableText from './copyable-text.svelte';
  import TechnicalDetails from './technical-details.svelte';
  import Timestamp from './timestamp.svelte';
  import StatusBadge from './status-badge.svelte';
  import { t } from '$lib/i18n.svelte';
  import { compactIdentifier } from '../../model/identifiers';
  import { presentSandboxTags } from '../../model/sandbox-tags';
  import { stoppedRuntimePresentation } from '../../model/stopped-runtime';

  let { sandbox, detail }: { sandbox: SandboxContextDetail | null; detail: RunDetail } = $props();
  const presentedTags = $derived(presentSandboxTags(sandbox?.tags ?? []));
  const stableTags = $derived(presentedTags.known.filter((tag) => tag.label !== '运行 ID'));
  const stoppedRuntime = $derived(sandbox ? stoppedRuntimePresentation(sandbox) : null);

  function formattedResult(value: string): string {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
</script>

{#if sandbox}
  <div class="space-y-4">
    <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <div class="rounded-lg border border-border bg-card p-4">
        <div class="text-xs text-muted-foreground">{t('状态')}</div>
        <div class="mt-2"><StatusBadge status={sandbox.status} /></div>
      </div>
      <div class="rounded-lg border border-border bg-card p-4">
        <div class="text-xs text-muted-foreground">{t('运行方式')}</div>
        <div class="mt-1 font-medium">{sandbox.driver || '—'}</div>
      </div>
      <div class="rounded-lg border border-border bg-card p-4 sm:col-span-2">
        <div class="text-xs text-muted-foreground">{t('运行镜像')}</div>
        <div class="mt-1 break-all font-mono text-xs">{sandbox.guestImage || '—'}</div>
      </div>
    </div>
    {#if stoppedRuntime}<div
        data-stopped-runtime-state
        class="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-3 text-sm"
      >
        <StatusBadge status={stoppedRuntime.status} label={stoppedRuntime.label} />
        <span class="min-w-0 break-words text-muted-foreground">
          {stoppedRuntime.status === 'failed' ? stoppedRuntime.description : t(stoppedRuntime.description)}
        </span>
        {#if sandbox.stoppedRuntimeReleasedAt}<Timestamp
            value={sandbox.stoppedRuntimeReleasedAt}
            class="ml-auto"
          />{/if}
      </div>{/if}
    <dl class="grid gap-x-4 gap-y-3 rounded-lg border border-border bg-card p-4 text-sm md:grid-cols-[9rem_1fr]">
      <dt class="text-muted-foreground">{t('创建时间')}</dt>
      <dd><Timestamp value={sandbox.createdAt} mode="full" /></dd>
      <dt class="text-muted-foreground">{t('更新时间')}</dt>
      <dd><Timestamp value={sandbox.updatedAt} mode="full" /></dd>
    </dl>
    {#if stableTags.length}<section data-sandbox-tags class="rounded-lg border border-border bg-card p-4">
        <h3 class="text-sm font-medium">{t('关联信息')}</h3>
        <dl class="mt-3 grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[7rem_minmax(0,1fr)]">
          {#each stableTags as tag (tag.key)}
            <dt class="text-muted-foreground">{t(tag.label)}</dt>
            <dd class="min-w-0">
              {#if tag.identifier}
                <CopyableText
                  value={tag.value}
                  display={compactIdentifier(tag.value)}
                  label={tag.label}
                  class="max-w-full font-mono text-xs"
                />
              {:else}{t(tag.value)}{/if}
            </dd>
          {/each}
        </dl>
      </section>{/if}
    <TechnicalDetails
      title="详细信息"
      items={[
        { label: '执行环境 ID', value: sandbox.id },
        { label: '工作目录', value: sandbox.workspacePath },
        ...presentedTags.other.map((tag) => ({ label: tag.name, value: tag.value, copyable: false })),
      ]}
    />
  </div>
{:else}
  <div class="rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm text-warning">
    {t('该运行的执行环境不可用或已回收；日志和事件仍可查看。')}
  </div>
{/if}

{#if detail.artifactsDir || detail.logsPath}
  <TechnicalDetails
    title="运行文件"
    class="mt-4"
    items={[
      ...(detail.artifactsDir ? [{ label: '运行目录', value: detail.artifactsDir }] : []),
      ...(detail.logsPath ? [{ label: '日志来源', value: detail.logsPath }] : []),
    ]}
  />
{/if}

{#if detail.resultJson}
  <details class="mt-4 rounded-lg border border-border bg-card p-4">
    <summary class="cursor-pointer text-sm font-medium">{t('结构化结果')}</summary>
    <pre class="mt-3 whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 text-xs leading-5">{formattedResult(
        detail.resultJson,
      )}</pre>
  </details>
{/if}
