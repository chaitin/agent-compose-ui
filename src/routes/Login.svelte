<script lang="ts">
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { loginWithPassword, type AuthStatus } from '../api/auth';
  import Boxes from '@lucide/svelte/icons/boxes';
  import { t } from '$lib/i18n.svelte';

  let { status, onAuthenticated }: { status: AuthStatus; onAuthenticated: (status: AuthStatus) => void } = $props();
  let username = $state('admin');
  let password = $state('');
  let submitting = $state(false);
  let error = $state('');

  $effect(() => {
    if (status.username && username === 'admin') username = status.username;
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!username.trim() || !password) {
      error = t('请输入用户名和密码');
      return;
    }
    submitting = true;
    error = '';
    try {
      onAuthenticated(await loginWithPassword(username.trim(), password));
    } catch (cause) {
      error = cause instanceof Error ? cause.message : t('登录失败');
    } finally {
      submitting = false;
    }
  }

  function oauthLogin() {
    const next = new URLSearchParams(window.location.search).get('next') || '/';
    window.location.assign(`/oauth/authorize?next=${encodeURIComponent(next)}`);
  }
</script>

<main class="flex min-h-dvh items-center justify-center bg-background p-4 text-foreground sm:p-6">
  <section class="w-full max-w-sm rounded-xl border border-border bg-card p-7 shadow-lg">
    <div class="mb-6 flex items-center gap-3">
      <div class="flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
        <Boxes class="size-5" />
      </div>
      <div>
        <h1 class="text-lg font-semibold">agent-compose</h1>
        <p class="text-sm text-muted-foreground">{t('登录 Web 控制台')}</p>
      </div>
    </div>
    {#if error}<div class="mb-4 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
        {error}
      </div>{/if}
    <form class="space-y-4" onsubmit={submit}>
      <label class="block space-y-1.5"
        ><span class="text-sm font-medium">{t('用户名')}</span><Input
          bind:value={username}
          autocomplete="username"
        /></label
      >
      <label class="block space-y-1.5"
        ><span class="text-sm font-medium">{t('密码')}</span><Input
          bind:value={password}
          type="password"
          autocomplete="current-password"
        /></label
      >
      <Button class="w-full" type="submit" disabled={submitting}>{t(submitting ? '登录中…' : '登录')}</Button>
      {#if status.oauthEnabled}<Button class="w-full" type="button" variant="outline" onclick={oauthLogin}
          >{t('使用 OAuth 登录')}</Button
        >{/if}
    </form>
  </section>
</main>
