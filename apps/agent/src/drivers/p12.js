// Certificat dintr-un fișier PKCS#12. Parola se cere la fiecare semnătură, iar cheia nu rămâne în memorie între semnături.
import crypto, { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import forge from 'node-forge';

export class WrongCredential extends Error {}

function readP12(file, passphrase) {
  const raw = fs.readFileSync(file);
  let p12;
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(forge.util.createBuffer(raw.toString('binary'))), false, passphrase);
  } catch (err) {
    throw new WrongCredential('Parola fișierului PKCS#12 este greșită sau fișierul este deteriorat.', { cause: err });
  }
  const keys = [
    ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? []),
  ].map((bag) => bag.key).filter(Boolean);
  const certs = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? []).map((bag) => bag.cert).filter(Boolean);
  if (!keys.length) throw new Error('Fișierul PKCS#12 nu conține o cheie privată RSA citibilă.');
  return { keys, certs };
}

const matches = (key, cert) => cert.publicKey.n && cert.publicKey.n.equals(key.n) && cert.publicKey.e.equals(key.e);

/** Citește certificatele o singură dată, la import. Se păstrează doar partea publică și calea fișierului. */
export function importP12(file, passphrase) {
  const { keys, certs } = readP12(file, passphrase);
  const out = [];
  for (const key of keys) {
    const leaf = certs.find((c) => matches(key, c));
    if (!leaf) continue;
    const certPem = forge.pki.certificateToPem(leaf);
    const sha = crypto.createHash('sha256').update(new X509Certificate(certPem).raw).digest('hex');
    out.push({
      id: `p12-${sha.slice(0, 16)}`,
      driver: 'p12',
      path: file,
      certPem,
      chainPem: certs.filter((c) => c !== leaf).map((c) => forge.pki.certificateToPem(c)),
    });
  }
  if (!out.length) throw new Error('Niciun certificat din fișier nu se potrivește cu o cheie privată.');
  return out;
}

export const p12Driver = {
  name: 'p12',
  credentialLabel: 'Parola fișierului PKCS#12',
  /** Parola se poate reîncerca: un fișier nu se blochează. */
  retriable: true,
  list(config) {
    return config.certificates.filter((c) => c.driver === 'p12');
  },
  async sign(entry, passphrase, data) {
    const { keys, certs } = readP12(entry.path, passphrase);
    const want = crypto.createHash('sha256').update(new X509Certificate(entry.certPem).raw).digest('hex');
    const leaf = certs.find((c) => crypto.createHash('sha256').update(new X509Certificate(forge.pki.certificateToPem(c)).raw).digest('hex') === want);
    const key = leaf && keys.find((k) => matches(k, leaf));
    if (!key) throw new Error('Cheia certificatului nu se mai află în fișierul PKCS#12.');
    const keyObject = crypto.createPrivateKey(forge.pki.privateKeyToPem(key));
    return crypto.sign('sha256', data, keyObject);
  },
};
