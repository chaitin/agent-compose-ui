import { CellType, type WorkSessionCell } from '../api/sessions';

export type SessionOutputSearchMatch = {
  cellId: string;
  section: 'source' | 'output';
  lineIndex: number;
  startOffset: number;
  endOffset: number;
};

export function sessionCellOutput(cell: WorkSessionCell): string {
  if (cell.running && !cell.output && !cell.stopReason) return '等待回复...';
  const output = cell.output || cell.stopReason || '-';
  const resultIndex = output.lastIndexOf('__AGENT_RESULT__');
  return resultIndex >= 0 ? output.slice(0, resultIndex) : output;
}

export function sessionCellStatus(cell: WorkSessionCell): string {
  if (cell.id.startsWith('pending-user-')) return '已发送';
  if (cell.running) return '运行中';
  return cell.success ? '完成' : `失败${cell.exitCode ? ` · ${cell.exitCode}` : ''}`;
}

export function sessionCellStatusTone(cell: WorkSessionCell): 'running' | 'succeeded' | 'failed' {
  if (cell.running) return 'running';
  return cell.success ? 'succeeded' : 'failed';
}

export function isAgentSessionCell(cell: WorkSessionCell): boolean {
  return Boolean(cell.agent) || cell.type === CellType.AGENT || cell.id.startsWith('pending-agent-');
}

export function sessionMessageSource(cell: WorkSessionCell): string {
  if (cell.id.startsWith('pending-user-')) return cell.output;
  return cell.agent && cell.source ? cell.source : '';
}

export function sessionMessageOutput(cell: WorkSessionCell): string {
  return cell.id.startsWith('pending-user-') ? '' : sessionCellOutput(cell);
}

export function visibleSessionCells(cells: WorkSessionCell[]): WorkSessionCell[] {
  return cells.filter((cell) => Boolean(sessionMessageSource(cell) || sessionMessageOutput(cell)));
}

export function findSessionOutputMatches(cells: WorkSessionCell[], query: string): SessionOutputSearchMatch[] {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];
  const pattern = new RegExp(normalizedQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu');
  const matches: SessionOutputSearchMatch[] = [];
  for (const cell of visibleSessionCells(cells)) {
    const sections: Array<{ section: SessionOutputSearchMatch['section']; value: string }> = [
      { section: 'source', value: sessionMessageSource(cell) },
      { section: 'output', value: sessionMessageOutput(cell) },
    ];
    for (const { section, value } of sections) {
      if (!value) continue;
      let lineStartOffset = 0;
      value.split(/\r?\n/).forEach((line, lineIndex) => {
        const lineMatch = pattern.exec(line);
        if (lineMatch) {
          const startOffset = lineStartOffset + lineMatch.index;
          matches.push({ cellId: cell.id, section, lineIndex, startOffset, endOffset: startOffset + lineMatch[0].length });
        }
        lineStartOffset += line.length;
        if (value.startsWith('\r\n', lineStartOffset)) lineStartOffset += 2;
        else if (value[lineStartOffset] === '\n') lineStartOffset += 1;
      });
    }
  }
  return matches;
}

export function sessionOutputMatchParts(value: string, match: SessionOutputSearchMatch): Array<{ text: string; matched: boolean }> {
  if (match.startOffset < 0 || match.endOffset > value.length) return [{ text: value, matched: false }];
  return [
    { text: value.slice(0, match.startOffset), matched: false },
    { text: value.slice(match.startOffset, match.endOffset), matched: true },
    { text: value.slice(match.endOffset), matched: false },
  ].filter((part) => part.text.length > 0);
}

export function sessionOutputText(cells: WorkSessionCell[]): string {
  const blocks: string[] = [];
  for (const cell of visibleSessionCells(cells)) {
    const source = sessionMessageSource(cell);
    const output = sessionMessageOutput(cell);
    if (source) blocks.push(`用户:\n${source}`);
    if (output) blocks.push(`${cell.agent || '助手'}:\n${output}`);
  }
  return blocks.join('\n\n');
}
