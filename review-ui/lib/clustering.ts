/**
 * Connected components via union-find, computed client-side over the
 * chunk-similarity edges already fetched for the graph. This is a
 * deliberately simple stand-in for real topic clustering: it doesn't know
 * anything about content, it just groups chunks that are transitively
 * linked at the current similarity threshold. Two chunks in the same
 * component means "there's a chain of similar-enough chunks connecting
 * them," not necessarily that a human would call them the same topic — but
 * it's an honest, cheap way to visually surface cross-document groupings
 * without adding a real ML clustering dependency.
 */
export function connectedComponents(
  nodeIds: string[],
  links: { source: string; target: string }[]
): Map<string, number> {
  const parent = new Map<string, string>();

  function find(x: string): string {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) {
      root = parent.get(root) as string;
    }
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur) as string;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  function union(a: string, b: string) {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  }

  nodeIds.forEach((id) => find(id)); // every node is at least its own singleton component
  links.forEach((link) => union(link.source, link.target));

  const rootToIndex = new Map<string, number>();
  const result = new Map<string, number>();
  nodeIds.forEach((id) => {
    const root = find(id);
    if (!rootToIndex.has(root)) rootToIndex.set(root, rootToIndex.size);
    result.set(id, rootToIndex.get(root) as number);
  });
  return result;
}
