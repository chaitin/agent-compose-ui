<script lang="ts">
  import { t } from '$lib/i18n.svelte';
  import type { AgentRecordCategory, AgentRecordEvent } from '../../model/agent-record-events';
  import { formatBeijingTime } from '../../time';

  let { event }: { event: AgentRecordEvent } = $props();

  const tone: Record<AgentRecordCategory, string> = {
    conversation: 'bg-blue-500/10 text-blue-700 dark:text-blue-200',
    tool: 'bg-amber-500/10 text-amber-700 dark:text-amber-200',
    activity: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-200',
    error: 'bg-destructive/10 text-destructive',
    system: 'bg-muted text-muted-foreground',
  };

  function timeLabel(value: string): string {
    if (!value) return '—';
    const formatted = formatBeijingTime(value);
    return formatted.split(' ').at(-1) ?? formatted;
  }

  function summaryLabel(value: string): string {
    const duration = /^耗时 (\d+) ms$/.exec(value);
    return duration ? t('耗时 {duration} ms', { duration: duration[1] }) : t(value);
  }
</script>

<details data-agent-record-event data-category={event.category} class="group rounded-lg border border-border bg-card">
  <summary class="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
    <span class="font-mono text-[11px] text-muted-foreground">{timeLabel(event.timestamp)}</span>
    <span class="w-fit rounded-full px-2 py-0.5 text-[11px] font-medium {tone[event.category]}">{t(event.title)}</span>
    <span class="line-clamp-2 min-w-48 flex-1 break-words text-sm leading-5"
      >{summaryLabel(event.summary) || t('没有事件摘要')}</span
    >
  </summary>
  <div class="border-t border-border px-3 py-3">
    <div class="mb-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>{t('原始事件')}</span><code>{event.type}</code>
    </div>
    <pre
      class="overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-[#0b1018] p-3 font-mono text-xs leading-5 text-[#cdd6e3]">{event.formatted}</pre>
  </div>
</details>
