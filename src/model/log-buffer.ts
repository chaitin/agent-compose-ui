// 日志缓冲：所有显示运行日志的地方共用。
//
// 流式日志一块块到达（每块可能 64KB），如果每块都拼进响应式字符串再整体切行、整体重绘，
// 日志一长页面就会卡死。这里的做法：
// - 数据块先进非响应式的待处理缓冲，由调用方按固定间隔 flush；
// - flush 只切新到的文本，已切好的行原地追加，不整份复制；
// - 内存里最多保留 maxLines 行，超出后丢掉最旧的，并记住保留部分从第几个字节开始，
//   这样「加载更早」可以按字节偏移往前一段段地读，而不是从头读完整个前缀。

/** 打开日志时先取末尾多少行。 */
export const LOG_TAIL_LINES = 2000;
/** 跟随运行时内存里最多保留多少行。 */
export const LOG_MAX_LINES = 5000;
/** 每次「加载更早」往前读多少字节，按每行约 128 字节约等于 2000 行。 */
export const LOG_EARLIER_BYTES = 256 * 1024;
/** 待处理文本合并进行数组的间隔。 */
export const LOG_FLUSH_MS = 150;

const encoder = new TextEncoder();

export function byteLength(value: string): number {
  return encoder.encode(value).length;
}

export type LogChunk = { data: string; offset: bigint };

export class LogBuffer {
  /** 已切好的完整行。只由本类修改；对外用 view() 取快照。 */
  private lines: string[] = [];
  /** 最后一段还没遇到换行的文本。 */
  private incomplete = '';
  private pending = '';
  private maxLines: number;
  /** lines[0] 在完整日志里的字节偏移；0n 表示从日志开头就在内存里。 */
  start = 0n;
  /** 是否已经从第一块数据推算出 start。 */
  startKnown = false;

  constructor(maxLines = LOG_MAX_LINES) {
    this.maxLines = maxLines;
  }

  /** 记下一个流式数据块，不触发切行。chunk.offset 是这块结束后的字节偏移。 */
  push(chunk: LogChunk): void {
    if (!chunk.data) return;
    if (!this.startKnown) {
      // 第一块带日志内容的数据决定已加载部分的起点（末尾 N 行模式下它不是 0）。
      const start = chunk.offset - BigInt(byteLength(chunk.data));
      this.start = start < 0n ? 0n : start;
      this.startKnown = true;
    }
    this.pending += chunk.data;
  }

  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  /** 把待处理文本切成行并入缓冲。有变化时返回 true。 */
  flush(): boolean {
    if (!this.pending) return false;
    const parts = `${this.incomplete}${this.pending}`.split('\n');
    this.pending = '';
    this.incomplete = parts.pop() ?? '';
    for (const line of parts) this.lines.push(line);
    this.trim();
    return true;
  }

  /** 已加载部分之前是否还有内容。 */
  get hasEarlier(): boolean {
    return this.startKnown && this.start > 0n;
  }

  /** 在前面补上更早的一段。用户主动要看的内容，不会在之后的跟随中被裁掉。 */
  prepend(lines: string[], start: bigint): void {
    if (!lines.length && start === this.start) return;
    this.lines = [...lines, ...this.lines];
    this.start = start;
    this.maxLines = Math.max(this.maxLines, this.lines.length + LOG_TAIL_LINES);
  }

  /** 当前可显示的行（含最后一段不完整的行）。返回新数组，可以直接交给响应式状态。 */
  view(): string[] {
    return this.incomplete ? [...this.lines, this.incomplete] : [...this.lines];
  }

  get lineCount(): number {
    return this.lines.length + (this.incomplete ? 1 : 0);
  }

  private trim(): void {
    const excess = this.lines.length - this.maxLines;
    if (excess <= 0) return;
    const dropped = this.lines.splice(0, excess);
    let bytes = 0;
    for (const line of dropped) bytes += byteLength(line) + 1;
    this.start += BigInt(bytes);
  }
}

/**
 * 把从 from 开始读到的一段文本切成完整行。
 * from 不是日志开头时，第一行多半是被截断的半行，丢掉它，并把起点移到下一行开头。
 */
export function earlierLines(text: string, from: bigint): { lines: string[]; start: bigint } {
  const parts = text.split('\n');
  // 文本以换行结尾时，split 会在末尾多出一个空串。
  if (parts.at(-1) === '') parts.pop();
  if (from === 0n || parts.length <= 1) return { lines: parts, start: from };
  const partial = parts.shift() ?? '';
  return { lines: parts, start: from + BigInt(byteLength(partial) + 1) };
}

/** 数据块里落在 [from, until) 之间的部分。chunk.offset 是这块结束后的字节偏移。 */
export function textBetween(chunk: LogChunk, from: bigint, until: bigint): string {
  if (!chunk.data || chunk.offset <= from) return '';
  const bytes = encoder.encode(chunk.data);
  const chunkStart = chunk.offset - BigInt(bytes.length);
  if (chunkStart >= until) return '';
  if (chunkStart >= from && chunk.offset <= until) return chunk.data;
  const head = chunkStart < from ? Number(from - chunkStart) : 0;
  const tail = chunk.offset > until ? Number(until - chunkStart) : bytes.length;
  return new TextDecoder().decode(bytes.slice(head, tail));
}
