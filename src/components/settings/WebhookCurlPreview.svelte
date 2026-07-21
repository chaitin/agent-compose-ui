<script lang="ts">
  import type { WebhookSource } from '../../lib/webhook/types';

  interface Props {
    source: WebhookSource | null;
    token: string | null;
  }

  let { source, token }: Props = $props();

  function buildCurlCommand(src: WebhookSource, tok: string | null): string {
    const topic = src.topic_prefix.replace(/\.+$/, '');
    const auth = tok ?? '<your-token>';
    return [
      `curl -X POST 'http://127.0.0.1:7410/api/webhooks/${topic}' \\`,
      `  -H 'Content-Type: application/json' \\`,
      `  -H 'Authorization: Bearer ${auth}' \\`,
      `  --data '{`,
      `    "alert_type": "Webshell上传",`,
      `    "src_ip": "192.168.1.50"`,
      `  }'`,
    ].join('\n');
  }

  async function copyCurl(): Promise<void> {
    if (!source) return;
    try {
      await navigator.clipboard.writeText(buildCurlCommand(source, token));
    } catch {
      // ignore
    }
  }
</script>

<section class="section-card">
  <header class="section-card-header">
    <div>
      <span class="title">curl 示例</span>
      <span class="desc">选中源后自动生成可复制的调用命令</span>
    </div>
    <div class="spacer"></div>
    <button type="button" class="btn" onclick={copyCurl} disabled={!source}>📋 复制</button>
  </header>
  <div class="curl-card-body">
    {#if source}
      <div class="curl-source-line">
        <span class="name">{source.name}</span>
        <span>·</span>
        <span class="topic">{source.topic_prefix}</span>
      </div>
      <pre class="curl-preview">{buildCurlCommand(source, token)}</pre>
      {#if token}
        <div class="curl-warning">
          <span>⚠</span>
          <span>包含明文 token，仅您当前会话可见。关闭页面后需重新生成 token 才能再次获取。</span>
        </div>
      {:else}
        <div class="curl-warning muted">
          <span>⚠</span>
          <span>替换 &lt;your-token&gt; 为您的源 token。如需新 token，点击表格中"↻ 重生成"。</span>
        </div>
      {/if}
    {:else}
      <div class="empty-curl">点击上方表格中的源以查看 curl 示例</div>
    {/if}
  </div>
</section>

<style>
  .section-card { background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 6px; overflow: hidden; }
  .section-card-header { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--border-color); background: var(--bg-tertiary); }
  .section-card-header .title { font-size: var(--font-size-md); font-weight: 600; }
  .section-card-header .desc { color: var(--text-muted); font-size: var(--font-size-xs); margin-left: 8px; }
  .section-card-header .spacer { flex: 1; }
  .section-card-header .btn { padding: 5px 12px; border: 1px solid var(--border-color); border-radius: 4px; background: var(--bg-secondary); color: var(--text-primary); font-size: var(--font-size-sm); }
  .section-card-header .btn:hover:not(:disabled) { border-color: var(--accent-blue); }
  .section-card-header .btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .curl-card-body { padding: 14px 16px; }
  .curl-source-line { font-size: var(--font-size-sm); color: var(--text-secondary); margin-bottom: 8px; display: flex; align-items: center; gap: 8px; }
  .curl-source-line .name { color: var(--text-primary); font-weight: 600; }
  .curl-source-line .topic { font-family: var(--font-mono); color: var(--accent-blue); font-size: var(--font-size-xs); }

  .curl-preview {
    background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 4px;
    padding: 12px 14px; font-family: var(--font-mono); font-size: var(--font-size-xs);
    line-height: 1.7; color: var(--text-secondary); white-space: pre-wrap; word-break: break-all;
    margin: 0;
  }

  .curl-warning {
    margin-top: 10px; padding: 6px 10px; border-radius: 3px; font-size: var(--font-size-xs);
    color: var(--accent-yellow); background: color-mix(in srgb, var(--accent-yellow) 8%, transparent);
    border-left: 2px solid var(--accent-yellow); display: flex; align-items: center; gap: 6px;
  }
  .curl-warning.muted { color: var(--text-muted); background: var(--bg-tertiary); border-left-color: var(--text-muted); }

  .empty-curl { padding: 24px; text-align: center; color: var(--text-muted); font-size: var(--font-size-sm); }
</style>
