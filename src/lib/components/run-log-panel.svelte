<script lang="ts">
  import { untrack } from 'svelte';
  import RunLogViewer from '$lib/components/run-log-viewer.svelte';
  import { RunLogFeed } from '$lib/run-log-feed.svelte';
  import { t } from '$lib/i18n.svelte';
  import { followRunLogs } from '../../api/runs';

  // 单次运行的日志：末尾 2000 行、运行中继续跟随、按字节分段加载更早，下载时单独读取完整日志。
  let {
    runId,
    projectId,
    running,
    onError,
  }: { runId: string; projectId: string; running: boolean; onError?: (message: string) => void } = $props();

  let feed = $state<RunLogFeed | null>(null);
  let query = $state('');
  let downloading = $state(false);
  let preserveLine = $state(0);

  $effect(() => {
    const next = new RunLogFeed(runId, projectId);
    // 只在打开时决定是否跟随：运行结束后跟随的连接会自然结束，状态变化不需要重开日志。
    const follow = untrack(() => running);
    feed = next;
    preserveLine = 0;
    void next.start(follow).then(() => {
      if (next.error) untrack(() => onError)?.(next.error);
    });
    return () => next.stop();
  });

  async function loadEarlier(): Promise<void> {
    if (!feed) return;
    // 新行插在最上面，总是在视口上方，补偿滚动位置让屏幕上的内容不动。
    preserveLine += await feed.loadEarlier();
  }

  async function download(): Promise<void> {
    if (downloading) return;
    downloading = true;
    const controller = new AbortController();
    try {
      const parts: string[] = [];
      await followRunLogs(runId, (chunk) => void (chunk.data && parts.push(chunk.data)), controller.signal, {
        follow: false,
        projectId,
        startOffset: 0n,
      });
      const url = URL.createObjectURL(new Blob(parts, { type: 'text/plain' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${runId}.log`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      onError?.(cause instanceof Error ? cause.message : t('日志加载失败'));
    } finally {
      downloading = false;
    }
  }
</script>

<RunLogViewer
  {query}
  lines={feed?.lines ?? []}
  loadedLineCount={feed?.lines.length ?? 0}
  hasEarlier={feed?.hasEarlier ?? false}
  loadingEarlier={feed?.loadingEarlier ?? false}
  {downloading}
  {preserveLine}
  onQuery={(value) => (query = value)}
  onDownload={() => void download()}
  onLoadEarlier={() => void loadEarlier()}
/>
