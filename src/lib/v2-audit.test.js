import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const report = readFileSync(new URL('../../test/fixtures/v2-capability-matrix.md', import.meta.url), 'utf8');
const expectedHeader = '| 能力域 | 用户任务 | CLI 用户价值 | v2 契约 | 当前 Web | 是否迫使使用 CLI | 决策 | 优先级 | 验收标准 | 证据 |';
const rows = report.split('\n')
  .filter(line => line.startsWith('| ') && line !== expectedHeader && !line.startsWith('|---'))
  .map(line => line.split('|').slice(1, -1).map(cell => cell.trim()));

describe('v2 capability audit', () => {
  test('covers every v2 service and every decision class', () => {
    for (const service of ['Project', 'Run', 'Exec', 'Image', 'Cache', 'Volume', 'Sandbox']) {
      expect(report).toContain(`| ${service} |`);
    }
    for (const decision of ['保留', '补齐', '合并', '重构', '移除', '禁用', '后端阻塞', 'CLI 专属']) {
      expect(rows.some(row => row[6] === decision)).toBe(true);
    }
  });

  test('records v1-only product areas explicitly', () => {
    for (const area of ['Dashboard', 'Session', 'Scheduler', 'Loader Run', '全局环境变量', '能力目录']) {
      expect(report).toContain(area);
    }
  });

  test('keeps the matrix structurally reviewable', () => {
    expect(report).toContain(expectedHeader);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toHaveLength(10);
      expect(row.every(cell => cell.length > 0)).toBe(true);
    }
    expect(report).not.toContain('视情况而定');
  });

  test('requires the exact v2 unavailable message for disabled capabilities', () => {
    const unavailableAreas = ['Session', 'Loader Run'];
    const unavailableRows = rows.filter(row => unavailableAreas.includes(row[0]) || ['禁用', '后端阻塞'].includes(row[6]));
    expect(unavailableRows.length).toBeGreaterThan(0);
    for (const row of unavailableRows) {
      expect(row[8]).toContain('当前 v2 API 未提供此能力');
    }
  });
});
