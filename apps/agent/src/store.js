// Configurația agentului, într-un director al utilizatorului. Nu conține chei sau parole.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function homeDir() {
  return process.env.SEADOC_AGENT_HOME || path.join(os.homedir(), '.seadoc-agent');
}

const defaults = () => ({ port: 47800, allowedOrigins: [], pairingToken: crypto.randomBytes(32).toString('hex'), certificates: [], pkcs11: null });

export function loadConfig() {
  const dir = homeDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'config.json');
  let config;
  try {
    config = { ...defaults(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Configurația ${file} nu se poate citi: ${err.message}`);
    config = defaults();
    saveConfig(config);
  }
  if (process.env.SEADOC_AGENT_PORT !== undefined) config.port = Number(process.env.SEADOC_AGENT_PORT);
  if (process.env.SEADOC_AGENT_ORIGINS !== undefined) config.allowedOrigins = process.env.SEADOC_AGENT_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  return config;
}

export function saveConfig(config) {
  const file = path.join(homeDir(), 'config.json');
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

/** O origine este schemă + gazdă + port, fără cale; orice altă formă e probabil o greșeală de configurare. */
export function normalizeOrigin(text) {
  const url = new URL(text);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Originea trebuie să fie http sau https');
  if (url.pathname !== '/' || url.search || url.hash) throw new Error('Originea nu conține cale');
  return url.origin;
}
