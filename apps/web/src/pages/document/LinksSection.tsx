import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Link2, Plus } from 'lucide-react';
import { api } from '../../api';
import { DocPicker, type PickedDoc } from '../../components/DocPicker';
import { Alert, Empty, ErrorAlert, Field, Section } from '../../components/Ui';
import { LINK_KIND } from '../../labels';
import type { DocDetail } from '../../types';

const REVERSE: Record<string, string> = { raspuns_la: 'Are ca răspuns', anexa_la: 'Are ca anexă' };

export function LinksSection({ doc, onChanged }: { doc: DocDetail; onChanged: () => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  const [target, setTarget] = useState<PickedDoc | null>(null);
  const [kind, setKind] = useState('raspuns_la');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!target) { setProblem('Alegeți documentul de legat.'); return; }
    setProblem(null);
    setBusy(true);
    setError(null);
    try {
      await api(`/documents/${doc.id}/links`, { method: 'POST', body: { toId: target.id, kind } });
      setTarget(null);
      setAdding(false);
      await onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Documente legate"
      icon={Link2}
      count={doc.links.length}
      collapsible
      defaultOpen={doc.links.length > 0 || adding}
      actions={doc.canEdit ? (
        <button type="button" className="btn btn-sm" aria-expanded={adding} onClick={() => setAdding(!adding)}><Plus size={15} aria-hidden="true" />Adaugă</button>
      ) : undefined}
    >
      {adding && (
        <form className="inline-form" onSubmit={submit}>
          <ErrorAlert error={error} />
          {problem && <Alert kind="error">{problem}</Alert>}
          <DocPicker value={target} onChange={setTarget} excludeId={doc.id} label="Document legat" />
          <Field label="Acest document este">
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              {Object.entries(LINK_KIND).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          </Field>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Se salvează…' : 'Salvează legătura'}</button>
        </form>
      )}
      {doc.links.length === 0 && !adding && <Empty title="Nu există documente legate." />}
      {doc.links.length > 0 && (
        <ul className="row-list">
          {doc.links.map((link) => (
            <li key={`${link.dir}-${link.kind}-${link.id}`} className="row-static">
              <span className="row-sub">{link.dir === 'catre' ? LINK_KIND[link.kind] ?? link.kind : REVERSE[link.kind] ?? link.kind}</span>
              <Link to={`/documente/${link.id}`}>{link.regLabel ?? 'Fără număr'} · {link.title}</Link>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
