// CMS SignedData detașat, în stil PAdES: fără signing-time (momentul este în dicționarul PDF), cu signing-certificate-v2.
import crypto from 'node:crypto';

const lenBytes = (n) => {
  if (n < 0x80) return Buffer.from([n]);
  const out = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) out.unshift(v & 255);
  return Buffer.from([0x80 | out.length, ...out]);
};
const tlv = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), lenBytes(body.length), body]);
};
const seq = (...p) => tlv(0x30, ...p);
const set = (...p) => tlv(0x31, ...p);
const octet = (b) => tlv(0x04, b);
const NULL = Buffer.from([0x05, 0x00]);

function oid(text) {
  const parts = text.split('.').map(Number);
  const out = [parts[0] * 40 + parts[1]];
  for (const n of parts.slice(2)) {
    const chunk = [];
    let v = n;
    do { chunk.unshift(v & 0x7f); v = Math.floor(v / 128); } while (v > 0);
    chunk.forEach((b, i) => out.push(i < chunk.length - 1 ? b | 0x80 : b));
  }
  return tlv(0x06, Buffer.from(out));
}

const OID = {
  signedData: '1.2.840.113549.1.7.2',
  data: '1.2.840.113549.1.7.1',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  sha256: '2.16.840.1.101.3.4.2.1',
  sha256WithRsa: '1.2.840.113549.1.1.11',
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
};

function readTlv(b, pos) {
  let p = pos + 1;
  let len = b[p++];
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[p++];
  }
  return { tag: b[pos], start: pos, bodyStart: p, end: p + len };
}

/** Seria și emitentul, exact ca în certificat. */
function issuerAndSerial(certDer) {
  const cert = readTlv(certDer, 0);
  const tbs = readTlv(certDer, cert.bodyStart);
  let p = tbs.bodyStart;
  let field = readTlv(certDer, p);
  if (field.tag === 0xa0) { p = field.end; field = readTlv(certDer, p); }
  const serial = certDer.subarray(field.start, field.end);
  const sigAlg = readTlv(certDer, field.end);
  const issuer = readTlv(certDer, sigAlg.end);
  return seq(certDer.subarray(issuer.start, issuer.end), serial);
}

/**
 * @param {{ digest: Buffer, certDer: Buffer, chainDer: Buffer[], keyType: 'rsa'|'ec',
 *           sign: (signedAttrs: Buffer) => Promise<Buffer> | Buffer }} input
 */
export async function buildCms({ digest, certDer, chainDer, keyType, sign }) {
  const certHash = crypto.createHash('sha256').update(certDer).digest();
  const attribute = (type, value) => seq(oid(type), set(value));
  const attrs = [
    attribute(OID.contentType, oid(OID.data)),
    attribute(OID.messageDigest, octet(digest)),
    attribute(OID.signingCertificateV2, seq(seq(seq(octet(certHash))))),
  ].sort(Buffer.compare); // SET OF în DER este ordonat
  const signedAttrs = set(...attrs);
  const signature = await sign(signedAttrs);
  const sha256Alg = seq(oid(OID.sha256));
  const signatureAlg = keyType === 'ec' ? seq(oid(OID.ecdsaWithSha256)) : seq(oid(OID.sha256WithRsa), NULL);
  const signerInfo = seq(
    tlv(0x02, Buffer.from([1])),
    issuerAndSerial(certDer),
    sha256Alg,
    tlv(0xa0, ...attrs),
    signatureAlg,
    octet(signature),
  );
  const signedData = seq(
    tlv(0x02, Buffer.from([1])),
    set(sha256Alg),
    seq(oid(OID.data)),
    tlv(0xa0, certDer, ...chainDer),
    set(signerInfo),
  );
  return seq(oid(OID.signedData), tlv(0xa0, signedData));
}

/** Semnătura ECDSA brută de pe token (r||s), în forma DER pe care o cere CMS. */
export function ecdsaRawToDer(raw) {
  const half = raw.length / 2;
  const integer = (b) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const v = b.subarray(i);
    return tlv(0x02, v[0] & 0x80 ? Buffer.concat([Buffer.from([0]), v]) : v);
  };
  return seq(integer(raw.subarray(0, half)), integer(raw.subarray(half)));
}
