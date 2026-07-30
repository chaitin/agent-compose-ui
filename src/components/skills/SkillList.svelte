<script lang="ts">
  import type { Entry } from '../../lib/skills/api';

  interface Props {
    entries: Entry[];
    selected: string;
    loading: boolean;
    error: string;
    busy: boolean;
    onSelect: (name: string) => void;
    onRetry: () => void;
  }

  let { entries, selected, loading, error, busy, onSelect, onRetry }: Props = $props();
</script>

<nav aria-label="Skills 列表">
  {#if loading}
    <p role="status">正在加载 Skills…</p>
  {:else if error}
    <p role="alert">加载失败：{error}</p>
    <button type="button" onclick={onRetry}>重试加载</button>
  {:else if !entries.length}
    <p role="status">暂无 Skills</p>
  {:else}
    <ul>
      {#each entries as entry}
        <li>
          <button
            type="button"
            class:active={selected === entry.name}
            aria-current={selected === entry.name ? 'true' : undefined}
            onclick={() => onSelect(entry.name)}
            disabled={busy}
          >{entry.name}</button>
        </li>
      {/each}
    </ul>
  {/if}
</nav>

<style>
  nav { height: 100%; padding: 10px; overflow: auto; }
  ul { margin: 0; padding: 0; list-style: none; }
  li + li { margin-top: 3px; }
  li button { width: 100%; padding: 6px 8px; text-align: left; }
  button.active { color: var(--accent-blue); background: color-mix(in srgb, var(--accent-blue) 10%, transparent); }
</style>
