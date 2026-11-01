import { HttpException, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { AuditService } from './audit.js';
import { config } from './config.js';
import { Db, Queryable } from './db.js';
import { DocumentsService } from './documents.js';
import { badRequest, conflict, forbidden, notFound, optText, toInt } from './http.js';
import { NotificationService } from './notifications.js';
import { can, CurrentUser, PERMISSIONS } from './perms.js';

// ---------------------------------------------------------------------------
// BPMN: citire și validare
// ---------------------------------------------------------------------------

export type ElementType = 'startEvent' | 'endEvent' | 'userTask' | 'parallelGateway' | 'exclusiveGateway';

export interface BpmnFlow {
  id: string;
  sourceId: string;
  targetId: string;
  condition: string | null;
}

export interface BpmnElement {
  id: string;
  type: ElementType;
  name: string | null;
  incoming: BpmnFlow[];
  outgoing: BpmnFlow[];
  assigneeType: string | null;
  assignee: string | null;
  action: string | null;
  completion: string | null;
  dueHours: string | null;
  defaultFlowId: string | null;
}

export interface BpmnProcess {
  elements: Map<string, BpmnElement>;
  flows: Map<string, BpmnFlow>;
}

const ELEMENT_TYPES: ElementType[] = ['startEvent', 'endEvent', 'userTask', 'parallelGateway', 'exclusiveGateway'];
const IGNORED_CHILDREN = new Set(['documentation', 'extensionElements']);
const ELEMENT_CHILDREN = new Set(['incoming', 'outgoing', ...IGNORED_CHILDREN]);
const ASSIGNEE_TYPES = ['functie', 'rol', 'utilizator', 'manager_departament', 'initiator'];
const NAMED_ASSIGNEE_TYPES = ['functie', 'rol', 'utilizator'];
const TASK_ACTIONS = ['avizare', 'aprobare', 'semnare', 'informare'];
const COMPLETIONS = ['all', 'any', 'majority'];
const MAX_DUE_HOURS = 87_600; // 10 ani; peste această valoare este sigur o greșeală
const MAX_HOPS = 1000;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  // Tot ce nu este atribut devine listă, indiferent câte apariții are în XML.
  isArray: (_name, _path, _leaf, isAttribute) => !isAttribute,
});

const childNames = (node: any) => (typeof node === 'object' && node ? Object.keys(node).filter((k) => !k.startsWith('@_') && k !== '#text') : []);
const attr = (node: any, name: string): string | null => optText(node?.[`@_${name}`]);
const label = (el: { id: string; name?: string | null }) => (el.name ? `„${el.name}” (${el.id})` : el.id);
const splitValues = (raw: string | null) => (raw ?? '').split(',').map((v) => v.trim()).filter(Boolean);

/** Citește XML-ul; erorile de structură a fișierului și elementele neacceptate se întorc în `errors`. */
export function parseBpmn(xml: unknown): { process: BpmnProcess | null; errors: string[] } {
  const errors: string[] = [];
  const text = typeof xml === 'string' ? xml : '';
  if (!text.trim()) return { process: null, errors: ['XML-ul fluxului lipsește'] };
  // Fără DOCTYPE, deci fără entități definite în document.
  if (/<!DOCTYPE/i.test(text)) return { process: null, errors: ['XML-ul nu poate conține DOCTYPE'] };
  const check = XMLValidator.validate(text);
  if (check !== true) return { process: null, errors: [`XML invalid la linia ${check.err.line}`] };

  let root: any;
  try {
    root = parser.parse(text);
  } catch {
    return { process: null, errors: ['XML-ul nu a putut fi citit'] };
  }
  const definitions = root?.definitions?.[0];
  if (!definitions) return { process: null, errors: ['Fișierul nu este un document BPMN (lipsește „definitions”)'] };
  for (const name of childNames(definitions)) {
    if (name !== 'process' && name !== 'BPMNDiagram' && !IGNORED_CHILDREN.has(name)) errors.push(`Elementul „${name}” nu este acceptat`);
  }
  const processes: any[] = definitions.process ?? [];
  if (processes.length !== 1) {
    errors.push(processes.length ? 'Fișierul trebuie să conțină un singur proces' : 'Fișierul nu conține niciun proces');
    if (!processes.length) return { process: null, errors };
  }
  const node = processes[0];
  const process: BpmnProcess = { elements: new Map(), flows: new Map() };
  const seen = new Set<string>();
  const claimId = (id: string | null, what: string): id is string => {
    if (!id) { errors.push(`Un element „${what}” nu are atributul id`); return false; }
    if (seen.has(id)) { errors.push(`Identificatorul „${id}” este folosit de mai multe ori`); return false; }
    seen.add(id);
    return true;
  };

  for (const name of childNames(node)) {
    if (IGNORED_CHILDREN.has(name)) continue;
    if (name === 'sequenceFlow') {
      for (const f of node.sequenceFlow) {
        const id = attr(f, 'id');
        if (!claimId(id, name)) continue;
        for (const child of childNames(f)) {
          if (!IGNORED_CHILDREN.has(child)) errors.push(`Legătura ${id} conține „${child}”, care nu este acceptat (condițiile se scriu în seadoc:condition)`);
        }
        const sourceId = attr(f, 'sourceRef');
        const targetId = attr(f, 'targetRef');
        if (!sourceId || !targetId) { errors.push(`Legătura ${id} nu are sursă sau destinație`); continue; }
        process.flows.set(id, { id, sourceId, targetId, condition: attr(f, 'condition') });
      }
    } else if ((ELEMENT_TYPES as string[]).includes(name)) {
      for (const e of node[name]) {
        const id = attr(e, 'id');
        if (!claimId(id, name)) continue;
        const element: BpmnElement = {
          id, type: name as ElementType, name: attr(e, 'name'), incoming: [], outgoing: [],
          assigneeType: attr(e, 'assigneeType'), assignee: attr(e, 'assignee'), action: attr(e, 'action'),
          completion: attr(e, 'completion'), dueHours: attr(e, 'dueHours'), defaultFlowId: attr(e, 'default'),
        };
        for (const child of childNames(e)) {
          if (!ELEMENT_CHILDREN.has(child)) errors.push(`Elementul ${label(element)} conține „${child}”, care nu este acceptat`);
        }
        process.elements.set(id, element);
      }
    } else {
      const ids = (Array.isArray(node[name]) ? node[name] : []).map((n: any) => attr(n, 'id')).filter(Boolean);
      errors.push(`Elementul „${name}”${ids.length ? ` (${ids.join(', ')})` : ''} nu este acceptat`);
    }
  }

  for (const flow of process.flows.values()) {
    const source = process.elements.get(flow.sourceId);
    const target = process.elements.get(flow.targetId);
    if (!source) errors.push(`Legătura ${flow.id} pornește dintr-un element inexistent: ${flow.sourceId}`);
    if (!target) errors.push(`Legătura ${flow.id} duce la un element inexistent: ${flow.targetId}`);
    if (source && target) {
      source.outgoing.push(flow);
      target.incoming.push(flow);
    }
  }
  return { process, errors };
}

const parseCondition = (raw: string) => {
  const at = raw.indexOf('=');
  if (at < 0) return null;
  const field = raw.slice(0, at).trim();
  const value = raw.slice(at + 1).trim();
  return /^[\p{L}\p{N}_.-]+$/u.test(field) && value ? { field, value } : null;
};

function walk(starts: BpmnElement[], next: (el: BpmnElement) => BpmnElement[]) {
  const seen = new Set(starts.map((s) => s.id));
  const stack = [...starts];
  while (stack.length) {
    for (const n of next(stack.pop()!)) {
      if (!seen.has(n.id)) { seen.add(n.id); stack.push(n); }
    }
  }
  return seen;
}

/** Bucle formate doar din evenimente și porți: nu se pot termina, fiindcă nimic nu oprește execuția. */
function findSilentLoop(process: BpmnProcess): BpmnElement | null {
  const state = new Map<string, 1 | 2>();
  const visit = (el: BpmnElement): BpmnElement | null => {
    if (el.type === 'userTask') return null;
    if (state.get(el.id) === 1) return el;
    if (state.get(el.id) === 2) return null;
    state.set(el.id, 1);
    for (const f of el.outgoing) {
      const hit = visit(process.elements.get(f.targetId)!);
      if (hit) return hit;
    }
    state.set(el.id, 2);
    return null;
  };
  for (const el of process.elements.values()) {
    const hit = visit(el);
    if (hit) return hit;
  }
  return null;
}

/** Regulile care nu cer baza de date. */
export function checkStructure(process: BpmnProcess): string[] {
  const errors: string[] = [];
  const all = [...process.elements.values()];
  const starts = all.filter((e) => e.type === 'startEvent');
  const ends = all.filter((e) => e.type === 'endEvent');
  if (starts.length !== 1) errors.push(`Fluxul trebuie să aibă exact un eveniment de start (are ${starts.length})`);
  for (const s of starts) if (s.incoming.length) errors.push(`Evenimentul de start ${label(s)} nu poate avea legături de intrare`);
  if (!ends.length) errors.push('Fluxul trebuie să aibă cel puțin un eveniment de final');
  for (const e of ends) if (e.outgoing.length) errors.push(`Evenimentul de final ${label(e)} nu poate avea legături de ieșire`);

  for (const el of all) {
    if (el.type === 'userTask') {
      if (!el.assigneeType) errors.push(`Sarcina ${label(el)}: lipsește seadoc:assigneeType`);
      else if (!ASSIGNEE_TYPES.includes(el.assigneeType)) errors.push(`Sarcina ${label(el)}: tip de titular invalid „${el.assigneeType}”`);
      else if (NAMED_ASSIGNEE_TYPES.includes(el.assigneeType) && !splitValues(el.assignee).length) errors.push(`Sarcina ${label(el)}: lipsește seadoc:assignee`);
      if (el.action && !TASK_ACTIONS.includes(el.action)) errors.push(`Sarcina ${label(el)}: acțiune invalidă „${el.action}”`);
      if (el.completion && !COMPLETIONS.includes(el.completion)) errors.push(`Sarcina ${label(el)}: regulă de finalizare invalidă „${el.completion}”`);
      if (el.dueHours != null) {
        const hours = Number(el.dueHours);
        if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_DUE_HOURS) errors.push(`Sarcina ${label(el)}: termen invalid „${el.dueHours}” (ore, număr pozitiv)`);
      }
    }
    if (el.type === 'exclusiveGateway') {
      const conditionless = el.outgoing.filter((f) => !f.condition);
      if (el.defaultFlowId && !el.outgoing.some((f) => f.id === el.defaultFlowId)) errors.push(`Poarta ${label(el)}: calea implicită ${el.defaultFlowId} nu iese din această poartă`);
      if (conditionless.filter((f) => f.id !== el.defaultFlowId).length > (el.defaultFlowId ? 0 : 1)) errors.push(`Poarta ${label(el)} are mai multe căi fără condiție`);
      if (el.outgoing.length && !el.defaultFlowId && !conditionless.length) errors.push(`Poarta ${label(el)} trebuie să aibă o cale implicită (fără condiție sau „default”)`);
      for (const f of el.outgoing) {
        if (f.condition && f.id !== el.defaultFlowId && !parseCondition(f.condition)) errors.push(`Legătura ${f.id}: condiție invalidă „${f.condition}” (forma este „camp = valoare”)`);
      }
    }
  }
  for (const flow of process.flows.values()) {
    if (flow.condition && process.elements.get(flow.sourceId)?.type !== 'exclusiveGateway') errors.push(`Legătura ${flow.id}: condițiile sunt permise doar la ieșirea dintr-o poartă exclusivă`);
  }

  const byId = (f: BpmnFlow, key: 'sourceId' | 'targetId') => process.elements.get(f[key])!;
  const reachable = walk(starts, (el) => el.outgoing.map((f) => byId(f, 'targetId')));
  const canEnd = walk(ends, (el) => el.incoming.map((f) => byId(f, 'sourceId')));
  if (starts.length) {
    for (const el of all) if (!reachable.has(el.id)) errors.push(`Elementul ${label(el)} nu poate fi atins din evenimentul de start`);
  }
  if (ends.length) {
    for (const el of all) if (!canEnd.has(el.id)) errors.push(`Din elementul ${label(el)} nu se poate ajunge la un eveniment de final`);
  }
  const loop = findSilentLoop(process);
  if (loop) errors.push(`Elementul ${label(loop)} face parte dintr-o buclă fără nicio sarcină`);
  return errors;
}

/** Cine poate rezolva o sarcină: are dreptul `approve` din rol sau din ajustările individuale. */
export function canApproveSql(alias: string): string {
  const roles = (PERMISSIONS.approve as readonly string[]).map((r) => `'${r}'`).join(',');
  return `COALESCE((SELECT p.allowed FROM user_permissions p WHERE p.user_id = ${alias}.id AND p.permission = 'approve'), ${alias}.role IN (${roles}))`;
}

const TODAY_SQL = `(now() AT TIME ZONE 'Europe/Bucharest')::date`;

// ---------------------------------------------------------------------------
// Execuție
// ---------------------------------------------------------------------------

export interface TaskActionInput {
  action?: unknown;
  comment?: unknown;
  password?: unknown;
  targetUserId?: unknown;
}

type Actor = CurrentUser | null;

interface Ctx {
  c: Queryable;
  instance: any;
  doc: any;
  process: BpmnProcess;
  actor: Actor;
}

const DOC_SQL = `SELECT d.id, d.title, d.status, d.department_id, d.metadata, t.name AS type_name, dep.name AS department_name
  FROM documents d JOIN document_types t ON t.id = d.document_type_id JOIN departments dep ON dep.id = d.department_id
  WHERE d.id = $1 FOR UPDATE OF d`;

@Injectable()
export class WorkflowEngine implements OnApplicationShutdown {
  private readonly logger = new Logger('Fluxuri');
  private timer: NodeJS.Timeout | null = null;
  private checking = false;

  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly notify: NotificationService,
    private readonly docs: DocumentsService,
  ) {}

  // Validare la publicare ----------------------------------------------------

  async validate(xml: unknown, client: Queryable = this.db): Promise<string[]> {
    const { process, errors } = parseBpmn(xml);
    if (!process) return errors;
    errors.push(...checkStructure(process));
    errors.push(...(await this.checkNamedAssignees(process, client)));
    return errors;
  }

  private async checkNamedAssignees(process: BpmnProcess, client: Queryable): Promise<string[]> {
    const wanted = new Map<string, Map<string, string>>(NAMED_ASSIGNEE_TYPES.map((t) => [t, new Map()]));
    for (const el of process.elements.values()) {
      if (el.type !== 'userTask' || !el.assigneeType || !wanted.has(el.assigneeType)) continue;
      for (const v of splitValues(el.assignee)) wanted.get(el.assigneeType)!.set(v.toLowerCase(), v);
    }
    const checks: [string, string, string][] = [
      ['functie', 'lower(u.job_title)', 'Funcții fără niciun utilizator activ cu drept de aprobare'],
      ['rol', 'u.role', 'Roluri fără niciun utilizator activ cu drept de aprobare'],
      ['utilizator', 'lower(u.username)', 'Utilizatori inexistenți, inactivi sau fără drept de aprobare'],
    ];
    const errors: string[] = [];
    for (const [type, column, message] of checks) {
      const values = wanted.get(type)!;
      if (!values.size) continue;
      const found = await client.query(
        `SELECT DISTINCT ${column} AS v FROM users u WHERE u.active AND ${column} = ANY($1::text[]) AND ${canApproveSql('u')}`, [[...values.keys()]]);
      const present = new Set(found.rows.map((r) => r.v));
      const missing = [...values].filter(([k]) => !present.has(k)).map(([, original]) => original);
      if (missing.length) errors.push(`${message}: ${missing.join(', ')}`);
    }
    return errors;
  }

  // Pornire ------------------------------------------------------------------

  async start(user: CurrentUser, key: string, documentId: number): Promise<{ instanceId: number }> {
    const def = await this.db.one('SELECT id, version, xml FROM workflow_definitions WHERE key = $1 ORDER BY version DESC LIMIT 1', [key]);
    if (!def) notFound('Flux inexistent');
    const doc = await this.docs.requireVisible(user, documentId);
    if (!can(user, 'register') && doc.owner_id !== user.id) forbidden();
    const process = this.loadProcess(def.xml);
    const start = [...process.elements.values()].find((e) => e.type === 'startEvent');
    if (!start) conflict('Definiția fluxului nu are eveniment de start');
    try {
      return await this.db.tx(async (c) => {
        const locked = (await c.query(DOC_SQL, [documentId])).rows[0];
        if (['arhivat', 'eliminat'].includes(locked.status)) conflict('Documentul arhivat nu poate intra într-un flux');
        const active = await c.query(`SELECT 1 FROM workflow_instances WHERE document_id = $1 AND status = 'activ'`, [documentId]);
        if (active.rowCount) conflict('Documentul are deja un flux activ');
        const instance = (await c.query(
          'INSERT INTO workflow_instances (definition_id, document_id, started_by) VALUES ($1,$2,$3) RETURNING *', [def.id, documentId, user.id])).rows[0];
        await c.query(`UPDATE documents SET status = 'in_flux' WHERE id = $1`, [documentId]);
        const ctx: Ctx = { c, instance, doc: locked, process, actor: user };
        await this.audit.log(user, { action: 'flux.pornit', documentId, details: { instanta: instance.id, cheie: key, versiune: def.version } }, c);
        await this.recordStep(ctx, start!);
        await this.advance(ctx, start!.outgoing);
        return { instanceId: instance.id as number };
      });
    } catch (err: any) {
      // Indexul „un singur flux activ” prinde pornirile concurente.
      if (err?.code === '23505') conflict('Documentul are deja un flux activ');
      throw err;
    }
  }

  private loadProcess(xml: string): BpmnProcess {
    const { process, errors } = parseBpmn(xml);
    if (!process || errors.length) conflict(`Definiția fluxului este invalidă: ${errors.join('; ')}`);
    return process!;
  }

  // Acțiuni pe sarcini ---------------------------------------------------------

  async act(user: CurrentUser, taskId: number, input: TaskActionInput) {
    const action = String(input.action ?? '');
    if (!['approve', 'sign', 'reject', 'redirect', 'request_info'].includes(action)) badRequest('Acțiune necunoscută');
    const ref = await this.db.one('SELECT instance_id FROM tasks WHERE id = $1', [taskId]);
    if (!ref) notFound('Sarcină inexistentă');
    try {
      return await this.db.tx(async (c) => {
        const { instance, doc } = await this.lockInstance(c, ref.instance_id);
        // Starea se verifică abia după blocare: între timp altcineva poate fi rezolvat pasul.
        const task = (await c.query('SELECT * FROM tasks WHERE id = $1', [taskId])).rows[0];
        if (task.assignee_id !== user.id) forbidden('Doar titularul sarcinii poate acționa asupra ei');
        if (task.kind !== 'completare' && !can(user, 'approve')) forbidden();
        if (task.status !== 'deschisa') conflict('Sarcina nu mai este deschisă');
        if (instance.status !== 'activ') conflict('Fluxul s-a încheiat');
        if (['arhivat', 'eliminat'].includes(doc.status)) conflict('Documentul arhivat nu se mai poate modifica');

        const def = (await c.query('SELECT xml FROM workflow_definitions WHERE id = $1', [instance.definition_id])).rows[0];
        const ctx: Ctx = { c, instance, doc, process: this.loadProcess(def.xml), actor: user };
        const comment = optText(input.comment);
        let status: string;
        switch (action) {
          case 'approve': status = await this.approve(ctx, task, comment); break;
          case 'sign': status = await this.sign(ctx, task, user, input.password, comment); break;
          case 'reject': status = await this.reject(ctx, task, comment); break;
          case 'redirect': status = await this.redirect(ctx, task, input.targetUserId, comment); break;
          default: status = await this.requestInfo(ctx, task, comment);
        }
        return { taskId, status, instanceStatus: ctx.instance.status as string };
      });
    } catch (err) {
      if (action === 'sign' && err instanceof HttpException && err.getStatus() === 401) {
        // Tranzacția s-a anulat, deci încercarea eșuată se notează separat.
        await this.audit.log(user, { action: 'sarcina.semnare_esuata', details: { sarcina: taskId } });
        await this.docs.registerSignFailure(user);
      }
      throw err;
    }
  }

  /**
   * Finalizează o sarcină de semnare cu o semnătură cu certificat, deja verificată criptografic.
   * `sign` scrie versiunea semnată în aceeași tranzacție, sub aceleași blocări ca semnătura internă.
   */
  async signTaskWith<S extends { id: number }>(user: CurrentUser, taskId: number, comment: string | null, sign: (c: Queryable) => Promise<S>) {
    const ref = await this.db.one('SELECT instance_id FROM tasks WHERE id = $1', [taskId]);
    if (!ref) notFound('Sarcină inexistentă');
    return this.db.tx(async (c) => {
      const { instance, doc } = await this.lockInstance(c, ref.instance_id);
      const task = (await c.query('SELECT * FROM tasks WHERE id = $1', [taskId])).rows[0];
      if (task.assignee_id !== user.id) forbidden('Doar titularul sarcinii poate acționa asupra ei');
      if (!can(user, 'approve')) forbidden();
      if (task.kind !== 'semnare') badRequest('Doar sarcinile de semnare se finalizează cu semnătură');
      if (task.status !== 'deschisa') conflict('Sarcina nu mai este deschisă');
      if (instance.status !== 'activ') conflict('Fluxul s-a încheiat');
      if (['arhivat', 'eliminat'].includes(doc.status)) conflict('Documentul arhivat nu se mai poate modifica');
      const def = (await c.query('SELECT xml FROM workflow_definitions WHERE id = $1', [instance.definition_id])).rows[0];
      const ctx: Ctx = { c, instance, doc, process: this.loadProcess(def.xml), actor: user };
      const signature = await sign(c);
      await this.closeTask(c, task.id, 'finalizata', comment);
      await this.audit.log(user, { action: 'sarcina.aprobata', documentId: task.document_id, details: { sarcina: task.id, tip: task.kind, semnatura: signature.id, comentariu: comment } }, c);
      await this.evaluateStep(ctx, task.step_id);
      return { taskId, status: 'finalizata', instanceStatus: ctx.instance.status as string, signature };
    });
  }

  /** Ordinea de blocare este mereu instanță, apoi document, apoi jurnalul de audit. */
  private async lockInstance(c: Queryable, instanceId: number) {
    const instance = (await c.query('SELECT * FROM workflow_instances WHERE id = $1 FOR UPDATE', [instanceId])).rows[0];
    const doc = (await c.query(DOC_SQL, [instance.document_id])).rows[0];
    return { instance, doc };
  }

  private async approve(ctx: Ctx, task: any, comment: string | null): Promise<string> {
    if (task.kind === 'semnare') badRequest('Sarcina de semnare se finalizează cu acțiunea „sign” și parola sau cu semnătură cu certificat');
    if (task.kind === 'completare') return this.finishInfo(ctx, task, comment);
    await this.closeTask(ctx.c, task.id, 'finalizata', comment);
    await this.audit.log(ctx.actor, { action: 'sarcina.aprobata', documentId: task.document_id, details: { sarcina: task.id, tip: task.kind, comentariu: comment } }, ctx.c);
    await this.evaluateStep(ctx, task.step_id);
    return 'finalizata';
  }

  private async sign(ctx: Ctx, task: any, user: CurrentUser, password: unknown, comment: string | null): Promise<string> {
    if (task.kind !== 'semnare') badRequest('Doar sarcinile de semnare se finalizează cu semnătură');
    if (typeof password !== 'string' || !password) badRequest('Parola de confirmare este obligatorie');
    const signature = await this.docs.signInternal(user, task.document_id, password as string, ctx.c);
    await this.closeTask(ctx.c, task.id, 'finalizata', comment);
    await this.audit.log(ctx.actor, { action: 'sarcina.aprobata', documentId: task.document_id, details: { sarcina: task.id, tip: task.kind, semnatura: signature.id, comentariu: comment } }, ctx.c);
    await this.evaluateStep(ctx, task.step_id);
    return 'finalizata';
  }

  private async reject(ctx: Ctx, task: any, comment: string | null): Promise<string> {
    if (task.kind === 'completare') badRequest('O sarcină de completare nu poate fi respinsă');
    if (!comment) badRequest('Motivul respingerii este obligatoriu');
    await this.closeTask(ctx.c, task.id, 'respinsa', comment);
    await this.audit.log(ctx.actor, { action: 'sarcina.respinsa', documentId: task.document_id, details: { sarcina: task.id, tip: task.kind, comentariu: comment } }, ctx.c);
    await this.evaluateStep(ctx, task.step_id);
    return 'respinsa';
  }

  private async redirect(ctx: Ctx, task: any, targetUserId: unknown, comment: string | null): Promise<string> {
    const { c } = ctx;
    if (targetUserId == null || targetUserId === '') badRequest('Alegeți persoana către care redirecționați');
    const targetId = toInt(targetUserId, 'utilizator');
    const needsApprove = task.kind !== 'completare';
    const target = (await c.query(`SELECT id, active, ${canApproveSql('u')} AS can_approve FROM users u WHERE id = $1`, [targetId])).rows[0];
    if (!target || !target.active) badRequest('Utilizatorul ales nu există sau este inactiv');
    if (needsApprove && !target.can_approve) badRequest('Utilizatorul ales nu are drept de aprobare');
    const assigneeId = await this.effectiveAssignee(c, targetId, needsApprove);
    if (assigneeId === task.assignee_id) badRequest('Sarcina vă este deja atribuită');
    const duplicate = await c.query(
      `SELECT 1 FROM tasks WHERE step_id = $1 AND assignee_id = $2 AND kind = $3 AND status IN ('deschisa','asteapta_completare')`, [task.step_id, assigneeId, task.kind]);
    if (duplicate.rowCount) conflict('Persoana aleasă are deja o sarcină deschisă pe acest pas');
    await this.closeTask(c, task.id, 'redirectionata', comment);
    const newId = await this.createTask(ctx, {
      stepId: task.step_id, assigneeId, kind: task.kind, name: task.name, dueAt: task.due_at,
      parentTaskId: task.parent_task_id, redirectedFrom: task.assignee_id, comment: task.kind === 'completare' ? task.comment : null,
    });
    await this.notify.send(assigneeId, 'sarcina_noua', `Sarcină redirecționată: ${task.name} (${ctx.doc.title})`, { documentId: task.document_id, taskId: newId }, c);
    await this.audit.log(ctx.actor, { action: 'sarcina.redirectionata', documentId: task.document_id, details: { sarcina: task.id, sarcinaNoua: newId, catre: assigneeId, comentariu: comment } }, c);
    return 'redirectionata';
  }

  private async requestInfo(ctx: Ctx, task: any, comment: string | null): Promise<string> {
    const { c } = ctx;
    if (task.kind === 'completare') badRequest('Pentru o sarcină de completare nu se poate cere altă completare');
    if (!comment) badRequest('Spuneți ce informații lipsesc');
    const initiator = (await c.query('SELECT active FROM users WHERE id = $1', [ctx.instance.started_by])).rows[0];
    const base = initiator.active ? ctx.instance.started_by : await this.fallbackUser(ctx, false);
    if (base == null) conflict('Nu există nimeni care să poată completa documentul');
    const assigneeId = await this.effectiveAssignee(c, base, false);
    await c.query(`UPDATE tasks SET status = 'asteapta_completare', comment = $2 WHERE id = $1`, [task.id, comment]);
    const childId = await this.createTask(ctx, {
      stepId: task.step_id, assigneeId, kind: 'completare', name: `Completare: ${task.name}`, dueAt: null,
      parentTaskId: task.id, redirectedFrom: null, comment,
    });
    await this.notify.send(assigneeId, 'completare_ceruta', `Completare cerută: ${task.name} (${ctx.doc.title})`, { documentId: task.document_id, taskId: childId }, c);
    await this.audit.log(ctx.actor, { action: 'sarcina.completare_ceruta', documentId: task.document_id, details: { sarcina: task.id, sarcinaCompletare: childId, catre: assigneeId, comentariu: comment } }, c);
    return 'asteapta_completare';
  }

  private async finishInfo(ctx: Ctx, task: any, comment: string | null): Promise<string> {
    const { c } = ctx;
    await this.closeTask(c, task.id, 'finalizata', comment);
    const parent = (await c.query(
      `UPDATE tasks SET status = 'deschisa' WHERE id = $1 AND status = 'asteapta_completare' RETURNING id, assignee_id, name`, [task.parent_task_id])).rows[0];
    if (parent) {
      await this.notify.send(parent.assignee_id, 'completare_finalizata', `Completare primită: ${parent.name} (${ctx.doc.title})`, { documentId: task.document_id, taskId: parent.id }, c);
    }
    await this.audit.log(ctx.actor, { action: 'sarcina.completare_finalizata', documentId: task.document_id, details: { sarcina: task.id, sarcinaOriginala: task.parent_task_id, comentariu: comment } }, c);
    return 'finalizata';
  }

  private async closeTask(c: Queryable, taskId: number, status: string, comment: string | null) {
    await c.query('UPDATE tasks SET status = $2, comment = COALESCE($3, comment), completed_at = clock_timestamp() WHERE id = $1', [taskId, status, comment]);
  }

  // Regula de finalizare a pasului ---------------------------------------------

  private async evaluateStep(ctx: Ctx, stepId: number) {
    const { c, process } = ctx;
    const step = (await c.query('SELECT * FROM workflow_steps WHERE id = $1', [stepId])).rows[0];
    if (step.status !== 'activ') return;
    // Sarcinile de completare nu sunt voturi; cele redirecționate sau anulate nu mai contează.
    const counts = (await c.query(
      `SELECT count(*)::int AS n,
              count(*) FILTER (WHERE status = 'finalizata')::int AS approvals,
              count(*) FILTER (WHERE status = 'respinsa')::int AS rejections
       FROM tasks WHERE step_id = $1 AND kind <> 'completare' AND status NOT IN ('redirectionata','anulata')`, [stepId])).rows[0];
    const outcome = stepOutcome(step.completion ?? 'any', counts.n, counts.approvals, counts.rejections);
    if (!outcome) return;
    await this.closeOpenTasks(c, 'step_id = $1', [stepId]);
    if (outcome === 'respins') {
      await c.query(`UPDATE workflow_steps SET status = 'respins', finished_at = clock_timestamp() WHERE id = $1`, [stepId]);
      await this.endRejected(ctx, { motiv: 'respingere', pas: step.name ?? step.element_id });
      return;
    }
    await c.query(`UPDATE workflow_steps SET status = 'finalizat', finished_at = clock_timestamp() WHERE id = $1`, [stepId]);
    const element = process.elements.get(step.element_id);
    if (!element) conflict(`Elementul ${step.element_id} nu mai există în definiția fluxului`);
    await this.advance(ctx, element!.outgoing);
  }

  private async closeOpenTasks(c: Queryable, where: string, params: unknown[]) {
    await c.query(`UPDATE tasks SET status = 'anulata', completed_at = clock_timestamp() WHERE ${where} AND status IN ('deschisa','asteapta_completare')`, params);
  }

  // Tokeni ---------------------------------------------------------------------

  /** Avansează toți tokenii până la sarcini, porți de unire sau final, apoi decide dacă instanța s-a încheiat. */
  private async advance(ctx: Ctx, flows: BpmnFlow[]) {
    const queue = [...flows];
    let hops = 0;
    while (queue.length) {
      if (++hops > MAX_HOPS) conflict('Fluxul conține o buclă fără sarcini și a fost oprit');
      const flow = queue.shift()!;
      const el = ctx.process.elements.get(flow.targetId);
      if (!el) conflict(`Legătura ${flow.id} duce la un element inexistent`);
      switch (el!.type) {
        case 'userTask':
          await this.activateTask(ctx, el!);
          break;
        case 'exclusiveGateway':
          await this.recordStep(ctx, el!);
          queue.push(this.chooseBranch(ctx, el!));
          break;
        case 'parallelGateway':
          queue.push(...(await this.arriveAtParallel(ctx, el!, flow)));
          break;
        case 'endEvent':
          await this.recordStep(ctx, el!);
          break;
        default:
          conflict(`Elementul ${el!.id} nu poate fi atins în timpul execuției`);
      }
    }
    await this.settle(ctx);
  }

  private async recordStep(ctx: Ctx, el: BpmnElement) {
    await ctx.c.query(
      `INSERT INTO workflow_steps (instance_id, element_id, element_type, name, status, finished_at) VALUES ($1,$2,$3,$4,'finalizat',clock_timestamp())`,
      [ctx.instance.id, el.id, el.type, el.name]);
  }

  private chooseBranch(ctx: Ctx, el: BpmnElement): BpmnFlow {
    const fallback = el.outgoing.find((f) => f.id === el.defaultFlowId) ?? el.outgoing.find((f) => !f.condition);
    for (const flow of el.outgoing) {
      if (flow === fallback || !flow.condition) continue;
      const condition = parseCondition(flow.condition);
      if (condition && this.conditionHolds(ctx, condition)) return flow;
    }
    if (!fallback) conflict(`Poarta ${label(el)}: nicio condiție nu este îndeplinită și nu există o cale implicită`);
    return fallback!;
  }

  private conditionHolds(ctx: Ctx, { field, value }: { field: string; value: string }) {
    const { doc } = ctx;
    const metadata = doc.metadata ?? {};
    const actual = field === 'tip' ? doc.type_name
      : field === 'departament' ? doc.department_name
      : Object.hasOwn(metadata, field) ? metadata[field] : null;
    if (actual == null) return false;
    const norm = (s: unknown) => String(s).trim().toLocaleLowerCase('ro');
    return norm(actual) === norm(value);
  }

  /** Poarta paralelă așteaptă un token pe fiecare legătură de intrare, consumă câte unul și pornește toate ieșirile. */
  private async arriveAtParallel(ctx: Ctx, el: BpmnElement, flow: BpmnFlow): Promise<BpmnFlow[]> {
    const { c, instance } = ctx;
    await c.query('INSERT INTO workflow_join_tokens (instance_id, element_id, flow_id) VALUES ($1,$2,$3)', [instance.id, el.id, flow.id]);
    let step = (await c.query(`SELECT id FROM workflow_steps WHERE instance_id = $1 AND element_id = $2 AND status = 'activ' LIMIT 1`, [instance.id, el.id])).rows[0];
    if (!step) {
      step = (await c.query(
        `INSERT INTO workflow_steps (instance_id, element_id, element_type, name) VALUES ($1,$2,$3,$4) RETURNING id`, [instance.id, el.id, el.type, el.name])).rows[0];
    }
    const present = await c.query('SELECT DISTINCT flow_id FROM workflow_join_tokens WHERE instance_id = $1 AND element_id = $2', [instance.id, el.id]);
    const have = new Set(present.rows.map((r) => r.flow_id));
    if (!el.incoming.every((f) => have.has(f.id))) return [];
    await c.query(
      `DELETE FROM workflow_join_tokens WHERE id IN (
         SELECT min(id) FROM workflow_join_tokens WHERE instance_id = $1 AND element_id = $2 GROUP BY flow_id)`, [instance.id, el.id]);
    await c.query(`UPDATE workflow_steps SET status = 'finalizat', finished_at = clock_timestamp() WHERE id = $1`, [step.id]);
    return el.outgoing;
  }

  /** Se rulează după ce toți tokenii s-au oprit, nu la primul final: altă ramură poate fi încă în lucru. */
  private async settle(ctx: Ctx) {
    const { c, instance } = ctx;
    if (instance.status !== 'activ') return;
    const row = (await c.query(
      `SELECT (SELECT count(*)::int FROM workflow_steps WHERE instance_id = $1 AND status = 'activ' AND element_type = 'userTask') AS active,
              (SELECT count(*)::int FROM workflow_join_tokens WHERE instance_id = $1) AS tokens`, [instance.id])).rows[0];
    if (row.active > 0) return;
    if (row.tokens > 0) {
      // Un token așteaptă la o poartă pe care nu o mai poate atinge nimic. Fluxul nu poate fi aprobat și nu rămâne suspendat.
      await this.audit.log(ctx.actor, { action: 'flux.blocat', documentId: instance.document_id, details: { instanta: instance.id, tokeni: row.tokens } }, c);
      await this.endRejected(ctx, { motiv: 'flux_blocat' });
      return;
    }
    await this.endApproved(ctx);
  }

  private async endApproved(ctx: Ctx) {
    const { c, instance, doc } = ctx;
    await c.query(`UPDATE workflow_instances SET status = 'aprobat', finished_at = clock_timestamp() WHERE id = $1`, [instance.id]);
    instance.status = 'aprobat';
    await c.query(`UPDATE documents SET status = 'aprobat' WHERE id = $1`, [doc.id]);
    await this.notify.send(instance.started_by, 'document_aprobat', `Documentul „${doc.title}” a fost aprobat`, { documentId: doc.id }, c);
    await this.audit.log(ctx.actor, { action: 'flux.aprobat', documentId: doc.id, details: { instanta: instance.id } }, c);
  }

  private async endRejected(ctx: Ctx, details: Record<string, unknown>) {
    const { c, instance, doc } = ctx;
    await this.closeOpenTasks(c, 'instance_id = $1', [instance.id]);
    await c.query(`UPDATE workflow_steps SET status = 'anulat', finished_at = clock_timestamp() WHERE instance_id = $1 AND status = 'activ'`, [instance.id]);
    await c.query('DELETE FROM workflow_join_tokens WHERE instance_id = $1', [instance.id]);
    await c.query(`UPDATE workflow_instances SET status = 'respins', finished_at = clock_timestamp() WHERE id = $1`, [instance.id]);
    instance.status = 'respins';
    await c.query(`UPDATE documents SET status = 'respins' WHERE id = $1`, [doc.id]);
    await this.notify.send(instance.started_by, 'document_respins', `Documentul „${doc.title}” a fost respins`, { documentId: doc.id }, c);
    await this.audit.log(ctx.actor, { action: 'flux.respins', documentId: doc.id, details: { instanta: instance.id, ...details } }, c);
  }

  // Activarea unui pas ---------------------------------------------------------

  private async activateTask(ctx: Ctx, el: BpmnElement) {
    const { c, instance, doc } = ctx;
    const completion = el.completion ?? 'any';
    const step = (await c.query(
      `INSERT INTO workflow_steps (instance_id, element_id, element_type, name, completion) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [instance.id, el.id, el.type, el.name, completion])).rows[0];
    const titulars = await this.resolveAssignees(ctx, el);
    // Doi titulari cu același înlocuitor înseamnă o singură sarcină.
    const assignees = new Map<number, number>();
    for (const titular of titulars) {
      const assignee = await this.effectiveAssignee(c, titular, true);
      if (!assignees.has(assignee)) assignees.set(assignee, titular);
    }
    const kind = el.action ?? 'avizare';
    const name = el.name ?? el.id;
    const dueAt = el.dueHours == null ? null : new Date(Date.now() + Number(el.dueHours) * 3_600_000);
    for (const [assigneeId, titularId] of assignees) {
      const redirectedFrom = titularId === assigneeId ? null : titularId;
      const taskId = await this.createTask(ctx, { stepId: step.id, assigneeId, kind, name, dueAt, parentTaskId: null, redirectedFrom, comment: null });
      await this.notify.send(assigneeId, 'sarcina_noua', `Sarcină nouă: ${name} (${doc.title})`, { documentId: doc.id, taskId }, c);
      await this.audit.log(ctx.actor, { action: 'sarcina.creata', documentId: doc.id, details: { sarcina: taskId, pas: el.id, tip: kind, titular: titularId, atribuitLui: assigneeId } }, c);
    }
  }

  private async createTask(ctx: Ctx, t: {
    stepId: number; assigneeId: number; kind: string; name: string; dueAt: Date | null;
    parentTaskId: number | null; redirectedFrom: number | null; comment: string | null;
  }): Promise<number> {
    const { c, instance } = ctx;
    const row = (await c.query(
      `INSERT INTO tasks (step_id, instance_id, document_id, assignee_id, kind, name, due_at, parent_task_id, redirected_from, comment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [t.stepId, instance.id, instance.document_id, t.assigneeId, t.kind, t.name, t.dueAt, t.parentTaskId, t.redirectedFrom, t.comment])).rows[0];
    await c.query('INSERT INTO document_access (document_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [instance.document_id, t.assigneeId]);
    return row.id;
  }

  /** Titularii pasului. Fără niciunul: managerul departamentului, apoi un administrator, cu urmă în audit. */
  private async resolveAssignees(ctx: Ctx, el: BpmnElement): Promise<number[]> {
    const { c, instance, doc } = ctx;
    const values = splitValues(el.assignee).map((v) => v.toLowerCase());
    const eligible = `u.active AND ${canApproveSql('u')}`;
    const select = async (where: string, param: unknown) =>
      (await c.query(`SELECT u.id FROM users u WHERE ${where} AND ${eligible} ORDER BY u.id`, [param])).rows.map((r) => r.id as number);
    let ids: number[] = [];
    switch (el.assigneeType) {
      case 'functie': ids = await select('lower(u.job_title) = ANY($1::text[])', values); break;
      case 'rol': ids = await select('u.role = ANY($1::text[])', values); break;
      case 'utilizator': ids = await select('lower(u.username) = ANY($1::text[])', values); break;
      case 'manager_departament': ids = await select('u.id = (SELECT manager_id FROM departments WHERE id = $1)', doc.department_id); break;
      case 'initiator': ids = await select('u.id = $1', instance.started_by); break;
    }
    if (ids.length) return ids;
    const fallback = await this.fallbackUser(ctx, true);
    if (fallback == null) conflict(`Pasul ${label(el)} nu are niciun titular și nu există un administrator activ`);
    await this.audit.log(ctx.actor, {
      action: 'flux.titular_lipsa', documentId: doc.id,
      details: { instanta: instance.id, pas: el.id, tipTitular: el.assigneeType, titular: el.assignee, atribuitLui: fallback },
    }, c);
    return [fallback!];
  }

  private async fallbackUser(ctx: Ctx, needsApprove: boolean): Promise<number | null> {
    const { c, doc } = ctx;
    const eligible = `u.active AND ${needsApprove ? canApproveSql('u') : 'TRUE'}`;
    const manager = (await c.query(
      `SELECT u.id FROM departments d JOIN users u ON u.id = d.manager_id WHERE d.id = $1 AND ${eligible}`, [doc.department_id])).rows[0];
    if (manager) return manager.id;
    const admin = (await c.query(`SELECT u.id FROM users u WHERE u.role = 'admin' AND ${eligible} ORDER BY u.id LIMIT 1`)).rows[0];
    return admin?.id ?? null;
  }

  /** Înlocuitorul activ primește sarcina; se urmează lanțul dacă și el este înlocuit. */
  private async effectiveAssignee(c: Queryable, userId: number, needsApprove: boolean): Promise<number> {
    const seen = new Set([userId]);
    let current = userId;
    for (;;) {
      const next = (await c.query(
        `SELECT s.id FROM users u JOIN users s ON s.id = u.substitute_id
         WHERE u.id = $1 AND u.substitute_until >= ${TODAY_SQL} AND s.active AND ${needsApprove ? canApproveSql('s') : 'TRUE'}`, [current])).rows[0];
      if (!next || seen.has(next.id)) return current;
      seen.add(next.id);
      current = next.id;
    }
  }

  // Termene --------------------------------------------------------------------

  async checkDeadlines(): Promise<{ reminded: number; escalated: number }> {
    const result = { reminded: 0, escalated: 0 };
    const due = (await this.db.query(
      `SELECT t.id, t.instance_id FROM tasks t JOIN workflow_instances i ON i.id = t.instance_id
       WHERE t.status = 'deschisa' AND i.status = 'activ' AND t.due_at IS NOT NULL
         AND ((t.escalated_at IS NULL AND t.due_at <= now())
           OR (t.reminded_at IS NULL AND t.due_at > now() AND t.due_at <= now() + interval '24 hours'))
       ORDER BY t.id`)).rows;
    for (const row of due) {
      try {
        const outcome = await this.db.tx((c) => this.fireDeadline(c, row.id, row.instance_id));
        if (outcome) result[outcome]++;
      } catch (err) {
        this.logger.error(`Termenul sarcinii ${row.id} nu a putut fi procesat: ${String(err)}`);
      }
    }
    return result;
  }

  private async fireDeadline(c: Queryable, taskId: number, instanceId: number): Promise<'reminded' | 'escalated' | null> {
    const { doc } = await this.lockInstance(c, instanceId);
    // Actualizarea condiționată este cea care garantează trimiterea o singură dată.
    const escalated = (await c.query(
      `UPDATE tasks SET escalated_at = now() WHERE id = $1 AND status = 'deschisa' AND escalated_at IS NULL AND due_at <= now() RETURNING *`, [taskId])).rows[0];
    if (escalated) {
      const title = `Termen depășit: ${escalated.name} (${doc.title})`;
      const refs = { documentId: doc.id, taskId };
      await this.notify.send(escalated.assignee_id, 'termen_depasit', title, refs, c);
      const manager = (await c.query(
        `SELECT u.id FROM departments d JOIN users u ON u.id = d.manager_id WHERE d.id = $1 AND u.active`, [doc.department_id])).rows[0];
      if (manager && manager.id !== escalated.assignee_id) await this.notify.send(manager.id, 'termen_depasit', title, refs, c);
      await this.audit.log(null, {
        action: 'flux.termen_depasit', documentId: doc.id,
        details: { sarcina: taskId, titular: escalated.assignee_id, manager: manager?.id ?? null, escaladat: true },
      }, c);
      return 'escalated';
    }
    const reminded = (await c.query(
      `UPDATE tasks SET reminded_at = now() WHERE id = $1 AND status = 'deschisa' AND reminded_at IS NULL AND due_at > now() AND due_at <= now() + interval '24 hours' RETURNING *`, [taskId])).rows[0];
    if (!reminded) return null;
    await this.notify.send(reminded.assignee_id, 'termen_apropiat', `Termen apropiat: ${reminded.name} (${doc.title})`, { documentId: doc.id, taskId }, c);
    await this.audit.log(null, { action: 'flux.termen_apropiat', documentId: doc.id, details: { sarcina: taskId, titular: reminded.assignee_id } }, c);
    return 'reminded';
  }

  startScheduler() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), config.schedulerMs);
    this.timer.unref();
  }

  stopScheduler() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick() {
    if (this.checking) return;
    this.checking = true;
    try {
      await this.checkDeadlines();
    } catch (err) {
      this.logger.error(`Verificarea termenelor a eșuat: ${String(err)}`);
    } finally {
      this.checking = false;
    }
  }

  onApplicationShutdown() {
    this.stopScheduler();
  }
}

/** Regula de finalizare: `aprobat`, `respins` sau null dacă pasul mai așteaptă. */
export function stepOutcome(completion: string, n: number, approvals: number, rejections: number): 'aprobat' | 'respins' | null {
  switch (completion) {
    case 'all':
      if (rejections > 0) return 'respins';
      return approvals === n ? 'aprobat' : null;
    case 'majority': {
      const need = Math.floor(n / 2) + 1;
      if (approvals >= need) return 'aprobat';
      return rejections > n - need ? 'respins' : null;
    }
    default:
      if (approvals > 0) return 'aprobat';
      return rejections === n ? 'respins' : null;
  }
}

// Folosit de controller la erorile de publicare.
export function invalidDefinition(errors: string[]): never {
  throw new HttpException({ message: 'Definiția fluxului este invalidă', errors }, 400);
}
