<script lang="ts">
  import { untrack } from 'svelte';
  import { GetProjectRequest, ListRunsRequest, RunStatus, type RunDetail, type RunSummary } from '../../gen/agentcompose/v2/agentcompose_pb';
  import { projectService, runService } from '../../lib/rpc';
  import { store } from '../../lib/stores.svelte';
  import RunExecutionProcess from './RunExecutionProcess.svelte';
  import RuntimeBreadcrumb from './RuntimeBreadcrumb.svelte';

  type AgentLatestRun = {
    projectId: string;
    agentName: string;
    loading: boolean;
    error: string;
    latestRun: RunSummary | null;
    status: RunStatus;
    requestGeneration: number;
  };

  let entries = $state<AgentLatestRun[]>([]);
  let projectLoading = $state(true);
  let projectError = $state('');
  let generation = 0;
  let controller: AbortController | null = null;

  $effect(() => {
    const requestedProject = store.activeProjectId;
    const requestedGeneration = ++generation;
    controller?.abort();
    controller = new AbortController();
    entries = [];
    projectError = '';
    projectLoading = Boolean(requestedProject);
    if (!requestedProject) {
      projectLoading = false;
      return () => controller?.abort();
    }
    const requestedController = controller;
    untrack(() => void loadProject(requestedProject, requestedGeneration, requestedController));
    return () => requestedController.abort();
  });

  function isCurrent(requestedProject: string, requestedGeneration: number, signal: AbortSignal) {
    return !signal.aborted && generation === requestedGeneration && store.activeProjectId === requestedProject;
  }

  function errorMessage(error: unknown, fallback: string) {
    return error instanceof Error && error.message ? error.message : fallback;
  }

  async function loadProject(requestedProject: string, requestedGeneration: number, requestedController: AbortController) {
    try {
      const response = await projectService.getProject(new GetProjectRequest({
        project: { projectId: requestedProject },
        includeSpec: true,
      }), { signal: requestedController.signal });
      if (!isCurrent(requestedProject, requestedGeneration, requestedController.signal)) return;
      entries = (response.project?.agents ?? []).map(agent => ({
        projectId: requestedProject,
        agentName: agent.agentName,
        loading: true,
        error: '',
        latestRun: null,
        status: RunStatus.UNSPECIFIED,
        requestGeneration: 0,
      }));
      projectLoading = false;
      for (const entry of entries) {
        void loadLatestRun(entry, requestedProject, requestedGeneration, requestedController);
      }
    } catch (error) {
      if (!isCurrent(requestedProject, requestedGeneration, requestedController.signal)) return;
      projectLoading = false;
      projectError = errorMessage(error, '加载项目 Agent 失败');
    }
  }

  async function loadLatestRun(
    entry: AgentLatestRun,
    requestedProject: string,
    requestedGeneration: number,
    requestedController: AbortController,
  ) {
    const entryRequestGeneration = ++entry.requestGeneration;
    entry.loading = true;
    entry.error = '';
    try {
      const response = await runService.listRuns(new ListRunsRequest({
        projectId: requestedProject,
        agentName: entry.agentName,
        limit: 1,
      }), { signal: requestedController.signal });
      if (!isCurrent(requestedProject, requestedGeneration, requestedController.signal) || entry.requestGeneration !== entryRequestGeneration) return;
      entry.latestRun = response.runs[0] ?? null;
      entry.status = entry.latestRun?.status ?? RunStatus.UNSPECIFIED;
    } catch (error) {
      if (!isCurrent(requestedProject, requestedGeneration, requestedController.signal) || entry.requestGeneration !== entryRequestGeneration) return;
      entry.latestRun = null;
      entry.error = errorMessage(error, '加载最近运行记录失败');
    } finally {
      if (isCurrent(requestedProject, requestedGeneration, requestedController.signal) && entry.requestGeneration === entryRequestGeneration) entry.loading = false;
    }
  }

  function retryAgent(entry: AgentLatestRun) {
    const requestedProject = entry.projectId;
    const requestedController = controller;
    if (!requestedProject || !requestedController || requestedController.signal.aborted) return;
    void loadLatestRun(entry, requestedProject, generation, requestedController);
  }

  function updateDetailStatus(entry: AgentLatestRun, detail: RunDetail | null) {
    if (detail?.summary) entry.status = detail.summary.status;
  }

  function updateSettledStatus(entry: AgentLatestRun, status: RunStatus) {
    entry.status = status;
  }

  function statusLabel(status: RunStatus) {
    if (status === RunStatus.PENDING) return '等待执行';
    if (status === RunStatus.RUNNING) return '运行中';
    if (status === RunStatus.SUCCEEDED) return '成功';
    if (status === RunStatus.FAILED) return '失败';
    if (status === RunStatus.CANCELED) return '已取消';
    return '未知';
  }
</script>

<div class="root">
  <div class="breadcrumb-wrap">
    <RuntimeBreadcrumb
      eyebrow="Agent 最近运行"
      title="最近运行结果"
      onBack={() => store.navigateTo('agents')}
      backLabel="返回 Agent 列表"
    />
  </div>

  {#if projectLoading}
    <div class="empty">正在加载项目 Agent...</div>
  {:else if projectError}
    <div class="project-error" role="alert">{projectError}</div>
  {:else if entries.length === 0}
    <div class="empty">项目暂无 Agent</div>
  {:else}
    <div class="agent-sections">
      {#each entries as entry (entry.agentName)}
        <section class="agent-section" data-agent={entry.agentName}>
          <header><span>Agent</span><h2>{entry.agentName}</h2>{#if entry.latestRun}<strong class="run-status">{statusLabel(entry.status)}</strong>{/if}</header>
          {#if entry.loading}
            <div class="state">正在加载最近运行记录...</div>
          {:else if entry.error}
            <div class="agent-error" role="alert">
              <span>{entry.error}</span>
              <button type="button" onclick={() => retryAgent(entry)}>重试</button>
            </div>
          {:else if entry.latestRun}
            <RunExecutionProcess
              projectId={entry.projectId}
              agentName={entry.agentName}
              runId={entry.latestRun.runId}
              onDetail={(detail) => updateDetailStatus(entry, detail)}
              onSettled={(status) => updateSettledStatus(entry, status)}
            />
          {:else}
            <div class="state">暂无运行记录</div>
          {/if}
        </section>
      {/each}
    </div>
  {/if}
</div>

<style>
  .root { height: 100%; overflow-y: auto; padding: 14px; box-sizing: border-box; }
  .breadcrumb-wrap { margin: -14px -14px 14px; }
  .agent-sections { display: grid; gap: 22px; }
  .agent-section { min-width: 0; overflow: hidden; border: 1px solid var(--border-color); border-radius: 8px; background: var(--bg-secondary); box-shadow: 0 8px 24px rgba(0, 0, 0, .12); }
  header { display: flex; align-items: center; gap: 10px; padding: 14px; border-bottom: 1px solid var(--border-color); }
  header span { color: var(--text-muted); font: var(--font-size-xs) var(--font-mono); text-transform: uppercase; }
  h2 { margin: 2px 0 0; color: var(--text-primary); font-size: var(--font-size-xl); }
  .run-status { margin-left: auto; color: var(--text-secondary); font-size: var(--font-size-sm); }
  .state, .empty, .project-error { padding: 48px; text-align: center; color: var(--text-muted); }
  .agent-error { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 36px; color: var(--danger, #ef4444); }
  button { border: 1px solid var(--border-color); border-radius: 5px; padding: 5px 10px; color: var(--text-primary); background: var(--bg-primary); cursor: pointer; }
</style>
