-- Semnătură cu certificat, separată de cea internă, și verificarea semnăturilor din PDF-urile primite.
ALTER TABLE signatures DROP CONSTRAINT signatures_kind_check;
ALTER TABLE signatures ADD CONSTRAINT signatures_kind_check CHECK (kind IN ('interna','certificat'));
ALTER TABLE signatures
  ADD COLUMN certificate_subject text,
  ADD COLUMN certificate_issuer text,
  ADD COLUMN certificate_serial text,
  ADD COLUMN certificate_sha256 text,
  ADD COLUMN certificate_pem text,
  -- Semnele de certificat de test găsite de verificator; goală nu înseamnă certificat real.
  ADD COLUMN test_indicators jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN chain_status text,
  ADD COLUMN verdict text,
  ADD CONSTRAINT signatures_certificate_fields CHECK (kind <> 'certificat' OR (certificate_sha256 IS NOT NULL AND certificate_pem IS NOT NULL));

-- Sesiune de semnare în două faze: PDF-ul pregătit așteaptă CMS-ul de la agentul local.
CREATE TABLE signing_sessions (
  id uuid PRIMARY KEY,
  user_id int NOT NULL REFERENCES users(id),
  document_id int NOT NULL REFERENCES documents(id),
  task_id int REFERENCES tasks(id),
  base_version_id int NOT NULL REFERENCES document_versions(id),
  storage_key text,
  digest_hex text NOT NULL,
  contents_start bigint NOT NULL,
  contents_end bigint NOT NULL,
  certificate_sha256 text NOT NULL,
  certificate_pem text NOT NULL,
  status text NOT NULL DEFAULT 'pregatita' CHECK (status IN ('pregatita','finalizata','expirata','anulata')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz
);
CREATE INDEX signing_sessions_open_idx ON signing_sessions (expires_at) WHERE status = 'pregatita';
CREATE INDEX signing_sessions_user_doc_idx ON signing_sessions (user_id, document_id) WHERE status = 'pregatita';

-- Rezultatul fiecărei verificări la cerere; se păstrează ca dovadă a ce s-a constatat atunci.
CREATE TABLE pdf_signature_checks (
  id serial PRIMARY KEY,
  document_id int NOT NULL REFERENCES documents(id),
  version_id int NOT NULL REFERENCES document_versions(id),
  checked_by int NOT NULL REFERENCES users(id),
  checked_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL,
  report jsonb NOT NULL
);
CREATE INDEX pdf_signature_checks_doc_idx ON pdf_signature_checks (document_id, version_id, id DESC);
