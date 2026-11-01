const RO: Record<string, string> = {
  'Activate hand tool': 'Instrument de deplasare a diagramei',
  'Activate lasso tool': 'Selecție cu lasou',
  'Activate create/remove space tool': 'Adaugă sau elimină spațiu',
  'Activate global connect tool': 'Conectează două elemente',
  'Create start event': 'Eveniment de start',
  'Create end event': 'Eveniment de final',
  'Create user task': 'Sarcină (avizare, aprobare, semnare, informare)',
  'Create exclusive gateway': 'Poartă exclusivă (se alege o singură cale)',
  'Create parallel gateway': 'Poartă paralelă (căi simultane)',
  'Create task': 'Sarcină',
  'Create gateway': 'Poartă',
  'Create intermediate/boundary event': 'Eveniment intermediar',
  'Create expanded sub-process': 'Subproces',
  'Create pool/participant': 'Participant',
  'Create data object reference': 'Obiect de date',
  'Create data store reference': 'Depozit de date',
  'Create group': 'Grup',
  'Append end event': 'Adaugă eveniment de final',
  'Append user task': 'Adaugă sarcină',
  'Append gateway': 'Adaugă poartă exclusivă',
  'Append parallel gateway': 'Adaugă poartă paralelă',
  'Append task': 'Adaugă sarcină',
  'Append intermediate/boundary event': 'Adaugă eveniment intermediar',
  'Add text annotation': 'Adaugă notă',
  'Connect to other element': 'Conectează cu alt element',
  'Connect using association': 'Conectează prin asociere',
  'Connect using data input association': 'Conectează prin asociere de date',
  'Change element': 'Schimbă elementul',
  'Delete': 'Șterge',
  'Align elements': 'Aliniază elementele',
  'Align elements left': 'Aliniază la stânga',
  'Align elements right': 'Aliniază la dreapta',
  'Align elements center': 'Aliniază pe centru',
  'Align elements top': 'Aliniază sus',
  'Align elements bottom': 'Aliniază jos',
  'Align elements middle': 'Aliniază la mijloc',
  'Distribute elements horizontally': 'Distribuie pe orizontală',
  'Distribute elements vertically': 'Distribuie pe verticală',
  'Search in diagram': 'Caută în diagramă',
  'Open {element}': 'Deschide {element}',
  'Add lane above': 'Adaugă culoar deasupra',
  'Add lane below': 'Adaugă culoar dedesubt',
  'Divide into two lanes': 'Împarte în două culoare',
  'Divide into three lanes': 'Împarte în trei culoare',
};

/** Modulul `translate` din diagram-js: același contract ca implementarea implicită. */
export function translate(template: string, replacements: Record<string, string> = {}): string {
  const text = RO[template] ?? template;
  return text.replace(/{([^}]+)}/g, (_, key: string) => replacements[key] ?? `{${key}}`);
}

export const translateModule = { translate: ['value', translate] };
