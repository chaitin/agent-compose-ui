<script lang="ts">
  import { cn } from '$lib/utils';
  import { navGroups } from '$lib/nav';
  import { t } from '$lib/i18n.svelte';
  import { router, navigate } from '$lib/router.svelte';
  import BrandMark from '$lib/components/brand-mark.svelte';

  let {
    collapsed = false,
    healthText = '连接中',
    cpu = '—',
    rss = '—',
    healthy = false,
  }: {
    collapsed?: boolean;
    healthText?: string;
    cpu?: string;
    rss?: string;
    healthy?: boolean;
  } = $props();
</script>

<aside
  class={cn(
    'flex h-full flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200',
    collapsed ? 'w-14' : 'w-60',
  )}
>
  <!-- 品牌 -->
  <div class="flex h-12 items-center gap-2 border-b border-sidebar-border px-3">
    <BrandMark class={cn('h-8 shrink-0', collapsed ? 'w-8' : 'w-11')} />
    {#if !collapsed}
      <div class="min-w-0">
        <div class="truncate text-sm font-semibold text-foreground">agent-compose</div>
      </div>
    {/if}
  </div>

  <!-- 导航 -->
  <nav data-scroll-surface class="flex-1 overflow-y-auto px-2 py-3">
    {#each navGroups() as group (group.title)}
      <div class="mb-4">
        {#if !collapsed}
          <div class="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
            {group.title}
          </div>
        {/if}
        <ul class="space-y-0.5">
          {#each group.items as item (item.href)}
            {@const active = item.match?.(router.path) ?? false}
            <li>
              <button
                type="button"
                onclick={() => navigate(item.href)}
                title={collapsed ? item.label : undefined}
                aria-label={item.label}
                class={cn(
                  'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors',
                  collapsed && 'justify-center',
                  active
                    ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                    : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground',
                )}
              >
                <item.icon class="size-4 shrink-0" />
                {#if !collapsed}<span class="truncate">{item.label}</span>{/if}
              </button>
            </li>
          {/each}
        </ul>
      </div>
    {/each}
  </nav>

  <!-- 底部全局状态 -->
  <button
    type="button"
    onclick={() => navigate('/')}
    class={cn(
      'flex items-center gap-2 border-t border-sidebar-border px-3 py-2.5 text-left text-xs hover:bg-sidebar-accent/50',
      collapsed && 'justify-center',
    )}
    title={t('系统健康 · 进入概览')}
  >
    <span class="size-2 shrink-0 rounded-full {healthy ? 'bg-success' : 'bg-warning'}"></span>
    {#if !collapsed}
      <span class="text-muted-foreground">
        {healthText} · CPU {cpu} · {rss}
      </span>
    {/if}
  </button>
</aside>
