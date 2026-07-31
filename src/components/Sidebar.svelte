<script lang="ts">
  import { store } from '../lib/stores.svelte';
  import { projectService, sandboxService } from '../lib/rpc';
  import { specToYaml, EMPTY_YAML_TEMPLATE, yamlToSpec } from '../lib/yaml';
  import { cascadeDeleteProject } from '../lib/toolbar-actions';
  import {
    ListProjectsRequest,
    GetProjectRequest,
    ProjectRef,
    type ProjectSummary,
  } from '../gen/agentcompose/v2/agentcompose_pb';
  import { onMount } from 'svelte';
  import type { ProjectEntry } from '../lib/types';
  import { deduplicateProjectEntries } from '../lib/projects';
  import { scriptApi, ScriptApiError, scriptErrorMessage } from '../lib/scripts/api';
  import { scriptWorkspace } from '../lib/scripts/workspace.svelte';
  import { restoreProjectScripts } from '../lib/scripts/project-lifecycle';
  import { getProjectEnvStatus } from '../lib/project-env-status';

  let deletingProjectId = $state('');

  const cascadeDeleteClient = {
    listSandboxes: sandboxService.listSandboxes.bind(sandboxService),
    removeSandbox: sandboxService.removeSandbox.bind(sandboxService),
    removeProject: projectService.removeProject.bind(projectService),
  };

  const PAGE_SIZE = 10;
  let filterText = $state('');
  let visibleProjects: ProjectEntry[] = $state([]);
  let projectOffset = $state(0);
  let hasMore = $state(false);
  let filterLoading = $state(false);
  let pendingSync = $state<Record<string, boolean>>({});
  let filterTimer: ReturnType<typeof setTimeout> | undefined;
  let requestGeneration = 0;
  let visibleDrafts = $derived(store.browserDrafts.filter((draft) => (
    !store.projects.some((project) => (
      !!draft.sourcePath?.trim() && project.summary.sourcePath?.trim() === draft.sourcePath.trim()
    )) && (!filterText.trim() || draft.name.toLocaleLowerCase().includes(filterText.trim().toLocaleLowerCase()))
  )));
  let filterEmpty = $derived(filterText.trim() !== '' && !filterLoading && visibleProjects.length === 0 && visibleDrafts.length === 0);

  function onFilterInput(event: Event) {
    filterText = (event.currentTarget as HTMLInputElement).value;
    if (filterTimer) clearTimeout(filterTimer);
    filterTimer = setTimeout(() => { void loadProjects(true); }, 250);
  }

  function clearFilter() {
    filterText = '';
    void loadProjects(true);
  }

  function loadMore() {
    void loadProjects(false);
  }

  async function loadProjects(reset = true) {
    const generation = ++requestGeneration;
    filterLoading = true;
    try {
      const resp = await projectService.listProjects(new ListProjectsRequest({
        query: filterText.trim(),
        offset: reset ? 0 : projectOffset,
        limit: PAGE_SIZE,
      }));
      if (generation !== requestGeneration) return [];

      const summaries: ProjectSummary[] = resp.projects;
      const entries = deduplicateProjectEntries(summaries.map(p => ({
        summary: {
          projectId: p.projectId,
          name: p.name,
          sourcePath: p.sourcePath,
          currentRevision: p.currentRevision,
          specHash: p.specHash,
          agentCount: p.agentCount,
          schedulerCount: p.schedulerCount,
          runningRunCount: p.runningRunCount,
          latestRunId: p.latestRunId,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        },
        source: { composePath: p.sourcePath || '', projectDir: '' },
        yamlContent: '',
        dirty: false,
      })) as ProjectEntry[]);
      visibleProjects = reset ? entries : deduplicateProjectEntries([...visibleProjects, ...entries]);
      projectOffset = resp.nextOffset || visibleProjects.length;
      hasMore = resp.hasMore;
      store.projects = deduplicateProjectEntries([...store.projects, ...entries]);
      void loadProjectStatuses(entries, generation, reset);
      return entries;
    } finally {
      if (generation === requestGeneration) filterLoading = false;
    }
  }

  async function loadProjectStatuses(entries: ProjectEntry[], generation: number, reset: boolean) {
    const statuses = await Promise.all(entries.map(async (entry) => {
        try {
          const status = await getProjectEnvStatus(entry.summary.projectId);
          return [entry.summary.projectId, status.pendingSync] as const;
        } catch {
          return [entry.summary.projectId, false] as const;
        }
    }));
    if (generation !== requestGeneration) return;
    pendingSync = reset ? Object.fromEntries(statuses) : { ...pendingSync, ...Object.fromEntries(statuses) };
  }

  async function loadProjectsWithToast() {
    try {
      return await loadProjects();
    } catch (e: any) {
      store.addToast(`加载智能体应用失败: ${e.message}`, 'error');
      throw e;
    }
  }

  let contentLoadGeneration = 0;

  async function loadProjectContent(id: string) {
    // Latest write wins: a stale load (e.g. onMount racing with a user click)
    // must not overwrite a newer selection.
    const gen = ++contentLoadGeneration;
    // Prefer the per-project cache of the raw YAML so `${VAR}` / `$ref:`
    // references survive instead of the backend-expanded snapshot.
    const saved = store.loadProjectEditor(id);
    if (saved !== null) {
      if (gen !== contentLoadGeneration) return;
      store.editorContent = saved;
      const projectName = yamlToSpec(saved).spec.name?.trim() ?? '';
      scriptWorkspace.resetForProject(id, projectName);
      return;
    }
    // Fall back to loading from backend (expanded values; do not cache).
    try {
      const req = new GetProjectRequest({
        project: new ProjectRef({ projectId: id }),
        includeSpec: true,
      });
      const resp: any = await projectService.getProject(req);
      if (gen !== contentLoadGeneration) return;
      if (resp.project?.spec) {
        const projectName: string = resp.project.spec.name ?? '';
        const daemonYaml = specToYaml(resp.project.spec);
        scriptWorkspace.resetForProject(id, projectName);
        try {
          const restored = await restoreProjectScripts({ projectId: id, daemonYaml, api: scriptApi });
          if (gen !== contentLoadGeneration) return;
          store.editorContent = restored.yamlText;
          scriptWorkspace.warnings = restored.warnings;
        } catch (error) {
          if (gen !== contentLoadGeneration) return;
          // Script service unavailable or manifest corrupt: keep daemon YAML, warn non-blocking
          store.editorContent = daemonYaml;
          scriptWorkspace.warnings = [];
          const message = scriptErrorMessage(error);
          store.addToast(`已加载项目，但${message}，脚本以内联形式显示`, 'info');
        }
      }
    } catch {
      // project may not exist yet, keep current content
    }
  }

  function selectProject(id: string) {
    store.activeProjectId = id;
    store.runtimeView = { level: 'agents', agentName: '', runId: '', sessionId: '' };
    store.goTo('project');
    loadProjectContent(id);
  }

  function selectDraft(draftId: string) {
    const draft = store.selectEditorDraft(draftId);
    if (!draft) return;
    store.runtimeView = { level: 'agents', agentName: '', runId: '', sessionId: '' };
    scriptWorkspace.resetForProject('', draft.name === '未命名草稿' ? '' : draft.name);
    store.goTo('project');
  }

  function deleteDraft(event: MouseEvent, draftId: string, name: string) {
    event.stopPropagation();
    if (!window.confirm(`确定删除本地草稿 "${name}" 吗？`)) return;
    const editingDraft = store.currentPage === 'project'
      && !store.activeProjectId
      && store.activeDraftId === draftId;
    store.removeEditorDraft(draftId);
    if (editingDraft) {
      store.editorContent = EMPTY_YAML_TEMPLATE;
      scriptWorkspace.resetForProject('', '');
    }
    store.addToast(`草稿 "${name}" 已删除`, 'success');
  }

  async function handleDeleteProject(event: MouseEvent, project: ProjectEntry) {
    event.stopPropagation();
    if (deletingProjectId) return;

    const sourcePath = project.summary.sourcePath || '未知来源路径';
    const confirmed = window.confirm(
      `确定删除智能体应用 "${project.summary.name}" 吗？\n\n来源：${sourcePath}\n\n此操作会停用 Trigger 并移除项目定义、关联 Sandbox 与脚本目录，运行历史将保留。Sandbox 清理失败时项目不会被删除。`,
    );
    if (!confirmed) return;

    const projectId = project.summary.projectId;
    deletingProjectId = projectId;
    try {
      const { removedSandboxes } = await cascadeDeleteProject(projectId, cascadeDeleteClient);
      let scriptCleanupError = '';
      try {
        await scriptApi.deleteProject(projectId);
      } catch (error) {
        if (!(error instanceof ScriptApiError && error.code === 'NOT_FOUND')) {
          scriptCleanupError = scriptErrorMessage(error);
        }
      }
      store.projects = store.projects.filter(p => p.summary.projectId !== projectId);
      if (store.activeProjectId === projectId) {
        store.removeProjectEditor(projectId);
        store.activeProjectId = '';
        store.editorContent = EMPTY_YAML_TEMPLATE;
        store.runtimeView = { level: 'agents', agentName: '', runId: '', sessionId: '' };
        scriptWorkspace.resetForProject('', '');
        store.goTo('project');
      }
      await loadProjects(true);
      if (scriptCleanupError) store.addToast(`智能体应用已删除，但脚本目录清理失败：${scriptCleanupError}`, 'error');
      else store.addToast(`智能体应用 "${project.summary.name}" 已停用并移除，${removedSandboxes} 个关联 Sandbox 与脚本目录已删除；运行历史已保留`, 'success');
    } catch (e: any) {
      const message = String(e?.message || '未知错误');
      if (message.toLowerCase().includes('unimplemented')) {
        store.addToast('当前后端不支持删除智能体应用，请升级后端后重试', 'error');
      } else {
        store.addToast(`删除智能体应用失败: ${message}`, 'error');
      }
    } finally {
      deletingProjectId = '';
    }
  }

  function navigateToNewProject() {
    store.beginEditorDraft();
    store.runtimeView = { level: 'agents', agentName: '', runId: '', sessionId: '' };
    scriptWorkspace.resetForProject('', '');
    store.goTo('project');
  }

  // Expose refresh globally so Toolbar can trigger a reload after Apply
  onMount(() => {
    void loadProjectsWithToast().catch(() => {});
    // Reload the active project's editor from the per-project cache (or backend)
    // so a page refresh doesn't show the global single-entry fallback content.
    if (store.activeProjectId) void loadProjectContent(store.activeProjectId);
    (window as any).__refreshProjects = loadProjects;
    return () => {
      if (filterTimer) clearTimeout(filterTimer);
      delete (window as any).__refreshProjects;
    };
  });
</script>

<nav class="sidebar">
  <div class="brand">
    <span class="logo">&blacktriangleright;</span>
    <span class="title">Agent Compose</span>
  </div>

  <div class="nav-section project-section" aria-labelledby="project-list-heading">
    <div class="section-header" id="project-list-heading">智能体应用</div>
    <div class="filter-box">
      <input
        class="project-filter"
        type="text"
        placeholder="筛选应用…"
        value={filterText}
        oninput={onFilterInput}
        aria-label="筛选智能体应用"
      />
      {#if filterText}
        <button
          class="filter-clear"
          type="button"
          onclick={clearFilter}
          aria-label="清除筛选"
          title="清除筛选"
        >×</button>
      {/if}
    </div>
    {#each visibleDrafts as draft (draft.id)}
      <div class="project-row draft-row" class:active={store.currentPage === 'project' && !store.activeProjectId && store.activeDraftId === draft.id}>
        <button class="nav-item project" onclick={() => selectDraft(draft.id)} title={`本地草稿：${draft.name}`}>
          <span class="status draft"></span>
          <span class="project-name">{draft.name}</span>
          <span class="draft-badge">草稿</span>
        </button>
        <button
          class="project-delete"
          onclick={(event) => deleteDraft(event, draft.id, draft.name)}
          title={`删除草稿 ${draft.name}`}
          aria-label={`删除草稿 ${draft.name}`}
        >
          <svg class="delete-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-2 6h10l-1 11H8L7 9Zm3 2v7h2v-7h-2Zm4 0v7h2v-7h-2Z" />
          </svg>
        </button>
      </div>
    {/each}
    {#each visibleProjects as p (p.summary.projectId)}
      <div
        class="project-row"
        class:active={store.currentPage === 'project' && store.activeProjectId === p.summary.projectId}
      >
        <button
          class="nav-item project"
          onclick={() => selectProject(p.summary.projectId)}
          title={p.summary.sourcePath || p.summary.name}
        >
          <span class="status" class:running={!!p.summary.runningRunCount}></span>
          <span class="project-name">{p.summary.name}</span>
          {#if pendingSync[p.summary.projectId]}
            <span class="sync-badge" title="全局变量已更新；保存或启用项目后同步最新值">变量已更新，待同步</span>
          {/if}
          {#if p.summary.runningRunCount}
            <span class="badge">{p.summary.runningRunCount}</span>
          {/if}
        </button>
        <button
          class="project-delete"
          onclick={(event) => handleDeleteProject(event, p)}
          disabled={!!deletingProjectId}
          title={`删除智能体应用 ${p.summary.name}`}
          aria-label={`删除智能体应用 ${p.summary.name}`}
        >
          {#if deletingProjectId === p.summary.projectId}
            <span class="delete-progress" aria-hidden="true">…</span>
          {:else}
            <svg class="delete-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-2 6h10l-1 11H8L7 9Zm3 2v7h2v-7h-2Zm4 0v7h2v-7h-2Z" />
            </svg>
          {/if}
        </button>
      </div>
    {/each}
    {#if filterEmpty}
      <div class="empty-hint">无匹配的智能体应用</div>
    {/if}
  </div>

  <div class="project-actions">
    {#if hasMore}
      <button class="load-more-btn" type="button" onclick={loadMore} disabled={filterLoading}>
        {filterLoading ? '加载中…' : '加载更多'}
      </button>
    {/if}
    <button class="new-project-btn" onclick={navigateToNewProject}>
      + 新建智能体应用
    </button>
  </div>

  <div class="divider"></div>

  <div class="nav-section bottom">
    <button
      class="nav-item"
      class:active={store.currentPage === 'images' || store.currentPage === 'environment' || store.currentPage === 'settings'}
      onclick={() => store.goTo('images')}
    >
      <span class="icon">&#9881;</span> 系统管理
    </button>
    <a
      class="nav-item"
      href="https://devboard.chaitin.net/devboard/issues?product_id=6a5f3c14839f64bb543f172d"
      target="_blank"
      rel="noopener noreferrer"
    >
      <span class="icon" aria-hidden="true">&#9993;</span> 反馈
    </a>
  </div>
</nav>

<style>
  .sidebar {
    width: var(--sidebar-width);
    min-width: var(--sidebar-width);
    height: 100%;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    background: var(--bg-secondary);
    border-right: 1px solid var(--border-color);
  }
  .brand {
    min-height: 46px;
    padding: 0 12px;
    display: flex;
    align-items: center;
    gap: 8px;
    border-bottom: 1px solid var(--border-color);
    font-size: var(--font-size-md);
    font-weight: 600;
    letter-spacing: -0.2px;
  }
  .logo { color: var(--accent-green); font-size: 16px; }
  .title { color: var(--text-primary); }
  .nav-section { padding: 4px 7px; }
  .project-section {
    min-height: 0;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--border-color) transparent;
  }
  .nav-section.bottom { margin-top: auto; padding-bottom: 8px; }
  .section-header {
    padding: 8px 7px 5px;
    font-size: var(--font-size-md);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
  }
  .filter-box {
    position: relative;
    padding: 0 0 6px;
  }
  .project-filter {
    width: 100%;
    height: 30px;
    padding: 0 24px 0 8px;
    font-size: var(--font-size-md);
  }
  .filter-clear {
    position: absolute;
    right: 4px;
    top: 50%;
    transform: translateY(-50%);
    width: 16px;
    height: 16px;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-muted);
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
  }
  .filter-clear:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }
  .empty-hint {
    padding: 7px;
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    text-align: center;
  }
  .divider {
    margin: 3px 10px;
    border-top: 1px solid var(--border-color);
  }
  .nav-item {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    min-height: 30px;
    padding: 4px 7px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    text-align: left;
    text-decoration: none;
    font-size: var(--font-size-md);
    transition: background 0.1s;
    cursor: pointer;
  }
  .nav-item:hover { background: var(--bg-tertiary); color: var(--text-primary); }
  .nav-item.active { background: var(--bg-tertiary); color: var(--text-primary); }
  .project-row {
    position: relative;
    display: flex;
    align-items: center;
    min-height: 30px;
    border-radius: 4px;
  }
  .project-row:hover, .project-row:focus-within, .project-row.active {
    background: var(--bg-tertiary);
  }
  .project-row.active .nav-item { color: var(--text-primary); }
  .project-row.active::before {
    content: '';
    position: absolute;
    inset: 5px auto 5px 0;
    width: 2px;
    border-radius: 2px;
    background: var(--accent-green);
  }
  .project-row .nav-item { min-width: 0; }
  .project-row .nav-item:hover { background: transparent; }
  .project-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
  }
  .project-delete {
    display: none;
    width: 22px;
    height: 22px;
    margin-right: 3px;
    flex-shrink: 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    line-height: 1;
  }
  .delete-icon {
    width: 15px;
    height: 15px;
    display: block;
    margin: auto;
    fill: currentColor;
  }
  .delete-progress {
    display: block;
    font-size: 16px;
    line-height: 1;
  }
  .project-row:hover .project-delete,
  .project-row:focus-within .project-delete,
  .project-delete:disabled {
    display: block;
  }
  .project-delete:hover:not(:disabled) {
    background: rgba(248, 81, 73, 0.15);
    color: var(--accent-red);
  }
  .project-delete:disabled { cursor: wait; opacity: 0.6; }
  .nav-item:focus-visible,
  .project-filter:focus-visible,
  .filter-clear:focus-visible,
  .project-delete:focus-visible,
  .load-more-btn:focus-visible,
  .new-project-btn:focus-visible {
    outline: 2px solid var(--accent-blue);
    outline-offset: -2px;
  }
  .nav-item .icon { font-size: 14px; width: 18px; text-align: center; }
  .status {
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--text-muted);
    flex-shrink: 0;
  }
  .status.running { background: var(--accent-green); box-shadow: 0 0 4px var(--accent-green); }
  .status.draft { background: var(--accent-yellow); }
  .draft-badge {
    margin-left: auto;
    padding: 1px 5px;
    border: 1px solid color-mix(in srgb, var(--accent-yellow) 45%, var(--border-color));
    border-radius: 8px;
    color: var(--accent-yellow);
    font-size: var(--font-size-xs);
    line-height: 1.2;
  }
  .badge {
    margin-left: auto;
    background: var(--accent-green);
    color: #000;
    font-size: var(--font-size-xs);
    font-weight: 600;
    padding: 1px 5px;
    border-radius: 8px;
    min-width: 16px;
    text-align: center;
  }
  .sync-badge {
    margin-left: auto;
    padding: 1px 5px;
    border: 1px solid color-mix(in srgb, var(--accent-yellow) 45%, var(--border-color));
    border-radius: 8px;
    color: var(--accent-yellow);
    font-size: var(--font-size-xs);
    line-height: 1.2;
    white-space: nowrap;
  }
  .sync-badge + .badge { margin-left: 0; }
  .project-actions {
    flex-shrink: 0;
    margin: 0 7px;
    padding: 6px 0 4px;
    border-top: 1px solid var(--border-color);
  }
  .load-more-btn,
  .new-project-btn {
    width: 100%;
    min-height: 30px;
    padding: 4px 7px;
    border-radius: 4px;
    font-size: var(--font-size-sm);
    cursor: pointer;
    text-align: center;
  }
  .load-more-btn {
    display: block;
    margin: 0 0 3px;
    border: 1px solid var(--border-color);
    background: var(--bg-primary);
    color: var(--text-muted);
    transition: border-color 0.15s, color 0.15s, background 0.15s;
  }
  .load-more-btn:hover {
    background: var(--bg-tertiary);
    border-color: var(--text-muted);
    color: var(--text-primary);
  }
  .new-project-btn {
    margin-top: 0;
    border: 1px solid color-mix(in srgb, var(--accent-green) 10%, var(--border-color));
    background: var(--bg-primary);
    color: var(--text-muted);
    transition: border-color 0.15s, color 0.15s;
  }
  .new-project-btn:hover,
  .new-project-btn:active {
    border-color: color-mix(in srgb, var(--accent-green) 30%, var(--border-color));
    color: var(--text-primary);
  }
</style>
