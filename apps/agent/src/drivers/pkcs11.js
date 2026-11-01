// Token real prin PKCS#11. NETESTAT: pe mașina de dezvoltare nu există token și nici compilator pentru pkcs11js.
// Vezi README.md, secțiunea „Ce nu a fost testat”.
import crypto, { X509Certificate } from 'node:crypto';
import { ecdsaRawToDer } from '../cms.js';
import { WrongCredential } from './p12.js';

const CKR_PIN_INCORRECT = 0xa0;
const CKR_PIN_LOCKED = 0xa4;

async function loadLibrary() {
  try {
    const mod = await import('pkcs11js');
    return mod.default ?? mod;
  } catch (err) {
    throw new Error('Pachetul opțional pkcs11js nu este instalat. Rulați: npm i pkcs11js (cere un compilator C++).', { cause: err });
  }
}

/** Deschide modulul și o sesiune; închide tot la final, pentru ca tokenul să poată fi scos între semnături. */
async function withSession(modulePath, slotFilter, fn) {
  const lib = await loadLibrary();
  const p = new lib.PKCS11();
  p.load(modulePath);
  p.C_Initialize();
  try {
    const out = [];
    for (const slot of p.C_GetSlotList(true)) {
      if (slotFilter && !slotFilter(slot)) continue;
      const session = p.C_OpenSession(slot, lib.CKF_SERIAL_SESSION);
      try {
        out.push(await fn(p, lib, session, slot));
      } finally {
        p.C_CloseSession(session);
      }
    }
    return out;
  } finally {
    p.C_Finalize();
    p.close();
  }
}

function find(p, session, template, max = 64) {
  p.C_FindObjectsInit(session, template);
  try {
    const out = [];
    for (;;) {
      const batch = p.C_FindObjects(session, 16);
      if (!batch.length) return out;
      out.push(...batch);
      if (out.length >= max) return out;
    }
  } finally {
    p.C_FindObjectsFinal(session);
  }
}

const slotKey = (slot) => Buffer.from(slot).toString('hex');

export const pkcs11Driver = {
  name: 'pkcs11',
  credentialLabel: 'PIN-ul tokenului',
  /** Un PIN greșit consumă o încercare pe token; nu se reîncearcă automat. */
  retriable: false,
  async list(config) {
    if (!config.pkcs11?.modulePath) return [];
    const perSlot = await withSession(config.pkcs11.modulePath, null, (p, lib, session, slot) => {
      const certs = find(p, session, [{ type: lib.CKA_CLASS, value: lib.CKO_CERTIFICATE }]).map((handle) => {
        const [value, id] = p.C_GetAttributeValue(session, handle, [{ type: lib.CKA_VALUE }, { type: lib.CKA_ID }]);
        const x509 = new X509Certificate(value.value);
        return { x509, ckaId: Buffer.from(id.value ?? []).toString('hex') };
      });
      const leaves = certs.filter((c) => !c.x509.ca);
      return leaves.map((leaf) => ({
        id: `pkcs11-${crypto.createHash('sha256').update(leaf.x509.raw).digest('hex').slice(0, 16)}`,
        driver: 'pkcs11',
        slot: slotKey(slot),
        ckaId: leaf.ckaId,
        certPem: leaf.x509.toString(),
        chainPem: certs.filter((c) => c !== leaf).map((c) => c.x509.toString()),
      }));
    });
    return perSlot.flat();
  },
  async sign(entry, pin, data, config) {
    const results = await withSession(config.pkcs11.modulePath, (slot) => slotKey(slot) === entry.slot, (p, lib, session) => {
      try {
        p.C_Login(session, lib.CKU_USER, pin);
      } catch (err) {
        const code = err.code ?? err.nativeCode;
        if (code === CKR_PIN_INCORRECT) throw new WrongCredential('PIN greșit. Atenție: după câteva încercări greșite tokenul se blochează.');
        if (code === CKR_PIN_LOCKED) throw new Error('Tokenul este blocat. Folosiți aplicația furnizorului pentru deblocare.');
        throw err;
      }
      try {
        const [key] = find(p, session, [
          { type: lib.CKA_CLASS, value: lib.CKO_PRIVATE_KEY },
          { type: lib.CKA_ID, value: Buffer.from(entry.ckaId, 'hex') },
        ], 1);
        if (!key) throw new Error('Cheia privată a certificatului nu a fost găsită pe token.');
        const isEc = new X509Certificate(entry.certPem).publicKey.asymmetricKeyType === 'ec';
        const out = Buffer.alloc(1024);
        if (isEc) {
          p.C_SignInit(session, { mechanism: lib.CKM_ECDSA }, key);
          return ecdsaRawToDer(Buffer.from(p.C_Sign(session, crypto.createHash('sha256').update(data).digest(), out)));
        }
        p.C_SignInit(session, { mechanism: lib.CKM_SHA256_RSA_PKCS }, key);
        return Buffer.from(p.C_Sign(session, data, out));
      } finally {
        p.C_Logout(session);
      }
    });
    if (!results.length) throw new Error('Tokenul certificatului nu este conectat.');
    return results[0];
  },
};
