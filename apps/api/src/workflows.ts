import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuditService } from './audit.js';
import { AuthGuard, RequirePerm, User } from './auth.js';
import { Db, Queryable } from './db.js';
import { DocumentsService } from './documents.js';
import { badRequest, conflict, forbidden, notFound, optInt, optText, toInt } from './http.js';
import { can, CurrentUser, visibleSql } from './perms.js';
import { canApproveSql, invalidDefinition, TaskActionInput, WorkflowEngine } from './workflow-engine.js';

const DEFINITION_COLUMNS = `w.id, w.key, w.version, w.name, w.description, w.department_id AS "departmentId",
  dep.name AS "departmentName", w.created_at AS "createdAt"`;
const DEFINITION_JOINS = 'FROM workflow_definitions w LEFT JOIN departments dep ON dep.id = w.department_id';

const OVERDUE_SQL = `(t.status IN ('deschisa','asteapta_completare') AND t.due_at IS NOT NULL AND t.due_at < now())`;
const TASK_SELECT = `SELECT t.id, t.document_id AS "documentId", d.title AS "documentTitle", d.reg_label AS "regLabel", t.name, t.kind, t.status,
    t.due_at AS "dueAt", ${OVERDUE_SQL} AS overdue, t.created_at AS "createdAt", def.name AS "workflowName", t.instance_id AS "instanceId", t.comment
  FROM tasks t
  JOIN documents d ON d.id = t.document_id
  JOIN workflow_instances i ON i.id = t.instance_id
  JOIN workflow_definitions def ON def.id = i.definition_id`;

/** Doar administratorul are acces pe toate; ceilalți editori doar pe definițiile departamentului lor. */
function canEditDefinition(user: CurrentUser, departmentId: number | null): boolean {
  if (!can(user, 'workflow_edit')) return false;
  return user.role === 'admin' || (departmentId != null && departmentId === user.departmentId);
}

export function slugify(name: string): string {
  return name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

interface PublishInput { key?: unknown; name?: unknown; description?: unknown; departmentId?: unknown; xml?: unknown }

@Controller('workflows')
@UseGuards(AuthGuard)
export class WorkflowsController {
  constructor(
    private readonly db: Db,
    private readonly engine: WorkflowEngine,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(@User() user: CurrentUser) {
    const rows = (await this.db.query(
      `SELECT DISTINCT ON (w.key) ${DEFINITION_COLUMNS} ${DEFINITION_JOINS} ORDER BY w.key, w.version DESC`)).rows;
    return rows.map((r) => ({ ...r, canEdit: canEditDefinition(user, r.departmentId) }));
  }

  // Declarată înaintea rutei `:key`, altfel „assignee-options” ar fi citit drept cheie.
  @Get('assignee-options')
  async assigneeOptions() {
    const eligible = `u.active AND ${canApproveSql('u')}`;
    const jobTitles = await this.db.query(`SELECT DISTINCT u.job_title AS v FROM users u WHERE ${eligible} AND u.job_title IS NOT NULL ORDER BY 1`);
    const roles = await this.db.query(`SELECT DISTINCT u.role AS v FROM users u WHERE ${eligible} ORDER BY 1`);
    const users = await this.db.query(
      `SELECT u.id, u.username, u.full_name AS "fullName", u.job_title AS "jobTitle", d.name AS "departmentName"
       FROM users u LEFT JOIN departments d ON d.id = u.department_id WHERE ${eligible} ORDER BY u.full_name`);
    const departments = await this.db.query('SELECT id, name FROM departments ORDER BY name');
    return { jobTitles: jobTitles.rows.map((r) => r.v), roles: roles.rows.map((r) => r.v), users: users.rows, departments: departments.rows };
  }

  @Post('validate') @HttpCode(200) @RequirePerm('workflow_edit')
  async validate(@Body() body: { xml?: unknown }) {
    return { errors: await this.engine.validate(body?.xml) };
  }

  @Post() @RequirePerm('workflow_edit')
  async publish(@User() user: CurrentUser, @Body() body: PublishInput) {
    const name = optText(body?.name);
    if (!name) badRequest('Denumirea fluxului este obligatorie');
    const key = optText(body.key) ?? slugify(name!);
    if (!/^[a-z0-9-]+$/.test(key)) badRequest('Cheia fluxului poate conține doar litere mici, cifre și cratime');
    const hasDepartment = body.departmentId !== undefined;
    const requested = optInt(body.departmentId, 'departament');
    if (requested != null && !(await this.db.one('SELECT 1 AS x FROM departments WHERE id = $1', [requested]))) badRequest('Departament inexistent');
    const errors = await this.engine.validate(body.xml);
    if (errors.length) invalidDefinition(errors);

    try {
      return await this.db.tx(async (c) => {
        const latest = (await c.query('SELECT version, department_id FROM workflow_definitions WHERE key = $1 ORDER BY version DESC LIMIT 1', [key])).rows[0];
        // O versiune nouă păstrează departamentul, dacă cererea nu îl schimbă explicit.
        const departmentId: number | null = hasDepartment ? requested : latest?.department_id ?? null;
        if (latest && !canEditDefinition(user, latest.department_id)) forbidden('Fluxul aparține altui departament');
        if (!canEditDefinition(user, departmentId)) forbidden('Puteți publica fluxuri doar pentru departamentul dumneavoastră');
        const version = (latest?.version ?? 0) + 1;
        const row = (await c.query(
          `INSERT INTO workflow_definitions (key, version, name, description, department_id, xml, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [key, version, name, optText(body.description), departmentId, body.xml, user.id])).rows[0];
        await this.audit.log(user, { action: 'flux.publicat', details: { definitie: row.id, cheie: key, versiune: version, departament: departmentId } }, c);
        const created = await this.definition(c, 'w.id = $1', [row.id]);
        return { ...created, canEdit: true };
      });
    } catch (err: any) {
      if (err?.code === '23505') conflict('Altcineva a publicat între timp o versiune a acestui flux. Reîncercați.');
      throw err;
    }
  }

  private async definition(c: Queryable, where: string, params: unknown[]) {
    return (await c.query(`SELECT ${DEFINITION_COLUMNS} ${DEFINITION_JOINS} WHERE ${where} ORDER BY w.version DESC LIMIT 1`, params)).rows[0];
  }

  @Get(':key')
  async get(@User() user: CurrentUser, @Param('key') key: string) {
    const row = await this.db.one(
      `SELECT ${DEFINITION_COLUMNS}, w.xml ${DEFINITION_JOINS} WHERE w.key = $1 ORDER BY w.version DESC LIMIT 1`, [key]);
    if (!row) notFound('Flux inexistent');
    return { ...row, canEdit: canEditDefinition(user, row.departmentId) };
  }

  @Get(':key/versions')
  async versions(@Param('key') key: string) {
    const rows = (await this.db.query(
      `SELECT w.version, w.created_at AS "createdAt", u.full_name AS "createdBy"
       FROM workflow_definitions w LEFT JOIN users u ON u.id = w.created_by WHERE w.key = $1 ORDER BY w.version DESC`, [key])).rows;
    if (!rows.length) notFound('Flux inexistent');
    return rows;
  }

  @Post(':key/start')
  start(@User() user: CurrentUser, @Param('key') key: string, @Body() body: { documentId?: unknown }) {
    return this.engine.start(user, key, toInt(body?.documentId, 'document'));
  }
}

@Controller('tasks')
@UseGuards(AuthGuard)
export class TasksController {
  constructor(private readonly db: Db, private readonly engine: WorkflowEngine) {}

  @Get()
  async list(@User() user: CurrentUser, @Query('scope') scope?: string) {
    const done = scope === 'done';
    const rows = await this.db.query(
      `${TASK_SELECT} WHERE t.assignee_id = $1 AND t.status ${done ? `NOT IN` : `IN`} ('deschisa','asteapta_completare')
       ORDER BY ${done ? 't.completed_at DESC NULLS LAST, t.id DESC LIMIT 200' : 't.due_at ASC NULLS LAST, t.created_at, t.id'}`, [user.id]);
    return rows.rows;
  }

  @Post(':id/action') @HttpCode(200)
  action(@User() user: CurrentUser, @Param('id') id: string, @Body() body: TaskActionInput) {
    return this.engine.act(user, toInt(id), body ?? {});
  }
}

@Controller('dashboard')
@UseGuards(AuthGuard)
export class DashboardController {
  constructor(private readonly db: Db) {}

  @Get()
  async dashboard(@User() user: CurrentUser) {
    const tasks = (await this.db.query(
      `${TASK_SELECT} WHERE t.assignee_id = $1 AND t.status = 'deschisa' ORDER BY t.due_at ASC NULLS LAST, t.created_at, t.id`, [user.id])).rows;

    const params: unknown[] = [];
    const visible = visibleSql(user, params);
    const pendingWhere = `d.status IN ('inregistrat','in_flux') AND ${visible}`;
    const pendingDocuments = (await this.db.query(
      `SELECT d.id, d.title, d.reg_label AS "regLabel", d.status, d.created_at AS "createdAt"
       FROM documents d WHERE ${pendingWhere} ORDER BY d.created_at DESC, d.id DESC LIMIT 20`, params)).rows;
    const pending: number = (await this.db.one(`SELECT count(*)::int AS n FROM documents d WHERE ${pendingWhere}`, params))!.n;

    const dueDocuments = (await this.db.query(
      `SELECT d.id AS "documentId", d.title, d.due_date::text AS "dueAt" FROM documents d
       WHERE ${pendingWhere} AND d.due_date IS NOT NULL
         AND d.due_date <= (now() AT TIME ZONE 'Europe/Bucharest')::date + 7`, params)).rows;
    const horizon = Date.now() + 7 * 86_400_000;
    const dueThisWeek = [
      ...tasks.filter((t) => t.dueAt && new Date(t.dueAt).getTime() <= horizon)
        .map((t) => ({ id: t.id, title: t.name, dueAt: t.dueAt, kind: 'sarcina', documentId: t.documentId })),
      ...dueDocuments.map((d) => ({ ...d, kind: 'document' })),
    ].sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());

    return {
      tasks, pendingDocuments, dueThisWeek,
      counts: { openTasks: tasks.length, overdueTasks: tasks.filter((t) => t.overdue).length, pending },
    };
  }
}

@Controller('documents')
@UseGuards(AuthGuard)
export class DocumentWorkflowController {
  constructor(private readonly db: Db, private readonly docs: DocumentsService) {}

  @Get(':id/workflow')
  async workflow(@User() user: CurrentUser, @Param('id') id: string) {
    const documentId = toInt(id);
    await this.docs.requireVisible(user, documentId);
    const instances = (await this.db.query(
      `SELECT i.id, i.status, def.version, def.name, u.full_name AS "startedBy", i.started_at AS "startedAt", i.finished_at AS "finishedAt", def.xml
       FROM workflow_instances i JOIN workflow_definitions def ON def.id = i.definition_id JOIN users u ON u.id = i.started_by
       WHERE i.document_id = $1 ORDER BY i.id DESC`, [documentId])).rows;
    const ids = instances.map((i) => i.id);
    const steps = (await this.db.query(
      `SELECT instance_id, element_id AS "elementId", element_type AS "elementType", name, status, started_at AS "startedAt", finished_at AS "finishedAt"
       FROM workflow_steps WHERE instance_id = ANY($1::int[]) ORDER BY id`, [ids])).rows;
    const tasks = (await this.db.query(
      `SELECT t.instance_id, t.id, s.element_id AS "elementId", t.name, t.kind, t.status, u.full_name AS assignee, t.due_at AS "dueAt",
              ${OVERDUE_SQL} AS overdue, t.comment, t.completed_at AS "completedAt"
       FROM tasks t JOIN workflow_steps s ON s.id = t.step_id JOIN users u ON u.id = t.assignee_id
       WHERE t.instance_id = ANY($1::int[]) ORDER BY t.id`, [ids])).rows;
    const strip = ({ instance_id: _, ...rest }: any) => rest;
    return {
      instances: instances.map((i) => ({
        ...i,
        steps: steps.filter((s) => s.instance_id === i.id).map(strip),
        tasks: tasks.filter((t) => t.instance_id === i.id).map(strip),
      })),
    };
  }
}
