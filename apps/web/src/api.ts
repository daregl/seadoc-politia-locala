// Client HTTP: un singur loc pentru sesiune, erori și mesaje în română.

export class ApiError extends Error {
  readonly status: number;
  readonly errors: string[];
  constructor(status: number, message: string, errors: string[] = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.errors = errors;
  }
}

type AuthListener = (reason: 'session' | 'password') => void;
let authListener: AuthListener | null = null;
export function onAuthLost(fn: AuthListener | null) { authListener = fn; }

const FALLBACK: Record<number, string> = {
  400: 'Datele trimise nu sunt valide.',
  401: 'Sesiunea a expirat. Autentificați-vă din nou.',
  403: 'Nu aveți drepturi pentru această acțiune.',
  404: 'Resursa cerută nu a fost găsită.',
  409: 'Acțiunea intră în conflict cu starea curentă. Reîncărcați pagina.',
  410: 'Resursa nu mai este disponibilă.',
  413: 'Fișierul depășește dimensiunea maximă admisă (50 MB).',
  423: 'Contul este blocat temporar.',
  429: 'Prea multe cereri. Încercați din nou peste câteva momente.',
  500: 'A apărut o eroare pe server. Încercați din nou.',
  502: 'Serverul nu este disponibil momentan.',
  503: 'Serverul nu este disponibil momentan.',
  504: 'Serverul nu a răspuns la timp.',
};
const GENERIC = 'A apărut o eroare neașteptată. Încercați din nou.';

// Mesajele implicite ale cadrului HTTP sunt în engleză; nu ajung la utilizator.
const FRAMEWORK_TEXT = /^(Internal server error|Cannot |File too large|Unexpected |Forbidden|Bad Request|Not Found|Unauthorized|Too Many|Payload Too Large|Multipart|Unsupported|Request Entity)/i;

// 401 care înseamnă pierderea sesiunii, spre deosebire de o parolă sau un cod greșit.
const SESSION_LOST = /Autentificare necesară|Sesiune expirată|Cont inactiv|verificarea MFA/;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  form?: FormData;
  /** Cererea verifică o parolă sau un cod: un 401 cu alt mesaj nu înseamnă sesiune pierdută. */
  credentialCheck?: boolean;
  /** Nu anunța pierderea sesiunii (verificarea stării la pornire). */
  silentAuth?: boolean;
  signal?: AbortSignal;
}

export async function api<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  let body: BodyInit | undefined;
  if (options.form) body = options.form;
  else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: options.method ?? (body ? 'POST' : 'GET'),
      credentials: 'same-origin',
      headers,
      body,
      signal: options.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'Serverul nu poate fi contactat. Verificați conexiunea și încercați din nou.');
  }
  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try { data = JSON.parse(text); } catch { data = undefined; }
  }
  if (res.ok) {
    if (text && data === undefined) throw new ApiError(res.status, 'Serverul a trimis un răspuns neașteptat.');
    return data as T;
  }
  const raw = (data ?? {}) as { message?: unknown; errors?: unknown };
  const first = Array.isArray(raw.message) ? raw.message[0] : raw.message;
  const message = typeof first === 'string' && first && !FRAMEWORK_TEXT.test(first)
    ? first
    : FALLBACK[res.status] ?? GENERIC;
  const errors = Array.isArray(raw.errors) ? raw.errors.map(String) : [];
  const error = new ApiError(res.status, message, errors);
  if (!options.silentAuth) {
    if (res.status === 401 && (!options.credentialCheck || SESSION_LOST.test(message))) authListener?.('session');
    if (res.status === 403 && message === 'Parola trebuie schimbată') authListener?.('password');
  }
  throw error;
}

/** Construiește un query string, omițând valorile goale. */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    out.set(key, value === true ? '1' : String(value));
  }
  const text = out.toString();
  return text ? `?${text}` : '';
}

export function fileUrl(documentId: number, opts: { version?: number; kind?: 'original' | 'searchable'; download?: boolean } = {}): string {
  return `/api/documents/${documentId}/file${qs({ version: opts.version, kind: opts.kind, download: opts.download })}`;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) {
    return err instanceof ApiError ? err.message : GENERIC;
  }
  return GENERIC;
}
