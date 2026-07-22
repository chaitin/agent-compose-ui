<script lang="ts">
  import { webhookStore } from '../../lib/webhook/store.svelte';
  import { WebhookApiError } from '../../lib/webhook/api';
  import { createUUID } from '../../lib/uuid';

  interface Props {
    open: boolean;
    onclose: () => void;
  }

  let { open, onclose }: Props = $props();

  let view = $state<'form' | 'creating' | 'success'>('form');
  let name = $state('');
  let topicPrefix = $state('');
  let enabled = $state(true);
  let token = $state('');
  let submitError = $state<string | null>(null);
  let createdSourceId = $state<string | null>(null);

  const TOPIC_RE = /^webhook\.[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*\.$/;

  function generateToken(): string {
    return 'tok_' + createUUID().replace(/-/g, '').slice(0, 24);
  }

  // Initialize token when modal opens; reset on close
  $effect(() => {
    if (open && !token) {
      token = generateToken();
    }
    if (!open) {
      view = 'form';
      name = '';
      topicPrefix = '';
      enabled = true;
      token = '';
      submitError = null;
      createdSourceId = null;
    }
  });

  let topicValid = $derived(TOPIC_RE.test(topicPrefix));
  let nameValid = $derived(name.trim().length >= 1 && name.trim().length <= 64);
  let canSubmit = $derived(nameValid && topicValid && view === 'form');

  function regenToken(): void {
    token = generateToken();
  }

  async function copyToken(): Promise<void> {
    try {
      await navigator.clipboard.writeText(token);
    } catch {
      // ignore
    }
  }

  async function handleSubmit(): Promise<void> {
    if (!canSubmit) return;
    view = 'creating';
    submitError = null;
    const sourceId = createUUID();
    try {
      const source = await webhookStore.upsert({
        id: sourceId,
        name: name.trim(),
        enabled,
        provider: 'generic',
        topic_prefix: topicPrefix,
        token,
        signature_type: 'none',
      });
      createdSourceId = source.id;
      view = 'success';
    } catch (error) {
      submitError = error instanceof WebhookApiError ? error.message : String(error);
      view = 'form';
    }
  }

  function handleClose(): void {
    onclose();
  }
</script>

{#if open}
  <div class="modal-backdrop" role="presentation" onclick={(e) => { if (e.target === e.currentTarget && view !== 'creating') handleClose(); }}>
    <div class="modal" role="dialog" aria-modal="true">
      {#if view === 'form' || view === 'creating'}
        <header class="modal-header">
          <div class="title">注册 Webhook 源</div>
          <button type="button" class="close" onclick={handleClose} disabled={view === 'creating'}>×</button>
        </header>
        <div class="modal-body">
          {#if submitError}
            <div class="alert-banner error">{submitError}</div>
          {/if}
          <div class="field">
            <label for="wh-name">名称</label>
            <input id="wh-name" type="text" bind:value={name} placeholder="用于识别的显示名" />
            <div class="hint">在源列表里显示，可重复。仅作展示，不参与匹配。</div>
          </div>
          <div class="field" class:invalid={topicPrefix !== '' && !topicValid}>
            <label for="wh-topic">Topic 前缀</label>
            <input id="wh-topic" type="text" class="mono" bind:value={topicPrefix} placeholder="例如 webhook.siem.alert." />
            <div class="hint">YAML 里 <code>scheduler.on("webhook.siem.alert.*", ...)</code> 通过此 topic 匹配。必须以 <code>webhook.</code> 开头、<code>.</code> 结尾。</div>
            {#if topicPrefix !== '' && !topicValid}
              <div class="error-text">格式无效：必须形如 webhook.siem.alert.</div>
            {/if}
          </div>
          <div class="field">
            <span class="label-text">访问 Token</span>
            <div class="token-input-group">
              <input id="wh-token" type="text" value={token} readonly />
              <button type="button" onclick={regenToken}>↻ 重新生成</button>
              <button type="button" onclick={copyToken}>📋 复制</button>
            </div>
            <div class="hint">调用方在 <code>Authorization: Bearer &lt;token&gt;</code> 头里携带。<strong class="warn">仅在创建时显示一次，请立即保存。</strong></div>
          </div>
          <div class="toggle-row">
            <div class="toggle" class:on={enabled} onclick={() => enabled = !enabled} role="switch" aria-checked={enabled} tabindex="0"
                 onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); enabled = !enabled; } }}></div>
            <span class="toggle-label">立即启用<span class="sub">· 停用后所有发往此 topic 的请求返回 404</span></span>
          </div>
        </div>
        <footer class="modal-footer">
          <button type="button" class="btn" onclick={handleClose} disabled={view === 'creating'}>取消</button>
          <button type="button" class="btn primary" onclick={handleSubmit} disabled={!canSubmit && view === 'form'}>
            {#if view === 'creating'}注册中...{:else}注册{/if}
          </button>
        </footer>
      {:else}
        <header class="modal-header">
          <span class="icon success">✓</span>
          <div class="title">源已注册</div>
          <button type="button" class="close" onclick={handleClose}>×</button>
        </header>
        <div class="modal-body">
          <div class="alert-banner warn">
            <span class="icon">⚠</span>
            <span>这是您最后一次能看到此 token。关闭后此 token 将不再显示，如需再次获取必须重新生成（会使旧 token 立即失效）。</span>
          </div>
          <div class="field">
            <span class="label-text">访问 Token</span>
            <div class="token-display">
              <span class="value">{token}</span>
              <button type="button" onclick={copyToken}>📋 复制</button>
            </div>
          </div>
        </div>
        <footer class="modal-footer">
          <button type="button" class="btn primary" onclick={handleClose}>我已保存，关闭</button>
        </footer>
      {/if}
    </div>
  </div>
{/if}

<style>
  .modal-backdrop {
    position: fixed; inset: 0; background: rgba(1,4,9,0.7);
    display: flex; align-items: center; justify-content: center;
    z-index: 100; backdrop-filter: blur(2px);
  }
  .modal {
    background: var(--bg-secondary); border: 1px solid var(--border-color);
    border-radius: 8px; width: 520px; max-width: calc(100% - 32px);
    box-shadow: 0 16px 48px rgba(0,0,0,0.5);
  }
  .modal-header { display: flex; align-items: center; gap: 8px; padding: 14px 18px; border-bottom: 1px solid var(--border-color); }
  .modal-header .title { font-size: var(--font-size-xl); font-weight: 600; }
  .modal-header .icon.success { color: var(--accent-green); font-size: 18px; }
  .modal-header .close { margin-left: auto; padding: 4px; border: 0; background: transparent; color: var(--text-muted); font-size: 18px; }
  .modal-header .close:hover:not(:disabled) { color: var(--text-primary); }
  .modal-header .close:disabled { cursor: not-allowed; opacity: 0.5; }
  .modal-body { padding: 16px 18px; }
  .field { margin-bottom: 14px; }
  .field label, .field .label-text { display: block; font-size: var(--font-size-xs); color: var(--text-secondary); margin-bottom: 5px; text-transform: uppercase; letter-spacing: 0.4px; font-weight: 600; }
  .field .hint { color: var(--text-muted); font-size: var(--font-size-xs); margin-top: 4px; line-height: 1.5; }
  .field .hint code { font-family: var(--font-mono); color: var(--accent-blue); background: color-mix(in srgb, var(--accent-blue) 10%, transparent); padding: 1px 4px; border-radius: 2px; }
  .field .hint .warn { color: var(--accent-yellow); }
  .field .error-text { color: var(--accent-red); font-size: var(--font-size-xs); margin-top: 4px; }
  .field.invalid input { border-color: var(--accent-red); }
  .field input { width: 100%; padding: 5px 10px; background: var(--bg-tertiary); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 4px; font-family: inherit; font-size: inherit; }
  .field input.mono { font-family: var(--font-mono); font-size: var(--font-size-xs); }
  .field input:focus { outline: 2px solid var(--accent-blue); outline-offset: -1px; border-color: var(--accent-blue); }

  .token-input-group { display: flex; gap: 6px; }
  .token-input-group input { flex: 1; font-family: var(--font-mono); font-size: var(--font-size-xs); padding: 5px 10px; background: var(--bg-tertiary); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 4px; }
  .token-input-group button { padding: 0 12px; border: 1px solid var(--border-color); border-radius: 4px; background: var(--bg-tertiary); color: var(--text-secondary); font-size: var(--font-size-xs); white-space: nowrap; }
  .token-input-group button:hover { color: var(--accent-blue); border-color: var(--accent-blue); }

  .toggle-row { display: flex; align-items: center; gap: 10px; padding: 8px 0; }
  .toggle { width: 36px; height: 20px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 10px; position: relative; cursor: pointer; transition: background 0.15s; flex-shrink: 0; }
  .toggle::after { content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; background: var(--text-secondary); border-radius: 50%; transition: transform 0.15s, background 0.15s; }
  .toggle.on { background: color-mix(in srgb, var(--accent-green) 30%, var(--bg-tertiary)); border-color: var(--accent-green); }
  .toggle.on::after { transform: translateX(16px); background: var(--accent-green); }
  .toggle-label { font-size: var(--font-size-sm); color: var(--text-primary); }
  .toggle-label .sub { color: var(--text-muted); font-size: var(--font-size-xs); margin-left: 6px; }

  .modal-footer { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--border-color); background: var(--bg-tertiary); border-radius: 0 0 8px 8px; }
  .modal-footer .btn { padding: 6px 14px; border-radius: 4px; font-size: var(--font-size-sm); border: 1px solid var(--border-color); background: var(--bg-secondary); color: var(--text-primary); }
  .modal-footer .btn:hover:not(:disabled) { border-color: var(--accent-blue); }
  .modal-footer .btn.primary { background: var(--accent-green); color: #0d1117; border-color: var(--accent-green); font-weight: 600; }
  .modal-footer .btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .alert-banner { padding: 10px 12px; border-radius: 4px; margin-bottom: 14px; display: flex; gap: 8px; align-items: flex-start; font-size: var(--font-size-sm); line-height: 1.5; }
  .alert-banner.warn { background: color-mix(in srgb, var(--accent-yellow) 10%, transparent); border: 1px solid color-mix(in srgb, var(--accent-yellow) 35%, transparent); color: var(--accent-yellow); }
  .alert-banner.error { background: color-mix(in srgb, var(--accent-red) 10%, transparent); border: 1px solid color-mix(in srgb, var(--accent-red) 35%, transparent); color: var(--accent-red); }
  .alert-banner .icon { flex-shrink: 0; font-size: 14px; margin-top: 1px; }

  .token-display { background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 4px; padding: 10px 12px; display: flex; align-items: center; gap: 8px; }
  .token-display .value { flex: 1; font-family: var(--font-mono); font-size: var(--font-size-xs); color: var(--accent-green); word-break: break-all; }
  .token-display button { padding: 4px 10px; border: 1px solid var(--border-color); border-radius: 3px; background: var(--bg-tertiary); color: var(--text-secondary); font-size: var(--font-size-xs); }
  .token-display button:hover { color: var(--accent-blue); border-color: var(--accent-blue); }
</style>
