<script lang="ts">
  import { onMount } from 'svelte';
  import Sidebar from './components/Sidebar.svelte';
  import YamlEditor from './components/YamlEditor.svelte';
  import Resizer from './components/Resizer.svelte';
  import Toast from './components/Toast.svelte';
  import Dashboard from './pages/Dashboard.svelte';
  import ProjectWorkspace from './pages/ProjectWorkspace.svelte';
  import SystemSettings from './pages/SystemSettings.svelte';
  import CacheListView from './pages/CacheListView.svelte';
  import VolumeListView from './pages/VolumeListView.svelte';
  import EventSandboxDetailPage from './pages/EventSandboxDetailPage.svelte';
  import LoginView from './components/LoginView.svelte';
  import { authState, getAuthStatus, type AuthStatus } from './lib/auth';
  import { store } from './lib/stores.svelte';

  authState.set({ phase: 'loading', enabled: true, loggedIn: false });

  let showRuntimePanel = $derived(store.currentPage === 'project');
  let pathname = $state(window.location.pathname);
  let eventId = $derived.by(() => {
    const eventPathMatch = pathname.match(/(?:^|\/agent-compose)\/events\/([^/]+)\/?$/);
    return eventPathMatch ? safeDecode(eventPathMatch[1]) : '';
  });

  function syncPathname() { pathname = window.location.pathname; }

  onMount(() => {
    window.addEventListener('popstate', syncPathname);
    return () => window.removeEventListener('popstate', syncPathname);
  });

  function safeDecode(value: string): string {
    try { return decodeURIComponent(value); }
    catch { return ''; }
  }

  const RETURN_TARGET_KEY = 'agent-compose.auth.return-target';

  function currentTarget(): string { return location.pathname + location.search + location.hash; }

  function saveReturnTarget() {
    sessionStorage.setItem(RETURN_TARGET_KEY, currentTarget());
  }

  function restoreReturnTarget() {
    const target = sessionStorage.getItem(RETURN_TARGET_KEY);
    sessionStorage.removeItem(RETURN_TARGET_KEY);
    if (!target) return;
    const resolved = new URL(target, location.origin);
    if (resolved.origin === location.origin) history.replaceState(null, '', resolved.pathname + resolved.search + resolved.hash);
    syncPathname();
  }

  function applyStatus(status: AuthStatus) {
    if (!status.enabled) authState.set({ ...status, phase: 'disabled' });
    else if (status.loggedIn) authState.set({ ...status, phase: 'authenticated' });
    else {
      saveReturnTarget();
      authState.set({ ...status, phase: 'anonymous' });
    }
  }

  async function checkAuthentication() {
    authState.set({ phase: 'loading', enabled: true, loggedIn: false });
    try { applyStatus(await getAuthStatus()); }
    catch (cause) {
      authState.set({ phase: 'error', enabled: true, loggedIn: false, error: cause instanceof Error ? cause.message : 'unknown error' });
    }
  }

  function authenticated(status: AuthStatus) {
    authState.set({ ...status, phase: status.enabled ? 'authenticated' : 'disabled' });
    restoreReturnTarget();
  }

  onMount(() => { void checkAuthentication(); });
</script>

{#if $authState.phase === 'loading'}
  <main class="auth-message" role="status"><span class="status-dot"></span>正在检查访问权限</main>
{:else if $authState.phase === 'error'}
  <main class="auth-message"><section role="alert"><strong>无法确认访问权限</strong><p>检查网络连接后重试。</p><button onclick={() => void checkAuthentication()}>重试</button></section></main>
{:else if $authState.phase === 'anonymous'}
  <LoginView onAuthenticated={authenticated} />
{:else if eventId}
  <div class="standalone"><EventSandboxDetailPage {eventId} /></div>
{:else}
<div class="shell">
  <Sidebar />
  <div class="main-area">
    {#if store.currentPage === 'dashboard'}
      <Dashboard />
    {:else if store.currentPage === 'settings' || store.currentPage === 'images' || store.currentPage === 'environment'}
      <SystemSettings />
    {:else if store.currentPage === 'caches'}
      <CacheListView />
    {:else if store.currentPage === 'volumes'}
      <VolumeListView />
    {:else if showRuntimePanel}
      <div class="split-pane">
        <div class="editor-pane" class:collapsed={store.editorCollapsed} style="width: {store.editorCollapsed ? '28px' : store.splitRatio + '%'}">
          <YamlEditor />
        </div>
        {#if !store.editorCollapsed}
          <Resizer />
        {/if}
        <div class="runtime-pane" style="flex: 1">
          <ProjectWorkspace />
        </div>
      </div>
    {/if}
  </div>
</div>
{/if}
{#if $authState.phase === 'authenticated' || $authState.phase === 'disabled'}<Toast />{/if}

<style>
  .shell {
    display: flex;
    height: 100%;
  }
  .standalone { height: 100%; min-height: 0; overflow: hidden; }
  .main-area {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    height: 100%;
  }
  .split-pane {
    display: flex;
    height: 100%;
  }
  .editor-pane {
    display: flex;
    flex-direction: column;
    min-width: 200px;
    overflow: hidden;
    transition: min-width 0.15s;
  }
  .editor-pane.collapsed {
    min-width: 28px;
  }
  .runtime-pane {
    min-width: 250px;
    overflow: hidden;
  }
  .auth-message { display:grid; min-height:100%; place-items:center; color:var(--text-secondary); font:var(--font-size-sm) var(--font-mono); }
  .auth-message > section { width:min(420px,calc(100% - 32px)); padding:24px; border:1px solid var(--border-color); border-radius:8px; background:var(--bg-secondary); }
  .auth-message strong { color:var(--text-primary); font:600 var(--font-size-xl) var(--font-sans); }
  .auth-message p { margin:7px 0 16px; font-family:var(--font-sans); }
  .auth-message button { padding:7px 14px; border:1px solid var(--border-color); border-radius:5px; background:var(--bg-tertiary); color:var(--text-primary); }
  .auth-message button:focus-visible { outline:2px solid var(--accent-blue); outline-offset:2px; }
  .status-dot { width:7px; height:7px; margin-right:9px; border-radius:50%; background:var(--accent-green); box-shadow:0 0 0 3px color-mix(in srgb,var(--accent-green) 10%,transparent); }
</style>
