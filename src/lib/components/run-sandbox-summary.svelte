<script lang="ts">
  import type { SandboxContextDetail } from '../../api/sessions';
  import type { RunDetail } from '../../gen/agentcompose/v2/agentcompose_pb.js';
  import CopyableText from './copyable-text.svelte';
  import Timestamp from './timestamp.svelte';
  import { t } from '$lib/i18n.svelte';

  let { sandbox, detail }: { sandbox: SandboxContextDetail | null; detail: RunDetail } = $props();

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
        <div class="mt-1 font-medium">{sandbox.status}</div>
      </div>
      <div class="rounded-lg border border-border bg-card p-4">
        <div class="text-xs text-muted-foreground">Driver</div>
        <div class="mt-1 font-medium">{sandbox.driver || '—'}</div>
      </div>
      <div class="rounded-lg border border-border bg-card p-4 sm:col-span-2">
        <div class="text-xs text-muted-foreground">Guest image</div>
        <div class="mt-1 break-all font-mono text-xs">{sandbox.guestImage || '—'}</div>
      </div>
    </div>
    <dl class="grid gap-x-4 gap-y-3 rounded-lg border border-border bg-card p-4 text-sm md:grid-cols-[9rem_1fr]">
      <dt class="text-muted-foreground">沙箱 ID</dt>
      <dd><CopyableText value={sandbox.id} label="Sandbox ID" class="max-w-full font-mono text-xs" /></dd>
      <dt class="text-muted-foreground">Workspace</dt>
      <dd>
        {#if sandbox.workspacePath}<CopyableText
            value={sandbox.workspacePath}
            label="Workspace 路径"
            class="max-w-full font-mono text-xs"
          />{:else}{t('无')}{/if}
      </dd>
      <dt class="text-muted-foreground">{t('创建时间')}</dt>
      <dd><Timestamp value={sandbox.createdAt} mode="full" /></dd>
      <dt class="text-muted-foreground">{t('更新时间')}</dt>
      <dd><Timestamp value={sandbox.updatedAt} mode="full" /></dd>
      <dt class="text-muted-foreground">Cells / Events</dt>
      <dd>{sandbox.cellCount} / {sandbox.eventCount}</dd>
    </dl>
    {#if sandbox.tags.length}<section class="rounded-lg border border-border bg-card p-4">
        <h3 class="text-sm font-medium">{t('运行标签')}</h3>
        <div class="mt-3 flex flex-wrap gap-2">
          {#each sandbox.tags as tag, index (`${tag.name}:${tag.value}:${index}`)}<span
              class="rounded-md bg-muted px-2 py-1 font-mono text-xs">{tag.name}={tag.value}</span
            >{/each}
        </div>
      </section>{/if}
  </div>
{:else}
  <div class="rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm text-warning">
    {t('该运行的沙箱不可用或已回收；日志和事件仍可查看。')}
  </div>
{/if}

{#if detail.artifactsDir || detail.logsPath}
  <section class="mt-4 rounded-lg border border-border bg-card p-4">
    <h3 class="text-sm font-medium">{t('运行元数据')}</h3>
    <dl class="mt-3 grid gap-x-4 gap-y-3 text-sm md:grid-cols-[9rem_1fr]">
      {#if detail.artifactsDir}
        <dt class="text-muted-foreground">{t('运行目录')}</dt>
        <dd><CopyableText value={detail.artifactsDir} label="运行目录" class="max-w-full font-mono text-xs" /></dd>
      {/if}
      {#if detail.logsPath}
        <dt class="text-muted-foreground">{t('日志来源')}</dt>
        <dd><CopyableText value={detail.logsPath} label="日志来源" class="max-w-full font-mono text-xs" /></dd>
      {/if}
    </dl>
  </section>
{/if}

{#if detail.resultJson}
  <details class="mt-4 rounded-lg border border-border bg-card p-4">
    <summary class="cursor-pointer text-sm font-medium">{t('结构化结果')}</summary>
    <pre class="mt-3 whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 text-xs leading-5">{formattedResult(
        detail.resultJson,
      )}</pre>
  </details>
{/if}
