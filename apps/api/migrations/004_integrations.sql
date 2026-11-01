-- Integrări: autentificare centralizată (LDAP/AD, OIDC), date ERP importate, migrarea arhivei.

-- Surse de autentificare ------------------------------------------------------
-- 'local' = parolă în aplicație; 'ldap' = bind în director, fără parolă stocată; 'oidc' = doar prin furnizorul SSO.
ALTER TABLE users
  ADD COLUMN auth_source text NOT NULL DEFAULT 'local' CHECK (auth_source IN ('local','ldap','oidc')),
  ADD COLUMN ldap_dn text,
  -- Doar sincronizarea reactivează conturile pe care ea le-a dezactivat, nu pe cele oprite de un administrator.
  ADD COLUMN deactivated_by_sync boolean NOT NULL DEFAULT false,
  ADD COLUMN oidc_issuer text,
  ADD COLUMN oidc_subject text;
CREATE UNIQUE INDEX users_oidc_subject_idx ON users (oidc_issuer, oidc_subject) WHERE oidc_subject IS NOT NULL;

-- Stările OIDC în curs: de unică folosință, legate de browserul care a pornit autentificarea.
CREATE TABLE oidc_login_states (
  state_hash text PRIMARY KEY,
  browser_hash text NOT NULL,
  nonce text NOT NULL,
  code_verifier text NOT NULL,
  return_to text,
  expires_at timestamptz NOT NULL
);

-- Date ERP importate ----------------------------------------------------------
CREATE TABLE erp_records (
  id serial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('partener','factura','comanda')),
  external_id text NOT NULL,
  source text NOT NULL DEFAULT 'csv',
  name text,
  number text,
  tax_id text,
  -- Legătura factură/comandă → partener rămâne prin id extern: fișierele pot veni în orice ordine.
  partner_external_id text,
  issue_date date,
  due_date date,
  amount numeric(18,2),
  currency text,
  status text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, external_id),
  CHECK (name IS NOT NULL OR number IS NOT NULL)
);
CREATE INDEX erp_records_name_trgm_idx ON erp_records USING gin (name gin_trgm_ops);
CREATE INDEX erp_records_number_trgm_idx ON erp_records USING gin (number gin_trgm_ops);
CREATE INDEX erp_records_partner_idx ON erp_records (partner_external_id);

CREATE TABLE document_erp_links (
  document_id int NOT NULL REFERENCES documents(id),
  record_id int NOT NULL REFERENCES erp_records(id),
  created_by int REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, record_id)
);
CREATE INDEX document_erp_links_record_idx ON document_erp_links (record_id);

-- Migrarea arhivei ------------------------------------------------------------
CREATE TABLE migration_runs (
  id serial PRIMARY KEY,
  source_name text NOT NULL,
  source_root text NOT NULL,
  inventory_file text,
  inventory_sha256 text NOT NULL,
  mapping_sha256 text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('simulare','import')),
  status text NOT NULL DEFAULT 'in_curs' CHECK (status IN ('in_curs','finalizat','intrerupt')),
  operator text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  counts jsonb NOT NULL DEFAULT '{}',
  report jsonb,
  report_ok boolean,
  report_at timestamptz,
  report_csv_key text,
  report_pdf_key text
);

CREATE TABLE migration_items (
  id bigserial PRIMARY KEY,
  run_id int NOT NULL REFERENCES migration_runs(id),
  source_name text NOT NULL,
  rel_path text NOT NULL,
  size_bytes bigint,
  sha256 text,
  status text NOT NULL DEFAULT 'in_asteptare'
    CHECK (status IN ('in_asteptare','simulat','importat','sarit','ignorat','refuzat','esuat','coliziune')),
  document_id int REFERENCES documents(id),
  version_id int REFERENCES document_versions(id),
  reg_label text,
  detail text,
  verify_status text CHECK (verify_status IN ('ok','nepotrivire','eliminat')),
  verified_sha256 text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, rel_path)
);
CREATE INDEX migration_items_run_status_idx ON migration_items (run_id, status);
-- Același fișier din aceeași sursă nu se importă de două ori, nici la rulări simultane.
CREATE UNIQUE INDEX migration_items_once_idx ON migration_items (source_name, rel_path, sha256) WHERE status = 'importat';
CREATE INDEX migration_items_source_idx ON migration_items (source_name, rel_path) WHERE status = 'importat';
