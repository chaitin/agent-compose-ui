<script lang="ts">
  import { cn } from '$lib/utils';
  import { t } from '$lib/i18n.svelte';

  // 状态只用「圆点 + 文字」表达：颜色落在圆点上，文字保持正文色，避免满屏色块。
  type SemanticStatus = 'running' | 'success' | 'failed' | 'skipped' | 'pending' | 'stopped';
  const statusLabel: Record<SemanticStatus, string> = {
    running: '运行中',
    success: '成功',
    failed: '失败',
    skipped: '跳过',
    pending: '等待中',
    stopped: '已停止',
  };

  let {
    status,
    label,
    dotOnly = false,
    class: className = '',
  }: { status: string; label?: string; dotOnly?: boolean; class?: string } = $props();
  const semanticStatus = $derived(normalizeStatus(status));

  const dotTone: Record<SemanticStatus, string> = {
    running: 'bg-info animate-pulse',
    success: 'bg-success',
    failed: 'bg-destructive',
    skipped: 'bg-faint',
    pending: 'bg-warning',
    stopped: 'bg-faint',
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

  const text = $derived(label ? t(label) : t(statusLabel[semanticStatus]));
</script>

<span
  data-semantic-status={semanticStatus}
  title={dotOnly ? text : undefined}
  class={cn(
    'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs',
    semanticStatus === 'failed' ? 'text-destructive' : 'text-foreground/80',
    className,
  )}
>
  <span class="size-1.5 shrink-0 rounded-full {dotTone[semanticStatus]}"></span>
  {#if dotOnly}<span class="sr-only">{text}</span>{:else}{text}{/if}
</span>
