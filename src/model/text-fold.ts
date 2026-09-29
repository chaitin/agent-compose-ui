// 对话里的长文本折叠：几万行的输出不整段进页面，只显示开头和结尾，中间折叠。
// 只按换行位置切分，用 indexOf 定位，不把整段文本拆成行数组。

/** 超过这么多行才折叠。 */
export const FOLD_MIN_LINES = 200;
export const FOLD_HEAD_LINES = 40;
export const FOLD_TAIL_LINES = 40;
/** 正在流式输出时只显示最后这么多行。 */
export const LIVE_TAIL_LINES = 80;

export type TextFold = {
  head: string;
  tail: string;
  /** 被折叠部分在原文中的范围 [hiddenStart, hiddenEnd)。 */
  hiddenStart: number;
  hiddenEnd: number;
  hiddenLines: number;
};

export function lineCount(text: string): number {
  if (!text) return 0;
  let count = 1;
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) count += 1;
  // 以换行结尾时最后一行是空的，不算。
  return text.endsWith('\n') ? count - 1 : count;
}

/** 第 n 行开头的位置（n 从 0 开始）。 */
function startOfLine(text: string, n: number): number {
  let position = 0;
  for (let line = 0; line < n; line += 1) {
    const next = text.indexOf('\n', position);
    if (next < 0) return text.length;
    position = next + 1;
  }
  return position;
}

/** 倒数第 n 行开头的位置（不计末尾换行后的空行）。 */
function startOfLastLines(text: string, n: number): number {
  let end = text.endsWith('\n') ? text.length - 1 : text.length;
  for (let line = 0; line < n; line += 1) {
    const previous = text.lastIndexOf('\n', end - 1);
    if (previous < 0) return 0;
    end = previous;
  }
  return end + 1;
}

/** 超过 FOLD_MIN_LINES 行时返回折叠结果，否则返回 null（整段显示）。 */
export function foldText(
  text: string,
  head = FOLD_HEAD_LINES,
  tail = FOLD_TAIL_LINES,
  minLines = FOLD_MIN_LINES,
): TextFold | null {
  const total = lineCount(text);
  if (total <= minLines) return null;
  const hiddenStart = startOfLine(text, head);
  const hiddenEnd = startOfLastLines(text, tail);
  return {
    head: text.slice(0, hiddenStart),
    tail: text.slice(hiddenEnd),
    hiddenStart,
    hiddenEnd,
    hiddenLines: total - head - tail,
  };
}

/** 流式输出只保留最后 keep 行；不够长时返回 null。 */
export function liveTail(text: string, keep = LIVE_TAIL_LINES): TextFold | null {
  const total = lineCount(text);
  if (total <= keep) return null;
  const hiddenEnd = startOfLastLines(text, keep);
  return { head: '', tail: text.slice(hiddenEnd), hiddenStart: 0, hiddenEnd, hiddenLines: total - keep };
}
