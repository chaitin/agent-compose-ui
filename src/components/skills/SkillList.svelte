<script lang="ts">
  import type { Entry } from '../../lib/skills/api';

  interface Props {
    entries: Entry[];
    selected: string;
    loading: boolean;
    error: string;
    busy: boolean;
    onSelect: (name: string) => void;
    onDelete: () => void;
    onRetry: () => void;
  }

  let { entries, selected, loading, error, busy, onSelect, onDelete, onRetry }: Props = $props();
</script>

<nav aria-label="Skills 列表">
  {#if loading}
    <p role="status">正在加载 Skills…</p>
  {:else if error}
    <p role="alert">加载失败：{error}</p>
    <button class="ui-button secondary" type="button" onclick={onRetry}>重试加载</button>
  {:else if !entries.length}
    <p role="status">暂无 Skills</p>
  {:else}
    <ul>
      {#each entries as entry}
        <li>
          <button
            type="button"
            class="ui-button ghost skill-select"
            class:active={selected === entry.name}
            aria-current={selected === entry.name ? 'true' : undefined}
            onclick={() => onSelect(entry.name)}
            disabled={busy}
          >{entry.name}</button>
          {#if selected === entry.name}
            <button
              class="skill-delete"
              type="button"
              aria-label="删除 Skill"
              title={`删除 Skill ${entry.name}`}
              onclick={onDelete}
              disabled={busy}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-2 6h10l-1 11H8L7 9Zm3 2v7h2v-7h-2Zm4 0v7h2v-7h-2Z" />
              </svg>
            </button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</nav>

<style>
  nav { box-sizing: border-box; height: 100%; padding: 4px; overflow: auto; }
  ul { margin: 0; padding: 0; list-style: none; }
  li { display: flex; align-items: center; gap: 2px; }
  li + li { margin-top: 1px; }
  .skill-select { min-width: 0; flex: 1; padding: 4px 5px; overflow: hidden; text-align: left; text-overflow: ellipsis; white-space: nowrap; }
  .skill-delete { display: grid; place-items: center; flex: 0 0 24px; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--text-muted); cursor: pointer; }
  .skill-delete:hover { background: color-mix(in srgb, var(--accent-red) 10%, transparent); color: var(--accent-red); }
  .skill-delete:disabled { cursor: not-allowed; opacity: .5; }
  .skill-delete svg { width: 15px; height: 15px; fill: currentColor; }
  button.active { color: var(--accent-blue); background: color-mix(in srgb, var(--accent-blue) 10%, transparent); }
</style>
