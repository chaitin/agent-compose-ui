<script lang="ts">
  import { GetCapabilityCatalogRequest, ListCapabilitySetsRequest, type CapabilitySet, type GetCapabilityCatalogResponse } from '../../gen/agentcompose/v2/agentcompose_pb';
  import { capabilityService } from '../../lib/rpc';
  let { configured = false, refreshRevision = 0 } = $props<{
    configured?: boolean;
    refreshRevision?: number;
  }>();
  let sets = $state<CapabilitySet[]>([]), selected = $state(''), catalog = $state<GetCapabilityCatalogResponse>(), error = $state(''), loading = $state(false);
  let requestId = 0;
  const message = (value: unknown) => value instanceof Error ? value.message : String(value);
  async function loadCatalog(id: string, currentRequestId: number) {
    if (!id) return;
    loading = true;
    error = '';
    try {
      const response = await capabilityService.getCapabilityCatalog(new GetCapabilityCatalogRequest({capsetId:id}));
      if (currentRequestId === requestId) catalog = response;
    } catch(cause) {
      if (currentRequestId === requestId) error = message(cause);
    } finally {
      if (currentRequestId === requestId) loading = false;
    }
  }
  async function load(currentRequestId: number) {
    loading = true;
    error = '';
    try {
      const response = await capabilityService.listCapabilitySets(new ListCapabilitySetsRequest());
      if (currentRequestId !== requestId) return;
      sets = response.capsets;
      const first = sets.find(item=>item.enabled) ?? sets[0];
      selected = first?.id ?? '';
      if (selected) await loadCatalog(selected, currentRequestId);
      else {
        catalog = undefined;
        loading = false;
      }
    } catch(cause) {
      if (currentRequestId === requestId) {
        error = message(cause);
        loading = false;
      }
    }
  }
  function choose(event: Event) {
    selected = (event.currentTarget as HTMLSelectElement).value;
    void loadCatalog(selected, ++requestId);
  }
  $effect(() => {
    configured;
    refreshRevision;
    const currentRequestId = ++requestId;
    if (!configured) {
      sets = [];
      selected = '';
      catalog = undefined;
      error = '';
      loading = false;
      return;
    }
    void load(currentRequestId);
  });
</script>
<section class="panel" aria-labelledby="catalog-title">
  <header class="panel-header">
    <h2 class="title" id="catalog-title">能力目录</h2>
    <label>能力集<select aria-label="能力集" value={selected} onchange={choose}>{#each sets as item}<option value={item.id}>{item.name || item.id}{item.enabled?' · 启用':''}</option>{/each}</select></label>
  </header>
  <div class="catalog-content" id="catalog-content">
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      {#if !configured}
        <p class="empty">请先配置能力网关</p>
      {:else if catalog}
        {#if catalog.description}<p class="description">{catalog.description}</p>{/if}
        <div class="methods" role="list" data-testid="capability-list-scroll">
          <div class="method-head" role="row" aria-label="能力方法列名">
            <span>方法名称</span>
            <span>服务 ID</span>
            <span>运行状态</span>
            <span>访问端点</span>
          </div>
          {#each catalog.methods as method}
            <article role="listitem">
              <strong class="method-name" title={method.methodFullName}>{method.methodFullName}</strong>
              <span class="service-id" title={method.serviceId}>{method.serviceId || '—'}</span>
              <span class="method-status">{method.backendInstanceStatus || '—'}</span>
              <div class="endpoints">
                {#each method.endpoints as endpoint}
                  <div class="endpoint">
                    <code>{endpoint.httpMethod || endpoint.protocol || '—'}</code>
                    <code title={endpoint.methodPath || endpoint.endpoint}>{endpoint.methodPath || endpoint.endpoint || '—'}</code>
                  </div>
                {:else}
                  <code>—</code>
                {/each}
              </div>
            </article>
          {:else}
            <p class="empty">此能力集未发布方法。</p>
          {/each}
        </div>
      {:else if loading}
        <p class="empty">正在读取目录…</p>
      {:else if !error && sets.length === 0}
        <p class="empty">网关未发布可用能力集</p>
      {/if}
  </div>
</section>
<style>
  .panel{min-width:0;border:1px solid var(--border-color);border-radius:10px;background:var(--bg-secondary);overflow:hidden}.panel-header{display:flex;min-height:68px;align-items:center;justify-content:space-between;gap:16px;padding:12px 18px}.title{margin:0;font-size:var(--font-size-xl);font-weight:600}label{display:flex;align-items:center;gap:8px;color:var(--text-secondary);font-size:var(--font-size-xs);white-space:nowrap}select{min-width:190px;border:1px solid var(--border-color);border-radius:5px;background:var(--bg-primary);color:var(--text-primary);padding:6px}.catalog-content{min-width:0;padding:0 18px 18px;border-top:1px solid color-mix(in srgb,var(--border-color) 70%,transparent)}.description,.empty{margin-top:14px;color:var(--text-secondary);font-size:var(--font-size-md)}.methods{width:100%;min-width:0;max-height:min(52vh,430px);margin-top:12px;overflow-y:auto;box-sizing:border-box;border-top:1px solid var(--border-color);border-bottom:1px solid var(--border-color)}.method-head,article{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,.5fr) minmax(0,.5fr) minmax(0,1.5fr);align-items:start;gap:14px;min-width:0;padding-inline:6px}.method-head{position:sticky;top:0;z-index:1;min-height:31px;align-items:center;border-bottom:1px solid var(--border-color);background:var(--bg-tertiary);color:var(--text-muted);font:var(--font-size-xs) var(--font-mono);letter-spacing:.04em}.method-head span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}article{min-height:45px;padding-top:10px;padding-bottom:10px;border-bottom:1px solid color-mix(in srgb,var(--border-color) 70%,transparent)}article:last-child{border-bottom:0}.method-name{min-width:0;overflow:hidden;font:var(--font-size-sm) var(--font-mono);text-overflow:ellipsis;white-space:nowrap}.service-id,.method-status{min-width:0;overflow:hidden;color:var(--text-secondary);font:var(--font-size-xs) var(--font-mono);text-overflow:ellipsis;white-space:nowrap}.endpoints{display:grid;min-width:0;gap:6px;color:var(--text-secondary)}.endpoint{display:grid;grid-template-columns:minmax(42px,auto) minmax(0,1fr);min-width:0;gap:8px}.endpoint code,.endpoints>code{min-width:0;overflow:hidden;font-size:var(--font-size-xs);text-overflow:ellipsis;white-space:nowrap}.error{margin-top:14px;color:var(--accent-red);font-size:var(--font-size-md)}@media(max-width:600px){.panel-header{align-items:stretch;flex-direction:column}label{justify-content:space-between}select{min-width:0;flex:1}.method-head,article{grid-template-columns:minmax(0,1fr) auto}.method-head span:nth-child(2){grid-column:1}.method-head span:nth-child(3){grid-column:2;grid-row:1}.method-head span:nth-child(4){grid-column:1/-1}.service-id{grid-column:1}.method-status{grid-column:2;grid-row:1}.endpoints{grid-column:1/-1}}
</style>
