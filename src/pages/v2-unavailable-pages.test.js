import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const cases = [
  ['../views/runtime/LoaderRunListView.svelte', 'loader-runs'],
  ['../views/runtime/LoaderRunDetailView.svelte', 'loader-runs'],
  ['../views/runtime/SessionDetailView.svelte', 'session-lifecycle'],
];

for (const [path, capability] of cases) {
  test(`${path} uses the shared unavailable experience for ${capability}`, () => {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    expect(source).toContain('V2Unavailable');
    expect(source).toContain(`V2_CAPABILITIES['${capability}']`);
    expect(source).not.toContain('agentcompose/v1');
  });
}

test('Dashboard uses the direct V2 overview service', () => {
  const source = readFileSync(new URL('Dashboard.svelte', import.meta.url), 'utf8');
  expect(source).toContain('dashboardService.getDashboardOverview');
  expect(source).toContain('dashboardService.watchDashboardOverview');
  expect(source).not.toContain('V2Unavailable');
  expect(source).not.toContain('agentcompose/v1');
});

test('SystemSettings uses the direct V2 settings and capability panels', () => {
  const source = readFileSync(new URL('SystemSettings.svelte', import.meta.url), 'utf8');
  expect(source).toContain('showPullAction={false}');
  expect(source).toContain('CapabilityGatewayPanel');
  expect(source).toContain('CapabilityCatalogPanel');
  expect(source).toContain('GlobalEnvPanel');
  expect(source).not.toContain('DaemonStatusPanel');
  expect(source).not.toContain('WorkspacePresetPanel');
  expect(source).not.toContain('V2Unavailable');
  expect(source).not.toContain('agentcompose/v1');
});
