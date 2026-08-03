<script lang="ts">
  import { onMount } from 'svelte';
  import * as Dialog from '$lib/components/ui/dialog';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Textarea } from '$lib/components/ui/textarea';
  import CodeEditor from '$lib/components/code-editor.svelte';
  import AgentEnvironmentEditor from '$lib/components/agent-environment-editor.svelte';
  import AutomationCollection from '../components/AutomationCollection.svelte';
  import PageHeader from '$lib/components/page-header.svelte';
  import PageContent from '$lib/components/page-content.svelte';
  import TechnicalDetails from '$lib/components/technical-details.svelte';
  import { preloadMonaco } from '$lib/monaco';
  import { navigate, router } from '$lib/router.svelte';
  import { listAgentDefinitions, type AgentDefinition } from '../api/agents';
  import {
    getAutomationTask,
    listAutomationTasks,
    previewAutomationTask,
    previewDeleteAutomationTask,
    runAutomationTaskNow,
    setAutomationTaskEnabled,
    validateAutomationTask,
    type AutomationTask,
    type AutomationTaskDetail,
    type SaveAutomationTaskInput,
  } from '../api/loaders';
  import {
    applyProjectPreview,
    listProjectViews,
    type ProjectDeploymentPreview,
    type ProjectView,
  } from '../api/projects';
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import FolderKanban from '@lucide/svelte/icons/folder-kanban';
  import Play from '@lucide/svelte/icons/play';
  import Plus from '@lucide/svelte/icons/plus';
  import { t } from '$lib/i18n.svelte';
  import { presentProjectChanges, triggerKindLabel, validationPathLabel } from '../model/presentation';
  import { validateAgentEnvironment } from '../model/agent-environment';

  type Draft = SaveAutomationTaskInput;

  const emptyDraft = (): Draft => ({
    name: '',
    description: '',
    runtime: 'scheduler',
    script: '',
    workspaceId: '',
    driver: 'docker',
    guestImage: '',
    agentId: '',
    capsetIds: [],
    defaultAgent: '',
    sessionPolicy: 'new_session',
    concurrencyPolicy: 'skip',
    enabled: true,
    envItems: [],
    triggers: [],
  });

  let tasks = $state<AutomationTask[]>([]);
  let agents = $state<AgentDefinition[]>([]);
  let projects = $state<ProjectView[]>([]);
  let draft = $state<Draft>(emptyDraft());
  let loading = $state(true);
  let saving = $state(false);
  let error = $state('');
  let validation = $state<{ valid: boolean; warnings: string[] } | null>(null);
  let preview = $state<ProjectDeploymentPreview | null>(null);
  let runTask = $state<AutomationTaskDetail | null>(null);
  let runTriggerId = $state('');
  let runPayload = $state('{}');
  let splitContainer = $state<HTMLDivElement>();
  let configPaneWidth = $state(420);
  let resizingConfigPane = $state(false);
  let draftBaseline = $state('');

  const CONFIG_PANE_WIDTH_KEY = 'ac.automationConfigPaneWidth';
  const DEFAULT_CONFIG_PANE_WIDTH = 420;
  const MIN_CONFIG_PANE_WIDTH = 340;
  const MIN_EDITOR_PANE_WIDTH = 420;

  const parts = $derived(router.path.split('/').filter(Boolean));
  const taskId = $derived(parts[1] && parts[1] !== 'new' ? decodeURIComponent(parts[1]) : '');
  const editing = $derived(parts[1] === 'new' || parts[2] === 'edit');
  const creating = $derived(parts[1] === 'new');
  const draftDirty = $derived(editing && draftSignature() !== draftBaseline);
  const presentedChanges = $derived(preview ? presentProjectChanges(preview.changes) : []);
  const availableAgents = $derived(
    agents.filter(
      (agent) =>
        (taskId || !tasks.some((task) => task.projectId === agent.projectId && task.agentName === agent.agentName)) &&
        projects.find((project) => project.projectId === agent.projectId)?.editable,
    ),
  );
  const selectedDraftAgent = $derived(
    agents.find(
      (agent) =>
        agent.id === draft.agentId ||
        (agent.agentName === draft.agentId &&
          (!taskId || agent.projectId === tasks.find((task) => task.id === taskId)?.projectId)),
    ),
  );

  onMount(async () => {
    await load();
    const params = new URLSearchParams(window.location.search);
    const contextProject = params.get('project');
    const contextAgent = params.get('agent');
    if (creating && contextProject && contextAgent) {
      const agent = agents.find((item) => item.projectId === contextProject && item.agentName === contextAgent);
      if (agent) draft.agentId = agent.id;
    } else if (editing && taskId) {
      await loadDraft(taskId);
    }
  });

  onMount(() => {
    const stored = Number(localStorage.getItem(CONFIG_PANE_WIDTH_KEY));
    if (Number.isFinite(stored) && stored > 0) configPaneWidth = stored;
    const onResize = () => {
      if (splitContainer) configPaneWidth = clampConfigPaneWidth(configPaneWidth);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  });

  $effect(() => {
    if (!editing) return;
    const removeGuard = router.setNavigationGuard(() => !draftDirty || window.confirm(t('放弃未保存的更改？')));
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!draftDirty) return;
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
      [tasks, agents, projects] = await Promise.all([
        listAutomationTasks(),
        listAgentDefinitions(),
        listProjectViews(),
      ]);
    } catch (cause) {
      error = errorMessage(cause);
    } finally {
      loading = false;
    }
  }

  async function loadDraft(id: string): Promise<void> {
    try {
      draft = draftFromDetail(await getAutomationTask(id));
      draftBaseline = draftSignature();
    } catch (cause) {
      error = errorMessage(cause);
    }
  }

  async function beginEdit(id: string): Promise<void> {
    await loadDraft(id);
    navigate(`/automations/${encodeURIComponent(id)}/edit`);
  }

  function beginCreate(): void {
    draft = emptyDraft();
    draftBaseline = draftSignature();
    validation = null;
    navigate('/automations/new');
  }

  async function validate(): Promise<boolean> {
    error = '';
    try {
      const result = await validateAutomationTask(draft.script, draft.runtime);
      validation = { valid: true, warnings: result.warnings };
      return true;
    } catch (cause) {
      validation = { valid: false, warnings: [] };
      error = errorMessage(cause);
      return false;
    }
  }

  async function save(): Promise<void> {
    if (!draft.name.trim()) {
      error = t('任务名称必填');
      return;
    }
    if (!draft.agentId) {
      error = t('请选择绑定智能体');
      return;
    }
    const environmentError = validateAgentEnvironment(draft.envItems ?? []);
    if (environmentError) {
      error = t(environmentError);
      return;
    }
    saving = true;
    error = '';
    try {
      if (!(await validate())) return;
      preview = await previewAutomationTask({ ...draft, id: creating ? undefined : taskId });
    } catch (cause) {
      error = errorMessage(cause);
    } finally {
      saving = false;
    }
  }

  async function applyPreview(): Promise<void> {
    if (!preview?.deployable) return;
    saving = true;
    error = '';
    try {
      await applyProjectPreview(preview.previewId);
      preview = null;
      await load();
      draftBaseline = draftSignature();
      navigate('/automations');
    } catch (cause) {
      error = errorMessage(cause);
    } finally {
      saving = false;
    }
  }

  async function prepareRun(task: AutomationTask): Promise<void> {
    error = '';
    try {
      runTask = await getAutomationTask(task.id);
      runTriggerId = runTask.triggers.find((trigger) => trigger.enabled)?.triggerId ?? '';
      runPayload = '{}';
    } catch (cause) {
      error = errorMessage(cause);
    }
  }

  async function runNow(): Promise<void> {
    if (!runTask || !runTriggerId) return;
    saving = true;
    error = '';
    try {
      JSON.parse(runPayload);
      const run = await runAutomationTaskNow(runTask.id, runPayload, runTriggerId);
      runTask = null;
      navigate(`/automation-runs/${encodeURIComponent(run.id)}`);
    } catch (cause) {
      error = errorMessage(cause);
    } finally {
      saving = false;
    }
  }

  async function toggle(task: AutomationTask): Promise<void> {
    try {
      await setAutomationTaskEnabled(task.id, !task.enabled);
      await load();
    } catch (cause) {
      error = errorMessage(cause);
    }
  }

  async function remove(task: AutomationTask): Promise<void> {
    try {
      preview = await previewDeleteAutomationTask(task.id);
    } catch (cause) {
      error = errorMessage(cause);
    }
  }

  function startConfigPaneResize(event: PointerEvent): void {
    if (window.innerWidth < 1024) return;
    event.preventDefault();
    resizingConfigPane = true;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function resizeConfigPane(event: PointerEvent): void {
    if (!resizingConfigPane || !splitContainer) return;
    const bounds = splitContainer.getBoundingClientRect();
    configPaneWidth = clampConfigPaneWidth(event.clientX - bounds.left);
  }

  function finishConfigPaneResize(event: PointerEvent): void {
    if (!resizingConfigPane) return;
    resizingConfigPane = false;
    const handle = event.currentTarget as HTMLElement;
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    localStorage.setItem(CONFIG_PANE_WIDTH_KEY, String(Math.round(configPaneWidth)));
  }

  function resetConfigPaneWidth(): void {
    configPaneWidth = clampConfigPaneWidth(DEFAULT_CONFIG_PANE_WIDTH);
    localStorage.setItem(CONFIG_PANE_WIDTH_KEY, String(Math.round(configPaneWidth)));
  }

  function resizeConfigPaneWithKeyboard(event: KeyboardEvent): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home') return;
    event.preventDefault();
    const nextWidth =
      event.key === 'Home' ? DEFAULT_CONFIG_PANE_WIDTH : configPaneWidth + (event.key === 'ArrowLeft' ? -24 : 24);
    configPaneWidth = clampConfigPaneWidth(nextWidth);
    localStorage.setItem(CONFIG_PANE_WIDTH_KEY, String(Math.round(configPaneWidth)));
  }

  function clampConfigPaneWidth(value: number): number {
    const availableWidth = splitContainer?.getBoundingClientRect().width || window.innerWidth;
    return Math.min(
      Math.max(value, MIN_CONFIG_PANE_WIDTH),
      Math.max(MIN_CONFIG_PANE_WIDTH, availableWidth - MIN_EDITOR_PANE_WIDTH - 16),
    );
  }

  function draftFromDetail(task: AutomationTaskDetail): Draft {
    return {
      id: task.id,
      name: task.name,
      description: task.description,
      runtime: task.runtime,
      script: task.script,
      workspaceId: task.workspaceId,
      driver: task.driver,
      guestImage: task.guestImage,
      agentId:
        agents.find((agent) => agent.projectId === task.projectId && agent.agentName === task.agentName)?.id ??
        task.agentId,
      capsetIds: task.capsetIds,
      defaultAgent: task.defaultAgent,
      sessionPolicy: task.sessionPolicy,
      concurrencyPolicy: task.concurrencyPolicy,
      enabled: task.enabled,
      envItems: task.envItems,
      triggers: task.configuredTriggers,
    };
  }

  function draftSignature(): string {
    return JSON.stringify(draft);
  }

  const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : t('请求失败'));
</script>

<div
  data-page-layout={editing ? 'editor' : 'document'}
  class={editing ? 'flex min-h-full flex-col lg:h-full lg:min-h-0 lg:overflow-hidden' : 'min-h-full'}
>
  <PageHeader title="自动化" description="管理自动化与执行结果">
    {#snippet actions()}
      {#if !editing}
        <Button size="sm" onpointerenter={preloadMonaco} onfocus={preloadMonaco} onclick={beginCreate}>
          <Plus class="size-3.5" />
          {t('配置自动化')}
        </Button>
      {/if}
    {/snippet}
  </PageHeader>

  {#if error}
    <div class="mx-4 mt-3 shrink-0 rounded-md bg-destructive/10 p-3 text-sm text-destructive sm:mx-5 xl:mx-6">
      {error}
    </div>
  {/if}

  {#if editing}
    <PageContent class="flex min-h-0 flex-1 flex-col lg:overflow-hidden">
      <form
        class="flex min-h-0 w-full flex-col gap-4 lg:h-full"
        onsubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div
          class="sticky top-0 z-20 flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border bg-background/95 py-3 backdrop-blur lg:static lg:border-b-0 lg:py-0"
        >
          <div>
            <h2 class="font-semibold">{t(creating ? '配置智能体自动化' : '编辑自动化')}</h2>
            <p class="mt-1 text-xs text-muted-foreground">{t('保存前预览项目变更')}</p>
          </div>
          <div class="flex gap-2">
            <Button type="button" variant="outline" onclick={() => navigate('/automations')}>{t('取消')}</Button>
            <Button type="button" variant="outline" onclick={validate}>{t('校验')}</Button>
            <Button type="submit" disabled={saving}>{t(saving ? '正在生成预览…' : '预览部署')}</Button>
          </div>
        </div>
        <div
          bind:this={splitContainer}
          class="grid min-h-0 flex-1 gap-4 lg:grid-cols-[var(--automation-config-width)_1rem_minmax(0,1fr)] lg:gap-0 lg:overflow-hidden {resizingConfigPane
            ? 'select-none'
            : ''}"
          style={`--automation-config-width: ${configPaneWidth}px`}
        >
          <section
            data-scroll-pane
            class="space-y-4 rounded-lg border border-border bg-card p-4 lg:mr-2 lg:min-h-0 lg:overflow-y-auto"
          >
            <label class="block space-y-1">
              <span class="text-sm">{t('所属项目 / 智能体')}</span>
              <select
                class="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm"
                bind:value={draft.agentId}
                disabled={!creating}
              >
                <option value="">{t('请选择')}</option>
                {#each availableAgents as agent (agent.id)}
                  <option value={agent.id}>{agent.projectName} / {agent.name}</option>
                {/each}
              </select>
            </label>
            {#if selectedDraftAgent}
              <button
                type="button"
                class="flex w-full items-center justify-between rounded-md bg-muted p-3 text-left text-xs"
                onclick={() =>
                  navigate(
                    `/projects/${selectedDraftAgent.projectId}/agents/${encodeURIComponent(selectedDraftAgent.agentName)}`,
                  )}
              >
                <span
                  ><FolderKanban class="mr-1 inline size-3.5" />{selectedDraftAgent.projectName} / {selectedDraftAgent.name}</span
                >
                <ArrowRight class="size-3.5" />
              </button>
            {/if}
            <div class="border-t border-border pt-4">
              <h3 class="text-sm font-medium">{t('基本信息')}</h3>
            </div>
            <label class="block space-y-1"
              ><span class="text-sm">{t('名称')}</span><Input bind:value={draft.name} /></label
            >
            <label class="block space-y-1"
              ><span class="text-sm">{t('描述')}</span><Textarea bind:value={draft.description} /></label
            >
            <div class="border-t border-border pt-4">
              <h3 class="text-sm font-medium">{t('执行策略')}</h3>
            </div>
            <label class="block space-y-1">
              <span class="text-sm">{t('会话策略')}</span>
              <select
                class="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm"
                bind:value={draft.sessionPolicy}
              >
                <option value="new_session">{t('每次新建执行环境')}</option>
                <option value="sticky">{t('复用固定执行环境')}</option>
              </select>
            </label>
            <label class="block space-y-1">
              <span class="text-sm">{t('并发策略')}</span>
              <select
                class="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm"
                bind:value={draft.concurrencyPolicy}
              >
                <option value="skip">{t('忙碌时跳过')}</option>
                <option value="parallel">{t('允许并行')}</option>
              </select>
            </label>
            <label class="flex items-center gap-2 text-sm"
              ><input type="checkbox" bind:checked={draft.enabled} /> {t('启用自动化')}</label
            >
            <AgentEnvironmentEditor
              bind:items={draft.envItems}
              title="所属智能体环境变量"
              description="保存时会同时更新智能体配置"
              layout="stacked"
              class="border-t border-border pt-4"
            />
          </section>
          <button
            type="button"
            class="group hidden h-full cursor-col-resize touch-none items-center justify-center lg:flex"
            aria-label={t('调整配置栏宽度')}
            title={t('拖动调整配置栏宽度，双击恢复默认')}
            onpointerdown={startConfigPaneResize}
            onpointermove={resizeConfigPane}
            onpointerup={finishConfigPaneResize}
            onpointercancel={finishConfigPaneResize}
            ondblclick={resetConfigPaneWidth}
            onkeydown={resizeConfigPaneWithKeyboard}
          >
            <span
              class="h-12 w-1 rounded-full bg-border transition-colors group-hover:bg-primary/60 group-focus-visible:bg-primary"
            ></span>
          </button>
          <section class="flex min-h-[32rem] flex-col lg:ml-2 lg:min-h-[24rem]">
            <div class="mb-2 flex shrink-0 flex-wrap items-center justify-between gap-2 text-sm">
              <span class="font-medium">{t('自动化脚本（JavaScript）')}</span>
              {#if validation}<span
                  class="rounded-full px-2 py-0.5 text-xs {validation.valid
                    ? 'bg-success/10 text-success'
                    : 'bg-destructive/10 text-destructive'}"
                  >{t(validation.valid ? '脚本校验通过' : '脚本校验失败')}{#if validation.warnings.length}
                    · {validation.warnings.length} {t('条提示')}{/if}</span
                >{/if}
            </div>
            <div class="min-h-0 flex-1">
              <CodeEditor
                bind:value={draft.script}
                language="javascript"
                height="100%"
                title={t('自动化脚本')}
                onChange={() => (validation = null)}
              />
            </div>
          </section>
        </div>
      </form>
    </PageContent>
  {:else}
    <AutomationCollection
      {tasks}
      {agents}
      {projects}
      {loading}
      onRun={prepareRun}
      onEdit={(task) => beginEdit(task.id)}
      onToggle={toggle}
      onRemove={remove}
    />
  {/if}
</div>

<Dialog.Root open={Boolean(preview)} onOpenChange={(open) => !open && !saving && (preview = null)}>
  <Dialog.Content class="sm:max-w-xl" showCloseButton={!saving}>
    <Dialog.Header
      ><Dialog.Title>{t('项目部署预览')}</Dialog.Title><Dialog.Description
        >{preview?.projectName} · {t('部署后创建新版本')}</Dialog.Description
      ></Dialog.Header
    >
    {#if preview}
      <div class="space-y-3">
        {#each presentedChanges as change (change.key)}<div
            class="flex items-center justify-between rounded-md border border-border p-3 text-sm"
          >
            <span>{t(change.resourceLabel)} · {change.name}</span><span class="text-xs text-muted-foreground"
              >{change.actionLabel}</span
            >
          </div>{/each}
        {#each preview.issues as issue (`${issue.path}:${issue.message}`)}<p
            class="rounded-md bg-warning/10 p-3 text-sm"
          >
            {t(validationPathLabel(issue.path))}：{issue.message}
          </p>{/each}
        {#if !preview.deployable}<p class="text-sm text-muted-foreground">{t('没有可部署的变更')}</p>{/if}
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
          </div>
        </TechnicalDetails>
      </div>
    {/if}
    <Dialog.Footer
      ><Button variant="outline" disabled={saving} onclick={() => (preview = null)}>{t('取消')}</Button><Button
        disabled={saving || !preview?.deployable}
        onclick={applyPreview}>{t(saving ? '部署中…' : '确认部署项目')}</Button
      ></Dialog.Footer
    >
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root open={Boolean(runTask)} onOpenChange={(open) => !open && !saving && (runTask = null)}>
  <Dialog.Content class="sm:max-w-lg" showCloseButton={!saving}>
    <Dialog.Header
      ><Dialog.Title>{t('运行自动化')}</Dialog.Title><Dialog.Description
        >{runTask?.name} · {t('选择触发条件和输入数据')}</Dialog.Description
      ></Dialog.Header
    >
    {#if runTask}<div class="space-y-4">
        <label class="block space-y-1"
          ><span class="text-sm">{t('触发条件')}</span><select
            class="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm"
            bind:value={runTriggerId}
            >{#each runTask.triggers as trigger (trigger.triggerId)}<option
                value={trigger.triggerId}
                disabled={!trigger.enabled}
                >{trigger.name || trigger.triggerId} · {t(triggerKindLabel(trigger.kind))}{trigger.enabled
                  ? ''
                  : ` · ${t('已停用')}`}</option
              >{/each}</select
          ></label
        ><label class="block space-y-1"
          ><span class="text-sm">{t('输入数据（JSON）')}</span><Textarea
            class="min-h-32 font-mono"
            bind:value={runPayload}
          /></label
        >{#if !runTask.triggers.some((trigger) => trigger.enabled)}<p class="text-sm text-warning">
            {t('没有已启用的触发条件')}
          </p>{/if}
      </div>{/if}
    <Dialog.Footer
      ><Button variant="outline" disabled={saving} onclick={() => (runTask = null)}>{t('取消')}</Button><Button
        disabled={saving || !runTriggerId}
        onclick={runNow}><Play class="size-3.5" />{t(saving ? '启动中…' : '开始运行')}</Button
      ></Dialog.Footer
    >
  </Dialog.Content>
</Dialog.Root>
