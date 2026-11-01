import 'reflect-metadata';
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger, LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppModule } from './app.module.js';
import { config } from './config.js';
import { Db } from './db.js';
import { LdapSyncService } from './ldap.js';
import { MailWorker } from './mail.js';
import { ImapImporter } from './mail-inbox.js';
import { OcrService } from './ocr.js';
import { WorkflowEngine } from './workflow-engine.js';

// bpmn-js desenează cu stiluri inline; PDF-urile se previzualizează în iframe/object de pe aceeași origine.
const CSP = [
  `default-src 'self'`,
  `script-src 'self'`,
  `style-src 'self' 'unsafe-inline'`,
  `img-src 'self' data:`,
  `font-src 'self' data:`,
  // Agentul local de semnare ascultă pe calculatorul utilizatorului; vezi apps/agent/README.md.
  `connect-src 'self' ${config.agentOrigin}`,
  `frame-src 'self'`,
  `object-src 'self'`,
  `base-uri 'self'`,
  `form-action 'self'`,
  `frame-ancestors 'self'`,
].join('; ');

const isApiPath = (p: string) => p === '/api' || p.startsWith('/api/');

function securityHeaders(req: Request, res: Response, next: NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', CSP);
  if (isApiPath(req.path)) res.setHeader('Cache-Control', 'no-store');
  next();
}

const STATUS_MESSAGES: Partial<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: 'Cerere invalidă',
  [HttpStatus.UNAUTHORIZED]: 'Autentificare necesară',
  [HttpStatus.FORBIDDEN]: 'Nu aveți drepturi pentru această acțiune',
  [HttpStatus.NOT_FOUND]: 'Resursa nu a fost găsită',
  [HttpStatus.METHOD_NOT_ALLOWED]: 'Metodă nepermisă',
  [HttpStatus.CONFLICT]: 'Operația este în conflict cu starea curentă',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'Conținutul trimis depășește dimensiunea maximă permisă',
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: 'Tip de conținut neacceptat',
  [HttpStatus.INTERNAL_SERVER_ERROR]: 'A apărut o eroare internă',
};

/** Coduri PostgreSQL care descriu o cerere greșită, nu o defecțiune a serverului. */
function fromPostgres(err: { code?: unknown; message?: string }): { status: number; message: string } | null {
  switch (err.code) {
    // Mesajele declanșatoarelor din migrații sunt deja în română.
    case 'P0001': return { status: HttpStatus.CONFLICT, message: err.message ?? STATUS_MESSAGES[HttpStatus.CONFLICT]! };
    case '23505': return { status: HttpStatus.CONFLICT, message: 'Există deja o înregistrare cu aceste date' };
    case '23503': return { status: HttpStatus.BAD_REQUEST, message: 'Referință către o înregistrare inexistentă' };
    case '22P02': case '22007': case '22008': case '22003': return { status: HttpStatus.BAD_REQUEST, message: 'Valoare invalidă în cerere' };
    default: return null;
  }
}

/** Toate erorile au forma `{ message }` cu text în română, inclusiv cele generate de Nest, Multer și body-parser. */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly log = new Logger('API');

  catch(err: any, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (res.headersSent) {
      this.log.error(err?.stack ?? String(err));
      res.destroy();
      return;
    }
    let status: number;
    let body: Record<string, unknown>;
    let known: ReturnType<typeof fromPostgres>;
    if (err instanceof HttpException) {
      status = err.getStatus();
      const response = err.getResponse();
      // Mesajele noastre vin fără `statusCode`; cele cu `statusCode` sunt textele în engleză ale cadrului.
      if (typeof response === 'object' && !('statusCode' in response)) body = response as Record<string, unknown>;
      else body = { message: STATUS_MESSAGES[status] ?? 'Cererea nu a putut fi procesată' };
    } else if ((known = fromPostgres(err))) {
      status = known.status;
      body = { message: known.message };
    } else if (Number.isInteger(err?.status) && err.status >= 400 && err.status < 500) {
      // Erorile body-parser: JSON invalid sau peste limită.
      status = err.status;
      body = { message: STATUS_MESSAGES[status] ?? 'Cererea nu a putut fi procesată' };
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      body = { message: STATUS_MESSAGES[status]! };
    }
    if (status >= 500) this.log.error(err?.stack ?? String(err));
    if (status === HttpStatus.PAYLOAD_TOO_LARGE && host.switchToHttp().getRequest<Request>().is('multipart/form-data')) {
      body = { message: `Fișierul depășește dimensiunea maximă permisă de ${Math.round(config.maxUploadBytes / (1024 * 1024))} MB` };
    }
    res.status(status).json(body);
  }
}

/** Aplicația complet configurată și inițializată, fără să asculte pe rețea și fără lucrări de fundal. */
export async function createApp(options: { logger?: LogLevel[] | false } = {}): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false, logger: options.logger ?? ['error', 'warn', 'log'] });
  await app.get(Db).migrate();
  app.setGlobalPrefix('api');
  app.set('trust proxy', config.trustProxy);
  app.use(securityHeaders);
  app.use(cookieParser());
  app.useBodyParser('json', { limit: '5mb' });
  // Express 5 lasă req.body nedefinit pentru cererile fără conținut.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.body ??= {};
    next();
  });
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableShutdownHooks();

  const { webDist } = config;
  const spa = fs.existsSync(path.join(webDist, 'index.html'));
  if (spa) app.useStaticAssets(webDist);
  // Rutele SPA primesc index.html; căile cu extensie sunt fișiere care chiar lipsesc.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (isApiPath(req.path)) return next();
    if (spa && (req.method === 'GET' || req.method === 'HEAD') && !path.extname(req.path)) return res.sendFile('index.html', { root: webDist });
    res.status(HttpStatus.NOT_FOUND).json({ message: STATUS_MESSAGES[HttpStatus.NOT_FOUND] });
  });
  await app.init();
  return app;
}

async function main() {
  const app = await createApp();
  app.get(OcrService).start();
  app.get(WorkflowEngine).startScheduler();
  app.get(LdapSyncService).startInterval();
  app.get(MailWorker).start();
  app.get(ImapImporter).start();
  await app.listen(config.port, config.host);
  new Logger('SeaDoc').log(`Pornit pe http://${config.host}:${config.port}`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
