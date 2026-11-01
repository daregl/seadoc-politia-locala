// Punctul de intrare al firelor izolate; vezi bounded-worker.ts.
import { parentPort, workerData } from 'node:worker_threads';
import { asBuffer } from './bounded-worker.js';

const { op, payload } = workerData as { op: string; payload: any };

async function run(): Promise<{ result: unknown; transfer?: ArrayBuffer[] }> {
  switch (op) {
    case 'pdf-verify': {
      const { verifyPdf } = await import('./pdf-signatures.js');
      return { result: verifyPdf(asBuffer(payload.data), payload.roots) };
    }
    case 'pdf-prepare': {
      const { insertPlaceholder } = await import('./pdf-signatures.js');
      const p = insertPlaceholder(asBuffer(payload.data), new Date(payload.signingTime));
      const pdf = new Uint8Array(p.pdf);
      return { result: { pdf, byteRange: p.byteRange, contentsStart: p.contentsStart, contentsEnd: p.contentsEnd, digestHex: p.digestHex }, transfer: [pdf.buffer] };
    }
    case 'pdf-complete': {
      const { completeSignature } = await import('./pdf-signatures.js');
      const r = completeSignature({ ...payload, prepared: asBuffer(payload.prepared), cms: asBuffer(payload.cms) });
      if (!r.ok) return { result: r };
      const signed = new Uint8Array(r.signed);
      return { result: { ok: true, signed, signature: r.signature, report: r.report }, transfer: [signed.buffer] };
    }
    case 'pdf-preflight': {
      const { parsePdf, assertStreamsBounded } = await import('./pdf-lite.js');
      await assertStreamsBounded(parsePdf(asBuffer(payload.data)), payload.maxPerStream, payload.maxTotal);
      return { result: true };
    }
    case 'office-preview': {
      const { convertOffice } = await import('./preview-convert.js');
      return { result: await convertOffice(asBuffer(payload.data), payload.mime) };
    }
    case 'tiff-page': {
      const { decodeTiffPage } = await import('./image-bounds.js');
      const page = decodeTiffPage(asBuffer(payload.data), payload.page);
      return { result: page, transfer: [page.rgba.buffer as ArrayBuffer] };
    }
    default:
      throw new Error(`Operație necunoscută: ${op}`);
  }
}

run().then(
  ({ result, transfer }) => parentPort!.postMessage({ ok: true, result }, transfer ?? []),
  (err: Error) => parentPort!.postMessage({ ok: false, error: err?.message ?? 'Eroare' }),
);
