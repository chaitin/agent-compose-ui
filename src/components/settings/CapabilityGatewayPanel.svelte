<script lang="ts">
  import { onMount } from 'svelte';
  import {
    GetCapabilityGatewayConfigRequest,
    GetCapabilityStatusRequest,
    UpdateCapabilityGatewayConfigRequest,
    type CapabilityGatewayConfig,
    type CapabilityStatusResponse,
  } from '../../gen/agentcompose/v2/agentcompose_pb';
  import { capabilityService, settingsService } from '../../lib/rpc';

  type Mode = 'view' | 'edit';
  let { onconfigurationchange, onconfigured }: {
    onconfigurationchange?: (configured: boolean) => void;
    onconfigured?: () => void;
  } = $props();
  let config = $state<CapabilityGatewayConfig>();
  let status = $state<CapabilityStatusResponse>();
  let configError = $state('');
  let statusError = $state('');
  let loading = $state(false);
  let saving = $state(false);
  let mode = $state<Mode>('view');
  let address = $state('');
  let tokenDraft = $state('');
  let saveError = $state('');
  let lastConfigured: boolean | undefined;

  const message = (value: unknown) => value instanceof Error ? value.message : String(value);
  async function load() {
    loading = true;
    configError = '';
    statusError = '';
    const [configResult, statusResult] = await Promise.allSettled([
      settingsService.getCapabilityGatewayConfig(new GetCapabilityGatewayConfigRequest()),
      capabilityService.getCapabilityStatus(new GetCapabilityStatusRequest()),
    ]);
    if (configResult.status === 'fulfilled') {
      config = configResult.value.config;
      address = config?.addr ?? '';
      const configured = Boolean(config?.addr.trim());
      if (configured !== lastConfigured) {
        lastConfigured = configured;
        onconfigurationchange?.(configured);
      }
      if (!configured) mode = 'edit';
    } else configError = message(configResult.reason);
    if (statusResult.status === 'fulfilled') status = statusResult.value;
    else statusError = message(statusResult.reason);
    loading = false;
  }

  function validateAddress(value: string) {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:' ? '' : '地址必须使用 http:// 或 https://';
    } catch {
      return '地址必须使用 http:// 或 https://';
    }
  }

  async function save() {
    const trimmedAddress = address.trim();
    const issue = validateAddress(trimmedAddress);
    if (issue) { saveError = issue; return; }
    saving = true;
    saveError = '';
    const values: { addr?: string; token?: string } = { addr: trimmedAddress };
    if (tokenDraft.trim()) values.token = tokenDraft.trim();
    try {
      await settingsService.updateCapabilityGatewayConfig(new UpdateCapabilityGatewayConfigRequest(values));
      tokenDraft = '';
      await load();
      mode = 'view';
      onconfigured?.();
    } catch (cause) {
      saveError = message(cause);
    } finally {
      saving = false;
    }
  }

  onMount(load);
</script>

<section class="panel" aria-labelledby="gateway-title">
  <header><div><h2 id="gateway-title">能力网关</h2></div></header>
  {#if configError}<p class="error" role="alert">配置读取失败：{configError}</p>{/if}
  {#if statusError}<p class="error" role="alert">状态读取失败：{statusError}</p>{/if}
  {#if saveError}<p class="error" role="alert">{saveError}</p>{/if}
  {#if config}
    {#if mode === 'view' && config.addr}
      {#if status && !status.ok && status.error}<p class="error" role="alert">{status.error}</p>{/if}
      <div class="gateway-overview" data-testid="gateway-overview">
        <div class="gateway-identity" data-testid="gateway-address-row"><span>Gateway 地址</span><strong>{config.addr}</strong></div>
        <div class="gateway-status-row" data-testid="gateway-status-row">
          {#if status}
            <span class="status-item"><span class="status-dot" class:failure={!status.ok} role="img" aria-label={status.ok ? '连接正常' : '连接异常'}></span>{status.ok ? '连接正常' : '连接异常'}</span>
          {/if}
          {#if status}
            <span class="status-item"><span class="status-dot" class:failure={!status.runtimeConfigured} aria-hidden="true"></span>{status.runtimeConfigured ? '运行时可用' : '运行时不可用'}</span>
            <span class="status-item"><span class="status-dot" class:failure={!status.proxyListenConfigured} aria-hidden="true"></span>{status.proxyListenConfigured ? '监听已配置' : '监听未配置'}</span>
            <span class="status-item"><span class="status-dot" class:failure={!status.proxyTargetConfigured} aria-hidden="true"></span>{status.proxyTargetConfigured ? '目标已配置' : '目标未配置'}</span>
            {#if status.configured && status.ok}<span>{status.serviceCount} 个服务</span>{/if}
          {/if}
          <button type="button" onclick={() => mode = 'edit'}>编辑配置</button>
        </div>
      </div>
    {:else}
      {#if !config.addr}<p class="muted">未配置</p>{/if}
      <div class="form">
        <label><span>Gateway 地址</span><input aria-label="Gateway 地址" bind:value={address} /></label>
        <label><span>Gateway 令牌</span><input aria-label="Gateway 令牌" type="password" bind:value={tokenDraft} placeholder={config.tokenSet ? '留空以保留现有令牌' : ''} /></label>
        <div class="actions"><button type="button" onclick={save} disabled={saving}>保存配置</button>{#if config.addr}<button type="button" onclick={() => { mode = 'view'; address = config?.addr ?? ''; tokenDraft = ''; saveError = ''; }}>取消</button>{/if}</div>
      </div>
    {/if}
  {:else if loading}<p class="muted">正在读取配置…</p>{/if}
</section>

<style>
  .panel{padding:16px;border:1px solid var(--border-color);border-radius:8px;background:var(--bg-secondary)}header{display:flex;align-items:center;justify-content:space-between;gap:12px}h2{margin:0;font-size:var(--font-size-xl)}.gateway-overview{display:grid;gap:12px;margin-top:14px}.gateway-identity{display:flex;align-items:baseline;gap:10px;min-width:0}.gateway-identity span,.muted{flex:0 0 auto;color:var(--text-secondary);font-size:var(--font-size-xs)}.gateway-identity strong{min-width:0;overflow:hidden;font-size:var(--font-size-md);text-overflow:ellipsis;white-space:nowrap}.gateway-status-row{display:flex;flex-wrap:wrap;align-items:center;gap:10px 18px;color:var(--text-secondary);font-size:var(--font-size-sm)}.status-item{display:inline-flex;align-items:center;gap:7px}.status-dot{width:7px;height:7px;border-radius:50%;background:var(--accent-green);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent-green) 10%,transparent)}.status-dot.failure{background:var(--accent-orange);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent-orange) 10%,transparent)}button,input{border:1px solid var(--border-color);border-radius:5px;background:var(--bg-primary);color:var(--text-primary);padding:7px 10px}.form{display:grid;gap:10px;margin-top:14px}label{display:grid;gap:6px;font-size:var(--font-size-md)}.actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px}.error{color:var(--accent-red);font-size:var(--font-size-md)}@media(max-width:760px){.gateway-status-row{gap:10px 14px}}
</style>
