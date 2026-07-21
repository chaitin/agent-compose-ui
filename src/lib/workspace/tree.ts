import type { WorkspaceFileEntry } from './types';

export interface WorkspaceTreeNode {
  path: string;
  name: string;
  dir: boolean;
  size: number;
  updatedAt: string;
  children: WorkspaceTreeNode[];
}

export function entryName(entry: WorkspaceFileEntry): string {
  const trimmed = entry.path.replace(/\/$/, '');
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

export function buildWorkspaceTree(files: WorkspaceFileEntry[]): WorkspaceTreeNode {
  const root: WorkspaceTreeNode = {
    path: '',
    name: '',
    dir: true,
    size: 0,
    updatedAt: '',
    children: [],
  };

  const dirIndex = new Map<string, WorkspaceTreeNode>();
  dirIndex.set('', root);

  const ensureDir = (path: string): WorkspaceTreeNode => {
    const cached = dirIndex.get(path);
    if (cached) return cached;
    const name = path.split('/').pop() ?? path;
    const node: WorkspaceTreeNode = {
      path,
      name,
      dir: true,
      size: 0,
      updatedAt: '',
      children: [],
    };
    dirIndex.set(path, node);
    const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const parent = ensureDir(parentPath);
    parent.children.push(node);
    return node;
  };

  for (const entry of files) {
    if (entry.dir) {
      const dir = ensureDir(entry.path);
      dir.size = entry.size;
      dir.updatedAt = entry.updated_at;
    } else {
      const parentPath = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '';
      const parent = ensureDir(parentPath);
      parent.children.push({
        path: entry.path,
        name: entryName(entry),
        dir: false,
        size: entry.size,
        updatedAt: entry.updated_at,
        children: [],
      });
    }
  }

  sortTree(root);
  return root;
}

function sortTree(node: WorkspaceTreeNode): void {
  node.children.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
  for (const child of node.children) sortTree(child);
}

export function countWorkspaceFiles(node: WorkspaceTreeNode | null): number {
  if (!node) return 0;
  let count = 0;
  for (const child of node.children) {
    if (child.dir) count += countWorkspaceFiles(child);
    else count += 1;
  }
  return count;
}

export interface FlatTreeRow {
  node: WorkspaceTreeNode;
  depth: number;
}

export function flattenTree(
  root: WorkspaceTreeNode | null,
  expanded: ReadonlySet<string>,
): FlatTreeRow[] {
  const rows: FlatTreeRow[] = [];
  if (!root) return rows;
  const walk = (node: WorkspaceTreeNode, depth: number) => {
    for (const child of node.children) {
      rows.push({ node: child, depth });
      if (child.dir && expanded.has(child.path)) walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return rows;
}

export function formatFileSize(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} ${units[unit]}` : `${value.toFixed(1)} ${units[unit]}`;
}
