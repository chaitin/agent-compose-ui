<script lang="ts">
  import { onMount } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import * as Dialog from '$lib/components/ui/dialog';
  import StatusBadge from '$lib/components/status-badge.svelte';
  import Timestamp from '$lib/components/timestamp.svelte';
  import CopyableText from '$lib/components/copyable-text.svelte';
  import { t } from '$lib/i18n.svelte';
  import { copyText } from '$lib/clipboard';
  import { compactIdentifier } from '../../model/identifiers';
  import {
    ApiTokenError,
    createApiToken,
    listApiTokens,
    revokeApiToken,
    type ApiTokenMetadata,
    type ApiTokenRole,
    type CreatedApiToken,
  } from '../../api/tokens';

  let items = $state<ApiTokenMetadata[]>([]);
  let loading = $state(true);
  let unavailable = $state(false);
  let error = $state('');
  let guideOpen = $state(false);
  let createOpen = $state(false);
  let name = $state('');
  let role = $state<ApiTokenRole>('read-only-admin');
  let expiresInDays = $state(90);
  let saving = $state(false);
  let created = $state<CreatedApiToken | null>(null);
  let copied = $state(false);
  let revokeTarget = $state<ApiTokenMetadata | null>(null);

  onMount(load);

  async function load(): Promise<void> {
    loading = true;
    error = '';
    try {
      items = await listApiTokens();
      unavailable = false;
    } catch (cause) {
      unavailable = cause instanceof ApiTokenError && cause.status === 503;
      if (!unavailable) error = message(cause, '加载 API 令牌失败');
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
    if (!name.trim()) {
      error = 'API 令牌名称不能为空';
      return;
    }
    saving = true;
    error = '';
    try {
      created = await createApiToken(name.trim(), role, expiresInDays);
      createOpen = false;
      copied = false;
      await load();
    } catch (cause) {
      error = message(cause, '创建 API 令牌失败');
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
      error = '复制失败，请手动复制 API 令牌';
    }
  }

  async function confirmRevoke(): Promise<void> {
    if (!revokeTarget) return;
    saving = true;
    error = '';
    try {
      await revokeApiToken(revokeTarget.id);
      revokeTarget = null;
      await load();
    } catch (cause) {
      error = message(cause, '撤销 API 令牌失败');
    } finally {
      saving = false;
    }
  }

  function isExpired(item: ApiTokenMetadata): boolean {
    return Boolean(item.expiresAt && new Date(item.expiresAt).getTime() <= Date.now());
  }

  const message = (cause: unknown, fallback: string): string => (cause instanceof Error ? cause.message : fallback);
</script>

<div class="flex min-h-0 flex-1 flex-col gap-4">
  <div class="flex shrink-0 flex-wrap items-start justify-between gap-3">
    <div>
      <h2 class="text-sm font-medium">{t('API 令牌')}</h2>
      <p class="text-xs text-muted-foreground">{t('为 CLI 和 API 调用创建访问凭据')}</p>
    </div>
    <div class="flex gap-2">
      <Button variant="outline" size="sm" onclick={() => (guideOpen = true)}>{t('使用说明')}</Button>
      <Button size="sm" disabled={unavailable} onclick={openCreate}>{t('创建令牌')}</Button>
    </div>
  </div>

  {#if error}<div role="alert" class="shrink-0 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
      {error}
    </div>{/if}
  {#if unavailable}
    <div class="rounded-lg border border-warning/35 bg-warning/10 p-4 text-sm">
      <div class="font-medium">{t('API 令牌未启用')}</div>
      <p class="mt-1 text-muted-foreground">{t('请联系管理员启用')}</p>
    </div>
  {:else if loading}
    <p class="text-sm text-muted-foreground">{t('正在加载 API 令牌…')}</p>
  {:else}
    <div data-scroll-surface class="min-h-0 overflow-auto rounded-lg border border-border bg-card">
      <table class="w-full min-w-[52rem] text-left text-sm">
        <thead class="sticky top-0 z-10 bg-muted/90 text-xs text-muted-foreground backdrop-blur">
          <tr>
            <th class="p-3 font-medium">名称</th><th class="p-3 font-medium">角色</th><th class="p-3 font-medium"
              >创建时间</th
            ><th class="p-3 font-medium">过期时间</th><th class="p-3 font-medium">状态</th><th
              class="p-3 text-right font-medium">操作</th
            >
          </tr>
        </thead>
        <tbody class="divide-y divide-border">
          {#each items as item (item.id)}
            <tr>
              <td class="p-3"
                ><div class="font-medium">{item.name}</div>
                <CopyableText
                  value={item.id}
                  display={compactIdentifier(item.id)}
                  label="Token ID"
                  class="font-mono text-[11px] text-muted-foreground"
                /></td
              >
              <td class="p-3 font-mono text-xs">{item.role}</td>
              <td class="p-3"><Timestamp value={item.createdAt} /></td>
              <td class="p-3"
                >{#if item.expiresAt}<Timestamp value={item.expiresAt} />{:else}{t('不过期')}{/if}</td
              >
              <td class="p-3">
                {#if item.revokedAt}<StatusBadge
                    status="disabled"
                    label="已撤销"
                  />{:else if isExpired(item)}<StatusBadge status="pending" label="已过期" />{:else}<StatusBadge
                    status="enabled"
                    label="有效"
                  />{/if}
              </td>
              <td class="p-3 text-right"
                ><Button
                  variant="ghost"
                  size="sm"
                  class="text-destructive"
                  disabled={Boolean(item.revokedAt) || isExpired(item)}
                  onclick={() => (revokeTarget = item)}>撤销</Button
                ></td
              >
            </tr>
          {:else}
            <tr><td colspan="6" class="p-8 text-center text-muted-foreground">{t('尚未创建 API 令牌')}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<Dialog.Root bind:open={guideOpen}>
  <Dialog.Content class="sm:max-w-xl">
    <Dialog.Header
      ><Dialog.Title>{t('API 令牌使用说明')}</Dialog.Title><Dialog.Description
        >调用地址由管理员提供，请勿直接将容器端口暴露到不可信网络。</Dialog.Description
      ></Dialog.Header
    >
    <ol class="list-decimal space-y-2 pl-5 text-sm">
      <li>创建后立即复制并安全保存；关闭结果窗口后无法再次查看明文。</li>
      <li>请求管理员提供 Agent Compose API Base URL。</li>
      <li>请求携带 <code class="rounded bg-muted px-1 font-mono">Authorization: Bearer &lt;API_TOKEN&gt;</code>。</li>
    </ol>
    <pre
      data-scroll-surface
      class="overflow-auto rounded-md bg-muted p-3 text-xs">curl -H 'Authorization: Bearer &lt;API_TOKEN&gt;' \
  '&lt;API_BASE_URL&gt;/api/version'</pre>
    <div class="space-y-1 text-xs text-muted-foreground">
      <p><code>read-only-admin</code> 仅允许登记的查询接口。</p>
      <p><code>admin</code> 可代理所有 API，只应授予可信调用方。</p>
    </div>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={createOpen}>
  <Dialog.Content>
    <Dialog.Header
      ><Dialog.Title>{t('创建 API 令牌')}</Dialog.Title><Dialog.Description>{t('令牌仅显示一次')}</Dialog.Description
      ></Dialog.Header
    >
    <form
      class="space-y-3"
      onsubmit={(event) => {
        event.preventDefault();
        void createToken();
      }}
    >
      <label class="block space-y-1"><span>名称</span><Input maxlength={64} bind:value={name} required /></label>
      <label class="block space-y-1"
        ><span>角色</span><select
          class="h-8 w-full rounded-lg border border-input bg-background px-2 text-sm"
          bind:value={role}
          ><option value="read-only-admin">read-only-admin</option><option value="admin">admin</option></select
        ></label
      >
      <label class="block space-y-1"
        ><span>有效期</span><select
          class="h-8 w-full rounded-lg border border-input bg-background px-2 text-sm"
          bind:value={expiresInDays}
          ><option value={1}>1 天</option><option value={7}>7 天</option><option value={30}>30 天</option><option
            value={90}>90 天</option
          ><option value={365}>1 年</option></select
        ></label
      >
      <Dialog.Footer
        ><Button type="button" variant="outline" onclick={() => (createOpen = false)}>取消</Button><Button
          type="submit"
          disabled={saving}>{saving ? '创建中…' : '创建'}</Button
        ></Dialog.Footer
      >
    </form>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root open={Boolean(created)} onOpenChange={(open) => !open && (created = null)}>
  <Dialog.Content class="sm:max-w-xl" showCloseButton={false}>
    <Dialog.Header
      ><Dialog.Title>{t('API 令牌已创建')}</Dialog.Title><Dialog.Description
        >请立即复制并安全保存，关闭后无法再次查看。</Dialog.Description
      ></Dialog.Header
    >
    {#if created}<div class="break-all rounded-md border border-warning/35 bg-warning/10 p-3 font-mono text-xs">
        {created.token}
      </div>
      <p class="text-xs text-muted-foreground">有效期至：<Timestamp value={created.expiresAt} /></p>{/if}
    <Dialog.Footer
      ><Button variant="outline" onclick={copyCreated}>{copied ? t('已复制') : t('复制令牌')}</Button><Button
        onclick={() => (created = null)}>完成</Button
      ></Dialog.Footer
    >
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root open={Boolean(revokeTarget)} onOpenChange={(open) => !open && (revokeTarget = null)}>
  <Dialog.Content>
    <Dialog.Header
      ><Dialog.Title>{t('撤销 API 令牌')}</Dialog.Title><Dialog.Description
        >撤销后立即失效且无法恢复。确认撤销 {revokeTarget?.name}？</Dialog.Description
      ></Dialog.Header
    >
    <Dialog.Footer
      ><Button variant="outline" onclick={() => (revokeTarget = null)}>取消</Button><Button
        variant="destructive"
        disabled={saving}
        onclick={confirmRevoke}>{saving ? '撤销中…' : '确认撤销'}</Button
      ></Dialog.Footer
    >
  </Dialog.Content>
</Dialog.Root>
