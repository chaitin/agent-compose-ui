<script lang="ts">
  import { onDestroy } from 'svelte';
  import Link from '@lucide/svelte/icons/link';
  import Check from '@lucide/svelte/icons/check';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import { Button } from '$lib/components/ui/button';
  import { copyText } from '$lib/clipboard';
  import { t } from '$lib/i18n.svelte';

  let { value = '', label = '复制链接' }: { value?: string; label?: string } = $props();
  let status = $state<'idle' | 'copied' | 'error'>('idle');
  let resetTimer = 0;

  function showStatus(nextStatus: 'copied' | 'error'): void {
    status = nextStatus;
    window.clearTimeout(resetTimer);
    resetTimer = window.setTimeout(() => (status = 'idle'), 1600);
  }

  async function copy(): Promise<void> {
    try {
      await copyText(value || window.location.href);
      showStatus('copied');
    } catch {
      showStatus('error');
    }
  }

  onDestroy(() => window.clearTimeout(resetTimer));
</script>

<Button variant="outline" size="sm" onclick={() => void copy()}>
  {#if status === 'copied'}<Check class="size-3.5 text-success" />{t(
      '已复制',
    )}{:else if status === 'error'}<TriangleAlert class="size-3.5 text-destructive" />{t('复制失败')}{:else}<Link
      class="size-3.5"
    />{t(label)}{/if}
</Button>
