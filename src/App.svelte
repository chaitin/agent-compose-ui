<script lang="ts">
  import { onMount } from 'svelte';
  import AppstoreOutlined from '@ant-design/icons-svg/es/asn/AppstoreOutlined';
  import ExperimentOutlined from '@ant-design/icons-svg/es/asn/ExperimentOutlined';
  import MenuFoldOutlined from '@ant-design/icons-svg/es/asn/MenuFoldOutlined';
  import MenuUnfoldOutlined from '@ant-design/icons-svg/es/asn/MenuUnfoldOutlined';
  import PlayCircleOutlined from '@ant-design/icons-svg/es/asn/PlayCircleOutlined';
  import RobotOutlined from '@ant-design/icons-svg/es/asn/RobotOutlined';
  import SettingOutlined from '@ant-design/icons-svg/es/asn/SettingOutlined';
  import type { IconDefinition } from '@ant-design/icons-svg/es/types';

  import { getAuthStatus } from './api/auth';
  import { getDashboardOverview, watchDashboardOverview, type DashboardOverview } from './api/dashboard';
  import { getHealthStatus, watchHealthStatus, type HealthStatus } from './api/health';
  import AntIcon from './components/AntIcon.svelte';
  import RunsPage from './pages/RunsPage.svelte';
  import AgentsPage from './pages/AgentsPage.svelte';
  import AutomationTasksPage from './pages/AutomationTasksPage.svelte';
  import SettingsPage from './pages/SettingsPage.svelte';
  import DebugRunPage from './pages/DebugRunPage.svelte';
  import EventDetailPage from './pages/EventDetailPage.svelte';
  import LoginPage from './pages/LoginPage.svelte';
  import { stripAppBase, appPath } from './paths';

  type Page = 'runs' | 'agents' | 'automation-tasks' | 'settings' | 'debug-run' | 'event-detail' | 'login';

  let debugRunId = '';
  let eventDetailId = '';
  let activePage: Page = pageFromPath(typeof window === 'undefined' ? '/' : stripAppBase(window.location.pathname));
  let health: HealthStatus | null = null;
  let statusError = '';
  let statusLoading = true;
  let runningCount = 0;
  let recentRunCount = 0;
  let attentionCount = 0;
  let processIoBytesPerSecond = 0;
  let overviewFallbackTimer = 0;
  let healthAbort: AbortController | null = null;
  let overviewAbort: AbortController | null = null;
  let sidebarCollapsed = false;
  let currentUsername = '';
  let authReady = false;
  let sidebarForcedByViewport = false;
  const sidebarCollapsedStorageKey = 'agent-compose.sidebarCollapsed';
  const sidebarBreakpoint = 1440;

  const pagePaths: Record<Page, string> = {
    runs: appPath('/runs'),
    agents: appPath('/agents'),
    'automation-tasks': appPath('/automation-tasks'),
    settings: appPath('/settings'),
    'debug-run': appPath('/debug/runs'),
    'event-detail': appPath('/events'),
    login: appPath('/login'),
  };

  function pageFromPath(pathname: string): Page {
    const normalized = pathname.replace(/\/+$/, '') || '/';
    const debugMatch = normalized.match(/^\/debug\/runs\/([^/]+)$/);
    if (debugMatch) {
      debugRunId = decodeURIComponent(debugMatch[1]);
      return 'debug-run';
    }
    const eventDetailMatch = normalized.match(/^\/events\/([^/]+)$/);
    if (eventDetailMatch) {
      eventDetailId = decodeURIComponent(eventDetailMatch[1]);
      return 'event-detail';
    }
    if (normalized === '/login') {
      return 'login';
    }
    if (normalized === '/' || normalized === '/workbench') {
      return 'agents';
    }
    if (normalized === '/runs') {
      return 'runs';
    }
    if (normalized === '/agents') {
      return 'agents';
    }
    if (normalized === '/automation-tasks') {
      return 'automation-tasks';
    }
    if (normalized === '/settings') {
      return 'settings';
    }
    return 'agents';
  }

  function redirectLegacyEntryPath(): void {
    const normalized = window.location.pathname.replace(/\/+$/, '') || '/';
    if (normalized !== '/ui' && normalized !== '/ui/workbench') return;
    const nextPath = `${appPath('/agents')}${window.location.search}${window.location.hash}`;
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (current !== nextPath) {
      history.replaceState({ page: 'agents' }, '', nextPath);
    }
  }

  function isLoginLocation(): boolean {
    const relativePath = stripAppBase(window.location.pathname).replace(/\/+$/, '') || '/';
    const configuredPath = appPath('/login').replace(/\/+$/, '');
    const currentPath = window.location.pathname.replace(/\/+$/, '') || '/';
    return relativePath === '/login' || currentPath === configuredPath || currentPath.endsWith('/login');
  }

  function redirectToLogin(): void {
    if (isLoginLocation()) {
      activePage = 'login';
      authReady = true;
      stopGlobalWatches();
      return;
    }
    const next = encodeURIComponent(`${window.location.pathname}${window.location.search}${window.location.hash}`);
    window.location.replace(`${appPath('/login')}?next=${next}`);
  }

  function navigate(page: Page): void {
    activePage = page;
    const nextPath = pagePaths[page];
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (current !== nextPath) {
      history.pushState({ page }, '', nextPath);
    }
  }

  function navigateToDebug(runId: string): void {
    debugRunId = runId;
    activePage = 'debug-run';
    const nextPath = appPath(`/debug/runs/${encodeURIComponent(runId)}`);
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (current !== nextPath) {
      history.pushState({ page: 'debug-run', runId }, '', nextPath);
    }
  }

  function navigateRunsWithRun(sessionId: string): void {
    activePage = 'runs';
    const nextPath = sessionId ? appPath(`/runs?sessionId=${encodeURIComponent(sessionId)}`) : appPath('/runs');
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (current !== nextPath) {
      history.pushState({ page: 'runs', sessionId }, '', nextPath);
    }
  }

  const navItems: Array<{ page: Page; label: string; icon: IconDefinition }> = [
    { page: 'agents', label: '智能体', icon: RobotOutlined },
    { page: 'automation-tasks', label: '自动化任务', icon: ExperimentOutlined },
    { page: 'runs', label: '运行中心', icon: PlayCircleOutlined },
    { page: 'settings', label: '系统配置', icon: SettingOutlined },
  ];

  function applyViewportSidebar(): void {
    if (window.innerWidth <= sidebarBreakpoint) {
      sidebarForcedByViewport = true;
      sidebarCollapsed = true;
    } else {
      sidebarForcedByViewport = false;
      sidebarCollapsed = window.localStorage.getItem(sidebarCollapsedStorageKey) === 'true';
    }
  }

  onMount(() => {
    redirectLegacyEntryPath();
    activePage = pageFromPath(stripAppBase(window.location.pathname));
    sidebarCollapsed = window.localStorage.getItem(sidebarCollapsedStorageKey) === 'true';
    applyViewportSidebar();
    const mediaQuery = window.matchMedia(`(max-width: ${sidebarBreakpoint}px)`);
    mediaQuery.addEventListener('change', applyViewportSidebar);
    void bootstrap();
    const syncFromLocation = () => {
      activePage = pageFromPath(stripAppBase(window.location.pathname));
      if (activePage === 'login') {
        authReady = true;
        stopGlobalWatches();
      } else if (authReady && activePage !== 'event-detail') {
        startGlobalWatches();
        void loadGlobalStatus();
      } else {
        stopGlobalWatches();
      }
    };
    const handleVisible = () => {
      if (activePage === 'event-detail') {
        return;
      }
      if (document.visibilityState === 'visible') {
        startGlobalWatches();
        void loadGlobalStatus();
      } else {
        stopGlobalWatches();
      }
    };
    window.addEventListener('popstate', syncFromLocation);
    window.addEventListener('focus', handleVisible);
    document.addEventListener('visibilitychange', handleVisible);
    return () => {
      stopGlobalWatches();
      mediaQuery.removeEventListener('change', applyViewportSidebar);
      window.removeEventListener('popstate', syncFromLocation);
      window.removeEventListener('focus', handleVisible);
      document.removeEventListener('visibilitychange', handleVisible);
    };
  });

  async function bootstrap(): Promise<void> {
    if (activePage === 'login') {
      authReady = true;
      return;
    }
    const ok = await ensureAuthenticated();
    if (!ok) return;
    authReady = true;
    if (activePage !== 'event-detail') {
      startGlobalWatches();
      void loadDashboardOverview();
    }
  }

  async function ensureAuthenticated(): Promise<boolean> {
    try {
      const authStatus = await getAuthStatus();
      currentUsername = authStatus.username;
      if (authStatus.enabled && !authStatus.loggedIn) {
        redirectToLogin();
        return false;
      }
      return true;
    } catch {
      currentUsername = '';
      return true;
    }
  }

  function startGlobalWatches(): void {
    if (document.visibilityState === 'hidden') return;
    if (!healthAbort) {
      healthAbort = new AbortController();
      void watchGlobalHealth(healthAbort.signal);
    }
    if (!overviewAbort) {
      overviewAbort = new AbortController();
      void watchGlobalOverview(overviewAbort.signal);
    }
  }

  function stopGlobalWatches(): void {
    healthAbort?.abort();
    overviewAbort?.abort();
    healthAbort = null;
    overviewAbort = null;
    window.clearInterval(overviewFallbackTimer);
    overviewFallbackTimer = 0;
  }

  async function loadGlobalStatus(): Promise<void> {
    await Promise.all([refreshHealthOnce(), loadDashboardOverview(), loadAuthStatus()]);
  }

  async function loadAuthStatus(): Promise<void> {
    try {
      const authStatus = await getAuthStatus();
      currentUsername = authStatus.username;
      if (authStatus.enabled && !authStatus.loggedIn) {
        redirectToLogin();
      }
    } catch {
      currentUsername = '';
    }
  }

  async function watchGlobalHealth(signal: AbortSignal): Promise<void> {
    statusLoading = true;
    let retryDelay = 1000;
    while (!signal.aborted) {
      try {
        await watchHealthStatus((nextHealth) => {
          applyHealthStatus(nextHealth);
          statusError = '';
          statusLoading = false;
          retryDelay = 1000;
        }, signal);
      } catch (err) {
        if (!signal.aborted) {
          statusError = err instanceof Error ? err.message : String(err);
          await refreshHealthOnce();
          await delay(retryDelay, signal);
          retryDelay = Math.min(retryDelay * 2, 30000);
        }
        continue;
      }
      if (!signal.aborted) {
        await refreshHealthOnce();
        await delay(retryDelay, signal);
        retryDelay = Math.min(retryDelay * 2, 30000);
      }
    }
  }

  async function refreshHealthOnce(): Promise<void> {
    statusLoading = true;
    try {
      applyHealthStatus(await getHealthStatus());
      statusError = '';
    } catch (err) {
      statusError = err instanceof Error ? err.message : String(err);
    } finally {
      statusLoading = false;
    }
  }

  function applyHealthStatus(nextHealth: HealthStatus): void {
    if (health) {
      const previousBytes = health.processReadBytes + health.processWriteBytes;
      const nextBytes = nextHealth.processReadBytes + nextHealth.processWriteBytes;
      const previousTime = Date.parse(health.currentTime);
      const nextTime = Date.parse(nextHealth.currentTime);
      const elapsedSeconds = (nextTime - previousTime) / 1000;
      const deltaBytes = nextBytes - previousBytes;
      processIoBytesPerSecond = elapsedSeconds > 0 && deltaBytes >= 0 ? deltaBytes / elapsedSeconds : 0;
    } else {
      processIoBytesPerSecond = 0;
    }
    health = nextHealth;
  }

  async function loadDashboardOverview(): Promise<void> {
    try {
      applyDashboardOverview(await getDashboardOverview());
      statusError = '';
    } catch (err) {
      statusError = err instanceof Error ? err.message : String(err);
    }
  }

  async function watchGlobalOverview(signal: AbortSignal): Promise<void> {
    let retryDelay = 1000;
    while (!signal.aborted) {
      try {
        await watchDashboardOverview((overview) => {
          applyDashboardOverview(overview);
          window.clearInterval(overviewFallbackTimer);
          retryDelay = 1000;
        }, signal);
      } catch (err) {
        if (!signal.aborted) {
          statusError = err instanceof Error ? err.message : String(err);
          scheduleOverviewFallback(signal);
          await delay(retryDelay, signal);
          retryDelay = Math.min(retryDelay * 2, 30000);
        }
      }
    }
  }

  function scheduleOverviewFallback(signal: AbortSignal): void {
    window.clearInterval(overviewFallbackTimer);
    overviewFallbackTimer = window.setInterval(() => {
      if (signal.aborted) {
        window.clearInterval(overviewFallbackTimer);
        return;
      }
      void loadDashboardOverview();
    }, 60000);
  }

  function applyDashboardOverview(overview: DashboardOverview): void {
    runningCount = overview.runningCount;
    recentRunCount = overview.recentCount;
    attentionCount = overview.attentionCount;
  }

  function delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = window.setTimeout(resolve, ms);
      signal.addEventListener(
        'abort',
        () => {
          window.clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  function formatUptime(seconds: number): string {
    if (!seconds) return '-';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  function formatBytes(value: number, showZero = false): string {
    if (showZero && value === 0) return '0B';
    if (!value) return '-';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = value;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex += 1;
    }
    return `${size >= 10 || unitIndex === 0 ? size.toFixed(0) : size.toFixed(1)}${units[unitIndex]}`;
  }

  function formatCpu(value: number): string {
    return `${Math.max(0, value).toFixed(value >= 10 ? 0 : 1)}%`;
  }

  function formatVersion(value: string): string {
    const normalized = value.trim();
    return normalized && normalized !== '0' ? normalized : '-';
  }

  function userBadge(value: string): string {
    const normalized = value.trim();
    if (!normalized) return '-';
    return normalized.slice(0, 3).toLowerCase();
  }

  function toggleSidebar(): void {
    sidebarCollapsed = !sidebarCollapsed;
    if (sidebarForcedByViewport) {
      sidebarForcedByViewport = false;
    }
    window.localStorage.setItem(sidebarCollapsedStorageKey, sidebarCollapsed ? 'true' : 'false');
  }
</script>

{#if activePage === 'login'}
  <LoginPage />
{:else if !authReady}
  <main class="auth-loading">
    <section class="login-panel">
      <p class="muted">正在检查登录状态...</p>
    </section>
  </main>
{:else if activePage === 'event-detail'}
  <EventDetailPage eventId={eventDetailId} />
{:else}
<div class="app-shell" class:sidebar-collapsed={sidebarCollapsed}>
  <aside class="sidebar" class:collapsed={sidebarCollapsed}>
    <div class="brand">
      <AntIcon definition={AppstoreOutlined} class="brand-mark" />
      <div class="brand-copy">
        <strong>agent-compose</strong>
        <small>管理控制台</small>
      </div>
      <button
        class="sidebar-toggle"
        type="button"
        title={sidebarCollapsed ? '展开菜单' : '折叠菜单'}
        aria-label={sidebarCollapsed ? '展开菜单' : '折叠菜单'}
        on:click={toggleSidebar}
      >
        <AntIcon definition={sidebarCollapsed ? MenuUnfoldOutlined : MenuFoldOutlined} />
      </button>
    </div>
    <nav>
      {#each navItems as item}
        <button class:active={activePage === item.page} title={item.label} data-label={item.label} on:click={() => navigate(item.page)}>
          <span class="nav-icon" aria-hidden="true">
            <AntIcon definition={item.icon} />
          </span>
          <span class="nav-label">{item.label}</span>
        </button>
      {/each}
    </nav>
  </aside>

  <main>
    <header class="top-statusbar">
      <div class="top-status-left">
        <span class="status-dot" class:bad={Boolean(statusError)} class:loading={statusLoading}></span>
        <span>系统健康</span>
        <b>{statusError ? '异常' : statusLoading ? '同步中' : '正常'}</b>
        <small>{health ? `${formatVersion(health.version)} · 运行 ${formatUptime(health.uptimeSeconds)}` : statusError || '等待健康检查'}</small>
      </div>
      <div class="top-status-metrics">
        <button><span>CPU</span><b>{formatCpu(health?.processCpuPercent ?? 0)}</b></button>
        <button><span>RSS</span><b>{formatBytes(health?.processRssBytes ?? 0)}</b></button>
        <button><span>Proc R/W</span><b>{formatBytes(processIoBytesPerSecond, Boolean(health))}/s</b></button>
        <button on:click={() => navigate('runs')}><span>运行中</span><b>{runningCount}</b></button>
        <button on:click={() => navigate('runs')}><span>近期运行</span><b>{recentRunCount}</b></button>
        <button class:attention={attentionCount > 0} on:click={() => navigate('runs')}><span>告警</span><b>{attentionCount}</b></button>
      </div>
      <div class="top-status-actions">
        <button class="icon-button" title="刷新状态" on:click={loadGlobalStatus}>↻</button>
        <button class="avatar-menu" title={currentUsername || '未登录'}><span>{userBadge(currentUsername)}</span><b>{currentUsername || '未登录'}</b></button>
      </div>
    </header>
    <section class="content">
      {#if activePage === 'runs'}
        <RunsPage on:debug={(event) => navigateToDebug(event.detail)} />
      {:else if activePage === 'agents'}
        <AgentsPage />
      {:else if activePage === 'automation-tasks'}
        <AutomationTasksPage />
      {:else if activePage === 'settings'}
        <SettingsPage />
      {:else}
        <DebugRunPage runId={debugRunId} on:navigateRuns={(event) => navigateRunsWithRun(event.detail)} />
      {/if}
    </section>
  </main>
</div>
{/if}
