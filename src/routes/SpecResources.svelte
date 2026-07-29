<script lang="ts">
  import { onMount } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import CodeEditor from '$lib/components/code-editor.svelte';
  import CopyableText from '$lib/components/copyable-text.svelte';
  import PageHeader from '$lib/components/page-header.svelte';
  import PageContent from '$lib/components/page-content.svelte';
  import { preloadMonaco } from '$lib/monaco';
  import { navigate } from '$lib/router.svelte';
  import {
    listSpecResources,
    listSpecResourceTargets,
    removeSpecResource,
    saveSpecResource,
    type SpecResource,
    type SpecResourceTarget,
  } from '../api/resources';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Plus from '@lucide/svelte/icons/plus';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import { t } from '$lib/i18n.svelte';

  let { kind }: { kind: 'mcp' | 'skills' } = $props();
  let items = $state<SpecResource[]>([]);
  let targets = $state<SpecResourceTarget[]>([]);
  let targetKey = $state('');
  let originalName = $state('');
  let resourceJSON = $state('');
  let editing = $state(false);
  let loading = $state(true);
  let saving = $state(false);
  let error = $state('');
  let success = $state('');

  onMount(load);

  async function load(): Promise<void> {
    loading = true;
    error = '';
    try {
      [items, targets] = await Promise.all([listSpecResources(kind), listSpecResourceTargets(kind)]);
      if (!targetKey && targets[0]) targetKey = targets[0].key;
    } catch (cause) {
      error = message(cause);
    } finally {
      loading = false;
    }
  }

  function beginCreate(): void {
    originalName = '';
    resourceJSON = JSON.stringify(
      kind === 'mcp'
        ? { name: 'new-mcp', type: 'local', command: 'npx', args: [] }
        : { name: 'new-skill', provider: 'git', url: 'https://github.com/example/skills.git', path: '' },
      null,
      2,
    );
    editing = true;
    success = '';
  }

  function beginEdit(item: SpecResource): void {
    targetKey = `${item.projectId}:${item.agentName}`;
    originalName = item.name;
    resourceJSON = item.details;
    editing = true;
    success = '';
  }

  async function save(): Promise<void> {
    const target = targets.find((item) => item.key === targetKey);
    if (!target) {
      error = t('请选择配置目标');
      return;
    }
    saving = true;
    error = '';
    success = '';
    try {
      await saveSpecResource(kind, target, originalName, resourceJSON);
      success = `${kind === 'mcp' ? 'MCP' : 'Skill'} 配置已保存`;
      editing = false;
      await load();
    } catch (cause) {
      error = message(cause);
    } finally {
      saving = false;
    }
  }

  async function remove(item: SpecResource): Promise<void> {
    if (!confirm(`确认删除 ${item.name}？`)) return;
    saving = true;
    error = '';
    try {
      await removeSpecResource(kind, item);
      success = `${item.name} 已删除`;
      await load();
    } catch (cause) {
      error = message(cause);
    } finally {
      saving = false;
    }
  }

  const message = (cause: unknown): string => (cause instanceof Error ? cause.message : t('请求失败'));
</script>

<PageHeader
  title={kind === 'mcp' ? 'MCP 服务' : 'Skills'}
  description={kind === 'mcp' ? '管理项目级与智能体级 MCP 声明' : '管理智能体 Skill 来源'}
>
  {#snippet actions()}<Button
      size="sm"
      onpointerenter={preloadMonaco}
      onfocus={preloadMonaco}
      onclick={beginCreate}
      disabled={!targets.length}><Plus class="size-3.5" />{t('新增')}{kind === 'mcp' ? ' MCP' : ' Skill'}</Button
    >{/snippet}
</PageHeader>
<PageContent class="space-y-4">
  {#if error}<div class="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>{/if}
  {#if success}<div class="rounded-md bg-success/10 p-3 text-sm text-success">{success}</div>{/if}

  {#if editing}<section class="space-y-3 rounded-lg border border-border bg-card p-4">
      <div class="flex flex-wrap items-center gap-2">
        <label class="text-sm font-medium" for="resource-target">{t('配置目标')}</label>
        <select
          id="resource-target"
          class="h-8 min-w-72 rounded-lg border border-input bg-background px-2 text-sm"
          bind:value={targetKey}
          disabled={Boolean(originalName)}
        >
          {#each targets as target (target.key)}<option value={target.key}>{target.label}</option>{/each}
        </select>
        <div class="ml-auto flex gap-2">
          <Button type="button" variant="outline" size="sm" onclick={() => (editing = false)}>{t('取消')}</Button>
          <Button type="button" size="sm" disabled={saving} onclick={save}>{t(saving ? '保存中…' : '保存')}</Button>
        </div>
      </div>
      <CodeEditor bind:value={resourceJSON} language="json" height="32rem" title={t('资源 JSON')} />
    </section>{/if}

  {#if loading}<p class="text-sm text-muted-foreground">{t('正在加载…')}</p>{:else}<div
      class="grid gap-3 lg:grid-cols-2"
    >
      {#each items as item (item.key)}<article class="rounded-lg border border-border bg-card p-4">
          <div class="flex items-start justify-between gap-4">
            <div>
              <h2 class="font-medium">{item.name}</h2>
              <p class="text-xs text-muted-foreground">
                {item.scope} · {item.projectName}{item.agentName ? ` / ${item.agentName}` : ''}
              </p>
              <div class="mt-1 flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
                <CopyableText value={item.key} label="资源 Key" class="max-w-full font-mono" />
                <CopyableText value={item.projectId} label="Project ID" class="max-w-full font-mono" />
              </div>
            </div>
            <div class="flex gap-1">
              {#if item.agentName}<Button
                  variant="ghost"
                  size="sm"
                  onclick={() => navigate(`/agents/${encodeURIComponent(item.agentName)}`)}>{t('智能体')}</Button
                >{/if}<Button
                variant="ghost"
                size="icon"
                title={t('编辑')}
                onpointerenter={preloadMonaco}
                onfocus={preloadMonaco}
                onclick={() => beginEdit(item)}><Pencil class="size-3.5" /></Button
              ><Button
                variant="ghost"
                size="icon"
                class="text-destructive"
                title={t('删除')}
                onclick={() => remove(item)}><Trash2 class="size-3.5" /></Button
              >
            </div>
          </div>
          <pre
            data-scroll-surface
            class="mt-3 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">{item.details}</pre>
        </article>{:else}<p class="text-sm text-muted-foreground">
          {t(
            kind === 'mcp'
              ? '当前项目没有声明 MCP 服务，可以通过右上角新增。'
              : '当前项目没有声明 Skills，可以通过右上角新增。',
          )}
        </p>{/each}
    </div>{/if}
</PageContent>
