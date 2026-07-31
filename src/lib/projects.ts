import type { ProjectEntry } from './types';

export function canonicalProjectId(projectId: string): string {
  return projectId.startsWith('sha256:')
    ? projectId.slice('sha256:'.length)
    : projectId;
}

export function isSameProjectId(left: string, right: string): boolean {
  return !!left && !!right && canonicalProjectId(left) === canonicalProjectId(right);
}

export function deduplicateProjectEntries(projects: ProjectEntry[]): ProjectEntry[] {
  const byCanonicalId = new Map<string, ProjectEntry>();

  for (const project of projects) {
    const key = canonicalProjectId(project.summary.projectId);
    const existing = byCanonicalId.get(key);
    const existingIsLegacy = existing?.summary.projectId.startsWith('sha256:') ?? false;
    const incomingIsLegacy = project.summary.projectId.startsWith('sha256:');
    if (!existing || (existingIsLegacy && !incomingIsLegacy) || existingIsLegacy === incomingIsLegacy) {
      byCanonicalId.set(key, project);
    }
  }

  return Array.from(byCanonicalId.values());
}
