<script lang="ts">
  import { onMount } from 'svelte';
  import * as Tabs from '$lib/components/ui/tabs';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Textarea } from '$lib/components/ui/textarea';
  import PageHeader from '$lib/components/page-header.svelte';
  import CopyableText from '$lib/components/copyable-text.svelte';
  import StatusBadge from '$lib/components/status-badge.svelte';
  import Timestamp from '$lib/components/timestamp.svelte';
  import { runStreams } from '$lib/run-stream.svelte';
  import { navigate, router } from '$lib/router.svelte';
  import {
    createAgentDefinition,
    deleteAgentDefinition,
    listAgentDefinitions,
    updateAgentDefinition,
    type AgentDefinition,
    type AgentDefinitionInput,
  } from '../api/agents';
  import { listCapabilitySets, listWorkspacePresets, type CapabilitySet, type WorkspacePreset } from '../api/config';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Play from '@lucide/svelte/icons/play';
  import Plus from '@lucide/svelte/icons/plus';
  import Trash2 from '@lucide/svelte/icons/trash-2';

  const emptyDraft = (): AgentDefinitionInput => ({
    agentName: '',
    name: '',
    description: '',
    enabled: true,
    provider: 'codex',
    model: '',
    systemPrompt: '',
    runtimeImageId: '',
    driver: 'docker',
    guestImage: '',
    workspaceId: '',
    envItems: [],
    configJson: '{}',
    capsetIds: [],
  });

  let agents = $state<AgentDefinition[]>([]);
  let workspaces = $state<WorkspacePreset[]>([]);
  let capabilitySets = $state<CapabilitySet[]>([]);
  let query = $state('');
  let statusFilter = $state<'all' | 'enabled' | 'disabled'>('enabled');
  let loading = $state(true);
  let saving = $state(false);
  let error = $state('');
  let runPrompt = $state('Reply with OK only.');
  let draft = $state<AgentDefinitionInput>(emptyDraft());

  const pathParts = $derived(router.path.split('/').filter(Boolean));
  const enabledCount = $derived(agents.filter((agent) => agent.enabled).length);
  const disabledCount = $derived(agents.length - enabledCount);
  const visibleAgents = $derived(filterAgents(agents, query, statusFilter));
  const selectedId = $derived(
    pathParts[1] && pathParts[1] !== 'new' ? decodeURIComponent(pathParts[1]) : visibleAgents[0]?.id,
  );
  const selected = $derived(agents.find((agent) => agent.id === selectedId || agent.agentName === selectedId));
  const editing = $derived(pathParts[1] === 'new' || pathParts[2] === 'edit');
  const creating = $derived(pathParts[1] === 'new');

  onMount(load);

  async function load(): Promise<void> {
    loading = true;
    error = '';
    try {
      [agents, workspaces, capabilitySets] = await Promise.all([
        listAgentDefinitions(),
        listWorkspacePresets(),
        listCapabilitySets(),
      ]);
      const firstAgent = filterAgents(agents, '', statusFilter)[0];
      if (!selected && firstAgent && router.path === '/agents')
        navigate(`/agents/${encodeURIComponent(firstAgent.id)}`);
    } catch (cause) {
      error = errorMessage(cause);
    } finally {
      loading = false;
    }
  }

  function beginCreate(): void {
    draft = emptyDraft();
    navigate('/agents/new');
  }

  function beginEdit(agent: AgentDefinition): void {
    draft = {
      agentName: agent.agentName,
      name: agent.name,
      description: agent.description,
      enabled: agent.enabled,
      provider: agent.provider,
      model: agent.model,
      systemPrompt: agent.systemPrompt,
      runtimeImageId: agent.runtimeImageId,
      driver: agent.driver,
      guestImage: agent.guestImage,
      workspaceId: agent.workspaceId,
      envItems: agent.envItems.map((item) => ({ ...item })),
      configJson: agent.configJson || '{}',
      capsetIds: [...agent.capsetIds],
    };
    navigate(`/agents/${encodeURIComponent(agent.id)}/edit`);
  }

  async function save(): Promise<void> {
    const validationError = validateDraft(draft, agents, creating ? undefined : selected?.id);
    if (validationError) {
      error = validationError;
      return;
    }
    saving = true;
    error = '';
    try {
      const saved = creating ? await createAgentDefinition(draft) : await updateAgentDefinition(selected!.id, draft);
      await load();
      navigate(`/agents/${encodeURIComponent(saved.id)}`);
    } catch (cause) {
      error = errorMessage(cause);
    } finally {
      saving = false;
    }
  }

  async function run(agent: AgentDefinition): Promise<void> {
    if (!runPrompt.trim()) {
      error = '请输入运行任务';
      return;
    }
    saving = true;
    error = '';
    try {
      if (!agent.projectId) throw new Error('智能体缺少项目标识，无法启动运行');
      const stream = await runStreams.start(
        {
          projectId: agent.projectId,
          agentName: agent.agentName,
          prompt: runPrompt.trim(),
          driver: agent.driver,
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

  async function remove(agent: AgentDefinition): Promise<void> {
    if (!confirm(`确认删除智能体 ${agent.name}？`)) return;
    try {
      await deleteAgentDefinition(agent.id);
      navigate('/agents');
      await load();
    } catch (cause) {
      error = errorMessage(cause);
    }
  }

  function updateCapsets(value: string): void {
    draft.capsetIds = value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function filterAgents(
    items: AgentDefinition[],
    value: string,
    status: 'all' | 'enabled' | 'disabled',
  ): AgentDefinition[] {
    const normalized = value.trim().toLowerCase();
    return items
      .filter((agent) => status === 'all' || agent.enabled === (status === 'enabled'))
      .filter((agent) =>
        normalized
          ? `${agent.name} ${agent.agentName} ${agent.provider} ${agent.model}`.toLowerCase().includes(normalized)
          : true,
      )
      .sort(
        (left, right) =>
          Number(right.enabled) - Number(left.enabled) ||
          (left.name || left.agentName).localeCompare(right.name || right.agentName, 'zh-CN'),
      );
  }
  const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : '请求失败');

  function validateDraft(input: AgentDefinitionInput, existingAgents: AgentDefinition[], currentId?: string): string {
    if (!/^[a-z][a-z0-9_-]*$/.test(input.agentName.trim()))
      return '调用标识必须以小写字母开头，仅包含小写字母、数字、- 或 _';
    if (existingAgents.some((agent) => agent.id !== currentId && agent.agentName === input.agentName.trim()))
      return '调用标识已存在';
    if (!input.name.trim()) return '显示名称必填';
    if (!input.model.trim()) return '模型必填';
    if (!input.driver.trim()) return 'Driver 必填';
    return '';
  }
</script>

<div data-page-layout="master-detail" class="flex min-h-full flex-col lg:h-full lg:min-h-0 lg:overflow-hidden">
  <PageHeader title="智能体" description="定义 LLM 提供方、运行时、工作区与能力">
    {#snippet actions()}<Button size="sm" onclick={beginCreate}><Plus class="size-3.5" /> 新建智能体</Button>{/snippet}
  </PageHeader>

  {#if error}<div class="mx-6 mt-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>{/if}
  {#if editing}
    <form
      class="mx-auto w-full max-w-4xl space-y-5 px-4 py-5 sm:px-5 lg:min-h-0 lg:flex-1 lg:overflow-y-auto xl:px-6"
      data-scroll-pane
      onsubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div class="flex items-center justify-between">
        <div>
          <h2 class="font-semibold">{creating ? '新建智能体' : `编辑 ${selected?.name ?? ''}`}</h2>
          <p class="text-sm text-muted-foreground">基础、运行时、工作区、环境与能力</p>
        </div>
        <div class="flex gap-2">
          <Button
            type="button"
            variant="outline"
            onclick={() => navigate(selected ? `/agents/${selected.id}` : '/agents')}>取消</Button
          ><Button type="submit" disabled={saving}>{saving ? '保存中…' : '保存'}</Button>
        </div>
      </div>
      <section class="grid gap-4 rounded-lg border border-border bg-card p-5 md:grid-cols-2">
        <label class="space-y-1"
          ><span class="text-sm">调用标识</span><Input
            bind:value={draft.agentName}
            disabled={!creating}
            placeholder="my-agent"
          /></label
        >
        <label class="space-y-1"><span class="text-sm">显示名称</span><Input bind:value={draft.name} /></label>
        <label class="space-y-1"
          ><span class="text-sm">Provider</span><select
            class="h-8 w-full rounded-lg border border-input bg-background px-2 text-sm"
            bind:value={draft.provider}
            ><option>codex</option><option>claude</option><option>gemini</option><option>opencode</option><option
              >pi</option
            ></select
          ></label
        >
        <label class="space-y-1"><span class="text-sm">模型</span><Input bind:value={draft.model} /></label>
        <label class="space-y-1"><span class="text-sm">Driver</span><Input bind:value={draft.driver} /></label>
        <label class="space-y-1"
          ><span class="text-sm">Guest 镜像</span><Input bind:value={draft.guestImage} placeholder="node:20" /></label
        >
        <label class="space-y-1"
          ><span class="text-sm">Workspace</span><select
            class="h-8 w-full rounded-lg border border-input bg-background px-2 text-sm"
            bind:value={draft.workspaceId}
            ><option value="">无</option>{#each workspaces as workspace (workspace.id)}<option value={workspace.id}
                >{workspace.name}</option
              >{/each}</select
          ></label
        >
        <label class="space-y-1"
          ><span class="text-sm">能力集（逗号分隔）</span><Input
            value={draft.capsetIds.join(', ')}
            oninput={(event) => updateCapsets(event.currentTarget.value)}
            list="capsets"
          /><datalist id="capsets"
            >{#each capabilitySets as set (set.id)}<option value={set.id}>{set.name}</option>{/each}</datalist
          ></label
        >
        <label class="space-y-1 md:col-span-2"
          ><span class="text-sm">描述</span><Input bind:value={draft.description} /></label
        >
        <label class="space-y-1 md:col-span-2"
          ><span class="text-sm">系统提示词</span><Textarea
            bind:value={draft.systemPrompt}
            class="min-h-40 font-mono text-xs"
          /></label
        >
        <label class="flex items-center gap-2 text-sm md:col-span-2"
          ><input type="checkbox" bind:checked={draft.enabled} /> 启用智能体</label
        >
      </section>
    </form>
  {:else}
    <div class="grid min-w-0 lg:min-h-0 lg:flex-1 lg:grid-cols-[20rem_minmax(0,1fr)] lg:overflow-hidden">
      <aside class="flex min-w-0 flex-col border-b border-border lg:min-h-0 lg:border-b-0 lg:border-r">
        <div class="p-3">
          <Input bind:value={query} placeholder="过滤智能体…" />
          <div class="mt-2 grid grid-cols-3 gap-1 rounded-lg bg-muted p-1" aria-label="智能体状态筛选">
            {#each [{ value: 'all', label: `全部 ${agents.length}` }, { value: 'enabled', label: `已启用 ${enabledCount}` }, { value: 'disabled', label: `已停用 ${disabledCount}` }] as option}
              <button
                type="button"
                aria-pressed={statusFilter === option.value}
                class="rounded-md px-2 py-1.5 text-xs transition-colors {statusFilter === option.value
                  ? 'bg-background font-medium text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'}"
                onclick={() => (statusFilter = option.value as typeof statusFilter)}>{option.label}</button
              >
            {/each}
          </div>
        </div>
        <div data-scroll-pane class="px-2 pb-3 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
          {#each visibleAgents as agent (agent.id)}<button
              class="mb-1 w-full rounded-md border-l-2 p-2 text-left {agent.enabled
                ? 'border-l-success'
                : 'border-l-transparent opacity-60'} {agent.id === selected?.id ? 'bg-accent' : 'hover:bg-accent/60'}"
              onclick={() => navigate(`/agents/${encodeURIComponent(agent.id)}`)}
              ><div class="flex items-center justify-between gap-2">
                <span class="truncate text-sm font-medium">{agent.name}</span>
                <span class="shrink-0 text-[11px] {agent.enabled ? 'text-success' : 'text-muted-foreground'}"
                  >{agent.enabled ? '已启用' : '已停用'}</span
                >
              </div>
              <div class="font-mono text-xs text-muted-foreground">
                {agent.provider} · {agent.guestImage || '默认镜像'}
              </div></button
            >{:else}<p class="p-6 text-sm text-muted-foreground">
              {loading ? '正在加载…' : agents.length ? '没有匹配的智能体' : '还没有智能体'}
            </p>{/each}
        </div>
      </aside>
      <section data-scroll-pane class="min-w-0 p-4 sm:p-5 lg:min-h-0 lg:overflow-y-auto xl:p-6">
        {#if selected}<div class="mb-5 flex items-center justify-between">
            <div class="flex items-center gap-3">
              <h2 class="font-semibold">{selected.name}</h2>
              <StatusBadge
                status={selected.enabled ? 'enabled' : 'disabled'}
                label={selected.enabled ? '已启用' : '已停用'}
              />{#if selected.latestRun}<StatusBadge
                  status={selected.latestRun.status === '成功'
                    ? 'success'
                    : selected.latestRun.status === '运行中'
                      ? 'running'
                      : 'failed'}
                />{/if}
            </div>
            <div class="flex gap-2">
              <Button variant="outline" size="sm" onclick={() => beginEdit(selected)}
                ><Pencil class="size-3.5" />编辑</Button
              ><Button variant="outline" size="sm" class="text-destructive" onclick={() => remove(selected)}
                ><Trash2 class="size-3.5" />删除</Button
              >
            </div>
          </div>
          <Tabs.Root value="overview"
            ><Tabs.List
              ><Tabs.Trigger value="overview">概况</Tabs.Trigger><Tabs.Trigger value="prompt">系统提示</Tabs.Trigger
              ><Tabs.Trigger value="env">环境</Tabs.Trigger><Tabs.Trigger value="extensions">扩展</Tabs.Trigger
              ></Tabs.List
            ><Tabs.Content value="overview" class="mt-4"
              ><dl class="grid grid-cols-[8rem_1fr] gap-3 text-sm">
                <dt class="text-muted-foreground">Agent ID</dt>
                <dd><CopyableText value={selected.id} label="Agent ID" class="max-w-full font-mono text-xs" /></dd>
                <dt class="text-muted-foreground">调用标识</dt>
                <dd>
                  <CopyableText value={selected.agentName} label="调用标识" class="max-w-full font-mono text-xs" />
                </dd>
                <dt class="text-muted-foreground">Provider / Model</dt>
                <dd>{selected.provider} · {selected.model}</dd>
                <dt class="text-muted-foreground">运行时</dt>
                <dd>{selected.driver} · {selected.guestImage}</dd>
                <dt class="text-muted-foreground">Workspace</dt>
                <dd>{selected.workFiles.summary || '无'}</dd>
                <dt class="text-muted-foreground">健康</dt>
                <dd>{selected.health}</dd>
                <dt class="text-muted-foreground">创建时间</dt>
                <dd><Timestamp value={selected.createdAt} mode="full" /></dd>
                <dt class="text-muted-foreground">更新时间</dt>
                <dd><Timestamp value={selected.updatedAt} mode="full" /></dd>
              </dl>
              <div class="mt-6 flex max-w-xl gap-2">
                <Input bind:value={runPrompt} placeholder="输入一次短任务" /><Button
                  disabled={saving || !selected.enabled}
                  onclick={() => run(selected)}><Play class="size-3.5" />运行</Button
                >
              </div></Tabs.Content
            ><Tabs.Content value="prompt" class="mt-4"
              ><pre class="whitespace-pre-wrap rounded-lg bg-muted p-4 text-xs">{selected.systemPrompt ||
                  '未设置'}</pre></Tabs.Content
            ><Tabs.Content value="env" class="mt-4"
              ><pre
                class="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-4 text-xs"
                data-scroll-surface>{JSON.stringify(selected.envItems, null, 2)}</pre></Tabs.Content
            ><Tabs.Content value="extensions" class="mt-4"
              ><pre
                class="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-4 text-xs"
                data-scroll-surface>{selected.configJson || '{}'}</pre></Tabs.Content
            ></Tabs.Root
          >{/if}
      </section>
    </div>
  {/if}
</div>
