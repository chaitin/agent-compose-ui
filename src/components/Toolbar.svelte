<script lang="ts">
  import { onDestroy } from 'svelte';
  import { store } from '../lib/stores.svelte';
  import { capabilityService, imageService, projectService, runService, sandboxService, settingsService } from '../lib/rpc';
  import { yamlToSpec } from '../lib/yaml';
  import {
    getAppliedProjectId,
    deleteProject,
    runYamlBatch,
    prepareProjectPreview,
    consumePendingApply,
    createPreviewGeneration,
    type PreparedProjectPreview,
    probeProjectRuntimeActivity,
    softPauseProject,
    stopProjectRuns,
  } from '../lib/toolbar-actions';
  import {
    ValidateProjectRequest,
    GetGlobalEnvRequest,
    GetProjectRequest,
    ProjectRef,
    ProjectSource,
    ProjectChangeAction,
    RunStatus,
    type ProjectChange,
  } from '../gen/agentcompose/v2/agentcompose_pb';
  import StatusIndicator from './StatusIndicator.svelte';
  import type { ValidateProjectResponse } from '../gen/agentcompose/v2/agentcompose_pb';
  import { scriptApi, scriptErrorMessage } from '../lib/scripts/api';
  import { scriptWorkspace } from '../lib/scripts/workspace.svelte';
  import { prepareScriptRequest } from '../lib/scripts/request-pipeline';
  import { canonicalProjectId } from '../lib/scripts/project-lifecycle';
  import { isSameProjectId } from '../lib/projects';
  import { replaceBatchAgent, type BatchAgentStatus } from '../lib/yaml-run-batch';
  import { yamlRunBatches } from '../lib/yaml-run-batch.svelte';
  import {
    changedBuildAgentNames,
    createProjectImageBuildPlans,
    ProjectImageBuildRunError,
    runProjectImageBuildPlans,
    type ProjectImageBuildPlan,
    type ProjectImageBuildRunResult,
  } from '../lib/project-image-build';
  import { checkProjectDependencies } from '../lib/project-dependency-preflight';
  import { llmConfigWarning } from '../lib/llm-config-preflight';

  let specHash = $state('');
  let synced = $state(false);
  let validating = $state(false);
  let saving = $state(false);
  let running = $state(false);
  let pausing = $state(false);
  let pauseActivityLoading = $state(false);
  let pauseActivityActive = $state(false);
  let pauseProbeVersion = $state(0);
  let pauseProbeGeneration = 0;
  let stopping = $state(false);
  let showDiff = $state(false);
  let showUnchanged = $state(false);
  let diffChanges: ProjectChange[] = $state([]);
  let previewIssues: Array<{ severity: unknown; path: string; message: string }> = $state([]);
  let previewUnchanged = $state(false);
  type PreparedScripts = Awaited<ReturnType<typeof prepareScriptRequest>>;
  let pendingApply: (PreparedProjectPreview<PreparedScripts> & { generation: number }) | undefined = $state();
  let pendingMode: 'save' | 'run' = $state('save');
  let buildPlans: ProjectImageBuildPlan[] = $state([]);
  let selectedBuildAgents: Set<string> = $state(new Set());
  let buildChoice: 'build' | 'skip' = $state('build');
  let forceNoCache = $state(false);
  let forcePull = $state(false);
  let buildResults: ProjectImageBuildRunResult[] = $state([]);
  let buildError = $state('');
  let buildBusy = $state(false);
  let operationPhase: 'choose' | 'build' | 'apply' | 'run' = $state('choose');
  let batchController: AbortController | undefined;
  let applyController: AbortController | undefined;

  function clearPreview() {
    applyController?.abort(new DOMException('Apply canceled', 'AbortError'));
    applyController = undefined;
    batchController?.abort();
    batchController = undefined;
    pendingApply = undefined;
    diffChanges = [];
    previewIssues = [];
    previewUnchanged = false;
    buildPlans = [];
    selectedBuildAgents = new Set();
    buildResults = [];
    buildError = '';
    buildBusy = false;
    operationPhase = 'choose';
    showUnchanged = false;
    showDiff = false;
  }

  function closePreview() {
    if (buildBusy) return;
    previewGeneration.invalidate();
  }

  const previewGeneration = createPreviewGeneration(clearPreview);
  onDestroy(() => batchController?.abort());
  let observedPreviewContext = `${store.activeProjectId}\u0000${store.editorContent}`;

  $effect(() => {
    const context = `${store.activeProjectId}\u0000${store.editorContent}`;
    if (context !== observedPreviewContext) {
      observedPreviewContext = context;
      previewGeneration.invalidate();
    }
  });

  $effect(() => {
    const projectId = store.activeProjectId;
    void store.runtimeRefreshVersion;
    void pauseProbeVersion;
    const generation = ++pauseProbeGeneration;
    pauseActivityActive = false;
    if (!projectId) {
      pauseActivityLoading = false;
      return;
    }
    pauseActivityLoading = true;
    void probeProjectRuntimeActivity({
      projectId,
      client: {
        listSchedulers: projectService.listSchedulers,
        getScheduler: projectService.getScheduler,
        listSchedulerRuns: projectService.listSchedulerRuns,
        listRuns: runService.listRuns,
        listSandboxes: sandboxService.listSandboxes,
      },
    }).then((activity) => {
      if (generation !== pauseProbeGeneration || projectId !== store.activeProjectId) return;
      pauseActivityActive = activity.active;
    }).catch((error) => {
      if (generation !== pauseProbeGeneration || projectId !== store.activeProjectId) return;
      pauseActivityActive = false;
      store.addToast(`检测可暂停状态失败: ${errorMessage(error)}`, 'error');
    }).finally(() => {
      if (generation === pauseProbeGeneration && projectId === store.activeProjectId) pauseActivityLoading = false;
    });
  });

  let changedChanges = $derived(
    diffChanges.filter((change) => change.action !== ProjectChangeAction.UNCHANGED),
  );
  let unchangedChanges = $derived(
    diffChanges.filter((change) => change.action === ProjectChangeAction.UNCHANGED),
  );
  let createdCount = $derived(
    diffChanges.filter((change) => change.action === ProjectChangeAction.CREATED).length,
  );
  let updatedCount = $derived(
    diffChanges.filter((change) => change.action === ProjectChangeAction.UPDATED).length,
  );
  let removedCount = $derived(
    diffChanges.filter((change) => change.action === ProjectChangeAction.REMOVED).length,
  );

  function actionLabel(a: ProjectChangeAction): string {
    switch (a) {
      case ProjectChangeAction.CREATED: return '新增';
      case ProjectChangeAction.UPDATED: return '更新';
      case ProjectChangeAction.REMOVED: return '删除';
      case ProjectChangeAction.UNCHANGED: return '未变更';
      default: return '?';
    }
  }

  function actionClass(a: ProjectChangeAction): string {
    switch (a) {
      case ProjectChangeAction.CREATED: return 'created';
      case ProjectChangeAction.UPDATED: return 'updated';
      case ProjectChangeAction.REMOVED: return 'removed';
      case ProjectChangeAction.UNCHANGED: return 'unchanged';
      default: return 'unknown';
    }
  }

  function actionSymbol(a: ProjectChangeAction): string {
    switch (a) {
      case ProjectChangeAction.CREATED: return '+';
      case ProjectChangeAction.UPDATED: return '↻';
      case ProjectChangeAction.REMOVED: return '−';
      case ProjectChangeAction.UNCHANGED: return '·';
      default: return '?';
    }
  }

  function resourceLabel(t: string): string {
    switch (t) {
      case 'agent':
      case 'project_agent': return '项目智能体';
      case 'agent_definition': return '智能体定义';
      case 'scheduler':
      case 'project_scheduler': return '调度计划';
      case 'loader': return '资源加载器';
      case 'project_revision': return '项目版本';
      case 'trigger': return '触发器';
      case 'env_var': return '环境变量';
      case 'variable': return '环境变量';
      case 'project': return '智能体应用';
      case 'workspace': return '工作区';
      default: return t;
    }
  }

  function displayName(change: ProjectChange): string {
    if (change.resourceType === 'project_revision' && change.name.startsWith('sha256:')) {
      return `${change.name.slice(0, 17)}…${change.name.slice(-8)}`;
    }
    return change.name;
  }

  async function handleValidate() {
    validating = true;
    try {
      const prepared = await prepareScriptRequest({
        mode: 'validate',
        editorYaml: store.editorContent,
        workspace: scriptWorkspace,
        readFile: scriptApi.readFile,
      });
      const { spec, error } = yamlToSpec(prepared.yamlText);
      if (error) {
        store.addToast(`YAML 解析错误: ${error}`, 'error');
        return;
      }
      const source = new ProjectSource({ composePath: 'agent-compose.yml' });
      void warnAboutMissingLLMConfig(spec);
      const req = new ValidateProjectRequest({ spec, source });
      const resp = await projectService.validateProject(req) as ValidateProjectResponse;
      if (resp.valid) {
        store.addToast('校验通过', 'success');
      } else {
        const msgs = (resp.issues || []).map((i: any) => `[${i.severity}] ${i.path}: ${i.message}`).join('\n');
        store.addToast(`校验问题:\n${msgs}`, 'error');
      }
    } catch (e: any) {
      store.addToast(`校验失败: ${scriptMessage(e)}`, 'error');
    } finally {
      validating = false;
    }
  }

  async function warnAboutMissingLLMConfig(spec: ReturnType<typeof yamlToSpec>['spec']) {
    try {
      const response = await settingsService.getGlobalEnv(new GetGlobalEnvRequest());
      const warning = llmConfigWarning(spec, response.env);
      if (warning) store.addToast(warning, 'info');
    } catch {
      // This is an advisory preflight; the daemon remains the source of truth.
    }
  }

  function scriptMessage(error: unknown): string {
    return scriptErrorMessage(error);
  }

  function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }

  function showSaveError(error: unknown) {
    if (error instanceof Error && (
      error.message.startsWith('YAML 解析错误:') ||
      error.message.startsWith('智能体应用名称 "') ||
      error.message === '保存未生效'
    )) {
      store.addToast(error.message, 'error');
      return;
    }
    const msg = error instanceof Error && error.name === 'AbortError'
      ? '保存超时 — 后端可能正在拉取镜像，请等待或重试'
      : errorMessage(error);
    store.addToast(`保存失败: ${msg}`, 'error');
  }

  async function previewCurrentProject(mode: 'save' | 'run' = 'save') {
    const context = `${store.activeProjectId}\u0000${store.editorContent}`;
    if (context !== observedPreviewContext) {
      observedPreviewContext = context;
      previewGeneration.invalidate();
    }
    const generation = previewGeneration.begin();
    const currentProjectId = store.activeProjectId;
    const editorContent = store.editorContent;
    const projects = store.projects.map((project) => ({ ...project, summary: { ...project.summary } }));
    const fallbackSpecHash = specHash;
    const preview = await prepareProjectPreview({
      mode, currentProjectId, editorContent, projects, fallbackSpecHash,
      prepare: async (snapshotEditorContent) => prepareScriptRequest({
        mode,
        editorYaml: snapshotEditorContent,
        workspace: scriptWorkspace,
        readFile: scriptApi.readFile,
      }),
      preflight: async (prepared) => {
        const parsed = yamlToSpec(prepared.yamlText);
        if (parsed.error) throw new Error(`YAML 解析错误: ${parsed.error}`);
        void warnAboutMissingLLMConfig(parsed.spec);
        const result = await checkProjectDependencies({
          spec: parsed.spec,
          imageClient: imageService,
          capabilityClient: capabilityService,
        });
        if (!previewGeneration.isCurrent(generation)) return;
        for (const warning of result.warnings) store.addToast(warning, 'error');
      },
      client: projectService,
      isCurrent: () => previewGeneration.isCurrent(generation),
    });
    if (!preview) return;
    const frozenSpec = yamlToSpec(preview.prepared.yamlText).spec;
    const currentProject = projects.find((project) => isSameProjectId(project.summary.projectId, currentProjectId));
    const savedSpec = currentProject
      ? (await projectService.getProject(new GetProjectRequest({
          project: new ProjectRef({ projectId: currentProject.summary.projectId }),
          includeSpec: true,
        }))).project?.spec
      : undefined;
    if (!previewGeneration.isCurrent(generation)) return;
    if (currentProject && !savedSpec) throw new Error('无法读取已保存的智能体应用配置');
    pendingApply = { ...preview, generation };
    pendingMode = mode;
    buildPlans = createProjectImageBuildPlans(frozenSpec, currentProject?.summary.sourcePath?.trim() || '');
    const changedBuildAgents = changedBuildAgentNames(savedSpec, frozenSpec);
    const hasChangedBuild = buildPlans.some((plan) => !plan.error && changedBuildAgents.has(plan.agentName));
    buildChoice = hasChangedBuild ? 'build' : 'skip';
    selectedBuildAgents = new Set(hasChangedBuild
      ? buildPlans.filter((plan) => !plan.error).map((plan) => plan.agentName)
      : []);
    forceNoCache = false;
    forcePull = false;
    buildResults = [];
    buildError = '';
    operationPhase = 'choose';
    diffChanges = preview.response.changes || [];
    previewIssues = preview.response.issues || [];
    previewUnchanged = preview.response.unchanged;
    showDiff = true;
  }

  async function confirmApply() {
    const candidate = pendingApply;
    if (!candidate || saving || running || !previewGeneration.isCurrent(candidate.generation)) return;
    const mode = pendingMode;
    saving = mode === 'save'; running = mode === 'run';
    const controller = new AbortController();
    applyController = controller;
    try {
    const prepared = candidate.prepared;
    const result = await consumePendingApply({
      take: () => {
        if (pendingApply !== candidate || !previewGeneration.isCurrent(candidate.generation)) return undefined;
        pendingApply = undefined;
        return candidate;
      },
      restore: (failed) => {
        if (!previewGeneration.isCurrent(candidate.generation)) return;
        pendingApply = failed as PreparedProjectPreview<PreparedScripts> & { generation: number };
        showDiff = true;
      },
    }, controller.signal);
    if (!result) return;
    if (!previewGeneration.isCurrent(candidate.generation)) return;
    const { response, agentNames, agents, supersededProjectId } = result;
    if (supersededProjectId) {
      await deleteProject(supersededProjectId, projectService, { stopRunningSessions: false });
      if (!previewGeneration.isCurrent(candidate.generation)) return;
      store.removeProjectEditor(supersededProjectId);
    }
    const appliedProjectId = getAppliedProjectId(response, candidate.currentProjectId);
    const stillCurrent = previewGeneration.isCurrent(candidate.generation);
    if (stillCurrent) {
      if (!candidate.currentProjectId && appliedProjectId) store.removeEditorDraft();
      synced = true;
      if (response.revision) specHash = response.revision.specHash;
      diffChanges = [];
      previewIssues = [];
      previewUnchanged = true;
      showUnchanged = false;
    }
    const projectName = yamlToSpec(prepared.yamlText).spec.name.trim() || '';
    let manifestError: Error | null = null;
    if (appliedProjectId) {
      try {
        await scriptApi.ensureProject(appliedProjectId, projectName);
        if (!previewGeneration.isCurrent(candidate.generation)) return;
        await scriptApi.writeManifest(appliedProjectId, {
          version: 1,
          projectId: canonicalProjectId(appliedProjectId),
          projectName,
          updatedAt: new Date().toISOString(),
          references: prepared.references,
        });
        if (!previewGeneration.isCurrent(candidate.generation)) return;
      } catch (error) {
        manifestError = error instanceof Error ? error : new Error(String(error));
      }
    }

    const remainsCurrent = previewGeneration.isCurrent(candidate.generation);
    if (remainsCurrent) {
      showDiff = false;
      store.triggerRuntimeRefresh();
      if ((window as any).__refreshProjects) {
        await (window as any).__refreshProjects();
        if (!previewGeneration.isCurrent(candidate.generation)) return;
      }
      if (manifestError) store.addToast(`项目代码已保存，但脚本引用元数据保存失败：${scriptMessage(manifestError)}`, 'error');
      else store.addToast('启用成功', 'success');
      if (mode === 'run') {
        operationPhase = 'run';
        await startAppliedAgents(appliedProjectId, agentNames, agents, candidate.generation);
      }
      if (previewGeneration.isCurrent(candidate.generation) && appliedProjectId && store.activeProjectId !== appliedProjectId) {
        observedPreviewContext = `${appliedProjectId}\u0000${store.editorContent}`;
        store.activeProjectId = appliedProjectId;
        store.syncHash();
        // Cache the raw editor YAML (keeps `${VAR}` / `$ref:`) for the applied
        // project so re-entering it doesn't fall back to the expanded snapshot.
        store.saveProjectEditor(appliedProjectId, store.editorContent);
      }
    }
    } catch (error) {
      if (previewGeneration.isCurrent(candidate.generation)) showSaveError(error);
    }
    finally {
      if (applyController === controller) applyController = undefined;
      saving = false;
      running = false;
    }
  }

  function setBuildChoice(choice: 'build' | 'skip') {
    buildChoice = choice;
    selectedBuildAgents = new Set(choice === 'build'
      ? buildPlans.filter((plan) => !plan.error).map((plan) => plan.agentName)
      : []);
    buildError = '';
  }

  function mergedBuildResults(next: ProjectImageBuildRunResult[]): ProjectImageBuildRunResult[] {
    const byAgent = new Map(buildResults.filter((result) => result.status === 'succeeded').map((result) => [result.agentName, result]));
    for (const result of next) byAgent.set(result.agentName, {
      ...result,
      stream: { ...result.stream, lines: [...result.stream.lines], warnings: [...result.stream.warnings] },
    });
    return buildPlans.flatMap((plan) => {
      const result = byAgent.get(plan.agentName);
      return result ? [result] : [];
    });
  }

  async function confirmBuildAndApply() {
    const candidate = pendingApply;
    if (!candidate || buildBusy || saving || running) return;
    if (buildChoice === 'skip' || buildPlans.length === 0) {
      operationPhase = 'apply';
      await confirmApply();
      return;
    }
    if (selectedBuildAgents.size === 0) {
      buildError = '请至少选择一个需要构建的智能体';
      return;
    }
    const invalid = buildPlans.find((plan) => selectedBuildAgents.has(plan.agentName) && plan.error);
    if (invalid) {
      buildError = invalid.error;
      return;
    }

    buildBusy = true;
    buildError = '';
    operationPhase = 'build';
    try {
      const completed = await runProjectImageBuildPlans({
        plans: buildPlans,
        selectedAgentNames: selectedBuildAgents,
        client: imageService,
        forceNoCache,
        forcePull,
        onUpdate: (_result, results) => { buildResults = mergedBuildResults(results); },
      });
      buildResults = mergedBuildResults(completed);
      if (pendingApply !== candidate || !previewGeneration.isCurrent(candidate.generation)) return;
      operationPhase = 'apply';
      buildBusy = false;
      await confirmApply();
    } catch (error) {
      if (error instanceof ProjectImageBuildRunError) {
        buildResults = mergedBuildResults(error.results);
        selectedBuildAgents = new Set(error.results
          .filter((result) => result.status === 'failed' || result.status === 'unexecuted')
          .map((result) => result.agentName));
      }
      buildError = errorMessage(error);
      operationPhase = 'build';
    } finally {
      buildBusy = false;
    }
  }

  function buildActionLabel(): string {
    if (saving || (running && operationPhase === 'apply')) return '启用中…';
    if (buildBusy) return '构建中…';
    if (buildChoice === 'skip' || buildPlans.length === 0) return pendingMode === 'run' ? '启用并运行' : '确认启用';
    if (buildError) return '重试失败及未执行项';
    return pendingMode === 'run' ? '构建、启用并运行' : '构建并启用';
  }

  function hasBlockingBuildError(): boolean {
    return buildChoice === 'build' && buildPlans.some((plan) => !!plan.error);
  }

  async function handleSave() {
    saving = true;
    try {
      await previewCurrentProject();
    } catch (error) {
      showSaveError(error);
    } finally {
      saving = false;
    }
  }

  function handleDraftSave() {
    const result = store.saveEditorDraft();
    if (!result.ok) {
      store.addToast(`草稿名称 "${result.name}" 已存在`, 'error');
      return;
    }
    store.addToast('草稿已保存到此浏览器', 'success');
  }

  async function handleRun() {
    running = true;
    try {
      await previewCurrentProject('run');
    } catch (error) { showSaveError(error); }
    finally { running = false; }
  }

  async function handlePause() {
    const projectId = store.activeProjectId;
    if (!projectId || saving || running || pausing || stopping || pauseActivityLoading || !pauseActivityActive) return;
    pauseActivityActive = false;
    pausing = true;
    try {
      const result = await softPauseProject({
        projectId,
        client: {
          listSchedulers: projectService.listSchedulers,
          getScheduler: projectService.getScheduler,
          setSchedulerEnabled: projectService.setSchedulerEnabled,
          listSchedulerRuns: projectService.listSchedulerRuns,
          stopSchedulerRun: projectService.stopSchedulerRun,
          listRuns: runService.listRuns,
          stopRun: runService.stopRun,
          listSandboxes: sandboxService.listSandboxes,
          stopSandbox: sandboxService.stopSandbox,
        },
      });
      if (result.failed === 0) {
        store.addToast('项目已暂停', 'success');
      } else {
        store.addToast(
          `项目暂停未完全成功：Scheduler ${result.schedulers.succeeded} 成功/${result.schedulers.failed} 失败，Scheduler Run ${result.schedulerRuns.succeeded} 成功/${result.schedulerRuns.failed} 失败，Agent Run ${result.runs.succeeded} 成功/${result.runs.failed} 失败，Sandbox ${result.sandboxes.succeeded} 成功/${result.sandboxes.failed} 失败`,
          'error',
        );
      }
    } catch (error) {
      store.addToast(`暂停失败: ${errorMessage(error)}`, 'error');
    } finally {
      store.triggerRuntimeRefresh();
      try {
        if ((window as any).__refreshProjects) {
          await (window as any).__refreshProjects();
        }
      } finally {
        pausing = false;
        pauseProbeVersion++;
      }
    }
  }

  function batchStatus(status: RunStatus): BatchAgentStatus {
    switch (status) {
      case RunStatus.RUNNING: return 'running';
      case RunStatus.SUCCEEDED: return 'succeeded';
      case RunStatus.FAILED: return 'failed';
      case RunStatus.CANCELED: return 'canceled';
      case RunStatus.PENDING:
      case RunStatus.UNSPECIFIED:
      default: return 'pending';
    }
  }

  function startAppliedAgents(projectId: string, agentNames: string[], agents: Array<{ name: string; prompt: string; hasScheduler: boolean }>, generation: number) {
      if (!previewGeneration.isCurrent(generation)) return;
      if (!projectId) {
        store.addToast('无法运行：保存结果缺少项目 ID', 'error');
        return;
      }
      if (agentNames.length === 0) {
        store.addToast('没有可运行的智能体', 'info');
        return;
      }

      batchController?.abort();
      const controller = new AbortController();
      batchController = controller;
      const batch = yamlRunBatches.create(projectId, agents);
      const isCurrentBatch = () => (
        batchController === controller &&
        previewGeneration.isCurrent(generation) &&
        yamlRunBatches.current(projectId)?.batchId === batch.batchId
      );
      const updateAgent = (name: string, patch: Parameters<typeof replaceBatchAgent>[2]) => {
        if (!isCurrentBatch()) return;
        yamlRunBatches.update(projectId, batch.batchId, (value) => replaceBatchAgent(value, name, patch));
      };
      const refreshRuntime = () => {
        if (!isCurrentBatch()) return;
        store.triggerRuntimeRefresh();
        const refreshProjects = (window as any).__refreshProjects;
        if (refreshProjects) {
          void Promise.resolve()
            .then(() => { if (isCurrentBatch()) return refreshProjects(); })
            .catch(() => undefined);
        }
      };
      store.navigateTo('latest-run');
      void runYamlBatch({
        projectId,
        agents,
        client: runService,
        signal: controller.signal,
        isCurrent: isCurrentBatch,
        onStarting: (name) => updateAgent(name, { status: 'starting', startError: '' }),
        onStarted: (name, run) => {
          if (!isCurrentBatch()) return;
          updateAgent(name, { runId: run.runId, status: batchStatus(run.status), startError: '' });
          store.addToast(`智能体 "${name}" 已启动运行`, 'success');
          refreshRuntime();
        },
        onChunk: (name, chunk) => updateAgent(name, { status: batchStatus(chunk.runStatus) }),
        onFinished: (name, status) => updateAgent(name, { status: batchStatus(status) }),
        onTrackingError: (name, error) => {
          if (!isCurrentBatch()) return;
          store.addToast(`运行 "${name}" 跟踪中断: ${errorMessage(error)}`, 'error');
          refreshRuntime();
        },
        onStartFailed: (name, error) => {
          if (!isCurrentBatch()) return;
          updateAgent(name, { status: 'start-failed', startError: errorMessage(error) });
          store.addToast(`启动 "${name}" 运行失败: ${errorMessage(error)}`, 'error');
        },
      }).then(async () => {
        if (!isCurrentBatch()) return;
        refreshRuntime();
      }).catch((error) => {
        if (!isCurrentBatch()) return;
        store.addToast(`批次运行跟踪失败: ${errorMessage(error)}`, 'error');
        refreshRuntime();
      });
  }

  async function handleStopAll() {
    if (!store.activeProjectId || saving || running || pausing || stopping) return;
    stopping = true;
    try {
      const result = await stopProjectRuns({
        projectId: store.activeProjectId,
        client: runService,
      });
      if (result.failed > 0) {
        store.addToast(`已停止 ${result.stopped} 个运行，${result.failed} 个停止失败`, 'error');
      } else if (result.stopped > 0) {
        store.addToast(`已停止 ${result.stopped} 个运行`, 'success');
      } else {
        store.addToast('当前没有正在运行或等待中的智能体', 'info');
      }
      store.triggerRuntimeRefresh();
      if ((window as any).__refreshProjects) {
        await (window as any).__refreshProjects();
      }
    } catch (e: any) {
      store.addToast(`停止失败: ${e.message}`, 'error');
    } finally {
      stopping = false;
    }
  }
</script>

<div class="toolbar">
  <div class="toolbar-left">
    <StatusIndicator {specHash} {synced} />
  </div>
  <div class="toolbar-actions">
    <button class="btn btn-secondary" onclick={handleValidate} disabled={validating}>
      {validating ? '校验中...' : '校验'}
    </button>
    <button class="btn btn-secondary" onclick={() => showDiff = true} disabled={diffChanges.length === 0}>
      变更 ({changedChanges.length})
    </button>
    <button class="btn btn-secondary" onclick={handleDraftSave} disabled={saving || running || pausing || stopping}>
      保存草稿
    </button>
    <button class="btn btn-secondary" onclick={handleSave} disabled={saving || running || pausing || stopping}>
      {#if saving}<span class="loading-spinner" aria-hidden="true"></span>{/if}{saving ? '启用中…' : '启用'}
    </button>
    <button hidden class="btn btn-primary" onclick={handleRun} disabled={saving || running || pausing || stopping}>
      {running ? '运行中...' : '运行'}
    </button>
    <button class="btn btn-secondary" onclick={handlePause} disabled={saving || running || pausing || stopping || pauseActivityLoading || !pauseActivityActive || !store.activeProjectId}>
      {pausing ? '暂停中...' : '暂停'}
    </button>
    <button hidden class="btn btn-danger" onclick={handleStopAll} disabled={saving || running || pausing || stopping || !store.activeProjectId}>
      {stopping ? '停止中...' : '停止全部'}
    </button>
  </div>
</div>

{#if showDiff}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="diff-overlay"
    onclick={closePreview}
    onkeydown={(e: KeyboardEvent) => { if (e.key === 'Escape') closePreview(); }}
    role="dialog"
    tabindex="-1"
  >
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="diff-panel"
      onclick={(e: MouseEvent) => e.stopPropagation()}
      onkeydown={(e: KeyboardEvent) => e.stopPropagation()}
      role="document"
    >
      <header class="diff-header">
        <div>
          <span class="diff-eyebrow">服务端预览</span>
          <h3>确认本次变更</h3>
          <p>
            {changedChanges.length > 0
              ? `服务端预计修改 ${changedChanges.length} 项，确认后才会应用。`
              : previewUnchanged ? '服务端确认当前配置无需变更。' : '服务端未返回资源变更。'}
          </p>
        </div>
        <button class="diff-close" onclick={closePreview} aria-label="关闭变更记录" disabled={buildBusy}>×</button>
      </header>

      <div class="diff-summary" aria-label="变更统计">
        <div class="summary-total">
          <strong>{changedChanges.length}</strong>
          <span>项变更</span>
        </div>
        <div class="summary-breakdown">
          <span class="summary-stat created"><i>+</i> 新增 <strong>{createdCount}</strong></span>
          <span class="summary-stat updated"><i>↻</i> 更新 <strong>{updatedCount}</strong></span>
          <span class="summary-stat removed"><i>−</i> 删除 <strong>{removedCount}</strong></span>
        </div>
      </div>

      <div class="diff-content">
        {#if previewIssues.length > 0}
          <section class="change-section"><div class="section-heading"><span>服务端问题</span><span>{previewIssues.length}</span></div>
            <div class="change-list">{#each previewIssues as issue}<div class="diff-item removed"><div class="change-copy"><div class="change-primary"><span class="name">[{String(issue.severity)}] {issue.path}</span></div><div class="change-meta"><span class="msg">{issue.message}</span></div></div></div>{/each}</div>
          </section>
        {/if}
        {#if changedChanges.length > 0}
          <section class="change-section" aria-labelledby="changed-heading">
            <div class="section-heading" id="changed-heading">
              <span>已修改的内容</span>
              <span>{changedChanges.length}</span>
            </div>
            <div class="change-list changed-scroll">
              {#each changedChanges as c}
                <div class="diff-item {actionClass(c.action)}">
                  <span class="change-symbol" aria-hidden="true">{actionSymbol(c.action)}</span>
                  <div class="change-copy">
                    <div class="change-primary">
                      <span class="name" title={c.name}>{displayName(c)}</span>
                      <span class="action">{actionLabel(c.action)}</span>
                    </div>
                    <div class="change-meta">
                      <span class="resource">{resourceLabel(c.resourceType)}</span>
                      {#if c.message}<span class="msg">{c.message}</span>{/if}
                    </div>
                  </div>
                </div>
              {/each}
            </div>
          </section>
        {:else}
          <div class="no-changes">
            <span class="no-changes-icon">✓</span>
            <strong>所有内容均为最新</strong>
            <p>当前配置与已保存版本一致。</p>
          </div>
        {/if}

        {#if buildPlans.length > 0}
          <section class="build-section" aria-labelledby="build-heading">
            <div class="section-heading" id="build-heading"><span>本次镜像处理</span><span>{buildPlans.length} 个可构建智能体</span></div>
            {#if buildResults.length === 0}
              <label class="build-mode" class:selected={buildChoice === 'build'}>
                <input type="radio" name="build-choice" value="build" checked={buildChoice === 'build'} onchange={() => setBuildChoice('build')} />
                <span><strong>构建 YAML 中配置的镜像</strong><small>先构建全部有效镜像，再应用当前配置。</small></span>
              </label>
              <label class="build-mode skip" class:selected={buildChoice === 'skip'}>
                <input type="radio" name="build-choice" value="skip" checked={buildChoice === 'skip'} onchange={() => setBuildChoice('skip')} />
                <span><strong>仅应用配置，不构建镜像</strong><small>可能使用已有镜像；本地缺失时后端会尝试从仓库拉取。</small></span>
              </label>
              {#if buildChoice === 'build'}
                <div class="build-options"><strong>本次构建选项</strong><div>
                  <label><input type="checkbox" bind:checked={forceNoCache} /> 不使用缓存</label>
                  <label><input type="checkbox" bind:checked={forcePull} /> 拉取最新基础镜像</label>
                </div></div>
                {#each buildPlans.filter((plan) => !!plan.error) as plan}
                  <div class="build-plan-error">{plan.agentName}：{plan.error}</div>
                {/each}
              {/if}
              <p class="build-side-effect">构建成功的镜像会保留在 daemon，即使后续应用配置失败。</p>
            {:else}
              <div class="build-progress-list">
                {#each buildResults as result}
                  <div class="build-result" class:failed={result.status === 'failed'}>
                    <span class="result-symbol">{result.status === 'succeeded' ? '✓' : result.status === 'failed' ? '!' : result.status === 'building' ? '●' : '○'}</span>
                    <span><strong>{result.agentName}</strong><small>{result.imageRef}</small></span>
                    <em>{result.status === 'succeeded' ? '构建成功' : result.status === 'failed' ? '构建失败' : result.status === 'building' ? '构建中' : result.status === 'unexecuted' ? '未执行' : '等待中'}</em>
                  </div>
                  {#if result.status === 'building' || result.status === 'failed'}
                    <div class="build-log" aria-label={`${result.agentName} 构建日志`}>
                      {#each result.stream.lines as line}<div><b>{line.stage || 'build'}</b><span>{line.message}</span></div>{/each}
                      {#if result.error}<div class="log-error">{result.error}</div>{/if}
                    </div>
                  {/if}
                {/each}
              </div>
            {/if}
            {#if buildError}<div class="build-error">{buildError}</div>{/if}
          </section>
        {/if}

        {#if unchangedChanges.length > 0}
          <section class="unchanged-section">
            <button class="unchanged-toggle" onclick={() => showUnchanged = !showUnchanged} aria-expanded={showUnchanged}>
              <span><i>✓</i> 未变更内容</span>
              <span class="toggle-meta">{unchangedChanges.length} 项 <b class:expanded={showUnchanged}>⌄</b></span>
            </button>
            {#if showUnchanged}
              <div class="unchanged-list">
                {#each unchangedChanges as c}
                  <div class="unchanged-item">
                    <span class="resource">{resourceLabel(c.resourceType)}</span>
                    <span class="name" title={c.name}>{displayName(c)}</span>
                  </div>
                {/each}
              </div>
            {/if}
          </section>
        {/if}
      </div>

      <footer class="diff-footer">
        <span>确认启用后，当前配置将覆盖上次启用的版本。</span>
        <div><button class="btn btn-secondary" onclick={closePreview} disabled={buildBusy}>取消</button>
        <button class="btn btn-primary" onclick={confirmBuildAndApply} disabled={previewIssues.length > 0 || hasBlockingBuildError() || buildBusy || saving || running}>{#if saving || (running && operationPhase === 'apply')}<span class="loading-spinner" aria-hidden="true"></span>{/if}{buildActionLabel()}</button></div>
      </footer>
    </div>
  </div>
{/if}

<style>
  .toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 12px;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border-color);
    min-height: 36px;
  }
  .loading-spinner {
    display: inline-block;
    width: 11px;
    height: 11px;
    margin-right: 6px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    vertical-align: -2px;
    animation: spin .7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .toolbar-left { display: flex; align-items: center; gap: 8px; }
  .toolbar-actions { display: flex; gap: 6px; }
  .btn {
    padding: 4px 12px;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    font-size: var(--font-size-md);
    font-weight: 500;
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-primary { background: var(--accent-green); color: #000; border-color: var(--accent-green); }
  .btn-danger { background: transparent; color: var(--accent-red); border-color: var(--accent-red); }
  .btn-danger:hover { background: var(--accent-red); color: #fff; }
  .btn-secondary:hover { border-color: var(--text-muted); }
  .diff-overlay {
    position: fixed;
    inset: 0;
    padding: 24px;
    background: rgba(1, 4, 9, 0.78);
    backdrop-filter: blur(5px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    animation: diff-fade-in 160ms ease-out;
  }
  .diff-panel {
    width: min(680px, 100%);
    max-height: min(760px, calc(100vh - 48px));
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: linear-gradient(145deg, rgba(63, 185, 80, 0.045), transparent 32%), var(--bg-secondary);
    border: 1px solid #30363d;
    border-top-color: #484f58;
    border-radius: 12px;
    box-shadow: 0 24px 80px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.025);
    animation: diff-panel-in 220ms cubic-bezier(0.2, 0.75, 0.25, 1);
  }
  .diff-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    padding: 24px 26px 20px;
    border-bottom: 1px solid var(--border-color);
  }
  .diff-eyebrow {
    display: block;
    margin-bottom: 5px;
    color: var(--accent-green);
    font-family: var(--font-mono);
    font-size: var(--font-size-xs);
    font-weight: 700;
    letter-spacing: 0.13em;
    text-transform: uppercase;
  }
  .diff-header h3 { margin: 0; color: var(--text-primary); font-size: var(--font-size-3xl); line-height: 1.25; }
  .diff-header p { margin: 7px 0 0; color: var(--text-secondary); font-size: var(--font-size-md); line-height: 1.6; }
  .diff-close {
    width: 30px;
    height: 30px;
    margin: -5px -7px 0 16px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: transparent;
    color: var(--text-muted);
    font-size: 22px;
    line-height: 1;
  }
  .diff-close:hover { color: var(--text-primary); border-color: var(--border-color); background: var(--bg-tertiary); }
  .diff-summary {
    display: flex;
    align-items: stretch;
    margin: 18px 26px 0;
    min-height: 72px;
    border: 1px solid var(--border-color);
    border-radius: 8px;
    background: rgba(13, 17, 23, 0.72);
    overflow: hidden;
  }
  .summary-total {
    display: flex;
    flex-direction: column;
    justify-content: center;
    min-width: 120px;
    padding: 12px 20px;
    border-right: 1px solid var(--border-color);
  }
  .summary-total strong { color: var(--text-primary); font-family: var(--font-mono); font-size: var(--font-size-hero); line-height: 1; }
  .summary-total span { margin-top: 7px; color: var(--text-muted); font-size: var(--font-size-xs); }
  .summary-breakdown { display: grid; grid-template-columns: repeat(3, 1fr); align-items: center; flex: 1; }
  .summary-stat {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 30px;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    border-right: 1px solid var(--border-color);
  }
  .summary-stat:last-child { border-right: 0; }
  .summary-stat i { font-family: var(--font-mono); font-style: normal; font-size: var(--font-size-lg); font-weight: 700; }
  .summary-stat strong { color: var(--text-primary); font-family: var(--font-mono); }
  .summary-stat.created i { color: var(--accent-green); }
  .summary-stat.updated i { color: var(--accent-yellow); }
  .summary-stat.removed i { color: var(--accent-red); }
  .diff-content { min-height: 0; padding: 20px 26px 22px; overflow-y: auto; }
  .section-heading {
    display: flex;
    justify-content: space-between;
    margin-bottom: 9px;
    color: var(--text-muted);
    font-size: var(--font-size-xs);
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .change-list { border: 1px solid var(--border-color); border-radius: 8px; overflow: hidden; }
  .change-list.changed-scroll { max-height: 240px; overflow-y: auto; overscroll-behavior: contain; }
  .changed-scroll .diff-item { gap: 8px; padding: 7px 10px; }
  .changed-scroll .change-symbol { flex-basis: 20px; width: 20px; height: 20px; margin-top: 0; border-radius: 4px; font-size: 13px; }
  .changed-scroll .change-meta { margin-top: 2px; line-height: 1.25; }
  .diff-item {
    position: relative;
    display: flex;
    gap: 12px;
    min-width: 0;
    padding: 13px 14px;
    border-bottom: 1px solid var(--border-color);
    background: rgba(13, 17, 23, 0.42);
  }
  .diff-item:last-child { border-bottom: 0; }
  .diff-item:hover { background: var(--bg-tertiary); }
  .diff-item::before { content: ''; position: absolute; inset: 0 auto 0 0; width: 2px; }
  .diff-item.created::before { background: var(--accent-green); }
  .diff-item.updated::before { background: var(--accent-yellow); }
  .diff-item.removed::before { background: var(--accent-red); }
  .change-symbol {
    display: grid;
    place-items: center;
    flex: 0 0 26px;
    width: 26px;
    height: 26px;
    margin-top: 1px;
    border-radius: 6px;
    font-family: var(--font-mono);
    font-size: 16px;
    font-weight: 800;
  }
  .created .change-symbol { color: var(--accent-green); background: rgba(63, 185, 80, 0.12); }
  .updated .change-symbol { color: var(--accent-yellow); background: rgba(210, 153, 34, 0.13); }
  .removed .change-symbol { color: var(--accent-red); background: rgba(248, 81, 73, 0.12); }
  .change-copy { min-width: 0; flex: 1; }
  .change-primary { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .change-primary .name {
    min-width: 0;
    overflow: hidden;
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: var(--font-size-md);
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .action {
    flex: 0 0 auto;
    padding: 2px 7px;
    border: 1px solid currentColor;
    border-radius: 10px;
    font-size: var(--font-size-xs);
    font-weight: 700;
    letter-spacing: 0.04em;
  }
  .created .action { color: var(--accent-green); background: rgba(63, 185, 80, 0.08); }
  .updated .action { color: var(--accent-yellow); background: rgba(210, 153, 34, 0.08); }
  .removed .action { color: var(--accent-red); background: rgba(248, 81, 73, 0.08); }
  .change-meta { display: flex; gap: 8px; margin-top: 4px; color: var(--text-muted); font-size: var(--font-size-xs); }
  .change-meta .resource::after { content: '·'; margin-left: 8px; color: var(--border-color); }
  .change-meta .resource:only-child::after { display: none; }
  .msg { overflow-wrap: anywhere; }
  .no-changes {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 30px 20px;
    border: 1px dashed var(--border-color);
    border-radius: 8px;
    text-align: center;
  }
  .no-changes-icon { display: grid; place-items: center; width: 32px; height: 32px; margin-bottom: 10px; border-radius: 50%; background: rgba(63, 185, 80, 0.12); color: var(--accent-green); }
  .no-changes strong { color: var(--text-primary); font-size: var(--font-size-md); }
  .no-changes p { margin: 5px 0 0; color: var(--text-muted); font-size: var(--font-size-sm); }
  .unchanged-section { margin-top: 14px; border: 1px solid var(--border-color); border-radius: 8px; overflow: hidden; }
  .unchanged-toggle {
    display: flex;
    justify-content: space-between;
    align-items: center;
    width: 100%;
    padding: 11px 13px;
    border: 0;
    background: rgba(13, 17, 23, 0.35);
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    text-align: left;
  }
  .unchanged-toggle:hover { background: var(--bg-tertiary); color: var(--text-primary); }
  .unchanged-toggle i { margin-right: 6px; color: var(--text-muted); font-style: normal; }
  .toggle-meta { color: var(--text-muted); font-family: var(--font-mono); font-size: var(--font-size-xs); }
  .toggle-meta b { display: inline-block; margin-left: 6px; font-size: 14px; transition: transform 160ms ease; }
  .toggle-meta b.expanded { transform: rotate(180deg); }
  .unchanged-list { padding: 5px 13px 9px; border-top: 1px solid var(--border-color); background: rgba(13, 17, 23, 0.48); }
  .unchanged-item { display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 12px; padding: 6px 0; color: var(--text-muted); font-size: var(--font-size-xs); }
  .unchanged-item .name { overflow: hidden; font-family: var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }
  .diff-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 13px 26px;
    border-top: 1px solid var(--border-color);
    background: rgba(13, 17, 23, 0.7);
  }
  .diff-footer > span { color: var(--text-muted); font-size: var(--font-size-xs); }
  .diff-footer > span::before { content: '●'; margin-right: 7px; color: var(--accent-green); font-size: 7px; }
  .diff-footer .btn { min-width: 72px; }
  .build-section { margin-top:18px }.build-mode { display:flex;gap:9px;padding:11px 12px;border:1px solid var(--border-color);background:rgba(13,17,23,.48);cursor:pointer }
  .build-mode.selected { border-color:rgba(63,185,80,.5);background:rgba(63,185,80,.06) }.build-mode>span { display:flex;flex-direction:column }.build-mode strong { color:var(--text-primary);font-size:var(--font-size-sm) }.build-mode small { margin-top:2px;color:var(--text-muted);font-size:var(--font-size-xs) }.build-mode:first-of-type { border-radius:7px 7px 0 0 }.build-mode.skip { border-radius:0 0 7px 7px }
  .build-plan-error { margin-top:7px;color:var(--accent-red);font-size:var(--font-size-xs) }
  .build-options { margin:10px 0;padding:9px 11px;border:1px solid var(--border-color);border-radius:6px;color:var(--text-muted);font-size:var(--font-size-xs) }.build-options>strong { color:var(--text-secondary);font-size:var(--font-size-xs) }.build-options div { display:flex;gap:16px;margin-top:7px }.build-options label { display:flex;align-items:center;gap:5px }.build-side-effect { margin:10px 0 0;padding-left:9px;border-left:2px solid var(--accent-yellow);color:var(--accent-yellow);font-size:var(--font-size-xs) }
  .build-progress-list { border:1px solid var(--border-color);border-radius:7px;overflow:hidden }.build-result { display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid var(--border-color);background:rgba(13,17,23,.48) }.build-result>span:nth-child(2) { display:flex;flex:1;flex-direction:column }.build-result strong { color:var(--text-primary);font-size:var(--font-size-sm) }.build-result small { color:var(--text-muted);font:var(--font-size-xs) var(--font-mono) }.build-result em { color:var(--text-muted);font-size:var(--font-size-xs);font-style:normal }.result-symbol { width:18px;color:var(--accent-yellow);text-align:center }.build-result.failed .result-symbol,.build-result.failed em { color:var(--accent-red) }
  .build-log { max-height:150px;padding:9px 12px;overflow:auto;border-bottom:1px solid var(--border-color);background:#070a0e;font:var(--font-size-xs)/1.6 var(--font-mono) }.build-log div { display:grid;grid-template-columns:70px 1fr;gap:8px }.build-log b { color:var(--accent-blue) }.build-log span { color:var(--text-secondary);overflow-wrap:anywhere }.log-error,.build-error { color:var(--accent-red) }.build-error { margin-top:9px;padding:9px;border:1px solid rgba(248,81,73,.35);border-radius:5px;background:rgba(248,81,73,.07);font-size:var(--font-size-xs) }
  @keyframes diff-fade-in { from { opacity: 0; } }
  @keyframes diff-panel-in { from { opacity: 0; transform: translateY(10px) scale(0.985); } }
  @media (max-width: 560px) {
    .diff-overlay { align-items: flex-end; padding: 0; }
    .diff-panel { width: 100%; max-height: 92vh; border-radius: 12px 12px 0 0; }
    .diff-header { padding: 20px 18px 17px; }
    .diff-summary { margin: 14px 18px 0; }
    .summary-total { min-width: 90px; padding: 10px 14px; }
    .summary-stat { flex-direction: column; gap: 2px; height: 46px; }
    .diff-content { padding: 17px 18px 20px; }
    .diff-footer { padding: 12px 18px; }
    .unchanged-item { grid-template-columns: 100px minmax(0, 1fr); }
  }
  @media (prefers-reduced-motion: reduce) {
    .diff-overlay, .diff-panel { animation: none; }
  }
</style>
