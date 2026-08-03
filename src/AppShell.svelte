<script lang="ts">
  import { onMount } from 'svelte';
  import { ModeWatcher } from 'mode-watcher';
  import AppSidebar from '$lib/components/app-sidebar.svelte';
  import AppTopbar from '$lib/components/app-topbar.svelte';
  import CommandPalette from '$lib/components/command-palette.svelte';
  import { router, matchDetail } from '$lib/router.svelte';
  import { density } from '$lib/density.svelte';
  import { i18n, t } from '$lib/i18n.svelte';

  import Overview from './routes/Overview.svelte';
  import Projects from './routes/Projects.svelte';
  import Automations from './routes/Automations.svelte';
  import AutomationRunDetail from './routes/AutomationRunDetail.svelte';
  import Sandboxes from './routes/Sandboxes.svelte';
  import SandboxDetail from './routes/SandboxDetail.svelte';
  import RunDetail from './routes/RunDetail.svelte';
  import UnlinkedRuns from './routes/UnlinkedRuns.svelte';
  import Settings from './routes/Settings.svelte';
  import Images from './routes/Images.svelte';
  import Capabilities from './routes/Capabilities.svelte';
  import SpecResources from './routes/SpecResources.svelte';
  import Caches from './routes/Caches.svelte';
  import EventDetail from './routes/EventDetail.svelte';
  import Events from './routes/Events.svelte';
  import Login from './routes/Login.svelte';
  import Audit from './routes/Audit.svelte';
  import AccountTokens from './routes/AccountTokens.svelte';
  import { getAuthStatus, logout, type AuthStatus } from './api/auth';
  import { getHealthStatus, type HealthStatus } from './api/health';
  import { normalizeAppLocation } from './paths';

  const STORAGE_KEY = 'ac.sidebarCollapsed';
  let collapsed = $state(false);
  let auth = $state<AuthStatus | null>(null);
  let authError = $state('');
  let health = $state<HealthStatus | null>(null);
  let healthTimer = 0;
  let mobileNavigationOpen = $state(false);

  onMount(() => {
    redirectLegacyPath();
    density.init();
    i18n.init();
    const stored = localStorage.getItem(STORAGE_KEY);
    collapsed = stored !== null ? stored === '1' : window.innerWidth < 1440;
    const onResize = () => {
      if (window.innerWidth < 1440 && localStorage.getItem(STORAGE_KEY) === null) collapsed = true;
    };
    window.addEventListener('resize', onResize);
    void bootstrap();
    return () => {
      window.removeEventListener('resize', onResize);
      window.clearInterval(healthTimer);
    };
  });

  function redirectLegacyPath(): void {
    const path = router.path.replace(/\/+$/, '') || '/';
    let target = '';
    if (path === '/ui' || path === '/workbench') target = '/';
    else if (path === '/automation-tasks') target = '/automations';
    else if (path === '/agents') target = '/projects';
    else if (path.startsWith('/debug/runs/')) target = `/runs/${path.slice('/debug/runs/'.length)}/terminal`;
    if (target) router.replace(target);
  }

  async function bootstrap() {
    try {
      auth = await getAuthStatus();
      if (!auth.enabled || auth.loggedIn) startHealth();
    } catch (cause) {
      authError = cause instanceof Error ? cause.message : t('无法连接 UI server');
    }
  }

  function startHealth() {
    window.clearInterval(healthTimer);
    void refreshHealth();
    healthTimer = window.setInterval(refreshHealth, 10_000);
  }

  async function refreshHealth(): Promise<void> {
    try {
      health = await getHealthStatus();
    } catch {
      health = null;
    }
  }

  function authenticated(value: AuthStatus) {
    auth = value;
    const next = new URLSearchParams(window.location.search).get('next');
    if (next?.startsWith('/')) {
      history.replaceState({}, '', normalizeAppLocation(next));
      router.sync();
    }
    startHealth();
  }

  async function handleLogout() {
    await logout();
    window.clearInterval(healthTimer);
    auth = await getAuthStatus();
  }

  function toggleSidebar() {
    if (window.matchMedia('(max-width: 1023px)').matches) {
      mobileNavigationOpen = !mobileNavigationOpen;
      return;
    }
    collapsed = !collapsed;
    localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0');
  }

  const p = $derived(router.path);
  const runDetailId = $derived(matchDetail('/runs', p));
  const sandboxDetailId = $derived(matchDetail('/sandboxes', p));

  $effect(() => {
    void p;
    mobileNavigationOpen = false;
  });
</script>

<ModeWatcher />
<svelte:window
  onkeydown={(event) => {
    if (event.key === 'Escape') mobileNavigationOpen = false;
  }}
/>
{#if authError}
  <main class="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
    <div class="max-w-lg rounded-lg border border-destructive/30 bg-card p-6">
      <h1 class="font-semibold">{t('无法启动控制台')}</h1>
      <p class="mt-2 text-sm text-destructive">{authError}</p>
      <button class="mt-4 text-sm text-primary underline" onclick={() => location.reload()}>{t('重试')}</button>
    </div>
  </main>
{:else if !auth}
  <main class="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
    {t('正在连接 UI server…')}
  </main>
{:else if auth.enabled && !auth.loggedIn}
  <Login status={auth} onAuthenticated={authenticated} />
{:else}
  <CommandPalette />

  <div class="flex h-dvh overflow-hidden bg-background text-foreground">
    <div class="hidden h-full lg:block">
      <AppSidebar
        {collapsed}
        healthy={Boolean(health)}
        healthText={health ? `v${health.version}` : t('连接中')}
        cpu={health ? `${health.processCpuPercent.toFixed(0)}%` : '—'}
        rss={health ? `${(health.processRssBytes / 1024 / 1024).toFixed(0)}M` : '—'}
      />
    </div>

    {#if mobileNavigationOpen}
      <button
        type="button"
        class="fixed inset-0 z-40 bg-black/45 backdrop-blur-[1px] lg:hidden"
        aria-label={t('关闭导航')}
        onclick={() => (mobileNavigationOpen = false)}
      ></button>
      <div class="fixed inset-y-0 left-0 z-50 w-[min(19rem,86vw)] pt-[env(safe-area-inset-top)] lg:hidden">
        <AppSidebar
          collapsed={false}
          healthy={Boolean(health)}
          healthText={health ? `v${health.version}` : t('连接中')}
          cpu={health ? `${health.processCpuPercent.toFixed(0)}%` : '—'}
          rss={health ? `${(health.processRssBytes / 1024 / 1024).toFixed(0)}M` : '—'}
        />
      </div>
    {/if}

    <div class="flex min-w-0 flex-1 flex-col">
      <AppTopbar
        onToggleSidebar={toggleSidebar}
        navigationOpen={mobileNavigationOpen}
        username={auth.user?.displayName || auth.username}
        healthy={Boolean(health)}
        onLogout={auth.enabled ? handleLogout : undefined}
      />

      <main
        data-scroll-root
        class="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]"
      >
        {#if p === '/'}
          <Overview />
        {:else if p.startsWith('/projects') || p.startsWith('/agents')}
          <Projects />
        {:else if p.startsWith('/automation-runs/')}
          <AutomationRunDetail />
        {:else if p.startsWith('/automations')}
          <Automations />
        {:else if p.startsWith('/events/')}
          <EventDetail />
        {:else if p.startsWith('/events')}
          <Events />
        {:else if sandboxDetailId}
          <SandboxDetail />
        {:else if p.startsWith('/sandboxes')}
          <Sandboxes />
        {:else if p === '/runs/unlinked'}
          <UnlinkedRuns />
        {:else if runDetailId}
          <RunDetail />
        {:else if p.startsWith('/settings/caches')}
          <Caches />
        {:else if p.startsWith('/audit')}
          <Audit />
        {:else if p.startsWith('/account/tokens')}
          <AccountTokens />
        {:else if p.startsWith('/settings')}
          <Settings />
        {:else if p.startsWith('/images')}
          <Images />
        {:else if p.startsWith('/capabilities')}
          <Capabilities />
        {:else if p.startsWith('/mcp')}
          <SpecResources kind="mcp" />
        {:else if p.startsWith('/skills')}
          <SpecResources kind="skills" />
        {:else}
          <Overview />
        {/if}
      </main>
    </div>
  </div>
{/if}
