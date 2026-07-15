-- Seed rm_candidate_sources master data.

INSERT INTO rm_candidate_sources (
  source_code,
  source_name,
  ownership_strategy,
  display_order
)
VALUES
  ('MANUAL', 'Recruiter Manual', 'CURRENT_USER', 1),
  ('PORTAL', 'Career Portal', 'NONE', 2),
  ('VENDOR', 'Vendor', 'NONE', 3),
  ('LINKEDIN', 'LinkedIn', 'CURRENT_USER', 4),
  ('NAUKRI', 'Naukri', 'CURRENT_USER', 5),
  ('INDEED', 'Indeed', 'CURRENT_USER', 6),
  ('REFERRAL', 'Employee Referral', 'AUTO_ASSIGN', 7),
  ('CAMPUS', 'Campus Recruitment', 'AUTO_ASSIGN', 8),
  ('WALKIN', 'Walk-In', 'CURRENT_USER', 9),
  ('IMPORT', 'Bulk Import', 'CURRENT_USER', 10),
  ('API', 'External API', 'NONE', 11)
ON CONFLICT (source_code) DO NOTHING;
