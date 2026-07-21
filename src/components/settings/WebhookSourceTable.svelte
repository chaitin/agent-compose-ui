<script lang="ts">
  import type { WebhookSource, TestState } from '../../lib/webhook/types';

  interface Props {
    sources: WebhookSource[];
    sessionTokenIds: Set<string>;
    selectedSourceId: string | null;
    testStates: Map<string, TestState>;
    onselect: (id: string) => void;
    ontoggle: (id: string) => void;
    ondelete: (id: string) => void;
    oncopycurl: (id: string) => void;
    ontest: (id: string) => void;
    onregen: (id: string) => void;
  }

  let {
    sources,
    sessionTokenIds,
    selectedSourceId,
    testStates,
    onselect,
    ontoggle,
    ondelete,
    oncopycurl,
    ontest,
    onregen,
  }: Props = $props();
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
                <button type="button" onclick={(e) => { e.stopPropagation(); oncopycurl(source.id); }}>📋 curl</button>
                <button type="button" disabled>⚡ 测试</button>
                <button type="button" onclick={(e) => { e.stopPropagation(); onregen(source.id); }}>↻ 重生成</button>
                <button type="button" class="danger" onclick={(e) => { e.stopPropagation(); ondelete(source.id); }}>✕</button>
              </div>
            </td>
          </tr>
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

  .empty-state { padding: 48px 24px; text-align: center; color: var(--text-muted); }
  .empty-state .icon { font-size: 28px; opacity: 0.4; margin-bottom: 8px; }
  .empty-state .title { font-size: var(--font-size-md); color: var(--text-secondary); margin-bottom: 4px; }
  .empty-state .hint { font-size: var(--font-size-xs); }
</style>
