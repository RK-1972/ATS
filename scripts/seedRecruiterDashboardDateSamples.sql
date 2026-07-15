-- Sample data for Recruiter Cockpit date-filter validation
-- Spreads candidate mappings, pipeline history, interviews, and tasks across ~90 days.
-- Run: psql -U <user> -d <database> -f scripts/seedRecruiterDashboardDateSamples.sql
--
-- Targets recruiter IGS0506 on existing assigned requisitions.
-- Safe to re-run: uses deterministic sample codes and ON CONFLICT / DELETE guards.

BEGIN;

DO $$
DECLARE
  recruiter_code CONSTANT TEXT := 'IGS0506';
  req_code TEXT;
  req_codes TEXT[];
  cand_id INT;
  map_id INT;
  day_offset INT;
  applied_ts TIMESTAMPTZ;
  hist_ts TIMESTAMPTZ;
  iv_date DATE;
BEGIN
  SELECT ARRAY_AGG(DISTINCT a.requisition_code ORDER BY a.requisition_code)
  INTO req_codes
  FROM rm_recruiter_assignments a
  WHERE a.recruiter_code = recruiter_code
    AND a.is_active = true;

  IF req_codes IS NULL OR array_length(req_codes, 1) IS NULL THEN
    RAISE EXCEPTION 'No active requisitions for recruiter %', recruiter_code;
  END IF;

  DELETE FROM rm_pipeline_history
  WHERE metadata ->> 'seedTag' = 'cockpit-date-filter-sample';

  DELETE FROM im_interviews
  WHERE interview_id LIKE 'IV-COCKPIT-%';

  DELETE FROM et_tasks
  WHERE metadata ->> 'seedTag' = 'cockpit-date-filter-sample';

  DELETE FROM rm_candidate_mappings
  WHERE remarks = 'cockpit-date-filter-sample';

  FOR day_offset IN 0..89 LOOP
    req_code := req_codes[1 + (day_offset % array_length(req_codes, 1))];
    applied_ts := (CURRENT_DATE - day_offset) + TIME '10:00:00';
    hist_ts := applied_ts + INTERVAL '2 hours';
    iv_date := CURRENT_DATE - day_offset;

    INSERT INTO cand_mstr (candidate_code, first_name, last_name, email, candidate_status)
    VALUES (
      'COCKPIT-C' || LPAD(day_offset::text, 3, '0'),
      'Sample',
      'Candidate ' || day_offset,
      'cockpit.sample.' || day_offset || '@example.com',
      'Applied'
    )
    ON CONFLICT (candidate_code) DO UPDATE
      SET first_name = EXCLUDED.first_name,
          last_name = EXCLUDED.last_name
    RETURNING candidate_id INTO cand_id;

    INSERT INTO rm_candidate_mappings (
      candidate_id, candidate_code, requisition_code, stage_name, source_type,
      is_active, remarks, applied_on, modified_on
    ) VALUES (
      cand_id,
      'COCKPIT-C' || LPAD(day_offset::text, 3, '0'),
      req_code,
      CASE
        WHEN day_offset % 7 = 0 THEN 'Joined'
        WHEN day_offset % 6 = 0 THEN 'Offer'
        WHEN day_offset % 5 = 0 THEN 'Client Interview'
        WHEN day_offset % 4 = 0 THEN 'L2 Interview'
        WHEN day_offset % 3 = 0 THEN 'L1 Interview'
        WHEN day_offset % 2 = 0 THEN 'Screening'
        ELSE 'Applied'
      END,
      'Referral',
      true,
      'cockpit-date-filter-sample',
      applied_ts,
      applied_ts
    )
    RETURNING mapping_id INTO map_id;

    INSERT INTO rm_pipeline_history (
      requisition_code, mapping_id, candidate_id, event_type, to_stage,
      actor, actor_role, comments, metadata, created_on
    ) VALUES (
      req_code,
      map_id,
      cand_id,
      'CandidateMapped',
      'Applied',
      recruiter_code,
      'Recruiter',
      'cockpit-date-filter-sample',
      jsonb_build_object('seedTag', 'cockpit-date-filter-sample'),
      applied_ts
    );

    IF day_offset % 2 = 0 THEN
      INSERT INTO rm_pipeline_history (
        requisition_code, mapping_id, candidate_id, event_type, from_stage, to_stage,
        actor, actor_role, comments, metadata, created_on
      ) VALUES (
        req_code,
        map_id,
        cand_id,
        'StageChanged',
        'Applied',
        'Screening',
        recruiter_code,
        'Recruiter',
        'cockpit-date-filter-sample',
        jsonb_build_object('seedTag', 'cockpit-date-filter-sample'),
        hist_ts
      );
    END IF;

    IF day_offset % 6 = 0 THEN
      INSERT INTO rm_pipeline_history (
        requisition_code, mapping_id, candidate_id, event_type, from_stage, to_stage,
        actor, actor_role, comments, metadata, created_on
      ) VALUES (
        req_code,
        map_id,
        cand_id,
        'StageChanged',
        'Client Interview',
        'Offer',
        recruiter_code,
        'Recruiter',
        'cockpit-date-filter-sample',
        jsonb_build_object('seedTag', 'cockpit-date-filter-sample'),
        hist_ts + INTERVAL '1 hour'
      );
    END IF;

    INSERT INTO im_interviews (
      interview_id, requisition_code, candidate_id, round_no, round_type,
      interview_date, interview_time, interview_status, feedback_submitted, remarks
    ) VALUES (
      'IV-COCKPIT-' || LPAD(day_offset::text, 3, '0'),
      req_code,
      cand_id,
      1,
      'Technical',
      iv_date,
      TIME '14:30:00',
      CASE WHEN day_offset % 3 = 0 THEN 'Completed' ELSE 'Scheduled' END,
      day_offset % 4 <> 0,
      'cockpit-date-filter-sample'
    );

    INSERT INTO et_tasks (
      module, task_type, title, status, priority, assignee, assignee_role,
      due_at, business_object_type, business_object_id, metadata, created_on
    ) VALUES (
      'Recruitment Management',
      'FollowUp',
      'Cockpit sample task ' || day_offset,
      'Pending',
      'Normal',
      recruiter_code,
      'Recruiter',
      applied_ts + INTERVAL '1 day',
      'Requisition',
      req_code,
      jsonb_build_object('seedTag', 'cockpit-date-filter-sample'),
      applied_ts
    );
  END LOOP;
END $$;

COMMIT;

-- Verify spread
SELECT
  DATE(applied_on) AS applied_day,
  COUNT(*)::int AS mappings
FROM rm_candidate_mappings
WHERE remarks = 'cockpit-date-filter-sample'
GROUP BY DATE(applied_on)
ORDER BY applied_day DESC
LIMIT 10;
