<script lang="ts">
  import { onMount } from 'svelte';
  import * as Command from '$lib/components/ui/command';
  import { navGroups } from '$lib/nav';
  import { navigate } from '$lib/router.svelte';
  import { command } from '$lib/command.svelte';
  import { listAgentDefinitions, type AgentDefinition } from '../../api/agents';
  import { listRuns } from '../../api/runs';
  import { resolveResource, routeForTarget } from '../../api/resources';
  import type { RunSummary } from '../../gen/agentcompose/v2/agentcompose_pb.js';

  let agents = $state<AgentDefinition[]>([]);
  let runs = $state<RunSummary[]>([]);
  let query = $state('');
  let resolveError = $state('');
  let loaded = $state(false);

  onMount(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        command.toggle();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  $effect(() => {
    if (!command.open || loaded) return;
    loaded = true;
    void Promise.all([listAgentDefinitions(), listRuns({ limit: 50 })])
      .then(([agentItems, runItems]) => {
        agents = agentItems;
        runs = runItems;
      })
      .catch(() => {
        loaded = false;
      });
  });

  function go(to: string) {
    command.open = false;
    navigate(to);
  }

  async function resolveID(): Promise<void> {
    const id = query.trim();
    if (!id) return;
    try {
      const result = await resolveResource(id);
      const route = result.targets.map(routeForTarget).find(Boolean);
      if (route) go(route);
      else resolveError = result.warnings.join(' · ') || '资源存在，但当前 UI 没有对应详情路由';
    } catch (cause) {
      resolveError = cause instanceof Error ? cause.message : '无法解析资源 ID';
    }
  }
</script>

<Command.Dialog bind:open={command.open}>
  <Command.Input bind:value={query} placeholder="跳转页面，或输入 ID 直达资源…" />
  <Command.List>
    <Command.Empty>没有匹配项。</Command.Empty>
    {#each navGroups as group (group.title)}
      <Command.Group heading={group.title}>
        {#each group.items as item (item.href)}
          <Command.Item onSelect={() => go(item.href)}>
            <item.icon class="size-4 text-muted-foreground" />
            <span>{item.label}</span>
          </Command.Item>
        {/each}
      </Command.Group>
    {/each}
    <Command.Separator />
    {#if query.trim()}
      <Command.Group heading="资源解析">
        <Command.Item value={`resolve ${query}`} onSelect={resolveID}
          ><span class="font-mono text-xs">ID</span><span>解析 {query}</span></Command.Item
        >
        {#if resolveError}<div class="px-2 py-1 text-xs text-destructive">{resolveError}</div>{/if}
      </Command.Group>
      <Command.Separator />
    {/if}
    <Command.Group heading="智能体">
      {#each agents as a (a.id)}
        <Command.Item value={`agent ${a.id}`} onSelect={() => go(`/agents/${a.id}`)}>
          <span class="font-mono text-xs text-muted-foreground">agent</span>
          <span>{a.name}</span>
        </Command.Item>
      {/each}
    </Command.Group>
    <Command.Group heading="运行">
      {#each runs as r (r.runId)}
        <Command.Item value={`run ${r.runId}`} onSelect={() => go(`/runs/${r.runId}`)}>
          <span class="font-mono text-xs text-muted-foreground">run</span>
          <span>{r.runShortId || r.runId}</span>
        </Command.Item>
      {/each}
    </Command.Group>
  </Command.List>
</Command.Dialog>
