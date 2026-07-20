<script lang="ts">
  import { login, type AuthStatus } from '../lib/auth';

  let { onAuthenticated }: { onAuthenticated: (status: AuthStatus) => void } = $props();
  let username = $state('');
  let password = $state('');
  let pending = $state(false);
  let error = $state('');

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (pending) return;
    pending = true;
    error = '';
    void login(username, password).then((status) => {
      if (!status.loggedIn) throw new Error('用户名或密码错误');
      password = '';
      onAuthenticated(status);
    }).catch((cause: unknown) => {
      error = cause instanceof Error ? cause.message : '登录失败，请重试';
    }).finally(() => {
      pending = false;
    });
  }
</script>

<main class="login-gate">
  <section class="login-panel" aria-labelledby="login-title">
    <header>
      <div class="gateway-line" aria-hidden="true"><i></i><span></span><i></i></div>
      <p class="eyebrow">AGENT COMPOSE / ACCESS GATEWAY</p>
      <h1 id="login-title">进入控制台</h1>
      <p class="description">使用内网账号验证访问权限。</p>
    </header>

    <form aria-label="登录" onsubmit={submit}>
      <label for="auth-username">用户名</label>
      <input id="auth-username" bind:value={username} autocomplete="username" required />
      <label for="auth-password">密码</label>
      <input id="auth-password" bind:value={password} type="password" autocomplete="current-password" required />
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      <button type="submit" disabled={pending}>{pending ? '正在验证…' : '进入控制台'}</button>
    </form>
  </section>
</main>

<style>
  .login-gate { display:grid; min-height:100%; place-items:center; padding:24px; background:var(--bg-primary); }
  .login-panel { width:min(400px,100%); overflow:hidden; border:1px solid var(--border-color); border-radius:8px; background:var(--bg-secondary); box-shadow:0 18px 50px #0005; }
  header { padding:24px 24px 20px; border-bottom:1px solid var(--border-color); }
  .gateway-line { display:grid; grid-template-columns:8px 1fr 8px; align-items:center; gap:7px; margin-bottom:20px; }
  .gateway-line i { width:8px; height:8px; border:2px solid var(--accent-green); border-radius:50%; }
  .gateway-line span { height:1px; background:linear-gradient(90deg,var(--accent-green),var(--border-color)); transform-origin:left; animation:connect .6s ease-out both; }
  .eyebrow { color:var(--accent-green); font:var(--font-size-xs) var(--font-mono); letter-spacing:.08em; }
  h1 { margin-top:8px; font-size:var(--font-size-3xl); font-weight:600; }
  .description { margin-top:7px; color:var(--text-secondary); font-size:var(--font-size-sm); }
  form { display:grid; gap:7px; padding:22px 24px 24px; }
  label { margin-top:6px; color:var(--text-secondary); font-size:var(--font-size-sm); }
  input { width:100%; min-height:38px; padding:7px 10px; background:var(--bg-primary); }
  input:focus-visible,button:focus-visible { outline:2px solid var(--accent-blue); outline-offset:2px; }
  button { min-height:38px; margin-top:12px; border:1px solid var(--accent-green); border-radius:5px; background:var(--accent-green); color:#071009; font-weight:600; }
  button:disabled { cursor:wait; opacity:.65; }
  .error { margin-top:5px; color:var(--accent-red); font-size:var(--font-size-sm); }
  @keyframes connect { from { transform:scaleX(0); opacity:0; } }
  @media (max-width:480px) { .login-gate{align-items:start;padding:16px}.login-panel{margin-top:8vh}header,form{padding-inline:18px} }
  @media (prefers-reduced-motion:reduce) { .gateway-line span{animation:none} }
</style>
