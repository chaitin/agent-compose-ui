<script lang="ts">
  import { cn } from '$lib/utils';
  import { accountItems, activeNavItem, navItems } from '$lib/nav';
  import { i18n, t } from '$lib/i18n.svelte';
  import { router, navigate } from '$lib/router.svelte';
  import { toggleMode } from 'mode-watcher';
  import Sun from '@lucide/svelte/icons/sun';
  import Moon from '@lucide/svelte/icons/moon';
  import Languages from '@lucide/svelte/icons/languages';
  import LogOut from '@lucide/svelte/icons/log-out';
  import BrandLogo from './brand-logo.svelte';

  let {
    collapsed = false,
    healthy = false,
    healthText = '连接中',
    username = '',
    onLogout,
    onNavigate,
  }: {
    collapsed?: boolean;
    healthy?: boolean;
    healthText?: string;
    username?: string;
    onLogout?: () => void;
    /** 每次点击导航后调用；移动端抽屉据此关闭，即使目标就是当前页面。 */
    onNavigate?: () => void;
  } = $props();

  let menuOpen = $state(false);
  const accountActive = $derived(activeNavItem(router.path)?.hidden ?? false);

  function go(href: string): void {
    navigate(href);
    onNavigate?.();
  }

  const iconButton =
    'grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground';
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.key === 'Escape') menuOpen = false;
  }}
  onpointerdown={(event) => {
    if (menuOpen && !(event.target as HTMLElement).closest('[aria-haspopup="menu"], [role="menu"]')) menuOpen = false;
  }}
/>

<aside
  class={cn(
    'flex h-full flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200',
    collapsed ? 'w-14' : 'w-52',
  )}
>
  <button
    type="button"
    onclick={() => go('/')}
    class={cn('flex h-12 shrink-0 items-center gap-2 px-4', collapsed && 'justify-center px-0')}
    aria-label="Agent Compose"
  >
    <BrandLogo compact class="h-4 w-7 shrink-0" />
    {#if !collapsed}<span class="truncate text-[13px] font-semibold tracking-tight text-foreground">Agent Compose</span
      >{/if}
  </button>

  <nav data-scroll-surface class="flex-1 overflow-y-auto px-2 pt-1">
    <ul class="space-y-px">
      {#each navItems() as item (item.href)}
        {@const active = item.match(router.path)}
        <li>
          <button
            type="button"
            onclick={() => go(item.href)}
            title={collapsed ? item.label : undefined}
            aria-label={item.label}
            aria-current={active ? 'page' : undefined}
            class={cn(
              'flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-[13px] transition-colors',
              collapsed && 'justify-center px-0',
              active
                ? 'bg-sidebar-accent font-medium text-foreground'
                : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-foreground',
            )}
          >
            <item.icon class="size-4 shrink-0 {active ? 'opacity-100' : 'opacity-70'}" strokeWidth={1.75} />
            {#if !collapsed}<span class="truncate">{item.label}</span>{/if}
          </button>
        </li>
      {/each}
    </ul>
  </nav>

  <div class="shrink-0 space-y-1 px-2 pb-3">
    <div class={cn('flex items-center gap-0.5 px-0.5', collapsed && 'flex-col')}>
      <button type="button" class={iconButton} onclick={toggleMode} title={t('切换主题')} aria-label={t('切换主题')}>
        <Sun class="size-3.5 dark:hidden" /><Moon class="hidden size-3.5 dark:block" />
      </button>
      <button type="button" class={iconButton} onclick={i18n.toggle} title={t('切换语言')} aria-label={t('切换语言')}>
        <Languages class="size-3.5" />
      </button>
    </div>
    <div class="relative">
      {#if menuOpen}
        <div
          role="menu"
          aria-label={t('账户')}
          class="absolute bottom-full left-0 z-50 mb-1 w-52 rounded-md border border-border bg-popover p-1 text-[13px] shadow-lg"
        >
          {#each accountItems() as item (item.href)}
            <button
              type="button"
              role="menuitem"
              class="flex h-8 w-full items-center rounded-[5px] px-2.5 text-left hover:bg-accent"
              onclick={() => {
                menuOpen = false;
                go(item.href);
              }}>{item.label}</button
            >
          {/each}
          {#if onLogout}
            <div class="my-1 border-t border-border"></div>
            <button
              type="button"
              role="menuitem"
              class="flex h-8 w-full items-center gap-2 rounded-[5px] px-2.5 text-left text-muted-foreground hover:bg-accent hover:text-foreground"
              onclick={() => {
                menuOpen = false;
                onLogout?.();
              }}><LogOut class="size-3.5" />{t('退出登录')}</button
            >
          {/if}
        </div>
      {/if}
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={t('账户菜单')}
        title={t('账户菜单')}
        onclick={() => (menuOpen = !menuOpen)}
        class={cn(
          'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-sidebar-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground',
          (menuOpen || accountActive) && 'bg-sidebar-accent text-foreground',
          collapsed && 'justify-center px-0',
        )}
      >
        <span
          class="grid size-5 shrink-0 place-items-center rounded-full bg-foreground text-[10px] font-semibold text-background"
          >{(username || '?').slice(0, 1).toUpperCase()}</span
        >
        {#if !collapsed}<span class="truncate">{username || t('匿名')}</span>{/if}
      </button>
    </div>
    <div
      class={cn('flex items-center gap-2 px-2.5 text-[11px] text-muted-foreground', collapsed && 'justify-center px-0')}
      title={`${t(healthy ? '系统健康：正常' : '系统健康：异常或连接中')} · ${healthText}`}
    >
      <span class="size-1.5 shrink-0 rounded-full {healthy ? 'bg-success' : 'bg-warning'}"></span>
      {#if !collapsed}<span class="truncate">{healthText}</span>{/if}
    </div>
  </div>
</aside>
