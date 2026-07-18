import type { EnvVarSpec } from '../../gen/agentcompose/v2/agentcompose_pb';
import { dumpYamlObject, parseYamlObject } from '../yaml';

// Mirrors the backend `envReferencePattern` in pkg/compose/normalize.go so the
// references we interpolate are exactly the ones `compose.Normalize` would
// otherwise expand from the daemon process env (`.env`). Keeping the pattern in
// sync is what lets the web console override the daemon's `.env`-based
// expansion with the global-env panel values at apply time.
const ENV_REFERENCE_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

// GetGlobalEnv redacts secrets to this sentinel (see
// pkg/agentcompose/api/settings_v2.go `secretRedactedValue`). Expanding a
// secret reference to it would corrupt the value, so secret references are
// left intact for the backend to resolve.
const SECRET_REDACTED = '********';

export type InterpolatableEnvVar = Pick<EnvVarSpec, 'name' | 'value' | 'secret'>;

function interpolateString(value: string, lookup: ReadonlyMap<string, string>, state: { matched: boolean }): string {
  return value.replace(ENV_REFERENCE_PATTERN, (match, name: string) => {
    const replacement = lookup.get(name.toUpperCase());
    if (replacement !== undefined) state.matched = true;
    return replacement === undefined ? match : replacement;
  });
}

function interpolateValues(value: unknown, lookup: ReadonlyMap<string, string>, state: { matched: boolean }): unknown {
  if (typeof value === 'string') return interpolateString(value, lookup, state);
  if (Array.isArray(value)) return value.map(item => interpolateValues(item, lookup, state));
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      (value as Record<string, unknown>)[key] = interpolateValues(item, lookup, state);
    }
  }
  return value;
}

/**
 * Expand `${VAR}` references in YAML text using global-env panel values.
 *
 * Only non-secret variables are expanded. Secrets are redacted by the backend
 * (`********`), so they cannot be expanded client-side; their references are
 * left intact; the runtime LLM facade overrides API-key env with a facade
 * token (see pkg/llms/runtimefacade/config.go `ensureSessionClaudeConfig`),
 * so a leftover `${LLM_API_KEY}` is resolved by the backend and harmless.
 *
 * Unknown references (no matching panel variable) are also left intact so the
 * backend can resolve them from the daemon process env, preserving the
 * existing behavior for variables not managed by the panel.
 *
 * Name matching is case-insensitive to mirror the backend
 * `LookupGlobalEnv` (strings.EqualFold).
 */
export function interpolateGlobalEnv(yamlText: string, env: ReadonlyArray<InterpolatableEnvVar> | undefined | null): string {
  if (!env || env.length === 0) return yamlText;
  const lookup = new Map<string, string>();
  for (const item of env) {
    const name = (item.name ?? '').trim();
    if (!name || item.secret) continue;
    const value = item.value ?? '';
    if (value === '' || value === SECRET_REDACTED) continue;
    lookup.set(name.toUpperCase(), value);
  }
  if (lookup.size === 0) return yamlText;
  const yamlObject = parseYamlObject(yamlText);
  const state = { matched: false };
  interpolateValues(yamlObject, lookup, state);
  if (!state.matched) return yamlText;
  const interpolated = dumpYamlObject(yamlObject);
  return yamlText.endsWith('\n') ? interpolated : interpolated.replace(/\n$/, '');
}
