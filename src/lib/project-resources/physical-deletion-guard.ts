type Deletion = { projectKey: string; volume: string };

const active = new Map<symbol, Deletion>();

export function beginManagedVolumeDeletion(projectKey: string, volume: string): () => void {
  const token = Symbol('managed-volume-deletion');
  active.set(token, { projectKey, volume });
  let released = false;
  return () => { if (!released) { released = true; active.delete(token); } };
}

export const managedVolumeDeletionGuard = {
  assertApplyAllowed(): void {
    if (active.size > 0) throw new Error('托管卷数据正在删除，请等待删除完成后再应用项目');
  },
  clearForTests(): void { active.clear(); },
};
