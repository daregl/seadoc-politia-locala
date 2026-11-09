import { Module } from '@nestjs/common';
import { AdminController, MetaController } from './admin.js';
import { ArchiveController, ArchiveService } from './archive.js';
import { AuditService } from './audit.js';
import { AuthController, AuthGuard, AuthService } from './auth.js';
import { CasesController, CasesService, DispatchController, TemplatesController } from './cases.js';
import { Db } from './db.js';
import { DocumentErpController, ErpController, ErpService } from './erp.js';
import { LdapController, LdapSyncService } from './ldap.js';
import { LdapClient } from './ldap-client.js';
import { MigrationController } from './migration.js';
import { OidcController, OidcService } from './oidc.js';
import { DocumentsController, DocumentsService } from './documents.js';
import { PreviewController, PreviewService } from './preview.js';
import { PdfSignaturesController, QualifiedSignService, SigningController } from './qualified-sign.js';
import { GdprRequestsController, GdprRequestService } from './gdpr-requests.js';
import { ApiTokensController, IntranetController } from './intranet.js';
import { MailAdminController, MailWorker } from './mail.js';
import { ImapImporter, InboxController, InboxService } from './mail-inbox.js';
import { NotificationController, NotificationService } from './notifications.js';
import { OcrService } from './ocr.js';
import { AuditController, GdprController, ReportsController } from './reports.js';
import { StorageService } from './storage.js';
import { WorkflowEngine } from './workflow-engine.js';
import { DashboardController, DocumentWorkflowController, TasksController, WorkflowsController } from './workflows.js';

@Module({
  controllers: [
    AuthController,
    OidcController,
    LdapController,
    ErpController,
    DocumentErpController,
    MigrationController,
    DocumentsController,
    PdfSignaturesController,
    SigningController,
    PreviewController,
    NotificationController,
    MailAdminController,
    InboxController,
    GdprRequestsController,
    AdminController,
    MetaController,
    ArchiveController,
    AuditController,
    GdprController,
    ReportsController,
    WorkflowsController,
    TasksController,
    DashboardController,
    DocumentWorkflowController,
    CasesController,
    DispatchController,
    TemplatesController,
    IntranetController,
    ApiTokensController,
  ],
  providers: [
    Db,
    AuditService,
    LdapClient,
    LdapSyncService,
    OidcService,
    ErpService,
    AuthService,
    AuthGuard,
    StorageService,
    OcrService,
    NotificationService,
    MailWorker,
    ImapImporter,
    InboxService,
    GdprRequestService,
    DocumentsService,
    QualifiedSignService,
    PreviewService,
    ArchiveService,
    WorkflowEngine,
    CasesService,
  ],
})
export class AppModule {}
