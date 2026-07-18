import type { ScriptTreeNode } from './types';

type ScriptFileNode = Extract<ScriptTreeNode, { kind: 'file' }>;

export function collectScriptFiles(node: ScriptTreeNode | null): ScriptFileNode[] {
  if (!node) return [];
  if (node.kind === 'file') return [node];
  return node.children.flatMap(collectScriptFiles);
}

export function countScriptFiles(node: ScriptTreeNode | null): number {
  return collectScriptFiles(node).length;
}

export function collectScriptDirectories(node: ScriptTreeNode | null): string[] {
  if (!node || node.kind === 'file') return [];
  return node.children.flatMap((child) =>
    child.kind === 'directory'
      ? [child.path, ...collectScriptDirectories(child)]
      : [],
  );
}

export function filterScriptDirectories(node: ScriptTreeNode | null, query: string): {
  tree: ScriptTreeNode | null;
  expandedPaths: Set<string>;
} {
  const normalized = query.trim().toLocaleLowerCase();
  if (!node || !normalized) return { tree: node, expandedPaths: new Set() };

  const expandedPaths = new Set<string>();
  const includeCompleteDirectory = (directory: Extract<ScriptTreeNode, { kind: 'directory' }>) => {
    expandedPaths.add(directory.path);
    for (const child of directory.children) {
      if (child.kind === 'directory') includeCompleteDirectory(child);
    }
  };
  const filterDirectory = (directory: Extract<ScriptTreeNode, { kind: 'directory' }>, root = false): ScriptTreeNode | null => {
    if (!root && directory.name.toLocaleLowerCase().includes(normalized)) {
      includeCompleteDirectory(directory);
      return directory;
    }
    const children = directory.children
      .filter((child): child is Extract<ScriptTreeNode, { kind: 'directory' }> => child.kind === 'directory')
      .map((child) => filterDirectory(child))
      .filter((child): child is ScriptTreeNode => child !== null);
    if (!root && children.length === 0) return null;
    if (!root) expandedPaths.add(directory.path);
    return { ...directory, children };
  };

  return { tree: filterDirectory(node as Extract<ScriptTreeNode, { kind: 'directory' }>, true), expandedPaths };
}
