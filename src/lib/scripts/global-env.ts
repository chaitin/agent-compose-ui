import { GetGlobalEnvRequest, type EnvVarSpec } from '../../gen/agentcompose/v2/agentcompose_pb';

// In-memory cache of the global-env panel values. The backend redacts secrets
// (********) on read, so this holds no plaintext secrets.
//
// Preview re-runs interpolation on every editor change, so we cache to avoid
// hammering GetGlobalEnv; the cache is invalidated whenever the panel is saved
// (see GlobalEnvPanel.svelte -> invalidateGlobalEnvCache).
let cache: EnvVarSpec[] | undefined;
let inflight: Promise<EnvVarSpec[]> | undefined;

// rpc.ts touches `window` at module top level (createConnectTransport reads
// window.location.origin). Importing it eagerly here would pull that side
// effect into any module that imports global-env (e.g. Toolbar -> global-env),
// breaking non-browser test environments. Load it lazily on first use instead.
async function loadSettingsService() {
  const mod = await import('../rpc');
  return mod.settingsService;
}

/** Returns the global-env panel values, caching the result until invalidated. */
export async function getGlobalEnvForInterpolation(): Promise<EnvVarSpec[]> {
  if (cache) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    const settingsService = await loadSettingsService();
    const response = await settingsService.getGlobalEnv(new GetGlobalEnvRequest());
    cache = response.env ?? [];
    return cache;
  })().finally(() => {
    inflight = undefined;
  });
  return inflight;
}

/** Drop the cache so the next read refetches from the backend. */
export function invalidateGlobalEnvCache(): void {
  cache = undefined;
}
