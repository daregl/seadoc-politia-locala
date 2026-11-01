import type { Direction, DocStatus, OcrStatus, Permission, Role, TaskKind, TaskStatus } from './types';

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Administrator',
  manager: 'Manager departament',
  user: 'Utilizator',
  registratura: 'Registratură',
  arhivar: 'Arhivar',
};
export const roleLabel = (role: string): string => ROLE_LABELS[role as Role] ?? role;

export const PERMISSION_LABELS: Record<Permission, string> = {
  register: 'Înregistrare documente',
  approve: 'Avizare și aprobare',
  sign_qualified: 'Semnătură cu certificat (token)',
  workflow_edit: 'Editare fluxuri',
  archive: 'Arhivă',
  users_admin: 'Administrare utilizatori',
  audit_all: 'Audit complet',
  reports: 'Rapoarte',
  archive_journal: 'Jurnal arhivă',
};

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export const DOC_STATUS: Record<DocStatus, { label: string; tone: Tone }> = {
  inregistrat: { label: 'Înregistrat', tone: 'neutral' },
  in_flux: { label: 'În flux', tone: 'info' },
  aprobat: { label: 'Aprobat', tone: 'success' },
  respins: { label: 'Respins', tone: 'danger' },
  arhivat: { label: 'Arhivat', tone: 'neutral' },
  eliminat: { label: 'Eliminat', tone: 'warning' },
};
export const DIRECTION_LABELS: Record<Direction, string> = { intrat: 'Intrare', iesit: 'Ieșire', intern: 'Intern' };

export const OCR_STATUS: Record<OcrStatus, { label: string; tone: Tone }> = {
  in_asteptare: { label: 'OCR în așteptare', tone: 'info' },
  in_lucru: { label: 'OCR în lucru', tone: 'info' },
  finalizat: { label: 'Text extras', tone: 'success' },
  esuat: { label: 'Extragere eșuată', tone: 'danger' },
  neaplicabil: { label: 'OCR neaplicabil', tone: 'neutral' },
};

export const TASK_KIND: Record<TaskKind, string> = {
  avizare: 'Avizare',
  aprobare: 'Aprobare',
  semnare: 'Semnare',
  informare: 'Informare',
  completare: 'Completare',
};
export const TASK_STATUS: Record<TaskStatus, { label: string; tone: Tone }> = {
  deschisa: { label: 'Deschisă', tone: 'info' },
  asteapta_completare: { label: 'Așteaptă completare', tone: 'warning' },
  finalizata: { label: 'Finalizată', tone: 'success' },
  respinsa: { label: 'Respinsă', tone: 'danger' },
  redirectionata: { label: 'Redirecționată', tone: 'neutral' },
  anulata: { label: 'Anulată', tone: 'neutral' },
};
export const APPROVE_LABEL: Record<TaskKind, string> = {
  avizare: 'Avizează',
  aprobare: 'Aprobă',
  semnare: 'Semnează',
  informare: 'Am luat la cunoștință',
  completare: 'Completare finalizată',
};

export const LINK_KIND: Record<string, string> = { raspuns_la: 'Răspuns la', anexa_la: 'Anexă la' };
export const DUPLICATE_KIND: Record<string, string> = {
  amprenta: 'fișier identic',
  text: 'text similar',
  denumire: 'denumire similară',
};
export const INSTANCE_STATUS: Record<string, { label: string; tone: Tone }> = {
  activ: { label: 'În derulare', tone: 'info' },
  aprobat: { label: 'Aprobat', tone: 'success' },
  respins: { label: 'Respins', tone: 'danger' },
};
export const PROPOSAL_STATUS: Record<string, { label: string; tone: Tone }> = {
  propusa: { label: 'Propunere în așteptare', tone: 'warning' },
  aprobata: { label: 'Eliminare aprobată', tone: 'neutral' },
  respinsa: { label: 'Propunere respinsă', tone: 'info' },
};

export const AUDIT_ACTIONS: Record<string, string> = {
  'auth.login': 'Autentificare reușită',
  'auth.login_esuat': 'Autentificare eșuată',
  'auth.login_blocat': 'Autentificare refuzată: cont blocat',
  'auth.cont_blocat': 'Cont blocat după încercări eșuate',
  'auth.mfa_esuat': 'Cod MFA incorect',
  'auth.mfa_inrolare': 'Configurare MFA',
  'auth.logout': 'Deconectare',
  'auth.parola_schimbata': 'Parolă schimbată',
  cautare: 'Căutare în documente',
  'document.inregistrat': 'Document înregistrat',
  'document.versiune_noua': 'Versiune nouă încărcată',
  'document.vizualizare': 'Fișă document consultată',
  'document.previzualizare': 'Fișier previzualizat',
  'document.descarcare': 'Fișier descărcat',
  'document.legatura': 'Legătură între documente',
  'document.semnatura_interna': 'Semnătură electronică internă',
  'document.duplicat_detectat': 'Duplicat posibil detectat',
  'document.ocr': 'Recunoaștere OCR finalizată',
  'document.text_extras': 'Text extras din fișier',
  'document.ocr_esuat': 'Extragere text eșuată',
  'registru.export': 'Export registru',
  'flux.publicat': 'Flux publicat',
  'flux.pornit': 'Flux pornit',
  'flux.aprobat': 'Flux încheiat: aprobat',
  'flux.respins': 'Flux încheiat: respins',
  'flux.blocat': 'Flux blocat',
  'flux.termen_apropiat': 'Termen apropiat',
  'flux.termen_depasit': 'Termen depășit',
  'flux.titular_lipsa': 'Pas fără titular',
  'sarcina.creata': 'Sarcină creată',
  'sarcina.aprobata': 'Sarcină finalizată',
  'sarcina.respinsa': 'Sarcină respinsă',
  'sarcina.redirectionata': 'Sarcină redirecționată',
  'sarcina.completare_ceruta': 'Informații cerute',
  'sarcina.completare_finalizata': 'Completare finalizată',
  'sarcina.semnare_esuata': 'Semnare eșuată: parolă incorectă',
  'arhiva.arhivare': 'Document arhivat',
  'arhiva.cautare': 'Căutare în arhivă',
  'arhiva.consultare': 'Consultare document arhivat',
  'arhiva.propunere_eliminare': 'Propunere de eliminare',
  'arhiva.propunere_respinsa': 'Propunere de eliminare respinsă',
  'arhiva.eliminare': 'Document eliminat',
  'arhiva.stergere_fisier_esuata': 'Ștergere fișier eșuată',
  'gdpr.acces_date_personale': 'Acces la date personale',
  'gdpr.cerere_creata': 'Cerere GDPR înregistrată',
  'gdpr.cerere_modificata': 'Cerere GDPR modificată',
  'gdpr.cerere_consultata': 'Cerere GDPR consultată',
  'gdpr.cerere_cautare': 'Căutare documente pentru cerere GDPR',
  'gdpr.cerere_export': 'Export pentru cerere GDPR',
  'gdpr.cerere_decizie': 'Decizie consemnată pentru cerere GDPR',
  'email.trimis': 'Email trimis',
  'email.esuat': 'Email netrimis',
  'email.retrimitere': 'Email repus în coadă',
  'email.importat': 'Email preluat',
  'email.duplicat': 'Email duplicat ignorat',
  'email.import_esuat': 'Căsuța de email nu poate fi citită',
  'email.atasament_refuzat': 'Atașament de email refuzat',
  'email.atasament_descarcat': 'Atașament de email descărcat',
  'email.vizualizare': 'Email consultat',
  'email.inregistrat': 'Email înregistrat ca document',
  'email.renuntat': 'S-a renunțat la un email',
  'audit.export': 'Export jurnal de audit',
  'admin.utilizator_creat': 'Utilizator creat',
  'admin.utilizator_modificat': 'Utilizator modificat',
  'admin.departament_creat': 'Departament creat',
  'admin.departament_modificat': 'Departament modificat',
  'admin.tip_document_creat': 'Tip de document creat',
  'admin.tip_document_modificat': 'Tip de document modificat',
  'admin.registru_creat': 'Registru creat',
  'admin.registru_modificat': 'Registru modificat',
  'admin.dosar_creat': 'Dosar creat',
  'admin.acces_acordat': 'Acces acordat',
  'admin.acces_revocat': 'Acces revocat',
  'admin.politica_parole_modificata': 'Politică de parole modificată',
  'admin.retele_interne_modificate': 'Rețele interne modificate',
};
export const auditLabel = (code: string): string => AUDIT_ACTIONS[code] ?? code;
