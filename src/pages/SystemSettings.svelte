<script lang="ts">
  import CapabilityGatewayPanel from '../components/settings/CapabilityGatewayPanel.svelte';
  import CapabilityCatalogPanel from '../components/settings/CapabilityCatalogPanel.svelte';
  import GlobalEnvPanel from '../components/settings/GlobalEnvPanel.svelte';
  import ImageListView from './ImageListView.svelte';
  import { store, type Page } from '../lib/stores.svelte';

  let gatewayConfigured = $state(false);
  let catalogRefreshRevision = $state(0);
  let activeModule = $derived(store.currentPage === 'environment'
    ? 'environment'
    : store.currentPage === 'settings' ? 'capabilities' : 'images');

  const modules: Array<{ id: 'images' | 'environment' | 'capabilities'; label: string; page: Page }> = [
    { id: 'images', label: '镜像', page: 'images' },
    { id: 'environment', label: '环境变量', page: 'environment' },
    { id: 'capabilities', label: '能力服务', page: 'settings' },
  ];

  function gatewaySaved() {
    gatewayConfigured = true;
    catalogRefreshRevision += 1;
  }

  function openModule(page: Page) {
    store.goTo(page);
  }

  function handleTabKeydown(event: KeyboardEvent, index: number) {
    const targetIndex = event.key === 'ArrowRight' ? (index + 1) % modules.length
      : event.key === 'ArrowLeft' ? (index - 1 + modules.length) % modules.length
      : event.key === 'Home' ? 0
      : event.key === 'End' ? modules.length - 1
      : -1;
    if (targetIndex < 0) return;
    event.preventDefault();
    openModule(modules[targetIndex].page);
    document.getElementById(`system-tab-${modules[targetIndex].id}`)?.focus();
  }
</script>

<div class="system-management">
  <header class="page-header">
    <div><h1>系统管理</h1></div>
    <div class="daemon-state"><i></i><span>当前 daemon</span><code>已连接</code></div>
  </header>

  <div class="route-tabs" role="tablist" aria-label="系统管理模块">
      {#each modules as item, index}
        <button
          id={`system-tab-${item.id}`}
          role="tab"
          class:active={activeModule === item.id}
          aria-selected={activeModule === item.id}
          aria-controls={`system-panel-${item.id}`}
          tabindex={activeModule === item.id ? 0 : -1}
          onclick={() => openModule(item.page)}
          onkeydown={(event) => handleTabKeydown(event, index)}
        >
          <span class="tab-label">{item.label}</span>
        </button>
      {/each}
  </div>

  <main class="module-stage">
      {#if activeModule === 'images'}
        <div id="system-panel-images" role="tabpanel" aria-labelledby="system-tab-images" class="module-content image-module"><ImageListView showTitle={false} showPullAction={false} /></div>
      {:else if activeModule === 'environment'}
        <div id="system-panel-environment" role="tabpanel" aria-labelledby="system-tab-environment" class="module-content environment-module">
          <div class="module-heading"><p>管理 YAML 应用前解析的 daemon 全局变量</p></div>
          <div class="environment-panel"><GlobalEnvPanel /></div>
        </div>
      {:else}
        <div id="system-panel-capabilities" role="tabpanel" aria-labelledby="system-tab-capabilities" class="module-content capability-module">
          <div class="module-heading"><p>网关连接决定 daemon 能发现和注入哪些外部能力</p></div>
          <div class="capability-stack" role="region" aria-label="能力服务连接">
            <div class="gateway-node">
              <CapabilityGatewayPanel
                onconfigurationchange={(configured) => gatewayConfigured = configured}
                onconfigured={gatewaySaved}
              />
            </div>
            <div class="catalog-node">
              <CapabilityCatalogPanel configured={gatewayConfigured} refreshRevision={catalogRefreshRevision} />
            </div>
          </div>
        </div>
      {/if}
  </main>
</div>

<style>
  .system-management{display:grid;grid-template-rows:auto auto minmax(0,1fr);height:100%;min-width:0;background:var(--bg-primary)}
  .page-header{display:grid;grid-template-columns:minmax(240px,1fr) auto;align-items:center;gap:24px;min-height:46px;padding:0 clamp(18px,2.5vw,38px);border-bottom:1px solid var(--border-color);box-sizing:border-box}
  .page-header h1{margin:0;font-size:var(--font-size-3xl);line-height:1.1;letter-spacing:-.03em}.daemon-state{display:grid;grid-template-columns:auto auto;align-items:center;gap:2px 7px;color:var(--text-secondary);font-size:var(--font-size-xs)}.daemon-state i{grid-row:1/3;width:7px;height:7px;border-radius:50%;background:var(--accent-green);box-shadow:0 0 0 4px color-mix(in srgb,var(--accent-green) 12%,transparent)}.daemon-state code{color:var(--text-muted);font:var(--font-size-xs) var(--font-mono)}
  .route-tabs{position:relative;display:flex;min-width:0;padding:0 clamp(18px,2.5vw,38px);overflow-x:auto;border-bottom:1px solid var(--border-color);background:var(--bg-secondary);scrollbar-width:thin}.route-tabs::after{content:'ROUTE-BACKED';align-self:center;margin-left:auto;padding-left:30px;color:var(--text-muted);font:var(--font-size-xs) var(--font-mono);letter-spacing:.13em;white-space:nowrap}.route-tabs button{position:relative;display:grid;flex:0 0 auto;align-content:center;min-width:146px;min-height:47px;padding:0 18px;border:0;background:transparent;color:var(--text-secondary);text-align:center}.route-tabs button::after{content:'';position:absolute;right:18px;bottom:-1px;left:18px;height:2px;background:transparent;transform:scaleX(.35);transition:background .14s ease,transform .14s ease}.route-tabs button:hover{background:var(--bg-tertiary);color:var(--text-primary)}.route-tabs button.active{color:var(--text-primary)}.route-tabs button.active::after{background:var(--accent-blue);transform:scaleX(1)}.tab-label{font-size:var(--font-size-md);font-weight:600}
  .module-stage{min-width:0;overflow:auto}.module-content{min-height:100%;animation:module-in .15s ease-out}.environment-module,.capability-module{padding:26px clamp(18px,2.6vw,38px) 38px}.module-heading{margin-bottom:18px;padding-bottom:15px;border-bottom:1px solid var(--border-color)}.module-heading p{margin:0;color:var(--text-secondary);font-size:var(--font-size-sm)}.image-module :global(.root){height:auto;min-height:100%;overflow:visible;padding:22px clamp(18px,2.6vw,38px) 38px}
  .environment-panel{width:100%}.environment-module :global(.panel){border-radius:7px}
  .capability-stack{display:grid;gap:16px}.gateway-node,.catalog-node{display:flex;min-width:0}.gateway-node :global(.panel),.catalog-node :global(.panel){width:100%;border-radius:7px}
  @keyframes module-in{from{opacity:0;transform:translateX(5px)}to{opacity:1;transform:none}}
  @media(max-width:720px){.page-header{min-height:46px;padding:0 13px}.daemon-state{display:none}.route-tabs{position:sticky;top:0;z-index:4;padding:0 8px}.route-tabs::after{display:none}.route-tabs button{min-width:auto;min-height:47px;padding:0 14px;text-align:center}.route-tabs button::after{right:14px;left:14px}.environment-module,.capability-module{padding:18px 12px 30px}}
  @media(prefers-reduced-motion:reduce){.module-content{animation:none}}
</style>
