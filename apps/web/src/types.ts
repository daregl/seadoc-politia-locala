// Tipurile răspunsurilor API, conform docs/API.md.

export type Role = 'admin' | 'manager' | 'user' | 'registratura' | 'arhivar';
export type Permission =
  | 'register' | 'approve' | 'sign_qualified' | 'workflow_edit' | 'archive'
  | 'users_admin' | 'audit_all' | 'reports' | 'archive_journal' | 'cases_all' | 'intranet_publish';

export interface User {
  id: number;
  username: string;
  fullName: string;
  role: Role;
  departmentId: number | null;
  departmentName: string | null;
  jobTitle: string | null;
  hasToken: boolean;
  mfaEnabled: boolean;
  mustChangePassword: boolean;
  authSource?: 'local' | 'ldap' | 'oidc';
  permissions: Permission[];
}

export type LoginState = 'ok' | 'mfa' | 'mfa_enrol' | 'change_password';
export interface AuthResponse { state: LoginState; user?: User }
export interface MfaEnrolment { secret: string; uri: string; qr: string }

export type DocStatus = 'inregistrat' | 'in_flux' | 'aprobat' | 'respins' | 'arhivat' | 'eliminat' | 'anulat';
export type OcrStatus = 'in_asteptare' | 'in_lucru' | 'finalizat' | 'esuat' | 'neaplicabil';
export type Direction = 'intrat' | 'iesit' | 'intern';

export interface DocListItem {
  id: number;
  title: string;
  direction: Direction | null;
  regLabel: string | null;
  regDate: string | null;
  issuer: string | null;
  recipient: string | null;
  status: DocStatus;
  dueDate: string | null;
  createdAt: string;
  personalData: boolean;
  confidential?: boolean;
  typeName: string;
  departmentName: string;
  folderName: string | null;
  favorite: boolean;
  snippet: string | null;
}
export interface Paged<T> { total: number; items: T[] }

export interface TypeField { key: string; label: string; type: 'text' | 'date' | 'number'; required?: boolean }
export interface DocVersion {
  id: number;
  versionNo: number;
  filename: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
  ocrStatus: OcrStatus;
  ocrUsed: boolean;
  hasSearchable: boolean;
  hasFile: boolean;
  createdAt: string;
  createdBy: string;
}
export interface DocLink { kind: 'raspuns_la' | 'anexa_la' | 'conex'; dir: 'catre' | 'de_la'; id: number; title: string; regLabel: string | null }
export interface DocSignature {
  id: number;
  kind: string;
  sha256: string;
  signedAt: string;
  signer: string;
  versionNo: number;
  certificateSubject: string | null;
  certificateIssuer: string | null;
  testIndicators: string[];
  chainStatus: string | null;
  verdict: string | null;
}
/** Rezultatul verificatorului pentru o semnătură din PDF. Statutul calificat nu este stabilit niciodată de aplicație. */
export interface SignatureCheck {
  index: number;
  fieldName: string | null;
  subFilter: string | null;
  verdict: 'valida' | 'lant_neverificat' | 'lant_invalid' | 'alterata' | 'semnatura_invalida' | 'modificat_dupa_semnare' | 'certificat_nevalabil' | 'structura_invalida' | 'nesuportata';
  message: string;
  signer: { subject: string; issuer: string; commonName: string | null; serial: string; sha256: string; validFrom: string; validTo: string; selfSigned: boolean } | null;
  testIndicators: string[];
  signingTime: { value: string; source: string; note: string } | null;
  digestMatches: boolean;
  cmsSignatureValid: boolean;
  coversWholeFile: boolean;
  bytesAfterSignature: number;
  certificateValidAtSigning: boolean | null;
  chain: { status: 'verificat' | 'neverificat' | 'invalid'; message: string; rootFile: string | null } | null;
  revocation: { checked: false; message: string };
  qualified: { checked: false; message: string };
  timestamp: { present: boolean; verified: false; message: string | null };
  issues: string[];
}
export interface PdfSignatureReport {
  status: 'cu_semnaturi' | 'fara_semnaturi' | 'malformat' | 'esuat';
  message: string;
  fileSha256: string;
  trustRootsConfigured: number;
  signatures: SignatureCheck[];
  notes: string[];
}
export interface PdfSignatureCheckRow { id: number; versionNo: number; checkedAt: string; checkedBy: string; report: PdfSignatureReport }
export type OfficePreviewReply =
  | { kind: 'html'; format: 'docx' | 'xlsx' | 'pptx'; html: string; truncated: boolean; notes: string[] }
  | { kind: 'descarcare'; message: string };
export interface DocDuplicate { kind: 'amprenta' | 'text' | 'denumire'; score: number; id?: number; title?: string; regLabel?: string | null; restricted?: boolean }
export interface DocDetail {
  id: number;
  title: string;
  direction: Direction | null;
  regLabel: string | null;
  regDate: string | null;
  issuer: string | null;
  recipient: string | null;
  summary: string | null;
  dueDate: string | null;
  status: DocStatus;
  metadata: Record<string, string>;
  personalData: boolean;
  createdAt: string;
  archivedAt: string | null;
  retentionUntil: string | null;
  type: { id: number; name: string; nomenclatorCode: string; retentionYears: number | null; fields: TypeField[] };
  department: string;
  owner: string;
  register: string | null;
  folder: string | null;
  ownerId: number;
  departmentId: number;
  favorite: boolean;
  versions: DocVersion[];
  links: DocLink[];
  signatures: DocSignature[];
  duplicates: DocDuplicate[];
  canEdit: boolean;
  canAddVersion: boolean;
  canArchive: boolean;
  confidential: boolean;
  cancelReason: string | null;
  cancelledAt: string | null;
  cancelledBy: string | null;
  canCancel: boolean;
  cases: { id: number; kind: string; regLabel: string; role: string }[];
}
export interface DocStatusResponse {
  versions: { versionNo: number; ocrStatus: OcrStatus; ocrUsed: boolean; hasSearchable: boolean }[];
  duplicates: DocDuplicate[];
}

export interface Notification {
  id: number;
  kind: string;
  title: string;
  documentId: number | null;
  taskId: number | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface WorkflowSummary {
  id: number;
  key: string;
  version: number;
  name: string;
  description: string | null;
  departmentId: number | null;
  departmentName: string | null;
  canEdit: boolean;
  createdAt: string;
}
export interface WorkflowFull extends WorkflowSummary { xml: string }
export interface WorkflowVersion { version: number; createdAt: string; createdBy: string | null }
export interface AssigneeOptions {
  jobTitles: string[];
  roles: string[];
  users: { id: number; username: string; fullName: string; jobTitle: string | null; departmentName: string | null }[];
  departments: { id: number; name: string }[];
}

export type TaskKind = 'avizare' | 'aprobare' | 'semnare' | 'informare' | 'completare';
export type TaskStatus = 'deschisa' | 'asteapta_completare' | 'finalizata' | 'respinsa' | 'redirectionata' | 'anulata';
export interface Task {
  id: number;
  documentId: number;
  documentTitle: string;
  regLabel: string | null;
  name: string;
  kind: TaskKind;
  status: TaskStatus;
  dueAt: string | null;
  overdue: boolean;
  createdAt: string;
  workflowName: string;
  instanceId: number;
  comment?: string | null;
}
export type StepStatus = 'activ' | 'finalizat' | 'respins' | 'anulat';
export interface WorkflowStep {
  elementId: string;
  elementType: string;
  name: string | null;
  status: StepStatus;
  startedAt: string;
  finishedAt: string | null;
}
export interface InstanceTask {
  id: number;
  elementId: string;
  name: string;
  kind: TaskKind;
  status: TaskStatus;
  assignee: string;
  dueAt: string | null;
  overdue: boolean;
  comment: string | null;
  completedAt: string | null;
}
export interface WorkflowInstance {
  id: number;
  status: 'activ' | 'aprobat' | 'respins';
  version: number;
  name: string;
  startedBy: string;
  startedAt: string;
  finishedAt: string | null;
  xml: string;
  steps: WorkflowStep[];
  tasks: InstanceTask[];
}
export interface Dashboard {
  tasks: Task[];
  pendingDocuments: { id: number; title: string; regLabel: string | null; status: DocStatus; createdAt: string }[];
  dueThisWeek: { id?: number; title: string; dueAt: string; kind: 'sarcina' | 'document'; documentId: number }[];
  counts: { openTasks: number; overdueTasks: number; pending: number };
}

export interface Department { id: number; name: string; parentId: number | null; managerId: number | null; managerName: string | null }
export interface DocumentType { id: number; name: string; nomenclatorCode: string; retentionYears: number | null; fields: TypeField[] }
export interface Register { id: number; name: string; code: string; departmentId: number | null; documentTypeId: number | null; active: boolean }
export interface Folder { id: number; name: string; parentId: number | null; departmentId: number | null }
export interface MetaUser { id: number; fullName: string; jobTitle: string | null; departmentName: string | null }
export interface Meta {
  departments: Department[];
  documentTypes: DocumentType[];
  registers: Register[];
  folders: Folder[];
  users: MetaUser[];
}

export interface AuditRow {
  seq: number | string;
  at: string;
  username: string | null;
  action: string;
  documentId: number | null;
  ip: string | null;
  details: Record<string, unknown> | null;
  hash: string;
}
export interface AuditVerify { ok: boolean; checked: number; brokenAt: number | string | null }

export interface ReportSummary {
  byStatus: { departmentName: string; status: DocStatus; count: number }[];
  resolution: { departmentName: string; avgHours: number | null; count: number }[];
  overdue: { taskId: number; documentId: number; title: string; assignee: string; dueAt: string }[];
}

export interface ArchiveItem {
  id: number;
  title: string;
  regLabel: string | null;
  status: DocStatus;
  typeName: string;
  nomenclatorCode: string;
  archivedAt: string | null;
  retentionUntil: string | null;
  expired: boolean;
  proposalStatus: 'propusa' | 'aprobata' | 'respinsa' | null;
}
export interface Proposal {
  id: number;
  documentId: number;
  title: string;
  regLabel: string | null;
  retentionUntil: string | null;
  reason: string | null;
  proposedBy: string;
  proposedAt: string;
  status: 'propusa' | 'aprobata' | 'respinsa';
  decidedBy: string | null;
  decidedAt: string | null;
}

export interface AdminUser {
  id: number;
  username: string;
  fullName: string;
  email: string | null;
  role: Role;
  departmentId: number | null;
  departmentName: string | null;
  jobTitle: string | null;
  hasToken: boolean;
  active: boolean;
  mfaEnabled: boolean;
  mustChangePassword: boolean;
  authSource?: 'local' | 'ldap' | 'oidc';
  lockedUntil: string | null;
  substituteId: number | null;
  substituteName: string | null;
  substituteUntil: string | null;
  /** Doar ajustările individuale peste rol. */
  permissions: Partial<Record<Permission, boolean>>;
}
export type GrantScope = 'document' | 'folder' | 'type' | 'department';
export interface Grant { id: number; userId: number; userName: string; scope: GrantScope; targetId: number; targetName: string | null }
export interface PasswordPolicy { minLength: number; requireComplexity: boolean; expiryDays: number; maxFailedAttempts: number; lockMinutes: number }
export interface AdminSettings { passwordPolicy: PasswordPolicy; internalNetworks: string[] }
