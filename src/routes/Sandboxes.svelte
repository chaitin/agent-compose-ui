<script lang="ts">
  import { onMount } from 'svelte';
  import { SvelteURLSearchParams } from 'svelte/reactivity';
  import CollectionPage from '$lib/components/collection-page.svelte';
  import CopyableText from '$lib/components/copyable-text.svelte';
  import StatusBadge from '$lib/components/status-badge.svelte';
  import Timestamp from '$lib/components/timestamp.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { navigate, router } from '$lib/router.svelte';
  import { t } from '$lib/i18n.svelte';
  import { listSandboxContexts, type SandboxContext } from '../api/sessions';
  import { listRunActors, listUnlinkedRuns, type RunActor } from '../api/runs';
  import { resolveResource } from '../api/resources';
  import { ResourceKind } from '../gen/agentcompose/v2/agentcompose_pb.js';
  import { compactIdentifier } from '../model/identifiers';

  const PAGE_SIZE = 50;
  const statuses = ['running', 'pending', 'stopped', 'failed', 'deleting'] as const;
  const initial = new URLSearchParams(location.search);
  let sandboxes = $state<SandboxContext[]>([]);
  let actors = $state<RunActor[]>([]);
  let projectId = $state(initial.get('projectId') ?? '');
  let status = $state(initial.get('status') ?? '');
  let idQuery = $state('');
  let offset = $state(Number(initial.get('offset') ?? 0) || 0);
  let total = $state(0);
  let loading = $state(true);
  let refreshing = $state(false);
  let error = $state('');
  let hasExceptionalRuns = $state(false);

  const projects = $derived(
    [...new Map(actors.map((actor) => [actor.projectId, actor.projectName])).entries()].map(([id, name]) => ({
      id,
      name,
    })),
  );

  onMount(() => {
    void loadActors();
    void loadExceptionalRunAvailability();
    void load();
  });

  async function loadExceptionalRunAvailability(): Promise<void> {
    try {
      const page = await listUnlinkedRuns(0, 1);
      hasExceptionalRuns = page.runs.length > 0;
    } catch {
      hasExceptionalRuns = false;
    }
  }

  async function loadActors(): Promise<void> {
    try {
      actors = await listRunActors();
    } catch {
      actors = [];
    }
  }

  async function load(background = false): Promise<void> {
    if (background) refreshing = true;
    else loading = true;
    error = '';
    try {
      const response = await listSandboxContexts(PAGE_SIZE, offset, {
        projectId,
        status: status ? [status] : [],
      });
      sandboxes = response.sessions;
      total = response.totalCount;
      syncURL();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : t('请求失败');
    } finally {
      loading = false;
      refreshing = false;
    }
  }

  function applyFilters(): void {
    offset = 0;
    void load();
  }

  function syncURL(): void {
    const query = new SvelteURLSearchParams();
    if (projectId) query.set('projectId', projectId);
    if (status) query.set('status', status);
    if (offset) query.set('offset', String(offset));
    const value = query.toString();
    router.replace(`/sandboxes${value ? `?${value}` : ''}`);
  }

  async function openResource(): Promise<void> {
    const value = idQuery.trim();
    if (!value) return;
    try {
      const response = await resolveResource(value);
      const target = response.targets.find((item) => item.kind === ResourceKind.SANDBOX);
      if (!target) throw new Error(t('无法解析资源 ID'));
      navigate(`/sandboxes/${encodeURIComponent(target.id)}`);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : t('无法解析资源 ID');
    }
  }

  function previous(): void {
    if (!offset) return;
    offset = Math.max(0, offset - PAGE_SIZE);
    void load();
  }

  function next(): void {
    if (offset + sandboxes.length >= total) return;
    offset += PAGE_SIZE;
    void load();
  }

  function statusLabel(value: string): string {
    return t(
      value === 'running'
        ? '运行中'
        : value === 'pending'
          ? '等待中'
          : value === 'stopped'
            ? '已停止'
            : value === 'failed'
              ? '失败'
              : value === 'deleting'
                ? '删除中'
                : value,
    );
  }

  function projectName(id: string): string {
    return projects.find((project) => project.id === id)?.name || (id ? compactIdentifier(id) : t('未关联项目'));
  }
</script>

<CollectionPage title="运行记录" description="按执行环境查看运行与对话" compactHeader>
  {#snippet actions()}
    <select
      bind:value={projectId}
      aria-label={t('按项目筛选')}
      class="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm sm:w-40 sm:flex-none"
      onchange={applyFilters}
    >
      <option value="">{t('全部项目')}</option>
      {#each projects as project (project.id)}<option value={project.id}>{project.name}</option>{/each}
    </select>
    <select
      bind:value={status}
      aria-label={t('按状态筛选')}
      class="h-8 min-w-28 rounded-md border border-input bg-background px-2 text-sm"
      onchange={applyFilters}
    >
      <option value="">{t('全部状态')}</option>
      {#each statuses as value (value)}<option {value}>{statusLabel(value)}</option>{/each}
    </select>
    {#if hasExceptionalRuns}<Button variant="outline" size="sm" onclick={() => navigate('/runs/unlinked')}
        >{t('运行异常')}</Button
      >{/if}
    <form
      class="flex w-full gap-2 sm:w-auto"
      onsubmit={(event) => {
        event.preventDefault();
        void openResource();
      }}
    >
      <Input bind:value={idQuery} placeholder={t('输入执行环境 ID')} class="h-8 min-w-0 sm:w-64" />
      <Button type="submit" variant="outline" size="sm">{t('查找')}</Button>
    </form>
    <Button variant="outline" size="sm" disabled={refreshing} onclick={() => void load(true)}
      >{t(refreshing ? '刷新中…' : '刷新')}</Button
    >
  {/snippet}

  {#if error}<div data-page-error class="mb-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
      {error}
    </div>{/if}

  <div data-scroll-pane data-route-scroll="sandboxes" class="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1 md:hidden">
    {#each sandboxes as sandbox (sandbox.id)}
      <button
        class="w-full rounded-lg border border-border bg-card p-3 text-left hover:bg-accent/40"
        onclick={() => navigate(`/sandboxes/${encodeURIComponent(sandbox.id)}`)}
      >
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="truncate text-sm font-medium">{sandbox.agentName || t('未命名智能体')}</div>
            <div class="mt-0.5 truncate text-xs text-muted-foreground">{projectName(sandbox.projectId)}</div>
          </div>
          <StatusBadge status={sandbox.status} label={statusLabel(sandbox.status)} />
        </div>
        <div class="mt-3 flex items-center justify-between gap-3">
          <CopyableText
            value={sandbox.id}
            display={compactIdentifier(sandbox.id)}
            label="执行环境 ID"
            class="font-mono text-xs"
          />
          <Timestamp value={sandbox.updatedAt} />
        </div>
      </button>
    {:else}<p class="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        {t(loading ? '正在加载运行…' : '没有匹配的执行环境')}
      </p>{/each}
  </div>

  <div
    data-scroll-pane
    data-route-scroll="sandboxes"
    class="hidden min-h-0 flex-1 overflow-auto rounded-lg border border-border md:block"
  >
    <table class="w-full min-w-[52rem] text-sm">
      <thead class="sticky top-0 z-10 bg-muted/95 text-xs backdrop-blur">
        <tr
          ><th class="p-3 text-left font-medium">{t('智能体 / 项目')}</th><th class="p-3 text-left font-medium"
            >{t('状态')}</th
          ><th class="p-3 text-left font-medium">{t('最近活动')}</th><th class="p-3 text-left font-medium"
            >{t('执行环境 ID')}</th
          ><th class="p-3 text-left font-medium">{t('运行方式')}</th></tr
        >
      </thead>
      <tbody class="divide-y divide-border">
        {#each sandboxes as sandbox (sandbox.id)}
          <tr
            class="cursor-pointer hover:bg-accent/50"
            onclick={() => navigate(`/sandboxes/${encodeURIComponent(sandbox.id)}`)}
          >
            <td class="p-3"
              ><div class="font-medium">{sandbox.agentName || t('未命名智能体')}</div>
              <div class="text-xs text-muted-foreground">{projectName(sandbox.projectId)}</div></td
            >
            <td class="p-3"><StatusBadge status={sandbox.status} label={statusLabel(sandbox.status)} /></td>
            <td class="p-3"><Timestamp value={sandbox.updatedAt} /></td>
            <td class="p-3"
              ><CopyableText
                value={sandbox.id}
                display={compactIdentifier(sandbox.id)}
                label="执行环境 ID"
                class="font-mono text-xs"
              /></td
            >
            <td class="p-3 text-xs text-muted-foreground">{sandbox.driver || '—'}</td>
          </tr>
        {:else}<tr
            ><td colspan="5" class="p-10 text-center text-muted-foreground"
              >{t(loading ? '正在加载运行…' : '没有匹配的执行环境')}</td
            ></tr
          >{/each}
      </tbody>
    </table>
  </div>

  {#snippet footer()}
    <div class="flex items-center justify-between border-t border-border pt-3">
      <span class="text-xs text-muted-foreground"
        >{total ? `${offset + 1}–${offset + sandboxes.length} / ${total}` : '0'}</span
      >
      <div class="flex gap-2">
        <Button variant="outline" size="sm" disabled={!offset || loading} onclick={previous}>{t('上一页')}</Button
        ><Button variant="outline" size="sm" disabled={offset + sandboxes.length >= total || loading} onclick={next}
          >{t('下一页')}</Button
        >
      </div>
    </div>
  {/snippet}
</CollectionPage>
