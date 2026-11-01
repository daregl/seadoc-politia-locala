import { useEffect, useState } from 'react';
import { api, errorMessage, qs } from '../api';
import type { Paged } from '../types';

export type ErpKind = 'partener' | 'factura' | 'comanda';
export interface ErpRecord {
  id: number;
  kind: ErpKind;
  externalId: string;
  name: string | null;
  number: string | null;
  taxId: string | null;
  partnerExternalId: string | null;
  partnerId: number | null;
  partnerName: string | null;
  issueDate: string | null;
  dueDate: string | null;
  amount: string | null;
  currency: string | null;
  status: string | null;
}

export const ERP_KIND_LABEL: Record<ErpKind, string> = { partener: 'Partener', factura: 'Factură', comanda: 'Comandă' };

export function erpRecordLabel(r: ErpRecord): string {
  if (r.kind === 'partener') return `${r.name ?? r.externalId}${r.taxId ? ` (${r.taxId})` : ''}`;
  return `${r.number ?? r.externalId}${r.partnerName ? ` · ${r.partnerName}` : ''}`;
}

/** Caută parteneri, facturi și comenzi importate. Alegerile se trimit una câte una, prin `onPick`. */
export function ErpPicker({ onPick, excludeIds = [], kind, label = 'Partener, factură sau comandă' }: {
  onPick: (record: ErpRecord) => void; excludeIds?: number[]; kind?: ErpKind; label?: string;
}) {
  const [text, setText] = useState('');
  const [items, setItems] = useState<ErpRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const term = text.trim();
    if (term.length < 2) { setItems(null); setError(null); return; }
    let active = true;
    const timer = window.setTimeout(async () => {
      try {
        const res = await api<Paged<ErpRecord>>(`/erp/records${qs({ q: term, kind, limit: 10 })}`);
        if (active) { setItems(res.items); setError(null); }
      } catch (err) {
        if (active) { setItems(null); setError(errorMessage(err)); }
      }
    }, 300);
    return () => { active = false; window.clearTimeout(timer); };
  }, [text, kind]);

  const visible = items?.filter((r) => !excludeIds.includes(r.id)) ?? null;
  return (
    <div className="field">
      <label className="field">
        <span className="field-label">{label}</span>
        <input
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Denumire, număr, CUI sau cod extern"
          autoComplete="off"
          onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
        />
      </label>
      {error && <span className="field-error" role="alert">{error}</span>}
      {visible && visible.length === 0 && <span className="hint">Nicio înregistrare găsită.</span>}
      {visible && visible.length > 0 && (
        <ul className="pick-list">
          {visible.map((r) => (
            <li key={r.id}>
              <button type="button" onClick={() => { onPick(r); setText(''); setItems(null); }}>
                <strong>{ERP_KIND_LABEL[r.kind]}</strong> · {erpRecordLabel(r)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
