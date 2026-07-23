<script lang="ts">
  import { onMount } from 'svelte';
  import { apiTokens, ApiTokenError, type ApiTokenMetadata, type ApiTokenRole, type CreatedApiToken } from '../../lib/api-tokens';
  import { copyText } from '../../lib/clipboard';

  let items = $state<ApiTokenMetadata[]>([]);
  let loading = $state(true);
  let unavailable = $state(false);
  let error = $state('');
  let createOpen = $state(false);
  let name = $state('');
  let role = $state<ApiTokenRole>('read-only-admin');
  let expiresInDays = $state('90');
  let saving = $state(false);
  let created = $state<CreatedApiToken | null>(null);
  let copied = $state(false);
  let revokeTarget = $state<ApiTokenMetadata | null>(null);
  let revoking = $state(false);

  const formatTime = (value?: string) => value ? new Date(value).toLocaleString() : '—';
  const isExpired = (item: ApiTokenMetadata) => {
    if (!item.expiresAt) return false;
    const timestamp = new Date(item.expiresAt).getTime();
    return Number.isFinite(timestamp) && timestamp <= Date.now();
  };

  async function load(): Promise<void> {
    loading = true;
    error = '';
    try {
      items = await apiTokens.list();
      unavailable = false;
    } catch (cause) {
      unavailable = cause instanceof ApiTokenError && cause.status === 503;
      error = unavailable ? '' : cause instanceof Error ? cause.message : '加载 Token 失败';
    } finally {
      loading = false;
    }
  }

  function openCreate(): void {
    name = '';
    role = 'read-only-admin';
    expiresInDays = '90';
    error = '';
    createOpen = true;
  }

  async function createToken(): Promise<void> {
    const normalized = name.trim();
    if (!normalized) {
      error = 'Token 名称不能为空';
      return;
    }
    saving = true;
    error = '';
    try {
      created = await apiTokens.create(normalized, role, Number(expiresInDays));
      createOpen = false;
      copied = false;
      await load();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : '创建 Token 失败';
    } finally {
      saving = false;
    }
  }

  async function copyCreated(): Promise<void> {
    if (!created) return;
    try {
      await copyText(created.token);
      copied = true;
    } catch {
      copied = false;
      error = '复制失败，请手动复制 Token';
    }
  }

  function closeCreated(): void {
    created = null;
    copied = false;
  }

  async function confirmRevoke(): Promise<void> {
    if (!revokeTarget) return;
    revoking = true;
    error = '';
    try {
      await apiTokens.revoke(revokeTarget.id);
      revokeTarget = null;
      await load();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : '撤销 Token 失败';
    } finally {
      revoking = false;
    }
  }

  onMount(load);
</script>

<section class="panel" aria-labelledby="token-title">
  <header>
    <div>
      <h2 id="token-title">API Token</h2>
      <p class="hint">为自动化调用创建受角色约束的 Token。Token 明文只显示一次。</p>
    </div>
    <button class="primary" onclick={openCreate} disabled={unavailable}>创建 Token</button>
  </header>

  {#if loading}
    <p class="empty" role="status">加载中...</p>
  {:else if unavailable}
    <div class="unavailable" role="status">
      <strong>Token 管理功能未启用</strong>
      <span>未配置 TOKEN_DB_PATH。UI 的其他功能不受影响。</span>
    </div>
  {:else}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <div class="table-wrap">
      <table>
        <thead><tr><th>名称</th><th>角色</th><th>创建时间</th><th>过期时间</th><th>状态</th><th><span class="sr-only">操作</span></th></tr></thead>
        <tbody>
          {#each items as item (item.id)}
            <tr>
              <td><strong>{item.name}</strong><code>{item.id}</code></td>
              <td><span class="role">{item.role}</span></td>
              <td>{formatTime(item.createdAt)}</td>
              <td>{item.expiresAt ? formatTime(item.expiresAt) : '不过期（历史 Token）'}</td>
              <td>{#if item.revokedAt}<span class="revoked">已撤销 · {formatTime(item.revokedAt)}</span>{:else if isExpired(item)}<span class="expired">已过期</span>{:else}<span class="active">有效</span>{/if}</td>
              <td><button onclick={() => revokeTarget = item} disabled={Boolean(item.revokedAt) || isExpired(item)}>撤销</button></td>
            </tr>
          {:else}
            <tr><td colspan="6" class="empty">尚未创建 API Token。</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>

{#if createOpen}
  <div class="backdrop" role="presentation">
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="create-token-title">
      <header><h3 id="create-token-title">创建 API Token</h3><button aria-label="关闭" onclick={() => createOpen = false}>×</button></header>
      <label><span>名称</span><input maxlength="64" bind:value={name} placeholder="例如：CI 只读巡检" /></label>
      <label><span>角色</span><select bind:value={role}><option value="read-only-admin">read-only-admin</option><option value="admin">admin</option></select></label>
      <label><span>有效期</span><select value={expiresInDays} onchange={(event) => expiresInDays = event.currentTarget.value}><option value="1">1 天</option><option value="7">7 天</option><option value="30">30 天</option><option value="90">90 天</option><option value="365">1 年</option></select></label>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      <footer><button onclick={() => createOpen = false} disabled={saving}>取消</button><button class="primary" onclick={createToken} disabled={saving}>{saving ? '创建中...' : '创建'}</button></footer>
    </div>
  </div>
{/if}

{#if created}
  <div class="backdrop" role="presentation">
    <div class="dialog token-dialog" role="dialog" aria-modal="true" aria-labelledby="created-token-title">
      <header><h3 id="created-token-title">Token 已创建</h3></header>
      <div class="warning"><strong>请立即复制并安全保存</strong><span>关闭后无法再次查看此 Token。</span></div>
      <p class="expiry">有效期至：{formatTime(created.expiresAt)}</p>
      <code class="raw-token">{created.token}</code>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      <footer><button onclick={copyCreated}>{copied ? '已复制' : '复制 Token'}</button><button class="primary" onclick={closeCreated}>完成</button></footer>
    </div>
  </div>
{/if}

{#if revokeTarget}
  <div class="backdrop" role="presentation">
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="revoke-token-title">
      <header><h3 id="revoke-token-title">撤销 API Token</h3></header>
      <p>撤销 <strong>{revokeTarget.name}</strong> 后，使用该 Token 的新请求将立即返回 401。</p>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      <footer><button onclick={() => revokeTarget = null} disabled={revoking}>取消</button><button class="danger" onclick={confirmRevoke} disabled={revoking}>{revoking ? '撤销中...' : '确认撤销'}</button></footer>
    </div>
  </div>
{/if}

<style>
  .panel{padding:16px;border:1px solid var(--border-color);border-radius:8px;background:var(--bg-secondary)}
  header,footer{display:flex;align-items:center;justify-content:space-between;gap:12px}h2,h3{margin:0}h2{font-size:var(--font-size-xl)}h3{font-size:var(--font-size-lg)}
  .hint{margin:6px 0 0;color:var(--text-muted);font-size:var(--font-size-sm)}button,input,select{box-sizing:border-box;border:1px solid var(--border-color);border-radius:5px;background:var(--bg-primary);color:var(--text-primary);padding:7px 10px}button{cursor:pointer}button:disabled{cursor:not-allowed;opacity:.5}.primary{border-color:var(--accent-blue);background:var(--accent-blue);color:#fff}.danger{border-color:var(--accent-red);color:var(--accent-red)}
  .error{color:var(--accent-red)}.empty{padding:22px;color:var(--text-muted);text-align:center}.unavailable{display:grid;gap:5px;margin-top:16px;padding:18px;border:1px dashed var(--border-color);color:var(--text-secondary)}.unavailable strong{color:var(--text-primary)}
  .table-wrap{margin-top:16px;overflow:auto}table{width:100%;border-collapse:collapse;font-size:var(--font-size-sm)}th,td{padding:10px;border-bottom:1px solid var(--border-color);text-align:left;white-space:nowrap}td:first-child{display:grid;gap:3px}td code{color:var(--text-muted);font-size:var(--font-size-xs)}.role{font-family:var(--font-mono)}.active{color:var(--accent-green)}.expired{color:var(--accent-orange)}.revoked{color:var(--text-muted)}
  .backdrop{position:fixed;inset:0;z-index:20;display:grid;place-items:center;padding:16px;background:#0009}.dialog{display:grid;gap:16px;width:min(520px,100%);padding:20px;border:1px solid var(--border-color);border-radius:8px;background:var(--bg-secondary);box-shadow:0 20px 60px #0009}.dialog label{display:grid;gap:6px}.dialog input,.dialog select{width:100%}.dialog footer{justify-content:flex-end}.warning{display:grid;gap:4px;padding:12px;border:1px solid var(--accent-orange);border-radius:6px;color:var(--accent-orange)}.expiry{margin:0;color:var(--text-secondary)}.raw-token{overflow-wrap:anywhere;padding:12px;border:1px solid var(--border-color);border-radius:5px;background:var(--bg-primary);user-select:all}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}
  @media(max-width:700px){.panel>header{align-items:flex-start;flex-direction:column}th:nth-child(3),td:nth-child(3){display:none}}
</style>
