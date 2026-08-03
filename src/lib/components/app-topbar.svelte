<script lang="ts">
  import PanelLeft from '@lucide/svelte/icons/panel-left';
  import Search from '@lucide/svelte/icons/search';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Rows3 from '@lucide/svelte/icons/rows-3';
  import Rows2 from '@lucide/svelte/icons/rows-2';
  import { Button } from '$lib/components/ui/button';
  import ThemeToggle from './theme-toggle.svelte';
  import { router, navigate } from '$lib/router.svelte';
  import { breadcrumbs } from '$lib/nav';
  import { command } from '$lib/command.svelte';
  import { density } from '$lib/density.svelte';
  import LogOut from '@lucide/svelte/icons/log-out';
  import Languages from '@lucide/svelte/icons/languages';
  import { i18n, t } from '$lib/i18n.svelte';

  let {
    onToggleSidebar,
    navigationOpen = false,
    username = '',
    healthy = false,
    onLogout,
  }: {
    onToggleSidebar: () => void;
    navigationOpen?: boolean;
    username?: string;
    healthy?: boolean;
    onLogout?: () => void;
  } = $props();

  const crumbs = $derived(breadcrumbs(router.path));
</script>

<header
  class="flex min-h-12 shrink-0 items-center gap-1.5 border-b border-border bg-background/80 px-2 pt-[env(safe-area-inset-top)] backdrop-blur sm:gap-2 sm:px-3"
>
  <Button
    variant="ghost"
    size="icon"
    onclick={onToggleSidebar}
    aria-label={t(navigationOpen ? '关闭导航' : '打开导航')}
  >
    <PanelLeft class="size-4" />
  </Button>

  <!-- 面包屑 -->
  <nav class="flex min-w-0 items-center gap-1 text-sm">
    {#each crumbs as c, i (i)}
      {#if i > 0}
        <ChevronRight class="size-3.5 shrink-0 text-muted-foreground/50" />
      {/if}
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

  <div class="ml-auto flex items-center gap-1.5">
    <!-- ⌘K 搜索触发 -->
    <button
      type="button"
      onclick={command.toggle}
      class="hidden items-center gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted sm:flex"
    >
      <Search class="size-3.5" />
      <span>{t('搜索…')}</span>
      <kbd class="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] font-medium">⌘K</kbd>
    </button>

    <Button
      variant="ghost"
      size="icon"
      class="hidden sm:inline-flex"
      onclick={density.toggle}
      title={t(density.value === 'comfortable' ? '密度：舒适（点击切紧凑）' : '密度：紧凑（点击切舒适）')}
      aria-label={t('切换密度')}
    >
      {#if density.value === 'comfortable'}
        <Rows3 class="size-4" />
      {:else}
        <Rows2 class="size-4" />
      {/if}
    </Button>

    <div class="hidden sm:block"><ThemeToggle /></div>

    <Button variant="ghost" size="icon" onclick={i18n.toggle} title={t('切换语言')} aria-label={t('切换语言')}>
      <Languages class="size-4" />
      <span class="sr-only">{i18n.locale === 'zh-CN' ? 'English' : '中文'}</span>
    </Button>

    <!-- 健康点 -->
    <div
      class="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground"
      title={t(healthy ? '系统健康：正常' : '系统健康：异常或连接中')}
    >
      <span class="size-2 rounded-full {healthy ? 'bg-success' : 'bg-warning'}"></span>
      <span class="hidden md:inline">{t(healthy ? '正常' : '检查中')}</span>
    </div>

    <!-- 用户 -->
    {#if username}<button
        type="button"
        class="flex size-7 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary hover:bg-primary/15"
        title={t('管理个人 API 令牌')}
        aria-label={t('管理个人 API 令牌')}
        onclick={() => navigate('/account/tokens')}>{username.slice(0, 1).toUpperCase()}</button
      >{/if}
    {#if onLogout}<Button variant="ghost" size="icon" onclick={onLogout} title={t('退出登录')}
        ><LogOut class="size-4" /></Button
      >{/if}
  </div>
</header>
