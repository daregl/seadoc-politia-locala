// Serverul local: ascultă doar pe 127.0.0.1. O pagină web oarecare nu ajunge la semnare, din trei motive independente:
// originea trebuie să fie pe lista permisă, cererea trebuie să aibă tokenul de asociere, iar utilizatorul confirmă
// fiecare semnătură într-o pagină servită de agent, pe care aplicația web nu o poate citi.
import crypto, { X509Certificate } from 'node:crypto';
import http from 'node:http';
import { buildCms } from './cms.js';
import { p12Driver, WrongCredential } from './drivers/p12.js';
import { pkcs11Driver } from './drivers/pkcs11.js';

const VERSION = '0.1.0';
const MAX_BODY = 64 * 1024;
const REQUEST_TTL_MS = 2 * 60_000;
const MAX_PENDING = 5;
const MAX_CREDENTIAL_ATTEMPTS = 3;
const HOST = '127.0.0.1';
const TOKEN_HEADER = 'x-seadoc-agent-token';

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const oneLine = (dn) => dn.split('\n').map((s) => s.trim()).filter(Boolean).join(', ');
const TEST_WORDS = /(^|[^\p{L}])(test|teste|demo|sandbox|prob[aă]|specimen)([^\p{L}]|$)/iu;

function describe(entry) {
  const x = new X509Certificate(entry.certPem);
  const subject = oneLine(x.subject);
  const issuer = oneLine(x.issuer);
  return {
    id: entry.id,
    driver: entry.driver,
    subject,
    issuer,
    serial: x.serialNumber,
    sha256: crypto.createHash('sha256').update(x.raw).digest('hex'),
    validFrom: new Date(x.validFrom).toISOString(),
    validTo: new Date(x.validTo).toISOString(),
    expired: new Date(x.validTo) < new Date() || new Date(x.validFrom) > new Date(),
    testCertificate: TEST_WORDS.test(subject) || TEST_WORDS.test(issuer) || x.subject === x.issuer,
    certPem: entry.certPem,
  };
}

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(a).digest();
  const y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y);
}

export function createAgent(config) {
  const drivers = [p12Driver, pkcs11Driver];
  const requests = new Map();
  let port = config.port;
  const ownOrigin = () => `http://${HOST}:${port}`;
  const allowedHosts = () => new Set([`${HOST}:${port}`, `localhost:${port}`]);

  const allCertificates = async () => {
    const out = [];
    const problems = [];
    for (const d of drivers) {
      try {
        out.push(...await d.list(config));
      } catch (err) {
        problems.push(`${d.name}: ${err.message}`);
      }
    }
    return { entries: out, problems };
  };

  const sweep = () => {
    const now = Date.now();
    for (const [id, r] of requests) {
      if (r.status === 'asteapta' && r.expiresAt < now) { r.status = 'expirat'; r.message = 'Confirmarea nu a venit la timp.'; }
      if (r.expiresAt + REQUEST_TTL_MS < now) requests.delete(id);
    }
  };
  const sweeper = setInterval(sweep, 15_000);
  sweeper.unref();

  const json = (res, status, body, origin) => {
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (origin) Object.assign(headers, { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' });
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
  };

  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Cerere prea mare'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

  // Pagina de confirmare ---------------------------------------------------------------------------

  const page = (res, status, title, body) => {
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    });
    res.end(`<!doctype html><html lang="ro"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font:16px system-ui,sans-serif;max-width:38rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a}dt{font-weight:600;margin-top:.75rem}dd{margin:0;overflow-wrap:anywhere}.warn{background:#fff4e5;border:1px solid #d97706;padding:.75rem;margin:1rem 0}.err{background:#fde8e8;border:1px solid #c81e1e;padding:.75rem;margin:1rem 0}input{font:inherit;width:100%;box-sizing:border-box;padding:.5rem;margin:.25rem 0 1rem}button{font:inherit;padding:.5rem 1rem;margin-right:.5rem}</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`);
  };

  const confirmForm = (r, error) => {
    const info = describe(r.entry);
    const label = r.driver.credentialLabel;
    return `
<p>O aplicație cere o semnătură cu certificatul de pe acest calculator. Verificați datele și confirmați doar dacă dumneavoastră ați inițiat semnarea.</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
${info.testCertificate ? '<p class="warn">Acesta este un certificat de test. Semnătura nu are valoare juridică.</p>' : ''}
<dl>
<dt>Cerută de</dt><dd>${escapeHtml(r.origin)}</dd>
<dt>Document (așa cum îl descrie aplicația; agentul nu îl poate verifica)</dt><dd>${escapeHtml(r.label || 'fără descriere')}</dd>
<dt>Amprenta SHA-256 care se semnează</dt><dd>${escapeHtml(r.digestHex)}</dd>
<dt>Certificat</dt><dd>${escapeHtml(info.subject)}</dd>
<dt>Emitent</dt><dd>${escapeHtml(info.issuer)}</dd>
</dl>
<form method="post" autocomplete="off">
<input type="hidden" name="csrf" value="${r.csrf}">
<label for="pin">${escapeHtml(label)} (rămâne în agent și nu ajunge la aplicația web)</label>
<input id="pin" name="pin" type="password" autocomplete="off" autofocus>
<button type="submit" name="action" value="sign">Semnează</button>
<button type="submit" name="action" value="refuse">Refuză</button>
</form>`;
  };

  const handleConfirm = async (req, res, id, token) => {
    const r = requests.get(id);
    if (!r || !safeEqual(r.confirmToken, token ?? '')) return page(res, 404, 'Cerere inexistentă', '<p>Cererea de semnare nu există sau a expirat.</p>');
    sweep();
    if (r.status !== 'asteapta') return page(res, 409, 'Cerere încheiată', `<p>Această cerere de semnare este deja încheiată (${escapeHtml(r.status)}). Puteți închide fereastra.</p>`);
    if (req.method === 'GET') return page(res, 200, 'Confirmare semnătură', confirmForm(r));
    if (req.method !== 'POST') return page(res, 405, 'Metodă nepermisă', '');
    // Doar pagina servită de agent poate trimite formularul; aplicația web nu vede nici valoarea csrf.
    if (req.headers.origin !== ownOrigin()) return page(res, 403, 'Cerere respinsă', '<p>Confirmarea se face doar din pagina agentului.</p>');
    const form = new URLSearchParams(await readBody(req));
    if (!safeEqual(r.csrf, form.get('csrf') ?? '')) return page(res, 403, 'Cerere respinsă', '<p>Formular invalid.</p>');
    if (form.get('action') === 'refuse') {
      r.status = 'refuzat';
      r.message = 'Semnătura a fost refuzată în agent.';
      return page(res, 200, 'Semnătură refuzată', '<p>Nu s-a semnat nimic. Puteți închide fereastra.</p>');
    }
    if (form.get('action') !== 'sign') return page(res, 400, 'Cerere respinsă', '<p>Acțiune necunoscută.</p>');
    try {
      const x509 = new X509Certificate(r.entry.certPem);
      const cms = await buildCms({
        digest: Buffer.from(r.digestHex, 'hex'),
        certDer: x509.raw,
        chainDer: (r.entry.chainPem ?? []).map((pem) => new X509Certificate(pem).raw),
        keyType: x509.publicKey.asymmetricKeyType === 'ec' ? 'ec' : 'rsa',
        sign: (signedAttrs) => r.driver.sign(r.entry, form.get('pin') ?? '', signedAttrs, config),
      });
      r.status = 'semnat';
      r.cms = cms.toString('base64');
      return page(res, 200, 'Semnat', '<p>Semnătura a fost făcută și trimisă aplicației. Puteți închide fereastra.</p>');
    } catch (err) {
      if (err instanceof WrongCredential) {
        r.attempts++;
        if (r.driver.retriable && r.attempts < MAX_CREDENTIAL_ATTEMPTS) return page(res, 401, 'Confirmare semnătură', confirmForm(r, err.message));
        r.status = 'esuat';
        r.message = err.message;
        return page(res, 401, 'Semnătură eșuată', `<p class="err">${escapeHtml(err.message)}</p><p>Reluați semnarea din aplicație.</p>`);
      }
      r.status = 'esuat';
      r.message = err.message;
      return page(res, 500, 'Semnătură eșuată', `<p class="err">${escapeHtml(err.message)}</p>`);
    }
  };

  // Interfața pentru aplicația web -------------------------------------------------------------------

  const handleApi = async (req, res, url) => {
    const origin = req.headers.origin;
    // Fără antete CORS pe respingere: pagina care a cerut nu află nici măcar motivul.
    if (!origin || !config.allowedOrigins.includes(origin)) return json(res, 403, { message: 'Origine nepermisă' });

    if (req.method === 'OPTIONS') {
      const headers = {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': `Content-Type, ${TOKEN_HEADER}`,
        'Access-Control-Max-Age': '600',
        Vary: 'Origin, Access-Control-Request-Private-Network, Access-Control-Request-Headers',
      };
      // Private Network Access: browserele mai vechi trimit acest antet la preflight.
      if (req.headers['access-control-request-private-network'] === 'true') headers['Access-Control-Allow-Private-Network'] = 'true';
      res.writeHead(204, headers);
      return res.end();
    }

    const paired = typeof req.headers[TOKEN_HEADER] === 'string' && safeEqual(config.pairingToken, req.headers[TOKEN_HEADER]);
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { agent: 'seadoc', version: VERSION, paired }, origin);
    }
    if (!paired) return json(res, 401, { message: 'Token de asociere lipsă sau greșit. Rulați „seadoc-agent pair” pe acest calculator.' }, origin);

    if (req.method === 'GET' && url.pathname === '/certificates') {
      const { entries, problems } = await allCertificates();
      return json(res, 200, { certificates: entries.map(describe), problems }, origin);
    }

    if (req.method === 'POST' && url.pathname === '/sign') {
      if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return json(res, 415, { message: 'Cererea trebuie să fie JSON' }, origin);
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { message: 'JSON invalid' }, origin);
      }
      if (body?.digestAlgorithm !== 'SHA-256' || typeof body.digestHex !== 'string' || !/^[0-9a-f]{64}$/.test(body.digestHex)) {
        return json(res, 400, { message: 'Se semnează doar o amprentă SHA-256 în format hexazecimal' }, origin);
      }
      sweep();
      const pending = [...requests.values()].filter((r) => r.status === 'asteapta').length;
      if (pending >= MAX_PENDING) return json(res, 429, { message: 'Prea multe cereri de semnare neconfirmate' }, origin);
      const { entries } = await allCertificates();
      const entry = entries.find((c) => c.id === body.certificateId);
      if (!entry) return json(res, 404, { message: 'Certificatul ales nu mai este disponibil' }, origin);
      const info = describe(entry);
      if (info.expired) return json(res, 400, { message: 'Certificatul ales nu este în perioada de valabilitate' }, origin);
      const id = crypto.randomUUID();
      const confirmToken = crypto.randomBytes(24).toString('hex');
      const expiresAt = Date.now() + REQUEST_TTL_MS;
      requests.set(id, {
        id, origin, entry, driver: drivers.find((d) => d.name === entry.driver), digestHex: body.digestHex,
        label: typeof body.label === 'string' ? body.label.slice(0, 200) : '',
        confirmToken, csrf: crypto.randomBytes(24).toString('hex'), expiresAt, status: 'asteapta', attempts: 0,
      });
      return json(res, 202, { requestId: id, confirmUrl: `${ownOrigin()}/confirm/${id}?t=${confirmToken}`, expiresAt: new Date(expiresAt).toISOString() }, origin);
    }

    const signMatch = /^\/sign\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (req.method === 'GET' && signMatch) {
      sweep();
      const r = requests.get(signMatch[1]);
      if (!r || r.origin !== origin) return json(res, 404, { message: 'Cerere de semnare inexistentă' }, origin);
      return json(res, 200, { status: r.status, message: r.message ?? null, cms: r.status === 'semnat' ? r.cms : null, certificateSha256: describe(r.entry).sha256 }, origin);
    }

    return json(res, 404, { message: 'Resursă inexistentă' }, origin);
  };

  const server = http.createServer((req, res) => {
    const fail = (err) => {
      if (res.headersSent) { res.destroy(); return; }
      json(res, err.status ?? 500, { message: err.status ? err.message : 'Eroare în agent' });
      if (!err.status) console.error(err);
    };
    // Verificarea gazdei oprește DNS rebinding: o adresă publică ce ajunge să indice 127.0.0.1.
    if (!allowedHosts().has(req.headers.host ?? '')) return json(res, 403, { message: 'Gazdă nepermisă' });
    const url = new URL(req.url, ownOrigin());
    const confirm = /^\/confirm\/([0-9a-f-]{36})$/.exec(url.pathname);
    (confirm ? handleConfirm(req, res, confirm[1], url.searchParams.get('t')) : handleApi(req, res, url)).catch(fail);
  });

  return {
    server,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      // Doar interfața locală; nu există opțiune pentru altă adresă.
      server.listen(config.port, HOST, () => {
        port = server.address().port;
        resolve(port);
      });
    }),
    close: () => new Promise((resolve) => { clearInterval(sweeper); server.close(resolve); }),
  };
}
