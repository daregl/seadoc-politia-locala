import { useEffect, useState } from 'react';
import { api, errorMessage, qs } from '../api';
import type { DocListItem, Paged } from '../types';

export interface PickedDoc { id: number; title: string; regLabel: string | null }

/** Caută un document vizibil pentru utilizator, ca să fie legat de cel curent. */
export function DocPicker({ value, onChange, excludeId, label = 'Document' }: {
  value: PickedDoc | null; onChange: (doc: PickedDoc | null) => void; excludeId?: number; label?: string;
}) {
  const [text, setText] = useState('');
  const [items, setItems] = useState<DocListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const term = text.trim();
    if (term.length < 2) { setItems(null); setError(null); return; }
    let active = true;
    const timer = window.setTimeout(async () => {
      try {
        const res = await api<Paged<DocListItem>>(`/documents${qs({ q: term, limit: 8 })}`);
        if (active) { setItems(res.items.filter((d) => d.id !== excludeId)); setError(null); }
      } catch (err) {
        if (active) { setItems(null); setError(errorMessage(err)); }
      }
    }, 300);
    return () => { active = false; window.clearTimeout(timer); };
  }, [text, excludeId]);

  if (value) {
    return (
      <div className="field">
        <span className="field-label">{label}</span>
        <p className="picked">
          <span><strong>{value.regLabel ?? 'Fără număr'}</strong> · {value.title}</span>
          <button type="button" className="btn btn-sm" onClick={() => onChange(null)}>Schimbă</button>
        </p>
      </div>
    );
  }
  return (
    <div className="field">
      <label className="field">
        <span className="field-label">{label}</span>
        <input
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Număr de înregistrare sau cuvinte din titlu"
          autoComplete="off"
          onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
        />
      </label>
      {error && <span className="field-error" role="alert">{error}</span>}
      {items && items.length === 0 && <span className="hint">Niciun document găsit.</span>}
      {items && items.length > 0 && (
        <ul className="pick-list">
          {items.map((doc) => (
            <li key={doc.id}>
              <button type="button" onClick={() => onChange({ id: doc.id, title: doc.title, regLabel: doc.regLabel })}>
                <strong>{doc.regLabel ?? 'Fără număr'}</strong> · {doc.title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
