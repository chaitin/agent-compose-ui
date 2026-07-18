<script lang="ts">
  import { store } from '../lib/stores.svelte';
  import AgentListView from '../views/runtime/AgentListView.svelte';
  import AgentRunListView from '../views/runtime/AgentRunListView.svelte';
  import ProjectRuntimeView from '../views/runtime/ProjectRuntimeView.svelte';
  import LatestRunView from '../views/runtime/LatestRunView.svelte';
  import RunDetailView from '../views/runtime/RunDetailView.svelte';
  import SchedulerRunDetailView from '../views/runtime/SchedulerRunDetailView.svelte';
  import SessionDetailView from '../views/runtime/SessionDetailView.svelte';
  import LoaderRunListView from '../views/runtime/LoaderRunListView.svelte';
  import LoaderRunDetailView from '../views/runtime/LoaderRunDetailView.svelte';
  import SandboxListView from '../views/runtime/SandboxListView.svelte';
  import SandboxDetailView from '../views/runtime/SandboxDetailView.svelte';
  import SchedulerListView from '../views/runtime/SchedulerListView.svelte';
</script>

<div class="runtime-panel">
  {#if store.runtimeView.level === 'agents'}
    <AgentListView />
  {:else if store.runtimeView.level === 'project-runtime'}
    <ProjectRuntimeView />
  {:else if store.runtimeView.level === 'latest-run'}
    <LatestRunView />
  {:else if store.runtimeView.level === 'agent-sandboxes'}
    <SandboxListView />
  {:else if store.runtimeView.level === 'sandbox-detail'}
    <SandboxDetailView />
  {:else if store.runtimeView.level === 'schedulers'}
    <SchedulerListView />
  {:else if store.runtimeView.level === 'agent-detail'}
    <AgentRunListView />
  {:else if store.runtimeView.level === 'run-detail'}
    <RunDetailView />
  {:else if store.runtimeView.level === 'scheduler-run-detail'}
    <SchedulerRunDetailView />
  {:else if store.runtimeView.level === 'loader-runs'}
    <LoaderRunListView />
  {:else if store.runtimeView.level === 'loader-run-detail'}
    <LoaderRunDetailView />
  {:else if store.runtimeView.level === 'session'}
    <SessionDetailView />
  {/if}
</div>

<style>
  .runtime-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--bg-primary);
  }
</style>
