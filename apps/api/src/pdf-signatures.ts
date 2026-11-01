// Verificarea semnăturilor din PDF și pregătirea unei semnături prin actualizare incrementală.
// Modulul nu are dependențe de Nest și rulează în firul izolat (sandbox-worker.ts), pentru că primește fișiere ostile.
import crypto, { X509Certificate } from 'node:crypto';
import {
  dict, isDict, isName, isNum, isRef, isStr, literal, name, num, ParsedPdf, parsePdf, PdfDict, PdfError, PdfRef, PdfStr, PdfValue, ref,
  resolve, serialize, strBytes, strText,
} from './pdf-lite.js';

// DER/BER -------------------------------------------------------------------------------------

export interface Der {
  tag: number;
  constructed: boolean;
  /** Tot elementul, cu antet. */
  raw: Buffer;
  /** Conținutul, fără antet (la lungime nedefinită, fără marcajul final). */
  body: Buffer;
  children: Der[];
}

const DER_MAX_DEPTH = 32;
const DER_MAX_NODES = 200_000;

class DerReader {
  nodes = 0;
  constructor(readonly b: Buffer) {}

  read(pos: number, limit: number, depth: number): { node: Der; next: number } {
    if (depth > DER_MAX_DEPTH) throw new PdfError('Structură ASN.1 prea adâncă');
    if (++this.nodes > DER_MAX_NODES) throw new PdfError('Structură ASN.1 prea mare');
    const { b } = this;
    if (pos + 2 > limit) throw new PdfError('ASN.1 trunchiat');
    const tag = b[pos];
    if ((tag & 0x1f) === 0x1f) throw new PdfError('Etichetă ASN.1 neacceptată');
    const constructed = (tag & 0x20) !== 0;
    let p = pos + 1;
    let len = b[p++];
    let indefinite = false;
    if (len === 0x80) {
      if (!constructed) throw new PdfError('Lungime nedefinită pe element primitiv');
      indefinite = true;
    } else if (len & 0x80) {
      const n = len & 0x7f;
      if (n > 4 || p + n > limit) throw new PdfError('Lungime ASN.1 invalidă');
      len = 0;
      for (let i = 0; i < n; i++) len = len * 256 + b[p++];
    }
    if (indefinite) {
      const children: Der[] = [];
      let q = p;
      for (;;) {
        if (q + 2 > limit) throw new PdfError('ASN.1 fără marcaj final');
        if (b[q] === 0 && b[q + 1] === 0) break;
        const r = this.read(q, limit, depth + 1);
        children.push(r.node);
        q = r.next;
      }
      return { node: { tag, constructed, raw: b.subarray(pos, q + 2), body: b.subarray(p, q), children }, next: q + 2 };
    }
    if (p + len > limit) throw new PdfError('Lungime ASN.1 peste limita elementului');
    const end = p + len;
    const children: Der[] = [];
    if (constructed) {
      let q = p;
      while (q < end) {
        const r = this.read(q, end, depth + 1);
        children.push(r.node);
        q = r.next;
      }
    }
    return { node: { tag, constructed, raw: b.subarray(pos, end), body: b.subarray(p, end), children }, next: end };
  }
}

export function parseDer(b: Buffer): Der {
  return new DerReader(b).read(0, b.length, 0).node;
}

function oidOf(node: Der | undefined): string {
  if (!node || node.tag !== 0x06 || node.body.length === 0 || node.body.length > 64) throw new PdfError('Identificator ASN.1 așteptat');
  const parts: number[] = [];
  let v = 0;
  node.body.forEach((byte, i) => {
    v = v * 128 + (byte & 0x7f);
    if (byte & 0x80) return;
    if (i === 0 || parts.length === 0) {
      const first = Math.min(Math.floor(v / 40), 2);
      parts.push(first, v - first * 40);
    } else parts.push(v);
    v = 0;
  });
  return parts.join('.');
}

const octets = (node: Der): Buffer => (node.constructed ? Buffer.concat(node.children.map(octets)) : node.body);
const stripZeros = (b: Buffer) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; return b.subarray(i); };

function asn1Time(node: Der | undefined): Date | null {
  if (!node) return null;
  const s = node.body.toString('latin1');
  let m: RegExpExecArray | null;
  if (node.tag === 0x17 && (m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/.exec(s))) {
    const y = Number(m[1]);
    return new Date(Date.UTC(y >= 50 ? 1900 + y : 2000 + y, +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0)));
  }
  if (node.tag === 0x18 && (m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\.\d+)?Z$/.exec(s))) {
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0)));
  }
  return null;
}

// CMS / PKCS#7 --------------------------------------------------------------------------------

const OID = {
  signedData: '1.2.840.113549.1.7.2',
  data: '1.2.840.113549.1.7.1',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  signingCertificate: '1.2.840.113549.1.9.16.2.12',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  timeStampToken: '1.2.840.113549.1.9.16.2.14',
  subjectKeyId: '2.5.29.14',
};

const DIGESTS: Record<string, string> = {
  '1.3.14.3.2.26': 'sha1',
  '2.16.840.1.101.3.4.2.1': 'sha256',
  '2.16.840.1.101.3.4.2.2': 'sha384',
  '2.16.840.1.101.3.4.2.3': 'sha512',
  '2.16.840.1.101.3.4.2.4': 'sha224',
};
const SIG_HASH: Record<string, string> = {
  '1.2.840.113549.1.1.5': 'sha1',
  '1.2.840.113549.1.1.14': 'sha224',
  '1.2.840.113549.1.1.11': 'sha256',
  '1.2.840.113549.1.1.12': 'sha384',
  '1.2.840.113549.1.1.13': 'sha512',
  '1.2.840.10045.4.1': 'sha1',
  '1.2.840.10045.4.3.1': 'sha224',
  '1.2.840.10045.4.3.2': 'sha256',
  '1.2.840.10045.4.3.3': 'sha384',
  '1.2.840.10045.4.3.4': 'sha512',
};
const RSA_ENCRYPTION = '1.2.840.113549.1.1.1';
const RSA_PSS = '1.2.840.113549.1.1.10';
const EC_PUBLIC_KEY = '1.2.840.10045.2.1';
const ED25519 = '1.3.101.112';

export interface ParsedCms {
  digestAlgorithm: string | null;
  digestOid: string;
  signatureOid: string;
  signatureParams: Der | undefined;
  signature: Buffer;
  /** Atributele semnate, reetichetate ca SET: ce a semnat de fapt cheia. */
  signedAttrs: Buffer | null;
  attrs: Map<string, Der[]>;
  attrsDuplicated: boolean;
  unsignedOids: string[];
  eContent: Buffer | null;
  eContentType: string;
  certificates: X509Certificate[];
  signerCert: X509Certificate | null;
  signerCount: number;
}

/** Numele emitentului și seria, ca octeți, din certificatul DER. */
function certIdentity(der: Buffer): { issuer: Buffer; serial: Buffer; ski: Buffer | null } {
  const cert = parseDer(der);
  const tbs = cert.children[0];
  const fields = tbs.children;
  const at = fields[0]?.tag === 0xa0 ? 1 : 0;
  let ski: Buffer | null = null;
  const ext = fields.find((f) => f.tag === 0xa3);
  for (const e of ext?.children[0]?.children ?? []) {
    if (oidOf(e.children[0]) === OID.subjectKeyId) {
      const wrapped = e.children[e.children.length - 1];
      ski = parseDer(octets(wrapped)).body;
    }
  }
  return { issuer: fields[at + 2].raw, serial: stripZeros(fields[at].body), ski };
}

export function parseCms(der: Buffer): ParsedCms {
  const root = parseDer(der);
  if (root.tag !== 0x30 || oidOf(root.children[0]) !== OID.signedData) throw new PdfError('Conținutul nu este CMS SignedData');
  const sd = root.children[1]?.children[0];
  if (root.children[1]?.tag !== 0xa0 || sd?.tag !== 0x30) throw new PdfError('SignedData lipsește');
  const encap = sd.children[2];
  if (encap?.tag !== 0x30) throw new PdfError('EncapsulatedContentInfo lipsește');
  const eContentType = oidOf(encap.children[0]);
  const eContentNode = encap.children[1]?.children[0];
  let i = 3;
  const certificates: X509Certificate[] = [];
  const certDers: Buffer[] = [];
  if (sd.children[i]?.tag === 0xa0) {
    for (const c of sd.children[i].children) {
      if (c.tag !== 0x30 || certificates.length >= 64) continue;
      try {
        certificates.push(new X509Certificate(c.raw));
        certDers.push(c.raw);
      } catch { /* certificat nelizibil: nu poate fi semnatarul */ }
    }
    i++;
  }
  if (sd.children[i]?.tag === 0xa1) i++;
  const infos = sd.children[i];
  if (infos?.tag !== 0x31 || infos.children.length === 0) throw new PdfError('SignerInfo lipsește');
  const si = infos.children[0];
  if (si.tag !== 0x30) throw new PdfError('SignerInfo invalid');
  const sid = si.children[1];
  const digestOid = oidOf(si.children[2]?.children[0]);
  let j = 3;
  let signedAttrs: Buffer | null = null;
  const attrs = new Map<string, Der[]>();
  let attrsDuplicated = false;
  if (si.children[j]?.tag === 0xa0) {
    const node = si.children[j];
    signedAttrs = Buffer.from(node.raw);
    signedAttrs[0] = 0x31;
    for (const a of node.children) {
      const oid = oidOf(a.children[0]);
      if (attrs.has(oid)) attrsDuplicated = true;
      attrs.set(oid, a.children[1]?.children ?? []);
    }
    j++;
  }
  const sigAlg = si.children[j++];
  const sigValue = si.children[j++];
  if (sigAlg?.tag !== 0x30 || !sigValue || (sigValue.tag & 0x1f) !== 4) throw new PdfError('Semnătura lipsește din SignerInfo');
  const unsigned = si.children[j]?.tag === 0xa1 ? si.children[j].children.map((a) => oidOf(a.children[0])) : [];

  let signerCert: X509Certificate | null = null;
  for (let c = 0; c < certDers.length && !signerCert; c++) {
    const id = certIdentity(certDers[c]);
    if (sid?.tag === 0x30) {
      const serial = stripZeros(sid.children[1]?.body ?? Buffer.alloc(0));
      if (id.issuer.equals(sid.children[0]?.raw ?? Buffer.alloc(0)) && id.serial.equals(serial)) signerCert = certificates[c];
    } else if (sid?.tag === 0x80 && id.ski?.equals(sid.body)) {
      signerCert = certificates[c];
    }
  }
  return {
    digestAlgorithm: DIGESTS[digestOid] ?? null,
    digestOid,
    signatureOid: oidOf(sigAlg.children[0]),
    signatureParams: sigAlg.children[1],
    signature: octets(sigValue),
    signedAttrs,
    attrs,
    attrsDuplicated,
    unsignedOids: unsigned,
    eContent: eContentNode ? octets(eContentNode) : null,
    eContentType,
    certificates,
    signerCert,
    signerCount: infos.children.length,
  };
}

/** Verifică semnătura criptografică din SignerInfo peste părțile date. */
function verifySignatureValue(cms: ParsedCms, cert: X509Certificate, parts: Buffer[]): boolean {
  const key = cert.publicKey;
  try {
    const alg = cms.signatureOid;
    if (alg === ED25519) return crypto.verify(null, Buffer.concat(parts), key, cms.signature);
    let hash: string | null = SIG_HASH[alg] ?? null;
    let options: crypto.VerifyKeyObjectInput = { key };
    if (alg === RSA_ENCRYPTION || alg === EC_PUBLIC_KEY) hash = cms.digestAlgorithm;
    if (alg === RSA_PSS) {
      const params = cms.signatureParams;
      let saltLength = 20;
      hash = 'sha1';
      for (const f of params?.children ?? []) {
        if (f.tag === 0xa0) hash = DIGESTS[oidOf(f.children[0]?.children[0])] ?? null;
        if (f.tag === 0xa2) saltLength = Number(BigInt(`0x${f.children[0].body.toString('hex')}`));
      }
      options = { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength };
    }
    if (!hash) return false;
    const verifier = crypto.createVerify(hash);
    for (const part of parts) verifier.update(part);
    return verifier.verify(options, cms.signature);
  } catch {
    return false;
  }
}

function signingCertificateAttr(cms: ParsedCms, cert: X509Certificate): 'ok' | 'absent' | 'nepotrivit' {
  try {
    const v2 = cms.attrs.get(OID.signingCertificateV2)?.[0];
    if (v2) {
      const first = v2.children[0]?.children[0];
      const hasAlg = first?.children[0]?.tag === 0x30;
      const algOid = hasAlg ? oidOf(first.children[0].children[0]) : '2.16.840.1.101.3.4.2.1';
      const hash = first?.children[hasAlg ? 1 : 0];
      const name = DIGESTS[algOid];
      if (!hash || !name) return 'nepotrivit';
      return crypto.createHash(name).update(cert.raw).digest().equals(hash.body) ? 'ok' : 'nepotrivit';
    }
    const v1 = cms.attrs.get(OID.signingCertificate)?.[0];
    if (v1) {
      const hash = v1.children[0]?.children[0]?.children[0];
      return hash && crypto.createHash('sha1').update(cert.raw).digest().equals(hash.body) ? 'ok' : 'nepotrivit';
    }
    return 'absent';
  } catch {
    return 'nepotrivit';
  }
}

// Certificate și lanț ---------------------------------------------------------------------------

export interface TrustRootPem { file: string; pem: string }
interface TrustRoot { file: string; cert: X509Certificate }

const oneLine = (dn: string) => dn.split('\n').map((s) => s.trim()).filter(Boolean).join(', ');

export function loadRoots(pems: TrustRootPem[]): { roots: TrustRoot[]; rejected: string[] } {
  const roots: TrustRoot[] = [];
  const rejected: string[] = [];
  for (const { file, pem } of pems) {
    const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
    if (!blocks.length) rejected.push(file);
    for (const block of blocks) {
      try { roots.push({ file, cert: new X509Certificate(block) }); } catch { rejected.push(file); }
    }
  }
  return { roots, rejected };
}

export interface CertInfo {
  subject: string;
  issuer: string;
  commonName: string | null;
  serial: string;
  sha256: string;
  validFrom: string;
  validTo: string;
  selfSigned: boolean;
}

export function certInfo(cert: X509Certificate): CertInfo {
  const subject = oneLine(cert.subject);
  return {
    subject,
    issuer: oneLine(cert.issuer),
    commonName: /(?:^|\n)\s*CN=([^\n]+)/.exec(cert.subject)?.[1]?.trim() ?? null,
    serial: cert.serialNumber,
    sha256: crypto.createHash('sha256').update(cert.raw).digest('hex'),
    validFrom: new Date(cert.validFrom).toISOString(),
    validTo: new Date(cert.validTo).toISOString(),
    selfSigned: cert.subject === cert.issuer,
  };
}

const TEST_WORDS = /(^|[^\p{L}])(test|teste|demo|sandbox|prob[aă]|specimen)([^\p{L}]|$)/iu;

/** Semnele că un certificat este de test. Absența lor nu înseamnă că certificatul este real. */
export function testIndicators(cert: X509Certificate, rootFile: string | null = null): string[] {
  const out: string[] = [];
  if (TEST_WORDS.test(oneLine(cert.subject))) out.push('titularul conține un cuvânt de test');
  if (TEST_WORDS.test(oneLine(cert.issuer))) out.push('emitentul conține un cuvânt de test');
  if (cert.subject === cert.issuer) out.push('certificat autosemnat');
  if (rootFile && /^test[-_.]/i.test(rootFile)) out.push(`rădăcina vine din fișierul de test ${rootFile}`);
  return out;
}

export type ChainStatus = 'verificat' | 'neverificat' | 'invalid';
export const CHAIN_UNVERIFIED = 'lanț de încredere neverificat';

export interface ChainResult {
  status: ChainStatus;
  message: string;
  rootFile: string | null;
  rootSubject: string | null;
  certificates: { subject: string; issuer: string; sha256: string }[];
}

const validAt = (cert: X509Certificate, at: Date) => new Date(cert.validFrom) <= at && at <= new Date(cert.validTo);

function chainOf(leaf: X509Certificate, pool: X509Certificate[], roots: TrustRoot[], at: Date | null): ChainResult {
  const path: X509Certificate[] = [leaf];
  const seen = new Set([leaf.fingerprint256]);
  let cur = leaf;
  let root: TrustRoot | null = null;
  for (let depth = 0; depth < 10; depth++) {
    const asRoot = roots.find((r) => r.cert.fingerprint256 === cur.fingerprint256);
    if (asRoot) { root = asRoot; break; }
    const issuedBy = (candidate: X509Certificate) => {
      try { return cur.checkIssued(candidate) && cur.verify(candidate.publicKey); } catch { return false; }
    };
    const viaRoot = roots.find((r) => r.cert.ca && issuedBy(r.cert));
    if (viaRoot) {
      root = viaRoot;
      path.push(viaRoot.cert);
      break;
    }
    // Un certificat care nu este de autoritate nu poate continua lanțul.
    const next = pool.find((c) => !seen.has(c.fingerprint256) && c.ca && issuedBy(c));
    if (!next) break;
    path.push(next);
    seen.add(next.fingerprint256);
    cur = next;
  }
  const certificates = path.map((c) => ({ subject: oneLine(c.subject), issuer: oneLine(c.issuer), sha256: crypto.createHash('sha256').update(c.raw).digest('hex') }));
  const base = { rootFile: root?.file ?? null, rootSubject: root ? oneLine(root.cert.subject) : null, certificates };
  if (!root) {
    return {
      ...base,
      status: 'neverificat',
      message: roots.length ? `${CHAIN_UNVERIFIED}: nicio rădăcină configurată nu se potrivește` : `${CHAIN_UNVERIFIED}: nu este configurată nicio rădăcină (TRUST_ROOTS_DIR)`,
    };
  }
  if (!at) return { ...base, status: 'neverificat', message: `${CHAIN_UNVERIFIED}: semnătura nu declară momentul semnării` };
  const stale = path.find((c) => !validAt(c, at));
  if (stale) return { ...base, status: 'invalid', message: `Lanț invalid la momentul semnării: ${oneLine(stale.subject)} nu era în perioada de valabilitate` };
  return { ...base, status: 'verificat', message: `Lanț verificat până la rădăcina configurată ${oneLine(root.cert.subject)}` };
}

// Verificarea unui PDF ----------------------------------------------------------------------------

export type Verdict =
  | 'valida' | 'lant_neverificat' | 'lant_invalid' | 'alterata' | 'semnatura_invalida'
  | 'modificat_dupa_semnare' | 'certificat_nevalabil' | 'structura_invalida' | 'nesuportata';

export interface SignatureReport {
  index: number;
  fieldName: string | null;
  /** Câmp de semnătură din formular care indică acest dicționar; `null` = nu s-a putut stabili. */
  referenced: boolean | null;
  subFilter: string | null;
  verdict: Verdict;
  message: string;
  signer: CertInfo | null;
  testIndicators: string[];
  signingTime: { value: string; source: 'atribut_semnat' | 'dictionar_pdf'; note: string } | null;
  digestAlgorithm: string | null;
  signatureAlgorithm: string;
  weakAlgorithm: boolean;
  digestMatches: boolean;
  cmsSignatureValid: boolean;
  signingCertificateAttribute: 'ok' | 'absent' | 'nepotrivit' | null;
  byteRange: number[] | null;
  byteRangeValid: boolean;
  coversWholeFile: boolean;
  bytesAfterSignature: number;
  certificateValidAtSigning: boolean | null;
  chain: ChainResult | null;
  revocation: { checked: false; message: string };
  qualified: { checked: false; message: string };
  timestamp: { present: boolean; verified: false; message: string | null };
  issues: string[];
}

export interface VerifyReport {
  status: 'cu_semnaturi' | 'fara_semnaturi' | 'malformat' | 'esuat';
  message: string;
  fileSha256: string;
  fileSize: number;
  checkedAt: string;
  trustRootsConfigured: number;
  trustRootsRejected: string[];
  signatures: SignatureReport[];
  truncated: boolean;
  notes: string[];
}

export const REVOCATION_NOT_CHECKED = 'Revocarea certificatului (OCSP/CRL) nu a fost verificată.';
export const QUALIFIED_NOT_CHECKED = 'Statutul calificat eIDAS nu a fost verificat (lista de încredere UE nu este consultată).';
const MAX_SIGNATURES = 32;
const MAX_CMS_BYTES = 8 * 1024 * 1024;

function pdfDate(s: PdfValue | undefined): Date | null {
  if (!isStr(s)) return null;
  const m = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:(Z)|([+-])(\d{2})'?(\d{2})?'?)?/.exec(strText(s));
  if (!m) return null;
  const utc = Date.UTC(+m[1], +(m[2] ?? 1) - 1, +(m[3] ?? 1), +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  const offset = m[8] ? (m[8] === '+' ? 1 : -1) * ((+m[9]) * 60 + +(m[10] ?? 0)) : 0;
  const d = new Date(utc - offset * 60_000);
  return Number.isNaN(d.getTime()) ? null : d;
}

interface Candidate { dict: PdfDict; pos: number; fieldName: string | null; referenced: boolean | null }

/** Câmpurile de semnătură din formular, după numărul obiectului care conține dicționarul semnăturii. */
function collectFields(pdf: ParsedPdf): { byObject: Map<number, string | null>; direct: { dict: PdfDict; fieldName: string | null }[]; known: boolean } {
  const byObject = new Map<number, string | null>();
  const direct: { dict: PdfDict; fieldName: string | null }[] = [];
  const root = resolve(pdf, pdf.trailer.get('Root'));
  if (!isDict(root)) return { byObject, direct, known: false };
  const form = resolve(pdf, root.map.get('AcroForm'));
  if (!isDict(form)) return { byObject, direct, known: pdf.unreadObjectStreams === 0 };
  const visited = new Set<number>();
  let budget = 20_000;
  const walk = (field: PdfValue | undefined, prefix: string, depth: number) => {
    if (depth > 16 || budget-- <= 0) return;
    if (isRef(field)) {
      if (visited.has(field.num)) return;
      visited.add(field.num);
    }
    const d = resolve(pdf, field);
    if (!isDict(d)) return;
    const t = d.map.get('T');
    const own = isStr(t) ? strText(t) : '';
    const full = [prefix, own].filter(Boolean).join('.');
    const v = d.map.get('V');
    if (isRef(v)) {
      const target = resolve(pdf, v);
      if (isDict(target) && target.map.has('ByteRange')) byObject.set(v.num, full || null);
    } else if (isDict(v) && v.map.has('ByteRange')) {
      direct.push({ dict: v, fieldName: full || null });
    }
    const kids = resolve(pdf, d.map.get('Kids'));
    if (Array.isArray(kids)) for (const k of kids) walk(k, full, depth + 1);
  };
  const fields = resolve(pdf, form.map.get('Fields'));
  if (Array.isArray(fields)) for (const f of fields) walk(f, '', 0);
  return { byObject, direct, known: pdf.unreadObjectStreams === 0 };
}

function findCandidates(pdf: ParsedPdf): { list: Candidate[]; truncated: boolean } {
  const fields = collectFields(pdf);
  const list: Candidate[] = [];
  const current = (num: number, pos: number) => pdf.objects.get(num)?.pos === pos;
  for (const obj of pdf.topLevel) {
    if (!isDict(obj.value) || obj.stream) continue;
    if (!obj.value.map.has('ByteRange') || !obj.value.map.has('Contents')) continue;
    const named = fields.byObject.has(obj.num) && current(obj.num, obj.pos);
    list.push({
      dict: obj.value,
      pos: obj.start,
      fieldName: named ? fields.byObject.get(obj.num)! : null,
      referenced: named ? true : fields.known ? false : null,
    });
  }
  for (const d of fields.direct) {
    if (!d.dict.map.has('Contents')) continue;
    const c = d.dict.map.get('Contents');
    list.push({ dict: d.dict, pos: isStr(c) ? c.start : 0, fieldName: d.fieldName, referenced: true });
  }
  list.sort((a, b) => a.pos - b.pos);
  return { list: list.slice(0, MAX_SIGNATURES), truncated: list.length > MAX_SIGNATURES };
}

const VERDICT_MESSAGES: Record<Verdict, string> = {
  valida: 'Semnătură valabilă criptografic, cu lanț verificat până la o rădăcină configurată.',
  lant_neverificat: `Integritatea și semnătura criptografică sunt corecte; ${CHAIN_UNVERIFIED}.`,
  lant_invalid: 'Integritatea este corectă, dar lanțul de certificate nu este valabil la momentul semnării.',
  alterata: 'Conținutul acoperit de semnătură a fost modificat: amprenta nu corespunde.',
  semnatura_invalida: 'Semnătura criptografică nu se verifică.',
  modificat_dupa_semnare: 'Semnătura este corectă pentru revizia semnată, dar fișierul conține octeți adăugați după ea.',
  certificat_nevalabil: 'Certificatul semnatarului nu era în perioada de valabilitate la momentul declarat al semnării.',
  structura_invalida: 'Structura semnăturii din PDF este invalidă.',
  nesuportata: 'Acest format de semnătură nu este verificat de aplicație.',
};

function emptyReport(index: number, c: Candidate, subFilter: string | null): SignatureReport {
  return {
    index,
    fieldName: c.fieldName,
    referenced: c.referenced,
    subFilter,
    verdict: 'structura_invalida',
    message: VERDICT_MESSAGES.structura_invalida,
    signer: null,
    testIndicators: [],
    signingTime: null,
    digestAlgorithm: null,
    signatureAlgorithm: '',
    weakAlgorithm: false,
    digestMatches: false,
    cmsSignatureValid: false,
    signingCertificateAttribute: null,
    byteRange: null,
    byteRangeValid: false,
    coversWholeFile: false,
    bytesAfterSignature: 0,
    certificateValidAtSigning: null,
    chain: null,
    revocation: { checked: false, message: REVOCATION_NOT_CHECKED },
    qualified: { checked: false, message: QUALIFIED_NOT_CHECKED },
    timestamp: { present: false, verified: false, message: null },
    issues: [],
  };
}

function finish(r: SignatureReport, verdict: Verdict): SignatureReport {
  r.verdict = verdict;
  r.message = VERDICT_MESSAGES[verdict];
  return r;
}

function checkCandidate(data: Buffer, c: Candidate, index: number, roots: TrustRoot[]): SignatureReport {
  const subFilterValue = c.dict.map.get('SubFilter');
  const subFilter = isName(subFilterValue) ? subFilterValue.name : null;
  const r = emptyReport(index, c, subFilter);
  if (c.referenced === false) r.issues.push('Dicționarul semnăturii nu este legat de niciun câmp de semnătură din document.');

  const rangeValue = c.dict.map.get('ByteRange');
  const range = Array.isArray(rangeValue) && rangeValue.length === 4 && rangeValue.every(isNum) ? rangeValue.map((n) => (n as { v: number }).v) : null;
  if (!range || range.some((n) => !Number.isSafeInteger(n) || n < 0)) { r.issues.push('ByteRange lipsește sau nu are patru numere întregi.'); return finish(r, 'structura_invalida'); }
  r.byteRange = range;
  const [a, b, c2, d] = range;
  const contents = c.dict.map.get('Contents');
  const ordered = a === 0 && b > 0 && c2 > b && c2 + d <= data.length && d >= 0;
  // Golul din ByteRange trebuie să fie exact șirul /Contents al acestui dicționar: altfel semnătura poate fi mutată.
  const gapIsContents = isStr(contents) && contents.hex && contents.start === b && contents.end === c2;
  if (!ordered) r.issues.push('ByteRange nu descrie un interval valid din fișier.');
  if (!gapIsContents) r.issues.push('Golul din ByteRange nu coincide cu șirul /Contents al semnăturii.');
  r.byteRangeValid = ordered && gapIsContents;
  if (ordered) {
    r.coversWholeFile = c2 + d === data.length;
    r.bytesAfterSignature = Math.max(0, data.length - (c2 + d));
  }
  if (!isStr(contents)) return finish(r, 'structura_invalida');
  const der = strBytes(contents);
  if (der.length > MAX_CMS_BYTES) { r.issues.push('Semnătura depășește dimensiunea acceptată.'); return finish(r, 'structura_invalida'); }

  if (subFilter === 'ETSI.RFC3161') { r.issues.push('Marcă temporală de document: nu este verificată.'); return finish(r, 'nesuportata'); }
  if (subFilter === 'adbe.x509.rsa_sha1') { r.issues.push('Formatul adbe.x509.rsa_sha1 nu este CMS și nu este verificat.'); return finish(r, 'nesuportata'); }

  let cms: ParsedCms;
  try {
    cms = parseCms(der);
  } catch (err) {
    r.issues.push(err instanceof PdfError ? err.message : 'CMS ilizibil.');
    return finish(r, 'structura_invalida');
  }
  r.digestAlgorithm = cms.digestAlgorithm;
  r.signatureAlgorithm = cms.signatureOid;
  r.weakAlgorithm = cms.digestAlgorithm === 'sha1' || SIG_HASH[cms.signatureOid] === 'sha1';
  if (r.weakAlgorithm) r.issues.push('Algoritmul SHA-1 este depășit.');
  if (cms.signerCount > 1) r.issues.push('CMS conține mai mulți semnatari; se verifică primul.');
  if (cms.attrsDuplicated) r.issues.push('Atribute semnate duplicate.');
  const stamp = cms.unsignedOids.includes(OID.timeStampToken);
  r.timestamp = { present: stamp, verified: false, message: stamp ? 'Conține o marcă temporală, care nu a fost verificată.' : null };

  if (cms.signedAttrs && (!cms.attrs.has(OID.contentType) || !cms.attrs.has(OID.messageDigest))) r.issues.push('Lipsesc atributele semnate obligatorii.');

  // Ce acoperă semnătura: octeții din ByteRange sau, la adbe.pkcs7.sha1, amprenta lor încapsulată.
  const covered = ordered ? [data.subarray(0, b), data.subarray(c2, c2 + d)] : [];
  const hash = (alg: string, parts: Buffer[]) => { const h = crypto.createHash(alg); for (const p of parts) h.update(p); return h.digest(); };
  let content: Buffer[] = covered;
  let digestMatches = false;
  if (ordered && cms.digestAlgorithm) {
    if (cms.eContent) {
      if (subFilter === 'adbe.pkcs7.sha1') {
        digestMatches = hash('sha1', covered).equals(cms.eContent);
        content = [cms.eContent];
      } else {
        r.issues.push('CMS conține conținut încapsulat, dar formatul cere semnătură detașată.');
      }
    } else digestMatches = true;
    if (digestMatches && cms.signedAttrs) {
      const md = cms.attrs.get(OID.messageDigest)?.[0];
      digestMatches = !!md && hash(cms.digestAlgorithm, content).equals(md.body);
    }
  } else if (!cms.digestAlgorithm) {
    r.issues.push('Algoritm de amprentă necunoscut sau neacceptat.');
  }

  const cert = cms.signerCert;
  if (!cert) {
    r.issues.push('Certificatul semnatarului nu se află în semnătură.');
    r.digestMatches = digestMatches;
    return finish(r, digestMatches ? 'semnatura_invalida' : 'alterata');
  }
  r.signer = certInfo(cert);
  r.signingCertificateAttribute = cms.signedAttrs ? signingCertificateAttr(cms, cert) : null;
  if (r.signingCertificateAttribute === 'nepotrivit') r.issues.push('Atributul semnat al certificatului nu corespunde certificatului inclus.');

  const signedTime = asn1Time(cms.attrs.get(OID.signingTime)?.[0]);
  const declared = pdfDate(c.dict.map.get('M'));
  const at = signedTime ?? declared;
  const note = 'Moment declarat de semnatar, fără marcă temporală verificată.';
  if (signedTime) r.signingTime = { value: signedTime.toISOString(), source: 'atribut_semnat', note };
  else if (declared) r.signingTime = { value: declared.toISOString(), source: 'dictionar_pdf', note };
  r.certificateValidAtSigning = at ? validAt(cert, at) : null;

  const pool = cms.certificates;
  r.chain = chainOf(cert, pool, roots, at);
  r.testIndicators = testIndicators(cert, r.chain.rootFile);

  r.cmsSignatureValid = cms.signedAttrs
    ? verifySignatureValue(cms, cert, [cms.signedAttrs])
    : content.length > 0 && verifySignatureValue(cms, cert, content);
  // Fără atribute semnate, semnătura însăși este singura legătură cu conținutul.
  if (!cms.signedAttrs && !cms.eContent) digestMatches = digestMatches && r.cmsSignatureValid;
  r.digestMatches = digestMatches;

  if (!r.byteRangeValid) return finish(r, 'structura_invalida');
  if (!r.digestMatches) return finish(r, cms.eContent && subFilter !== 'adbe.pkcs7.sha1' ? 'structura_invalida' : 'alterata');
  if (!r.cmsSignatureValid || r.signingCertificateAttribute === 'nepotrivit' || cms.attrsDuplicated) return finish(r, 'semnatura_invalida');
  if (!r.coversWholeFile) {
    r.issues.push(`După această semnătură, fișierul mai conține ${r.bytesAfterSignature} octeți, neacoperiți de ea.`);
    if (r.chain.status !== 'verificat') r.issues.push(r.chain.message);
    return finish(r, 'modificat_dupa_semnare');
  }
  if (r.certificateValidAtSigning === false) return finish(r, 'certificat_nevalabil');
  if (r.chain.status === 'invalid') return finish(r, 'lant_invalid');
  if (r.chain.status === 'neverificat') return finish(r, 'lant_neverificat');
  return finish(r, 'valida');
}

export function verifyPdf(data: Buffer, rootPems: TrustRootPem[]): VerifyReport {
  const { roots, rejected } = loadRoots(rootPems);
  const report: VerifyReport = {
    status: 'fara_semnaturi',
    message: 'Fișierul nu conține semnături electronice.',
    fileSha256: crypto.createHash('sha256').update(data).digest('hex'),
    fileSize: data.length,
    checkedAt: new Date().toISOString(),
    trustRootsConfigured: roots.length,
    trustRootsRejected: rejected,
    signatures: [],
    truncated: false,
    notes: [],
  };
  let pdf: ParsedPdf;
  try {
    pdf = parsePdf(data);
  } catch (err) {
    report.status = 'malformat';
    report.message = err instanceof PdfError ? `PDF ilizibil: ${err.message}` : 'PDF ilizibil.';
    return report;
  }
  if (pdf.syntaxErrors) report.notes.push(`Fișierul conține ${pdf.syntaxErrors} obiecte cu sintaxă invalidă.`);
  if (pdf.unreadObjectStreams) report.notes.push('Unele fluxuri de obiecte nu s-au putut citi; legătura semnăturilor cu câmpurile din formular nu s-a putut stabili complet.');
  const { list, truncated } = findCandidates(pdf);
  report.truncated = truncated;
  if (truncated) report.notes.push(`Fișierul conține mai mult de ${MAX_SIGNATURES} semnături; s-au verificat primele ${MAX_SIGNATURES}.`);
  report.signatures = list.map((c, i) => checkCandidate(data, c, i + 1, roots));
  if (report.signatures.length) {
    report.status = 'cu_semnaturi';
    report.message = `Semnături găsite: ${report.signatures.length}.`;
  }
  return report;
}

// Pregătirea semnăturii -----------------------------------------------------------------------------

/** Spațiul rezervat pentru CMS, în octeți. */
export const CMS_RESERVED_BYTES = 32_768;

export interface PreparedPdf {
  pdf: Buffer;
  byteRange: [number, number, number, number];
  contentsStart: number;
  contentsEnd: number;
  digestHex: string;
}

const pdfTimestamp = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}+00'00'`;
};

function firstPage(pdf: ParsedPdf, pages: PdfValue | undefined): { ref: PdfRef; dict: PdfDict } {
  let cur = pages;
  const seen = new Set<number>();
  for (let depth = 0; depth < 64; depth++) {
    if (!isRef(cur) || seen.has(cur.num)) break;
    seen.add(cur.num);
    const node = resolve(pdf, cur);
    if (!isDict(node)) break;
    const kids = resolve(pdf, node.map.get('Kids'));
    if (!Array.isArray(kids)) {
      if (!isName(node.map.get('Type'), 'Page')) break;
      return { ref: cur, dict: node };
    }
    cur = kids[0];
  }
  throw new PdfError('PDF fără pagini citibile');
}

function refusesChanges(pdf: ParsedPdf, root: PdfDict): boolean {
  const perms = resolve(pdf, root.map.get('Perms'));
  if (!isDict(perms)) return false;
  const docMdp = resolve(pdf, perms.map.get('DocMDP'));
  if (!isDict(docMdp)) return false;
  const refs = resolve(pdf, docMdp.map.get('Reference'));
  if (!Array.isArray(refs)) return false;
  return refs.some((item) => {
    const entry = resolve(pdf, item);
    if (!isDict(entry)) return false;
    const params = resolve(pdf, entry.map.get('TransformParams'));
    const p = isDict(params) ? params.map.get('P') : undefined;
    return isName(entry.map.get('TransformMethod'), 'DocMDP') && isNum(p) && p.v === 1;
  });
}

/**
 * Adaugă semnătura goală printr-o actualizare incrementală: octeții existenți rămân identici,
 * deci stratul de text OCR și semnăturile anterioare nu sunt atinse.
 */
export function insertPlaceholder(data: Buffer, signingTime: Date): PreparedPdf {
  const pdf = parsePdf(data);
  if (pdf.encrypted) throw new PdfError('PDF-ul este criptat și nu poate fi semnat');
  if (pdf.startxref === null || !pdf.xrefKind) throw new PdfError('Tabelul de referințe al PDF-ului este invalid');
  const rootRef = pdf.trailer.get('Root');
  if (!isRef(rootRef)) throw new PdfError('PDF fără catalog');
  const root = resolve(pdf, rootRef);
  if (!isDict(root) || !isName(root.map.get('Type'), 'Catalog')) throw new PdfError('PDF fără catalog');
  if (refusesChanges(pdf, root)) throw new PdfError('PDF-ul este certificat și nu permite alte modificări, nici semnături');
  const page = firstPage(pdf, root.map.get('Pages'));

  const sizeValue = pdf.trailer.get('Size');
  let next = Math.max(pdf.maxObjectNumber + 1, isNum(sizeValue) ? sizeValue.v : 0);
  const sigNum = next++;
  const widgetNum = next++;

  const updates = new Map<number, { gen: number; body: string }>();
  const update = (r: PdfRef, value: PdfValue) => {
    const existing = pdf.objects.get(r.num);
    if (existing?.stream) throw new PdfError('Obiectul de actualizat este un flux');
    updates.set(r.num, { gen: r.gen, body: serialize(value) });
  };

  // Lista de câmpuri a formularului, fie directă, fie obiect separat.
  const appendTo = (holder: PdfDict, key: string, item: PdfValue, holderChanged: () => void) => {
    const cur = holder.map.get(key);
    const resolved = resolve(pdf, cur);
    if (isRef(cur) && Array.isArray(resolved)) {
      update(cur, [...resolved, item]);
      return;
    }
    holder.map.set(key, Array.isArray(resolved) ? [...resolved, item] : [item]);
    holderChanged();
  };

  // Formularul: un dicționar direct în catalog sau un obiect separat.
  const formValue = root.map.get('AcroForm');
  let form = resolve(pdf, formValue);
  let formRef: PdfRef | null = isRef(formValue) && isDict(form) ? formValue : null;
  let existingNames = new Set<string>();
  let rootChanged = false;
  if (!isDict(form)) {
    form = dict({});
    formRef = ref(next++);
    root.map.set('AcroForm', formRef);
    rootChanged = true;
  }
  const formDict = form as PdfDict;
  const fields = resolve(pdf, formDict.map.get('Fields'));
  if (Array.isArray(fields)) {
    existingNames = new Set(fields.map((f) => {
      const d = resolve(pdf, f);
      const t = isDict(d) ? d.map.get('T') : undefined;
      return isStr(t) ? strText(t) : '';
    }));
  }
  let n = 1;
  while (existingNames.has(`SemnaturaSeaDoc${n}`)) n++;

  const sigFlags = formDict.map.get('SigFlags');
  formDict.map.set('SigFlags', num((isNum(sigFlags) ? sigFlags.v : 0) | 3));
  appendTo(formDict, 'Fields', ref(widgetNum), () => {});
  if (formRef) updates.set(formRef.num, { gen: formRef.gen, body: serialize(formDict) });
  else rootChanged = true;
  if (rootChanged) update(rootRef, root);

  // Semnătura este și adnotarea invizibilă de pe prima pagină.
  let pageChanged = false;
  appendTo(page.dict, 'Annots', ref(widgetNum), () => { pageChanged = true; });
  if (pageChanged) update(page.ref, page.dict);

  const widget = dict({
    Type: name('Annot'),
    Subtype: name('Widget'),
    FT: name('Sig'),
    T: literal(`SemnaturaSeaDoc${n}`),
    F: num(132),
    Rect: [num(0), num(0), num(0), num(0)],
    V: ref(sigNum),
    P: page.ref,
  });

  const BR_WIDTH = 10;
  const brPlaceholder = `[0 ${'*'.repeat(BR_WIDTH)} ${'*'.repeat(BR_WIDTH)} ${'*'.repeat(BR_WIDTH)}]`;
  const contentsHexLength = CMS_RESERVED_BYTES * 2;
  const sigHead = `<</Type /Sig /Filter /Adobe.PPKLite /SubFilter /ETSI.CAdES.detached /M (${pdfTimestamp(signingTime)}) /ByteRange ${brPlaceholder} /Contents <`;
  const sigBody = `${sigHead}${'0'.repeat(contentsHexLength)}>>>`;

  // Scrierea secțiunii adăugate; pozițiile sunt absolute în fișierul final.
  const chunks: Buffer[] = [data];
  let offset = data.length;
  const push = (text: string | Buffer) => {
    const buf = typeof text === 'string' ? Buffer.from(text, 'latin1') : text;
    chunks.push(buf);
    offset += buf.length;
  };
  push('\n');
  const entries: { num: number; gen: number; offset: number }[] = [];
  const writeObject = (objNum: number, gen: number, body: string) => {
    entries.push({ num: objNum, gen, offset });
    push(`${objNum} ${gen} obj\n${body}\nendobj\n`);
  };
  for (const [objNum, u] of [...updates].sort((x, y) => x[0] - y[0])) writeObject(objNum, u.gen, u.body);
  writeObject(widgetNum, 0, serialize(widget));
  const sigObjectStart = offset;
  writeObject(sigNum, 0, sigBody);
  const contentsStart = sigObjectStart + Buffer.byteLength(`${sigNum} 0 obj\n`) + sigHead.length - 1;
  const contentsEnd = contentsStart + contentsHexLength + 2;

  const size = next;
  const trailerEntries: Record<string, PdfValue> = { Size: num(size), Root: rootRef, Prev: num(pdf.startxref) };
  for (const key of ['Info', 'ID']) {
    const v = pdf.trailer.get(key);
    if (v !== undefined && v !== null) trailerEntries[key] = v;
  }
  const xrefOffset = offset;
  const subsections = (items: { num: number }[]) => {
    const sorted = [...items].sort((x, y) => x.num - y.num);
    const groups: { first: number; items: typeof sorted }[] = [];
    for (const item of sorted) {
      const last = groups[groups.length - 1];
      if (last && last.first + last.items.length === item.num) last.items.push(item);
      else groups.push({ first: item.num, items: [item] });
    }
    return groups as { first: number; items: { num: number; gen: number; offset: number }[] }[];
  };
  if (pdf.xrefKind === 'tabel') {
    let table = 'xref\n';
    for (const g of subsections(entries)) {
      table += `${g.first} ${g.items.length}\n`;
      for (const e of g.items) table += `${String(e.offset).padStart(10, '0')} ${String(e.gen).padStart(5, '0')} n \n`;
    }
    push(`${table}trailer\n${serialize(dict(trailerEntries))}\n`);
  } else {
    // Un fișier cu flux de referințe se continuă tot cu un flux de referințe.
    const xrefNum = next++;
    entries.push({ num: xrefNum, gen: 0, offset });
    trailerEntries.Size = num(next);
    const groups = subsections(entries);
    const rows = Buffer.alloc(entries.length * 7);
    let w = 0;
    for (const g of groups) {
      for (const e of g.items) {
        rows[w] = 1;
        rows.writeUInt32BE(e.offset, w + 1);
        rows.writeUInt16BE(e.gen, w + 5);
        w += 7;
      }
    }
    const xrefDict = dict({
      ...trailerEntries,
      Type: name('XRef'),
      W: [num(1), num(4), num(2)],
      Index: groups.flatMap((g) => [num(g.first), num(g.items.length)]),
      Length: num(rows.length),
    });
    push(`${xrefNum} 0 obj\n${serialize(xrefDict)}\nstream\n`);
    push(rows);
    push('\nendstream\nendobj\n');
  }
  push(`startxref\n${xrefOffset}\n%%EOF\n`);

  const out = Buffer.concat(chunks);
  const byteRange: [number, number, number, number] = [0, contentsStart, contentsEnd, out.length - contentsEnd];
  const brText = `[0 ${byteRange.slice(1).join(' ')}]`.padEnd(brPlaceholder.length, ' ');
  const brStart = out.indexOf(brPlaceholder, sigObjectStart, 'latin1');
  if (brStart < 0 || brText.length !== brPlaceholder.length) throw new PdfError('Spațiul pentru ByteRange nu s-a putut completa');
  out.write(brText, brStart, 'latin1');

  const digestHex = crypto.createHash('sha256').update(out.subarray(0, contentsStart)).update(out.subarray(contentsEnd)).digest('hex');
  return { pdf: out, byteRange, contentsStart, contentsEnd, digestHex };
}

export interface CompletionInput {
  prepared: Buffer;
  contentsStart: number;
  contentsEnd: number;
  cms: Buffer;
  expectedDigestHex: string;
  declaredCertSha256: string;
  roots: TrustRootPem[];
}

export type CompletionResult =
  | { ok: true; signed: Buffer; signature: SignatureReport; report: VerifyReport }
  | { ok: false; message: string };

/** Verifică CMS-ul peste octeții pregătiți, îl scrie în spațiul rezervat și verifică rezultatul încă o dată. */
export function completeSignature(input: CompletionInput): CompletionResult {
  const { prepared, contentsStart, contentsEnd, cms: der } = input;
  let cms: ParsedCms;
  try {
    cms = parseCms(der);
  } catch {
    return { ok: false, message: 'Semnătura primită nu este un CMS valid' };
  }
  if (der.length * 2 > contentsEnd - contentsStart - 2) return { ok: false, message: 'Semnătura depășește spațiul rezervat în PDF' };
  if (cms.signerCount !== 1) return { ok: false, message: 'Semnătura trebuie să aibă un singur semnatar' };
  if (cms.eContent) return { ok: false, message: 'Semnătura trebuie să fie detașată' };
  if (!cms.signerCert) return { ok: false, message: 'Certificatul semnatarului lipsește din semnătură' };
  if (certInfo(cms.signerCert).sha256 !== input.declaredCertSha256) return { ok: false, message: 'Certificatul semnatarului diferă de cel declarat la pregătire' };
  if (cms.digestAlgorithm !== 'sha256') return { ok: false, message: 'Semnătura trebuie să folosească SHA-256' };
  if (!cms.signedAttrs || cms.attrsDuplicated || !cms.attrs.has(OID.contentType)) return { ok: false, message: 'Atributele semnate lipsesc sau sunt invalide' };
  const digest = crypto.createHash('sha256').update(prepared.subarray(0, contentsStart)).update(prepared.subarray(contentsEnd)).digest('hex');
  if (digest !== input.expectedDigestHex) return { ok: false, message: 'Fișierul pregătit nu mai corespunde sesiunii' };
  const md = cms.attrs.get(OID.messageDigest)?.[0];
  if (!md || md.body.toString('hex') !== digest) return { ok: false, message: 'Semnătura a fost făcută peste o altă amprentă decât cea pregătită' };
  if (!verifySignatureValue(cms, cms.signerCert, [cms.signedAttrs])) return { ok: false, message: 'Semnătura criptografică nu se verifică cu certificatul declarat' };
  if (signingCertificateAttr(cms, cms.signerCert) === 'nepotrivit') return { ok: false, message: 'Atributul semnat al certificatului nu corespunde' };
  if (!validAt(cms.signerCert, new Date())) return { ok: false, message: 'Certificatul semnatarului nu este în perioada de valabilitate' };

  const signed = Buffer.from(prepared);
  const hex = der.toString('hex').toUpperCase();
  signed.fill('0', contentsStart + 1, contentsEnd - 1, 'latin1');
  signed.write(hex, contentsStart + 1, 'latin1');

  const report = verifyPdf(signed, input.roots);
  const signature = report.signatures.find((s) => s.byteRange?.[1] === contentsStart);
  if (!signature || !signature.digestMatches || !signature.cmsSignatureValid || !signature.coversWholeFile || !signature.byteRangeValid) {
    return { ok: false, message: 'PDF-ul semnat nu a trecut verificarea finală' };
  }
  return { ok: true, signed, signature, report };
}
