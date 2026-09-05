import type { GraphData, GraphEdge, GraphNode, NoteRef } from '@graphite/bindings';

const EMPTY: GraphData = { nodes: [], edges: [] };

function undirectedAdj(edges: readonly GraphEdge[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const add = (from: string, to: string) => {
    let set = adj.get(from);
    if (set === undefined) {
      set = new Set();
      adj.set(from, set);
    }
    set.add(to);
  };
  for (const edge of edges) {
    if (edge.source === edge.target) {
      continue;
    }
    add(edge.source, edge.target);
    add(edge.target, edge.source);
  }
  return adj;
}

/** Текущая заметка и соседи на расстоянии `hops` (рёбра без направления). */
export function egoSubgraph(data: GraphData, center: NoteRef, hops = 1): GraphData {
  if (hops < 0) {
    return EMPTY;
  }
  const keep = new Set<string>([center]);
  if (hops > 0) {
    const adj = undirectedAdj(data.edges);
    let frontier: string[] = [center];
    for (let step = 0; step < hops; step += 1) {
      const next: string[] = [];
      for (const ref of frontier) {
        const neighbors = adj.get(ref);
        if (neighbors === undefined) {
          continue;
        }
        for (const neighbor of neighbors) {
          if (!keep.has(neighbor)) {
            keep.add(neighbor);
            next.push(neighbor);
          }
        }
      }
      frontier = next;
    }
  }

  const edges: GraphEdge[] = [];
  const degree = new Map<string, number>();
  for (const edge of data.edges) {
    if (!keep.has(edge.source) || !keep.has(edge.target) || edge.source === edge.target) {
      continue;
    }
    edges.push(edge);
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }

  const nodes: GraphNode[] = [];
  for (const node of data.nodes) {
    if (!keep.has(node.ref)) {
      continue;
    }
    nodes.push({ ...node, degree: degree.get(node.ref) ?? 0 });
  }
  return { nodes, edges };
}
