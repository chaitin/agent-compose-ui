<script lang="ts">
  import * as monaco from 'monaco-editor';
  import { untrack } from 'svelte';
  import type { ScriptWorkspace } from '../../lib/scripts/workspace.svelte';

  interface Props {
    workspace: ScriptWorkspace;
    onCreateFile: () => void;
  }
  let { workspace, onCreateFile }: Props = $props();

  let container = $state<HTMLDivElement>();
  let editor = $state<monaco.editor.IStandaloneCodeEditor | null>(null);
  let ignoreChanges = false;

  $effect(() => {
    if (!container) return;
    const initial = untrack(() => workspace.activeFile?.content ?? '');
    const e: monaco.editor.IStandaloneCodeEditor = monaco.editor.create(container!, {
      value: initial,
      language: 'javascript',
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

    e.onDidChangeModelContent(() => {
      if (ignoreChanges) return;
      workspace.updateActiveContent(e.getValue());
    });

    e.addAction({
      id: 'script-save-active',
      label: '保存当前脚本',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => {
        void workspace.saveActive();
      },
    });

    editor = e;

    return () => {
      e.dispose();
      editor = null;
    };
  });

  $effect(() => {
    const content = workspace.activeFile?.content ?? '';
    if (!editor) return;
    if (editor.getValue() === content) return;
    ignoreChanges = true;
    editor.setValue(content);
    ignoreChanges = false;
  });
</script>

<div class="script-editor">
  <div class="editor-tab" class:empty={!workspace.activeFile}>
    {#if workspace.activeFile}
      <span class="tab-icon">JS</span>
      <span class="tab-name">{workspace.activeFile.path}</span>
      {#if workspace.activeFile.dirty}
        <span class="tab-dirty" title="未保存">●</span>
      {/if}
    {:else}
      <span>选择一个脚本文件进行编辑</span>
    {/if}
    <button class="new-script" type="button" onclick={onCreateFile}>+ 新建脚本</button>
  </div>
  <div class="editor-body" bind:this={container}></div>
</div>

<style>
  .script-editor {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    min-height: 0;
    background: #1e1e1e;
  }
  .editor-tab {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border-color);
    font-size: var(--font-size-md);
    color: var(--text-secondary);
    flex-shrink: 0;
  }
  .editor-tab.empty {
    color: var(--text-muted);
    font-style: italic;
  }
  .new-script{margin-left:auto;padding:3px 8px;border:1px solid var(--border-color);border-radius:4px;background:var(--bg-tertiary);color:var(--text-primary);font-size:var(--font-size-sm);font-style:normal;cursor:pointer}
  .new-script:hover{border-color:var(--accent-blue);color:var(--accent-blue)}
  .new-script:focus-visible{outline:2px solid var(--accent-blue);outline-offset:1px}
  .tab-icon {
    background: rgba(247, 223, 30, 0.15);
    color: var(--accent-yellow);
    border-radius: 3px;
    font-size: 9px;
    font-weight: 700;
    padding: 1px 4px;
  }
  .tab-name {
    font-family: var(--font-mono);
    color: var(--text-primary);
  }
  .tab-dirty {
    color: var(--accent-yellow);
    font-size: 10px;
  }
  .editor-body {
    flex: 1;
    min-height: 0;
  }
</style>
