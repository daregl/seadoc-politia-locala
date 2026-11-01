import type { Department, Folder } from './types';

interface Node { id: number; name: string; parentId: number | null }

/** Parcurge un arbore în ordine, cu adâncimea fiecărui nod; rezistă la cicluri și părinți lipsă. */
export function walkTree<T extends Node>(items: T[]): { item: T; depth: number }[] {
  const byParent = new Map<number | null, T[]>();
  const ids = new Set(items.map((i) => i.id));
  for (const item of items) {
    const parent = item.parentId !== null && ids.has(item.parentId) ? item.parentId : null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), item]);
  }
  const out: { item: T; depth: number }[] = [];
  const seen = new Set<number>();
  const visit = (parent: number | null, depth: number) => {
    const children = (byParent.get(parent) ?? []).slice().sort((a, b) => a.name.localeCompare(b.name, 'ro'));
    for (const child of children) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push({ item: child, depth });
      visit(child.id, depth + 1);
    }
  };
  visit(null, 0);
  return out;
}

export function indentedFolders(folders: Folder[]): { id: number; label: string; departmentId: number | null }[] {
  return walkTree(folders).map(({ item, depth }) => ({
    id: item.id,
    label: `${'  '.repeat(depth)}${item.name}`,
    departmentId: item.departmentId,
  }));
}

export function indentedDepartments(departments: Department[]): { id: number; label: string }[] {
  return walkTree(departments).map(({ item, depth }) => ({
    id: item.id,
    label: `${'  '.repeat(depth)}${item.name}`,
  }));
}
