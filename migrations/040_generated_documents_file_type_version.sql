-- OPTALYNX Generated Documents — file format + version for Enterprise Document Repository
-- Run: psql -U <user> -d <database> -f migrations/040_generated_documents_file_type_version.sql

BEGIN;

ALTER TABLE om_generated_documents
  ADD COLUMN IF NOT EXISTS file_type VARCHAR(10),
  ADD COLUMN IF NOT EXISTS version_no INT NOT NULL DEFAULT 1;

UPDATE om_generated_documents
SET file_type = 'PDF'
WHERE file_type IS NULL
  AND LOWER(document_path) LIKE '%.pdf';

UPDATE om_generated_documents
SET file_type = 'DOCX'
WHERE file_type IS NULL
  AND LOWER(document_path) LIKE '%.docx';

UPDATE om_generated_documents
SET file_type = 'DOCX'
WHERE file_type IS NULL;

CREATE INDEX IF NOT EXISTS idx_om_generated_documents_business_version
  ON om_generated_documents(business_object_type, business_object_id, version_no DESC);

CREATE INDEX IF NOT EXISTS idx_om_generated_documents_business_file
  ON om_generated_documents(
    business_object_type,
    business_object_id,
    document_type,
    file_type,
    version_no DESC
  );

COMMIT;
