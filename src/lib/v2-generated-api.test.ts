import { describe, expect, it } from 'vitest';
import { DashboardService, RunService, SandboxService, SettingsService, CapabilityService } from '../gen/agentcompose/v2/agentcompose_connect';

describe('generated V2 API surface', () => {
  it('contains the direct APIs used by the frontend', () => {
    expect(Object.keys(SandboxService.methods)).toEqual(expect.arrayContaining([
      'getSandbox', 'listSandboxes', 'stopSandbox', 'resumeSandbox',
      'listSandboxHistory', 'watchSandbox',
    ]));
    expect(Object.keys(RunService.methods)).toEqual(expect.arrayContaining(['listRunEvents', 'listSandboxRunEvents']));
    expect(Object.keys(DashboardService.methods)).toContain('watchDashboardOverview');
    expect(Object.keys(SettingsService.methods)).toEqual(expect.arrayContaining(['getGlobalEnv', 'updateGlobalEnv', 'listWorkspacePresets']));
    expect(Object.keys(CapabilityService.methods)).toEqual(expect.arrayContaining(['getCapabilityStatus', 'listCapabilitySets', 'getCapabilityCatalog']));
  });
});
