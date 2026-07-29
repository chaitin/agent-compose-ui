<script lang="ts">
  import { onMount } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Textarea } from '$lib/components/ui/textarea';
  import CodeEditor from '$lib/components/code-editor.svelte';
  import CopyableText from '$lib/components/copyable-text.svelte';
  import PageHeader from '$lib/components/page-header.svelte';
  import PageContent from '$lib/components/page-content.svelte';
  import StatusBadge from '$lib/components/status-badge.svelte';
  import Timestamp from '$lib/components/timestamp.svelte';
  import { preloadMonaco } from '$lib/monaco';
  import { navigate, router } from '$lib/router.svelte';
  import { listAgentDefinitions, type AgentDefinition } from '../api/agents';
  import {
    deleteAutomationTask,
    getAutomationTask,
    listAutomationTasks,
    runAutomationTaskNow,
    saveAutomationTask,
    setAutomationTaskEnabled,
    validateAutomationTask,
    type AutomationTask,
    type AutomationTaskDetail,
    type SaveAutomationTaskInput,
  } from '../api/loaders';
  import Plus from '@lucide/svelte/icons/plus';
  import { t } from '$lib/i18n.svelte';

  type Draft = SaveAutomationTaskInput & { payload: string };

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
    concurrencyPolicy: 'parallel',
    enabled: true,
    envItems: [],
    triggers: [],
    payload: '{}',
  });

  let tasks = $state<AutomationTask[]>([]);
  let agents = $state<AgentDefinition[]>([]);
  let draft = $state<Draft>(emptyDraft());
  let loading = $state(true);
  let saving = $state(false);
  let error = $state('');
  let validation = $state<{ valid: boolean; warnings: string[] } | null>(null);
  let query = $state('');
  let statusFilter = $state<'all' | 'enabled' | 'disabled'>('enabled');

  const parts = $derived(router.path.split('/').filter(Boolean));
  const taskId = $derived(parts[1] && parts[1] !== 'new' ? decodeURIComponent(parts[1]) : '');
  const editing = $derived(parts[1] === 'new' || parts[2] === 'edit');
  const creating = $derived(parts[1] === 'new');
  const enabledCount = $derived(tasks.filter((task) => task.enabled).length);
  const disabledCount = $derived(tasks.length - enabledCount);
  const visibleTasks = $derived(filterTasks(tasks, query, statusFilter));

  onMount(load);

  async function load(): Promise<void> {
    loading = true;
    error = '';
    try {
      [tasks, agents] = await Promise.all([listAutomationTasks(), listAgentDefinitions()]);
    } catch (cause) {
      error = errorMessage(cause);
    } finally {
      loading = false;
    }
  }

  async function beginEdit(id: string): Promise<void> {
    try {
      draft = draftFromDetail(await getAutomationTask(id));
      navigate(`/automations/${encodeURIComponent(id)}/edit`);
    } catch (cause) {
      error = errorMessage(cause);
    }
  }

  function beginCreate(): void {
    draft = emptyDraft();
    validation = null;
    navigate('/automations/new');
  }

  async function validate(): Promise<boolean> {
    const result = await validateAutomationTask(draft.script, draft.runtime);
    validation = { valid: true, warnings: result.warnings };
    return true;
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
    saving = true;
    error = '';
    try {
      if (!(await validate())) return;
      const saved = await saveAutomationTask({ ...draft, id: creating ? undefined : taskId });
      await load();
      navigate(`/automations/${encodeURIComponent(saved.id)}`);
    } catch (cause) {
      error = errorMessage(cause);
    } finally {
      saving = false;
    }
  }

  async function runNow(task: AutomationTask): Promise<void> {
    try {
      const run = await runAutomationTaskNow(task.id, '{}');
      if (!run.agentRunId) throw new Error('自动化已完成，但没有找到关联的 Agent 运行');
      navigate(`/runs/${encodeURIComponent(run.agentRunId)}`);
    } catch (cause) {
      error = errorMessage(cause);
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
    if (!confirm(`确认删除自动化任务 ${task.name}？`)) return;
    try {
      await deleteAutomationTask(task.id);
      await load();
    } catch (cause) {
      error = errorMessage(cause);
    }
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
      agentId: task.agentId,
      capsetIds: task.capsetIds,
      defaultAgent: task.defaultAgent,
      sessionPolicy: task.sessionPolicy,
      concurrencyPolicy: task.concurrencyPolicy,
      enabled: task.enabled,
      envItems: task.envItems,
      triggers: task.triggers.map((trigger) => ({
        id: trigger.triggerId,
        kind: trigger.kind,
        topic: trigger.topic,
        intervalMs: trigger.intervalMs,
        enabled: trigger.enabled,
        name: trigger.name,
        prompt: trigger.prompt,
      })),
      payload: '{}',
    };
  }

  function filterTasks(
    items: AutomationTask[],
    value: string,
    status: 'all' | 'enabled' | 'disabled',
  ): AutomationTask[] {
    const normalized = value.trim().toLowerCase();
    return items
      .filter((task) => status === 'all' || task.enabled === (status === 'enabled'))
      .filter((task) =>
        normalized
          ? `${task.name} ${task.description} ${task.agentName} ${task.id}`.toLowerCase().includes(normalized)
          : true,
      )
      .sort(
        (left, right) => Number(right.enabled) - Number(left.enabled) || left.name.localeCompare(right.name, 'zh-CN'),
      );
  }

  const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : t('请求失败'));
</script>

<div
  data-page-layout={editing ? 'editor' : 'document'}
  class={editing ? 'flex h-full min-h-0 flex-col overflow-hidden' : 'min-h-full'}
>
  <PageHeader title="自动化任务" description="cron / interval / event / timeout 触发，或 JavaScript 调度脚本">
    {#snippet actions()}{#if !editing}<Button
          size="sm"
          onpointerenter={preloadMonaco}
          onfocus={preloadMonaco}
          onclick={beginCreate}><Plus class="size-3.5" /> {t('新建任务')}</Button
        >{/if}{/snippet}
  </PageHeader>
  {#if error}<div class="mx-4 mt-3 shrink-0 rounded-md bg-destructive/10 p-3 text-sm text-destructive sm:mx-5 xl:mx-6">
      {error}
    </div>{/if}

  {#if editing}
    <PageContent class="flex min-h-0 max-w-6xl flex-1 overflow-hidden">
      <form
        class="flex h-full min-h-0 w-full flex-col gap-4"
        onsubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div class="flex shrink-0 flex-wrap items-center justify-between gap-3">
          <div>
            <h2 class="font-semibold">{t(creating ? '新建自动化任务' : '编辑自动化任务')}</h2>
            {#if validation}<p class="text-sm {validation.valid ? 'text-success' : 'text-destructive'}">
                {validation.valid
                  ? `${t('校验通过')}${validation.warnings.length ? ` · ${validation.warnings.join(' · ')}` : ''}`
                  : t('校验失败')}
              </p>{/if}
          </div>
          <div class="flex gap-2">
            <Button type="button" variant="outline" onclick={() => navigate('/automations')}>{t('取消')}</Button><Button
              type="button"
              variant="outline"
              onclick={validate}>{t('校验')}</Button
            ><Button type="submit" disabled={saving}>{t(saving ? '保存中…' : '保存')}</Button>
          </div>
        </div>
        <div class="grid min-h-0 flex-1 gap-4 lg:grid-cols-[20rem_minmax(0,1fr)] lg:overflow-hidden">
          <section
            data-scroll-pane
            class="space-y-4 rounded-lg border border-border bg-card p-4 lg:min-h-0 lg:overflow-y-auto"
          >
            <label class="block space-y-1"
              ><span class="text-sm">{t('名称')}</span><Input bind:value={draft.name} /></label
            ><label class="block space-y-1"
              ><span class="text-sm">{t('绑定智能体')}</span><select
                class="h-8 w-full rounded-lg border border-input bg-background px-2 text-sm"
                bind:value={draft.agentId}
                ><option value="">{t('请选择')}</option>{#each agents as agent (agent.id)}<option value={agent.id}
                    >{agent.name}</option
                  >{/each}</select
              ></label
            ><label class="block space-y-1"
              ><span class="text-sm">Runtime</span><Input bind:value={draft.runtime} disabled /></label
            ><label class="block space-y-1"
              ><span class="text-sm">Driver</span><Input bind:value={draft.driver} /></label
            ><label class="block space-y-1"
              ><span class="text-sm">{t('Guest 镜像')}</span><Input bind:value={draft.guestImage} /></label
            ><label class="block space-y-1"
              ><span class="text-sm">{t('描述')}</span><Textarea bind:value={draft.description} /></label
            ><label class="flex items-center gap-2 text-sm"
              ><input type="checkbox" bind:checked={draft.enabled} /> {t('启用调度')}</label
            >
          </section>
          <section class="flex min-h-[24rem] flex-col lg:min-h-0">
            <div class="mb-2 shrink-0 text-sm font-medium">Scheduler JavaScript</div>
            <div class="min-h-0 flex-1">
              <CodeEditor bind:value={draft.script} language="javascript" height="100%" title="Scheduler JavaScript" />
            </div>
          </section>
        </div>
      </form>
    </PageContent>
  {:else}
    <PageContent class="space-y-4">
      <div class="flex flex-col gap-3 rounded-lg border border-border bg-card p-3 sm:flex-row sm:items-center">
        <Input bind:value={query} class="sm:max-w-sm" placeholder={t('搜索任务、智能体或任务 ID')} />
        <div class="flex rounded-lg bg-muted p-1" aria-label={t('自动化任务状态筛选')}>
          {#each [{ value: 'all', label: `${t('全部')} ${tasks.length}` }, { value: 'enabled', label: `${t('已启用')} ${enabledCount}` }, { value: 'disabled', label: `${t('已停用')} ${disabledCount}` }] as option}
            <button
              type="button"
              aria-pressed={statusFilter === option.value}
              class="rounded-md px-3 py-1.5 text-xs transition-colors {statusFilter === option.value
                ? 'bg-background font-medium text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'}"
              onclick={() => (statusFilter = option.value as typeof statusFilter)}>{option.label}</button
            >
          {/each}
        </div>
        <span class="text-xs text-muted-foreground sm:ml-auto">{t('已启用任务优先展示')}</span>
      </div>
      <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {#each visibleTasks as task (task.id)}<article
            class="rounded-lg border bg-card p-4 {task.enabled
              ? 'border-success/40 shadow-sm'
              : 'border-border opacity-65'}"
          >
            <div class="flex items-center justify-between">
              <h2 class="font-medium">{task.name}</h2>
              <StatusBadge status={task.enabled ? 'enabled' : 'disabled'} label={task.enabled ? '已启用' : '已停用'} />
            </div>
            <p class="mt-1 text-sm text-muted-foreground">{task.description || `绑定 ${task.agentName}`}</p>
            <dl class="mt-4 grid grid-cols-2 gap-2 text-xs">
              <dt class="text-muted-foreground">{t('任务 ID')}</dt>
              <dd><CopyableText value={task.id} label="任务 ID" class="max-w-full font-mono" /></dd>
              <dt class="text-muted-foreground">{t('触发器')}</dt>
              <dd>{task.triggerCount}</dd>
              <dt class="text-muted-foreground">{t('运行')}</dt>
              <dd>{task.runCount}</dd>
              <dt class="text-muted-foreground">{t('最近')}</dt>
              <dd><Timestamp value={task.latestRunAt} empty={t('未运行')} /></dd>
              <dt class="text-muted-foreground">{t('更新时间')}</dt>
              <dd><Timestamp value={task.updatedAt} /></dd>
            </dl>
            <div class="mt-4 flex flex-wrap gap-2">
              <Button size="sm" onclick={() => runNow(task)}>{t('立即运行')}</Button><Button
                size="sm"
                variant="outline"
                onpointerenter={preloadMonaco}
                onfocus={preloadMonaco}
                onclick={() => beginEdit(task.id)}>{t('编辑')}</Button
              ><Button size="sm" variant="ghost" onclick={() => toggle(task)}
                >{t(task.enabled ? '停用' : '启用')}</Button
              ><Button size="sm" variant="ghost" class="text-destructive" onclick={() => remove(task)}
                >{t('删除')}</Button
              >
            </div>
          </article>{:else}<p class="text-sm text-muted-foreground">
            {t(loading ? '正在加载…' : tasks.length ? '没有匹配的自动化任务' : '还没有自动化任务')}
          </p>{/each}
      </div>
    </PageContent>
  {/if}
</div>
