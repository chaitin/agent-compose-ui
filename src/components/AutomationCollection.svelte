<script lang="ts">
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import CopyableText from '$lib/components/copyable-text.svelte';
  import PageContent from '$lib/components/page-content.svelte';
  import StatusBadge from '$lib/components/status-badge.svelte';
  import Timestamp from '$lib/components/timestamp.svelte';
  import { preloadMonaco } from '$lib/monaco';
  import { navigate } from '$lib/router.svelte';
  import type { AgentDefinition } from '../api/agents';
  import type { AutomationTask } from '../api/loaders';
  import type { ProjectView } from '../api/projects';
  import Play from '@lucide/svelte/icons/play';
  import { t } from '$lib/i18n.svelte';

  let {
    tasks,
    agents,
    project,
    loading,
    onRun,
    onEdit,
    onToggle,
    onRemove,
  }: {
    tasks: AutomationTask[];
    agents: AgentDefinition[];
    project: ProjectView | null;
    loading: boolean;
    onRun: (task: AutomationTask) => void;
    onEdit: (task: AutomationTask) => void;
    onToggle: (task: AutomationTask) => void;
    onRemove: (task: AutomationTask) => void;
  } = $props();

  const params = new URLSearchParams(window.location.search);
  let query = $state(params.get('agent') ?? '');
  let statusFilter = $state<'all' | 'enabled' | 'disabled'>('enabled');

  const enabledCount = $derived(tasks.filter((task) => task.enabled).length);
  const disabledCount = $derived(tasks.length - enabledCount);
  const visibleTasks = $derived(filterTasks(tasks, query, statusFilter));

  function agentForTask(task: AutomationTask): AgentDefinition | undefined {
    return agents.find((agent) => agent.projectId === task.projectId && agent.agentName === task.agentName);
  }

  function taskEditable(task: AutomationTask): boolean {
    return project?.projectId === task.projectId && project.editable;
  }

  function filterTasks(
    items: AutomationTask[],
    value: string,
    status: 'all' | 'enabled' | 'disabled',
  ): AutomationTask[] {
    const normalized = value.trim().toLowerCase();
    return items
      .filter((task) => status === 'all' || task.enabled === (status === 'enabled'))
      .filter((task) => {
        return normalized
          ? `${task.name} ${task.description} ${project?.name ?? ''} ${task.agentName} ${task.id}`
              .toLowerCase()
              .includes(normalized)
          : true;
      })
      .sort(
        (left, right) =>
          Number(right.enabled) - Number(left.enabled) ||
          (agentForTask(left)?.name ?? left.agentName).localeCompare(
            agentForTask(right)?.name ?? right.agentName,
            'zh-CN',
          ) ||
          left.name.localeCompare(right.name, 'zh-CN'),
      );
  }
</script>

<PageContent class="space-y-4">
  <div class="flex flex-col gap-3 rounded-lg border border-border bg-card p-3 lg:flex-row lg:items-center">
    <Input bind:value={query} class="lg:max-w-sm" placeholder={t('搜索项目、智能体、自动化或 ID')} />
    <div class="flex rounded-lg bg-muted p-1 lg:ml-auto" aria-label={t('自动化状态筛选')}>
      {#each [{ value: 'enabled', label: `${t('已启用')} ${enabledCount}` }, { value: 'disabled', label: `${t('已停用')} ${disabledCount}` }, { value: 'all', label: `${t('全部')} ${tasks.length}` }] as option (option.value)}
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
  </div>

  <div class="hidden overflow-hidden rounded-lg border border-border bg-card min-[1400px]:block">
    <table class="w-full table-fixed text-sm">
      <thead class="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
        <tr>
          <th class="w-[26%] px-4 py-3 font-medium">{t('项目 / 智能体')}</th>
          <th class="w-[24%] px-4 py-3 font-medium">{t('自动化')}</th>
          <th class="w-[10%] px-4 py-3 font-medium">{t('状态')}</th>
          <th class="w-[10%] px-4 py-3 font-medium">{t('触发条件')}</th>
          <th class="w-[16%] px-4 py-3 font-medium">{t('最近运行')}</th>
          <th class="px-4 py-3 text-right font-medium">{t('操作')}</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-border">
        {#each visibleTasks as task (task.id)}
          {@const taskAgent = agentForTask(task)}
          <tr class="align-top hover:bg-muted/20">
            <td class="px-4 py-3">
              <button
                type="button"
                class="max-w-full text-left"
                onclick={() =>
                  navigate(
                    `/projects/${encodeURIComponent(task.projectId)}/agents/${encodeURIComponent(task.agentName)}`,
                  )}
              >
                <div class="truncate font-medium">{project?.name || task.projectId.slice(0, 8)}</div>
                <div class="truncate text-xs text-muted-foreground">{taskAgent?.name || task.agentName}</div>
              </button>
            </td>
            <td class="px-4 py-3">
              <div class="truncate font-medium">{task.name}</div>
              <div class="mt-1">
                <CopyableText
                  value={task.id}
                  display={task.id.slice(0, 12)}
                  label="自动化 ID"
                  class="font-mono text-[11px] text-muted-foreground"
                />
              </div>
              {#if task.lastError}<p class="mt-1 line-clamp-2 text-xs text-destructive">{task.lastError}</p>{/if}
            </td>
            <td class="px-4 py-3">
              <StatusBadge status={task.enabled ? 'enabled' : 'disabled'} label={task.enabled ? '已启用' : '已停用'} />
            </td>
            <td class="px-4 py-3">{task.triggerCount}</td>
            <td class="px-4 py-3">
              <Timestamp value={task.latestRunAt} empty={t('未运行')} />
              <div class="mt-1 text-xs text-muted-foreground">{task.runCount} {t('次运行')}</div>
            </td>
            <td class="px-4 py-3">
              <div class="flex justify-end gap-1">
                <Button size="sm" onclick={() => onRun(task)}><Play class="size-3.5" />{t('运行')}</Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!taskEditable(task)}
                  onpointerenter={preloadMonaco}
                  onclick={() => onEdit(task)}>{t('编辑')}</Button
                >
                <Button size="sm" variant="ghost" onclick={() => onToggle(task)}
                  >{t(task.enabled ? '停用' : '启用')}</Button
                >
                <Button
                  size="sm"
                  variant="ghost"
                  class="text-destructive"
                  disabled={!taskEditable(task)}
                  onclick={() => onRemove(task)}>{t('删除')}</Button
                >
              </div>
            </td>
          </tr>
        {:else}
          <tr>
            <td colspan="6" class="px-4 py-12 text-center text-sm text-muted-foreground">
              {t(loading ? '正在加载…' : tasks.length ? '没有匹配的自动化' : '还没有自动化')}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  <div class="grid gap-3 sm:grid-cols-2 min-[1400px]:hidden">
    {#each visibleTasks as task (task.id)}
      {@const taskAgent = agentForTask(task)}
      <article class="rounded-lg border border-border bg-card p-4">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="truncate text-xs text-muted-foreground">
              {project?.name || task.projectId.slice(0, 8)} / {taskAgent?.name || task.agentName}
            </p>
            <h2 class="mt-1 truncate font-medium">{task.name}</h2>
          </div>
          <StatusBadge status={task.enabled ? 'enabled' : 'disabled'} label={task.enabled ? '已启用' : '已停用'} />
        </div>
        <div class="mt-3 flex items-center justify-between text-xs text-muted-foreground">
          <span>{task.triggerCount} {t('个触发条件')}</span><Timestamp value={task.latestRunAt} empty={t('未运行')} />
        </div>
        {#if task.lastError}<p class="mt-2 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
            {task.lastError}
          </p>{/if}
        <div class="mt-4 flex flex-wrap gap-2">
          <Button size="sm" onclick={() => onRun(task)}>{t('运行')}</Button>
          <Button size="sm" variant="outline" disabled={!taskEditable(task)} onclick={() => onEdit(task)}
            >{t('编辑')}</Button
          >
          <Button size="sm" variant="ghost" onclick={() => onToggle(task)}>{t(task.enabled ? '停用' : '启用')}</Button>
          <Button
            size="sm"
            variant="ghost"
            class="text-destructive"
            disabled={!taskEditable(task)}
            onclick={() => onRemove(task)}>{t('删除')}</Button
          >
        </div>
      </article>
    {:else}
      <p class="py-10 text-center text-sm text-muted-foreground">
        {t(loading ? '正在加载…' : tasks.length ? '没有匹配的自动化' : '还没有自动化')}
      </p>
    {/each}
  </div>
</PageContent>
