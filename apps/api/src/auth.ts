import { Body, CanActivate, Controller, createParamDecorator, ExecutionContext, Get, HttpCode, Injectable, Optional, Post, Req, Res, SetMetadata, UseGuards } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import crypto from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import * as OTPAuth from 'otpauth';
import QRCode from 'qrcode';
import { AuditService } from './audit.js';
import { config } from './config.js';
import { Db } from './db.js';
import { badRequest, fail, forbidden } from './http.js';
import { LdapClient, LdapUnavailableError } from './ldap-client.js';
import { can, CurrentUser, Permission, permissionsOf } from './perms.js';

export const COOKIE = 'seadoc_session';
export const Public = () => SetMetadata('public', true);
export const AllowPartial = () => SetMetadata('allowPartial', true);
export const RequirePerm = (...perms: Permission[]) => SetMetadata('perms', perms);
export const User = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().user as CurrentUser);

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split('$');
  // Conturile externe (LDAP, OIDC) nu au parolă locală: nicio parolă nu li se potrivește aici.
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'hex'), 64, { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return crypto.timingSafeEqual(actual, expected);
}
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

export interface PasswordPolicy { minLength: number; requireComplexity: boolean; expiryDays: number; maxFailedAttempts: number; lockMinutes: number }

export function passwordProblem(password: string, policy: PasswordPolicy): string | null {
  if (password.length < policy.minLength) return `Parola trebuie să aibă cel puțin ${policy.minLength} caractere`;
  if (policy.requireComplexity && !(/[a-z]/.test(password) && /[A-Z]/.test(password) && /\d/.test(password) && /[^A-Za-z0-9]/.test(password))) {
    return 'Parola trebuie să conțină litere mici, litere mari, cifre și un caracter special';
  }
  return null;
}

@Injectable()
export class AuthService {
  constructor(private readonly db: Db, private readonly audit: AuditService, @Optional() private readonly ldap?: LdapClient) {}

  /** Confirmarea parolei unui cont autentificat (de exemplu la semnare), oricare ar fi sursa contului. */
  async confirmPassword(user: { username: string; auth_source: string; password_hash: string }, password: string): Promise<boolean> {
    if (user.auth_source === 'local') return verifyPassword(password, user.password_hash);
    if (user.auth_source !== 'ldap') fail(409, 'Contul folosește doar autentificarea unică și nu are o parolă de confirmare.');
    try {
      return (await this.ldap?.verifyPassword(user.username, password)) ?? false;
    } catch (err) {
      if (err instanceof LdapUnavailableError) fail(503, 'Serviciul de autentificare centralizată nu este disponibil. Încercați din nou.');
      throw err;
    }
  }

  async policy(): Promise<PasswordPolicy> {
    return (await this.db.one(`SELECT value FROM settings WHERE key = 'password_policy'`))!.value;
  }

  async isRemote(ip: string): Promise<boolean> {
    const nets: string[] = (await this.db.one(`SELECT value FROM settings WHERE key = 'internal_networks'`))!.value;
    const list = new BlockList();
    for (const net of nets) {
      const [addr, prefix] = net.split('/');
      const family = isIP(addr) === 6 ? 'ipv6' : 'ipv4';
      list.addSubnet(addr, Number(prefix), family);
    }
    const clean = ip.replace(/^::ffff:/, '');
    const family = isIP(clean);
    if (!family) return true;
    return !list.check(clean, family === 6 ? 'ipv6' : 'ipv4');
  }

  async loadUser(id: number, ip: string): Promise<CurrentUser | null> {
    const u = await this.db.one(
      `SELECT u.*, d.name AS department_name FROM users u LEFT JOIN departments d ON d.id = u.department_id WHERE u.id = $1 AND u.active`, [id]);
    if (!u) return null;
    const overrides = (await this.db.query('SELECT permission, allowed FROM user_permissions WHERE user_id = $1', [id])).rows;
    const policy = await this.policy();
    const ageMs = Date.now() - new Date(u.password_changed_at).getTime();
    // Parola conturilor externe se administrează în director, nu aici.
    const expired = u.auth_source === 'local' && policy.expiryDays > 0 && ageMs > policy.expiryDays * 86_400_000;
    return {
      id: u.id, username: u.username, fullName: u.full_name, role: u.role,
      departmentId: u.department_id, departmentName: u.department_name, jobTitle: u.job_title,
      hasToken: u.has_token, mfaEnabled: u.mfa_enabled, mustChangePassword: u.auth_source === 'local' && (u.must_change_password || expired),
      authSource: u.auth_source,
      overrides: Object.fromEntries(overrides.map((o) => [o.permission, o.allowed])), ip,
    };
  }

  async createSession(userId: number, mfaRequired: boolean, ip: string, res: Response) {
    const token = crypto.randomBytes(32).toString('base64url');
    await this.db.query(
      `INSERT INTO sessions (token_hash, user_id, mfa_required, mfa_ok, ip, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6))`,
      [sha(token), userId, mfaRequired, !mfaRequired, ip, config.sessionHours]);
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: config.cookieSecure, path: '/', maxAge: config.sessionHours * 3_600_000 });
  }

  async registerFailure(user: { id: number; failed_attempts: number }, policy: PasswordPolicy) {
    const attempts = user.failed_attempts + 1;
    const lock = attempts >= policy.maxFailedAttempts;
    await this.db.query(
      `UPDATE users SET failed_attempts = $2, locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) ELSE locked_until END WHERE id = $1`,
      [user.id, lock ? 0 : attempts, lock, policy.lockMinutes]);
    return lock;
  }
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly db: Db, private readonly auth: AuthService, private readonly reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>('public', targets)) return true;
    const req = ctx.switchToHttp().getRequest<Request & { user?: CurrentUser; session_row?: any }>();
    const token = req.cookies?.[COOKIE];
    if (!token) fail(401, 'Autentificare necesară');
    const session = await this.db.one('SELECT * FROM sessions WHERE token_hash = $1 AND expires_at > now()', [sha(token)]);
    if (!session) fail(401, 'Sesiune expirată');
    const user = await this.auth.loadUser(session.user_id, req.ip ?? '');
    if (!user) fail(401, 'Cont inactiv');
    req.user = user!;
    req.session_row = session;
    const partialAllowed = this.reflector.getAllAndOverride<boolean>('allowPartial', targets);
    if (!partialAllowed) {
      if (session.mfa_required && !session.mfa_ok) fail(401, 'Este necesară verificarea MFA');
      if (user!.mustChangePassword) fail(403, 'Parola trebuie schimbată');
    }
    const perms = this.reflector.getAllAndOverride<Permission[]>('perms', targets) ?? [];
    if (perms.length && !perms.some((p) => can(user!, p))) forbidden();
    return true;
  }
}

@Controller('auth')
@UseGuards(AuthGuard)
export class AuthController {
  constructor(private readonly db: Db, private readonly auth: AuthService, private readonly audit: AuditService, @Optional() private readonly ldap?: LdapClient) {}

  private async loginState(userId: number, session: { mfa_required: boolean; mfa_ok: boolean }, ip: string) {
    const user = await this.auth.loadUser(userId, ip);
    if (session.mfa_required && !session.mfa_ok) {
      return { state: user!.mfaEnabled ? 'mfa' : 'mfa_enrol' };
    }
    return { state: user!.mustChangePassword ? 'change_password' : 'ok', user: this.publicUser(user!) };
  }

  private publicUser(u: CurrentUser) {
    const { overrides: _o, ip: _i, ...rest } = u;
    return { ...rest, permissions: permissionsOf(u) };
  }

  @Public() @Post('login') @HttpCode(200)
  async login(@Body() body: { username?: string; password?: string }, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const username = String(body.username ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    const ip = req.ip ?? '';
    const policy = await this.auth.policy();
    const u = await this.db.one('SELECT * FROM users WHERE lower(username) = $1 AND active', [username]);
    // Conturile LDAP trec tot prin scrypt, pe hash-ul fictiv, ca durata să nu deosebească sursa contului.
    const local = !u || u.auth_source === 'local';
    let valid = verifyPassword(password, local ? u?.password_hash ?? DUMMY_HASH : DUMMY_HASH) && local;
    if (u?.locked_until && new Date(u.locked_until) > new Date()) {
      await this.audit.log({ id: u.id, username: u.username, ip }, { action: 'auth.login_blocat' });
      fail(423, 'Cont blocat temporar după încercări eșuate. Încercați mai târziu.');
    }
    // Directorul se întreabă abia după verificarea blocării, ca aici să nu se poată bloca și contul din AD.
    if (u?.auth_source === 'ldap') {
      try {
        valid = (await this.ldap?.verifyPassword(u.username, password)) ?? false;
      } catch (err) {
        if (!(err instanceof LdapUnavailableError)) throw err;
        // O pană a directorului nu este o încercare eșuată: nu contează la blocarea contului.
        await this.audit.log({ id: u.id, username: u.username, ip }, { action: 'auth.ldap_indisponibil' });
        fail(503, 'Serviciul de autentificare centralizată nu este disponibil. Încercați din nou.');
      }
    }
    if (!u || !valid) {
      if (u) {
        const locked = await this.auth.registerFailure(u, policy);
        await this.audit.log({ id: u.id, username: u.username, ip }, { action: locked ? 'auth.cont_blocat' : 'auth.login_esuat' });
      }
      fail(401, 'Utilizator sau parolă incorecte');
    }
    await this.db.query('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [u.id]);
    const mfaRequired = u.mfa_enabled || (await this.auth.isRemote(ip));
    await this.auth.createSession(u.id, mfaRequired, ip, res);
    if (!mfaRequired) await this.audit.log({ id: u.id, username: u.username, ip }, { action: 'auth.login' });
    return this.loginState(u.id, { mfa_required: mfaRequired, mfa_ok: !mfaRequired }, ip);
  }

  @Post('mfa/verify') @AllowPartial() @HttpCode(200)
  async verifyMfa(@Body() body: { code?: string }, @Req() req: any, @User() user: CurrentUser) {
    const u = await this.db.one('SELECT * FROM users WHERE id = $1', [user.id]);
    if (!u.totp_secret) badRequest('MFA nu este configurat');
    const policy = await this.auth.policy();
    if (u.locked_until && new Date(u.locked_until) > new Date()) fail(423, 'Cont blocat temporar');
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(u.totp_secret), digits: 6, period: 30 });
    const delta = totp.validate({ token: String(body.code ?? ''), window: 1 });
    const counter = delta === null ? null : Math.floor(Date.now() / 30_000) + delta;
    // Un cod deja folosit nu mai este acceptat; condiția din UPDATE acoperă și două cereri simultane cu același cod.
    const claimed = counter !== null && (await this.db.query(
      `UPDATE users SET mfa_enabled = true, last_totp_counter = $2, failed_attempts = 0
       WHERE id = $1 AND (last_totp_counter IS NULL OR last_totp_counter < $2)`, [u.id, counter])).rowCount === 1;
    if (!claimed) {
      await this.auth.registerFailure(u, policy);
      await this.audit.log(user, { action: 'auth.mfa_esuat' });
      fail(401, 'Cod incorect');
    }
    await this.db.query('UPDATE sessions SET mfa_ok = true, mfa_required = true WHERE token_hash = $1', [req.session_row.token_hash]);
    await this.audit.log(user, { action: 'auth.login', details: { mfa: true } });
    return this.loginState(u.id, { mfa_required: true, mfa_ok: true }, user.ip);
  }

  @Post('mfa/enrol') @AllowPartial() @HttpCode(200)
  async enrol(@User() user: CurrentUser) {
    // Un cont cu MFA activ nu își poate înlocui secretul de aici.
    if (user.mfaEnabled) fail(409, 'MFA este deja configurat');
    const secret = new OTPAuth.Secret({ size: 20 });
    await this.db.query('UPDATE users SET totp_secret = $2 WHERE id = $1', [user.id, secret.base32]);
    const totp = new OTPAuth.TOTP({ issuer: 'SeaDoc', label: user.username, secret, digits: 6, period: 30 });
    await this.audit.log(user, { action: 'auth.mfa_inrolare' });
    return { secret: secret.base32, uri: totp.toString(), qr: await QRCode.toDataURL(totp.toString()) };
  }

  @Post('logout') @AllowPartial() @HttpCode(200)
  async logout(@Req() req: any, @User() user: CurrentUser, @Res({ passthrough: true }) res: Response) {
    await this.db.query('DELETE FROM sessions WHERE token_hash = $1', [req.session_row.token_hash]);
    await this.audit.log(user, { action: 'auth.logout' });
    res.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  }

  @Get('me') @AllowPartial()
  async me(@Req() req: any, @User() user: CurrentUser) {
    return this.loginState(user.id, req.session_row, user.ip);
  }

  @Post('password') @AllowPartial() @HttpCode(200)
  async changePassword(@Body() body: { current?: string; next?: string }, @Req() req: any, @User() user: CurrentUser) {
    if (req.session_row.mfa_required && !req.session_row.mfa_ok) fail(401, 'Este necesară verificarea MFA');
    const u = await this.db.one('SELECT password_hash, auth_source FROM users WHERE id = $1', [user.id]);
    if (u.auth_source !== 'local') fail(409, 'Parola acestui cont se administrează în directorul organizației, nu în SeaDoc.');
    if (!verifyPassword(String(body.current ?? ''), u.password_hash)) fail(401, 'Parola curentă este incorectă');
    const next = String(body.next ?? '');
    const problem = passwordProblem(next, await this.auth.policy());
    if (problem) badRequest(problem);
    await this.db.query('UPDATE users SET password_hash = $2, password_changed_at = now(), must_change_password = false WHERE id = $1', [user.id, hashPassword(next)]);
    await this.audit.log(user, { action: 'auth.parola_schimbata' });
    return this.loginState(user.id, req.session_row, user.ip);
  }
}

export function checkPassword(password: string, stored: string) {
  return verifyPassword(password, stored);
}
