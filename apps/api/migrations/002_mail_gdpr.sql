-- Coada de email: rândul intră în aceeași tranzacție cu notificarea, iar trimiterea se face separat.
CREATE TABLE email_outbox (
  id serial PRIMARY KEY,
  user_id int NOT NULL REFERENCES users(id),
  to_address text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  kind text NOT NULL,
  document_id int REFERENCES documents(id),
  task_id int REFERENCES tasks(id),
  status text NOT NULL DEFAULT 'in_asteptare' CHECK (status IN ('in_asteptare','trimis','esuat','ignorat')),
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX email_outbox_due_idx ON email_outbox (next_attempt_at) WHERE status = 'in_asteptare';
CREATE INDEX email_outbox_status_idx ON email_outbox (status, id DESC);

-- Poziția în căsuța IMAP: după prima rulare se iau doar mesajele cu UID mai mare.
CREATE TABLE email_imap_state (
  mailbox text PRIMARY KEY,
  uidvalidity bigint,
  last_uid bigint NOT NULL DEFAULT 0,
  last_poll_at timestamptz,
  last_success_at timestamptz,
  last_error text
);

-- Mesajele primite. HTML-ul nu se păstrează: există doar textul.
CREATE TABLE email_inbox (
  id serial PRIMARY KEY,
  mailbox text NOT NULL,
  uidvalidity bigint NOT NULL,
  uid bigint NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  message_id text,
  from_name text,
  from_address text,
  to_text text,
  subject text NOT NULL DEFAULT '',
  sent_at timestamptz,
  body_text text NOT NULL DEFAULT '',
  body_truncated boolean NOT NULL DEFAULT false,
  import_note text,
  status text NOT NULL DEFAULT 'nou' CHECK (status IN ('nou','inregistrat','renuntat')),
  document_id int REFERENCES documents(id),
  discard_reason text,
  handled_by int REFERENCES users(id),
  handled_at timestamptz,
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mailbox, uidvalidity, uid),
  CHECK ((status = 'inregistrat') = (document_id IS NOT NULL))
);
CREATE INDEX email_inbox_status_idx ON email_inbox (status, id DESC);

-- Atașamentele refuzate rămân vizibile, cu motivul, dar fără conținut stocat.
CREATE TABLE email_inbox_attachments (
  id serial PRIMARY KEY,
  inbox_id int NOT NULL REFERENCES email_inbox(id),
  filename text NOT NULL,
  mime text,
  size_bytes bigint NOT NULL,
  sha256 text NOT NULL,
  storage_key text,
  refused_reason text
);
CREATE INDEX email_inbox_attachments_inbox_idx ON email_inbox_attachments (inbox_id);
ALTER TABLE email_inbox ADD COLUMN attachment_id int REFERENCES email_inbox_attachments(id);

-- Cereri ale persoanelor vizate. Termenul legal de 30 de zile se calculează din data primirii.
CREATE TABLE gdpr_requests (
  id serial PRIMARY KEY,
  type text NOT NULL CHECK (type IN ('acces','rectificare','stergere','restrictionare','opozitie','portabilitate')),
  subject_name text NOT NULL,
  subject_identifier text,
  received_on date NOT NULL,
  due_on date GENERATED ALWAYS AS (received_on + 30) STORED,
  status text NOT NULL DEFAULT 'inregistrata' CHECK (status IN ('inregistrata','in_lucru','solutionata','respinsa')),
  resolution_note text,
  assignee_id int REFERENCES users(id),
  created_by int NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);
CREATE INDEX gdpr_requests_status_idx ON gdpr_requests (status, due_on);

-- Decizia pe fiecare document. Nimic nu se șterge automat: se consemnează ce s-a hotărât și de ce.
CREATE TABLE gdpr_request_decisions (
  request_id int NOT NULL REFERENCES gdpr_requests(id),
  document_id int NOT NULL REFERENCES documents(id),
  decision text NOT NULL CHECK (decision IN ('pastrare_retentie','eliminare_la_expirare','fara_legatura','alta')),
  note text,
  retention_until date,
  document_status text NOT NULL,
  decided_by int NOT NULL REFERENCES users(id),
  decided_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, document_id)
);
