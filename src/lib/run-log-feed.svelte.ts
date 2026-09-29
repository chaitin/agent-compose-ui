// 一次运行的日志订阅：先取末尾 LOG_TAIL_LINES 行，运行中则继续跟随；
// 数据块进 LogBuffer，按 LOG_FLUSH_MS 合并后才更新响应式的 lines。
import { followRunLogs, readRunLogRange } from '../api/runs';
import { earlierLines, LOG_EARLIER_BYTES, LOG_FLUSH_MS, LOG_TAIL_LINES, LogBuffer } from '../model/log-buffer';
import { t } from '$lib/i18n.svelte';

export class RunLogFeed {
  lines = $state<string[]>([]);
  loaded = $state(false);
  error = $state('');
  hasEarlier = $state(false);
  loadingEarlier = $state(false);

  private buffer = new LogBuffer();
  private controller: AbortController | null = null;
  private earlierController: AbortController | null = null;
  private timer = 0;
  private stopped = false;

  constructor(
    readonly runId: string,
    readonly projectId: string,
  ) {}

  /** 打开日志。follow 为 true 时保持连接，持续追加新内容。 */
  async start(follow: boolean): Promise<void> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    try {
      await followRunLogs(
        this.runId,
        (chunk) => {
          this.buffer.push(chunk);
          if (chunk.data && follow) {
            // 跟随时第一次拿到内容就离开「加载中」，之后按间隔合并。
            if (!this.loaded) this.apply();
            else this.schedule();
          }
        },
        controller.signal,
        { follow, projectId: this.projectId, tailLines: LOG_TAIL_LINES },
      );
    } catch (cause) {
      if (!controller.signal.aborted) this.error = cause instanceof Error ? cause.message : t('日志加载失败');
    } finally {
      if (!this.stopped) this.apply();
    }
  }

  /** 往前再加载一段，返回新增的行数（调用方用它保持滚动位置）。 */
  async loadEarlier(): Promise<number> {
    const until = this.buffer.start;
    if (this.loadingEarlier || until <= 0n) return 0;
    this.loadingEarlier = true;
    const controller = new AbortController();
    this.earlierController = controller;
    try {
      const from = until > BigInt(LOG_EARLIER_BYTES) ? until - BigInt(LOG_EARLIER_BYTES) : 0n;
      const text = await readRunLogRange(this.runId, this.projectId, from, until, controller.signal);
      if (this.stopped) return 0;
      const earlier = earlierLines(text, from);
      this.buffer.prepend(earlier.lines, earlier.start);
      this.apply();
      return earlier.lines.length;
    } catch (cause) {
      if (!controller.signal.aborted) this.error = cause instanceof Error ? cause.message : t('日志加载失败');
      return 0;
    } finally {
      this.loadingEarlier = false;
    }
  }

  stop(): void {
    this.stopped = true;
    this.controller?.abort();
    this.earlierController?.abort();
    window.clearTimeout(this.timer);
    this.timer = 0;
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      this.apply();
    }, LOG_FLUSH_MS);
  }

  private apply(): void {
    window.clearTimeout(this.timer);
    this.timer = 0;
    this.buffer.flush();
    this.lines = this.buffer.view();
    this.hasEarlier = this.buffer.hasEarlier;
    this.loaded = true;
  }
}
