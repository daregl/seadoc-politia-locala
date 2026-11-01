import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Search, Star } from 'lucide-react';
import { api, errorMessage } from '../api';
import { useAuth } from '../auth';
import { ERP_KIND_LABEL, erpRecordLabel, ErpPicker, type ErpRecord } from '../components/ErpPicker';
import { Snippet } from '../components/Snippet';
import { Alert, Badge, Empty, ErrorAlert, Field, Loading, PageHeader, Pagination, StatusBadge } from '../components/Ui';
import { fmtDate } from '../format';
import { useAsync, usePageTitle } from '../hooks';
import { DIRECTION_LABELS, DOC_STATUS } from '../labels';
import { indentedFolders } from '../tree';
import type { DocListItem, DocStatus, Meta, Paged } from '../types';

const LIMIT = 25;
const ADVANCED = ['number', 'from', 'to', 'typeId', 'departmentId', 'folderId', 'status', 'direction', 'issuer', 'erpRecordId'];

/** Filtrul după partener, factură sau comandă din datele ERP importate. */
function ErpFilter({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const record = useAsync(() => (value ? api<ErpRecord>(`/erp/records/${value}`) : Promise.resolve(null)), [value]);
  if (!value) return <ErpPicker onPick={(r) => onChange(String(r.id))} label="Partener, factură sau comandă (ERP)" />;
  return (
    <div className="field">
      <span className="field-label">Partener, factură sau comandă (ERP)</span>
      <p className="picked">
        <span>{record.data ? <><strong>{ERP_KIND_LABEL[record.data.kind]}</strong> · {erpRecordLabel(record.data)}</> : 'Se încarcă…'}</span>
        <button type="button" className="btn btn-sm" onClick={() => onChange('')}>Schimbă</button>
      </p>
    </div>
  );
}

export default function DocumentsPage() {
  usePageTitle('Documente');
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const query = params.toString();
  const offset = Number(params.get('offset') ?? 0) || 0;
  const hasAdvanced = useMemo(
    () => [...params.keys()].some((key) => ADVANCED.includes(key) || key.startsWith('meta.')),
    [params],
  );
  const [showAdvanced, setShowAdvanced] = useState(hasAdvanced);
  const meta = useAsync(() => api<Meta>('/meta'), []);
  const list = useAsync(() => {
    const send = new URLSearchParams(query);
    send.set('limit', String(LIMIT));
    return api<Paged<DocListItem>>(`/documents?${send.toString()}`);
  }, [query]);

  // Formularul este o copie locală a filtrelor; se aplică la trimitere.
  const [form, setForm] = useState<Record<string, string>>(() => Object.fromEntries(params.entries()));
  useEffect(() => { setForm(Object.fromEntries(new URLSearchParams(query).entries())); }, [query]);
  const set = (key: string, value: string) => setForm((prev) => ({ ...prev, [key]: value }));

  const apply = (e: FormEvent) => {
    e.preventDefault();
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries(form)) {
      if (value.trim() && key !== 'offset') next.set(key, value.trim());
    }
    setParams(next);
  };
  const clear = () => setParams(params.get('favorites') ? { favorites: '1' } : {});
  const toggleFavorites = () => {
    const next = new URLSearchParams(params);
    next.delete('offset');
    if (next.get('favorites')) next.delete('favorites');
    else next.set('favorites', '1');
    setParams(next);
  };
  const goTo = (nextOffset: number) => {
    const next = new URLSearchParams(params);
    if (nextOffset) next.set('offset', String(nextOffset));
    else next.delete('offset');
    setParams(next);
    window.scrollTo({ top: 0 });
  };

  const selectedType = meta.data?.documentTypes.find((t) => String(t.id) === form.typeId);
  const folderOptions = useMemo(() => indentedFolders(meta.data?.folders ?? []), [meta.data]);
  const [favError, setFavError] = useState<string | null>(null);

  const toggleFavorite = async (doc: DocListItem) => {
    setFavError(null);
    try {
      await api(`/documents/${doc.id}/favorite`, { method: doc.favorite ? 'DELETE' : 'PUT' });
      list.setData((prev) => {
        const current = prev as Paged<DocListItem>;
        const items = current.items.map((d) => (d.id === doc.id ? { ...d, favorite: !doc.favorite } : d));
        return params.get('favorites') && doc.favorite
          ? { total: current.total - 1, items: items.filter((d) => d.id !== doc.id) }
          : { ...current, items };
      });
    } catch (err) {
      setFavError(errorMessage(err));
    }
  };

  const favorites = !!params.get('favorites');
  const activeFilters = [...params.keys()].filter((key) => ADVANCED.includes(key) || key.startsWith('meta.')).length;
  const filtered = query.replace(/(^|&)(favorites|offset)=[^&]*/g, '') !== '';
  return (
    <>
      <PageHeader
        title="Documente"
        actions={can('register') ? <Link to="/documente/nou" className="btn btn-primary phone-only">Înregistrează document</Link> : undefined}
      />

      <form className="search-box" onSubmit={apply} role="search">
        <div className="search-row">
          <div className="search-main">
            <Search size={18} aria-hidden="true" />
            <input
              type="search"
              value={form.q ?? ''}
              onChange={(e) => set('q', e.target.value)}
              placeholder="Titlu, număr sau text"
              aria-label="Căutare în documente"
            />
          </div>
          <button type="submit" className="btn btn-primary">Caută</button>
          <button type="button" className="btn" aria-expanded={showAdvanced} onClick={() => setShowAdvanced(!showAdvanced)}>
            Filtre
            {activeFilters > 0 && <span className="filter-count">({activeFilters})</span>}
          </button>
          <button type="button" className="btn" aria-pressed={favorites} onClick={toggleFavorites}>
            <Star className="star-icon" size={16} aria-hidden="true" />Favorite
          </button>
          {filtered && <button type="button" className="btn btn-ghost" onClick={clear}>Șterge filtrele</button>}
        </div>
        {showAdvanced && (
          <div className="form-grid search-advanced">
            <Field label="Număr de înregistrare">
              <input value={form.number ?? ''} onChange={(e) => set('number', e.target.value)} placeholder="de exemplu 00012/2026" />
            </Field>
            <Field label="De la data"><input type="date" value={form.from ?? ''} onChange={(e) => set('from', e.target.value)} /></Field>
            <Field label="Până la data"><input type="date" value={form.to ?? ''} onChange={(e) => set('to', e.target.value)} /></Field>
            <Field label="Tip document">
              <select
                value={form.typeId ?? ''}
                onChange={(e) => setForm((prev) => {
                  const next = Object.fromEntries(Object.entries(prev).filter(([k]) => !k.startsWith('meta.')));
                  return { ...next, typeId: e.target.value };
                })}
              >
                <option value="">Toate tipurile</option>
                {meta.data?.documentTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
            <Field label="Departament">
              <select value={form.departmentId ?? ''} onChange={(e) => set('departmentId', e.target.value)}>
                <option value="">Toate departamentele</option>
                {meta.data?.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </Field>
            <Field label="Stare">
              <select value={form.status ?? ''} onChange={(e) => set('status', e.target.value)}>
                <option value="">Toate stările</option>
                {(Object.keys(DOC_STATUS) as DocStatus[]).map((s) => <option key={s} value={s}>{DOC_STATUS[s].label}</option>)}
              </select>
            </Field>
            <Field label="Dosar">
              <select value={form.folderId ?? ''} onChange={(e) => set('folderId', e.target.value)}>
                <option value="">Toate dosarele</option>
                {folderOptions.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
              </select>
            </Field>
            <Field label="Direcție">
              <select value={form.direction ?? ''} onChange={(e) => set('direction', e.target.value)}>
                <option value="">Toate</option>
                {Object.entries(DIRECTION_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
            </Field>
            <Field label="Emitent"><input value={form.issuer ?? ''} onChange={(e) => set('issuer', e.target.value)} /></Field>
            <ErpFilter value={form.erpRecordId ?? ''} onChange={(id) => set('erpRecordId', id)} />
            {selectedType?.fields.map((field) => (
              <Field key={field.key} label={`Metadate: ${field.label}`}>
                <input
                  value={form[`meta.${field.key}`] ?? ''}
                  onChange={(e) => set(`meta.${field.key}`, e.target.value)}
                  type={field.type === 'date' ? 'date' : 'text'}
                  inputMode={field.type === 'number' ? 'numeric' : undefined}
                />
              </Field>
            ))}
            {!selectedType && <p className="hint form-grid-full">Alegeți un tip de document pentru a filtra după metadatele lui.</p>}
            <ErrorAlert error={meta.error} retry={() => void meta.reload()} />
            <div className="form-grid-full">
              <button type="submit" className="btn btn-primary">Aplică filtrele</button>
            </div>
          </div>
        )}
      </form>

      {favError && <Alert kind="error">{favError}</Alert>}
      <ErrorAlert error={list.error} retry={() => void list.reload()} />
      {list.loading && !list.data && <Loading />}
      {list.data && list.data.items.length === 0 && (
        <Empty title={filtered || favorites ? 'Niciun document nu corespunde căutării.' : 'Nu există documente la care aveți acces.'}>
          {filtered && <p>Încercați alți termeni sau ștergeți filtrele.</p>}
        </Empty>
      )}
      {list.data && list.data.items.length > 0 && (
        <>
          <div className="table-cards-wrap" aria-busy={list.loading}>
            <table className="table table-cards">
              <caption className="visually-hidden">Lista documentelor</caption>
              <thead>
                <tr>
                  <th scope="col">Număr</th>
                  <th scope="col">Document</th>
                  <th scope="col">Tip</th>
                  <th scope="col">Stare</th>
                  <th scope="col">Termen</th>
                  <th scope="col"><span className="visually-hidden">Favorit</span></th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((doc) => (
                  <tr key={doc.id} onClick={(e) => {
                    if (!(e.target as HTMLElement).closest('a,button') && !window.getSelection()?.toString()) navigate(`/documente/${doc.id}`);
                  }} className="row-clickable">
                    <td data-label="Număr" className="cell-nowrap cell-phone-number">
                      <span className="reg-no">{doc.regLabel ?? '–'}</span>
                      <div className="doc-sub">{fmtDate(doc.regDate ?? doc.createdAt)}</div>
                    </td>
                    <td data-label="Document" className="cell-grow">
                      <Link to={`/documente/${doc.id}`} className="doc-title-link">{doc.title}</Link>
                      {doc.personalData && <> <Badge tone="warning">Date personale</Badge></>}
                      <div className="doc-sub">
                        {[doc.direction ? DIRECTION_LABELS[doc.direction] : null, doc.issuer].filter(Boolean).join(' · ')}
                      </div>
                      <Snippet text={doc.snippet} />
                    </td>
                    <td data-label="Tip" className="cell-phone-inline">
                      {doc.typeName}
                      <div className="doc-sub">{doc.departmentName}</div>
                    </td>
                    <td data-label="Stare" className="cell-phone-plain"><StatusBadge status={doc.status} /></td>
                    <td data-label="Termen" className={`cell-nowrap ${doc.dueDate ? '' : 'cell-phone-hide'}`}>{doc.dueDate ? fmtDate(doc.dueDate) : ''}</td>
                    <td className="cell-fav">
                      <button
                        type="button"
                        className="fav-btn"
                        aria-pressed={doc.favorite}
                        aria-label={doc.favorite ? `Elimină de la favorite: ${doc.title}` : `Adaugă la favorite: ${doc.title}`}
                        onClick={() => void toggleFavorite(doc)}
                      >
                        <Star size={17} aria-hidden="true" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination total={list.data.total} limit={LIMIT} offset={offset} onChange={goTo} />
        </>
      )}
    </>
  );
}
