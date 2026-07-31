<script lang="ts">
  interface Props {
    state: 'add' | 'manage' | 'repair';
    agentName: string;
    onOpen: () => void;
  }

  let { state, agentName, onOpen }: Props = $props();
  const label = $derived(state === 'add' ? '添加 Skill' : state === 'repair' ? '修正 Skill' : '配置 Skill');
</script>

<button
  type="button"
  class:warning={state === 'repair'}
  aria-label={`${label}：${agentName}`}
  title={`${label} · ${agentName}`}
  onclick={onOpen}
>
  <span aria-hidden="true">{state === 'repair' ? '!' : '+'}</span>{label}
</button>

<style>
  button {
    display: inline-flex;
    min-width: 0;
    max-width: 100%;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border: 1px solid var(--accent-blue);
    border-radius: 3px;
    background: color-mix(in srgb, var(--accent-blue) 12%, transparent);
    color: var(--accent-blue-pale);
    cursor: pointer;
    font-size: var(--font-size-xs);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    transition: background 0.15s;
  }
  button:hover { background: color-mix(in srgb, var(--accent-blue) 25%, transparent); }
  button:focus-visible { outline: 2px solid var(--accent-blue); outline-offset: 1px; }
  button.warning {
    border-color: color-mix(in srgb, var(--accent-yellow) 55%, var(--border-color));
    color: var(--accent-yellow);
    background: color-mix(in srgb, var(--accent-yellow) 9%, var(--bg-secondary));
  }
  span { display: inline-grid; width: 12px; height: 12px; place-items: center; font-family: var(--font-mono); }
</style>
