<script lang="ts">
  import { onMount } from 'svelte';
  import { formatBeijingTime, formatRelativeTime } from '../../time';

  let {
    value,
    mode = 'compact',
    empty = '—',
    class: className = '',
  }: {
    value: string | Date | number | null | undefined;
    mode?: 'compact' | 'full';
    empty?: string;
    class?: string;
  } = $props();

  let now = $state(Date.now());
  const absolute = $derived(value ? formatBeijingTime(value) : empty);
  const relative = $derived(value ? formatRelativeTime(value, now) : empty);
  const datetime = $derived(toISOString(value));

  function toISOString(input: string | Date | number | null | undefined): string | undefined {
    if (input === null || input === undefined || input === '') return undefined;
    const date = input instanceof Date ? input : new Date(input);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }

  onMount(() => {
    const timer = window.setInterval(() => (now = Date.now()), 60_000);
    return () => window.clearInterval(timer);
  });
</script>

{#if mode === 'full'}
  <time class={className} {datetime} title={`${absolute} · Asia/Shanghai`}>
    <span>{absolute}</span>{#if value}<span class="ml-1.5 text-muted-foreground">（{relative}）</span>{/if}
  </time>
{:else}
  <time class={className} {datetime} title={`${absolute} · Asia/Shanghai`}>
    {relative}
  </time>
{/if}
