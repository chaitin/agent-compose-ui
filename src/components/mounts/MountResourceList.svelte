<script lang="ts">
  import type { AgentMount, ProjectDataResource } from '../../lib/project-resources/model';
  export type MountSelection = { kind: 'volume'; key: string } | { kind: 'share'; source: string; agent: string; target: string };
  interface Props { volumes: ProjectDataResource[]; cacheKeys: string[]; shares: AgentMount[]; selected: MountSelection | null; onSelect: (value: MountSelection) => void; }
  let { volumes, cacheKeys, shares, selected, onSelect }: Props = $props();
  const caches = $derived(volumes.filter((item) => cacheKeys.includes(item.key)));
  const data = $derived(volumes.filter((item) => !cacheKeys.includes(item.key)));
  const active = (value: MountSelection) => JSON.stringify(value) === JSON.stringify(selected);
</script>
<nav aria-label="数据资源">
  <fieldset><legend>持久数据</legend>{#if !data.length}<p>暂无</p>{/if}{#each data as item}<button class="ui-button ghost" type="button" aria-current={active({ kind: 'volume', key: item.key }) ? 'true' : undefined} onclick={() => onSelect({ kind: 'volume', key: item.key })}>{item.key} <span>{item.mounts.length}</span></button>{/each}</fieldset>
  <fieldset><legend>依赖缓存</legend>{#if !caches.length}<p>暂无</p>{/if}{#each caches as item}<button class="ui-button ghost" type="button" aria-current={active({ kind: 'volume', key: item.key }) ? 'true' : undefined} onclick={() => onSelect({ kind: 'volume', key: item.key })}>{item.key} <span>{item.mounts.length}</span></button>{/each}</fieldset>
  <fieldset><legend>共享目录</legend>{#if !shares.length}<p>暂无</p>{/if}{#each shares as item}<button class="ui-button ghost" type="button" aria-current={active({ kind: 'share', source: item.source, agent: item.agent, target: item.target }) ? 'true' : undefined} onclick={() => onSelect({ kind: 'share', source: item.source, agent: item.agent, target: item.target })}>{item.source} · {item.agent}</button>{/each}</fieldset>
</nav>
<style>
  nav { padding: 8px; border-right: 1px solid var(--border-color); overflow: auto; } fieldset { display: grid; gap: 4px; margin: 0 0 10px; border: 0; } legend { font-weight: 600; } button { display: flex; justify-content: space-between; text-align: left; } button[aria-current='true'] { color: var(--accent-blue); } p { margin: 2px 0; color: var(--text-secondary); }
</style>
