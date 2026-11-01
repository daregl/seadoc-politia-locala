// Clientul agentului local de semnare. Cererile merg direct din browser către 127.0.0.1;
// PIN-ul nu trece pe aici: se introduce în pagina servită de agent.
export interface AgentCertificate {
  id: string;
  driver: string;
  subject: string;
  issuer: string;
  serial: string;
  sha256: string;
  validFrom: string;
  validTo: string;
  expired: boolean;
  testCertificate: boolean;
  certPem: string;
}

export type AgentStatus = 'absent' | 'neasociat' | 'asociat';

const TOKEN_KEY = 'seadoc.agent.token';

export function storedToken(): string {
  try { return localStorage.getItem(TOKEN_KEY) ?? ''; } catch { return ''; }
}
export function storeToken(token: string) {
  try { localStorage.setItem(TOKEN_KEY, token); } catch { /* stocare blocată: tokenul se cere din nou */ }
}

export class AgentError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'AgentError';
  }
}

/**
 * Chrome cere pentru adresele locale permisiunea „Local Network Access”, iar `targetAddressSpace` declară ținta.
 * Versiunile care nu cunosc valoarea o refuză cu TypeError; atunci se repetă cererea fără ea.
 */
async function send(url: string, init: RequestInit): Promise<Response> {
  const base: RequestInit = { ...init, mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' };
  try {
    return await fetch(url, { ...base, targetAddressSpace: 'loopback' } as RequestInit);
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
    return fetch(url, base);
  }
}

async function call<T>(origin: string, path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { 'x-seadoc-agent-token': storedToken() };
  if (init.body) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await send(`${origin}${path}`, { ...init, headers });
  } catch {
    throw new AgentError(0, 'Agentul local nu răspunde.');
  }
  const data = (await res.json().catch(() => ({}))) as { message?: string };
  if (!res.ok) throw new AgentError(res.status, data.message ?? 'Agentul local a refuzat cererea.');
  return data as T;
}

export async function agentStatus(origin: string): Promise<AgentStatus> {
  try {
    const health = await call<{ agent?: string; paired?: boolean }>(origin, '/health');
    if (health.agent !== 'seadoc') return 'absent';
    return health.paired ? 'asociat' : 'neasociat';
  } catch {
    return 'absent';
  }
}

export const agentCertificates = (origin: string) =>
  call<{ certificates: AgentCertificate[]; problems: string[] }>(origin, '/certificates');

export const agentRequestSignature = (origin: string, body: { certificateId: string; digestHex: string; label: string }) =>
  call<{ requestId: string; confirmUrl: string; expiresAt: string }>(origin, '/sign', {
    method: 'POST',
    body: JSON.stringify({ ...body, digestAlgorithm: 'SHA-256' }),
  });

export const agentSignatureState = (origin: string, requestId: string) =>
  call<{ status: 'asteapta' | 'semnat' | 'refuzat' | 'expirat' | 'esuat'; message: string | null; cms: string | null }>(origin, `/sign/${requestId}`);
