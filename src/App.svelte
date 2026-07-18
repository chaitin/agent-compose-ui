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
  import { store } from './lib/stores.svelte';

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
</script>

{#if eventId}
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
<Toast />

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
</style>
