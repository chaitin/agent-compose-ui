<script lang="ts">
  import type { WorkspaceFileEntry } from '../../lib/workspace/types';
  import {
    buildWorkspaceTree,
    flattenTree,
    formatFileSize,
    type WorkspaceTreeNode,
  } from '../../lib/workspace/tree';

  interface Props {
    files: WorkspaceFileEntry[];
    activePath?: string;
    onSelect: (path: string) => void;
  }

  let {
    files,
    activePath = '',
    onSelect,
  }: Props = $props();

  const ROW_HEIGHT = 26;
  const OVERSCAN = 6;

  let expanded = $state<Set<string>>(new Set());
  let scrollTop = $state(0);
  let viewportHeight = $state(0);
  let viewportEl = $state<HTMLDivElement | undefined>(undefined);

  const tree = $derived(buildWorkspaceTree(files));
  const rows = $derived(flattenTree(tree, expanded));
  const totalHeight = $derived(rows.length * ROW_HEIGHT);

  const startIndex = $derived(Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN));
  const visibleCount = $derived(
    viewportHeight > 0
      ? Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2
      : rows.length,
  );
  const endIndex = $derived(Math.min(rows.length, startIndex + visibleCount));
  const visibleRows = $derived(rows.slice(startIndex, endIndex));
  const offsetY = $derived(startIndex * ROW_HEIGHT);

  function isExpanded(path: string): boolean {
    return expanded.has(path);
  }

  function toggle(path: string): void {
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    expanded = next;
  }

  function handleRowClick(node: WorkspaceTreeNode): void {
    if (node.dir) {
      toggle(node.path);
      return;
    }
    onSelect(node.path);
  }

  function onScroll(event: Event) {
    const target = event.target as HTMLDivElement;
    scrollTop = target.scrollTop;
  }

  const resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      viewportHeight = entry.contentRect.height;
    }
  });

  $effect(() => {
    if (!viewportEl) return;
    viewportHeight = viewportEl.clientHeight;
    resizeObserver.observe(viewportEl);
    return () => resizeObserver.disconnect();
  });

  function typeIcon(node: WorkspaceTreeNode): { glyph: string; cls: string } {
    if (node.dir) return { glyph: '📁', cls: 'folder' };
    const lower = node.name.toLowerCase();
    if (lower.endsWith('.md')) return { glyph: '◐', cls: 'md' };
    if (lower.endsWith('.json')) return { glyph: '◇', cls: 'json' };
    if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return { glyph: '◇', cls: 'yaml' };
    if (lower.endsWith('.sh')) return { glyph: '⌘', cls: 'sh' };
    if (lower.endsWith('.py')) return { glyph: '⌘', cls: 'py' };
    if (lower.endsWith('.txt') || lower.endsWith('.log')) return { glyph: '☰', cls: 'txt' };
    if (/\.(png|jpe?g|gif|webp|svg)$/.test(lower)) return { glyph: '▣', cls: 'img' };
    return { glyph: '·', cls: 'default' };
  }
</script>

<div class="workspace-tree" bind:this={viewportEl} onscroll={onScroll}>
  {#if rows.length === 0}
    <div class="tree-empty">暂无文件</div>
  {:else}
    <div class="tree-spacer" style="height:{totalHeight}px; position: relative;">
      <div class="tree-window" style="transform: translateY({offsetY}px);">
        {#each visibleRows as row (row.node.path)}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div
            class="tree-node"
            class:active={activePath === row.node.path}
            class:folder={row.node.dir}
            class:file={!row.node.dir}
            role="treeitem"
            tabindex="0"
            aria-selected={activePath === row.node.path}
            aria-expanded={row.node.dir ? isExpanded(row.node.path) : undefined}
            style="padding-left:{14 + row.depth * 14}px"
            onclick={() => handleRowClick(row.node)}
            onkeydown={(e: KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handleRowClick(row.node);
              } else if (e.key === 'ArrowRight' && row.node.dir && !isExpanded(row.node.path)) {
                toggle(row.node.path);
              } else if (e.key === 'ArrowLeft' && row.node.dir && isExpanded(row.node.path)) {
                toggle(row.node.path);
              }
            }}
          >
            <span class="icon toggle">
              {row.node.dir ? (isExpanded(row.node.path) ? '▾' : '▸') : ''}
            </span>
            <span class="icon {typeIcon(row.node).cls}">{typeIcon(row.node).glyph}</span>
            <span class="label">{row.node.name}{row.node.dir ? '/' : ''}</span>
            {#if row.node.dir}
              <span class="size">{row.node.children.length}</span>
            {:else}
              <span class="size">{formatFileSize(row.node.size)}</span>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  .workspace-tree {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    background: var(--bg-primary);
    padding: 6px 0;
  }
  .tree-spacer {
    width: 100%;
  }
  .tree-window {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    will-change: transform;
  }
  .tree-node {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    padding-right: 14px;
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    cursor: pointer;
    font-family: var(--font-mono);
    border-left: 2px solid transparent;
    box-sizing: border-box;
  }
  .tree-node:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }
  .tree-node.active {
    background: var(--bg-tertiary);
    color: var(--text-primary);
    border-left-color: var(--accent-blue);
  }
  .tree-node .icon {
    font-size: 11px;
    opacity: 0.7;
    flex-shrink: 0;
  }
  .tree-node .icon.toggle {
    width: 12px;
    text-align: center;
    color: var(--text-muted);
  }
  .tree-node .icon.folder { color: var(--accent-blue); }
  .tree-node .icon.md { color: var(--accent-purple); }
  .tree-node .icon.json { color: var(--accent-yellow); }
  .tree-node .icon.yaml { color: var(--accent-yellow); }
  .tree-node .icon.sh { color: var(--accent-green); }
  .tree-node .icon.py { color: var(--accent-blue); }
  .tree-node .icon.txt { color: var(--text-muted); }
  .tree-node .icon.img { color: var(--accent-orange); }
  .tree-node .icon.default { color: var(--text-muted); }
  .tree-node .label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tree-node .size {
    margin-left: auto;
    color: var(--text-muted);
    font-size: 10px;
    flex-shrink: 0;
  }
  .tree-empty {
    padding: 24px 12px;
    color: var(--text-muted);
    font-size: var(--font-size-sm);
    text-align: center;
  }
</style>
