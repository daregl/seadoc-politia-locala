CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Căutare: aceeași formă pentru "sănătate", "sanatate" și vechile forme cu sedilă.
CREATE TEXT SEARCH CONFIGURATION seadoc (COPY = romanian);
ALTER TEXT SEARCH CONFIGURATION seadoc
  ALTER MAPPING FOR word, hword, hword_part, asciiword, asciihword WITH unaccent, romanian_stem;

CREATE TABLE settings (key text PRIMARY KEY, value jsonb NOT NULL);
INSERT INTO settings VALUES
  ('password_policy', '{"minLength":10,"requireComplexity":true,"expiryDays":180,"maxFailedAttempts":5,"lockMinutes":15}'),
  ('internal_networks', '["127.0.0.0/8","::1/128","10.0.0.0/8","192.168.0.0/16"]');

CREATE TABLE departments (
  id serial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  parent_id int REFERENCES departments(id)
);

CREATE TABLE users (
  id serial PRIMARY KEY,
  username text NOT NULL UNIQUE,
  full_name text NOT NULL,
  email text,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','manager','user','registratura','arhivar')),
  department_id int REFERENCES departments(id),
  job_title text,
  has_token boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  totp_secret text,
  mfa_enabled boolean NOT NULL DEFAULT false,
  last_totp_counter bigint,
  failed_attempts int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  must_change_password boolean NOT NULL DEFAULT false,
  substitute_id int REFERENCES users(id),
  substitute_until date
);
ALTER TABLE departments ADD COLUMN manager_id int REFERENCES users(id);

-- Ajustări individuale peste rol.
CREATE TABLE user_permissions (
  user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission text NOT NULL,
  allowed boolean NOT NULL,
  PRIMARY KEY (user_id, permission)
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mfa_ok boolean NOT NULL DEFAULT false,
  mfa_required boolean NOT NULL DEFAULT false,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE TABLE document_types (
  id serial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  nomenclator_code text NOT NULL,
  retention_years int,              -- NULL = păstrare permanentă
  fields jsonb NOT NULL DEFAULT '[]'
);

CREATE TABLE registers (
  id serial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  code text NOT NULL UNIQUE,
  department_id int REFERENCES departments(id),
  document_type_id int REFERENCES document_types(id),
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE register_counters (
  register_id int NOT NULL REFERENCES registers(id),
  year int NOT NULL,
  last_number int NOT NULL,
  PRIMARY KEY (register_id, year)
);

CREATE TABLE folders (
  id serial PRIMARY KEY,
  name text NOT NULL,
  parent_id int REFERENCES folders(id),
  department_id int REFERENCES departments(id),
  UNIQUE (parent_id, name)
);

CREATE TABLE documents (
  id serial PRIMARY KEY,
  title text NOT NULL,
  direction text CHECK (direction IN ('intrat','iesit','intern')),
  register_id int REFERENCES registers(id),
  reg_number int,
  reg_year int,
  reg_label text,
  reg_date timestamptz,
  issuer text,
  recipient text,
  summary text,
  due_date date,
  document_type_id int NOT NULL REFERENCES document_types(id),
  department_id int NOT NULL REFERENCES departments(id),
  folder_id int REFERENCES folders(id),
  owner_id int NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'inregistrat'
    CHECK (status IN ('inregistrat','in_flux','aprobat','respins','arhivat','eliminat')),
  metadata jsonb NOT NULL DEFAULT '{}',
  personal_data boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  archived_at timestamptz,
  retention_until date,
  content_text text NOT NULL DEFAULT '',
  search tsvector,
  UNIQUE (register_id, reg_year, reg_number)
);
CREATE INDEX documents_search_idx ON documents USING gin (search);
CREATE INDEX documents_department_idx ON documents (department_id);
CREATE INDEX documents_status_idx ON documents (status);
CREATE INDEX documents_title_trgm_idx ON documents USING gin (title gin_trgm_ops);

CREATE OR REPLACE FUNCTION documents_search_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.search :=
    setweight(to_tsvector('seadoc', coalesce(NEW.title,'') || ' ' || coalesce(NEW.reg_label,'')), 'A') ||
    setweight(to_tsvector('seadoc', coalesce(NEW.issuer,'') || ' ' || coalesce(NEW.recipient,'') || ' ' || coalesce(NEW.summary,'')), 'B') ||
    setweight(to_tsvector('seadoc', coalesce((SELECT string_agg(value, ' ') FROM jsonb_each_text(NEW.metadata)), '')), 'C') ||
    setweight(to_tsvector('seadoc', NEW.content_text), 'D');
  RETURN NEW;
END $$;
CREATE TRIGGER documents_search_trg BEFORE INSERT OR UPDATE OF title, reg_label, issuer, recipient, summary, metadata, content_text
  ON documents FOR EACH ROW EXECUTE FUNCTION documents_search_update();

-- Un document arhivat nu se mai poate modifica; singura tranziție este eliminarea aprobată.
CREATE OR REPLACE FUNCTION documents_archive_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'eliminat' THEN
    RAISE EXCEPTION 'Documentul eliminat nu se mai poate modifica';
  END IF;
  IF OLD.status = 'arhivat' AND NEW.status <> 'eliminat' THEN
    RAISE EXCEPTION 'Documentul arhivat nu se mai poate modifica';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER documents_archive_guard_trg BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION documents_archive_guard();

CREATE TABLE document_versions (
  id serial PRIMARY KEY,
  document_id int NOT NULL REFERENCES documents(id),
  version_no int NOT NULL,
  filename text NOT NULL,
  mime text NOT NULL,
  size_bytes bigint NOT NULL,
  sha256 text NOT NULL,
  storage_key text,
  searchable_key text,
  ocr_status text NOT NULL DEFAULT 'in_asteptare'
    CHECK (ocr_status IN ('in_asteptare','in_lucru','finalizat','esuat','neaplicabil')),
  ocr_used boolean NOT NULL DEFAULT false,
  ocr_error text,
  text_content text NOT NULL DEFAULT '',
  created_by int NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, version_no)
);
CREATE INDEX document_versions_sha_idx ON document_versions (sha256);

CREATE OR REPLACE FUNCTION versions_archive_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT status FROM documents WHERE id = NEW.document_id) IN ('arhivat','eliminat') THEN
    RAISE EXCEPTION 'Documentul arhivat nu acceptă versiuni noi';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER versions_archive_guard_trg BEFORE INSERT ON document_versions
  FOR EACH ROW EXECUTE FUNCTION versions_archive_guard();

CREATE TABLE document_links (
  from_id int NOT NULL REFERENCES documents(id),
  to_id int NOT NULL REFERENCES documents(id),
  kind text NOT NULL CHECK (kind IN ('raspuns_la','anexa_la')),
  PRIMARY KEY (from_id, to_id, kind),
  CHECK (from_id <> to_id)
);

-- Documente atribuite explicit unui utilizator (prin flux sau manual).
CREATE TABLE document_access (
  document_id int NOT NULL REFERENCES documents(id),
  user_id int NOT NULL REFERENCES users(id),
  PRIMARY KEY (document_id, user_id)
);

-- Acces controlat pe document, dosar, tip și departament.
CREATE TABLE access_grants (
  id serial PRIMARY KEY,
  user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('document','folder','type','department')),
  target_id int NOT NULL,
  UNIQUE (user_id, scope, target_id)
);

CREATE TABLE favorites (
  user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_id int NOT NULL REFERENCES documents(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, document_id)
);

CREATE TABLE duplicate_matches (
  version_id int NOT NULL REFERENCES document_versions(id),
  document_id int NOT NULL REFERENCES documents(id),
  match_document_id int NOT NULL REFERENCES documents(id),
  match_kind text NOT NULL CHECK (match_kind IN ('amprenta','text','denumire')),
  score real NOT NULL,
  PRIMARY KEY (version_id, match_document_id, match_kind)
);

CREATE TABLE signatures (
  id serial PRIMARY KEY,
  document_id int NOT NULL REFERENCES documents(id),
  version_id int NOT NULL REFERENCES document_versions(id),
  signer_id int NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('interna')),
  sha256 text NOT NULL,
  signed_at timestamptz NOT NULL,
  seal text NOT NULL
);

-- Fluxuri ------------------------------------------------------------------
CREATE TABLE workflow_definitions (
  id serial PRIMARY KEY,
  key text NOT NULL,
  version int NOT NULL,
  name text NOT NULL,
  description text,
  department_id int REFERENCES departments(id),
  xml text NOT NULL,
  created_by int REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (key, version)
);

CREATE TABLE workflow_instances (
  id serial PRIMARY KEY,
  definition_id int NOT NULL REFERENCES workflow_definitions(id),
  document_id int NOT NULL REFERENCES documents(id),
  status text NOT NULL DEFAULT 'activ' CHECK (status IN ('activ','aprobat','respins')),
  started_by int NOT NULL REFERENCES users(id),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE UNIQUE INDEX workflow_one_active_per_document ON workflow_instances (document_id) WHERE status = 'activ';

CREATE TABLE workflow_steps (
  id serial PRIMARY KEY,
  instance_id int NOT NULL REFERENCES workflow_instances(id),
  element_id text NOT NULL,
  element_type text NOT NULL,
  name text,
  completion text,
  status text NOT NULL DEFAULT 'activ' CHECK (status IN ('activ','finalizat','respins','anulat')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz
);
CREATE INDEX workflow_steps_instance_idx ON workflow_steps (instance_id);

-- Tokenii care așteaptă la o poartă paralelă de unire.
CREATE TABLE workflow_join_tokens (
  id serial PRIMARY KEY,
  instance_id int NOT NULL REFERENCES workflow_instances(id),
  element_id text NOT NULL,
  flow_id text NOT NULL
);

CREATE TABLE tasks (
  id serial PRIMARY KEY,
  step_id int NOT NULL REFERENCES workflow_steps(id),
  instance_id int NOT NULL REFERENCES workflow_instances(id),
  document_id int NOT NULL REFERENCES documents(id),
  assignee_id int NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('avizare','aprobare','semnare','informare','completare')),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'deschisa'
    CHECK (status IN ('deschisa','asteapta_completare','finalizata','respinsa','redirectionata','anulata')),
  parent_task_id int REFERENCES tasks(id),
  redirected_from int REFERENCES users(id),
  comment text,
  due_at timestamptz,
  reminded_at timestamptz,
  escalated_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX tasks_assignee_idx ON tasks (assignee_id, status);
CREATE INDEX tasks_due_idx ON tasks (due_at) WHERE status = 'deschisa';

CREATE TABLE notifications (
  id serial PRIMARY KEY,
  user_id int NOT NULL REFERENCES users(id),
  kind text NOT NULL,
  title text NOT NULL,
  document_id int REFERENCES documents(id),
  task_id int REFERENCES tasks(id),
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, read_at);

-- Arhivă --------------------------------------------------------------------
CREATE TABLE elimination_proposals (
  id serial PRIMARY KEY,
  document_id int NOT NULL REFERENCES documents(id),
  proposed_by int NOT NULL REFERENCES users(id),
  proposed_at timestamptz NOT NULL DEFAULT now(),
  reason text,
  status text NOT NULL DEFAULT 'propusa' CHECK (status IN ('propusa','aprobata','respinsa')),
  decided_by int REFERENCES users(id),
  decided_at timestamptz
);
CREATE UNIQUE INDEX elimination_one_open ON elimination_proposals (document_id) WHERE status = 'propusa';

-- Audit: rândurile nu se pot modifica sau șterge, iar lanțul de hash-uri arată orice alterare.
CREATE TABLE audit_log (
  seq bigint PRIMARY KEY,
  at timestamptz NOT NULL,
  user_id int,
  username text,
  action text NOT NULL,
  document_id int,
  ip text,
  details jsonb NOT NULL DEFAULT '{}',
  prev_hash text NOT NULL,
  hash text NOT NULL
);
CREATE SEQUENCE audit_log_seq;
CREATE INDEX audit_log_document_idx ON audit_log (document_id);
CREATE INDEX audit_log_action_idx ON audit_log (action);
CREATE INDEX audit_log_at_idx ON audit_log (at);

CREATE OR REPLACE FUNCTION audit_row_hash(prev text, r audit_log) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(concat_ws('|', prev, r.seq,
    to_char(r.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    coalesce(r.user_id::text, ''), coalesce(r.username, ''), r.action,
    coalesce(r.document_id::text, ''), coalesce(r.ip, ''), r.details::text), 'UTF8')), 'hex')
$$;

CREATE OR REPLACE FUNCTION audit_log_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE last_hash text;
BEGIN
  PERFORM pg_advisory_xact_lock(727001);
  SELECT hash INTO last_hash FROM audit_log ORDER BY seq DESC LIMIT 1;
  NEW.seq := nextval('audit_log_seq');
  NEW.at := clock_timestamp();
  NEW.prev_hash := coalesce(last_hash, '');
  NEW.hash := audit_row_hash(NEW.prev_hash, NEW);
  RETURN NEW;
END $$;
CREATE TRIGGER audit_log_chain_trg BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_chain();

CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Jurnalul de audit nu poate fi modificat';
END $$;
CREATE TRIGGER audit_log_no_change BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();
