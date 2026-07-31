<script lang="ts">
  interface Props {
    state: 'add' | 'manage' | 'repair';
    agentName: string;
    onOpen: () => void;
  }

  let { state, agentName, onOpen }: Props = $props();
  const label = $derived(state === 'add' ? '添加 Skill' : state === 'repair' ? '修正 Skill' : '管理 Skill');
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
    height: 22px;
    align-items: center;
    gap: 4px;
    padding: 1px 7px;
    border: 1px solid color-mix(in srgb, var(--accent-blue) 48%, var(--border-color));
    border-radius: 4px;
    color: var(--accent-blue);
    background: color-mix(in srgb, var(--accent-blue) 10%, var(--bg-secondary));
    font: 600 var(--font-size-sm) var(--font-sans);
    cursor: pointer;
  }
  button:hover { border-color: var(--accent-blue); background: color-mix(in srgb, var(--accent-blue) 16%, var(--bg-secondary)); }
  button:focus-visible { outline: 2px solid var(--accent-blue); outline-offset: 1px; }
  button.warning {
    border-color: color-mix(in srgb, var(--accent-yellow) 55%, var(--border-color));
    color: var(--accent-yellow);
    background: color-mix(in srgb, var(--accent-yellow) 9%, var(--bg-secondary));
  }
  span { display: inline-grid; width: 12px; height: 12px; place-items: center; font-family: var(--font-mono); }
</style>
