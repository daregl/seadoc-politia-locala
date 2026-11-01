import { useMemo, useState } from 'react';
import { roleLabel } from '../labels';
import type { AssigneeOptions, Meta } from '../types';
import { Field } from '../components/Ui';
import { isType, type DiagramElement, type ModdleObject, type Modeling } from './services';

const ASSIGNEE_TYPES: { value: string; label: string; needsValues: boolean; hint?: string }[] = [
  { value: 'functie', label: 'Funcție din organigramă', needsValues: true },
  { value: 'rol', label: 'Rol', needsValues: true },
  { value: 'utilizator', label: 'Utilizator anume', needsValues: true },
  { value: 'manager_departament', label: 'Managerul departamentului documentului', needsValues: false },
  { value: 'initiator', label: 'Inițiatorul fluxului', needsValues: false },
];
const ACTIONS = [
  { value: 'avizare', label: 'Avizare' },
  { value: 'aprobare', label: 'Aprobare' },
  { value: 'semnare', label: 'Semnare (semnătură electronică internă)' },
  { value: 'informare', label: 'Informare' },
];
const COMPLETIONS = [
  { value: 'any', label: 'Oricare aprobă' },
  { value: 'all', label: 'Toți aprobă' },
  { value: 'majority', label: 'Majoritate' },
];
const TYPE_NAMES: Record<string, string> = {
  'bpmn:StartEvent': 'Eveniment de start',
  'bpmn:EndEvent': 'Eveniment de final',
  'bpmn:UserTask': 'Sarcină',
  'bpmn:ExclusiveGateway': 'Poartă exclusivă',
  'bpmn:ParallelGateway': 'Poartă paralelă',
  'bpmn:SequenceFlow': 'Legătură',
};
const SUPPORTED = Object.keys(TYPE_NAMES);

const text = (bo: ModdleObject, name: string): string => {
  const value = bo.get(name);
  return value === undefined || value === null ? '' : String(value);
};
const splitValues = (raw: string) => raw.split(',').map((v) => v.trim()).filter(Boolean);

export function PropertiesPanel({ element, count, modeling, options, meta }: {
  element: DiagramElement | null;
  count: number;
  modeling: Modeling | null;
  options: AssigneeOptions | undefined;
  meta: Meta | undefined;
}) {
  if (count > 1) return <p className="muted">Ați selectat {count} elemente. Alegeți unul singur pentru a-i edita proprietățile.</p>;
  if (!element || !modeling) {
    return (
      <div>
        <p>Alegeți un element din diagramă pentru a-i edita proprietățile.</p>
        <p className="muted">Trageți elemente din paleta din stânga, apoi conectați-le. Fiecare sarcină are nevoie de un titular.</p>
      </div>
    );
  }
  const bo = element.businessObject;
  const update = (props: Record<string, unknown>) => modeling.updateProperties(element, props);

  if (!SUPPORTED.some((type) => bo.$type === type)) {
    return (
      <div className="prop-warning" role="alert">
        <strong>Element neacceptat</strong>
        <p>Motorul de fluxuri nu acceptă elementele de tip {bo.$type.replace('bpmn:', '')}. Ștergeți-l și folosiți elementele din paletă.</p>
      </div>
    );
  }

  return (
    <div className="prop-form">
      <p className="prop-type">{TYPE_NAMES[bo.$type]}</p>
      <Field label="Denumire">
        <input value={bo.name ?? ''} onChange={(e) => update({ name: e.target.value || undefined })} />
      </Field>
      {isType(element, 'bpmn:UserTask') && <UserTaskFields bo={bo} update={update} options={options} />}
      {isType(element, 'bpmn:SequenceFlow') && <FlowFields element={element} update={update} modeling={modeling} meta={meta} />}
      <p className="prop-id muted">Identificator: {element.id}</p>
    </div>
  );
}

function UserTaskFields({ bo, update, options }: {
  bo: ModdleObject; update: (props: Record<string, unknown>) => void; options: AssigneeOptions | undefined;
}) {
  const assigneeType = text(bo, 'seadoc:assigneeType');
  const info = ASSIGNEE_TYPES.find((t) => t.value === assigneeType);
  const missing = !assigneeType || (info?.needsValues && !splitValues(text(bo, 'seadoc:assignee')).length);
  return (
    <>
      <Field label="Tip titular" required>
        <select
          value={assigneeType}
          onChange={(e) => update({ 'seadoc:assigneeType': e.target.value || undefined, 'seadoc:assignee': undefined })}
        >
          <option value="">Alegeți</option>
          {ASSIGNEE_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </Field>
      {info?.needsValues && (
        <AssigneeValues
          type={assigneeType}
          value={text(bo, 'seadoc:assignee')}
          options={options}
          onChange={(value) => update({ 'seadoc:assignee': value || undefined })}
        />
      )}
      {missing && <p className="field-error">Sarcina nu are încă titular.</p>}
      <Field label="Acțiune">
        <select value={text(bo, 'seadoc:action') || 'avizare'} onChange={(e) => update({ 'seadoc:action': e.target.value })}>
          {ACTIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
        </select>
      </Field>
      <Field label="Termen (ore)" hint="Gol înseamnă fără termen.">
        <input
          type="number"
          min={1}
          step={1}
          inputMode="numeric"
          value={text(bo, 'seadoc:dueHours')}
          onChange={(e) => update({ 'seadoc:dueHours': e.target.value || undefined })}
        />
      </Field>
      <Field label="Condiție de finalizare" hint="Se aplică atunci când titularul rezolvă mai multe persoane.">
        <select value={text(bo, 'seadoc:completion') || 'any'} onChange={(e) => update({ 'seadoc:completion': e.target.value })}>
          {COMPLETIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </Field>
    </>
  );
}

function AssigneeValues({ type, value, options, onChange }: {
  type: string; value: string; options: AssigneeOptions | undefined; onChange: (value: string) => void;
}) {
  const [filter, setFilter] = useState('');
  const selected = useMemo(() => splitValues(value), [value]);
  const available = useMemo(() => {
    if (!options) return [];
    if (type === 'functie') return options.jobTitles.map((v) => ({ value: v, label: v }));
    if (type === 'rol') return options.roles.map((v) => ({ value: v, label: roleLabel(v) }));
    return options.users.map((u) => ({
      value: u.username,
      label: `${u.fullName}${u.jobTitle ? `, ${u.jobTitle}` : ''}${u.departmentName ? ` (${u.departmentName})` : ''}`,
    }));
  }, [options, type]);
  // Valorile salvate care nu mai există în organigramă rămân vizibile, ca să poată fi debifate.
  const orphans = selected.filter((v) => options && !available.some((a) => a.value.toLowerCase() === v.toLowerCase()));
  const term = filter.trim().toLocaleLowerCase('ro');
  const shown = available.filter((a) => !term || a.label.toLocaleLowerCase('ro').includes(term));
  const toggle = (item: string, on: boolean) => {
    const next = on ? [...selected, item] : selected.filter((v) => v.toLowerCase() !== item.toLowerCase());
    onChange(next.join(','));
  };
  const isOn = (item: string) => selected.some((v) => v.toLowerCase() === item.toLowerCase());
  const legend = type === 'functie' ? 'Funcții' : type === 'rol' ? 'Roluri' : 'Utilizatori';

  return (
    <fieldset className="fieldset prop-values">
      <legend>{legend} <span className="required" title="Câmp obligatoriu">*</span></legend>
      {!options && <p className="muted">Se încarcă opțiunile…</p>}
      {options && available.length > 6 && (
        <input type="search" aria-label={`Filtrează ${legend.toLowerCase()}`} placeholder="Filtrează" value={filter} onChange={(e) => setFilter(e.target.value)} />
      )}
      {options && available.length === 0 && orphans.length === 0 && <p className="muted">Nu există opțiuni disponibile.</p>}
      <div className="prop-checks">
        {orphans.map((v) => (
          <label key={v} className="check check-warning">
            <input type="checkbox" checked onChange={() => toggle(v, false)} />
            <span>{v} <span className="hint">(nu mai există)</span></span>
          </label>
        ))}
        {shown.map((a) => (
          <label key={a.value} className="check">
            <input type="checkbox" checked={isOn(a.value)} onChange={(e) => toggle(a.value, e.target.checked)} />
            <span>{a.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function FlowFields({ element, update, modeling, meta }: {
  element: DiagramElement; update: (props: Record<string, unknown>) => void; modeling: Modeling; meta: Meta | undefined;
}) {
  const source = element.source;
  if (!isType(source, 'bpmn:ExclusiveGateway') || !source) {
    return <p className="muted">Doar legăturile care ies dintr-o poartă exclusivă pot avea condiții.</p>;
  }
  const bo = element.businessObject;
  const condition = text(bo, 'seadoc:condition');
  const isDefault = source.businessObject.default === bo;
  const invalid = condition && !/^\s*[\p{L}\p{N}_.-]+\s*=\s*\S/u.test(condition);
  const keys = [...new Set((meta?.documentTypes ?? []).flatMap((t) => t.fields.map((f) => f.key)))].sort();
  return (
    <>
      <label className="check">
        <input
          type="checkbox"
          checked={isDefault}
          onChange={(e) => modeling.updateProperties(source, { default: e.target.checked ? element : undefined })}
        />
        <span>Cale implicită <span className="hint">Se urmează când nicio condiție nu este îndeplinită.</span></span>
      </label>
      <Field
        label="Condiție"
        hint={<>Forma: <code>camp = valoare</code>. Câmpuri: <code>tip</code>, <code>departament</code>{keys.length > 0 && <> sau metadate: {keys.map((k, i) => <span key={k}>{i > 0 && ', '}<code>{k}</code></span>)}</>}.</>}
        error={invalid ? 'Condiția trebuie să aibă forma „camp = valoare”.' : undefined}
      >
        <input
          value={condition}
          disabled={isDefault}
          onChange={(e) => update({ 'seadoc:condition': e.target.value || undefined })}
          placeholder="de exemplu tip = Contract"
        />
      </Field>
    </>
  );
}
