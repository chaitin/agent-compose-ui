<script lang="ts">
  import Bot from '@lucide/svelte/icons/bot';
  import CircleDot from '@lucide/svelte/icons/circle-dot';
  import UserRound from '@lucide/svelte/icons/user-round';
  import Wrench from '@lucide/svelte/icons/wrench';
  import { RunEventKind, type RunEvent } from '../../gen/agentcompose/v2/agentcompose_pb.js';
  import { timestampToISOString } from '../../model/timestamps';
  import Timestamp from './timestamp.svelte';

  let { events }: { events: RunEvent[] } = $props();

  function metadata(event: RunEvent): { label: string; icon: typeof Bot; tone: string } {
    if (event.kind === RunEventKind.USER_MESSAGE)
      return { label: '用户消息', icon: UserRound, tone: 'border-primary/30 bg-primary/10 text-primary' };
    if (event.kind === RunEventKind.AGENT_MESSAGE)
      return { label: '智能体回复', icon: Bot, tone: 'border-success/30 bg-success/10 text-success' };
    if (event.kind === RunEventKind.AGENT_ACTIVITY)
      return { label: '工具活动', icon: Wrench, tone: 'border-warning/30 bg-warning/10 text-warning' };
    return { label: '状态变化', icon: CircleDot, tone: 'border-border bg-muted text-muted-foreground' };
  }

  function eventText(event: RunEvent): string {
    return event.text || event.stopReason || event.name || event.agent || '';
  }

  function payload(event: RunEvent): string {
    if (!event.payloadJson) return '';
    try {
      return JSON.stringify(JSON.parse(event.payloadJson), null, 2);
    } catch {
      return event.payloadJson;
    }
  }
</script>

<div class="relative space-y-0 pl-3">
  <div class="absolute bottom-5 left-[1.55rem] top-5 w-px bg-border"></div>
  {#each events as event, index (event.id)}
    {@const meta = metadata(event)}
    {@const Icon = meta.icon}
    <article class="relative grid grid-cols-[2.75rem_1fr] gap-3 pb-5">
      <div class="z-10 flex size-8 items-center justify-center rounded-full border {meta.tone}">
        <Icon class="size-4" />
      </div>
      <div class="min-w-0 rounded-lg border border-border bg-card p-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex items-center gap-2">
            <span class="text-sm font-medium">{meta.label}</span>
            <span class="font-mono text-[11px] text-muted-foreground">#{index + 1}</span>
            {#if event.agent}<span class="text-xs text-muted-foreground">{event.agent}</span>{/if}
          </div>
          <Timestamp value={timestampToISOString(event.createdAt)} mode="full" class="text-xs" />
        </div>
        {#if eventText(event)}<p class="mt-2 whitespace-pre-wrap text-sm leading-6">{eventText(event)}</p>{/if}
        {#if payload(event)}<details class="mt-2">
            <summary class="cursor-pointer text-xs text-muted-foreground">查看结构化载荷</summary>
            <pre class="mt-2 whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">{payload(event)}</pre>
          </details>{/if}
      </div>
    </article>
  {:else}
    <div class="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
      当前运行没有语义事件
    </div>
  {/each}
</div>
