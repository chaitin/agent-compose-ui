<script lang="ts">
  import { store } from '../../lib/stores.svelte';
  import { yamlToSpec } from '../../lib/yaml';
  import { buildFileSources, type ProjectImageFileSource } from '../../lib/project-image-files';
  import { WorkspaceFileStore } from '../../lib/workspace/store.svelte';
  import {
    getProjectBindingOverride,
    legacyKeyFromSourcePath,
    projectStorageErrorMessage,
    workspaceBindings,
    type ProjectStorageBinding,
  } from '../../lib/workspace/bindings';
  import WorkspaceUpload from '../workspace/WorkspaceUpload.svelte';
  import WorkspaceFileTree from '../workspace/WorkspaceFileTree.svelte';

  interface Props {
    yaml?: string;
    projectIdentity?: string;
    bindingProjectKey?: string;
    bindingSourcePath?: string;
    bindingLegacyKey?: string;
    onBindingResolved?: (binding: ProjectStorageBinding, identity: string) => void;
  }

  let {
    yaml = store.editorContent,
    projectIdentity = '',
    bindingProjectKey = '',
    bindingSourcePath = '',
    bindingLegacyKey = '',
    onBindingResolved = () => {},
  }: Props = $props();

  let imageFiles = $state.raw(new WorkspaceFileStore());
  let selectedAgent = $state('');
  let bindingError = $state('');
  let bindingLoading = $state(false);
  let bindingGeneration = 0;
  let observedBindingContext = '';

  const sources = $derived.by((): ProjectImageFileSource[] => {
    const parsed = yamlToSpec(yaml);
    return parsed.error ? [] : buildFileSources(parsed.spec);
  });
  const selected = $derived(sources.find((item) => item.agentName === selectedAgent) ?? sources[0]);
  const dockerfileReady = $derived(Boolean(selected?.manageable && imageFiles.hasFile(selected.dockerfile)));
  const fileStorageError = $derived(imageFiles.lastError?.message || '');

  $effect(() => {
    if (sources.length === 0) selectedAgent = '';
    else if (!sources.some((item) => item.agentName === selectedAgent)) selectedAgent = sources[0].agentName;
  });

  $effect(() => {
    const source = selected;
    const context = [source?.agentName, source?.storagePath, source?.manageable, projectIdentity, bindingProjectKey, bindingSourcePath, bindingLegacyKey].join('\0');
    if (context === observedBindingContext) return;
    observedBindingContext = context;
    const generation = ++bindingGeneration;
    imageFiles = new WorkspaceFileStore();
    if (!source?.manageable) {
      bindingError = '';
      bindingLoading = false;
      return;
    }
    bindingLoading = true;
    void resolveBinding(source, context, generation, imageFiles);
  });

  async function resolveBinding(source: ProjectImageFileSource, context: string, generation: number, files: WorkspaceFileStore): Promise<void> {
    bindingError = '';
    let identity = projectIdentity;
    let projectKey = bindingProjectKey;
    let sourcePath = bindingSourcePath;
    let legacyKey = bindingLegacyKey;
    let draftId = '';

    if (!identity) {
      const projectId = store.activeProjectId;
      if (!projectId && !store.activeDraftId) store.ensureEditorDraftSourcePath();
      draftId = store.activeDraftId;
      const draft = store.activeDraftBinding();
      sourcePath = projectId
        ? getProjectBindingOverride(projectId)?.sourcePath || store.projects.find((item) => item.summary.projectId === projectId)?.summary.sourcePath || ''
        : draft.sourcePath || '';
      projectKey = projectId ? '' : draft.projectKey || '';
      legacyKey = projectId ? legacyKeyFromSourcePath(sourcePath) : store.browserDrafts.find((item) => item.id === draftId)?.legacyStorageKey || '';
      identity = projectId ? `project:${projectId}` : `draft:${draftId}`;
    }

    legacyKey ||= legacyKeyFromSourcePath(sourcePath);

    const imageIdentity = identity.endsWith(':images') ? identity : `${identity}:images`;
    try {
      const projectId = identity.startsWith('project:') ? identity.slice('project:'.length).replace(/:images$/, '') : '';
      const override = projectId ? getProjectBindingOverride(projectId) : undefined;
      const binding = override ?? await workspaceBindings.ensure(imageIdentity, {
        projectKey: projectKey || undefined,
        sourcePath: sourcePath || undefined,
        legacyKey: legacyKey || undefined,
      });
      if (generation !== bindingGeneration || context !== observedBindingContext) return;
      if (!projectId && draftId) store.persistActiveDraftBinding(binding, draftId);
      onBindingResolved(binding, identity);
      files.setWorkspace(binding.projectKey, source.storagePath);
    } catch (error) {
      if (generation !== bindingGeneration || context !== observedBindingContext) return;
      bindingError = projectStorageErrorMessage(error);
    } finally {
      if (generation === bindingGeneration && context === observedBindingContext) bindingLoading = false;
    }
  }

  function selectFile(path: string) {
    imageFiles.activePath = path;
  }
</script>

<div class="image-panel">
  {#if sources.length === 0}
    <div class="empty"><strong>暂无镜像构建配置</strong><span>在 YAML 的智能体中配置 <code>image</code> 和 <code>build</code> 后，可在这里上传源码与 Dockerfile。</span></div>
  {:else}
    <aside class="image-list" aria-label="镜像构建列表">
      {#each sources as source (source.agentName)}
        <button type="button" class:active={selected?.agentName === source.agentName} onclick={() => selectedAgent = source.agentName}>
          <span class="image-name">{source.imageRef || '未配置镜像名称'}</span><span class="agent-name">{source.agentName}</span>
          <i class:ready={source.agentName === selected?.agentName && !bindingLoading && dockerfileReady}>{source.error ? '需调整' : source.agentName === selected?.agentName && bindingLoading ? '解析中' : source.agentName === selected?.agentName && dockerfileReady ? '已就绪' : '待检查'}</i>
        </button>
      {/each}
    </aside>
    {#if selected}
      <section class="image-detail">
        <header><div><strong>{selected.imageRef || '未配置镜像名称'}</strong><span>智能体 {selected.agentName}</span></div>{#if selected.manageable && !bindingLoading && !bindingError && !fileStorageError}<WorkspaceUpload files={imageFiles} locationLabel="镜像项目目录" stripFolderRoot={true} />{/if}</header>
        <div class="path-summary"><span>上传位置 <code>{selected.context}</code></span><span>构建文件 <code>{selected.dockerfile}</code></span>{#if bindingLoading}<b class="missing">● 正在解析</b>{:else if fileStorageError}<b class="missing">● 文件状态不可用</b>{:else if dockerfileReady}<b>● 文件已就绪</b>{:else}<b class="missing">● 缺少 {selected.dockerfile}</b>{/if}</div>
        {#if bindingLoading}<div class="empty" role="status">正在解析项目存储…</div>
        {:else if selected.error || bindingError || fileStorageError}<div class="error" role="alert">{selected.error || bindingError || fileStorageError}</div>
        {:else}<div class="files"><WorkspaceFileTree files={imageFiles.files} activePath={imageFiles.activePath} onSelect={selectFile} /><div class="guide"><strong>{dockerfileReady ? '镜像项目文件已关联' : `请上传包含 ${selected.dockerfile} 的完整项目目录`}</strong><span>页面会把文件保存到 YAML 的 <code>build.context</code>，点击“启用”后自动构建镜像。</span>{#if imageFiles.activePath}<code class="selected-file">{imageFiles.activePath}</code>{/if}</div></div>{/if}
      </section>
    {/if}
  {/if}
</div>

<style>
  .image-panel{display:flex;flex:1;min-width:0;min-height:0;background:var(--bg-primary)}.image-list{width:240px;flex-shrink:0;border-right:1px solid var(--border-color);padding:6px 0;overflow:auto}.image-list button{width:100%;border:0;border-left:2px solid transparent;background:transparent;color:var(--text-secondary);padding:8px 12px;display:grid;grid-template-columns:1fr auto;gap:3px 8px;text-align:left;cursor:pointer}.image-list button:hover,.image-list button.active{background:var(--bg-tertiary);color:var(--text-primary)}.image-list button.active{border-left-color:var(--accent-blue)}.image-name{font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.agent-name{grid-row:2;font-size:10px;color:var(--text-muted)}.image-list i{grid-column:2;grid-row:1/3;align-self:center;font-size:10px;color:var(--accent-yellow);font-style:normal}.image-list i.ready{color:var(--accent-green)}.image-detail{flex:1;min-width:0;display:flex;flex-direction:column}header,.path-summary{display:flex;align-items:center;gap:12px;padding:8px 14px;border-bottom:1px solid var(--border-color);background:var(--bg-secondary)}header{justify-content:space-between}header div{display:flex;align-items:baseline;gap:10px}header strong{font-family:var(--font-mono);color:var(--text-primary)}header span,.path-summary{font-size:var(--font-size-xs);color:var(--text-muted)}.path-summary{background:color-mix(in srgb,var(--accent-blue) 6%,var(--bg-secondary))}.path-summary code{color:var(--accent-blue);font-family:var(--font-mono)}.path-summary b{margin-left:auto;color:var(--accent-green);font-size:var(--font-size-xs)}.path-summary b.missing{color:var(--accent-yellow)}.files{display:flex;flex:1;min-height:0}.files :global(.workspace-tree){width:280px;flex:none;border-right:1px solid var(--border-color)}.guide,.empty,.error{flex:1;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:8px;padding:24px;text-align:center;color:var(--text-muted);font-size:var(--font-size-sm)}.guide strong,.empty strong{color:var(--text-secondary)}.guide code,.empty code{color:var(--accent-blue);font-family:var(--font-mono)}.selected-file{margin-top:8px;padding:5px 8px;background:var(--bg-tertiary);border:1px solid var(--border-color)}.error{color:var(--accent-red)}
</style>
