<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from '$lib/i18n.svelte';
  import Timestamp from '$lib/components/timestamp.svelte';
  import { getAuthStatus, type AuthStatus } from '../api/auth';

  // 登录状态来自 UI server 自身（AUTH_* / OAUTH_* 部署变量），和 agent-compose daemon 无关，只读展示。
  let auth = $state<AuthStatus | null>(null);
  let error = $state('');

  onMount(() => {
    getAuthStatus()
      .then((value) => (auth = value))
      .catch((cause) => (error = cause instanceof Error ? cause.message : t('请求失败')));
  });
</script>

<div data-page-layout="collection" class="flex h-full min-h-0 flex-col">
  <h1 class="sr-only">{t('登录信息')}</h1>
  {#if error}<div class="bg-destructive/8 px-4 py-2 text-xs text-destructive sm:px-5 xl:px-6">{error}</div>{/if}
  <dl class="grid max-w-2xl grid-cols-[8rem_minmax(0,1fr)] gap-x-4 gap-y-2.5 px-4 py-5 text-[13px] sm:px-5 xl:px-6">
    <dt class="text-faint">{t('认证')}</dt>
    <dd>{t(auth?.enabled ? '已启用' : '未启用')}</dd>
    <dt class="text-faint">{t('当前用户')}</dt>
    <dd>{auth?.user?.displayName || auth?.username || t('匿名')}</dd>
    <dt class="text-faint">{t('认证来源')}</dt>
    <dd>{auth?.user?.source || '—'}{auth?.user?.authMethod ? ` · ${auth.user.authMethod}` : ''}</dd>
    <dt class="text-faint">OAuth</dt>
    <dd>{t(auth?.oauthEnabled ? '已启用' : '未启用')}</dd>
    <dt class="text-faint">{t('会话到期')}</dt>
    <dd>
      {#if auth?.expiresAt}<Timestamp value={auth.expiresAt} mode="full" />{:else}—{/if}
    </dd>
    <dt class="text-faint">{t('用户 ID')}</dt>
    <dd class="font-mono text-[11.5px] break-all text-muted-foreground">{auth?.user?.id || '—'}</dd>
  </dl>
</div>
