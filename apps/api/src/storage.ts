import { Injectable, OnModuleInit } from '@nestjs/common';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

// Fișierele stau pe disc criptate AES-256-GCM: iv (12 octeți) + tag (16 octeți) + conținut.
@Injectable()
export class StorageService implements OnModuleInit {
  async onModuleInit() {
    await fs.mkdir(config.storageDir, { recursive: true, mode: 0o700 });
  }

  private file(key: string) {
    if (!/^[a-f0-9-]+$/.test(key)) throw new Error('Cheie de stocare invalidă');
    return path.join(config.storageDir, key);
  }

  async put(data: Buffer): Promise<string> {
    const key = crypto.randomUUID();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', config.storageKey, iv);
    cipher.setAAD(Buffer.from(key));
    const body = Buffer.concat([cipher.update(data), cipher.final()]);
    await fs.writeFile(this.file(key), Buffer.concat([iv, cipher.getAuthTag(), body]), { mode: 0o600 });
    return key;
  }

  async get(key: string): Promise<Buffer> {
    const raw = await fs.readFile(this.file(key));
    const decipher = crypto.createDecipheriv('aes-256-gcm', config.storageKey, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(key));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
  }

  async remove(key: string): Promise<void> {
    await fs.rm(this.file(key), { force: true });
  }
}
