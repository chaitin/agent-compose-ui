<script lang="ts">
  import { onMount } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import CopyableText from '$lib/components/copyable-text.svelte';
  import PageHeader from '$lib/components/page-header.svelte';
  import PageContent from '$lib/components/page-content.svelte';
  import Timestamp from '$lib/components/timestamp.svelte';
  import { timestampToISOString } from '../model/timestamps';
  import { buildImage, inspectImage, listImages, pullImage, removeImage, type ImagePage } from '../api/resources';
  import type { Image } from '../gen/agentcompose/v2/agentcompose_pb.js';

  let page = $state<ImagePage | null>(null);
  let selected = $state<Image | null>(null);
  let query = $state('');
  let pullRef = $state('');
  let busy = $state(false);
  let error = $state('');
  let messages = $state<string[]>([]);
  let showBuild = $state(false);
  let contextDir = $state('');
  let dockerfile = $state('Dockerfile');
  let tags = $state('');

  onMount(load);
  async function load() {
    busy = true;
    error = '';
    try {
      page = await listImages(query);
    } catch (e) {
      error = message(e);
    } finally {
      busy = false;
    }
  }
  async function pull() {
    if (!pullRef.trim()) return;
    busy = true;
    error = '';
    try {
      messages = await pullImage(pullRef.trim());
      pullRef = '';
      await load();
    } catch (e) {
      error = message(e);
    } finally {
      busy = false;
    }
  }
  async function inspect(item: Image) {
    busy = true;
    try {
      selected = (await inspectImage(item.imageRef || item.repoTags[0] || item.imageId)) ?? item;
    } catch (e) {
      error = message(e);
    } finally {
      busy = false;
    }
  }
  async function remove(item: Image) {
    const ref = item.imageRef || item.repoTags[0] || item.imageId;
    if (!confirm(`确认删除镜像 ${ref}？`)) return;
    busy = true;
    try {
      messages = await removeImage(ref);
      selected = null;
      await load();
    } catch (e) {
      error = message(e);
    } finally {
      busy = false;
    }
  }
  async function build() {
    if (!contextDir.trim() || !tags.trim()) {
      error = '构建目录和至少一个标签必填';
      return;
    }
    busy = true;
    messages = [];
    error = '';
    try {
      await buildImage(
        {
          contextDir: contextDir.trim(),
          dockerfile: dockerfile.trim(),
          tags: tags
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean),
        },
        (line) => {
          if (line) messages = [...messages, line];
        },
      );
      showBuild = false;
      await load();
    } catch (e) {
      error = message(e);
    } finally {
      busy = false;
    }
  }
  const message = (cause: unknown) => (cause instanceof Error ? cause.message : '请求失败');
  const bytes = (value: bigint) => (value > 0n ? `${(Number(value) / 1024 / 1024).toFixed(1)} MB` : '—');
</script>

<PageHeader title="镜像" description="Docker / OCI 镜像存储、拉取与构建">
  {#snippet actions()}<Button variant="outline" size="sm" onclick={() => (showBuild = !showBuild)}>构建镜像</Button
    >{/snippet}
</PageHeader>
<PageContent class="space-y-4">
  {#if error}<div class="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
      {error} <button class="ml-2 underline" onclick={load}>重试</button>
    </div>{/if}
  <div class="flex flex-wrap gap-2">
    <Input
      bind:value={query}
      class="max-w-sm"
      placeholder="过滤引用、标签或 ID"
      onkeydown={(event: KeyboardEvent) => event.key === 'Enter' && load()}
    /><Button variant="outline" onclick={load} disabled={busy}>查询</Button><Input
      bind:value={pullRef}
      class="max-w-sm"
      placeholder="例如 node:20"
    /><Button onclick={pull} disabled={busy}>拉取</Button>
  </div>
  {#if showBuild}<form
      class="grid gap-2 rounded-lg border border-border bg-card p-4 md:grid-cols-3"
      onsubmit={(e) => {
        e.preventDefault();
        void build();
      }}
    >
      <Input bind:value={contextDir} placeholder="构建上下文绝对路径" /><Input
        bind:value={dockerfile}
        placeholder="Dockerfile"
      /><Input bind:value={tags} placeholder="标签，逗号分隔" />
      <div class="md:col-span-3"><Button type="submit" disabled={busy}>开始构建</Button></div>
    </form>{/if}
  {#if messages.length}<pre
      data-scroll-surface
      class="max-h-48 overflow-auto rounded-lg bg-muted p-3 text-xs">{messages.join('\n')}</pre>{/if}
  {#if busy && !page}<p class="text-sm text-muted-foreground">正在加载镜像…</p>{:else if page}
    <div class="text-xs text-muted-foreground">
      Store {page.available ? '可用' : '不可用'} · {page.endpoint || '默认端点'} · {page.totalCount} 个镜像 {page.error}
    </div>
    <div class="overflow-hidden rounded-lg border border-border">
      <table class="w-full text-sm">
        <thead class="bg-muted/40"
          ><tr
            ><th class="p-3 text-left">引用</th><th class="p-3 text-left">平台</th><th class="p-3 text-left">大小</th
            ><th class="p-3 text-left">创建时间</th><th class="p-3 text-left">容器</th><th></th></tr
          ></thead
        ><tbody class="divide-y divide-border"
          >{#each page.images as item (item.imageId + item.imageRef)}<tr
              ><td class="max-w-80 p-3"
                ><CopyableText
                  value={item.imageRef || item.repoTags[0] || item.imageId}
                  label="镜像引用"
                  class="max-w-full font-mono text-xs"
                />
                {#if item.imageId}<CopyableText
                    value={item.imageId}
                    label="镜像 ID"
                    class="mt-1 max-w-full font-mono text-xs text-muted-foreground"
                  />{/if}</td
              ><td class="p-3 text-muted-foreground">{item.platform?.os}/{item.platform?.architecture}</td><td
                class="p-3">{bytes(item.sizeBytes)}</td
              ><td class="p-3 text-xs text-muted-foreground"
                ><Timestamp value={timestampToISOString(item.createdAt)} /></td
              ><td class="p-3">{item.containerCount.toString()}</td><td class="p-3 text-right"
                ><Button variant="ghost" size="sm" onclick={() => inspect(item)}>检查</Button><Button
                  variant="ghost"
                  size="sm"
                  class="text-destructive"
                  onclick={() => remove(item)}>删除</Button
                ></td
              ></tr
            >{:else}<tr><td colspan="6" class="p-10 text-center text-muted-foreground">没有镜像</td></tr>{/each}</tbody
        >
      </table>
    </div>
  {/if}
  {#if selected}<div class="rounded-lg border border-border bg-card p-4">
      <div class="mb-2 flex justify-between">
        <h2 class="font-medium">镜像详情</h2>
        <button onclick={() => (selected = null)}>关闭</button>
      </div>
      <dl class="mb-4 grid grid-cols-[6rem_minmax(0,1fr)] gap-2 text-sm">
        <dt class="text-muted-foreground">镜像 ID</dt>
        <dd><CopyableText value={selected.imageId} label="镜像 ID" class="max-w-full font-mono text-xs" /></dd>
        <dt class="text-muted-foreground">引用</dt>
        <dd><CopyableText value={selected.imageRef} label="镜像引用" class="max-w-full font-mono text-xs" /></dd>
        <dt class="text-muted-foreground">创建时间</dt>
        <dd><Timestamp value={timestampToISOString(selected.createdAt)} mode="full" /></dd>
        <dt class="text-muted-foreground">检查时间</dt>
        <dd><Timestamp value={timestampToISOString(selected.inspectedAt)} mode="full" /></dd>
      </dl>
      <pre data-scroll-surface class="max-h-72 overflow-auto whitespace-pre-wrap text-xs">{selected.toJsonString({
          prettySpaces: 2,
        })}</pre>
    </div>{/if}
</PageContent>
