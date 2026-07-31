<script lang="ts">
  export type RuntimeBreadcrumbAction = {
    label: string;
    onclick: () => void;
    variant?: 'default' | 'primary' | 'danger' | 'back';
    ariaLabel?: string;
    title?: string;
    disabled?: boolean;
    hidden?: boolean;
    compact?: boolean;
  };

  let {
    eyebrow,
    title,
    onBack,
    backLabel = '返回',
    actions = [],
    status = '',
    statusTone = 'default',
  }: {
    eyebrow: string;
    title: string;
    onBack?: () => void;
    backLabel?: string;
    actions?: RuntimeBreadcrumbAction[];
    status?: string;
    statusTone?: 'default' | 'running' | 'success' | 'warning' | 'danger';
  } = $props();
</script>

<nav class="runtime-breadcrumb" aria-label="页面路径">
  {#if onBack}
    <button class="back" onclick={onBack} aria-label={backLabel}><span aria-hidden="true">←</span> {backLabel}</button>
  {/if}
  <div class="identity">
    <p>{eyebrow}</p>
    <h2 title={title}>{title}</h2>
  </div>
  {#if status}<span class="status {statusTone}">{status}</span>{/if}
  {#if actions.length > 0}
    <div class="actions">
      {#each actions as action}
        <button
          hidden={action.hidden}
          class:compact={action.compact}
          class:back={action.variant === 'back'}
          class:primary={action.variant === 'primary'}
          class:danger={action.variant === 'danger'}
          aria-label={action.ariaLabel || action.label}
          title={action.title}
          disabled={action.disabled}
          onclick={action.onclick}
        >{action.label}</button>
      {/each}
    </div>
  {/if}
</nav>

<style>
  .runtime-breadcrumb { position: sticky; top: 0; z-index: 8; display: flex; flex: 0 0 auto; align-items: center; gap: 12px; height: 41px; box-sizing: border-box; padding: 5px 12px; border-bottom: 1px solid var(--border-color); background: var(--bg-primary); }
  .identity { flex: 1; min-width: 0; }
  p { margin: 0; color: var(--text-muted); font-size: var(--font-size-xs); line-height: 1.2; }
  h2 { margin: 2px 0 0; overflow: hidden; color: var(--text-primary); font-size: var(--font-size-lg); line-height: 1.2; text-overflow: ellipsis; white-space: nowrap; }
  button { flex: 0 0 auto; padding: 5px 9px; border: 1px solid var(--border-color); border-radius: 4px; background: var(--bg-secondary); color: var(--text-primary); font: 600 var(--font-size-xs)/1.2 inherit; cursor: pointer; }
  button:hover { border-color: var(--accent-blue); background: var(--bg-tertiary); }
  button:focus-visible { outline: 2px solid var(--accent-blue); outline-offset: 2px; }
  button:disabled { cursor: not-allowed; opacity: .55; }
  button.primary { border-color: var(--accent-blue); background: var(--accent-blue); color: #fff; }
  button.danger { border-color: var(--accent-red); color: var(--accent-red); }
  .back { color: var(--text-secondary); }
  .back, button.compact { height: 22px; padding-top: 0; padding-bottom: 0; }
  .actions { display: flex; flex: 0 0 auto; align-items: center; gap: 6px; }
  .status { flex: 0 0 auto; padding: 2px 7px; border: 1px solid var(--border-color); border-radius: 999px; color: var(--text-muted); font-size: var(--font-size-xs); font-weight: 700; }
  .status.running { border-color: color-mix(in srgb, var(--accent-blue) 45%, var(--border-color)); color: var(--accent-blue); }
  .status.success { border-color: color-mix(in srgb, var(--accent-green) 45%, var(--border-color)); color: var(--accent-green); }
  .status.warning { border-color: color-mix(in srgb, var(--accent-yellow) 45%, var(--border-color)); color: var(--accent-yellow); }
  .status.danger { border-color: color-mix(in srgb, var(--accent-red) 45%, var(--border-color)); color: var(--accent-red); }
  @media (max-width: 700px) { .runtime-breadcrumb { height: auto; flex-wrap: wrap; gap: 8px; }.identity { order: -1; flex-basis: 100%; }.actions { margin-left: auto; } }
</style>
