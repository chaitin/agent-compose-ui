<script lang="ts">
  import PanelLeft from '@lucide/svelte/icons/panel-left';
  import Search from '@lucide/svelte/icons/search';
  import { Button } from '$lib/components/ui/button';
  import { router, navigate } from '$lib/router.svelte';
  import { breadcrumbs } from '$lib/nav';
  import { command } from '$lib/command.svelte';
  import { t } from '$lib/i18n.svelte';

  let {
    onToggleSidebar,
    navigationOpen = false,
  }: {
    onToggleSidebar: () => void;
    navigationOpen?: boolean;
  } = $props();

  const crumbs = $derived(breadcrumbs(router.path));
</script>

<header
  class="flex min-h-11 shrink-0 items-center gap-2 border-b border-border px-2 pt-[env(safe-area-inset-top)] sm:px-3"
>
  <Button
    variant="ghost"
    size="icon-sm"
    class="text-muted-foreground"
    onclick={onToggleSidebar}
    aria-label={t(navigationOpen ? '关闭导航' : '打开导航')}
  >
    <PanelLeft class="size-4" strokeWidth={1.75} />
  </Button>

  <nav aria-label={t('面包屑')} class="flex min-w-0 items-center gap-1.5 text-[13px]">
    {#each crumbs as c, i (i)}
      {#if i > 0}<span class="text-faint">/</span>{/if}
      {#if c.href && i < crumbs.length - 1}
        <button
          type="button"
          onclick={() => navigate(c.href!)}
          class="truncate text-muted-foreground hover:text-foreground"
        >
          {c.label}
        </button>
      {:else}
        <span class="truncate font-medium text-foreground">{c.label}</span>
      {/if}
    {/each}
  </nav>

  <button
    type="button"
    onclick={command.toggle}
    class="ml-auto hidden h-7 w-64 items-center gap-2 rounded-md bg-muted px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent sm:flex"
  >
    <Search class="size-3.5" />
    <span class="truncate">{t('搜索运行、项目，或粘贴任意 ID')}</span>
    <kbd class="ml-auto rounded border border-input px-1 font-mono text-[10px]">⌘K</kbd>
  </button>
  <Button variant="ghost" size="icon-sm" class="ml-auto sm:hidden" onclick={command.toggle} aria-label={t('搜索')}>
    <Search class="size-4" />
  </Button>
</header>
