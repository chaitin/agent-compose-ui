<script lang="ts">
  type BindingKind = 'non-file' | 'none' | 'valid';

  interface Props {
    kind: BindingKind;
    provider?: string;
    onConvert: () => void;
    onConfigure: () => void;
    onOpen: () => void;
  }

  let { kind, provider, onConvert, onConfigure, onOpen }: Props = $props();

  const warnTooltip = $derived(
    provider
      ? `${provider} 类型不支持文件管理，点击切换为 file 类型并创建 workspace`
      : '当前 workspace 类型不支持文件管理，点击切换为 local 类型',
  );
</script>

<div class="workspace-line-actions">
  {#if kind === 'non-file'}
    <button class="pill warn" title={warnTooltip} onclick={onConvert}>
      <span class="ico" aria-hidden="true">⚠</span>
      <span>切换为文件</span>
    </button>
  {:else if kind === 'none'}
    <button class="pill action" title="创建 file workspace 并绑定本地路径" onclick={onConfigure}>
      <span class="ico" aria-hidden="true">＋</span>
      <span>绑定 workspace</span>
    </button>
  {:else}
    <button class="pill neutral" title="展开下方面板并切换到 Workspace 文件" onclick={onOpen}>
      <span class="ico" aria-hidden="true">📂</span>
      <span>打开 workspace</span>
    </button>
  {/if}
</div>

<style>
  .workspace-line-actions {
    display: flex;
    align-items: center;
    gap: 4px;
    pointer-events: auto;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 3px;
    font-family: -apple-system, system-ui, sans-serif;
    font-size: var(--font-size-xs);
    cursor: pointer;
    border: 1px solid;
    white-space: nowrap;
    transition: background 0.15s, transform 0.1s;
  }
  .pill:active { transform: translateY(0.5px); }
  .pill .ico { font-size: 11px; line-height: 1; }

  .pill.warn {
    background: rgba(210, 153, 34, 0.12);
    border-color: #d29922;
    color: #d29922;
  }
  .pill.warn:hover { background: rgba(210, 153, 34, 0.24); }

  .pill.action {
    background: rgba(47, 129, 247, 0.12);
    border-color: var(--accent-blue);
    color: var(--accent-blue);
  }
  .pill.action:hover { background: rgba(47, 129, 247, 0.24); }

  .pill.neutral {
    background: transparent;
    border-color: var(--border-color);
    color: var(--text-secondary);
  }
  .pill.neutral:hover {
    border-color: var(--accent-blue);
    color: var(--accent-blue);
    background: rgba(47, 129, 247, 0.08);
  }
</style>
