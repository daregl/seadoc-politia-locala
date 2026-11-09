-- Registratură: anulare, documente conexe, documente confidențiale ------------

ALTER TABLE documents DROP CONSTRAINT documents_status_check;
ALTER TABLE documents ADD CONSTRAINT documents_status_check
  CHECK (status IN ('inregistrat','in_flux','aprobat','respins','arhivat','eliminat','anulat'));
ALTER TABLE documents
  ADD COLUMN cancel_reason text,
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN cancelled_by int REFERENCES users(id),
  -- Un document confidențial se vede doar de proprietar, de cei cărora li s-a dat explicit și de administrator.
  ADD COLUMN confidential boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT documents_cancel_check CHECK ((status = 'anulat') = (cancel_reason IS NOT NULL));

ALTER TABLE document_links DROP CONSTRAINT document_links_kind_check;
ALTER TABLE document_links ADD CONSTRAINT document_links_kind_check CHECK (kind IN ('raspuns_la','anexa_la','conex'));

-- Numărul anulat rămâne în registru; înregistrarea nu se mai poate modifica.
CREATE OR REPLACE FUNCTION documents_archive_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'eliminat' THEN
    RAISE EXCEPTION 'Documentul eliminat nu se mai poate modifica';
  END IF;
  IF OLD.status = 'anulat' THEN
    RAISE EXCEPTION 'Înregistrarea anulată nu se mai poate modifica';
  END IF;
  IF OLD.status = 'arhivat' AND NEW.status <> 'eliminat' THEN
    RAISE EXCEPTION 'Documentul arhivat nu se mai poate modifica';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION versions_archive_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT status FROM documents WHERE id = NEW.document_id) IN ('arhivat','eliminat','anulat') THEN
    RAISE EXCEPTION 'Documentul arhivat sau anulat nu acceptă versiuni noi';
  END IF;
  RETURN NEW;
END $$;

-- Lucrări: petiții, cereri pe Legea 544/2001, dosare contravenționale, acțiuni de control --

CREATE TABLE case_counters (
  kind text NOT NULL,
  year int NOT NULL,
  last_number int NOT NULL,
  PRIMARY KEY (kind, year)
);

CREATE TABLE cases (
  id serial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('petitie','informatii_publice','contraventie','control')),
  reg_year int NOT NULL,
  reg_number int NOT NULL,
  reg_label text NOT NULL,
  subject text NOT NULL,
  applicant_name text,
  applicant_address text,
  applicant_email text,
  applicant_phone text,
  anonymous boolean NOT NULL DEFAULT false,
  channel text,                              -- scris, email, verbal, telefon, audiență, din oficiu
  location text,                             -- adresa sau obiectivul, pentru istoric
  received_on date NOT NULL,
  base_days int,                             -- termenul legal în zile; NULL = fără termen calculat
  extension_days int NOT NULL DEFAULT 0,
  extension_reason text,
  manual_due_on date,                        -- termen stabilit de mână (acțiuni de control)
  status text NOT NULL DEFAULT 'deschisa' CHECK (status IN ('deschisa','inchisa')),
  outcome text,
  resolution_note text,
  redirected_to text,
  parent_id int REFERENCES cases(id),        -- conexată la / acțiunea de control din care provine
  department_id int NOT NULL REFERENCES departments(id),
  assignee_id int REFERENCES users(id),
  answer_communicated_on date,
  details jsonb NOT NULL DEFAULT '{}',
  created_by int NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  reminded_at timestamptz,
  escalated_at timestamptz,
  UNIQUE (kind, reg_year, reg_number),
  CHECK (extension_days >= 0),
  CHECK ((status = 'inchisa') = (outcome IS NOT NULL AND closed_at IS NOT NULL)),
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX cases_kind_status_idx ON cases (kind, status);
CREATE INDEX cases_department_idx ON cases (department_id);
CREATE INDEX cases_assignee_idx ON cases (assignee_id) WHERE status = 'deschisa';
CREATE INDEX cases_location_trgm_idx ON cases USING gin (location gin_trgm_ops);
CREATE INDEX cases_received_idx ON cases (received_on);

-- Petițiile cu obiect multiplu: fiecare obiect are compartimentul și răspunsul lui.
CREATE TABLE case_objects (
  id serial PRIMARY KEY,
  case_id int NOT NULL REFERENCES cases(id),
  text text NOT NULL,
  department_id int REFERENCES departments(id),
  assignee_id int REFERENCES users(id),
  status text NOT NULL DEFAULT 'deschis' CHECK (status IN ('deschis','solutionat')),
  answer text,
  created_at timestamptz NOT NULL DEFAULT now(),
  solved_at timestamptz
);
CREATE INDEX case_objects_case_idx ON case_objects (case_id);

CREATE TABLE case_documents (
  case_id int NOT NULL REFERENCES cases(id),
  document_id int NOT NULL REFERENCES documents(id),
  role text NOT NULL CHECK (role IN ('principal','raspuns','adresa','proces_verbal','plangere','hotarare','dovada','anexa','alt')),
  added_by int NOT NULL REFERENCES users(id),
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, document_id)
);
CREATE INDEX case_documents_document_idx ON case_documents (document_id);

-- Istoricul lucrării, în ordine; aceleași acțiuni intră și în jurnalul de audit.
CREATE TABLE case_events (
  id serial PRIMARY KEY,
  case_id int NOT NULL REFERENCES cases(id),
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  user_id int REFERENCES users(id),
  kind text NOT NULL,
  note text,
  data jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX case_events_case_idx ON case_events (case_id, id);

-- Fotografiile din teren, stocate criptat, cu locul de unde au fost făcute dacă telefonul îl dă.
CREATE TABLE case_photos (
  id serial PRIMARY KEY,
  case_id int NOT NULL REFERENCES cases(id),
  filename text NOT NULL,
  mime text NOT NULL,
  size_bytes bigint NOT NULL,
  sha256 text NOT NULL,
  storage_key text NOT NULL,
  latitude double precision,
  longitude double precision,
  note text,
  created_by int NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX case_photos_case_idx ON case_photos (case_id);

-- Dosarul contravențional (OG 2/2001): un rând pentru fiecare proces-verbal.
CREATE TABLE case_contraventions (
  case_id int PRIMARY KEY REFERENCES cases(id),
  pv_series text NOT NULL,
  pv_number text NOT NULL,
  offender_name text NOT NULL,
  offender_id_code text,
  offender_address text,
  fact text NOT NULL,
  legal_basis text NOT NULL,
  sanction text NOT NULL CHECK (sanction IN ('amenda','avertisment')),
  amount numeric(12,2),
  min_amount numeric(12,2),
  agent_id int REFERENCES users(id),
  observed_at timestamptz,
  applied_on date NOT NULL,
  communicated_on date,
  communication_method text CHECK (communication_method IN ('inmanare','posta','afisare')),
  paid_on date,
  paid_amount numeric(12,2),
  complaint_filed_on date,
  court text,
  court_file text,
  decision_on date,
  decision_outcome text CHECK (decision_outcome IN ('plangere_respinsa','plangere_admisa','admisa_partial','inlocuire_avertisment')),
  execution_sent_on date,
  execution_body text,
  UNIQUE (pv_series, pv_number),
  CHECK (sanction <> 'amenda' OR amount IS NOT NULL)
);

-- Expedierea documentelor și dovada comunicării ----------------------------

CREATE TABLE dispatches (
  id serial PRIMARY KEY,
  document_id int REFERENCES documents(id),
  case_id int REFERENCES cases(id),
  method text NOT NULL CHECK (method IN ('posta','posta_recomandata','email','curier','inmanare','fax','afisare')),
  recipient text NOT NULL,
  address text,
  sent_on date NOT NULL,
  tracking text,
  note text,
  delivered_on date,
  proof_filename text,
  proof_mime text,
  proof_sha256 text,
  proof_key text,
  created_by int NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (document_id IS NOT NULL OR case_id IS NOT NULL)
);
CREATE INDEX dispatches_document_idx ON dispatches (document_id);
CREATE INDEX dispatches_case_idx ON dispatches (case_id);

-- Șabloane pentru documentele generate --------------------------------------

CREATE TABLE document_templates (
  id serial PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  case_kind text CHECK (case_kind IN ('petitie','informatii_publice','contraventie','control')),
  case_role text NOT NULL DEFAULT 'adresa',
  title text NOT NULL,
  body text NOT NULL,
  document_type_id int REFERENCES document_types(id),
  register_id int REFERENCES registers(id),
  active boolean NOT NULL DEFAULT true,
  updated_by int REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO settings (key, value) VALUES
  ('institution', '{"name": "Poliția Locală", "address": "", "phone": "", "email": "", "leader": "", "leaderTitle": "Director executiv"}')
ON CONFLICT (key) DO NOTHING;

INSERT INTO document_templates (code, name, case_kind, case_role, title, body) VALUES
('petitie_raspuns', 'Răspuns la petiție', 'petitie', 'raspuns', 'Răspuns la petiția nr. {{numar_lucrare}}',
'Către: {{petent}}
{{adresa_petent}}

Stimată doamnă / Stimate domn,

Ca urmare a petiției dumneavoastră, înregistrată la {{institutie}} cu nr. {{numar_lucrare}} din {{data_primirii}}, având ca obiect „{{obiect}}”, vă comunicăm următoarele:

{{solutie}}

Răspunsul este formulat în temeiul Ordonanței Guvernului nr. 27/2002 privind reglementarea activității de soluționare a petițiilor.

{{conducator_functie}},
{{conducator}}

Întocmit: {{responsabil}}'),
('petitie_prelungire', 'Înștiințare de prelungire a termenului (petiție)', 'petitie', 'adresa', 'Prelungirea termenului pentru petiția nr. {{numar_lucrare}}',
'Către: {{petent}}
{{adresa_petent}}

Vă aducem la cunoștință că, pentru soluționarea petiției dumneavoastră nr. {{numar_lucrare}} din {{data_primirii}}, sunt necesare verificări suplimentare. În temeiul art. 9 din O.G. nr. 27/2002, termenul de soluționare se prelungește cu {{zile_prelungire}} zile, până la {{termen}}.

Motivul prelungirii: {{motiv_prelungire}}

{{conducator_functie}},
{{conducator}}'),
('petitie_redirectionare_petent', 'Înștiințarea petentului despre redirecționare', 'petitie', 'adresa', 'Redirecționarea petiției nr. {{numar_lucrare}}',
'Către: {{petent}}
{{adresa_petent}}

Vă comunicăm că petiția dumneavoastră nr. {{numar_lucrare}} din {{data_primirii}}, având ca obiect „{{obiect}}”, nu intră în competența {{institutie}}. În temeiul art. 6^1 din O.G. nr. 27/2002, aceasta a fost transmisă spre soluționare către: {{institutie_competenta}}.

{{conducator_functie}},
{{conducator}}'),
('petitie_redirectionare_institutie', 'Adresă de transmitere către instituția competentă', 'petitie', 'adresa', 'Transmiterea petiției nr. {{numar_lucrare}} către {{institutie_competenta}}',
'Către: {{institutie_competenta}}

Vă transmitem, spre competentă soluționare, petiția doamnei / domnului {{petent}}, înregistrată la {{institutie}} cu nr. {{numar_lucrare}} din {{data_primirii}}, având ca obiect „{{obiect}}”.

Petentul a fost înștiințat despre această transmitere, conform art. 6^1 din O.G. nr. 27/2002.

{{conducator_functie}},
{{conducator}}'),
('petitie_clasare', 'Notă de clasare', 'petitie', 'adresa', 'Notă de clasare a petiției nr. {{numar_lucrare}}',
'Petiția nr. {{numar_lucrare}} din {{data_primirii}}, având ca obiect „{{obiect}}”, se clasează.

Motivul clasării: {{solutie}}

Întocmit: {{responsabil}}
Data: {{data}}'),
('info544_raspuns', 'Răspuns la cererea de informații publice', 'informatii_publice', 'raspuns', 'Răspuns la cererea nr. {{numar_lucrare}} (Legea 544/2001)',
'Către: {{petent}}
{{adresa_petent}}

Ca răspuns la cererea dumneavoastră nr. {{numar_lucrare}} din {{data_primirii}}, formulată în temeiul Legii nr. 544/2001 privind liberul acces la informațiile de interes public, prin care solicitați „{{obiect}}”, vă comunicăm următoarele:

{{solutie}}

{{conducator_functie}},
{{conducator}}'),
('info544_prelungire', 'Înștiințare de prelungire la 30 de zile (Legea 544/2001)', 'informatii_publice', 'adresa', 'Prelungirea termenului pentru cererea nr. {{numar_lucrare}}',
'Către: {{petent}}
{{adresa_petent}}

Vă aducem la cunoștință că, având în vedere complexitatea informațiilor solicitate prin cererea nr. {{numar_lucrare}} din {{data_primirii}}, răspunsul vă va fi comunicat până la {{termen}}, în termenul de 30 de zile prevăzut de art. 7 alin. (1) din Legea nr. 544/2001.

{{conducator_functie}},
{{conducator}}'),
('info544_refuz', 'Refuz motivat (Legea 544/2001)', 'informatii_publice', 'raspuns', 'Răspuns la cererea nr. {{numar_lucrare}} (refuz)',
'Către: {{petent}}
{{adresa_petent}}

Referitor la cererea dumneavoastră nr. {{numar_lucrare}} din {{data_primirii}}, vă comunicăm că informațiile solicitate nu pot fi furnizate, pentru următorul motiv:

{{solutie}}

Împotriva acestui refuz puteți depune reclamație administrativă, în termen de 30 de zile, conform art. 21 din Legea nr. 544/2001, sau vă puteți adresa instanței de contencios administrativ, conform art. 22.

{{conducator_functie}},
{{conducator}}'),
('pv_contraventie', 'Proces-verbal de constatare a contravenției', 'contraventie', 'proces_verbal', 'Proces-verbal seria {{pv_serie}} nr. {{pv_numar}}',
'PROCES-VERBAL DE CONSTATARE ȘI SANCȚIONARE A CONTRAVENȚIEI
Seria {{pv_serie}} nr. {{pv_numar}}

Încheiat la data de {{data_aplicarii}}, de subsemnatul {{agent}}, agent constatator în cadrul {{institutie}}.

Contravenient: {{contravenient}}
Cod de identificare: {{cod_contravenient}}
Domiciliu / sediu: {{adresa_contravenient}}

Data și ora constatării: {{data_constatarii}}
Locul constatării: {{adresa}}

Descrierea faptei: {{fapta}}

Fapta constituie contravenție și se sancționează conform: {{temei}}

Sancțiunea aplicată: {{sanctiune}}

Contravenientul poate achita, în termen de cel mult 15 zile de la data înmânării sau comunicării procesului-verbal, jumătate din minimul amenzii prevăzute de actul normativ, respectiv {{jumatate_minim}} lei.

Împotriva prezentului proces-verbal se poate formula plângere în termen de 15 zile de la data înmânării sau comunicării, la judecătoria în a cărei circumscripție a fost săvârșită contravenția.

Agent constatator: {{agent}}                Contravenient: ________________'),
('pv_executare', 'Adresă de trimitere spre executare silită', 'contraventie', 'adresa', 'Trimiterea spre executare a PV seria {{pv_serie}} nr. {{pv_numar}}',
'Către: {{organ_executare}}

Vă transmitem, în vederea executării silite, conform art. 39 din O.G. nr. 2/2001, procesul-verbal de constatare și sancționare a contravenției seria {{pv_serie}} nr. {{pv_numar}} din {{data_aplicarii}}, privind pe {{contravenient}} ({{cod_contravenient}}), domiciliat în {{adresa_contravenient}}.

Sancțiunea aplicată: {{sanctiune}}
Data comunicării: {{data_comunicarii}}

Procesul-verbal nu a fost achitat și nu a fost contestat în termenul legal{{mentiune_hotarare}}.

{{conducator_functie}},
{{conducator}}'),
('control_proces_verbal', 'Proces-verbal de control', 'control', 'proces_verbal', 'Proces-verbal de control nr. {{numar_lucrare}}',
'PROCES-VERBAL DE CONTROL
nr. {{numar_lucrare}} din {{data}}

Obiectivul controlat: {{adresa}}
Tema controlului: {{obiect}}
Echipa de control: {{echipa}}

Constatări:
{{constatari}}

Măsuri dispuse:
{{solutie}}

Echipa de control:                         Reprezentantul obiectivului:
{{echipa}}                                  ________________');

-- Intranet --------------------------------------------------------------------

CREATE TABLE intranet_posts (
  id serial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('anunt','procedura')),
  title text NOT NULL,
  body text NOT NULL,
  department_id int REFERENCES departments(id),   -- NULL = toată instituția
  document_id int REFERENCES documents(id),
  pinned boolean NOT NULL DEFAULT false,
  requires_ack boolean NOT NULL DEFAULT false,
  expires_on date,
  published_by int NOT NULL REFERENCES users(id),
  published_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz
);
CREATE INDEX intranet_posts_published_idx ON intranet_posts (published_at DESC);

CREATE TABLE intranet_reads (
  post_id int NOT NULL REFERENCES intranet_posts(id),
  user_id int NOT NULL REFERENCES users(id),
  read_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  PRIMARY KEY (post_id, user_id)
);

-- Tokenuri pentru integrări (contabilitate, HR, email, semnătură) -------------

CREATE TABLE api_tokens (
  id serial PRIMARY KEY,
  user_id int NOT NULL REFERENCES users(id),
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  prefix text NOT NULL,
  expires_on date,
  created_by int NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

-- Notificările pot trimite la o lucrare sau la Intranet, nu doar la un document.
ALTER TABLE notifications ADD COLUMN link text;
