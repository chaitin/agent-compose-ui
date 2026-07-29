<script lang="ts">
  import { onMount } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import PageHeader from '$lib/components/page-header.svelte';
  import PageContent from '$lib/components/page-content.svelte';
  import StatusBadge from '$lib/components/status-badge.svelte';
  import CopyableText from '$lib/components/copyable-text.svelte';
  import Timestamp from '$lib/components/timestamp.svelte';
  import { navigate } from '$lib/router.svelte';
  import { durationName, listRuns, runStatusName, sourceName } from '../api/runs';
  import type { RunSummary } from '../gen/agentcompose/v2/agentcompose_pb.js';
  import { timestampToISOString } from '../model/timestamps';
  import Terminal from '@lucide/svelte/icons/terminal';
  let runs = $state<RunSummary[]>([]);
  let query = $state('');
  let loading = $state(true);
  let error = $state('');
  let timer = 0;
  onMount(() => {
    void load();
    timer = window.setInterval(load, 5000);
    return () => clearInterval(timer);
  });
  async function load() {
    try {
      runs = await listRuns({
        query,
        sandboxId: new URLSearchParams(location.search).get('sandboxId') || '',
        limit: 500,
      });
      error = '';
    } catch (e) {
      error = e instanceof Error ? e.message : '加载失败';
    } finally {
      loading = false;
    }
  }
</script>

<PageHeader title="运行" description="所有智能体运行 · 手动 / 调度 / API"
  >{#snippet actions()}<Input
      bind:value={query}
      placeholder="按运行、智能体或沙箱过滤"
      class="h-8 w-64"
      onkeydown={(event: KeyboardEvent) => event.key === 'Enter' && load()}
    /><Button variant="outline" size="sm" onclick={load}>刷新</Button>{/snippet}</PageHeader
>
<PageContent>
  {#if error}<div class="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>{/if}
  <div data-scroll-surface class="overflow-x-auto rounded-lg border border-border">
    <table class="min-w-[64rem] w-full text-sm">
      <thead class="bg-muted/40"
        ><tr
          ><th class="p-3 text-left">智能体</th><th class="p-3 text-left">运行</th><th class="p-3 text-left">来源</th
          ><th class="p-3 text-left">状态</th><th class="p-3 text-left">开始</th><th class="p-3 text-left">耗时</th><th
            class="p-3 text-left">沙箱</th
          ><th></th></tr
        ></thead
      ><tbody class="divide-y divide-border"
        >{#each runs as run (run.runId)}<tr
            class="cursor-pointer hover:bg-accent/50"
            onclick={() => navigate(`/runs/${run.runId}`)}
            ><td class="p-3"
              ><div class="font-medium">{run.agentName || '未命名智能体'}</div>
              <div class="text-xs text-muted-foreground">{run.projectName || '未关联项目'}</div></td
            ><td class="p-3"
              ><CopyableText
                value={run.runId}
                display={run.runShortId || run.runId}
                label="Run ID"
                class="font-mono text-xs font-medium"
              />
              {#if run.triggerId}<div class="mt-1 text-[11px] text-muted-foreground">
                  trigger: {run.triggerId}
                </div>{/if}</td
            ><td class="p-3 text-muted-foreground">{sourceName(run.source)}</td><td class="p-3"
              ><StatusBadge status={runStatusName(run.status)} /></td
            ><td class="p-3 text-xs text-muted-foreground"
              ><Timestamp value={timestampToISOString(run.startedAt || run.createdAt)} /></td
            ><td class="p-3">{durationName(run.durationMs)}</td><td class="p-3 font-mono text-xs text-muted-foreground"
              >{#if run.sandboxId}<CopyableText
                  value={run.sandboxId}
                  display={run.sandboxShortId || run.sandboxId}
                  label="Sandbox ID"
                />{:else}—{/if}</td
            ><td class="p-3 text-right"
              >{#if run.sandboxId}<Button
                  variant="ghost"
                  size="icon"
                  title="终端"
                  onclick={(event: MouseEvent) => {
                    event.stopPropagation();
                    navigate(`/runs/${run.runId}/terminal`);
                  }}><Terminal class="size-4" /></Button
                >{/if}</td
            ></tr
          >{:else}<tr
            ><td colspan="8" class="p-10 text-center text-muted-foreground"
              >{loading ? '正在加载运行…' : '没有匹配的运行'}</td
            ></tr
          >{/each}</tbody
      >
    </table>
  </div>
</PageContent>
