import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { assertLedgerOwns, buildFixture, createLedger } from './fixtures';
import { findTrackedSandbox, imageHasReference, imagePlatform, schedulerEventsRequest } from './api';
import { Sandbox } from '../../src/gen/agentcompose/v2/agentcompose_pb';

describe('real-data fixture safety', () => {
  test('builds deterministic exact markers and commands from a batch ID', () => {
    const fixture = buildFixture('e2e-20260715-fixed');

    expect(fixture.stdoutMarker).toBe('e2e-20260715-fixed-stdout');
    expect(fixture.stderrMarker).toBe('e2e-20260715-fixed-stderr');
    expect(fixture.llmMarker).toBe('e2e-20260715-fixed-llm-ok');
    expect(fixture.successCommand).toContain(fixture.stdoutMarker);
    expect(fixture.failedCommand).toContain('exit 17');
    expect(fixture.scriptContent).toContain('e2e-20260715-fixed-script-ok');
    expect(fixture.agentImage).toBe('ghcr.io/chaitin/agent-compose-guest:latest');
    expect(fixture.agentImage).not.toBe(fixture.image);
  });

  test('ledger accepts only current-batch resources', () => {
    const ledger = createLedger('e2e-fixed');
    ledger.projects.add('e2e-fixed-project');

    expect(assertLedgerOwns(ledger, 'projects', 'e2e-fixed-project')).toBe('e2e-fixed-project');
    expect(() => assertLedgerOwns(ledger, 'projects', 'production')).toThrow('not owned');
  });

  test('uses a unique safe batch format', () => {
    const fixture = buildFixture();
    expect(fixture.batchId).toMatch(/^e2e-\d{8}t\d{6}z-[a-f0-9]{6}$/);
    expect(fixture.projectName).toMatch(/^[a-z][a-z0-9_-]*$/);
  });

  test('reads image references and platform from the generated v2 shape', () => {
    const image = { repoTags: ['busybox:1.36.1'], platform: { os: 'linux', architecture: 'amd64' } };
    expect(imageHasReference(image, 'busybox:1.36.1')).toBe(true);
    expect(imagePlatform(image)).toBe('linux/amd64');
  });

  test('walks sandbox cursors until a tracked sandbox is found', async () => {
    const cursors: string[] = [];
    const found = await findTrackedSandbox(async request => {
      cursors.push(request.cursor);
      return request.cursor
        ? { sandboxes: [new Sandbox({ sandboxId: 'tracked' })], nextCursor: 'unused' }
        : { sandboxes: [new Sandbox({ sandboxId: 'other' })], nextCursor: 'next' };
    }, new Set(['tracked']));

    expect(found?.sandboxId).toBe('tracked');
    expect(cursors).toEqual(['', 'next']);
  });

  test('probes the complete direct v2 read-only surface', () => {
    const source = readFileSync(new URL('./api.ts', import.meta.url), 'utf8');
    for (const call of [
      'clients.sandbox.listSandboxes',
      'clients.sandbox.getSandbox',
      'clients.sandbox.listSandboxHistory',
      'clients.run.listSandboxRunEvents',
      'clients.dashboard.getDashboardOverview',
      'clients.project.listSchedulerEvents',
      'clients.settings.getGlobalEnv',
      'clients.capability.getCapabilityStatus',
    ]) {
      expect(source).toContain(call);
    }
    const schedulerRequest = schedulerEventsRequest('project-1', 'agent-1');
    expect(schedulerRequest.project?.projectId).toBe('project-1');
    expect(schedulerRequest.agentName).toBe('agent-1');
    expect(schedulerRequest.limit).toBe(100);
  });
});
