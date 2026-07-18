<script lang="ts">
  import type { ScriptTreeNode } from '../../lib/scripts/types';
  import { filterScriptDirectories } from '../../lib/scripts/tree';

  interface Props {
    tree: ScriptTreeNode | null;
    activePath?: string;
    dirtyPaths?: Set<string>;
    onOpen: (path: string) => void;
    onDeleteFile: (path: string) => void;
    onDeleteFolder: (path: string) => void;
  }

  let {
    tree,
    activePath = '',
    dirtyPaths = new Set<string>(),
    onOpen,
    onDeleteFolder,
    onDeleteFile,
  }: Props = $props();

  let expanded = $state<Set<string>>(new Set());
  let directoryQuery = $state('');
  let filtered = $derived(filterScriptDirectories(tree, directoryQuery));
  let visibleTree = $derived(filtered.tree);

  function isExpanded(path: string) {
    return directoryQuery.trim() ? filtered.expandedPaths.has(path) : expanded.has(path);
  }

  function toggle(path: string) {
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    expanded = next;
  }

  function childrenOf(node: ScriptTreeNode): ScriptTreeNode[] {
    return node.kind === 'directory' ? node.children : [];
  }

  function handleDelete(event: MouseEvent, node: ScriptTreeNode) {
    event.stopPropagation();
    if (node.kind === 'file') {
      if (confirm(`确定删除文件 ${node.path} 吗？引用该文件的项目下次打开时会自动回退为原后端保存的内联代码。`)) {
        onDeleteFile(node.path);
      }
    } else {
      if (confirm(`确定递归删除文件夹 ${node.path} 吗？文件夹内的所有脚本和子目录都会被删除。`)) {
        onDeleteFolder(node.path);
      }
    }
  }
</script>

<aside class="file-tree">
  <div class="tree-head">
    <span>目录</span>
    <input type="search" aria-label="检索脚本目录" placeholder="检索目录…" bind:value={directoryQuery} />
  </div>

  <div class="tree-body">
    {#snippet renderTree(nodes: ScriptTreeNode[], depth: number)}
      {#each nodes as node (node.path)}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div
          class="tree-row"
          class:folder={node.kind === 'directory'}
          class:file={node.kind === 'file'}
          class:active={activePath === node.path}
          data-path={node.path}
          style="padding-left:{8 + depth * 14}px"
          role="treeitem"
          tabindex="0"
          aria-selected={activePath === node.path}
          onclick={() => node.kind === 'file' && onOpen(node.path)}
        >
          <button
            class="tree-icon"
            class:file-js={node.kind === 'file'}
            class:toggle={node.kind === 'directory'}
            onclick={(event) => { if (node.kind === 'directory') { event.stopPropagation(); toggle(node.path); } }}
            tabindex="-1"
            aria-hidden="true"
          >
            {node.kind === 'file' ? 'JS' : isExpanded(node.path) ? '⌄' : '›'}
          </button>
          <span class="tree-label">{node.name}{node.kind === 'directory' ? '/' : ''}</span>
          {#if node.kind === 'file' && dirtyPaths.has(node.path)}
            <span class="dirty-dot" title="未保存"></span>
          {/if}
          <button
            class="tree-delete"
            aria-label={`删除${node.kind === 'directory' ? '文件夹' : '文件'} ${node.path}`}
            title="删除"
            onclick={(event) => handleDelete(event, node)}
          >⌫</button>
        </div>
        {#if node.kind === 'directory' && isExpanded(node.path)}
          {@render renderTree(childrenOf(node), depth + 1)}
        {/if}
      {/each}
    {/snippet}

    {#if visibleTree && childrenOf(visibleTree).length > 0}
      {@render renderTree(childrenOf(visibleTree), 0)}
    {:else if directoryQuery.trim()}
      <div class="tree-empty">未找到匹配目录</div>
    {:else}
      <div class="tree-empty">暂无脚本文件</div>
    {/if}
  </div>
</aside>

<style>
  .file-tree {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--bg-secondary);
    border-right: 1px solid var(--border-color);
    user-select: none;
  }
  .tree-head {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 8px;
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    border-bottom: 1px solid var(--border-color);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .tree-head>span{flex:0 0 auto}
  .tree-head input{min-width:0;flex:1;height:24px;padding:2px 7px;border:1px solid var(--border-color);border-radius:4px;background:var(--bg-primary);color:var(--text-primary);font-size:var(--font-size-sm);text-transform:none;letter-spacing:normal}
  .tree-head input:focus-visible{outline:2px solid var(--accent-blue);outline-offset:-1px}
  .tree-body {
    flex: 1;
    overflow: auto;
    padding: 4px 0;
  }
  .tree-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 8px;
    cursor: pointer;
    font-size: var(--font-size-md);
    color: var(--text-primary);
    border-left: 2px solid transparent;
  }
  .tree-row:hover, .tree-row:focus-within {
    background: var(--bg-tertiary);
  }
  .tree-row.active {
    background: rgba(88, 166, 255, 0.12);
    border-left-color: var(--accent-blue);
  }
  .tree-icon {
    background: transparent;
    border: none;
    color: var(--text-secondary);
    width: 20px;
    text-align: center;
    cursor: pointer;
    font-size: 11px;
    flex-shrink: 0;
  }
  .tree-icon.file-js {
    background: rgba(247, 223, 30, 0.15);
    color: var(--accent-yellow);
    border-radius: 3px;
    font-size: 9px;
    font-weight: 700;
  }
  .tree-icon.toggle { cursor: pointer; }
  .tree-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
  }
  .tree-row.folder .tree-label { color: var(--text-primary); }
  .dirty-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent-yellow);
    flex-shrink: 0;
  }
  .tree-delete {
    display: none;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 22px;
    margin-left: auto;
    flex: 0 0 26px;
    background: transparent;
    border: none;
    color: var(--accent-red);
    font-size: 17px;
    cursor: pointer;
    border-radius: 4px;
  }
  .tree-row:hover .tree-delete,
  .tree-row:focus-within .tree-delete {
    display: inline-flex;
  }
  .tree-delete:hover {
    background: rgba(248, 81, 73, 0.15);
  }
  .tree-empty {
    padding: 16px 12px;
    color: var(--text-muted);
    font-size: var(--font-size-md);
    text-align: center;
  }
</style>
