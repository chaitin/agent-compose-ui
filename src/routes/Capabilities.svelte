<script lang="ts">
  import { onMount } from 'svelte';
  import PageHeader from '$lib/components/page-header.svelte';
  import PageContent from '$lib/components/page-content.svelte';
  import CopyableText from '$lib/components/copyable-text.svelte';
  import { Button } from '$lib/components/ui/button';
  import {
    getCapabilityCatalog,
    getCapabilityStatus,
    listCapabilitySets,
    type CapabilityMethodInfo,
    type CapabilitySet,
    type CapabilityStatus,
  } from '../api/config';
  let status = $state<CapabilityStatus | null>(null);
  let sets = $state<CapabilitySet[]>([]);
  let selected = $state('');
  let methods = $state<CapabilityMethodInfo[]>([]);
  let loading = $state(true);
  let error = $state('');
  onMount(load);
  async function load() {
    loading = true;
    error = '';
    try {
      [status, sets] = await Promise.all([getCapabilityStatus(), listCapabilitySets()]);
      if (sets[0]) await select(sets[0].id);
    } catch (e) {
      error = e instanceof Error ? e.message : '加载失败';
    } finally {
      loading = false;
    }
  }
  async function select(id: string) {
    selected = id;
    methods = await getCapabilityCatalog(id);
  }
</script>

<PageHeader title="能力集" description="能力网关状态、capset 与方法目录"
  >{#snippet actions()}<Button variant="outline" size="sm" onclick={load}>刷新</Button>{/snippet}</PageHeader
>
<PageContent class="space-y-4">
  {#if error}<div class="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>{:else if loading}<p
      class="text-sm text-muted-foreground"
    >
      正在加载能力网关…
    </p>{:else}<div class="rounded-lg border border-border bg-card p-4 text-sm">
      <span class="mr-2 inline-block size-2 rounded-full {status?.ok ? 'bg-success' : 'bg-destructive'}"
      ></span>{status?.ok ? '已连接' : '未连接'} · {status?.status || '未配置'} · {status?.serviceCount ?? 0} 个服务{#if status?.error}<p
          class="mt-2 text-destructive"
        >
          {status.error}
        </p>{/if}
    </div>
    <div class="grid gap-4 lg:grid-cols-[18rem_1fr]">
      <div class="space-y-1 rounded-lg border border-border p-2">
        {#each sets as set (set.id)}<div
            class="relative rounded-md text-sm {selected === set.id ? 'bg-accent' : 'hover:bg-accent/50'}"
          >
            <button class="w-full p-2 pr-8 text-left" onclick={() => select(set.id)}
              ><div class="font-medium">{set.name || set.id}</div>
              <div class="truncate text-xs text-muted-foreground" title={set.id}>{set.id}</div></button
            >
            <CopyableText
              value={set.id}
              display=""
              label="Capability Set ID"
              class="absolute right-2 top-1/2 -translate-y-1/2"
            />
          </div>{:else}<p class="p-4 text-sm text-muted-foreground">没有能力集</p>{/each}
      </div>
      <div class="overflow-hidden rounded-lg border border-border">
        <table class="w-full text-sm">
          <thead class="bg-muted/40"
            ><tr><th class="p-3 text-left">方法</th><th class="p-3 text-left">说明</th></tr></thead
          ><tbody class="divide-y divide-border"
            >{#each methods as method (method.methodFullName)}<tr
                ><td class="p-3 font-mono text-xs">{method.methodFullName}</td><td class="p-3 text-muted-foreground"
                  >{method.serviceId} · {method.backendInstanceStatus || '未知'}</td
                ></tr
              >{:else}<tr><td colspan="2" class="p-8 text-center text-muted-foreground">选择能力集查看方法</td></tr
              >{/each}</tbody
          >
        </table>
      </div>
    </div>{/if}
</PageContent>
