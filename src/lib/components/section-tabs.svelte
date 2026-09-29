<script lang="ts">
  import { navigate } from '$lib/router.svelte';
  import type { NavTab } from '$lib/nav';

  let { tabs, path }: { tabs: NavTab[]; path: string } = $props();
</script>

<nav
  data-section-tabs
  class="flex shrink-0 items-end gap-5 overflow-x-auto border-b border-border px-4 sm:px-5 xl:px-6"
>
  {#each tabs as tab (tab.href)}
    {@const active = tab.match(path)}
    <button
      type="button"
      onclick={() => navigate(tab.href)}
      aria-current={active ? 'page' : undefined}
      class="-mb-px h-9 shrink-0 border-b-2 text-[13px] transition-colors {active
        ? 'border-foreground font-medium text-foreground'
        : 'border-transparent text-muted-foreground hover:text-foreground'}"
    >
      {tab.label}
    </button>
  {/each}
</nav>
