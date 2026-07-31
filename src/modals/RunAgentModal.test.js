import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('./RunAgentModal.svelte', import.meta.url),
  'utf8',
);

test('submits one detached run and reports its returned run ID', () => {
  assert.match(source, /onstarted\?: \(runId: string\) => void;/);
  assert.match(
    source,
    /runService\.startRun\(new StartRunRequest\(\{ run: req \}\)\)[\s\S]*const runId = response\.run\?\.runId \|\| '';[\s\S]*onstarted\(runId\);/,
  );
  assert.match(source, /store\.navigateTo\('run-detail', \{ agentName, runId \}\)/);
});

test('offers prompt and command inputs with explicit run overrides', () => {
  assert.match(source, /Prompt（对话）/);
  assert.match(source, /命令（Command）/);
  assert.match(source, /aria-label="驱动"/);
  assert.match(source, /aria-label="Sandbox ID"/);
  assert.match(source, /aria-label="清理策略"/);
  assert.match(source, /aria-label="启用 Jupyter"/);
  assert.match(source, /aria-label="暴露 Jupyter 端口"/);
});

test('keeps observation and stop controls on the run detail surface', () => {
  assert.doesNotMatch(source, /runAgentStream|runAttach|stopRun/);
  assert.doesNotMatch(source, /观察方式|停止中|取消交互 Run/);
});

test('uses one submit-then-observe mode', () => {
  assert.match(source, /runService\.startRun/);
  assert.match(source, /store\.navigateTo\('run-detail'/);
  assert.doesNotMatch(source, /runAgentStream|submitMode/);
});

test('loads sandbox choices from the authoritative sandbox service', () => {
  assert.match(source, /listAllSandboxes\(\(request, options\) => sandboxService\.listSandboxes\(request, options\)\)/);
  assert.match(source, /filterSandboxes\(records, \{ projectId, agentName: name \}\)/);
  assert.match(source, /if \(cancelled\) return;/);
  assert.match(source, /return \(\) => \{ cancelled = true; \};/);
});

test('does not derive sandbox choices from run history', () => {
  assert.doesNotMatch(source, /listRuns|ListRunsRequest/);
  assert.doesNotMatch(source, /Run 记录|最多查询 1000 条/);
});
