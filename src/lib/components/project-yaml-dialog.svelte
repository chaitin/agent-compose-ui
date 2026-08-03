<script lang="ts">
  import { onDestroy } from 'svelte';
  import Check from '@lucide/svelte/icons/check';
  import Copy from '@lucide/svelte/icons/copy';
  import Download from '@lucide/svelte/icons/download';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import * as Dialog from '$lib/components/ui/dialog';
  import { Button } from '$lib/components/ui/button';
  import { copyText } from '$lib/clipboard';
  import { t } from '$lib/i18n.svelte';
  import CodeEditor from '$lib/components/code-editor.svelte';

  let {
    open,
    projectName,
    revision,
    yaml,
    loading,
    error,
    onOpenChange,
  }: {
    open: boolean;
    projectName: string;
    revision: string;
    yaml: string;
    loading: boolean;
    error: string;
    onOpenChange: (open: boolean) => void;
  } = $props();

  let copyStatus = $state<'idle' | 'copied' | 'error'>('idle');
  let resetTimer = 0;

  async function copyYAML(): Promise<void> {
    try {
      await copyText(yaml);
      showCopyStatus('copied');
    } catch {
      showCopyStatus('error');
    }
  }

  function showCopyStatus(status: 'copied' | 'error'): void {
    copyStatus = status;
    window.clearTimeout(resetTimer);
    resetTimer = window.setTimeout(() => (copyStatus = 'idle'), 1600);
  }

  function downloadYAML(): void {
    const url = URL.createObjectURL(new Blob([yaml], { type: 'application/yaml;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${safeFileName(projectName)}.yaml`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function safeFileName(value: string): string {
    return value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-') || 'project';
  }

  onDestroy(() => window.clearTimeout(resetTimer));
</script>

<Dialog.Root {open} {onOpenChange}>
  <Dialog.Content
    data-project-yaml-dialog
    class="flex h-[min(52rem,calc(100dvh-2rem))] min-h-0 flex-col gap-3 sm:max-w-5xl"
    showCloseButton={false}
  >
    <Dialog.Header class="shrink-0 pr-10">
      <Dialog.Title>{t('当前配置')}</Dialog.Title>
      <Dialog.Description>
        {projectName}{#if revision}
          · {t('版本')} {revision}{/if} · {t('只读 YAML')}
      </Dialog.Description>
    </Dialog.Header>

    <div class="flex min-h-0 flex-1 flex-col">
      {#if loading}
        <div class="flex min-h-48 flex-1 items-center justify-center text-sm text-muted-foreground">
          {t('正在加载配置…')}
        </div>
      {:else if error}
        <div class="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
      {:else}
        <CodeEditor value={yaml} language="yaml" readOnly height="100%" title="项目 YAML" formatEnabled={false} />
      {/if}
    </div>

    <Dialog.Footer class="shrink-0 flex-col sm:flex-row">
      {#if yaml && !loading && !error}
        <Button variant="outline" onclick={() => void copyYAML()}>
          {#if copyStatus === 'copied'}<Check class="size-3.5 text-success" />{t(
              '已复制',
            )}{:else if copyStatus === 'error'}<TriangleAlert class="size-3.5 text-destructive" />{t(
              '复制失败',
            )}{:else}<Copy class="size-3.5" />{t('复制 YAML')}{/if}
        </Button>
        <Button variant="outline" onclick={downloadYAML}><Download class="size-3.5" />{t('下载 YAML')}</Button>
      {/if}
      <Button onclick={() => onOpenChange(false)}>{t('关闭')}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
