<script lang="ts">
  import { tick } from 'svelte';
  import type { ResourceTab, ScriptWorkspace } from '../lib/scripts/workspace.svelte';
  import { countScriptFiles } from '../lib/scripts/tree';
  import ScriptPanel from './scripts/ScriptPanel.svelte';
  import WorkspacePanel from './workspace/WorkspacePanel.svelte';
  import SkillPanel from './skills/SkillPanel.svelte';
  import DataMountPanel from './mounts/DataMountPanel.svelte';
  import { workspaceFiles } from '../lib/workspace/store.svelte';
  import { getProjectBindingOverride, projectStorageErrorMessage, workspaceBindings, type ProjectStorageBinding } from '../lib/workspace/bindings';

  const VALID_PROJECT_KEY = /^ws_[0-9a-f]{32}$/;

  interface Props {
    workspace: ScriptWorkspace;
    projectKey?: string;
    projectIdentity?: string;
    bindingProjectKey?: string;
    bindingSourcePath?: string;
    bindingLegacyKey?: string;
    onBindingResolved?: (binding: ProjectStorageBinding, identity: string) => void;
    yaml?: string;
    selectedAgent?: string;
    onYamlChange?: (yaml: string) => void | Promise<void>;
    onApply?: () => Promise<void>;
  }
  let {
    workspace, projectKey = '', projectIdentity = '', bindingProjectKey = '', bindingSourcePath = '', bindingLegacyKey = '',
    onBindingResolved = () => {}, yaml = '', selectedAgent = '', onYamlChange = () => {}, onApply = async () => {},
  }: Props = $props();
  const instanceId = $props.id();
  const resourceTabs: readonly ResourceTab[] = ['scripts', 'workspace', 'skills', 'mounts'];

  let panelHeight = $state(240);
  let resizing = false;
  let skillProjectKey = $state('');
  let bindingLoading = $state(false);
  let bindingError = $state('');
  let bindingGeneration = 0;
  let observedBindingContext = '';

  const scriptFileCount = $derived(workspace.tree ? countScriptFiles(workspace.tree) : 0);
  const workspaceFileCount = $derived(workspaceFiles.files.filter((f) => !f.dir).length);

  $effect(() => {
    const shouldResolve = workspace.panelOpen && (workspace.activeTab === 'skills' || workspace.activeTab === 'mounts');
    const context = [shouldResolve, projectIdentity, bindingProjectKey, bindingSourcePath, bindingLegacyKey, projectKey].join('\0');
    if (context === observedBindingContext) return;
    observedBindingContext = context;
    if (!shouldResolve) { bindingGeneration += 1; bindingLoading = false; return; }
    void resolveSkillBinding();
  });

  async function resolveSkillBinding(): Promise<void> {
    const generation = ++bindingGeneration;
    skillProjectKey = ''; bindingError = '';
    if (!projectIdentity) {
      skillProjectKey = VALID_PROJECT_KEY.test(projectKey) ? projectKey : '';
      bindingLoading = false; return;
    }
    const identity = projectIdentity;
    bindingLoading = true;
    try {
      const projectId = identity.startsWith('project:') ? identity.slice('project:'.length) : '';
      const override = projectId ? getProjectBindingOverride(projectId) : undefined;
      const binding = override ?? await workspaceBindings.ensure(identity, {
        projectKey: bindingProjectKey || undefined,
        sourcePath: bindingSourcePath || undefined,
        legacyKey: bindingLegacyKey || undefined,
        ensureWorkspace: false,
      });
      if (generation !== bindingGeneration || identity !== projectIdentity) return;
      if (!VALID_PROJECT_KEY.test(binding.projectKey)) throw new Error('项目存储返回了无效 projectKey');
      skillProjectKey = binding.projectKey; onBindingResolved(binding, identity);
    } catch (value) {
      if (generation !== bindingGeneration || identity !== projectIdentity) return;
      bindingError = projectStorageErrorMessage(value);
    } finally { if (generation === bindingGeneration) bindingLoading = false; }
  }

  function startVerticalResize(event: MouseEvent) {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = panelHeight;
    const maxHeight = Math.max(120, window.innerHeight - 200);
    resizing = true;
    const onMove = (e: MouseEvent) => {
      if (!resizing) return;
      panelHeight = Math.max(120, Math.min(maxHeight, startHeight + (startY - e.clientY)));
    };
    const onUp = () => {
      resizing = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'row-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function selectTab(tab: ResourceTab) {
    workspace.activeTab = tab;
    if (!workspace.panelOpen) workspace.panelOpen = true;
  }

  const tabId = (tab: ResourceTab) => `${instanceId}-resource-tab-${tab}`;
  const panelId = (tab: ResourceTab) => `${instanceId}-resource-panel-${tab}`;
  async function handleTabKeydown(event: KeyboardEvent, currentTab: ResourceTab) {
    const current = resourceTabs.indexOf(currentTab);
    let target = current;
    if (event.key === 'ArrowRight') target = (current + 1) % resourceTabs.length;
    else if (event.key === 'ArrowLeft') target = (current - 1 + resourceTabs.length) % resourceTabs.length;
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = resourceTabs.length - 1;
    else return;
    event.preventDefault(); selectTab(resourceTabs[target]); await tick(); document.getElementById(tabId(resourceTabs[target]))?.focus();
  }
</script>

<section
  class="resource-panel"
  class:open={workspace.panelOpen}
  style:height={workspace.panelOpen ? `${panelHeight}px` : undefined}
>
  {#if workspace.panelOpen}
    <button
      class="panel-resizer"
      type="button"
      aria-label="调整资源面板高度"
      onmousedown={startVerticalResize}
    ></button>
  {/if}
  <div class="resource-tabs">
    <button
      type="button"
      class="resource-toggle"
      aria-label={workspace.panelOpen ? '折叠资源面板' : '展开资源面板'}
      onclick={() => (workspace.panelOpen = !workspace.panelOpen)}
    >
      <span class="chevron">{workspace.panelOpen ? '⌄' : '›'}</span>
      <span class="title">项目资源</span>
    </button>
    <div class="resource-tablist" role="tablist" aria-label="项目资源标签页">
    <button
      id={tabId('scripts')}
      type="button"
      class="resource-tab"
      class:active={workspace.activeTab === 'scripts'}
      role="tab"
      aria-selected={workspace.activeTab === 'scripts'}
      aria-controls={panelId('scripts')}
      tabindex={workspace.activeTab === 'scripts' ? 0 : -1}
      onclick={() => selectTab('scripts')}
      onkeydown={(event) => handleTabKeydown(event, 'scripts')}
    >
      <span>脚本文件</span>
      <span class="count">{scriptFileCount}</span>
    </button>
    <button
      id={tabId('workspace')}
      type="button"
      class="resource-tab"
      class:active={workspace.activeTab === 'workspace'}
      role="tab"
      aria-selected={workspace.activeTab === 'workspace'}
      aria-controls={panelId('workspace')}
      tabindex={workspace.activeTab === 'workspace' ? 0 : -1}
      onclick={() => selectTab('workspace')}
      onkeydown={(event) => handleTabKeydown(event, 'workspace')}
    >
      <span>Workspace 文件</span>
      <span class="count">{workspaceFileCount}</span>
    </button>
    <button id={tabId('skills')} type="button" class="resource-tab" class:active={workspace.activeTab === 'skills'} role="tab" aria-selected={workspace.activeTab === 'skills'} aria-controls={panelId('skills')} tabindex={workspace.activeTab === 'skills' ? 0 : -1} onclick={() => selectTab('skills')} onkeydown={(event) => handleTabKeydown(event, 'skills')}><span>Skills</span></button>
    <button id={tabId('mounts')} type="button" class="resource-tab" class:active={workspace.activeTab === 'mounts'} role="tab" aria-selected={workspace.activeTab === 'mounts'} aria-controls={panelId('mounts')} tabindex={workspace.activeTab === 'mounts' ? 0 : -1} onclick={() => selectTab('mounts')} onkeydown={(event) => handleTabKeydown(event, 'mounts')}><span>数据与挂载</span></button>
    </div>
    {#if !workspace.serviceAvailable && workspace.activeTab === 'scripts'}
      <span class="header-status" title="脚本服务不可用">●</span>
    {/if}
  </div>

  {#if workspace.panelOpen}
    <div class="panel-body" id={panelId(workspace.activeTab)} role="tabpanel" aria-labelledby={tabId(workspace.activeTab)}>
      {#if workspace.activeTab === 'scripts'}
        <ScriptPanel {workspace} />
      {:else if workspace.activeTab === 'workspace'}
        <WorkspacePanel />
      {:else if workspace.activeTab === 'skills'}
        {#if bindingLoading}<div class="resource-placeholder" role="status">正在解析项目存储…</div>
        {:else if bindingError}<div class="resource-placeholder" role="alert">项目存储不可用：{bindingError}<button type="button" onclick={resolveSkillBinding}>重试</button></div>
        {:else if !skillProjectKey}<div class="resource-placeholder" role="status">请先建立项目存储绑定</div>
        {:else}<SkillPanel projectKey={skillProjectKey} {yaml} {selectedAgent} {onYamlChange} />{/if}
      {:else}
        {#if bindingLoading}<div class="resource-placeholder" role="status">正在解析项目存储…</div>
        {:else if bindingError}<div class="resource-placeholder" role="alert">项目存储不可用：{bindingError}<button type="button" onclick={resolveSkillBinding}>重试</button></div>
        {:else if !skillProjectKey}<div class="resource-placeholder" role="status">请先建立项目存储绑定</div>
        {:else}<DataMountPanel projectKey={skillProjectKey} {yaml} {selectedAgent} {onYamlChange} {onApply} />{/if}
      {/if}
    </div>
  {/if}
</section>

<style>
  .resource-panel {
    display: flex;
    flex-direction: column;
    border-top: 1px solid var(--border-color);
    background: var(--bg-secondary);
    flex-shrink: 0;
    position: relative;
  }
  .resource-panel:not(.open) {
    height: 32px;
  }
  .resource-panel.open {
    min-height: 120px;
  }
  .panel-resizer {
    height: 4px;
    width: 100%;
    padding: 0;
    border: 0;
    background: var(--border-color);
    cursor: row-resize;
    flex-shrink: 0;
    transition: background 0.1s;
  }
  .panel-resizer:hover,
  .panel-resizer:active {
    background: var(--accent-blue);
  }
  .resource-tabs {
    display: flex;
    align-items: center;
    gap: 4px;
    background: var(--bg-tertiary);
    border-bottom: 1px solid var(--border-color);
    padding: 0 8px;
    height: 32px;
    flex-shrink: 0;
  }
  .resource-toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    border: none;
    background: transparent;
    color: var(--text-secondary);
    font-size: var(--font-size-md);
    font-family: var(--font-sans);
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .resource-toggle:hover { color: var(--text-primary); }
  .resource-toggle .chevron { font-size: 10px; }
  .resource-toggle .title { font-weight: 600; }
  .resource-tablist { display: flex; align-items: center; gap: 4px; height: 100%; min-width: 0; flex: 1; overflow-x: auto; }
  .resource-tab {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border: none;
    background: transparent;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    font-family: var(--font-sans);
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    cursor: pointer;
  }
  .resource-tab:hover { color: var(--text-primary); }
  .resource-tab.active { color: var(--text-primary); border-bottom-color: var(--accent-blue); }
  .resource-tab .count {
    background: var(--bg-secondary);
    color: var(--text-secondary);
    border: 1px solid var(--border-color);
    padding: 0 6px;
    border-radius: 10px;
    font-size: 10px;
    font-family: var(--font-mono);
  }
  .resource-tab.active .count {
    background: var(--bg-primary);
    color: var(--accent-blue);
    border-color: var(--accent-blue);
  }
  .header-status {
    color: var(--accent-red);
    font-size: var(--font-size-xs);
    margin-left: auto;
  }
  .panel-body {
    position: relative;
    isolation: isolate;
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  .resource-placeholder { display: flex; flex: 1; align-items: center; justify-content: center; padding: 24px; color: var(--text-muted); background: var(--bg-secondary); font-size: var(--font-size-sm); }
</style>
