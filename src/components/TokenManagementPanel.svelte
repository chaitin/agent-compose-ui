<script lang="ts">
  import { onMount } from 'svelte';

  import {
    ApiTokenError,
    createApiToken,
    listApiTokens,
    revokeApiToken,
    type ApiTokenMetadata,
    type ApiTokenRole,
    type CreatedApiToken,
  } from '../api/tokens';
  import { formatBeijingTime } from '../time';

  let items: ApiTokenMetadata[] = [];
  let loading = true;
  let unavailable = false;
  let error = '';
  let guideOpen = false;
  let createOpen = false;
  let name = '';
  let role: ApiTokenRole = 'read-only-admin';
  let expiresInDays = 90;
  let saving = false;
  let created: CreatedApiToken | null = null;
  let copied = false;
  let revokeTarget: ApiTokenMetadata | null = null;
  let revoking = false;

  onMount(() => {
    void load();
  });

  function formatTime(value?: string): string {
    return value ? formatBeijingTime(value) : '-';
  }

  function isExpired(item: ApiTokenMetadata): boolean {
    if (!item.expiresAt) return false;
    const timestamp = new Date(item.expiresAt).getTime();
    return Number.isFinite(timestamp) && timestamp <= Date.now();
  }

  async function load(): Promise<void> {
    loading = true;
    error = '';
    try {
      items = await listApiTokens();
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
    expiresInDays = 90;
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
      created = await createApiToken(normalized, role, expiresInDays);
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
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(created.token);
      } else {
        fallbackCopy(created.token);
      }
      copied = true;
    } catch {
      copied = false;
      error = '复制失败，请手动复制 Token';
    }
  }

  function fallbackCopy(value: string): void {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    const copiedValue = document.execCommand('copy');
    document.body.removeChild(textarea);
    if (!copiedValue) throw new Error('copy failed');
  }

  function closeCreated(): void {
    created = null;
    copied = false;
    error = '';
  }

  async function confirmRevoke(): Promise<void> {
    if (!revokeTarget) return;
    revoking = true;
    error = '';
    try {
      await revokeApiToken(revokeTarget.id);
      revokeTarget = null;
      await load();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : '撤销 Token 失败';
    } finally {
      revoking = false;
    }
  }
</script>

<section class="config-card token-card">
  <div class="panel-head">
    <div>
      <h2>API Token</h2>
      <p>为远程 CLI 和自动化调用创建受角色约束的凭据。Token 明文只显示一次。</p>
    </div>
    <div class="token-head-actions">
      <button on:click={() => guideOpen = true}>使用说明</button>
      <button class="primary" on:click={openCreate} disabled={unavailable}>创建 Token</button>
    </div>
  </div>

  {#if loading}
    <div class="empty">正在加载 Token...</div>
  {:else if unavailable}
    <div class="token-unavailable">
      <b>Token 管理功能未启用</b>
      <span>部署时配置 TOKEN_DB_PATH 后启用；系统其他功能不受影响。</span>
    </div>
  {:else}
    {#if error}<div class="alert danger" role="alert">{error}</div>{/if}
    <div class="token-table-wrap">
      <table class="token-table">
        <thead>
          <tr><th>名称</th><th>角色</th><th>创建时间</th><th>过期时间</th><th>状态</th><th>操作</th></tr>
        </thead>
        <tbody>
          {#each items as item (item.id)}
            <tr>
              <td><b>{item.name}</b><code>{item.id}</code></td>
              <td><code>{item.role}</code></td>
              <td>{formatTime(item.createdAt)}</td>
              <td>{item.expiresAt ? formatTime(item.expiresAt) : '不过期（历史 Token）'}</td>
              <td>
                {#if item.revokedAt}
                  <span class="chip gray">已撤销</span>
                {:else if isExpired(item)}
                  <span class="chip amber">已过期</span>
                {:else}
                  <span class="chip green">有效</span>
                {/if}
              </td>
              <td><button class="danger" on:click={() => revokeTarget = item} disabled={Boolean(item.revokedAt) || isExpired(item)}>撤销</button></td>
            </tr>
          {:else}
            <tr><td colspan="6" class="empty-cell">尚未创建 API Token。</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>

{#if guideOpen}
  <div class="token-modal-mask">
    <div class="token-modal token-guide" role="dialog" aria-modal="true" aria-labelledby="token-guide-title">
      <div class="token-modal-head">
        <h2 id="token-guide-title">API Token 使用说明</h2>
        <button class="ghost" aria-label="关闭" on:click={() => guideOpen = false}>关闭</button>
      </div>
      <div class="proxy-port">
        <span>Token Proxy 部署端口</span>
        <strong>8081</strong>
      </div>
      <p class="base-url-note">具体可访问的 API Base URL 请联系管理员获取。</p>
      <ol>
        <li>创建 Token 后立即复制并安全保存，关闭创建结果弹窗后无法再次查看明文。</li>
        <li>将调用方的 Agent Compose API Base URL 配置为管理员提供的地址。</li>
        <li>每次请求携带 Header：<code>Authorization: Bearer &lt;API_TOKEN&gt;</code>。</li>
      </ol>
      <div>
        <b>curl 示例</b>
        <pre>curl -H 'Authorization: Bearer &lt;API_TOKEN&gt;' \
  '&lt;API_BASE_URL&gt;/api/version'</pre>
      </div>
      <div class="role-help">
        <p><code>read-only-admin</code> 仅允许已登记的查询接口，适合巡检和只读自动化。</p>
        <p><code>admin</code> 允许代理所有 API，请仅授予可信调用方。</p>
      </div>
      <div class="alert warning">请仅通过受信任且加密的网络连接传输 Token，不要直接连接未受 Token/RBAC 保护的 daemon API。</div>
      <div class="token-modal-actions"><button class="primary" on:click={() => guideOpen = false}>知道了</button></div>
    </div>
  </div>
{/if}

{#if createOpen}
  <div class="token-modal-mask">
    <form class="token-modal" on:submit|preventDefault={createToken} aria-labelledby="create-token-title">
      <div class="token-modal-head"><h2 id="create-token-title">创建 API Token</h2><button type="button" class="ghost" aria-label="关闭" on:click={() => createOpen = false}>关闭</button></div>
      <label><span>名称</span><input maxlength="64" bind:value={name} placeholder="例如：CI 只读巡检" required></label>
      <label><span>角色</span><select bind:value={role}><option value="read-only-admin">read-only-admin</option><option value="admin">admin</option></select></label>
      <label><span>有效期</span><select bind:value={expiresInDays}><option value={1}>1 天</option><option value={7}>7 天</option><option value={30}>30 天</option><option value={90}>90 天</option><option value={365}>1 年</option></select></label>
      {#if error}<div class="alert danger" role="alert">{error}</div>{/if}
      <div class="token-modal-actions"><button type="button" on:click={() => createOpen = false} disabled={saving}>取消</button><button class="primary" type="submit" disabled={saving}>{saving ? '创建中...' : '创建'}</button></div>
    </form>
  </div>
{/if}

{#if created}
  <div class="token-modal-mask">
    <div class="token-modal" role="dialog" aria-modal="true" aria-labelledby="created-token-title">
      <div class="token-modal-head"><h2 id="created-token-title">Token 已创建</h2></div>
      <div class="token-warning"><b>请立即复制并安全保存</b><span>关闭后无法再次查看此 Token。</span></div>
      <p>有效期至：{formatTime(created.expiresAt)}</p>
      <code class="raw-token">{created.token}</code>
      {#if error}<div class="alert danger" role="alert">{error}</div>{/if}
      <div class="token-modal-actions"><button on:click={copyCreated}>{copied ? '已复制' : '复制 Token'}</button><button class="primary" on:click={closeCreated}>完成</button></div>
    </div>
  </div>
{/if}

{#if revokeTarget}
  <div class="token-modal-mask">
    <div class="token-modal" role="dialog" aria-modal="true" aria-labelledby="revoke-token-title">
      <div class="token-modal-head"><h2 id="revoke-token-title">撤销 API Token</h2></div>
      <p>撤销 <b>{revokeTarget.name}</b> 后，使用该 Token 的新请求将立即返回 401。</p>
      {#if error}<div class="alert danger" role="alert">{error}</div>{/if}
      <div class="token-modal-actions"><button on:click={() => revokeTarget = null} disabled={revoking}>取消</button><button class="danger" on:click={confirmRevoke} disabled={revoking}>{revoking ? '撤销中...' : '确认撤销'}</button></div>
    </div>
  </div>
{/if}

<style>
  .token-card { overflow: auto; }
  .panel-head > div { min-width: 0; }
  .panel-head p { margin: 5px 0 0; color: var(--muted); }
  .token-head-actions { display: flex; align-items: center; gap: 8px; }
  .token-unavailable { display: grid; gap: 5px; padding: 18px; border: 1px dashed var(--line-strong); border-radius: 6px; background: var(--surface-2); color: var(--muted); }
  .token-table-wrap { overflow: auto; border: 1px solid var(--line); border-radius: 6px; }
  .token-table { width: 100%; min-width: 900px; border-collapse: collapse; }
  .token-table th, .token-table td { padding: 10px 12px; border-bottom: 1px solid var(--line); text-align: left; white-space: nowrap; }
  .token-table th { background: var(--surface-2); color: var(--muted); font-family: var(--mono); font-size: var(--font-size-sm); }
  .token-table tr:last-child td { border-bottom: 0; }
  .token-table td:first-child { display: grid; gap: 3px; }
  .token-table td:first-child code { color: var(--muted); font-size: var(--font-size-xs); }
  .empty-cell { color: var(--muted); text-align: center !important; }
  .token-modal-mask { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; padding: 18px; background: rgba(15, 23, 42, 0.42); }
  .token-modal { width: min(520px, 100%); display: grid; gap: 16px; padding: 20px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); box-shadow: 0 24px 60px rgba(15, 23, 42, 0.24); }
  .token-modal label { display: grid; gap: 6px; color: var(--muted); }
  .token-modal p { margin: 0; color: var(--muted); }
  .token-modal-head, .token-modal-actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .token-modal-head h2 { margin: 0; font-size: var(--font-size-lg); }
  .token-modal-actions { justify-content: flex-end; }
  .token-guide { width: min(620px, 100%); }
  .token-guide ol { display: grid; gap: 8px; margin: 0; padding-left: 22px; color: var(--muted); }
  .token-guide code { font-family: var(--mono); color: var(--text); }
  .token-guide pre { margin: 8px 0 0; padding: 12px; overflow: auto; border: 1px solid var(--line); border-radius: 6px; background: var(--surface-2); color: var(--text); font-family: var(--mono); line-height: 1.5; }
  .proxy-port { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--primary-weak); }
  .proxy-port span { color: var(--muted); }
  .proxy-port strong { color: var(--primary); font-family: var(--mono); font-size: var(--font-size-xl); }
  .base-url-note { margin: 0; color: var(--muted); }
  .role-help { display: grid; gap: 6px; }
  .role-help p { margin: 0; }
  .token-warning { display: grid; gap: 4px; padding: 12px; border: 1px solid #f3d28a; border-radius: 6px; background: var(--amber-weak); color: #92400e; }
  .raw-token { padding: 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface-2); overflow-wrap: anywhere; user-select: all; }
  @media (max-width: 700px) { .token-card > .panel-head { align-items: flex-start; flex-direction: column; } }
</style>
