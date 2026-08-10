<script lang="ts">
  import { Button } from '$lib/components/ui/button';
  import { t } from '$lib/i18n.svelte';
  import type { TopicEventTraceSandbox } from '../../api/loaders';
  import { compactIdentifier } from '../../model/identifiers';

  const buttonLimit = 5;

  let {
    items,
    selectedSandboxId,
    onSelect,
  }: {
    items: TopicEventTraceSandbox[];
    selectedSandboxId: string;
    onSelect: (sandboxId: string) => void;
  } = $props();

  const useCompactSelector = $derived(items.length > buttonLimit);
  const selectedPosition = $derived(
    Math.max(1, items.findIndex((item) => item.link.sandboxId === selectedSandboxId) + 1),
  );

  function sandboxName(item: TopicEventTraceSandbox): string {
    return item.sandbox?.agentName || item.sandbox?.title || t('执行环境');
  }

  function sandboxLabel(item: TopicEventTraceSandbox): string {
    return `${sandboxName(item)} · ${compactIdentifier(item.link.sandboxId)}`;
  }
</script>

<div
  data-sandbox-selector="desktop"
  data-sandbox-selector-mode={useCompactSelector ? 'compact' : 'buttons'}
  class="hidden min-w-0 shrink-0 items-center gap-2 rounded-lg border border-border/70 bg-muted/30 p-1.5 sm:flex"
>
  <span class="shrink-0 px-1 text-xs font-medium text-muted-foreground">{t('关联执行环境')}</span>
  {#if useCompactSelector}
    <select
      data-sandbox-selector-control
      aria-label={t('关联执行环境')}
      value={selectedSandboxId}
      onchange={(event) => onSelect(event.currentTarget.value)}
      class="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 text-sm md:max-w-xl"
    >
      {#each items as item (item.link.sandboxId)}
        <option value={item.link.sandboxId}>{sandboxLabel(item)}</option>
      {/each}
    </select>
    <span class="shrink-0 px-1 text-xs tabular-nums text-muted-foreground">
      {selectedPosition}/{items.length}
    </span>
  {:else}
    <div class="flex min-w-0 flex-1 flex-wrap gap-1.5">
      {#each items as item (item.link.sandboxId)}
        <Button
          size="sm"
          variant={item.link.sandboxId === selectedSandboxId ? 'default' : 'outline'}
          aria-pressed={item.link.sandboxId === selectedSandboxId}
          data-sandbox-id={item.link.sandboxId}
          title={sandboxLabel(item)}
          class="min-w-0 max-w-64"
          onclick={() => onSelect(item.link.sandboxId)}
        >
          <span class="truncate">{sandboxLabel(item)}</span>
        </Button>
      {/each}
    </div>
  {/if}
</div>

<select
  data-sandbox-selector="mobile"
  data-sandbox-selector-control
  aria-label={t('关联执行环境')}
  value={selectedSandboxId}
  onchange={(event) => onSelect(event.currentTarget.value)}
  class="h-9 w-full shrink-0 rounded-md border border-input bg-background px-3 text-sm sm:hidden"
>
  {#each items as item (item.link.sandboxId)}
    <option value={item.link.sandboxId}>{sandboxLabel(item)}</option>
  {/each}
</select>
