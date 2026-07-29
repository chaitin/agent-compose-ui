<script lang="ts">
  import { cn } from '$lib/utils';
  import Activity from '@lucide/svelte/icons/activity';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import CircleX from '@lucide/svelte/icons/circle-x';
  import Clock3 from '@lucide/svelte/icons/clock-3';
  import MinusCircle from '@lucide/svelte/icons/minus-circle';
  import OctagonPause from '@lucide/svelte/icons/octagon-pause';

  type SemanticStatus = 'running' | 'success' | 'failed' | 'skipped' | 'pending' | 'stopped';
  const statusLabel: Record<SemanticStatus, string> = {
    running: '运行中',
    success: '成功',
    failed: '失败',
    skipped: '跳过',
    pending: '等待中',
    stopped: '已停止',
  };

  let { status, label, class: className = '' }: { status: string; label?: string; class?: string } = $props();
  const semanticStatus = $derived(normalizeStatus(status));

  const tone: Record<SemanticStatus, string> = {
    running: 'border-info/35 bg-info/10 text-info',
    success: 'border-success/35 bg-success/10 text-success',
    failed: 'border-destructive/35 bg-destructive/10 text-destructive',
    skipped: 'border-border bg-muted text-muted-foreground',
    pending: 'border-warning/40 bg-warning/10 text-warning-foreground',
    stopped: 'border-border bg-muted text-muted-foreground',
  };

  function normalizeStatus(value: string): SemanticStatus {
    const normalized = value.trim().toLowerCase();
    if (['running', 'active', 'processing'].includes(normalized)) return 'running';
    if (
      ['success', 'succeeded', 'completed', 'healthy', 'enabled', 'delivered', 'dispatched', 'accepted'].includes(
        normalized,
      )
    )
      return 'success';
    if (['failed', 'error', 'unhealthy', 'rejected', 'dead_letter'].includes(normalized)) return 'failed';
    if (['skipped'].includes(normalized)) return 'skipped';
    if (['stopped', 'canceled', 'cancelled', 'disabled'].includes(normalized)) return 'stopped';
    return 'pending';
  }
</script>

<span
  data-semantic-status={semanticStatus}
  class={cn(
    'inline-flex h-5 items-center gap-1 rounded-full border px-2 text-[11px] font-semibold',
    tone[semanticStatus],
    className,
  )}
>
  {#if semanticStatus === 'running'}<Activity class="size-3" />{:else if semanticStatus === 'success'}<CircleCheck
      class="size-3"
    />{:else if semanticStatus === 'failed'}<CircleX class="size-3" />{:else if semanticStatus === 'pending'}<Clock3
      class="size-3"
    />{:else if semanticStatus === 'skipped'}<MinusCircle class="size-3" />{:else}<OctagonPause class="size-3" />{/if}
  {label || statusLabel[semanticStatus]}
</span>
