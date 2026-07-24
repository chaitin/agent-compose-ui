<script lang="ts">
  import { mount, onMount, unmount } from 'svelte';
  import { untrack } from 'svelte';
  import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
  import * as monaco from 'monaco-editor';
  import { store } from '../lib/stores.svelte';
  import { countAgents, countSchedulers, yamlToSpec } from '../lib/yaml';
  import Toolbar from './Toolbar.svelte';
  import ResourcePanel from './ResourcePanel.svelte';
  import ScriptLineActions from './scripts/ScriptLineActions.svelte';
  import ScriptReferenceModal from './scripts/ScriptReferenceModal.svelte';
  import WorkspaceLineActions from './workspace/WorkspaceLineActions.svelte';
  import GlobalEnvLineAction from './env/GlobalEnvLineAction.svelte';
  import ConfigureGlobalEnvModal from './env/ConfigureGlobalEnvModal.svelte';
  import { GetGlobalEnvRequest } from '../gen/agentcompose/v2/agentcompose_pb';
  import { settingsService } from '../lib/rpc';
  import { missingAgentEnvReferences, type AgentEnvReference } from '../lib/yaml-env-references';
  import { scriptWorkspace } from '../lib/scripts/workspace.svelte';
  import { scriptApi, scriptErrorMessage } from '../lib/scripts/api';
  import { collectScriptFiles } from '../lib/scripts/tree';
  import {
    defaultScriptPath,
    extractInlineScript,
    findScriptAtLine,
    initializeInlineScript,
    inlineScriptReference,
    listScriptRanges,
    referenceExistingScript,
    type ScriptLocation,
    type ScriptRange,
  } from '../lib/scripts/editor-actions';
  import {
    findWorkspaceLine,
    parseWorkspaceBinding,
    defaultWorkspacePath,
    type WorkspaceBinding,
  } from '../lib/workspace-binding';
  import { createWorkspaceAndBind } from '../lib/workspace-create';

  self.MonacoEnvironment = {
    getWorker: () => new EditorWorker(),
  };

  type ModalRequest =
    | { mode: 'extract'; pointer: string; defaultPath: string; exists: boolean }
    | { mode: 'reference'; pointer: string };

  interface MountedActionWidget {
    widget: monaco.editor.IContentWidget;
    component: ReturnType<typeof mount>;
  }

  const ACTION_RIGHT_GAP = 12;

  type WorkspaceBindingKind = 'non-file' | 'none' | 'valid';

  let container = $state<HTMLDivElement>();
  let editor = $state<monaco.editor.IStandaloneCodeEditor | null>(null);
  let modalRequest = $state<ModalRequest | null>(null);
  let modalBusy = $state(false);
  let ignoreChanges = false;
  let decorationIds: string[] = [];
  let actionWidgets: MountedActionWidget[] = [];
  let workspaceWidget: MountedActionWidget | null = null;
  let workspaceWidgetKey = '';
  let envWidgets: MountedActionWidget[] = [];
  let envDecorationIds: string[] = [];
  let configuredGlobalNames = $state<string[]>([]);
  let globalEnvLoaded = $state(false);
  let envModal = $state<{ agentName: string; names: string[] } | null>(null);
  let updateScriptActionContext = () => {};

  let agentCount = $derived(countAgents(store.editorContent));
  let schedulerCount = $derived(countSchedulers(store.editorContent));

  async function loadGlobalEnv(): Promise<void> {
    try {
      configuredGlobalNames = (await settingsService.getGlobalEnv(new GetGlobalEnvRequest())).env.map((item) => item.name);
      globalEnvLoaded = true;
    } catch {
      // The editor remains usable when settings are temporarily unavailable.
      globalEnvLoaded = false;
    }
  }

  onMount(() => { void loadGlobalEnv(); });

  async function configureAgentEnv(agentName: string): Promise<void> {
    await loadGlobalEnv();
    if (!globalEnvLoaded) {
      store.addToast('无法读取全局环境变量，请稍后重试', 'error');
      return;
    }
    const names = [...new Set(missingAgentEnvReferences(store.editorContent, configuredGlobalNames)
      .filter((item) => item.agentName === agentName)
      .flatMap((item) => item.names))];
    if (!names.length) {
      store.addToast('该 Agent 引用的全局环境变量已配置', 'success');
      return;
    }
    envModal = { agentName, names };
  }

  function globalEnvSaved(names: string[]): void {
    configuredGlobalNames = [...new Set([...configuredGlobalNames, ...names])];
    envModal = null;
    store.addToast(`已保存 ${names.length} 个全局环境变量；项目将在下次保存或启用时同步`, 'success');
    void loadGlobalEnv();
  }

  function locationAtCursor(): ScriptLocation | null {
    if (!editor) return null;
    const position = editor.getPosition();
    if (!position) return null;
    return findScriptAtLine(store.editorContent, position.lineNumber);
  }

  function scriptMessage(error: unknown): string {
    return scriptErrorMessage(error);
  }

  async function openScript(path: string): Promise<void> {
    try {
      scriptWorkspace.panelOpen = true;
      await scriptWorkspace.openFile(path);
    } catch (error) {
      store.addToast('打开失败：' + scriptMessage(error), 'error');
    }
  }

  function isEmptyInlineScript(range: ScriptRange | undefined): boolean {
    return range?.kind === 'inline' && range.content.trim() === '';
  }

  function rangeAtPointer(pointer: string): ScriptRange | undefined {
    return listScriptRanges(store.editorContent).find((range) => range.pointer === pointer);
  }

  function projectName(): string {
    return scriptWorkspace.projectName || (yamlToSpec(store.editorContent).spec.name?.trim() ?? '');
  }

  function targetScriptPath(pointer: string): string {
    return defaultScriptPath(pointer, projectName());
  }

  function scriptFileExists(pointer: string): boolean {
    const target = targetScriptPath(pointer);
    const files = collectScriptFiles(scriptWorkspace.tree);
    return files.some((f) => f.path === target);
  }

  function requestExtract(range: Extract<ScriptRange, { kind: 'inline' }>): void {
    if (isEmptyInlineScript(range)) return;
    const exists = scriptFileExists(range.pointer);
    modalRequest = {
      mode: 'extract',
      pointer: range.pointer,
      defaultPath: targetScriptPath(range.pointer),
      exists,
    };
  }

  function chooseInline(range: Extract<ScriptRange, { kind: 'inline' }>): void {
    if (!isEmptyInlineScript(range)) return;
    store.commitEditorContent(initializeInlineScript(store.editorContent, range.pointer));
  }

  async function requestReference(pointer: string): Promise<void> {
    const range = rangeAtPointer(pointer);
    if (!range || range.kind !== 'inline' || !isEmptyInlineScript(range)) {
      store.addToast('只有空的 script 才能引用已有文件', 'error');
      return;
    }
    modalRequest = { mode: 'reference', pointer };
    try {
      await scriptWorkspace.refreshTree();
    } catch (error) {
      store.addToast('加载脚本文件失败：' + scriptMessage(error), 'error');
    }
  }

  async function confirmScriptAction(path: string): Promise<void> {
    if (!modalRequest || modalBusy) return;
    const request = modalRequest;
    modalBusy = true;
    try {
      if (request.mode === 'extract') {
        const extracted = extractInlineScript(store.editorContent, request.pointer, path);
        await scriptWorkspace.writeFileForce(path, extracted.content);
        store.commitEditorContent(extracted.yamlText);
        scriptWorkspace.panelOpen = true;
        store.addToast(request.exists ? `已更新 ${path}` : `已提取到 ${path}`, 'success');
      } else {
        const range = rangeAtPointer(request.pointer);
        if (!range || range.kind !== 'inline' || !isEmptyInlineScript(range)) {
          throw new Error('只有空的 script 才能引用已有文件');
        }
        const nextYaml = referenceExistingScript(store.editorContent, request.pointer, path);
        await scriptWorkspace.openFile(path);
        store.commitEditorContent(nextYaml);
        scriptWorkspace.panelOpen = true;
        store.addToast(`已引用 ${path}`, 'success');
      }
      modalRequest = null;
    } catch (error) {
      store.addToast(`${request.mode === 'extract' ? '提取' : '引用'}失败：${scriptMessage(error)}`, 'error');
    } finally {
      modalBusy = false;
    }
  }

  async function inlineRef(pointer: string, path: string): Promise<void> {
    try {
      const file = await scriptApi.readFile(path);
      store.commitEditorContent(inlineScriptReference(store.editorContent, pointer, file.content));
      store.addToast(`已内联 ${path}`, 'success');
    } catch (error) {
      store.addToast('内联失败：' + scriptMessage(error), 'error');
    }
  }

  // Workspace providers that intentionally don't use the local file panel - git/http
  // pull content from remote sources, so we don't prompt the user to switch.
  // Only unknown or unsupported provider names get the warning.
  const KNOWN_NON_FILE_PROVIDERS = new Set(['git', 'http']);

  function bindingKind(binding: WorkspaceBinding | null): WorkspaceBindingKind | null {
    if (!binding) return null;
    if (binding.provider && binding.provider !== 'file') {
      if (KNOWN_NON_FILE_PROVIDERS.has(binding.provider)) return null;
      return 'non-file';
    }
    if (binding.path === '') return 'none';
    return 'valid';
  }

  const currentProject = $derived(store.projects.find(p => p.summary.projectId === store.activeProjectId));
  const projectSourcePath = $derived(currentProject?.summary.sourcePath ?? '');

  async function bindWorkspace(force: boolean): Promise<void> {
    const sourcePath = projectSourcePath;
    try {
      const result = await createWorkspaceAndBind(store.editorContent, sourcePath, { force });
      store.commitEditorContent(result.yaml);
      scriptWorkspace.openWorkspaceTab();
      store.addToast(
        sourcePath
          ? `已绑定 workspace（path=${result.workspacePath}）`
          : `已配置 workspace path，保存项目后即可上传文件`,
        'success',
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      store.addToast(`${force ? '切换' : '绑定'}失败：${msg}`, 'error');
    }
  }

  function clearWorkspaceWidget(target: monaco.editor.IStandaloneCodeEditor): void {
    if (!workspaceWidget) return;
    target.removeContentWidget(workspaceWidget.widget);
    void unmount(workspaceWidget.component);
    workspaceWidget = null;
    workspaceWidgetKey = '';
  }

  function addWorkspaceWidget(
    target: monaco.editor.IStandaloneCodeEditor,
    line: number,
    kind: WorkspaceBindingKind,
    provider?: string,
  ): MountedActionWidget {
    const node = document.createElement('div');
    const component = mount(WorkspaceLineActions, {
      target: node,
      props: {
        kind,
        provider,
        onConvert: () => void bindWorkspace(true),
        onConfigure: () => void bindWorkspace(false),
        onOpen: () => scriptWorkspace.openWorkspaceTab(),
      },
    });
    const widget: monaco.editor.IContentWidget = {
      allowEditorOverflow: false,
      suppressMouseDown: true,
      getId: () => `workspace-line-actions:${line}`,
      getDomNode: () => node,
      getPosition: () => {
        const model = target.getModel();
        if (!model || line > model.getLineCount()) return null;
        return {
          position: { lineNumber: line, column: 1 },
          preference: [monaco.editor.ContentWidgetPositionPreference.EXACT],
        };
      },
      afterRender: (position) => {
        if (position === null) return;
        const layout = target.getLayoutInfo();
        const viewportRight = layout.width - layout.verticalScrollbarWidth - ACTION_RIGHT_GAP;
        const availableWidth = Math.max(0, viewportRight - layout.contentLeft);
        node.style.maxWidth = `${availableWidth}px`;
        const widgetWidth = Math.min(node.offsetWidth, availableWidth);
        const targetLeft = Math.max(0, availableWidth - widgetWidth);
        node.style.transform = `translateX(${targetLeft}px)`;
      },
    };
    target.addContentWidget(widget);
    return { widget, component };
  }

  function refreshWorkspacePresentation(target: monaco.editor.IStandaloneCodeEditor): void {
    const yaml = store.editorContent;
    const line = findWorkspaceLine(yaml);
    if (line === null) {
      clearWorkspaceWidget(target);
      return;
    }

    const binding = parseWorkspaceBinding(yaml);
    // bindingKind returns null for two distinct cases:
    //   - binding itself is null (YAML incomplete while user is typing)
    //   - binding parsed but provider is git/http (intentional remote source)
    // Only the first case falls back to 'none' so the user still has an entry
    // point; the second case hides the button entirely.
    let kind: WorkspaceBindingKind;
    if (binding === null) {
      kind = 'none';
    } else {
      const parsed = bindingKind(binding);
      if (parsed === null) {
        clearWorkspaceWidget(target);
        return;
      }
      kind = parsed;
    }

    const key = `${line}:${kind}`;
    if (key === workspaceWidgetKey && workspaceWidget) return;

    clearWorkspaceWidget(target);
    workspaceWidget = addWorkspaceWidget(target, line, kind, binding?.provider ?? undefined);
    workspaceWidgetKey = key;
  }

  function clearActionWidgets(target: monaco.editor.IStandaloneCodeEditor): void {
    for (const entry of actionWidgets) {
      target.removeContentWidget(entry.widget);
      void unmount(entry.component);
    }
    actionWidgets = [];
  }

  function addActionWidget(
    target: monaco.editor.IStandaloneCodeEditor,
    range: ScriptRange,
  ): MountedActionWidget {
    const node = document.createElement('div');
    const component = mount(ScriptLineActions, {
      target: node,
      props: {
        kind: range.kind,
        empty: isEmptyInlineScript(range),
        fileExists: range.kind === 'inline' && scriptFileExists(range.pointer),
        onMode: () => range.kind === 'inline' && chooseInline(range),
        onExtract: () => range.kind === 'inline' && requestExtract(range),
        onReference: () => void requestReference(range.pointer),
        onInline: () => range.kind === 'reference' && void inlineRef(range.pointer, range.path),
      },
    });
    const widget: monaco.editor.IContentWidget = {
      allowEditorOverflow: false,
      suppressMouseDown: true,
      getId: () => `script-line-actions:${range.pointer}`,
      getDomNode: () => node,
      getPosition: () => {
        const model = target.getModel();
        if (!model || range.startLine > model.getLineCount()) return null;
        return {
          position: {
            lineNumber: range.startLine,
            column: 1,
          },
          preference: [monaco.editor.ContentWidgetPositionPreference.EXACT],
        };
      },
      afterRender: (position) => {
        if (position === null) return;
        const layout = target.getLayoutInfo();
        const viewportRight = layout.width - layout.verticalScrollbarWidth - ACTION_RIGHT_GAP;
        const availableWidth = Math.max(0, viewportRight - layout.contentLeft);
        node.style.maxWidth = `${availableWidth}px`;
        const widgetWidth = Math.min(node.offsetWidth, availableWidth);
        const targetLeft = Math.max(0, availableWidth - widgetWidth);
        node.style.transform = `translateX(${targetLeft}px)`;
      },
    };
    target.addContentWidget(widget);
    return { widget, component };
  }

  function refreshScriptPresentation(target: monaco.editor.IStandaloneCodeEditor): void {
    const ranges = listScriptRanges(store.editorContent);
    const model = target.getModel();
    if (!model) return;

    const decorations: monaco.editor.IModelDeltaDecoration[] = ranges
      .filter((range): range is Extract<ScriptRange, { kind: 'reference' }> => range.kind === 'reference')
      .map((range) => {
        const line = model.getLineContent(range.startLine);
        const refStart = Math.max(0, line.indexOf('$ref:'));
        return {
          range: new monaco.Range(range.startLine, refStart + 1, range.startLine, line.length + 1),
          options: {
            inlineClassName: 'script-ref-link',
            hoverMessage: { value: `脚本文件：\`${range.path}\`\n\n点击打开脚本面板` },
            stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          },
        };
      });
    decorationIds = target.deltaDecorations(decorationIds, decorations);

    clearActionWidgets(target);
    actionWidgets = ranges.map((range) => addActionWidget(target, range));
  }

  function clearEnvWidgets(target: monaco.editor.IStandaloneCodeEditor): void {
    for (const entry of envWidgets) {
      target.removeContentWidget(entry.widget);
      void unmount(entry.component);
    }
    envWidgets = [];
  }

  function addEnvWidget(target: monaco.editor.IStandaloneCodeEditor, reference: AgentEnvReference): MountedActionWidget {
    const node = document.createElement('div');
    const agentNames = [...new Set(missingAgentEnvReferences(store.editorContent, configuredGlobalNames)
      .filter((item) => item.agentName === reference.agentName)
      .flatMap((item) => item.names))];
    const component = mount(GlobalEnvLineAction, {
      target: node,
      props: { count: agentNames.length, onConfigure: () => void configureAgentEnv(reference.agentName) },
    });
    const widget: monaco.editor.IContentWidget = {
      allowEditorOverflow: false,
      suppressMouseDown: true,
      getId: () => `global-env-line-action:${reference.agentName}:${reference.envLine}`,
      getDomNode: () => node,
      getPosition: () => ({
        position: { lineNumber: reference.envLine, column: 1 },
        preference: [monaco.editor.ContentWidgetPositionPreference.EXACT],
      }),
      afterRender: (position) => {
        if (position === null) return;
        const layout = target.getLayoutInfo();
        const availableWidth = Math.max(0, layout.width - layout.verticalScrollbarWidth - ACTION_RIGHT_GAP - layout.contentLeft);
        node.style.maxWidth = `${availableWidth}px`;
        node.style.transform = `translateX(${Math.max(0, availableWidth - Math.min(node.offsetWidth, availableWidth))}px)`;
      },
    };
    target.addContentWidget(widget);
    return { widget, component };
  }

  function refreshEnvPresentation(target: monaco.editor.IStandaloneCodeEditor): void {
    if (!globalEnvLoaded) {
      clearEnvWidgets(target);
      envDecorationIds = target.deltaDecorations(envDecorationIds, []);
      return;
    }
    const references = missingAgentEnvReferences(store.editorContent, configuredGlobalNames);
    clearEnvWidgets(target);
    const agentEntries = [...new Map(references.map((reference) => [reference.agentName, reference])).values()];
    envWidgets = agentEntries.map((reference) => addEnvWidget(target, reference));
    envDecorationIds = target.deltaDecorations(envDecorationIds, references.map((reference) => ({
      range: new monaco.Range(reference.line, reference.startColumn, reference.line, reference.endColumn),
      options: {
        inlineClassName: 'missing-global-env',
        hoverMessage: { value: `全局环境变量 ${reference.names.join('、')} 尚未配置` },
        overviewRuler: { color: 'rgba(210, 153, 34, .8)', position: monaco.editor.OverviewRulerLane.Right },
      },
    })));
  }

  $effect(() => {
    if (!container) return;

    const initial = untrack(() => store.editorContent);
    const e: monaco.editor.IStandaloneCodeEditor = monaco.editor.create(container, {
      value: initial,
      language: 'yaml',
      theme: 'vs-dark',
      fontSize: 13,
      fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)",
      lineNumbers: 'on',
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      wordWrap: 'on',
      tabSize: 2,
      automaticLayout: true,
    });

    const scriptInlineEmptyContext = e.createContextKey('scriptInlineEmpty', false as boolean);
    const scriptInlinePopulatedContext = e.createContextKey('scriptInlinePopulated', false as boolean);
    const scriptReferenceContext = e.createContextKey('scriptReference', false as boolean);
    updateScriptActionContext = () => {
      const position = e.getPosition();
      const location = position
        ? findScriptAtLine(store.editorContent, position.lineNumber)
        : null;
      const inlineContent = location?.kind === 'inline' ? location.content : null;
      scriptInlineEmptyContext.set(inlineContent !== null && inlineContent.trim() === '');
      scriptInlinePopulatedContext.set(inlineContent !== null && inlineContent.trim() !== '');
      scriptReferenceContext.set(location?.kind === 'reference');
    };

    const contentDisposable = e.onDidChangeModelContent(() => {
      if (ignoreChanges) return;
      store.commitEditorContent(e.getValue());
      updateScriptActionContext();
    });
    const cursorDisposable = e.onDidChangeCursorPosition(updateScriptActionContext);

    e.onMouseDown((event) => {
      const position = event.target?.position;
      if (!position) return;
      const location = findScriptAtLine(store.editorContent, position.lineNumber);
      if (location?.kind === 'reference') void openScript(location.path);
    });

    e.addAction({
      id: 'script-open-file',
      label: '打开脚本文件',
      contextMenuGroupId: 'script',
      contextMenuOrder: 1,
      precondition: 'scriptReference',
      run: () => {
        const location = locationAtCursor();
        if (location?.kind === 'reference') void openScript(location.path);
      },
    });

    e.addAction({
      id: 'script-extract-to-file',
      label: '提取到文件',
      contextMenuGroupId: 'script',
      contextMenuOrder: 2,
      precondition: 'scriptInlinePopulated',
      run: () => {
        const position = e.getPosition();
        const range = position
          ? listScriptRanges(store.editorContent).find(
              (candidate) => candidate.kind === 'inline'
                && position.lineNumber >= candidate.startLine
                && position.lineNumber <= candidate.endLine,
            )
          : undefined;
        if (range?.kind === 'inline') requestExtract(range);
      },
    });

    e.addAction({
      id: 'script-reference-existing',
      label: '引用已有文件',
      contextMenuGroupId: 'script',
      contextMenuOrder: 3,
      precondition: 'scriptInlineEmpty',
      run: () => {
        const location = locationAtCursor();
        if (location) void requestReference(location.pointer);
      },
    });

    e.addAction({
      id: 'script-inline-ref',
      label: '转为内联',
      contextMenuGroupId: 'script',
      contextMenuOrder: 4,
      precondition: 'scriptReference',
      run: () => {
        const location = locationAtCursor();
        if (location?.kind === 'reference') void inlineRef(location.pointer, location.path);
      },
    });

    e.addAction({
      id: 'apply-project',
      label: 'Apply 智能体应用',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => document.querySelector<HTMLButtonElement>('.btn-primary')?.click(),
    });

    const relayoutActionWidgets = () => {
      for (const entry of actionWidgets) e.layoutContentWidget(entry.widget);
      for (const entry of envWidgets) e.layoutContentWidget(entry.widget);
      if (workspaceWidget) e.layoutContentWidget(workspaceWidget.widget);
    };
    const scrollDisposable = e.onDidScrollChange(relayoutActionWidgets);
    const layoutDisposable = e.onDidLayoutChange(relayoutActionWidgets);

    editor = e;
    untrack(() => {
      updateScriptActionContext();
      refreshScriptPresentation(e);
      refreshWorkspacePresentation(e);
      refreshEnvPresentation(e);
    });

    return () => {
      contentDisposable.dispose();
      cursorDisposable.dispose();
      scriptInlineEmptyContext.reset();
      scriptInlinePopulatedContext.reset();
      scriptReferenceContext.reset();
      updateScriptActionContext = () => {};
      scrollDisposable.dispose();
      layoutDisposable.dispose();
      clearActionWidgets(e);
      clearWorkspaceWidget(e);
      clearEnvWidgets(e);
      decorationIds = e.deltaDecorations(decorationIds, []);
      envDecorationIds = e.deltaDecorations(envDecorationIds, []);
      e.dispose();
      editor = null;
    };
  });

  $effect(() => {
    const current = store.editorContent;
    if (!editor) return;
    if (editor.getValue() !== current) {
      const scrollTop = editor.getScrollTop();
      const scrollLeft = editor.getScrollLeft();
      const selections = editor.getSelections();
      ignoreChanges = true;
      try {
        editor.setValue(current);
      } finally {
        ignoreChanges = false;
      }
      if (selections?.length) editor.setSelections(selections);
      editor.setScrollPosition({ scrollTop, scrollLeft });
    }
    updateScriptActionContext();
    refreshScriptPresentation(editor);
    refreshWorkspacePresentation(editor);
    refreshEnvPresentation(editor);
  });
</script>

<div class="yaml-editor" class:collapsed={store.editorCollapsed}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="collapse-strip" onclick={() => store.editorCollapsed = false} onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && (store.editorCollapsed = false)} title="点击展开编辑器" role="button" tabindex="0">
    <span class="strip-filename">agent-compose.yml</span>
    <span class="strip-arrow">▶</span>
  </div>

  <div class="yaml-editor-header">
    <span class="filename">agent-compose.yml</span>
    <Toolbar />
  </div>
  <div class="editor-stack">
    <div class="yaml-editor-body" bind:this={container}></div>
    <ResourcePanel workspace={scriptWorkspace} />
    {#if modalRequest}
      <ScriptReferenceModal
        mode={modalRequest.mode}
        tree={scriptWorkspace.tree}
        defaultPath={modalRequest.mode === 'extract' ? modalRequest.defaultPath : ''}
        fileExists={modalRequest.mode === 'extract' ? modalRequest.exists : false}
        busy={modalBusy}
        onConfirm={confirmScriptAction}
        onCancel={() => !modalBusy && (modalRequest = null)}
      />
    {/if}
    {#if envModal}
      <ConfigureGlobalEnvModal
        agentName={envModal.agentName}
        names={envModal.names}
        onSaved={globalEnvSaved}
        onCancel={() => (envModal = null)}
      />
    {/if}
  </div>
  <div class="yaml-editor-footer">
    <span>智能体: {agentCount}</span>
    <span>调度器: {schedulerCount}</span>
    <span class="lang-badge">YAML</span>
  </div>
</div>

<style>
  .yaml-editor {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    background: #1e1e1e;
    overflow: hidden;
  }
  .collapse-strip {
    display: none;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    height: 100%;
    cursor: pointer;
    background: #1a1a1f;
    border-left: 2px solid var(--accent-blue);
    transition: background 0.2s;
    user-select: none;
    padding: 0 4px;
  }
  .collapse-strip:hover { background: #22222a; }
  .collapse-strip:hover .strip-arrow { color: #fff; transform: scale(1.3); }
  .strip-filename {
    writing-mode: vertical-rl;
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    letter-spacing: 1px;
  }
  .strip-arrow { color: var(--accent-blue); font-size: 12px; transition: color 0.15s, transform 0.15s; }
  .yaml-editor.collapsed { min-width: 28px; }
  .yaml-editor.collapsed .collapse-strip { display: flex; }
  .yaml-editor.collapsed .yaml-editor-header,
  .yaml-editor.collapsed .editor-stack,
  .yaml-editor.collapsed .yaml-editor-footer { display: none; }
  .yaml-editor-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 12px;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border-color);
    font-size: var(--font-size-md);
    color: var(--text-secondary);
    flex-shrink: 0;
    gap: 0;
  }
  .filename { font-family: var(--font-mono); flex-shrink: 0; }
  :global(.yaml-editor-header .toolbar) {
    flex: 1;
    padding: 0;
    background: transparent;
    border-bottom: none;
    min-height: 28px;
  }
  .editor-stack { position: relative; display: flex; flex-direction: column; flex: 1; min-height: 0; }
  .yaml-editor-body { flex: 1; min-height: 0; }
  .yaml-editor-footer {
    display: flex;
    gap: 16px;
    padding: 2px 12px;
    background: var(--bg-secondary);
    border-top: 1px solid var(--border-color);
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    flex-shrink: 0;
  }
  :global(.script-ref-link) {
    color: #c9a7ff !important;
    background: rgba(163, 113, 247, 0.09);
    text-decoration: underline;
    text-decoration-color: rgba(201, 167, 255, 0.75);
    cursor: pointer;
  }
  :global(.missing-global-env) {
    text-decoration-line: underline;
    text-decoration-style: wavy;
    text-decoration-color: var(--accent-orange);
    text-underline-offset: 3px;
  }
  :global(.monaco-scrollable-element > .scrollbar > .slider) { width: 4px !important; }
  :global(.monaco-editor .decorationsOverviewRuler) { width: 4px !important; }
  .lang-badge { margin-left: auto; color: var(--text-secondary); }
</style>
