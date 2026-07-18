<script lang="ts">
  import { store } from '../lib/stores.svelte';

  let dragging = $state(false);
  let splitPane: HTMLElement | null = null;

  function onPointerDown(e: PointerEvent) {
    e.preventDefault();
    dragging = true;
    splitPane = (e.target as HTMLElement).closest('.split-pane');
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging || !splitPane) return;
    const rect = splitPane.getBoundingClientRect();
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    store.splitRatio = Math.max(20, Math.min(80, pct));
  }

  function onPointerUp() {
    dragging = false;
  }

  function toggleCollapse(e: PointerEvent) {
    if (dragging) return;
    store.editorCollapsed = !store.editorCollapsed;
  }
</script>

<div class="resizer-wrap">
  <div
    class="resizer"
    class:dragging
    role="separator"
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
  ></div>
  <button
    class="collapse-btn"
    onclick={() => store.editorCollapsed = !store.editorCollapsed}
  >
    {store.editorCollapsed ? '▶' : '◀'}
  </button>
</div>

<style>
  .resizer-wrap {
    display: flex;
    flex-direction: column;
    align-items: center;
    flex-shrink: 0;
    position: relative;
    width: 6px;
    height: 100%;
  }
  .resizer {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 6px;
    cursor: col-resize;
    background: var(--border-color);
    transition: background 0.15s;
  }
  .resizer:hover, .resizer.dragging {
    background: var(--accent-blue);
  }
  .collapse-btn {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    z-index: 1;
    background: var(--bg-secondary);
    border: none;
    color: var(--accent-blue);
    font-size: 12px;
    cursor: pointer;
    padding: 4px 0;
    border-radius: 4px;
    transition: color 0.15s;
  }
  .collapse-btn:hover { color: #fff; transform: scale(1.3); }
</style>
