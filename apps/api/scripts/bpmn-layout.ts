// Generează BPMN 2.0 complet, cu forme și muchii BPMNDI, pe care bpmn-js le poate desena.

export type BpmnNodeType = 'startEvent' | 'endEvent' | 'userTask' | 'parallelGateway' | 'exclusiveGateway';

export interface BpmnNode {
  id: string;
  type: BpmnNodeType;
  name?: string;
  assigneeType?: 'functie' | 'rol' | 'utilizator' | 'manager_departament' | 'initiator';
  assignee?: string;
  action?: 'avizare' | 'aprobare' | 'semnare' | 'informare';
  dueHours?: number;
  completion?: 'all' | 'any' | 'majority';
}

export interface BpmnEdge {
  from: string;
  to: string;
  name?: string;
  /** `camp = valoare`, doar pe ieșirile unei porți exclusive. */
  condition?: string;
  /** Calea implicită a porții exclusive. */
  isDefault?: boolean;
}

export interface BpmnSpec {
  id: string;
  name: string;
  nodes: BpmnNode[];
  edges: BpmnEdge[];
}

const SIZE: Record<BpmnNodeType, { w: number; h: number }> = {
  startEvent: { w: 36, h: 36 },
  endEvent: { w: 36, h: 36 },
  userTask: { w: 140, h: 80 },
  parallelGateway: { w: 50, h: 50 },
  exclusiveGateway: { w: 50, h: 50 },
};
const COLUMN = 200;
const ROW = 130;
const ORIGIN = { x: 120, y: 120 };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const attrs = (values: Record<string, unknown>) =>
  Object.entries(values).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => ` ${k}="${esc(String(v))}"`).join('');

/** Coloana fiecărui nod este cel mai lung drum de la start; nodurile dintr-o coloană se centrează pe verticală. */
function positions(spec: BpmnSpec) {
  const column = new Map<string, number>(spec.nodes.map((n) => [n.id, 0]));
  for (let pass = 0; pass < spec.nodes.length; pass++) {
    for (const e of spec.edges) column.set(e.to, Math.max(column.get(e.to)!, column.get(e.from)! + 1));
  }
  const byColumn = new Map<number, BpmnNode[]>();
  for (const n of spec.nodes) byColumn.set(column.get(n.id)!, [...(byColumn.get(column.get(n.id)!) ?? []), n]);
  const rows = Math.max(...[...byColumn.values()].map((nodes) => nodes.length));
  const centerY = ORIGIN.y + ((rows - 1) * ROW) / 2 + 40;
  const box = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const [col, nodes] of byColumn) {
    nodes.forEach((n, i) => {
      const { w, h } = SIZE[n.type];
      const cx = ORIGIN.x + col * COLUMN + SIZE.userTask.w / 2;
      const cy = centerY + (i - (nodes.length - 1) / 2) * ROW;
      box.set(n.id, { x: cx - w / 2, y: cy - h / 2, w, h });
    });
  }
  return box;
}

export function buildBpmn(spec: BpmnSpec): string {
  const known = new Set(spec.nodes.map((n) => n.id));
  for (const e of spec.edges) {
    if (!known.has(e.from) || !known.has(e.to)) throw new Error(`Legătură către un nod necunoscut: ${e.from} → ${e.to}`);
  }
  const flows = spec.edges.map((e, i) => ({ ...e, id: `Flow_${i + 1}` }));
  const box = positions(spec);

  const elements = spec.nodes.map((n) => {
    const fallback = flows.find((f) => f.from === n.id && f.isDefault);
    const open = `<bpmn:${n.type}${attrs({
      id: n.id,
      name: n.name,
      default: fallback?.id,
      'seadoc:assigneeType': n.assigneeType,
      'seadoc:assignee': n.assignee,
      'seadoc:action': n.action,
      'seadoc:dueHours': n.dueHours,
      'seadoc:completion': n.completion,
    })}>`;
    const links = [
      ...flows.filter((f) => f.to === n.id).map((f) => `<bpmn:incoming>${f.id}</bpmn:incoming>`),
      ...flows.filter((f) => f.from === n.id).map((f) => `<bpmn:outgoing>${f.id}</bpmn:outgoing>`),
    ];
    return [`    ${open}`, ...links.map((l) => `      ${l}`), `    </bpmn:${n.type}>`].join('\n');
  });
  const sequence = flows.map((f) =>
    `    <bpmn:sequenceFlow${attrs({ id: f.id, name: f.name, sourceRef: f.from, targetRef: f.to, 'seadoc:condition': f.condition })} />`);

  const shapes = spec.nodes.map((n) => {
    const b = box.get(n.id)!;
    const marker = n.type === 'exclusiveGateway' ? ' isMarkerVisible="true"' : '';
    const external = n.type !== 'userTask' && n.name;
    const label = external
      ? `\n        <bpmndi:BPMNLabel><dc:Bounds x="${b.x + b.w / 2 - 50}" y="${b.y + b.h + 6}" width="100" height="28" /></bpmndi:BPMNLabel>`
      : '';
    return `      <bpmndi:BPMNShape id="${n.id}_di" bpmnElement="${n.id}"${marker}>\n        <dc:Bounds x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" />${label}\n      </bpmndi:BPMNShape>`;
  });
  const edges = flows.map((f) => {
    const a = box.get(f.from)!;
    const c = box.get(f.to)!;
    const start = { x: a.x + a.w, y: a.y + a.h / 2 };
    const end = { x: c.x, y: c.y + c.h / 2 };
    const middle = start.y === end.y ? [] : [{ x: (start.x + end.x) / 2, y: start.y }, { x: (start.x + end.x) / 2, y: end.y }];
    const points = [start, ...middle, end].map((p) => `        <di:waypoint x="${p.x}" y="${p.y}" />`).join('\n');
    const label = f.name
      ? `\n        <bpmndi:BPMNLabel><dc:Bounds x="${(start.x + end.x) / 2 - 45}" y="${Math.min(start.y, end.y) + (start.y === end.y ? -24 : (Math.abs(start.y - end.y) / 2) - 10)}" width="90" height="28" /></bpmndi:BPMNLabel>`
      : '';
    return `      <bpmndi:BPMNEdge id="${f.id}_di" bpmnElement="${f.id}">\n${points}${label}\n      </bpmndi:BPMNEdge>`;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
  xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
  xmlns:seadoc="http://seadoc.ro/schema/bpmn"
  id="Definitions_${spec.id}" targetNamespace="http://seadoc.ro/schema/bpmn">
  <bpmn:process id="${spec.id}" name="${esc(spec.name)}" isExecutable="true">
${[...elements, ...sequence].join('\n')}
  </bpmn:process>
  <bpmndi:BPMNDiagram id="Diagram_${spec.id}">
    <bpmndi:BPMNPlane id="Plane_${spec.id}" bpmnElement="${spec.id}">
${[...shapes, ...edges].join('\n')}
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>
`;
}
