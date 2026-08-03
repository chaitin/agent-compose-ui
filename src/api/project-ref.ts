export function projectById(projectId: string): {
  selector: { case: 'projectId'; value: string };
} {
  return { selector: { case: 'projectId', value: projectId } };
}

export function nextPageOffset(offset: number, count: number, total: number): number | undefined {
  const next = offset + count;
  return next < total ? next : undefined;
}
