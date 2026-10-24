/**
 * Offer Hold — PostgreSQL integration tests (disposable local DB only).
 * Requires TEST_DATABASE_URL (optalynx_mig_test*) — never uses dotenv / production.
 * Set OPTALYNX_MIG_INTEGRATION_REQUIRE_PG=1 to fail when prerequisites are missing.
 */
const assert = require("node:assert/strict");
const { describe, it, before, after } = require("node:test");

const recruitmentService = require("../services/recruitmentService");
const offerManagementService = require("../services/offerManagementService");
const interviewService = require("../services/interviewService");
const candidateOfferHoldService = require("../services/candidateOfferHoldService");
const {
  isTestDatabaseUrlConfigured,
  isIntegrationPgRequired
} = require("./lib/migrationIntegrationGuards");
const {
  probePostgresAvailability,
  prerequisiteMessage
} = require("./lib/migrationIntegrationHarness");
const {
  assertCoreSchemaReady,
  assertOfferHoldSchemaReady,
  applyMigration065IfMissing,
  createDisposablePool,
  createOfferHoldFixture,
  releaseOfferAndActivateHold,
  countActiveHolds,
  cleanupOfferHoldFixture,
  mockReq,
  tableExists,
  resolveOfferWorkspaceRecruiter,
  resolveAdminReq
} = require("./lib/candidateOfferHoldIntegrationFixtures");
const {
  resolveOfferRouteTestContext,
  createDisposableSubmittedOffer,
  cleanupOffer
} = require("./lib/offerApprovalTestFixtures");

describe("candidate offer hold (PostgreSQL integration)", { concurrency: 1 }, () => {
  let pool;
  let enabled = false;
  let skipReason = null;
  let databaseLabel = null;

  before(async () => {
    if (!isTestDatabaseUrlConfigured()) {
      skipReason = "TEST_DATABASE_URL is not set (see docs/migration-integration-tests.md)";
      if (isIntegrationPgRequired()) {
        throw new Error(skipReason);
      }
      return;
    }

    const probe = await probePostgresAvailability();
    if (!probe.available) {
      skipReason = prerequisiteMessage(probe.error);
      if (isIntegrationPgRequired()) {
        throw new Error(skipReason);
      }
      return;
    }

    databaseLabel = `local disposable (${probe.config.database}@${probe.config.host})`;
    pool = createDisposablePool();

    const schema = await assertCoreSchemaReady(pool);
    if (!schema.ok) {
      skipReason = schema.reason;
      if (isIntegrationPgRequired()) {
        throw new Error(skipReason);
      }
      await pool.end().catch(() => {});
      pool = null;
      return;
    }

    await applyMigration065IfMissing(pool);

    const holdSchema = await assertOfferHoldSchemaReady(pool);
    if (!holdSchema.ok) {
      skipReason = holdSchema.reason;
      if (isIntegrationPgRequired()) {
        throw new Error(skipReason);
      }
      await pool.end().catch(() => {});
      pool = null;
      return;
    }

    enabled = true;
  });

  after(async () => {
    if (pool) {
      await pool.end().catch(() => {});
    }
  });

  function skipIfDisabled(t) {
    if (!enabled) {
      t.skip(skipReason || "Integration prerequisites not satisfied");
      return true;
    }
    return false;
  }

  it("reports disposable database identity when enabled", async (t) => {
    if (skipIfDisabled(t)) {
      return;
    }
    assert.match(databaseLabel, /local disposable/);
    assert.equal(await tableExists(pool, "rm_candidate_offer_hold"), true);
  });

  it("draft / pending offer does not create an active hold", async (t) => {
    if (skipIfDisabled(t)) {
      return;
    }

    const recruiter = await resolveOfferWorkspaceRecruiter(pool);
    const routeContext = await resolveOfferRouteTestContext(pool);
    assert.ok(recruiter && routeContext, "Offer workspace recruiter and route required");

    const adminReq = await resolveAdminReq(pool);
    const recruiterReq = mockReq(recruiter);
    const submitted = await createDisposableSubmittedOffer(
      pool,
      recruiter,
      recruiterReq,
      adminReq,
      "draftonly",
      { routeContext }
    );

    const offerMeta = await pool.query(
      `SELECT candidate_id FROM om_offers WHERE offer_id = $1`,
      [submitted.offerId]
    );
    const candidateId = offerMeta.rows[0].candidate_id;

    try {
      assert.equal(await countActiveHolds(pool, candidateId), 0);

      await assert.rejects(
        () =>
          offerManagementService.releaseOffer(
            pool,
            submitted.offerId,
            {},
            recruiterReq
          ),
        (error) => error.status === 409 || error.status === 400
      );

      assert.equal(await countActiveHolds(pool, candidateId), 0);
    } finally {
      await cleanupOffer(pool, submitted.offerId);
      await pool.query(`DELETE FROM rm_candidate_mappings WHERE candidate_id = $1`, [
        candidateId
      ]);
      await pool.query(`DELETE FROM candidate_req_map WHERE candidate_id = $1`, [
        candidateId
      ]).catch(() => undefined);
      await pool.query(`DELETE FROM cand_mstr WHERE candidate_id = $1`, [candidateId]);
    }
  });

  it("successful offer release activates exactly one active hold", async (t) => {
    if (skipIfDisabled(t)) {
      return;
    }

    const fixture = await createOfferHoldFixture(pool, { suffix: "release" });
    try {
      const result = await releaseOfferAndActivateHold(pool, fixture);
      assert.ok(result.offerHold?.hold_id);

      const holds = await countActiveHolds(pool, fixture.candidateId);
      assert.equal(holds, 1);

      const row = await pool.query(
        `SELECT hold_status, source_requisition_code, activated_by_employee_code
         FROM rm_candidate_offer_hold
         WHERE candidate_id = $1 AND hold_status = 'Active'`,
        [fixture.candidateId]
      );
      assert.equal(row.rows[0].hold_status, "Active");
      assert.equal(row.rows[0].source_requisition_code, fixture.sourceRequisitionCode);
      assert.equal(
        String(row.rows[0].activated_by_employee_code),
        fixture.recruiter.employee_code
      );
    } finally {
      await cleanupOfferHoldFixture(pool, fixture);
    }
  });

  it("acceptance leaves the offer hold active", async (t) => {
    if (skipIfDisabled(t)) {
      return;
    }

    const fixture = await createOfferHoldFixture(pool, { suffix: "accept" });
    try {
      await releaseOfferAndActivateHold(pool, fixture);
      await offerManagementService.acceptOffer(pool, fixture.offerId, fixture.recruiterReq);

      const holds = await countActiveHolds(pool, fixture.candidateId);
      assert.equal(holds, 1);
    } finally {
      await cleanupOfferHoldFixture(pool, fixture);
    }
  });

  it("assigned recruiter can release with reason and audit event", async (t) => {
    if (skipIfDisabled(t)) {
      return;
    }

    const fixture = await createOfferHoldFixture(pool, { suffix: "relok" });
    try {
      await releaseOfferAndActivateHold(pool, fixture);
      const released = await candidateOfferHoldService.releaseOfferHold(
        pool,
        fixture.candidateId,
        "Integration release reason",
        fixture.recruiterReq
      );
      assert.equal(released.hold.hold_status, "Released");

      const events = await pool.query(
        `SELECT event_type FROM rm_candidate_offer_hold_event
         WHERE hold_id = $1 ORDER BY event_id DESC`,
        [released.hold.hold_id]
      );
      assert.ok(events.rows.some((row) => row.event_type === "OfferHoldReleased"));
    } finally {
      await cleanupOfferHoldFixture(pool, fixture);
    }
  });

  it("rejects release from recruiter not assigned to source requisition", async (t) => {
    if (skipIfDisabled(t)) {
      return;
    }

    const fixture = await createOfferHoldFixture(pool, {
      suffix: "rel403",
      withOtherRequisition: true
    });
    try {
      await releaseOfferAndActivateHold(pool, fixture);
      await assert.rejects(
        () =>
          candidateOfferHoldService.releaseOfferHold(
            pool,
            fixture.candidateId,
            "Should not work",
            fixture.otherRequisition.otherRecruiterReq
          ),
        (error) => error.status === 403
      );
    } finally {
      await cleanupOfferHoldFixture(pool, fixture);
    }
  });

  it("rejects release without a meaningful reason", async (t) => {
    if (skipIfDisabled(t)) {
      return;
    }

    const fixture = await createOfferHoldFixture(pool, { suffix: "reason" });
    try {
      await releaseOfferAndActivateHold(pool, fixture);
      await assert.rejects(
        () =>
          candidateOfferHoldService.releaseOfferHold(
            pool,
            fixture.candidateId,
            "   ",
            fixture.recruiterReq
          ),
        (error) => error.status === 400
      );
    } finally {
      await cleanupOfferHoldFixture(pool, fixture);
    }
  });

  it("rejects mapping to another requisition while hold is active", async (t) => {
    if (skipIfDisabled(t)) {
      return;
    }

    const fixture = await createOfferHoldFixture(pool, {
      suffix: "mapblk",
      withOtherRequisition: true
    });
    try {
      await releaseOfferAndActivateHold(pool, fixture);

      await assert.rejects(
        () =>
          recruitmentService.mapCandidate(
            pool,
            {
              candidate_id: fixture.candidateId,
              requisition_code: fixture.otherRequisition.requisitionCode,
              stage_name: "Applied",
              source_type: "Direct"
            },
            fixture.recruiterReq
          ),
        (error) => error.status === 409
      );

      const count = await pool.query(
        `SELECT COUNT(*)::int AS count
         FROM rm_candidate_mappings
         WHERE candidate_id = $1
           AND requisition_code = $2
           AND is_active = TRUE`,
        [fixture.candidateId, fixture.otherRequisition.requisitionCode]
      );
      assert.equal(count.rows[0].count, 0);
    } finally {
      await cleanupOfferHoldFixture(pool, fixture);
    }
  });

  it("rejects interview rescheduling while hold is active", async (t) => {
    if (skipIfDisabled(t)) {
      return;
    }

    const fixture = await createOfferHoldFixture(pool, { suffix: "resched" });
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 5);
    const interviewDate = tomorrow.toISOString().slice(0, 10);
    const later = new Date(tomorrow);
    later.setDate(later.getDate() + 1);
    const newDate = later.toISOString().slice(0, 10);
    const interviewId = `INT-OH-${Date.now()}`;

    try {
      await releaseOfferAndActivateHold(pool, fixture);

      await pool.query(
        `INSERT INTO im_interviews (
          interview_id, map_id, req_id, requisition_code, candidate_id, round_no, round_type,
          interview_date, interview_time, interview_status, created_by, modified_by, effective_from
        ) VALUES ($1,$2,$3,$4,$5,1,'L1',$6,'10:00:00','Scheduled','integration','integration',NOW())`,
        [
          interviewId,
          fixture.mapId,
          null,
          fixture.sourceRequisitionCode,
          fixture.candidateId,
          interviewDate
        ]
      );

      await assert.rejects(
        () =>
          interviewService.rescheduleInterview(
            pool,
            interviewId,
            { interview_date: newDate, interview_time: "11:00:00" },
            fixture.recruiterReq
          ),
        (error) => error.status === 409
      );
    } finally {
      await pool.query(`DELETE FROM im_interviews WHERE interview_id = $1`, [interviewId]);
      await cleanupOfferHoldFixture(pool, fixture);
    }
  });

  it("rejects interview scheduling while hold is active", async (t) => {
    if (skipIfDisabled(t)) {
      return;
    }

    const fixture = await createOfferHoldFixture(pool, { suffix: "sched" });
    try {
      await releaseOfferAndActivateHold(pool, fixture);

      const panel = await pool.query(
        `SELECT panel_id, interviewer_name, email_id, interviewer_type
         FROM interview_panel_mstr
         WHERE is_active = TRUE
         LIMIT 1`
      );

      if (!panel.rows.length) {
        t.skip("No active interview_panel_mstr row in disposable database");
        return;
      }

      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 2);
      const interviewDate = tomorrow.toISOString().slice(0, 10);

      await assert.rejects(
        () =>
          interviewService.scheduleInterview(
            pool,
            {
              map_id: fixture.mapId,
              req_id: null,
              interviewer_id: panel.rows[0].panel_id,
              round_type: "L1",
              interview_date: interviewDate,
              interview_time: "10:00:00",
              interviewer_name: panel.rows[0].interviewer_name,
              interviewer_email: panel.rows[0].email_id,
              interviewer_type: panel.rows[0].interviewer_type || "Interviewer"
            },
            fixture.recruiterReq
          ),
        (error) => error.status === 409
      );
    } finally {
      await cleanupOfferHoldFixture(pool, fixture);
    }
  });

  it("rejects legacy-only stage transition on other requisition while hold is active", async (t) => {
    if (skipIfDisabled(t)) {
      return;
    }

    if (!(await tableExists(pool, "candidate_req_map"))) {
      t.skip("candidate_req_map not present");
      return;
    }

    const fixture = await createOfferHoldFixture(pool, {
      suffix: "legacy",
      withOtherRequisition: true
    });
    try {
      await releaseOfferAndActivateHold(pool, fixture);

      const legacyMapId = Number(fixture.mapId) + 500000 + Number(String(Date.now()).slice(-5));
      await pool.query(
        `INSERT INTO candidate_req_map (
          map_id, candidate_id, req_id, recruiter_id, stage_name, source_type, is_active
        ) VALUES ($1, $2, $3, $4, 'Applied', 'Direct', TRUE)`,
        [
          legacyMapId,
          fixture.candidateId,
          fixture.otherRequisition.reqId,
          fixture.recruiter.email_id || "integration"
        ]
      );

      await assert.rejects(
        () =>
          recruitmentService.applyGovernedCandidateStageTransition(
            pool,
            legacyMapId,
            "Screening",
            "legacy-only path",
            fixture.recruiterReq,
            { useOperationalStageName: true }
          ),
        (error) => error.status === 409
      );

      await pool.query(`DELETE FROM candidate_req_map WHERE map_id = $1`, [legacyMapId]);
    } finally {
      await cleanupOfferHoldFixture(pool, fixture);
    }
  });

  it("offer release racing mapCandidate cannot leave prohibited cross-requisition mapping", async (t) => {
    if (skipIfDisabled(t)) {
      return;
    }

    const fixture = await createOfferHoldFixture(pool, {
      suffix: "race-map",
      withOtherRequisition: true
    });
    try {
      const mapPromise = recruitmentService
        .mapCandidate(
          pool,
          {
            candidate_id: fixture.candidateId,
            requisition_code: fixture.otherRequisition.requisitionCode,
            stage_name: "Applied",
            source_type: "Direct"
          },
          fixture.recruiterReq
        )
        .then(() => ({ ok: true }))
        .catch((error) => ({ ok: false, error }));

      const releasePromise = releaseOfferAndActivateHold(pool, fixture).then(() => ({
        ok: true
      }));

      const [mapResult] = await Promise.all([mapPromise, releasePromise]);

      const holds = await countActiveHolds(pool, fixture.candidateId);
      assert.equal(holds, 1);

      const crossMap = await pool.query(
        `SELECT COUNT(*)::int AS count
         FROM rm_candidate_mappings
         WHERE candidate_id = $1
           AND requisition_code = $2
           AND is_active = TRUE`,
        [fixture.candidateId, fixture.otherRequisition.requisitionCode]
      );
      assert.equal(
        crossMap.rows[0].count,
        0,
        "Cross-requisition mapping must not commit under active hold"
      );

      assert.equal(
        mapResult.ok,
        false,
        "mapCandidate must not succeed while cross-requisition mapping is prohibited"
      );
      assert.equal(mapResult.error?.status, 409);
    } finally {
      await cleanupOfferHoldFixture(pool, fixture);
    }
  });

  it("offer release racing scheduleInterview cannot leave a new scheduled interview", async (t) => {
    if (skipIfDisabled(t)) {
      return;
    }

    const panel = await pool.query(
      `SELECT panel_id, interviewer_name, email_id, interviewer_type
       FROM interview_panel_mstr WHERE is_active = TRUE LIMIT 1`
    );
    if (!panel.rows.length) {
      t.skip("No active interview_panel_mstr row");
      return;
    }

    const fixture = await createOfferHoldFixture(pool, { suffix: "race-int" });
    try {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 3);
      const interviewDate = tomorrow.toISOString().slice(0, 10);

      const schedulePromise = interviewService
        .scheduleInterview(
          pool,
          {
            map_id: fixture.mapId,
            interviewer_id: panel.rows[0].panel_id,
            round_type: "L1",
            interview_date: interviewDate,
            interview_time: "11:00:00",
            interviewer_name: panel.rows[0].interviewer_name,
            interviewer_email: panel.rows[0].email_id
          },
          fixture.recruiterReq
        )
        .then((result) => ({ ok: true, interviewId: result.interviewId }))
        .catch((error) => ({ ok: false, error }));

      const releasePromise = releaseOfferAndActivateHold(pool, fixture);

      const [scheduleResult] = await Promise.all([schedulePromise, releasePromise]);

      const holds = await countActiveHolds(pool, fixture.candidateId);
      assert.equal(holds, 1);

      const scheduled = await pool.query(
        `SELECT COUNT(*)::int AS count
         FROM im_interviews
         WHERE candidate_id = $1
           AND interview_status = 'Scheduled'
           AND interview_date = $2`,
        [fixture.candidateId, interviewDate]
      );

      if (scheduleResult.ok) {
        assert.fail(
          `scheduleInterview committed while hold should block (interview ${scheduleResult.interviewId})`
        );
      } else {
        assert.equal(scheduleResult.error?.status, 409);
      }

      assert.equal(scheduled.rows[0].count, 0);
    } finally {
      await cleanupOfferHoldFixture(pool, fixture);
    }
  });
});
