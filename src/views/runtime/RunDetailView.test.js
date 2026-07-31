import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = [
  './RunDetailView.svelte',
  './RunExecutionProcess.svelte',
  './RunExecutionTimelineEntry.svelte',
].map(path => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n');

test('prefers paginated structured Run events and labels inferred logs as fallback only', () => {
  assert.match(source, /listAllRunEvents/);
  assert.match(source, /runService\.listRunEvents/);
  assert.match(source, /historyAvailable === false/);
  assert.match(source, /结构化历史不可用，以下内容根据文本日志推断/);
});

test('renders one chronological timeline instead of a fixed four-step flow', () => {
  assert.match(source, /buildRuntimeTimeline/);
  assert.match(source, /class="timeline-list"/);
  assert.match(source, /timelineEntries/);
  assert.doesNotMatch(source, /<span class="flow-index">01<\/span>/);
  assert.doesNotMatch(source, /<span class="flow-index">04<\/span>/);
});

test('offers progressive full-log loading and preserves full content actions', () => {
  assert.match(source, /加载更多（显示最近 500 行）/);
  assert.match(source, /加载全部日志/);
  assert.match(source, /可能存在更早日志/);
  assert.match(source, /复制全文/);
  assert.doesNotMatch(source, /-webkit-line-clamp/);
});

test('renders elapsed timing and accessible pressed filter state', () => {
  assert.match(source, /formatElapsed/);
  assert.match(source, /aria-pressed=\{activeTimelineFilter === filter\}/);
});

test('groups backend and synthesized evidence into six overlapping user-facing filters', () => {
  for (const label of ['全部', '消息', '活动', '运行', '产物', '问题']) assert.match(source, new RegExp(`${label}`));
  assert.match(source, /entry\.filterTags/);
  assert.match(source, /entry\.kind === 'warning' \|\| entry\.kind === 'error'/);
  assert.match(source, /entry\.source === '用户消息'/);
  assert.doesNotMatch(source, /toggleKind/);
});

test('preserves run status, timing, exit code, source, and linked sandbox navigation', () => {
  assert.match(source, /statusLabel\(runDetail\.summary\?\.status/);
  assert.match(source, /formatDuration\(runDetail\.summary\.durationMs\)/);
  assert.match(source, /runDetail\.summary\?\.exitCode/);
  assert.match(source, /sourceLabel\(runDetail\.summary\?\.source/);
  assert.match(source, /formatTime\(runDetail\.summary\?\.startedAt/);
  assert.match(source, /formatTime\(runDetail\.summary\?\.completedAt/);
  assert.match(source, /store\.navigateTo\('sandbox-detail'/);
  assert.doesNotMatch(source, /Session|sessionId|navigateTo\('session'/);
});

test('adds conditional identifiers without placeholder values', () => {
  assert.match(source, /runDetail\.summary\?\.schedulerId/);
  assert.match(source, /runDetail\.summary\?\.triggerId/);
  assert.match(source, /runDetail\.summary\?\.sandboxId/);
  assert.match(source, /runDetail\.summary\?\.runId/);
});

test('does not show redundant sandbox association copy', () => {
  assert.doesNotMatch(source, /此环境来自 v2 Run 记录的 Sandbox 关联字段/);
});

test('does not show the runtime monitoring action', () => {
  assert.doesNotMatch(source, /运行时监控 →/);
});

test('uses the existing Agent Compose visual tokens for the redesigned detail', () => {
  assert.match(source, /background:\s*var\(--bg-secondary\)/);
  assert.match(source, /border[^;]*var\(--border-color\)/);
  assert.match(source, /color:\s*var\(--text-secondary\)/);
  assert.match(source, /font-family:\s*var\(--font-mono\)/);
  assert.doesNotMatch(source, /font-family:\s*(?:Georgia|Arial|Inter)/);
});

test('stops pending or running runs through StopRun', () => {
  assert.match(source, /function canStopRun\(/);
  assert.match(source, /RunStatus\.PENDING/);
  assert.match(source, /RunStatus\.RUNNING/);
  assert.match(source, /await runService\.stopRun\(buildStopRunRequest\(runId\)\)/);
  assert.match(source, /停止运行/);
  assert.match(source, /stopping/);
});

test('does not label a pending run as completed', () => {
  assert.match(source, /if \(status === RunStatus\.PENDING\) return '等待执行'/);
  assert.match(source, /\{runTitle\(runDetail\.summary\?\.status \?\? RunStatus\.UNSPECIFIED\)\}/);
});

test('polls active run detail and events until the run reaches a terminal status', () => {
  assert.match(source, /status === RunStatus\.PENDING \|\| status === RunStatus\.RUNNING/);
  assert.match(source, /scheduleRefresh\(generation, projectId, requestedRunId, requestedAgent\)/);
  assert.match(source, /void fetchDetail\(generation, projectId, requestedRunId, requestedAgent\)/);
  assert.match(source, /void fetchEvents\(generation, projectId, requestedRunId, requestedAgent\)/);
});

test('smoothly grows the timeline without animating the whole agent panel', () => {
  assert.match(source, /class="timeline-entry-growth"/);
  assert.match(source, /@keyframes timeline-grow/);
  assert.match(source, /grid-template-rows: 0fr/);
  assert.match(source, /prefers-reduced-motion: reduce/);
  assert.doesNotMatch(source, /class="root"[^>]*in:/);
});

test('shows run evidence directly and does not substitute resource metadata for execution logs', () => {
  assert.match(source, /执行过程/);
  assert.match(source, /buildRuntimeTimeline/);
  assert.doesNotMatch(source, /buildRunRelatedContext/);
  assert.doesNotMatch(source, /确定日志/);
  assert.doesNotMatch(source, /关联日志/);
  assert.doesNotMatch(source, /关联资源上下文/);
  assert.doesNotMatch(source, /scheduler\.started|sandbox\.created/);
  assert.doesNotMatch(source, /agentcompose\/v1|ListLoaderEvents|ListSessionEvents/);
});
