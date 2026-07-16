export type LegacySessionPolicy = 'reuse_session' | 'new_session';
export type ProjectSandboxPolicy = 'sticky' | 'new';

export function toProjectSandboxPolicy(policy: string): ProjectSandboxPolicy {
  switch (policy.trim().toLowerCase()) {
    case 'sticky':
    case 'reuse':
    case 'reuse_session':
      return 'sticky';
    case 'new':
    case 'new_session':
    default:
      return 'new';
  }
}

export function toLegacySessionPolicy(policy: string): LegacySessionPolicy {
  return toProjectSandboxPolicy(policy) === 'sticky' ? 'reuse_session' : 'new_session';
}
