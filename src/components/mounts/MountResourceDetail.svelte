<script lang="ts">
  import type { AgentMount, ProjectDataResource } from '../../lib/project-resources/model';
  interface Props { resource?: ProjectDataResource; share?: AgentMount; locked: boolean; canBrowse: boolean; onUnmount: (mount: AgentMount) => void; onRemove: (resource: ProjectDataResource, trigger: HTMLButtonElement) => void; }
  let { resource, share, locked, canBrowse, onUnmount, onRemove }: Props = $props();
</script>
{#if resource}
  <section class="detail" aria-label={`${resource.key} 详情`}>
    <header><div><h3>{resource.key}</h3><code>{resource.systemName}</code></div><span>{resource.managed ? '托管卷' : '非托管卷'}</span></header>
    <p>{resource.mounts.length} 个挂载 / {new Set(resource.mounts.map((item) => item.agent)).size} 个 Agent</p>
    {#each resource.mounts as mount}<div class="mount"><span>{mount.agent} → <code>{mount.target}</code> · {mount.readOnly ? '只读' : '读写'}</span><button type="button" disabled={locked} onclick={() => onUnmount(mount)}>卸载</button></div>{/each}
    <button type="button" disabled={locked} onclick={(event) => onRemove(resource, event.currentTarget)}>移除声明…</button>
    {#if canBrowse}<div data-volume-browser></div>{/if}
  </section>
{:else if share}
  <section class="detail" aria-label={`${share.source} 详情`}><header><h3>共享目录</h3><code>{share.source}</code></header><p>{share.agent} → <code>{share.target}</code> · {share.readOnly ? '只读' : '读写'}</p><button type="button" disabled={locked} onclick={() => onUnmount(share)}>卸载</button></section>
{:else}<section class="detail" aria-label="资源详情"><p>请选择左侧资源查看详情。</p></section>{/if}
<style>
  .detail { padding: 12px; min-width: 0; overflow: auto; } header,.mount { display: flex; align-items: center; justify-content: space-between; gap: 8px; } h3 { margin: 0; } .mount { padding: 7px 0; border-bottom: 1px solid var(--border-color); }
</style>
