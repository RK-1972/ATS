/**
 * Explicit data/shape checks derived from migration SQL (not guessed counts).
 * Merged with derived object checks in getEffectiveManifest().
 */

function dataCheck(query, expectMin, proves, cannotProve, field = "c") {
  return {
    type: "data",
    query,
    field,
    expectMin,
    tier: "data",
    proves,
    cannotProve
  };
}

function existsCheck(query, proves, cannotProve) {
  return {
    type: "exists",
    query,
    tier: "data",
    proves,
    cannotProve
  };
}

const SEED_DATA_CHECKS = {
  "000_schema_migration_ledger.sql": [
    {
      type: "regclass",
      object: "public.schema_migrations",
      expect: "present",
      tier: "object",
      proves: "Ledger table exists.",
      cannotProve: "Ledger row contents."
    },
    {
      type: "regclass",
      object: "public.schema_migration_orphans",
      expect: "present",
      tier: "object",
      proves: "Orphan tracking table exists.",
      cannotProve: "Orphan row contents."
    },
    {
      type: "regclass",
      object: "public.schema_migration_recovery_blocks",
      expect: "present",
      tier: "object",
      proves: "Recovery block table exists.",
      cannotProve: "Active recovery blocks."
    }
  ],
  "001_master_data_schema.sql": [
    dataCheck(
      "SELECT COUNT(*)::int AS c FROM md_entity_types",
      35,
      "At least 35 md_entity_types rows (matches INSERT/FOREACH registry in 001).",
      "md_records content and per-entity view definitions."
    )
  ],
  "010_interview_stages_schema.sql": [
    existsCheck(
      `SELECT EXISTS (
         SELECT 1 FROM md_entity_types
         WHERE entity_type = 'interview_stages'
           AND domain_key = 'recruitment'
           AND label = 'Interview Stages'
           AND table_name = 'md_interview_stages'
       ) AS exists`,
      "Interview stages master-data catalog type registered with domain, label, and view table name (010 INSERT).",
      "Individual stage rows in md_records; stages may be added later via application seeding."
    ),
    existsCheck(
      `SELECT EXISTS (
         SELECT 1
         FROM information_schema.views
         WHERE table_schema = 'public'
           AND table_name = 'md_interview_stages'
       ) AS exists`,
      "md_interview_stages view exists for stage catalog records.",
      "View definition equivalence and non-deleted stage row content."
    ),
    existsCheck(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_views
         WHERE schemaname = 'public'
           AND viewname = 'md_interview_stages'
           AND definition ILIKE '%entity_type%interview_stages%'
           AND definition ILIKE '%is_deleted%'
       ) AS exists`,
      "Stage catalog view filters md_records to interview_stages entity (010 view definition).",
      "Whether any stage catalog rows exist in md_records."
    )
  ],
  "013_rm_candidate_sources_schema.sql": [
    {
      type: "column",
      table: "rm_candidate_sources",
      column: "source_code",
      expect: "present",
      tier: "shape",
      proves: "rm_candidate_sources.source_code column from 013 exists.",
      cannotProve: "UNIQUE NOT NULL enforcement beyond separate index check."
    },
    {
      type: "column",
      table: "rm_candidate_sources",
      column: "source_name",
      expect: "present",
      tier: "shape",
      proves: "rm_candidate_sources.source_name column from 013 exists.",
      cannotProve: "Display names and ownership_strategy values."
    },
    {
      type: "column",
      table: "rm_candidate_sources",
      column: "ownership_strategy",
      expect: "present",
      tier: "shape",
      proves: "rm_candidate_sources.ownership_strategy column from 013 exists.",
      cannotProve: "Strategy enum values in data."
    },
    {
      type: "column",
      table: "rm_candidate_sources",
      column: "allow_resume_upload",
      expect: "present",
      tier: "shape",
      proves: "rm_candidate_sources.allow_resume_upload column from 013 exists.",
      cannotProve: "Default TRUE for existing rows."
    },
    {
      type: "column",
      table: "rm_candidate_sources",
      column: "is_active",
      expect: "present",
      tier: "shape",
      proves: "rm_candidate_sources.is_active column from 013 exists.",
      cannotProve: "Active flag per source row."
    },
    existsCheck(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = 'public'
           AND t.relname = 'rm_candidate_sources'
           AND c.contype = 'p'
       ) AS exists`,
      "PRIMARY KEY on rm_candidate_sources (source_id SERIAL) from 013.",
      "Serial sequence state and row data."
    ),
    existsCheck(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename = 'rm_candidate_sources'
           AND indexdef ILIKE '%UNIQUE%'
           AND indexdef ILIKE '%source_code%'
       ) AS exists`,
      "UNIQUE source_code constraint/index from 013.",
      "source_name uniqueness and other indexes."
    )
  ],
  "015_rm_candidate_intake_schema.sql": [
    {
      type: "column",
      table: "rm_candidate_intake",
      column: "source_id",
      expect: "present",
      tier: "shape",
      proves: "rm_candidate_intake.source_id column from 015 exists.",
      cannotProve: "FK target md_candidate_sources(id) population."
    },
    {
      type: "column",
      table: "rm_candidate_intake",
      column: "intake_status",
      expect: "present",
      tier: "shape",
      proves: "rm_candidate_intake.intake_status column from 015 exists.",
      cannotProve: "Status values in existing rows."
    },
    {
      type: "column",
      table: "rm_candidate_intake",
      column: "parsing_status",
      expect: "present",
      tier: "shape",
      proves: "rm_candidate_intake.parsing_status column from 015 exists.",
      cannotProve: "Parsing pipeline state."
    },
    {
      type: "column",
      table: "rm_candidate_intake",
      column: "duplicate_status",
      expect: "present",
      tier: "shape",
      proves: "rm_candidate_intake.duplicate_status column from 015 exists.",
      cannotProve: "Duplicate detection outcomes."
    },
    {
      type: "column",
      table: "rm_candidate_intake",
      column: "review_status",
      expect: "present",
      tier: "shape",
      proves: "rm_candidate_intake.review_status column from 015 exists.",
      cannotProve: "Review workflow state."
    },
    {
      type: "column",
      table: "rm_candidate_intake",
      column: "resume_path",
      expect: "present",
      tier: "shape",
      proves: "rm_candidate_intake.resume_path column from 015 exists.",
      cannotProve: "Stored resume paths."
    },
    existsCheck(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = 'public'
           AND t.relname = 'rm_candidate_intake'
           AND c.contype = 'p'
       ) AS exists`,
      "PRIMARY KEY on rm_candidate_intake (intake_id SERIAL) from 015.",
      "Intake row data."
    ),
    existsCheck(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         JOIN pg_class rt ON rt.oid = c.confrelid
         JOIN pg_namespace rn ON rn.oid = rt.relnamespace
         WHERE n.nspname = 'public'
           AND t.relname = 'rm_candidate_intake'
           AND c.contype = 'f'
           AND rn.nspname = 'public'
           AND rt.relname = 'md_candidate_sources'
           AND c.confdeltype = 'a'
           AND EXISTS (
             SELECT 1
             FROM unnest(c.conkey) WITH ORDINALITY AS fk(attnum, ord)
             JOIN pg_attribute fa
               ON fa.attrelid = c.conrelid
              AND fa.attnum = fk.attnum
              AND NOT fa.attisdropped
             WHERE fk.ord = 1
               AND fa.attname = 'source_id'
           )
           AND EXISTS (
             SELECT 1
             FROM unnest(c.confkey) WITH ORDINALITY AS ref(attnum, ord)
             JOIN pg_attribute ra
               ON ra.attrelid = c.confrelid
              AND ra.attnum = ref.attnum
              AND NOT ra.attisdropped
             WHERE ref.ord = 1
               AND ra.attname = 'id'
           )
       ) AS exists`,
      "FOREIGN KEY rm_candidate_intake.source_id REFERENCES md_candidate_sources(id) with ON DELETE NO ACTION (015 default).",
      "Whether md_candidate_sources rows exist or source_id values are valid."
    )
  ],
  "020_approval_route_unique_constraint.sql": [
    {
      type: "constraint",
      table: "approval_route_mstr",
      constraint: "uq_approval_route_applies_to_route_name",
      expect: "present",
      tier: "shape",
      proves: "Unique constraint uq_approval_route_applies_to_route_name exists on approval_route_mstr.",
      cannotProve: "Historical DELETE deduplication was run."
    },
    existsCheck(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = 'public'
           AND t.relname = 'approval_route_mstr'
           AND c.conname = 'uq_approval_route_applies_to_route_name'
           AND c.contype = 'u'
           AND (
             SELECT array_agg(a.attname ORDER BY ord)
             FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, ord)
             JOIN pg_attribute a
               ON a.attrelid = c.conrelid
              AND a.attnum = u.attnum
              AND NOT a.attisdropped
           ) = ARRAY['applies_to', 'route_name']::name[]
       ) AS exists`,
      "UNIQUE (applies_to, route_name) definition from 020 matches intended column pair.",
      "Duplicate route rows were removed before constraint creation."
    )
  ],
  "014_rm_candidate_sources_seed.sql": [
    dataCheck(
      "SELECT COUNT(*)::int AS c FROM rm_candidate_sources",
      11,
      "At least 11 rm_candidate_sources rows (VALUES clause count in 014).",
      "Exact source_name/ownership_strategy beyond source_code."
    )
  ],
  "023_work_assignment_engine_schema.sql": [
    existsCheck(
      `SELECT EXISTS (
         SELECT 1 FROM work_assignment_mstr
         WHERE assignment_code = 'USER_ADMINISTRATOR'
       ) AS exists`,
      "USER_ADMINISTRATOR work assignment seed from 023 is present.",
      "Other assignment seeds and column extensions from later migrations."
    )
  ],
  "024_work_assignment_interviewer_seed.sql": [
    existsCheck(
      `SELECT EXISTS (
         SELECT 1 FROM work_assignment_mstr WHERE assignment_code = 'INTERVIEWER'
       ) AS exists`,
      "INTERVIEWER work assignment seed from 024 is present.",
      "Workspace metadata updates from later migrations."
    )
  ],
  "029_work_assignment_budget_requestor_seed.sql": [
    existsCheck(
      `SELECT EXISTS (
         SELECT 1 FROM work_assignment_mstr WHERE assignment_code = 'BUDGET_REQUESTOR'
       ) AS exists`,
      "BUDGET_REQUESTOR seed from 029 is present.",
      "Authorization behavior in application layer."
    )
  ],
  "030_work_assignment_offer_seed.sql": [
    existsCheck(
      `SELECT EXISTS (
         SELECT 1 FROM work_assignment_mstr WHERE assignment_code = 'OFFER_RECRUITER'
       ) AS exists`,
      "OFFER_RECRUITER seed from 030 is present.",
      "Offer workflow routing configuration."
    )
  ],
  "031_offer_approval_route_policy.sql": [
    existsCheck(
      `SELECT EXISTS (
         SELECT 1
         FROM approval_route_policy p
         INNER JOIN approval_route_mstr r ON r.route_id = p.route_id
         WHERE LOWER(TRIM(r.applies_to)) = 'offer'
           AND p.is_active = TRUE
       ) AS exists`,
      "Active offer approval_route_policy row exists when an offer route is present (matches 031 NOT EXISTS guard).",
      "Policy when no active offer route exists in approval_route_mstr (migration may legitimately insert zero rows)."
    )
  ],
  "033_compensation_engine_schema.sql": [
    dataCheck(
      "SELECT COUNT(*)::int AS c FROM cm_compensation_component_master",
      10,
      "At least 10 compensation components seeded in 033 VALUES.",
      "Structure component formula values and STRUCT-STANDARD-KARNATAKA linkage correctness."
    ),
    existsCheck(
      `SELECT EXISTS (
         SELECT 1 FROM cm_compensation_structures
         WHERE structure_id = 'STRUCT-STANDARD-KARNATAKA'
       ) AS exists`,
      "STRUCT-STANDARD-KARNATAKA structure seed exists.",
      "All structure_component rows (expects 10 in 033)."
    ),
    dataCheck(
      `SELECT COUNT(*)::int AS c
       FROM cm_compensation_structure_components
       WHERE structure_id = 'STRUCT-STANDARD-KARNATAKA'`,
      10,
      "At least 10 structure_component rows for STRUCT-STANDARD-KARNATAKA (VALUES count in 033).",
      "Formula amounts and mandatory flags per component."
    )
  ],
  "034_document_templates_schema.sql": [
    existsCheck(
      `SELECT EXISTS (
         SELECT 1 FROM cm_document_templates
         WHERE template_id = 'OFFER_LETTER_STANDARD'
       ) AS exists`,
      "OFFER_LETTER_STANDARD template seed from 034 exists.",
      "Template body/version content."
    )
  ],
  "044_report_builder_schema.sql": [
    dataCheck(
      "SELECT COUNT(*)::int AS c FROM rb_dataset",
      2,
      "At least 2 rb_dataset rows (CANDIDATE_PIPELINE and REQUISITION_SUMMARY in 044).",
      "rb_field/rb_filter/permission seed completeness."
    )
  ],
  "046_user_administrator_work_assignment_seed.sql": [
    existsCheck(
      `SELECT EXISTS (
         SELECT 1 FROM work_assignment_mstr
         WHERE assignment_code = 'USER_ADMINISTRATOR'
           AND workspace_flag = 'showUserAdministrationWorkspace'
       ) AS exists`,
      "USER_ADMINISTRATOR workspace metadata update from 046 is present.",
      "Prior 023 seed without 046 metadata."
    )
  ],
  "050_rm_ats_stage_catalog.sql": [
    dataCheck(
      "SELECT COUNT(*)::int AS c FROM rm_ats_stage_catalog",
      7,
      "At least 7 rm_ats_stage_catalog rows (seven VALUES tuples in 050).",
      "Exact display_name/sort_order beyond stage_code."
    )
  ],
  "051_rm_ats_stage_alias.sql": [
    dataCheck(
      "SELECT COUNT(*)::int AS c FROM rm_ats_stage_alias",
      5,
      "At least 5 rm_ats_stage_alias rows (five legacy_value seeds in 051).",
      "Alias-to-stage_id mapping correctness."
    )
  ],
  "054_ta_lead_workspace_flag.sql": [
    existsCheck(
      `SELECT EXISTS (
         SELECT 1 FROM work_assignment_mstr
         WHERE assignment_code = 'REQUISITION_ASSIGNER'
           AND workspace_flag = 'showTaLeadWorkspace'
       ) AS exists`,
      "REQUISITION_ASSIGNER workspace_flag showTaLeadWorkspace from 054 is present.",
      "Other workspace metadata columns updated in 054."
    )
  ],
  "058_ta_lead_recruiter_workload_report_permission.sql": [
    existsCheck(
      `SELECT EXISTS (
         SELECT 1
         FROM rb_role_dataset_permission p
         INNER JOIN rb_dataset d ON d.dataset_id = p.dataset_id
         WHERE d.code = 'CANDIDATE_PIPELINE'
           AND p.role_name IN ('TA Lead', 'TA Leader')
           AND p.can_view = TRUE
       ) AS exists`,
      "TA Lead/TA Leader can_view on CANDIDATE_PIPELINE dataset (058 upsert intent).",
      "rb_role_field_permission rows from 058."
    )
  ],
  "012_rm_pipeline_history_actor_code.sql": [
    {
      type: "column",
      table: "rm_pipeline_history",
      column: "actor_code",
      expect: "present",
      tier: "shape",
      proves: "actor_code column from 012 exists.",
      cannotProve: "Historical actor_code data."
    }
  ],
  "059_candidate_registered_pan_unique.sql": [
    existsCheck(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_class t ON t.oid = i.indrelid
         WHERE n.nspname = 'public'
           AND c.relname = 'uq_cand_mstr_registered_pan_upper'
           AND t.relname = 'cand_mstr'
           AND i.indisunique = true
           AND i.indpred IS NOT NULL
           AND pg_get_indexdef(i.indexrelid) ILIKE '%upper(trim(pan_number))%'
           AND pg_get_indexdef(i.indexrelid) ILIKE '%registered%'
       ) AS exists`,
      "Partial unique index on UPPER(TRIM(pan_number)) for REGISTERED candidates (059 definition).",
      "Duplicate REGISTERED PAN rows were cleaned before index creation; PAN values are not inspected."
    )
  ],
  "060_interview_panel_mstr_employee_code_extend.sql": [
    {
      type: "column_characteristics",
      table: "interview_panel_mstr",
      column: "employee_code",
      expectDataType: "character varying",
      expectMaxLength: 100,
      tier: "shape",
      proves:
        "interview_panel_mstr.employee_code is character varying(100) as applied by 060 ALTER COLUMN TYPE.",
      cannotProve: "Collation, constraints, or data migrated to wider values."
    }
  ]
};

function getExplicitSeedChecks(filename) {
  return SEED_DATA_CHECKS[filename] || [];
}

module.exports = {
  SEED_DATA_CHECKS,
  getExplicitSeedChecks
};
