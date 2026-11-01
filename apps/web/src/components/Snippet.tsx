import type { ReactNode } from 'react';

/**
 * Fragmentul vine ca text de document cu marcaje <mark>. Se împarte pe marcaje și se redă
 * prin noduri React: orice altceva rămâne text escapat, inclusiv un eventual cod HTML din document.
 */
export function snippetNodes(snippet: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let inMark = false;
  snippet.split(/(<\/?mark>)/i).forEach((part, index) => {
    const lower = part.toLowerCase();
    if (lower === '<mark>') { inMark = true; return; }
    if (lower === '</mark>') { inMark = false; return; }
    if (!part) return;
    nodes.push(inMark ? <mark key={index}>{part}</mark> : part);
  });
  return nodes;
}

export function Snippet({ text }: { text: string | null | undefined }) {
  if (!text) return null;
  return <p className="snippet">{snippetNodes(text)}</p>;
}
