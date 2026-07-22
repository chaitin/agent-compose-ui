<script lang="ts">
  import type { WebhookSource, TestState } from '../../lib/webhook/types';

  interface Props {
    sources: WebhookSource[];
    sessionTokenIds: Set<string>;
    sessionTokens: Map<string, string>;
    selectedSourceId: string | null;
    testStates: Map<string, TestState>;
    onselect: (id: string) => void;
    ontoggle: (id: string) => void;
    ondelete: (id: string) => void;
    ontest: (id: string) => void;
    onregen: (id: string) => void;
  }

  let {
    sources,
    sessionTokenIds,
    sessionTokens,
    selectedSourceId,
    testStates,
    onselect,
    ontoggle,
    ondelete,
    ontest,
    onregen,
  }: Props = $props();

  let expandedId = $state<string | null>(null);

  function buildCurlCommand(src: WebhookSource, tok: string | null): string {
    const topic = src.topic_prefix.replace(/\.+$/, '');
    const auth = tok ?? '<your-token>';
    return [
      `curl -X POST 'http://127.0.0.1:8080/api/webhooks/${topic}' \\`,
      `  -H 'Content-Type: application/json' \\`,
      `  -H 'Authorization: Bearer ${auth}' \\`,
      `  --data '{`,
      `    "alert_type": "Webshell上传",`,
      `    "src_ip": "192.168.1.50"`,
      `  }'`,
    ].join('\n');
  }

  async function copyCurl(src: WebhookSource, tok: string | null): Promise<void> {
    try {
      await navigator.clipboard.writeText(buildCurlCommand(src, tok));
    } catch {
      // ignore
    }
  }
</script>

<div class="table-wrap">
  <table class="webhook-table">
    <thead>
      <tr>
        <th style="width: 16%;">名称</th>
        <th style="width: 24%;">Topic 前缀</th>
        <th style="width: 14%;">状态</th>
        <th style="width: 16%;">Token</th>
        <th style="width: 30%; text-align: right;">操作</th>
      </tr>
    </thead>
    <tbody>
      {#if sources.length === 0}
        <tr class="empty-row">
          <td colspan="5">
            <div class="empty-state">
              <div class="icon">⌥</div>
              <div class="title">暂无 webhook 源</div>
              <div class="hint">点击右上"+ 注册源"创建第一个源</div>
            </div>
          </td>
        </tr>
      {:else}
        {#each sources as source (source.id)}
          <tr class="source-row" class:selected={selectedSourceId === source.id}
              onclick={() => onselect(source.id)}>
            <td class="name">{source.name}</td>
            <td class="topic">{source.topic_prefix}</td>
            <td>
              <div class="status-cell">
                <span class="status-pill" class:enabled={source.enabled} class:disabled={!source.enabled}>
                  <span class="dot"></span>{source.enabled ? '启用' : '停用'}
                </span>
                <div class="mini-toggle" class:on={source.enabled} role="switch" aria-checked={source.enabled} tabindex="0"
                     onclick={(e) => { e.stopPropagation(); ontoggle(source.id); }}
                     onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); ontoggle(source.id); } }}></div>
              </div>
            </td>
            <td>
              <div class="token-cell">
                <span class="dot" class:missing={!source.has_token}></span>
                <span>{source.has_token ? '已配置' : '未配置'}</span>
                {#if source.has_token}
                  <span class="session-badge" class:available={sessionTokenIds.has(source.id)} class:missing={!sessionTokenIds.has(source.id)}>
                    {sessionTokenIds.has(source.id) ? '会话内' : '需重生成'}
                  </span>
                {/if}
              </div>
            </td>
            <td>
              <div class="row-actions">
                <button type="button" class:active={expandedId === source.id}
                  onclick={(e) => { e.stopPropagation(); expandedId = expandedId === source.id ? null : source.id; }}>{expandedId === source.id ? '▾' : '▸'} curl 示例</button>
                <button type="button"
                  disabled={!sessionTokenIds.has(source.id) || !source.enabled || testStates.get(source.id)?.phase === 'sending'}
                  title={!sessionTokenIds.has(source.id) ? '需重新生成 token 才能测试' : !source.enabled ? '源已停用，请先启用' : ''}
                  onclick={(e) => { e.stopPropagation(); ontest(source.id); }}>⚡ 测试</button>
                <button type="button" onclick={(e) => { e.stopPropagation(); onregen(source.id); }}>↻ 重生成</button>
                <button type="button" class="danger" onclick={(e) => { e.stopPropagation(); ondelete(source.id); }}>✕</button>
              </div>
            </td>
          </tr>
          {#if testStates.get(source.id)}
            {@const testState = testStates.get(source.id)!}
            <tr class="test-status-row">
              <td colspan="5">
                <div class="test-status-bar" class:success={testState.phase === 'success'} class:error={testState.phase === 'error'} class:sending={testState.phase === 'sending'}>
                  <div class="line">
                    <span class="prefix">&gt;</span>
                    <span class="method">POST</span>
                    <span class="path">/api/webhooks/{source.topic_prefix.replace(/\.+$/, '')}</span>
                  </div>
                  {#if testState.phase === 'sending'}
                    <div class="line">
                      <span class="prefix">&lt;</span>
                      <span class="status"><span class="spinner"></span> 发送中...</span>
                    </div>
                  {:else if testState.phase === 'success'}
                    <div class="line">
                      <span class="prefix">&lt;</span>
                      <span class="status">{testState.status} Accepted</span>
                      <span class="sep">·</span>
                      <span class="event-id">{testState.eventId}</span>
                      <span class="sep">·</span>
                      <span class="seq">sequence {testState.sequence}</span>
                    </div>
                  {:else}
                    <div class="line">
                      <span class="prefix">&lt;</span>
                      <span class="status">{testState.status ?? ''} {testState.message ?? '错误'}</span>
                    </div>
                  {/if}
                </div>
              </td>
            </tr>
          {/if}
          {#if expandedId === source.id}
            {@const token = sessionTokens.get(source.id) ?? null}
            <tr class="curl-row">
              <td colspan="5">
                <div class="curl-bar">
                  <div class="curl-cmd-line">
                    <pre class="curl-cmd">{buildCurlCommand(source, token)}</pre>
                    <button type="button" class="copy-btn" onclick={(e) => { e.stopPropagation(); void copyCurl(source, token); }}>📋 复制</button>
                  </div>
                  {#if token}
                    <div class="curl-warning">⚠ 包含明文 token，仅您当前会话可见。关闭页面后需重新生成 token 才能再次获取。</div>
                  {:else}
                    <div class="curl-warning muted">⚠ 替换 &lt;your-token&gt; 为您的源 token。如需新 token，点击表格中"↻ 重生成"。</div>
                  {/if}
                </div>
              </td>
            </tr>
          {/if}
        {/each}
      {/if}
    </tbody>
  </table>
</div>

<style>
  .table-wrap { width: 100%; }
  .webhook-table { width: 100%; border-collapse: collapse; font-size: var(--font-size-sm); }
  .webhook-table th {
    text-align: left; padding: 8px 16px; background: var(--bg-tertiary);
    color: var(--text-muted); font-weight: 600; font-size: var(--font-size-xs);
    text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid var(--border-color);
  }
  .webhook-table td { padding: 12px 16px; border-bottom: 1px solid var(--border-color); vertical-align: middle; }
  .webhook-table tr.source-row { cursor: pointer; }
  .webhook-table tr.source-row:hover td { background: var(--bg-tertiary); }
  .webhook-table tr.source-row.selected td { background: color-mix(in srgb, var(--accent-blue) 6%, var(--bg-secondary)); }
  .webhook-table tr.source-row.selected td:first-child { box-shadow: inset 2px 0 0 var(--accent-blue); }
  .webhook-table .name { font-weight: 600; color: var(--text-primary); }
  .webhook-table .topic { font-family: var(--font-mono); color: var(--accent-blue); font-size: var(--font-size-xs); }

  .status-cell { display: flex; align-items: center; gap: 8px; }
  .status-pill {
    display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px;
    border-radius: 10px; font-size: 10px; font-weight: 600;
    font-family: var(--font-mono); text-transform: uppercase; letter-spacing: 0.3px;
  }
  .status-pill.enabled { background: color-mix(in srgb, var(--accent-green) 15%, transparent); color: var(--accent-green); border: 1px solid color-mix(in srgb, var(--accent-green) 30%, transparent); }
  .status-pill.disabled { background: var(--bg-tertiary); color: var(--text-muted); border: 1px solid var(--border-color); }
  .status-pill .dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }

  .mini-toggle {
    width: 28px; height: 16px; background: var(--bg-tertiary);
    border: 1px solid var(--border-color); border-radius: 8px;
    position: relative; cursor: pointer; transition: background 0.15s; flex-shrink: 0;
  }
  .mini-toggle::after {
    content: ''; position: absolute; top: 1px; left: 1px;
    width: 12px; height: 12px; background: var(--text-secondary);
    border-radius: 50%; transition: transform 0.15s, background 0.15s;
  }
  .mini-toggle.on { background: color-mix(in srgb, var(--accent-green) 30%, var(--bg-tertiary)); border-color: var(--accent-green); }
  .mini-toggle.on::after { transform: translateX(12px); background: var(--accent-green); }

  .token-cell { display: flex; align-items: center; gap: 6px; font-size: var(--font-size-xs); font-family: var(--font-mono); color: var(--text-secondary); }
  .token-cell .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent-green); }
  .token-cell .dot.missing { background: var(--text-muted); }
  .token-cell .session-badge { font-size: 9px; padding: 1px 5px; border-radius: 3px; margin-left: 4px; }
  .token-cell .session-badge.available { color: var(--accent-green); background: color-mix(in srgb, var(--accent-green) 12%, transparent); }
  .token-cell .session-badge.missing { color: var(--accent-yellow); background: color-mix(in srgb, var(--accent-yellow) 12%, transparent); }

  .row-actions { display: flex; gap: 4px; justify-content: flex-end; }
  .row-actions button {
    padding: 4px 9px; border: 1px solid var(--border-color); border-radius: 3px;
    color: var(--text-secondary); font-size: var(--font-size-xs); background: var(--bg-secondary);
    display: flex; align-items: center; gap: 4px;
  }
  .row-actions button.danger { color: var(--text-secondary); }
  .row-actions button:disabled { opacity: 0.45; cursor: not-allowed; }
  .row-actions button:not(:disabled):hover { color: var(--accent-blue); border-color: var(--accent-blue); }
  .row-actions button.danger:not(:disabled):hover { color: var(--accent-red); border-color: var(--accent-red); }
  .row-actions button.active { color: var(--accent-blue); border-color: var(--accent-blue); }

  .empty-state { padding: 48px 24px; text-align: center; color: var(--text-muted); }
  .empty-state .icon { font-size: 28px; opacity: 0.4; margin-bottom: 8px; }
  .empty-state .title { font-size: var(--font-size-md); color: var(--text-secondary); margin-bottom: 4px; }
  .empty-state .hint { font-size: var(--font-size-xs); }

  .test-status-row > td { padding: 0 16px 8px !important; border-bottom: 1px solid var(--border-color) !important; }
  .test-status-bar {
    padding: 8px 12px; background: var(--bg-primary); border-radius: 0 0 4px 4px;
    font-family: var(--font-mono); font-size: 11px; line-height: 1.7;
    display: flex; flex-direction: column; gap: 1px;
    border-left: 2px solid transparent;
  }
  .test-status-bar.success { border-left-color: var(--accent-green); }
  .test-status-bar.error { border-left-color: var(--accent-red); }
  .test-status-bar.sending { border-left-color: var(--accent-yellow); }
  .test-status-bar .line { display: flex; align-items: center; gap: 6px; }
  .test-status-bar .prefix { color: var(--text-muted); width: 8px; }
  .test-status-bar .method { color: var(--accent-purple); font-weight: 600; }
  .test-status-bar .path { color: var(--text-secondary); }
  .test-status-bar .status { font-weight: 600; }
  .test-status-bar.success .status { color: var(--accent-green); }
  .test-status-bar.error .status { color: var(--accent-red); }
  .test-status-bar.sending .status { color: var(--accent-yellow); display: flex; align-items: center; gap: 6px; }
  .test-status-bar .sep { color: var(--text-muted); }
  .test-status-bar .event-id, .test-status-bar .seq { color: var(--text-secondary); }
  .spinner {
    display: inline-block; width: 8px; height: 8px;
    border: 1.5px solid var(--accent-yellow); border-top-color: transparent;
    border-radius: 50%; animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .curl-row > td { padding: 0 16px 8px !important; border-bottom: 1px solid var(--border-color) !important; }
  .curl-bar { background: var(--bg-primary); border-radius: 0 0 4px 4px; padding: 10px 12px; border-left: 2px solid var(--accent-blue); }
  .curl-cmd-line { display: flex; gap: 8px; align-items: flex-start; }
  .curl-cmd { flex: 1; margin: 0; font-family: var(--font-mono); font-size: 11px; line-height: 1.6; color: var(--text-secondary); white-space: pre-wrap; word-break: break-all; }
  .copy-btn { padding: 4px 10px; border: 1px solid var(--border-color); border-radius: 3px; background: var(--bg-tertiary); color: var(--text-secondary); font-size: var(--font-size-xs); flex-shrink: 0; cursor: pointer; }
  .copy-btn:hover { color: var(--accent-blue); border-color: var(--accent-blue); }
  .curl-warning { margin-top: 6px; font-size: 11px; color: var(--accent-yellow); display: flex; align-items: center; gap: 4px; }
  .curl-warning.muted { color: var(--text-muted); }
</style>
