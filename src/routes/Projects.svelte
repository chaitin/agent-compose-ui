<script lang="ts">
  import { onMount } from 'svelte';
  import * as Dialog from '$lib/components/ui/dialog';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Textarea } from '$lib/components/ui/textarea';
  import PageHeader from '$lib/components/page-header.svelte';
  import AgentEnvironmentEditor from '$lib/components/agent-environment-editor.svelte';
  import StatusBadge from '$lib/components/status-badge.svelte';
  import TechnicalDetails from '$lib/components/technical-details.svelte';
  import { runStreams } from '$lib/run-stream.svelte';
  import { navigate, router } from '$lib/router.svelte';
  import {
    applyProjectPreview,
    listProjectViews,
    previewProjectMutation,
    type AgentEditableSpec,
    type ProjectAgent,
    type ProjectAgentEnv,
    type ProjectDeploymentPreview,
    type ProjectMutation,
    type ProjectView,
  } from '../api/projects';
  import { listCapabilitySets, listWorkspacePresets, type CapabilitySet, type WorkspacePreset } from '../api/config';
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import Bot from '@lucide/svelte/icons/bot';
  import FileCode from '@lucide/svelte/icons/file-code-2';
  import FolderKanban from '@lucide/svelte/icons/folder-kanban';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Play from '@lucide/svelte/icons/play';
  import Plus from '@lucide/svelte/icons/plus';
  import Settings2 from '@lucide/svelte/icons/settings-2';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import { t } from '$lib/i18n.svelte';
  import { presentProjectChanges, validationPathLabel } from '../model/presentation';
  import { validateAgentEnvironment } from '../model/agent-environment';

  type Draft = {
    projectName: string;
    agentName: string;
    displayName: string;
    description: string;
    enabled: boolean;
    provider: string;
    model: string;
    systemPrompt: string;
    image: string;
    driver: string;
    workspaceName: string;
    workspace: Record<string, unknown>;
    stoppedRuntimePolicy: string;
    env: Array<{ name: string; value: string; secret: boolean }>;
    capsetIds: string[];
  };

  const emptyDraft = (): Draft => ({
    projectName: '',
    agentName: '',
    displayName: '',
    description: '',
    enabled: true,
    provider: 'codex',
    model: '',
    systemPrompt: '',
    image: '',
    driver: 'docker',
    workspaceName: '',
    workspace: {},
    stoppedRuntimePolicy: 'remove',
    env: [],
    capsetIds: [],
  });

  let projects = $state<ProjectView[]>([]);
  let workspaces = $state<WorkspacePreset[]>([]);
  let capabilitySets = $state<CapabilitySet[]>([]);
  let query = $state('');
  let loading = $state(true);
  let saving = $state(false);
  let error = $state('');
  let runPrompt = $state('Reply with OK only.');
  let draft = $state<Draft>(emptyDraft());
  let projectVariables = $state<ProjectAgentEnv[]>([]);
  let editorBaseline = $state('');
  let preview = $state<ProjectDeploymentPreview | null>(null);

  const pathParts = $derived(router.path.split('/').filter(Boolean));
  const legacyPath = $derived(pathParts[0] === 'agents');
  const projectID = $derived(pathParts[0] === 'projects' && pathParts[1] && pathParts[1] !== 'new' ? pathParts[1] : '');
  const agentName = $derived(
    pathParts[0] === 'projects' && pathParts[2] === 'agents' && pathParts[3] && pathParts[3] !== 'new'
      ? decodeURIComponent(pathParts[3])
      : '',
  );
  const creatingProject = $derived(router.path === '/projects/new');
  const creatingAgent = $derived(pathParts[2] === 'agents' && pathParts[3] === 'new');
  const editingAgent = $derived(pathParts[2] === 'agents' && pathParts[4] === 'edit');
  const editingProjectVariables = $derived(pathParts[2] === 'settings');
  const editing = $derived(creatingProject || creatingAgent || editingAgent);
  const editorDirty = $derived((editing || editingProjectVariables) && editorSignature() !== editorBaseline);
  const selectedProject = $derived(
    projects.find((project) => project.projectId === projectID) ??
      (router.path === '/projects' ? projects[0] : undefined),
  );
  const selectedAgent = $derived(selectedProject?.agents.find((agent) => agent.agentName === agentName));
  const presentedChanges = $derived(preview ? presentProjectChanges(preview.changes) : []);
  const visibleProjects = $derived(
    projects.filter((project) =>
      query.trim()
        ? `${project.name} ${project.projectId} ${project.agents.map((agent) => agent.displayName).join(' ')}`
            .toLowerCase()
            .includes(query.trim().toLowerCase())
        : true,
    ),
  );
  const assignableWorkspaces = $derived(workspaces.filter((workspace) => workspace.type === 'git'));

  onMount(() => void load());

  $effect(() => {
    if (!editing && !editingProjectVariables) return;
    const removeGuard = router.setNavigationGuard(() => !editorDirty || window.confirm(t('放弃未保存的更改？')));
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!editorDirty) return;
      event.preventDefault();
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      removeGuard();
      window.removeEventListener('beforeunload', beforeUnload);
    };
  });

  async function load(): Promise<void> {
    loading = true;
    error = '';
    try {
      [projects, workspaces, capabilitySets] = await Promise.all([
        listProjectViews(),
        listWorkspacePresets(),
        listCapabilitySets(),
      ]);
      if (legacyPath) {
        redirectLegacyAgent();
        return;
      }
      restoreEditorDraft();
    } catch (cause) {
      error = errorMessage(cause);
    } finally {
      loading = false;
    }
  }

  function redirectLegacyAgent(): void {
    const id = pathParts[1] ? decodeURIComponent(pathParts[1]) : '';
    if (!id) {
      router.replace('/projects');
      return;
    }
    const match = projects
      .flatMap((project) => project.agents.map((agent) => ({ project, agent })))
      .find(({ agent }) => agent.id === id || agent.agentName === id);
    router.replace(
      match
        ? `/projects/${encodeURIComponent(match.project.projectId)}/agents/${encodeURIComponent(match.agent.agentName)}`
        : '/projects',
    );
  }

  function beginProjectCreate(): void {
    draft = emptyDraft();
    projectVariables = [];
    editorBaseline = editorSignature();
    navigate('/projects/new');
  }

  function beginAgentCreate(project: ProjectView): void {
    draft = emptyDraft();
    editorBaseline = editorSignature();
    navigate(`/projects/${encodeURIComponent(project.projectId)}/agents/new`);
  }

  function beginProjectVariableEdit(project: ProjectView): void {
    projectVariables = project.variables.map((item) => ({ ...item }));
    editorBaseline = JSON.stringify(projectVariables);
    navigate(`/projects/${encodeURIComponent(project.projectId)}/settings`);
  }

  function beginAgentEdit(project: ProjectView, agent: ProjectAgent): void {
    populateAgentDraft(project, agent);
    navigate(`/projects/${encodeURIComponent(project.projectId)}/agents/${encodeURIComponent(agent.agentName)}/edit`);
  }

  function populateAgentDraft(project: ProjectView, agent: ProjectAgent): void {
    draft = {
      projectName: project.name,
      agentName: agent.agentName,
      displayName: agent.displayName,
      description: agent.description,
      enabled: agent.enabled,
      provider: agent.provider,
      model: agent.model,
      systemPrompt: agent.systemPrompt,
      image: agent.image,
      driver: stringValue(agent.driver.name) || 'docker',
      workspaceName: stringValue(agent.workspace.name),
      workspace: { ...agent.workspace },
      stoppedRuntimePolicy: agent.stoppedRuntimePolicy || 'remove',
      env: agent.env.map((item) => ({ ...item })),
      capsetIds: [...agent.capsetIds],
    };
    editorBaseline = editorSignature();
  }

  function restoreEditorDraft(): void {
    const project = projects.find((item) => item.projectId === projectID);
    if (!project) return;
    if (editingProjectVariables) {
      projectVariables = project.variables.map((item) => ({ ...item }));
      editorBaseline = JSON.stringify(projectVariables);
      return;
    }
    if (!editingAgent) return;
    const agent = project.agents.find((item) => item.agentName === agentName);
    if (agent) populateAgentDraft(project, agent);
  }

  async function requestPreview(mutation: ProjectMutation): Promise<void> {
    saving = true;
    error = '';
    try {
      preview = await previewProjectMutation(mutation);
    } catch (cause) {
      error = errorMessage(cause);
    } finally {
      saving = false;
    }
  }

  function previewDraft(): void {
    const validationError = validateDraft(draft, selectedProject, creatingProject || creatingAgent);
    if (validationError) {
      error = validationError;
      return;
    }
    const kind: ProjectMutation['kind'] = creatingProject
      ? 'create_project_with_agent'
      : creatingAgent
        ? 'create_agent'
        : 'update_agent';
    void requestPreview({
      kind,
      projectId: selectedProject?.projectId,
      baseSpecHash: selectedProject?.specHash,
      projectName: creatingProject ? draft.projectName.trim() : undefined,
      variables: creatingProject ? projectVariables.map((item) => ({ ...item, name: item.name.trim() })) : undefined,
      agentName: draft.agentName.trim(),
      agent: editableSpec(draft),
    });
  }

  function previewDelete(project: ProjectView, agent: ProjectAgent): void {
    void requestPreview({
      kind: 'delete_agent',
      projectId: project.projectId,
      baseSpecHash: project.specHash,
      agentName: agent.agentName,
    });
  }

  function previewProjectVariables(project: ProjectView): void {
    const environmentError = validateAgentEnvironment(projectVariables);
    if (environmentError) {
      error = t(environmentError);
      return;
    }
    void requestPreview({
      kind: 'update_project_variables',
      projectId: project.projectId,
      baseSpecHash: project.specHash,
      variables: projectVariables.map((item) => ({ ...item, name: item.name.trim() })),
    });
  }

  async function deployPreview(): Promise<void> {
    if (!preview?.deployable) return;
    saving = true;
    error = '';
    const applied = preview;
    try {
      await applyProjectPreview(applied.previewId);
      preview = null;
      await load();
      editorBaseline = editorSignature();
      navigate(
        applied.mutation.kind === 'delete_agent' || applied.mutation.kind === 'update_project_variables'
          ? `/projects/${encodeURIComponent(applied.projectId)}`
          : `/projects/${encodeURIComponent(applied.projectId)}/agents/${encodeURIComponent(applied.mutation.agentName ?? '')}`,
      );
    } catch (cause) {
      preview = null;
      error = errorMessage(cause);
    } finally {
      saving = false;
    }
  }

  async function run(project: ProjectView, agent: ProjectAgent): Promise<void> {
    if (!runPrompt.trim()) {
      error = t('请输入运行任务');
      return;
    }
    saving = true;
    error = '';
    try {
      const stream = await runStreams.start(
        {
          projectId: project.projectId,
          agentName: agent.agentName,
          prompt: runPrompt.trim(),
          driver: stringValue(agent.driver.name),
        },
        (started) => navigate(`/runs/${encodeURIComponent(started.runId)}`),
      );
      if (stream.phase === 'failed' && !stream.runId) error = stream.error;
    } catch (cause) {
      error = errorMessage(cause);
    } finally {
      saving = false;
    }
  }

  function editableSpec(input: Draft): AgentEditableSpec {
    return {
      provider: input.provider.trim(),
      model: input.model.trim(),
      systemPrompt: input.systemPrompt.trim(),
      image: input.image.trim(),
      driver: input.driver.trim() ? { name: input.driver.trim() } : {},
      env: input.env.map((item) => ({ ...item, name: item.name.trim() })).filter((item) => item.name),
      workspace: workspaceSpec(input),
      sandbox: { stoppedRuntimePolicy: input.stoppedRuntimePolicy },
      capsetIds: input.capsetIds.map((item) => item.trim()).filter(Boolean),
      enabled: input.enabled,
      displayName: input.displayName.trim(),
      description: input.description.trim(),
    };
  }

  function workspaceSpec(input: Draft): Record<string, unknown> {
    if (!input.workspaceName) return {};
    if (stringValue(input.workspace.name) === input.workspaceName) return { ...input.workspace };
    const preset = workspaces.find((item) => item.id === input.workspaceName);
    if (!preset) return {};
    const config = jsonObject(preset.configJson);
    if (preset.type !== 'git') return {};
    return {
      name: preset.id,
      provider: 'git',
      url: stringValue(config.url) || stringValue(config.repo_url) || stringValue(config.repoUrl),
      ref: stringValue(config.commit) || stringValue(config.branch),
    };
  }

  function updateCapsets(value: string): void {
    draft.capsetIds = value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function validateDraft(input: Draft, project: ProjectView | undefined, creating: boolean): string {
    if (creatingProject && !input.projectName.trim()) return t('项目名称必填');
    if (creatingProject) {
      const projectEnvironmentError = validateAgentEnvironment(projectVariables);
      if (projectEnvironmentError) return t(projectEnvironmentError);
    }
    if (!/^[a-z][a-z0-9_-]*$/.test(input.agentName.trim()))
      return t('调用标识必须以小写字母开头，仅包含小写字母、数字、- 或 _');
    if (creating && project?.agents.some((agent) => agent.agentName === input.agentName.trim()))
      return t('当前项目已存在同名智能体');
    if (!input.displayName.trim()) return t('显示名称必填');
    if (!input.model.trim()) return t('模型必填');
    if (!input.driver.trim()) return t('运行方式必填');
    const environmentError = validateAgentEnvironment(input.env);
    if (environmentError) return t(environmentError);
    return '';
  }

  function issueIsError(severity: string): boolean {
    return severity.toUpperCase().includes('ERROR');
  }

  function stringValue(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  function jsonObject(value: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(value || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function editorSignature(): string {
    return JSON.stringify(editingProjectVariables ? projectVariables : { draft, projectVariables });
  }

  const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : t('请求失败'));
</script>

<div data-page-layout="master-detail" class="flex min-h-full flex-col lg:h-full lg:min-h-0 lg:overflow-hidden">
  <PageHeader title="项目" description="按项目管理和部署智能体">
    {#snippet actions()}<Button size="sm" onclick={beginProjectCreate}><Plus class="size-3.5" />{t('新建项目')}</Button
      >{/snippet}
  </PageHeader>

  {#if error}<div data-page-error class="mx-auto w-full max-w-[112rem] shrink-0 px-4 pt-3 sm:px-5 xl:px-6">
      <div class="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
    </div>{/if}

  <div
    data-page-frame
    class="mx-auto grid w-full max-w-[112rem] min-w-0 flex-1 px-4 py-4 sm:px-5 lg:min-h-0 lg:grid-cols-[20rem_minmax(0,1fr)] lg:overflow-hidden xl:px-6"
  >
    <aside
      class="min-w-0 flex-col border-b border-border lg:flex lg:min-h-0 lg:border-b-0 lg:border-r {projectID ||
      creatingProject
        ? 'hidden lg:flex'
        : 'flex'}"
    >
      <div class="p-3">
        <Input bind:value={query} placeholder={t('搜索项目或智能体…')} />
      </div>
      <div data-scroll-pane class="px-2 pb-3 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
        {#each visibleProjects as project (project.projectId)}
          <button
            type="button"
            class="mb-1 w-full rounded-md border-l-2 p-2 text-left {project.editable
              ? 'border-l-success'
              : 'border-l-warning'} {project.projectId === selectedProject?.projectId
              ? 'bg-accent'
              : 'hover:bg-accent/60'}"
            onclick={() => navigate(`/projects/${encodeURIComponent(project.projectId)}`)}
          >
            <div class="flex items-center justify-between gap-2">
              <span class="truncate text-sm font-medium">{project.name}</span>
              <span class="shrink-0 text-[11px] text-muted-foreground">{project.agentCount} {t('个智能体')}</span>
            </div>
            <div class="mt-1 truncate text-[11px] text-muted-foreground">{t('版本')} {project.currentRevision}</div>
          </button>
        {:else}
          <p class="p-6 text-sm text-muted-foreground">
            {t(loading ? '正在加载…' : projects.length ? '没有匹配的项目' : '暂无项目')}
          </p>
        {/each}
      </div>
    </aside>

    <main
      data-scroll-pane
      class="min-w-0 p-4 sm:p-5 lg:min-h-0 lg:overflow-y-auto xl:p-6 {projectID || creatingProject
        ? 'block'
        : 'hidden lg:block'}"
    >
      {#if editingProjectVariables && selectedProject}
        <form
          class="mx-auto max-w-4xl space-y-5"
          onsubmit={(event) => {
            event.preventDefault();
            previewProjectVariables(selectedProject);
          }}
        >
          <div
            class="sticky top-0 z-10 flex flex-wrap items-start justify-between gap-3 border-b border-border bg-background/95 py-3 backdrop-blur"
          >
            <div class="flex min-w-0 items-start gap-2">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onclick={() => navigate(`/projects/${encodeURIComponent(selectedProject.projectId)}`)}
                aria-label={t('返回')}><ArrowLeft class="size-4" /></Button
              >
              <div>
                <h2 class="font-semibold">{t('项目环境变量')}</h2>
                <p class="text-sm text-muted-foreground">{selectedProject.name}</p>
              </div>
            </div>
            <div class="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onclick={() => navigate(`/projects/${encodeURIComponent(selectedProject.projectId)}`)}
                >{t('取消')}</Button
              >
              <Button type="submit" disabled={saving}>{t(saving ? '预览中…' : '预览部署')}</Button>
            </div>
          </div>
          <section class="rounded-lg border border-border bg-card p-5">
            <AgentEnvironmentEditor
              bind:items={projectVariables}
              title="项目环境变量"
              description="随项目配置一起部署"
            />
          </section>
        </form>
      {:else if editing}
        <form
          class="mx-auto max-w-4xl space-y-5"
          onsubmit={(event) => {
            event.preventDefault();
            previewDraft();
          }}
        >
          <div
            class="sticky top-0 z-10 flex flex-wrap items-start justify-between gap-3 border-b border-border bg-background/95 py-3 backdrop-blur"
          >
            <div class="flex min-w-0 items-start gap-2">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onclick={() =>
                  navigate(
                    selectedProject ? `/projects/${encodeURIComponent(selectedProject.projectId)}` : '/projects',
                  )}
                aria-label={t('返回')}><ArrowLeft class="size-4" /></Button
              >
              <div>
                <h2 class="font-semibold">
                  {creatingProject
                    ? t('新建项目与首个智能体')
                    : creatingAgent
                      ? t('新增智能体')
                      : `${t('编辑')} ${selectedAgent?.displayName ?? ''}`}
                </h2>
                <p class="text-sm text-muted-foreground">{t('提交前会预览整个项目的部署变更')}</p>
              </div>
            </div>
            <div class="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onclick={() =>
                  navigate(
                    selectedProject ? `/projects/${encodeURIComponent(selectedProject.projectId)}` : '/projects',
                  )}>{t('取消')}</Button
              >
              <Button type="submit" disabled={saving}>{t(saving ? '预览中…' : '预览部署')}</Button>
            </div>
          </div>

          {#if creatingProject}<section class="space-y-5 rounded-lg border border-border bg-card p-5">
              <label class="space-y-1"
                ><span class="text-sm">{t('项目名称')}</span><Input
                  bind:value={draft.projectName}
                  placeholder="my-project"
                /></label
              >
              <AgentEnvironmentEditor
                bind:items={projectVariables}
                title="项目环境变量"
                description="随项目配置一起部署"
                class="border-t border-border pt-4"
              />
            </section>{/if}

          {#if selectedProject && !selectedProject.editable}<div
              class="rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm text-warning-foreground"
            >
              {selectedProject.blockedReasons.join('；')}
            </div>{/if}

          <section class="grid gap-4 rounded-lg border border-border bg-card p-5 md:grid-cols-2">
            <div class="md:col-span-2">
              <h3 class="font-medium">{t('基本信息')}</h3>
            </div>
            <label class="space-y-1"
              ><span class="text-sm">{t('调用标识')}</span><Input
                bind:value={draft.agentName}
                disabled={editingAgent}
                placeholder="my-agent"
              /></label
            >
            <label class="space-y-1"
              ><span class="text-sm">{t('显示名称')}</span><Input bind:value={draft.displayName} /></label
            >
            <label class="space-y-1 md:col-span-2"
              ><span class="text-sm">{t('描述')}</span><Input bind:value={draft.description} /></label
            >
            <label class="flex items-center gap-2 text-sm md:col-span-2"
              ><input type="checkbox" bind:checked={draft.enabled} />{t('启用智能体')}</label
            >
          </section>

          <section class="grid gap-4 rounded-lg border border-border bg-card p-5 md:grid-cols-2">
            <div class="md:col-span-2">
              <h3 class="font-medium">{t('模型配置')}</h3>
            </div>
            <label class="space-y-1"
              ><span class="text-sm">{t('模型服务')}</span><select
                class="h-8 w-full rounded-lg border border-input bg-background px-2 text-sm"
                bind:value={draft.provider}
                ><option>codex</option><option>claude</option><option>gemini</option><option>opencode</option><option
                  >pi</option
                ></select
              ></label
            >
            <label class="space-y-1"><span class="text-sm">{t('模型')}</span><Input bind:value={draft.model} /></label>
            <label class="space-y-1 md:col-span-2"
              ><span class="text-sm">{t('系统提示词')}</span><Textarea
                bind:value={draft.systemPrompt}
                class="min-h-48 resize-y font-mono text-xs"
              /></label
            >
          </section>

          <section class="grid gap-4 rounded-lg border border-border bg-card p-5 md:grid-cols-2">
            <div class="md:col-span-2">
              <h3 class="font-medium">{t('执行环境')}</h3>
            </div>
            <label class="space-y-1"
              ><span class="text-sm">{t('运行方式')}</span><Input bind:value={draft.driver} /></label
            >
            <label class="space-y-1"
              ><span class="text-sm">{t('Guest 镜像')}</span><Input
                bind:value={draft.image}
                placeholder="node:20"
              /></label
            >
            <label class="space-y-1"
              ><span class="text-sm">{t('工作目录')}</span><select
                class="h-8 w-full rounded-lg border border-input bg-background px-2 text-sm"
                bind:value={draft.workspaceName}
                ><option value="">{t('无')}</option>{#each assignableWorkspaces as workspace (workspace.id)}<option
                    value={workspace.id}>{workspace.name}</option
                  >{/each}</select
              ></label
            >
            <label class="space-y-1 md:col-span-2">
              <span class="text-sm">{t('停止后')}</span>
              <select
                class="h-8 w-full rounded-lg border border-input bg-background px-2 text-sm"
                bind:value={draft.stoppedRuntimePolicy}
              >
                <option value="remove">{t('释放运行环境')}</option>
                <option value="retain">{t('保留运行环境')}</option>
              </select>
              <span class="block text-xs text-muted-foreground">
                {t(
                  draft.stoppedRuntimePolicy === 'retain'
                    ? '恢复时继续使用原运行环境'
                    : '恢复时创建新运行环境，工作目录和日志不受影响',
                )}
              </span>
            </label>
          </section>

          <section class="space-y-4 rounded-lg border border-border bg-card p-5">
            <h3 class="font-medium">{t('能力与变量')}</h3>
            <label class="block space-y-1"
              ><span class="text-sm">{t('能力集（逗号分隔）')}</span><Input
                value={draft.capsetIds.join(', ')}
                oninput={(event) => updateCapsets(event.currentTarget.value)}
                list="project-agent-capsets"
              /><datalist id="project-agent-capsets"
                >{#each capabilitySets as set (set.id)}<option value={set.id}>{set.name}</option>{/each}</datalist
              ></label
            >
            <AgentEnvironmentEditor bind:items={draft.env} class="border-t border-border pt-4" />
          </section>
        </form>
      {:else if selectedProject}
        <div class="space-y-5">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="flex min-w-0 items-start gap-2">
              <Button
                variant="ghost"
                size="icon"
                class="lg:hidden"
                onclick={() => navigate('/projects')}
                aria-label={t('返回')}><ArrowLeft class="size-4" /></Button
              >
              <div>
                <div class="flex min-w-0 flex-wrap items-center gap-2">
                  <h2 class="min-w-0 break-words text-base font-semibold sm:text-lg">{selectedProject.name}</h2>
                  <StatusBadge
                    status={selectedProject.editable ? 'enabled' : 'warning'}
                    label={selectedProject.editable ? '可部署' : '只读'}
                  />
                </div>
                <div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>{t('版本')} {selectedProject.currentRevision}</span>
                </div>
              </div>
            </div>
            {#if selectedProject.editable}<div class="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onclick={() => beginProjectVariableEdit(selectedProject)}
                  ><Settings2 class="size-3.5" />{t('项目变量')}
                  {#if selectedProject.variables.length}<span class="text-muted-foreground"
                      >{selectedProject.variables.length}</span
                    >{/if}</Button
                >
                <Button size="sm" onclick={() => beginAgentCreate(selectedProject)}
                  ><Plus class="size-3.5" />{t('新增智能体')}</Button
                >
              </div>{/if}
          </div>

          {#if selectedProject.blockedReasons.length}<div
              class="rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm"
            >
              <div class="font-medium">{t('当前项目只读')}</div>
              <ul class="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
                {#each selectedProject.blockedReasons as reason (reason)}<li>{reason}</li>{/each}
              </ul>
            </div>{/if}

          <div class="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <section class="rounded-lg border border-border bg-card p-4">
              <div class="text-xs text-muted-foreground">{t('智能体')}</div>
              <div class="mt-1 text-lg font-semibold">{selectedProject.agentCount}</div>
            </section>
            <button
              type="button"
              class="rounded-lg border border-border bg-card p-4 text-left transition-colors hover:bg-accent/40"
              onclick={() => navigate(`/automations?project=${encodeURIComponent(selectedProject.projectId)}`)}
            >
              <div class="text-xs text-muted-foreground">{t('自动化任务')}</div>
              <div class="mt-1 text-lg font-semibold">{selectedProject.schedulerCount}</div>
            </button>
            <section class="rounded-lg border border-border bg-card p-4">
              <div class="text-xs text-muted-foreground">{t('运行中')}</div>
              <div class="mt-1 text-lg font-semibold">{selectedProject.runningRunCount}</div>
            </section>
            <section class="rounded-lg border border-border bg-card p-4">
              <div class="text-xs text-muted-foreground">{t('来源')}</div>
              <div class="mt-1 flex items-center gap-1 text-sm font-medium">
                {#if selectedProject.sourcePath}<FileCode class="size-4" />Compose{:else}<FolderKanban
                    class="size-4"
                  />{t('控制台')}{/if}
              </div>
            </section>
          </div>

          {#if selectedProject.sourcePath}<p class="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
              {t('来自 Compose 文件；部署不会修改源文件')}
            </p>{/if}

          <TechnicalDetails
            title="项目标识"
            items={[
              { label: '项目 ID', value: selectedProject.projectId },
              { label: '配置指纹', value: selectedProject.specHash },
              { label: '来源文件', value: selectedProject.sourcePath },
            ]}
          />

          {#if selectedAgent}
            <section class="rounded-lg border border-border bg-card">
              <div class="flex flex-wrap items-start justify-between gap-3 border-b border-border p-4">
                <div class="flex items-start gap-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    onclick={() => navigate(`/projects/${encodeURIComponent(selectedProject.projectId)}`)}
                    aria-label={t('返回项目')}><ArrowLeft class="size-4" /></Button
                  >
                  <div>
                    <div class="flex flex-wrap items-center gap-2">
                      <h3 class="font-semibold">{selectedAgent.displayName}</h3>
                      <StatusBadge
                        status={selectedAgent.enabled ? 'enabled' : 'disabled'}
                        label={selectedAgent.enabled ? '已启用' : '已停用'}
                      />
                    </div>
                    <p class="font-mono text-xs text-muted-foreground">{selectedAgent.agentName}</p>
                  </div>
                </div>
                <div class="flex gap-2">
                  {#if selectedAgent.hasScheduler || selectedProject.editable}<Button
                      variant="outline"
                      size="sm"
                      onclick={() =>
                        navigate(
                          selectedAgent.hasScheduler
                            ? `/automations?project=${encodeURIComponent(selectedProject.projectId)}&agent=${encodeURIComponent(selectedAgent.agentName)}`
                            : `/automations/new?project=${encodeURIComponent(selectedProject.projectId)}&agent=${encodeURIComponent(selectedAgent.agentName)}`,
                        )}>{t(selectedAgent.hasScheduler ? '管理自动化' : '配置自动化')}</Button
                    >{/if}
                  {#if selectedProject.editable}<Button
                      variant="outline"
                      size="sm"
                      onclick={() => beginAgentEdit(selectedProject, selectedAgent)}
                      ><Pencil class="size-3.5" />{t('编辑')}</Button
                    ><Button
                      variant="outline"
                      size="sm"
                      class="text-destructive"
                      onclick={() => previewDelete(selectedProject, selectedAgent)}
                      ><Trash2 class="size-3.5" />{t('删除')}</Button
                    >{/if}
                </div>
              </div>
              <div class="grid gap-6 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,32rem)]">
                <div class="space-y-4">
                  <dl class="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 text-sm">
                    <dt class="text-muted-foreground">{t('模型服务 / 模型')}</dt>
                    <dd>{selectedAgent.provider} · {selectedAgent.model}</dd>
                    <dt class="text-muted-foreground">{t('运行时')}</dt>
                    <dd>{stringValue(selectedAgent.driver.name)} · {selectedAgent.image || t('默认镜像')}</dd>
                    <dt class="text-muted-foreground">{t('工作目录')}</dt>
                    <dd>{stringValue(selectedAgent.workspace.name) || t('无')}</dd>
                    <dt class="text-muted-foreground">{t('停止后')}</dt>
                    <dd>
                      {t(selectedAgent.stoppedRuntimePolicy === 'retain' ? '保留运行环境' : '释放运行环境')}
                    </dd>
                    <dt class="text-muted-foreground">{t('自动化')}</dt>
                    <dd>{selectedAgent.hasScheduler ? t('已配置') : t('未配置')}</dd>
                    <dt class="text-muted-foreground">{t('扩展')}</dt>
                    <dd>
                      MCP {selectedAgent.mcpCount} · Skills {selectedAgent.skillCount}{#if selectedAgent.jupyterEnabled}
                        · Jupyter{/if}
                    </dd>
                  </dl>
                  <TechnicalDetails
                    title="智能体标识"
                    items={[
                      { label: '智能体 ID', value: selectedAgent.id },
                      { label: '调用标识', value: selectedAgent.agentName },
                    ]}
                  />
                </div>
                <div class="space-y-2">
                  <label class="text-sm font-medium" for="project-agent-run-prompt">{t('运行智能体')}</label>
                  <div class="flex gap-2">
                    <Input id="project-agent-run-prompt" bind:value={runPrompt} placeholder={t('输入一次短任务')} />
                    <Button
                      disabled={saving || !selectedAgent.enabled}
                      onclick={() => run(selectedProject, selectedAgent)}><Play class="size-3.5" />{t('运行')}</Button
                    >
                  </div>
                </div>
              </div>
            </section>
          {:else}
            <section class="overflow-hidden rounded-lg border border-border bg-card">
              <div class="border-b border-border px-4 py-3"><h3 class="font-medium">{t('智能体')}</h3></div>
              <div class="divide-y divide-border">
                {#each selectedProject.agents as agent (agent.agentName)}
                  <button
                    type="button"
                    class="flex w-full items-center justify-between gap-3 p-4 text-left hover:bg-accent/50"
                    onclick={() =>
                      navigate(
                        `/projects/${encodeURIComponent(selectedProject.projectId)}/agents/${encodeURIComponent(agent.agentName)}`,
                      )}
                  >
                    <div class="flex min-w-0 items-center gap-3">
                      <div
                        class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
                      >
                        <Bot class="size-4" />
                      </div>
                      <div class="min-w-0">
                        <div class="flex flex-wrap items-center gap-2">
                          <span class="truncate font-medium">{agent.displayName}</span><StatusBadge
                            status={agent.enabled ? 'enabled' : 'disabled'}
                            label={agent.enabled ? '已启用' : '已停用'}
                          />
                        </div>
                        <p class="truncate font-mono text-xs text-muted-foreground">
                          {agent.agentName} · {agent.provider} / {agent.model}
                        </p>
                      </div>
                    </div>
                    <div class="hidden shrink-0 text-right text-xs text-muted-foreground sm:block">
                      {#if agent.hasScheduler}<div>{t('自动化已配置')}</div>{/if}
                      <div>MCP {agent.mcpCount} · Skills {agent.skillCount}</div>
                    </div>
                  </button>
                {:else}
                  <p class="p-8 text-center text-sm text-muted-foreground">{t('当前项目还没有智能体')}</p>
                {/each}
              </div>
            </section>
          {/if}
        </div>
      {:else if !loading && projects.length}
        <div class="flex min-h-64 flex-col items-center justify-center text-center">
          <FolderKanban class="size-10 text-muted-foreground" />
          <h2 class="mt-3 font-semibold">{t('请选择项目')}</h2>
          <p class="mt-1 text-sm text-muted-foreground">{t('从左侧列表选择项目后管理其中的智能体')}</p>
        </div>
      {:else if !loading}
        <div class="flex min-h-64 flex-col items-center justify-center text-center">
          <FolderKanban class="size-10 text-muted-foreground" />
          <h2 class="mt-3 font-semibold">{t('暂无项目')}</h2>
          <p class="mt-1 text-sm text-muted-foreground">{t('创建项目与首个智能体后开始运行')}</p>
          <Button class="mt-4" onclick={beginProjectCreate}><Plus class="size-3.5" />{t('新建项目')}</Button>
        </div>
      {/if}
    </main>
  </div>
</div>

<Dialog.Root open={Boolean(preview)} onOpenChange={(open) => !open && !saving && (preview = null)}>
  <Dialog.Content class="sm:max-w-2xl" showCloseButton={!saving}>
    <Dialog.Header>
      <Dialog.Title>{t('项目部署预览')}</Dialog.Title>
      <Dialog.Description>
        {preview?.projectName} · {t('当前版本')}
        {selectedProject?.currentRevision || '0'} ·
        {t('部署后将创建新的项目版本')}
      </Dialog.Description>
    </Dialog.Header>
    {#if preview}<div class="max-h-[60vh] space-y-4 overflow-y-auto pr-1" data-scroll-surface>
        <section class="space-y-2">
          <h3 class="text-sm font-medium">{t('变更')}</h3>
          {#each presentedChanges as change (change.key)}
            <div class="flex items-start justify-between gap-3 rounded-md border border-border p-3 text-sm">
              <div>
                <div class="font-medium">{change.name}</div>
                <div class="text-xs text-muted-foreground">{t(change.resourceLabel)}</div>
              </div>
              <StatusBadge status={change.status} label={change.actionLabel} />
            </div>
          {:else}<p class="text-sm text-muted-foreground">{t('没有配置变化')}</p>{/each}
        </section>
        {#if preview.issues.length}<section class="space-y-2">
            <h3 class="text-sm font-medium">{t('校验结果')}</h3>
            {#each preview.issues as issue (`${issue.severity}:${issue.path}:${issue.message}`)}<div
                class="rounded-md p-3 text-sm {issueIsError(issue.severity)
                  ? 'bg-destructive/10 text-destructive'
                  : 'bg-warning/10'}"
              >
                <div class="font-medium">{t(validationPathLabel(issue.path))}</div>
                <div class="mt-1 whitespace-pre-wrap">{issue.message}</div>
              </div>{/each}
          </section>{/if}
        <p class="text-xs text-muted-foreground">{t('如果项目在确认前发生变化，本次部署会被拒绝。')}</p>
        <TechnicalDetails
          title="原始变更"
          items={[
            { label: '当前配置指纹', value: preview.baseSpecHash },
            { label: '候选配置指纹', value: preview.candidateSpecHash },
          ]}
        >
          <div class="space-y-1">
            {#each presentedChanges as change (change.key)}
              <div class="break-all font-mono">{change.rawAction} · {change.rawTypes.join(', ')}</div>
            {/each}
            {#each preview.issues.filter((issue) => issue.path) as issue (`raw:${issue.path}:${issue.message}`)}
              <div class="break-all font-mono">{issue.path}</div>
            {/each}
          </div>
        </TechnicalDetails>
      </div>{/if}
    <Dialog.Footer>
      <Button variant="outline" disabled={saving} onclick={() => (preview = null)}>{t('取消')}</Button>
      <Button disabled={saving || !preview?.deployable} onclick={() => void deployPreview()}>
        {t(saving ? '部署中…' : '确认部署项目')}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
