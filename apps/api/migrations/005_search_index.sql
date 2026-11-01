-- Căutarea combină textul cu numărul de registru: fără acest index, OR-ul forțează scanarea tabelei.
CREATE INDEX documents_reg_label_trgm_idx ON documents USING gin (reg_label gin_trgm_ops);
