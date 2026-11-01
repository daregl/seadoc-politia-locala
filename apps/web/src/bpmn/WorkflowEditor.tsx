import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useBlocker, useLocation, useNavigate } from 'react-router-dom';
import Modeler from 'bpmn-js/lib/Modeler';
import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-js.css';
import 'bpmn-js/dist/assets/bpmn-font/css/bpmn.css';
import { api, ApiError, errorMessage } from '../api';
import { useUser } from '../auth';
import { Alert, ErrorAlert, Field, Modal, PageHeader } from '../components/Ui';
import { useAsync } from '../hooks';
import type { AssigneeOptions, Meta, WorkflowFull, WorkflowSummary } from '../types';
import { moddleExtensions, NEW_DIAGRAM } from './descriptor';
import { PropertiesPanel } from './PropertiesPanel';
import { seadocModule } from './seadocModule';
import type { Canvas, CommandStack, DiagramElement, ElementRegistry, EventBus, Modeling, Selection } from './services';
import { translateModule } from './translate';

/** Aceeași regulă ca pe server, pentru a vedea dinainte ce cheie primește un flux nou. */
const slugify = (name: string) => name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

type Validation = { state: 'idle' } | { state: 'busy' } | { state: 'done'; errors: string[] } | { state: 'failed'; error: unknown };

export default function WorkflowEditor({ definition, onPublished }: { definition: WorkflowFull | null; onPublished: () => void }) {
  const user = useUser();
  const navigate = useNavigate();
  const location = useLocation();
  // Editorul se remontează după publicare, deci mesajul vine prin starea rutei.
  const published = (location.state as { published?: string } | null)?.published;
  const isAdmin = user.role === 'admin';
  const containerRef = useRef<HTMLDivElement>(null);
  const modelerRef = useRef<Modeler | null>(null);
  const [modeling, setModeling] = useState<Modeling | null>(null);
  const [selection, setSelection] = useState<DiagramElement[]>([]);
  const [, setRevision] = useState(0);
  const [stack, setStack] = useState({ canUndo: false, canRedo: false });
  const [importError, setImportError] = useState(false);
  const dirtyRef = useRef(false);

  const [name, setName] = useState(definition?.name ?? '');
  const [description, setDescription] = useState(definition?.description ?? '');
  const [departmentId, setDepartmentId] = useState(
    definition ? String(definition.departmentId ?? '') : isAdmin ? '' : String(user.departmentId ?? ''),
  );
  const [validation, setValidation] = useState<Validation>({ state: 'idle' });
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<unknown>(null);
  const [nameProblem, setNameProblem] = useState<string | null>(null);

  const options = useAsync(() => api<AssigneeOptions>('/workflows/assignee-options'), []);
  const meta = useAsync(() => api<Meta>('/meta'), []);
  const existing = useAsync(() => (definition ? Promise.resolve([]) : api<WorkflowSummary[]>('/workflows')), [definition]);

  const initialXml = definition?.xml ?? NEW_DIAGRAM;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const modeler = new Modeler({
      container,
      moddleExtensions,
      additionalModules: [translateModule, seadocModule],
    });
    modelerRef.current = modeler;
    const eventBus = modeler.get<EventBus>('eventBus');
    const commandStack = modeler.get<CommandStack>('commandStack');
    const canvas = modeler.get<Canvas>('canvas');
    let cancelled = false;

    eventBus.on<{ newSelection: DiagramElement[] }>('selection.changed', (e) => {
      setSelection(e.newSelection.map((el) => el.labelTarget ?? el));
    });
    eventBus.on('commandStack.changed', () => {
      setRevision((r) => r + 1);
      setStack({ canUndo: commandStack.canUndo(), canRedo: commandStack.canRedo() });
      dirtyRef.current = commandStack.canUndo();
      setValidation({ state: 'idle' });
    });

    modeler.importXML(initialXml).then(() => {
      if (cancelled) return;
      canvas.zoom('fit-viewport', 'auto');
      // Paleta stă peste marginea stângă a pânzei: diagrama se mută în zona liberă.
      canvas.zoom(canvas.zoom() * 0.85, 'auto');
      canvas.scroll({ dx: 36, dy: 0 });
      setModeling(modeler.get<Modeling>('modeling'));
    }).catch((err: unknown) => {
      console.error(err);
      if (!cancelled) setImportError(true);
    });

    const observer = new ResizeObserver(() => canvas.resized());
    observer.observe(container);
    return () => {
      cancelled = true;
      observer.disconnect();
      modelerRef.current = null;
      setModeling(null);
      modeler.destroy();
    };
  }, [initialXml]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirtyRef.current) e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);
  const blocker = useBlocker(useCallback(
    ({ currentLocation, nextLocation }) => dirtyRef.current && currentLocation.pathname !== nextLocation.pathname,
    [],
  ));

  const saveXml = async (): Promise<string> => {
    const modeler = modelerRef.current;
    if (!modeler) throw new Error('Editorul nu este pregătit');
    const { xml } = await modeler.saveXML({ format: true });
    if (!xml) throw new Error('Diagrama nu a putut fi exportată');
    return xml;
  };

  const validate = async () => {
    setValidation({ state: 'busy' });
    try {
      const res = await api<{ errors: string[] }>('/workflows/validate', { method: 'POST', body: { xml: await saveXml() } });
      setValidation({ state: 'done', errors: res.errors });
    } catch (err) {
      setValidation({ state: 'failed', error: err });
    }
  };

  const key = definition?.key ?? slugify(name);
  const clash = !definition && existing.data?.find((f) => f.key === key);

  const askPublish = () => {
    if (!name.trim()) { setNameProblem('Denumirea fluxului este obligatorie.'); return; }
    if (!definition && !key) { setNameProblem('Denumirea trebuie să conțină litere sau cifre.'); return; }
    setNameProblem(null);
    setPublishError(null);
    setConfirmPublish(true);
  };

  const publish = async () => {
    setPublishing(true);
    setPublishError(null);
    try {
      const created = await api<WorkflowSummary>('/workflows', {
        method: 'POST',
        body: {
          key: definition?.key,
          name: name.trim(),
          description: description.trim() || undefined,
          departmentId: departmentId ? Number(departmentId) : null,
          xml: await saveXml(),
        },
      });
      dirtyRef.current = false;
      setConfirmPublish(false);
      navigate(`/fluxuri/${encodeURIComponent(created.key)}`, {
        replace: true,
        state: { published: `Versiunea ${created.version} a fost publicată. Instanțele aflate în derulare rămân pe versiunea cu care au pornit.` },
      });
      if (definition) onPublished();
    } catch (err) {
      setPublishError(err);
      if (err instanceof ApiError && err.errors.length) {
        setValidation({ state: 'done', errors: err.errors });
        setConfirmPublish(false);
      }
    } finally {
      setPublishing(false);
    }
  };

  const focusElement = (message: string) => {
    const modeler = modelerRef.current;
    if (!modeler) return;
    const registry = modeler.get<ElementRegistry>('elementRegistry');
    const id = message.match(/[A-Za-z_][\w-]*/g)?.find((token) => registry.get(token));
    const element = id ? registry.get(id) : undefined;
    if (!element) return;
    modeler.get<Selection>('selection').select(element);
    if (!element.waypoints) modeler.get<Canvas>('canvas').scrollToElement(element, 80);
  };
  const elementInMessage = (message: string) => {
    const modeler = modelerRef.current;
    if (!modeler) return false;
    const registry = modeler.get<ElementRegistry>('elementRegistry');
    return !!message.match(/[A-Za-z_][\w-]*/g)?.some((token) => registry.get(token));
  };

  const departments = useMemo(() => {
    const all = meta.data?.departments ?? [];
    return isAdmin ? all : all.filter((d) => d.id === user.departmentId);
  }, [meta.data, isAdmin, user.departmentId]);

  const selected = selection.length === 1 ? selection[0] : null;
  const nextVersion = definition ? definition.version + 1 : 1;

  return (
    <>
      <PageHeader
        title={definition ? definition.name : 'Flux nou'}
        subtitle={definition ? `Versiunea curentă: ${definition.version}. Publicarea creează versiunea ${nextVersion}.` : 'Noul flux pornește de la o diagramă minimă, de la start la final.'}
        actions={<Link className="btn" to="/fluxuri">Înapoi la fluxuri</Link>}
      />

      {published && <Alert kind="success">{published}</Alert>}
      <Alert kind="info">
        Publicarea creează o versiune nouă. Instanțele aflate în derulare rămân pe versiunea cu care au pornit; versiunea nouă se aplică doar fluxurilor pornite după publicare.
      </Alert>
      <p className="phone-note">Editorul de diagrame se folosește cel mai bine pe un ecran mare.</p>

      <section className="panel" aria-label="Date generale">
        <div className="panel-body form-grid">
          <Field label="Denumire" required error={nameProblem ?? undefined} hint={!definition && key ? `Cheie: ${key}` : undefined}>
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <Field label="Departament" hint={isAdmin ? 'Fără departament, fluxul este disponibil tuturor.' : 'Managerul publică doar pentru departamentul propriu.'}>
            <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} disabled={!isAdmin}>
              {isAdmin && <option value="">Toate departamentele</option>}
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </Field>
          <Field label="Descriere" className="form-grid-full">
            <input value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          {clash && (
            <div className="form-grid-full">
              <Alert kind="warning">
                Există deja fluxul <Link to={`/fluxuri/${encodeURIComponent(clash.key)}`}>{clash.name}</Link> cu aceeași cheie. Publicarea îi va adăuga o versiune nouă. Alegeți altă denumire dacă doriți un flux separat.
              </Alert>
            </div>
          )}
        </div>
      </section>

      <div className="wf-toolbar">
        <div className="wf-toolbar-group">
          <button type="button" className="btn btn-sm" disabled={!stack.canUndo} onClick={() => modelerRef.current?.get<CommandStack>('commandStack').undo()}>Anulează</button>
          <button type="button" className="btn btn-sm" disabled={!stack.canRedo} onClick={() => modelerRef.current?.get<CommandStack>('commandStack').redo()}>Refă</button>
        </div>
        <div className="wf-toolbar-group">
          <button type="button" className="btn" onClick={validate} disabled={validation.state === 'busy' || !modeling}>
            {validation.state === 'busy' ? 'Se validează…' : 'Validează'}
          </button>
          <button type="button" className="btn btn-primary" onClick={askPublish} disabled={!modeling}>Publică</button>
        </div>
      </div>

      {importError && <Alert kind="error">Diagrama nu a putut fi încărcată în editor. XML-ul publicat poate conține elemente incompatibile.</Alert>}
      {validation.state === 'failed' && <ErrorAlert error={validation.error} />}
      {validation.state === 'done' && validation.errors.length === 0 && <Alert kind="success">Fluxul este valid și poate fi publicat.</Alert>}
      {validation.state === 'done' && validation.errors.length > 0 && (
        <Alert kind="error" title={`Fluxul are ${validation.errors.length === 1 ? 'o problemă' : `${validation.errors.length} probleme`} de rezolvat`}>
          <ul className="alert-list">
            {validation.errors.map((message, index) => (
              <li key={index}>
                {message}
                {elementInMessage(message) && (
                  <> <button type="button" className="btn btn-sm btn-link" onClick={() => focusElement(message)}>Arată în diagramă</button></>
                )}
              </li>
            ))}
          </ul>
        </Alert>
      )}

      <div className="wf-editor">
        <div className="wf-canvas" ref={containerRef} />
        <aside className="wf-props" aria-label="Proprietăți element">
          <h2>Proprietăți</h2>
          <ErrorAlert error={options.error} retry={() => void options.reload()} />
          <PropertiesPanel element={selected} count={selection.length} modeling={modeling} options={options.data} meta={meta.data} />
        </aside>
      </div>

      {confirmPublish && (
        <Modal
          title={definition ? `Publicare versiunea ${nextVersion}` : 'Publicare flux nou'}
          onClose={() => setConfirmPublish(false)}
          footer={(
            <>
              <button type="button" className="btn" onClick={() => setConfirmPublish(false)} disabled={publishing}>Renunță</button>
              <button type="button" className="btn btn-primary" onClick={publish} disabled={publishing}>{publishing ? 'Se publică…' : 'Publică'}</button>
            </>
          )}
        >
          <p>Se publică <strong>{name.trim()}</strong> ca versiune nouă. Instanțele aflate în derulare rămân pe versiunea cu care au pornit.</p>
          {publishError ? <Alert kind="error">{errorMessage(publishError)}</Alert> : null}
        </Modal>
      )}
      {blocker.state === 'blocked' && (
        <Modal
          title="Modificări nepublicate"
          onClose={() => blocker.reset()}
          footer={(
            <>
              <button type="button" className="btn" onClick={() => blocker.reset()}>Rămân în editor</button>
              <button type="button" className="btn btn-danger" onClick={() => blocker.proceed()}>Părăsesc pagina</button>
            </>
          )}
        >
          <p>Diagrama are modificări care nu au fost publicate. Dacă părăsiți pagina, ele se pierd.</p>
        </Modal>
      )}
    </>
  );
}
