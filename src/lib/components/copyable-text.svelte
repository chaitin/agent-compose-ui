<script lang="ts">
  import { onDestroy } from 'svelte';
  import Check from '@lucide/svelte/icons/check';
  import Copy from '@lucide/svelte/icons/copy';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import { copyText } from '$lib/clipboard';
  import { t } from '$lib/i18n.svelte';

  let {
    value,
    display = value,
    label = '内容',
    class: className = '',
  }: {
    value: string;
    display?: string;
    label?: string;
    class?: string;
  } = $props();

  let status = $state<'idle' | 'copied' | 'error'>('idle');
  let resetTimer = 0;

  function showStatus(nextStatus: 'copied' | 'error'): void {
    status = nextStatus;
    window.clearTimeout(resetTimer);
    resetTimer = window.setTimeout(() => (status = 'idle'), 1600);
  }

  async function copy(event: MouseEvent): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    try {
      await copyText(value);
      showStatus('copied');
    } catch {
      showStatus('error');
    }
  }

  onDestroy(() => window.clearTimeout(resetTimer));
</script>

<span class={`group/copy relative inline-flex min-w-0 items-center gap-1 ${className}`}>
  <span class="min-w-0 truncate" title={value}>{display}</span>
  <button
    type="button"
    class="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-60 transition hover:bg-accent hover:text-foreground group-hover/copy:opacity-100"
    aria-label={status === 'copied'
      ? `${t(label)} ${t('已复制')}`
      : status === 'error'
        ? `${t(label)} ${t('复制失败')}`
        : `${t('复制')} ${t(label)}`}
    title={status === 'copied' ? t('已复制') : status === 'error' ? t('复制失败') : `${t('复制')} ${t(label)}`}
    onclick={copy}
  >
    {#if status === 'copied'}<Check class="size-3 text-success" />{:else if status === 'error'}<TriangleAlert
        class="size-3 text-destructive"
      />{:else}<Copy class="size-3" />{/if}
  </button>
  {#if status !== 'idle'}
    <span
      role="status"
      class="absolute right-0 top-full z-50 mt-1 whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-[11px] font-normal text-popover-foreground shadow-md"
    >
      {t(status === 'copied' ? '已复制' : '复制失败')}
    </span>
  {/if}
</span>
