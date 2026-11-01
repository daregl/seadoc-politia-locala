// Autentificare unică prin OpenID Connect: cod de autorizare cu PKCE, state, nonce și semnătura ID token-ului verificată prin JWKS.
import { Controller, Get, Injectable, Logger, OnModuleInit, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import crypto from 'node:crypto';
import * as oidc from 'openid-client';
import { AuditService } from './audit.js';
import { AuthGuard, AuthService, Public } from './auth.js';
import { Db } from './db.js';
import { NO_LOCAL_PASSWORD } from './ldap-client.js';

const BROWSER_COOKIE = 'seadoc_oidc';
const COOKIE_PATH = '/api/auth/oidc';
const STATE_MINUTES = 10;
const USERNAME = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const DEFAULT_MFA_AMR = ['mfa', 'otp', 'hwk', 'mca', 'http://schemas.microsoft.com/claims/multipleauthn'];
const DEFAULT_MFA_ACR = ['http://schemas.openid.net/pape/policies/2007/06/multi-factor'];

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const csv = (value: string | undefined, fallback: string[]) => (value?.trim() ? value.split(',').map((v) => v.trim()).filter(Boolean) : fallback);

export interface OidcConfig {
  issuer: URL;
  clientId: string;
  clientSecret: string;
  redirectUri: URL;
  usernameClaim: string;
  /** Domeniul eliminat din numele de forma `nume@domeniu` (UPN în Entra sau ADFS). */
  usernameDomain: string | null;
  autoCreate: boolean;
  mfaAmr: string[];
  mfaAcr: string[];
  label: string;
}

const isLoopback = (u: URL) => ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);

export function oidcConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OidcConfig | null {
  const { OIDC_ISSUER: issuer, OIDC_CLIENT_ID: clientId, OIDC_CLIENT_SECRET: clientSecret, OIDC_REDIRECT_URI: redirectUri } = env;
  if (!issuer || !clientId || !clientSecret || !redirectUri) return null;
  const issuerUrl = new URL(issuer);
  // HTTP necriptat doar pe aceeași mașină; în rest token-urile și cheile trebuie să vină prin TLS.
  if (issuerUrl.protocol !== 'https:' && !isLoopback(issuerUrl)) throw new Error('OIDC_ISSUER trebuie să folosească https://');
  return {
    issuer: issuerUrl,
    clientId,
    clientSecret,
    redirectUri: new URL(redirectUri),
    usernameClaim: env.OIDC_USERNAME_CLAIM?.trim() || 'preferred_username',
    usernameDomain: env.OIDC_USERNAME_DOMAIN?.trim().toLowerCase() || null,
    autoCreate: env.OIDC_AUTO_CREATE === 'true',
    mfaAmr: csv(env.OIDC_MFA_AMR, DEFAULT_MFA_AMR),
    mfaAcr: csv(env.OIDC_MFA_ACR, DEFAULT_MFA_ACR),
    label: env.OIDC_LABEL?.trim() || 'Autentificare unică (SSO)',
  };
}

/** Furnizorul a confirmat autentificarea cu mai mulți factori doar dacă ID token-ul o spune explicit. */
export function claimsProveMfa(claims: { amr?: unknown; acr?: unknown }, cfg: Pick<OidcConfig, 'mfaAmr' | 'mfaAcr'>): boolean {
  const amr = Array.isArray(claims.amr) ? claims.amr.map(String) : [];
  if (amr.some((v) => cfg.mfaAmr.includes(v))) return true;
  return typeof claims.acr === 'string' && cfg.mfaAcr.includes(claims.acr);
}

@Injectable()
export class OidcService implements OnModuleInit {
  private readonly log = new Logger('OIDC');
  readonly config = oidcConfigFromEnv();
  private discovered: Promise<oidc.Configuration> | null = null;

  onModuleInit() {
    if (this.config && this.config.redirectUri.protocol !== 'https:' && !isLoopback(this.config.redirectUri)) {
      this.log.warn('OIDC_REDIRECT_URI nu folosește https://: codul de autorizare circulă necriptat.');
    }
  }

  /** Descoperirea se face la prima folosire, ca un furnizor oprit să nu împiedice pornirea aplicației. */
  server(): Promise<oidc.Configuration> {
    const cfg = this.config!;
    this.discovered ??= oidc.discovery(cfg.issuer, cfg.clientId, cfg.clientSecret, undefined, {
      execute: [
        ...(cfg.issuer.protocol === 'http:' ? [oidc.allowInsecureRequests] : []),
        // Fără această opțiune biblioteca nu verifică semnătura ID token-ului primit direct de la furnizor.
        oidc.enableNonRepudiationChecks,
      ],
    }).catch((err) => {
      this.discovered = null;
      throw err;
    });
    return this.discovered;
  }
}

class Refused extends Error {}

@Controller('auth')
@UseGuards(AuthGuard)
export class OidcController {
  private readonly log = new Logger('OIDC');

  constructor(private readonly db: Db, private readonly auth: AuthService, private readonly audit: AuditService, private readonly service: OidcService) {}

  /** Ce arată pagina de autentificare. Nu expune nimic din configurație în afara butonului. */
  @Public() @Get('sso')
  sso() {
    return { oidc: !!this.service.config, label: this.service.config?.label ?? null };
  }

  @Public() @Get('oidc/start')
  async start(@Query('returnTo') returnTo: string | undefined, @Res() res: Response) {
    const cfg = this.service.config;
    if (!cfg) return res.status(404).json({ message: 'Autentificarea unică nu este configurată' });
    let server: oidc.Configuration;
    try {
      server = await this.service.server();
    } catch (err) {
      this.log.error(`Descoperirea furnizorului a eșuat: ${(err as Error).message}`);
      return res.redirect(302, '/autentificare?sso=indisponibil');
    }
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const verifier = oidc.randomPKCECodeVerifier();
    const browser = crypto.randomBytes(32).toString('base64url');
    // Doar căi locale: altfel adresa de revenire ar deveni o redirecționare deschisă.
    const target = typeof returnTo === 'string' && /^\/[^/\\]/.test(returnTo) ? returnTo : null;
    await this.db.query('DELETE FROM oidc_login_states WHERE expires_at < now()');
    await this.db.query(
      `INSERT INTO oidc_login_states (state_hash, browser_hash, nonce, code_verifier, return_to, expires_at)
       VALUES ($1,$2,$3,$4,$5, now() + make_interval(mins => $6))`, [sha(state), sha(browser), nonce, verifier, target, STATE_MINUTES]);
    // SameSite=Lax: revenirea de la furnizor este o navigare din alt site.
    res.cookie(BROWSER_COOKIE, browser, {
      httpOnly: true, sameSite: 'lax', secure: cfg.redirectUri.protocol === 'https:', path: COOKIE_PATH, maxAge: STATE_MINUTES * 60_000,
    });
    const url = oidc.buildAuthorizationUrl(server, {
      redirect_uri: cfg.redirectUri.href,
      scope: 'openid profile email',
      state,
      nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
    });
    return res.redirect(302, url.href);
  }

  @Public() @Get('oidc/callback')
  async callback(@Req() req: Request, @Res() res: Response) {
    const cfg = this.service.config;
    if (!cfg) return res.status(404).json({ message: 'Autentificarea unică nu este configurată' });
    const ip = req.ip ?? '';
    const finish = (code: string) => {
      res.clearCookie(BROWSER_COOKIE, { path: COOKIE_PATH });
      return res.redirect(302, `/autentificare?sso=${code}`);
    };
    const query = new URLSearchParams(req.url.split('?')[1] ?? '');
    const state = query.get('state') ?? '';
    // DELETE … RETURNING: o stare se consumă o singură dată, indiferent de rezultat.
    const row = state ? await this.db.one(
      'DELETE FROM oidc_login_states WHERE state_hash = $1 AND expires_at > now() RETURNING *', [sha(state)]) : undefined;
    const refuse = async (reason: string, details: Record<string, unknown> = {}, code = 'eroare') => {
      await this.audit.log({ id: null as unknown as number, username: 'sso', ip }, { action: 'auth.oidc_esuat', details: { motiv: reason, ...details } });
      return finish(code);
    };
    // Adresa este publică: o stare necunoscută nu scrie în jurnal, ca oricine să nu îl poată umple.
    if (!row) {
      this.log.warn(`Stare OIDC necunoscută sau deja folosită, de la ${ip}`);
      return finish('eroare');
    }
    const browser = sha(String(req.cookies?.[BROWSER_COOKIE] ?? ''));
    if (!crypto.timingSafeEqual(Buffer.from(browser), Buffer.from(row.browser_hash))) return refuse('browser_diferit');
    if (query.has('error')) return refuse('furnizor', { eroare: String(query.get('error')).slice(0, 100) }, 'refuzat');

    let claims: Record<string, unknown>;
    try {
      const server = await this.service.server();
      // Adresa se construiește din configurație, nu din antetele cererii, care pot fi rescrise de un proxy.
      const current = new URL(cfg.redirectUri);
      current.search = query.toString();
      const tokens = await oidc.authorizationCodeGrant(server, current, {
        pkceCodeVerifier: row.code_verifier, expectedState: state, expectedNonce: row.nonce, idTokenExpected: true,
      });
      claims = (tokens.claims() ?? {}) as Record<string, unknown>;
    } catch (err) {
      const e = err as { code?: string; message?: string };
      this.log.warn(`Răspuns respins de la furnizor: ${e.code ?? ''} ${e.message ?? ''}`);
      return refuse('token_invalid', { cod: e.code ?? null, detalii: String(e.message ?? '').slice(0, 200) });
    }

    let user: any;
    try {
      user = await this.resolveUser(cfg, claims, ip);
    } catch (err) {
      if (err instanceof Refused) return refuse(err.message, { sub: String(claims.sub ?? '').slice(0, 200) }, err.message === 'cont_blocat' ? 'blocat' : 'necunoscut');
      throw err;
    }

    const proven = claimsProveMfa(claims, cfg);
    // Regulile MFA ale aplicației rămân; doar o confirmare explicită de la furnizor le poate satisface.
    const mfaRequired = !proven && (user.mfa_enabled || (await this.auth.isRemote(ip)));
    await this.auth.createSession(user.id, mfaRequired, ip, res);
    if (!mfaRequired) await this.audit.log({ id: user.id, username: user.username, ip }, { action: 'auth.login', details: { sso: 'oidc', mfaFurnizor: proven } });
    res.clearCookie(BROWSER_COOKIE, { path: COOKIE_PATH });
    return res.redirect(302, row.return_to ?? '/panou');
  }

  private usernameFrom(cfg: OidcConfig, claims: Record<string, unknown>): string | null {
    const raw = claims[cfg.usernameClaim];
    if (typeof raw !== 'string' || !raw.trim()) return null;
    const name = raw.trim().toLowerCase();
    if (cfg.usernameDomain && name.endsWith(`@${cfg.usernameDomain}`)) return name.slice(0, -(cfg.usernameDomain.length + 1));
    return name;
  }

  /** Contul se leagă de furnizor la prima autentificare; apoi contează identificatorul stabil `sub`, nu numele. */
  private async resolveUser(cfg: OidcConfig, claims: Record<string, unknown>, ip: string) {
    const issuer = cfg.issuer.href;
    const subject = typeof claims.sub === 'string' ? claims.sub : '';
    if (!subject) throw new Refused('fara_subiect');
    let user = await this.db.one('SELECT * FROM users WHERE oidc_issuer = $1 AND oidc_subject = $2', [issuer, subject]);
    if (!user) {
      const username = this.usernameFrom(cfg, claims);
      if (username) user = await this.db.one('SELECT * FROM users WHERE lower(username) = $1', [username]);
      // Adresa de email contează doar dacă furnizorul a verificat-o.
      if (!user && claims.email_verified === true && typeof claims.email === 'string') {
        const matches = (await this.db.query('SELECT * FROM users WHERE lower(email) = lower($1)', [claims.email])).rows;
        if (matches.length > 1) throw new Refused('email_ambiguu');
        user = matches[0];
      }
      if (!user) {
        if (!cfg.autoCreate) throw new Refused('cont_necunoscut');
        if (!username || !USERNAME.test(username)) throw new Refused('nume_invalid');
        user = (await this.db.one(
          `INSERT INTO users (username, full_name, email, password_hash, role, auth_source, oidc_issuer, oidc_subject)
           VALUES ($1,$2,$3,$4,'user','oidc',$5,$6) RETURNING *`,
          [username, String(claims.name ?? username), claims.email_verified === true ? claims.email : null, NO_LOCAL_PASSWORD, issuer, subject]))!;
        await this.audit.log({ id: user.id, username: user.username, ip }, { action: 'auth.oidc_cont_creat' });
        return user;
      }
      // Administratorul local este contul de urgență: nu se poate intra în el prin furnizorul extern.
      if (user.auth_source === 'local' && user.role === 'admin') throw new Refused('administrator_local');
      if (user.oidc_subject && (user.oidc_subject !== subject || user.oidc_issuer !== issuer)) throw new Refused('subiect_diferit');
      await this.db.query('UPDATE users SET oidc_issuer = $2, oidc_subject = $3 WHERE id = $1', [user.id, issuer, subject]);
    }
    if (!user.active) throw new Refused('cont_inactiv');
    if (user.locked_until && new Date(user.locked_until) > new Date()) throw new Refused('cont_blocat');
    return user;
  }
}
