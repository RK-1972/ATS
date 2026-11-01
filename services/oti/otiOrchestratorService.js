/**
 * OTI orchestrator — synchronous Phase 1 run execution with persisted steps/results.
 */

const crypto = require("crypto");
const resumeMatchService = require("../resumeMatchService");
const { writeEnterpriseAudit, userContext } = require("../enterpriseAuditService");
const otiQueryAgentService = require("./otiQueryAgentService");
const otiInternalDiscoveryAgentService = require("./otiInternalDiscoveryAgentService");
const otiResumeRetrievalService = require("./otiResumeRetrievalService");
const otiHybridRankService = require("./otiHybridRankService");
const otiSemanticRetrievalService = require("./otiSemanticRetrievalService");
const otiSemanticHybridRankService = require("./otiSemanticHybridRankService");
const otiEmbeddingService = require("./otiEmbeddingService");
const otiExternalDiscoveryAgentService = require("./otiExternalDiscoveryAgentService");
const otiExternalLeadService = require("./otiExternalLeadService");
const otiCapabilityAuth = require("./otiCapabilityAuth");
const otiAiGovernanceService = require("./otiAiGovernanceService");
const otiJdIntelligenceService = require("./otiJdIntelligenceService");
const otiQueryGenerationService = require("./otiQueryGenerationService");
const otiSourceSelectionService = require("./otiSourceSelectionService");
const otiTalentAdjacencyService = require("./otiTalentAdjacencyService");
const {
  OTI_MIN_RECOMMENDATION_MATCH_PCT,
  isQualifyingInternalRecommendation,
  prepareQualifyingRecommendations,
  qualifyingSourcingResultSqlPredicate
} = require("./otiRecommendationQualification");
const { describeConnectorCatalog } = require("./connectors/otiConnectorRegistry");

const QUALIFYING_SOURCING_RESULT_SQL = qualifyingSourcingResultSqlPredicate();

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function buildRunUuid() {
  return `oti-run-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

async function findRunByIdempotency(pool, initiatedBy, idempotencyKey) {
  if (!idempotencyKey) {
    return null;
  }

  const result = await pool.query(
    `SELECT *
     FROM oti_sourcing_run
     WHERE initiated_by = $1
       AND idempotency_key = $2
     ORDER BY run_id DESC
     LIMIT 1`,
    [initiatedBy, idempotencyKey]
  );

  return result.rows[0] || null;
}

async function insertRunStep(pool, runId, agentKey, status, inputSnapshot, outputSnapshot, durationMs) {
  await pool.query(
    `INSERT INTO oti_sourcing_run_step (
       run_id, agent_key, status, input_snapshot, output_snapshot, duration_ms
     ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      runId,
      agentKey,
      status,
      JSON.stringify(inputSnapshot || {}),
      JSON.stringify(outputSnapshot || {}),
      durationMs ?? null
    ]
  );
}

async function persistResults(pool, runId, rankedResults) {
  for (const row of rankedResults) {
    if (!isQualifyingInternalRecommendation(row)) {
      continue;
    }
    await pool.query(
      `INSERT INTO oti_sourcing_result (
         run_id,
         candidate_id,
         source_type,
         rank_order,
         match_pct,
         rank_score,
         matched_skills,
         missing_skills,
         explanation,
         candidate_code,
         candidate_name,
         total_experience
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        runId,
        row.candidate_id,
        row.source_type,
        row.rank_order,
        row.match_pct,
        row.rank_score,
        JSON.stringify(row.matched_skills || []),
        JSON.stringify(row.missing_skills || []),
        JSON.stringify(row.explanation || {}),
        row.candidate_code,
        row.candidate_name,
        row.total_experience
      ]
    );
  }
}

async function writeRunAudit(pool, req, payload) {
  const actor = userContext(req);

  try {
    await writeEnterpriseAudit(pool, {
      eventType: "OtiSourcingRunCompleted",
      module: "recruitment",
      entity: "requisition",
      entityId: String(payload.requisition_code),
      action: payload.success ? "run_success" : "run_failure",
      userName: actor.name,
      userRole: actor.role,
      metadata: {
        run_uuid: payload.run_uuid,
        results_count: payload.results_count ?? 0,
        excluded_count: payload.excluded_count ?? 0,
        error_message: payload.error_message || null
      }
    });
  } catch (auditError) {
    console.error("OTI run audit write failed:", auditError.message);
  }
}

async function executeSourcingRun(pool, requisitionCode, req, body = {}, entryPoint = "requisition") {
  const code = String(requisitionCode || "").trim();
  if (!code) {
    throw httpError("requisition_code is required.", 400);
  }

  const employeeCode = String(req.user?.employee_code || "").trim();
  if (!employeeCode) {
    throw httpError("Authenticated employee_code is required.", 401);
  }

  const requisitionResult = await pool.query(
    "SELECT * FROM rm_requisitions WHERE requisition_code = $1 LIMIT 1",
    [code]
  );
  const requisition = requisitionResult.rows[0] || null;

  resumeMatchService.assertApprovedOpenRequisition(requisition);
  if (entryPoint === "workspace") {
    await otiCapabilityAuth.assertCanExecuteOtiWorkspaceSourcingRun(pool, req, requisition);
  } else {
    await otiCapabilityAuth.assertCanExecuteOtiRequisitionSourcingRun(pool, req, requisition);
  }

  const idempotencyKey = String(
    body.idempotency_key || req.headers?.["idempotency-key"] || ""
  ).trim();
  if (idempotencyKey) {
    const existing = await findRunByIdempotency(pool, employeeCode, idempotencyKey);
    if (existing) {
      return loadRunSummary(pool, existing.run_id, req);
    }
  }

  const runUuid = buildRunUuid();
  const queryText = String(body.query_text || "").trim();
  const includeExternal = body.include_external === true || body.include_external === "true";
  const includeSemantic = body.include_semantic === true || body.include_semantic === "true";
  const includeAiAssist = body.include_ai_assist === true || body.include_ai_assist === "true";
  const externalProviderKeys = Array.isArray(body.external_provider_keys)
    ? body.external_provider_keys.map((key) => String(key || "").trim()).filter(Boolean)
    : [];

  const runInsert = await pool.query(
    `INSERT INTO oti_sourcing_run (
       run_uuid,
       requisition_code,
       initiated_by,
       status,
       query_text,
       query_structured,
       idempotency_key,
       started_on
     ) VALUES ($1,$2,$3,'processing',$4,'{}'::jsonb,$5,NOW())
     RETURNING *`,
    [runUuid, code, employeeCode, queryText || null, idempotencyKey || null]
  );

  const runRow = runInsert.rows[0];
  const runId = runRow.run_id;

  if (includeAiAssist) {
    await otiAiGovernanceService.assertAiAssistEnabled(pool);
  }

  const aiTracker = otiAiGovernanceService.createRunUsageTracker();
  let jdIntelligenceSnapshot = null;
  let searchStrategySnapshot = null;
  let providerSelectionSnapshot = null;

  try {
    await pool.query(
      `UPDATE oti_sourcing_run SET include_external = $1, include_semantic = $2, include_ai_assist = $3 WHERE run_id = $4`,
      [includeExternal, includeSemantic, includeAiAssist, runId]
    );
  } catch {
    await pool.query(
      `UPDATE oti_sourcing_run SET include_external = $1, include_semantic = $2 WHERE run_id = $3`,
      [includeExternal, includeSemantic, runId]
    );
  }

  try {
    let jdProfile = otiJdIntelligenceService.buildDeterministicProfile(requisition);

    if (includeAiAssist) {
      const jdStarted = Date.now();
      const jdOutput = await otiJdIntelligenceService.analyzeJdIntelligence(pool, runId, requisition, {
        useAi: true,
        tracker: aiTracker
      });
      jdProfile = jdOutput.profile;
      jdIntelligenceSnapshot = {
        profile: jdOutput.profile,
        used_ai: jdOutput.used_ai,
        fallback_reason: jdOutput.fallback_reason
      };

      await insertRunStep(
        pool,
        runId,
        "jd_intelligence",
        "completed",
        { requisition_code: code },
        jdIntelligenceSnapshot,
        Date.now() - jdStarted
      );

      const catalog = await describeConnectorCatalog();
      const strategyStarted = Date.now();
      const strategyOutput = await otiQueryGenerationService.generateSearchStrategies(
        pool,
        runId,
        jdProfile,
        catalog,
        { useAi: true, tracker: aiTracker, requisition }
      );
      searchStrategySnapshot = strategyOutput;

      await insertRunStep(
        pool,
        runId,
        "search_strategy_generation",
        "completed",
        { strategy_count: strategyOutput.bundle?.strategies?.length || 0 },
        {
          bundle: strategyOutput.bundle,
          used_ai: strategyOutput.used_ai,
          fallback_reason: strategyOutput.fallback_reason
        },
        Date.now() - strategyStarted
      );

      const selectionStarted = Date.now();
      const selectionOutput = await otiSourceSelectionService.selectSourceProviders(
        pool,
        runId,
        jdProfile,
        catalog,
        {
          useAi: true,
          tracker: aiTracker,
          explicitProviderKeys: externalProviderKeys
        }
      );
      providerSelectionSnapshot = selectionOutput;

      await insertRunStep(
        pool,
        runId,
        "provider_selection",
        "completed",
        { include_external: includeExternal },
        {
          selection: selectionOutput.selection,
          used_ai: selectionOutput.used_ai,
          fallback_reason: selectionOutput.fallback_reason
        },
        Date.now() - selectionStarted
      );

      try {
        await pool.query(
          `UPDATE oti_sourcing_run
           SET jd_intelligence_snapshot = $1,
               search_strategy_snapshot = $2,
               provider_selection_snapshot = $3
           WHERE run_id = $4`,
          [
            JSON.stringify(jdIntelligenceSnapshot),
            JSON.stringify(searchStrategySnapshot),
            JSON.stringify(providerSelectionSnapshot),
            runId
          ]
        );
      } catch {
        // migration 077 not applied — snapshots remain on run steps only
      }
    }

    const queryStarted = Date.now();
    const queryOutput = includeAiAssist
      ? {
          structured_query: otiJdIntelligenceService.profileToStructuredQuery(
            jdProfile,
            queryText,
            code
          ),
          used_llm: Boolean(jdIntelligenceSnapshot?.used_ai)
        }
      : otiQueryAgentService.buildStructuredQuery({
          queryText,
          requisition
        });
    await pool.query(
      `UPDATE oti_sourcing_run SET query_structured = $1 WHERE run_id = $2`,
      [JSON.stringify(queryOutput.structured_query), runId]
    );
    await insertRunStep(
      pool,
      runId,
      "query",
      "completed",
      { query_text: queryText },
      queryOutput,
      Date.now() - queryStarted
    );

    const discoveryStarted = Date.now();
    const discoveryOutput = await otiInternalDiscoveryAgentService.discoverInternalCandidates(
      pool,
      req,
      code
    );
    await insertRunStep(
      pool,
      runId,
      "internal_discovery",
      "completed",
      { requisition_code: code },
      discoveryOutput,
      Date.now() - discoveryStarted
    );

    const retrievalStarted = Date.now();
    const retrievalOutput = await otiResumeRetrievalService.searchIndexedCandidates(
      pool,
      req,
      {
        requisitionCode: code,
        queryText,
        requisition
      }
    );
    await insertRunStep(
      pool,
      runId,
      "resume_retrieval",
      "completed",
      { requisition_code: code, search_query: retrievalOutput.search_query },
      {
        candidates: retrievalOutput.candidates.length,
        excluded: retrievalOutput.excluded?.length || 0
      },
      Date.now() - retrievalStarted
    );

    let semanticOutput = { candidates: [], excluded: [], limitation_notes: [], semantic_enabled: false };

    if (includeSemantic && otiEmbeddingService.isEmbeddingConfigured()) {
      const semanticStarted = Date.now();
      const candidateIds = [
        ...discoveryOutput.candidates.map((row) => row.candidate_id),
        ...retrievalOutput.candidates.map((row) => row.candidate_id)
      ];

      semanticOutput = await otiSemanticRetrievalService.searchInternalCandidatesSemantic(pool, req, {
        requisitionCode: code,
        queryText,
        requisition,
        structuredQuery: queryOutput.structured_query,
        candidateIdsToEmbed: candidateIds
      });

      await insertRunStep(
        pool,
        runId,
        "semantic_retrieval",
        "completed",
        { include_semantic: true },
        {
          candidates: semanticOutput.candidates.length,
          excluded: semanticOutput.excluded?.length || 0,
          semantic_enabled: semanticOutput.semantic_enabled
        },
        Date.now() - semanticStarted
      );

      await pool.query(
        `UPDATE oti_sourcing_run SET semantic_summary = $1 WHERE run_id = $2`,
        [
          JSON.stringify({
            semantic_enabled: semanticOutput.semantic_enabled,
            candidate_count: semanticOutput.candidates.length
          }),
          runId
        ]
      );
    }

    const rankStarted = Date.now();
    const rankOutput =
      includeSemantic && semanticOutput.semantic_enabled
        ? await otiSemanticHybridRankService.rankInternalCandidatesSemanticHybrid(
            pool,
            requisition,
            discoveryOutput.candidates,
            retrievalOutput.candidates,
            semanticOutput.candidates,
            {
              queryText,
              structuredSkillTokens: queryOutput.structured_query?.skill_tokens
            }
          )
        : await otiHybridRankService.rankInternalCandidatesHybrid(
            pool,
            requisition,
            discoveryOutput.candidates,
            retrievalOutput.candidates,
            {
              queryText,
              structuredSkillTokens: queryOutput.structured_query?.skill_tokens
            }
          );
    await insertRunStep(
      pool,
      runId,
      "match_rank",
      "completed",
      {
        structured_count: discoveryOutput.candidates.length,
        retrieval_count: retrievalOutput.candidates.length,
        semantic_count: semanticOutput.candidates.length,
        ranking_mode: includeSemantic && semanticOutput.semantic_enabled ? "phase5_semantic" : "phase2_hybrid"
      },
      { results_count: rankOutput.ranked_results.length },
      Date.now() - rankStarted
    );

    let rankedResults = rankOutput.ranked_results;
    if (includeAiAssist) {
      rankedResults = otiTalentAdjacencyService.enrichRankedResults(rankedResults, jdProfile);
    }
    rankedResults = prepareQualifyingRecommendations(rankedResults);

    await persistResults(pool, runId, rankedResults);

    let externalOutput = null;
    let externalLeadsCount = 0;
    const resolvedExternalProviderKeys =
      includeAiAssist && providerSelectionSnapshot?.selection?.selected_provider_keys?.length
        ? providerSelectionSnapshot.selection.selected_provider_keys
        : externalProviderKeys;
    const resolvedProviderQueries =
      includeAiAssist && searchStrategySnapshot?.bundle?.provider_queries
        ? searchStrategySnapshot.bundle.provider_queries
        : {};

    if (includeExternal) {
      const externalStarted = Date.now();
      externalOutput = await otiExternalDiscoveryAgentService.discoverExternalCandidates(
        pool,
        runId,
        {
          queryText,
          structuredQuery: queryOutput.structured_query,
          requisition,
          providerKeys: resolvedExternalProviderKeys,
          providerQueries: resolvedProviderQueries
        }
      );
      externalLeadsCount = externalOutput.staged_count || 0;

      await insertRunStep(
        pool,
        runId,
        "external_discovery",
        "completed",
        {
          include_external: true,
          provider_keys: externalProviderKeys
        },
        {
          staged_count: externalLeadsCount,
          connector_results: externalOutput.connector_results,
          provider_metrics: externalOutput.provider_metrics,
          consolidated_totals: externalOutput.consolidated_totals,
          discovery_filter: externalOutput.discovery_filter
        },
        Date.now() - externalStarted
      );

      await pool.query(
        `UPDATE oti_sourcing_run
         SET external_summary = $1
         WHERE run_id = $2`,
        [
          JSON.stringify({
            staged_count: externalLeadsCount,
            configured_connector_count: externalOutput.configured_connector_count,
            connector_results: externalOutput.connector_results,
            provider_metrics: externalOutput.provider_metrics,
            consolidated_totals: externalOutput.consolidated_totals,
            discovery_filter: externalOutput.discovery_filter
          }),
          runId
        ]
      );
    }

    const aiUsageSummary = includeAiAssist
      ? otiAiGovernanceService.buildUsageSummary(aiTracker)
      : null;

    try {
      await pool.query(
        `UPDATE oti_sourcing_run
         SET status = 'completed',
             completed_on = NOW(),
             ai_usage_summary = $2
         WHERE run_id = $1`,
        [runId, JSON.stringify(aiUsageSummary || {})]
      );
    } catch {
      await pool.query(
        `UPDATE oti_sourcing_run SET status = 'completed', completed_on = NOW() WHERE run_id = $1`,
        [runId]
      );
    }

    const limitationNotes = [
      ...(discoveryOutput.limitation_notes || []),
      ...(externalOutput?.limitation_notes || []),
      ...(semanticOutput?.limitation_notes || []),
      ...(aiUsageSummary?.limitation_notes || [])
    ];

    if (!(rankOutput.required_skills || []).length) {
      limitationNotes.push(
        "Requisition primary_skill is not configured and no sourcing query skills were provided. Internal match scores require published skill requirements."
      );
    } else if (rankedResults.length === 0 && (discoveryOutput.candidates || []).length > 0) {
      limitationNotes.push(
        `No internal candidates met the minimum ${OTI_MIN_RECOMMENDATION_MATCH_PCT}% structured skill match threshold for this requisition.`
      );
    }

    await writeRunAudit(pool, req, {
      success: true,
      requisition_code: code,
      run_uuid: runUuid,
      results_count: rankedResults.length,
      excluded_count: discoveryOutput.excluded?.length || 0,
      external_leads_count: externalLeadsCount
    });

    return loadRunSummary(pool, runId, req, {
      required_skills: rankOutput.required_skills,
      limitation_notes: limitationNotes,
      external_leads_count: externalLeadsCount,
      include_external: includeExternal,
      include_ai_assist: includeAiAssist,
      jd_intelligence: jdIntelligenceSnapshot,
      search_strategies: searchStrategySnapshot?.bundle || null,
      provider_selection: providerSelectionSnapshot?.selection || null,
      ai_usage_summary: aiUsageSummary,
      internal_results_count: rankedResults.length
    });
  } catch (error) {
    await pool.query(
      `UPDATE oti_sourcing_run
       SET status = 'failed', error_message = $2, completed_on = NOW()
       WHERE run_id = $1`,
      [runId, error.message || "OTI run failed."]
    );

    await writeRunAudit(pool, req, {
      success: false,
      requisition_code: code,
      run_uuid: runUuid,
      error_message: error.message
    });

    throw error;
  }
}

function mapRunRow(row) {
  return {
    run_id: row.run_uuid,
    run_internal_id: row.run_id,
    requisition_code: row.requisition_code,
    status: row.status,
    query_text: row.query_text,
    query_structured: row.query_structured,
    initiated_by: row.initiated_by,
    error_message: row.error_message,
    include_external: Boolean(row.include_external),
    include_semantic: Boolean(row.include_semantic),
    include_ai_assist: Boolean(row.include_ai_assist),
    external_summary: row.external_summary || {},
    external_leads_count: Number(row.external_summary?.staged_count) || 0,
    semantic_summary: row.semantic_summary || {},
    jd_intelligence_snapshot: row.jd_intelligence_snapshot || {},
    search_strategy_snapshot: row.search_strategy_snapshot || {},
    provider_selection_snapshot: row.provider_selection_snapshot || {},
    ai_usage_summary: row.ai_usage_summary || {},
    created_on: row.created_on,
    completed_on: row.completed_on
  };
}

async function loadRunSummary(pool, runInternalId, req, extras = {}) {
  const runResult = await pool.query(
    "SELECT * FROM oti_sourcing_run WHERE run_id = $1 LIMIT 1",
    [runInternalId]
  );
  const runRow = runResult.rows[0];

  await otiCapabilityAuth.assertCanAccessOtiRunRecord(pool, req, runRow);

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM oti_sourcing_result
     WHERE run_id = $1
       AND ${QUALIFYING_SOURCING_RESULT_SQL}`,
    [runInternalId]
  );

  return {
    ...mapRunRow(runRow),
    results_count: countResult.rows[0]?.total || 0,
    required_skills: extras.required_skills || null,
    limitation_notes: extras.limitation_notes || null,
    external_leads_count:
      extras.external_leads_count ?? (Number(runRow.external_summary?.staged_count) || 0),
    include_external: extras.include_external ?? Boolean(runRow.include_external),
    include_ai_assist: extras.include_ai_assist ?? Boolean(runRow.include_ai_assist),
    jd_intelligence: extras.jd_intelligence ?? runRow.jd_intelligence_snapshot ?? null,
    search_strategies: extras.search_strategies ?? runRow.search_strategy_snapshot?.bundle ?? null,
    provider_selection:
      extras.provider_selection ?? runRow.provider_selection_snapshot?.selection ?? null,
    ai_usage_summary: extras.ai_usage_summary ?? runRow.ai_usage_summary ?? null,
    internal_results_count: extras.internal_results_count ?? null
  };
}

async function getRunByPublicId(pool, runPublicId, req) {
  const result = await pool.query(
    "SELECT * FROM oti_sourcing_run WHERE run_uuid = $1 LIMIT 1",
    [String(runPublicId || "").trim()]
  );
  const runRow = result.rows[0];

  if (!runRow) {
    throw httpError("Sourcing run not found.", 404);
  }

  return loadRunSummary(pool, runRow.run_id, req);
}

async function listRunsForRequisition(pool, requisitionCode, req, entryPoint = "requisition") {
  const code = String(requisitionCode || "").trim();
  const requisitionResult = await pool.query(
    "SELECT * FROM rm_requisitions WHERE requisition_code = $1 LIMIT 1",
    [code]
  );
  const requisition = requisitionResult.rows[0] || null;

  resumeMatchService.assertApprovedOpenRequisition(requisition);
  if (entryPoint === "workspace") {
    await otiCapabilityAuth.assertCanExecuteOtiWorkspaceSourcingRun(pool, req, requisition);
  } else {
    await otiCapabilityAuth.assertCanExecuteOtiRequisitionSourcingRun(pool, req, requisition);
  }

  const result = await pool.query(
    `SELECT run_uuid, requisition_code, status, query_text, initiated_by, created_on, completed_on,
            (SELECT COUNT(*)::int FROM oti_sourcing_result r
              WHERE r.run_id = s.run_id AND ${qualifyingSourcingResultSqlPredicate("r").replace(/\n/g, " ")}) AS results_count
     FROM oti_sourcing_run s
     WHERE s.requisition_code = $1
     ORDER BY s.created_on DESC
     LIMIT 50`,
    [code]
  );

  return result.rows.map((row) => ({
    run_id: row.run_uuid,
    requisition_code: row.requisition_code,
    status: row.status,
    query_text: row.query_text,
    initiated_by: row.initiated_by,
    results_count: row.results_count,
    created_on: row.created_on,
    completed_on: row.completed_on
  }));
}

function parsePaginationOptions(query = {}) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(query.page_size) || 25));
  const externalPage = Math.max(1, Number(query.external_page) || 1);
  const externalPageSize = Math.min(100, Math.max(1, Number(query.external_page_size) || 10));

  return { page, pageSize, externalPage, externalPageSize };
}

async function listRunResults(pool, runPublicId, req, query = {}) {
  const { page, pageSize, externalPage, externalPageSize } = parsePaginationOptions(query);
  const runResult = await pool.query(
    "SELECT * FROM oti_sourcing_run WHERE run_uuid = $1 LIMIT 1",
    [String(runPublicId || "").trim()]
  );
  const runRow = runResult.rows[0];

  if (!runRow) {
    throw httpError("Sourcing run not found.", 404);
  }

  await otiCapabilityAuth.assertCanAccessOtiRunRecord(pool, req, runRow);

  if (String(runRow.status || "").trim() === "failed") {
    return {
      run: mapRunRow(runRow),
      results: [],
      run_failed: true,
      error_message: runRow.error_message || "Sourcing run failed."
    };
  }

  const countInternal = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM oti_sourcing_result
     WHERE run_id = $1
       AND ${QUALIFYING_SOURCING_RESULT_SQL}`,
    [runRow.run_id]
  );
  const internalTotal = countInternal.rows[0]?.total || 0;
  const internalTotalPages = Math.max(1, Math.ceil(internalTotal / pageSize) || 1);
  const internalPage = internalTotal === 0 ? 1 : Math.min(page, internalTotalPages);
  const internalOffset = (internalPage - 1) * pageSize;

  const results = await pool.query(
    `SELECT
        result_id,
        candidate_id,
        candidate_code,
        candidate_name,
        source_type,
        rank_order,
        match_pct,
        rank_score,
        matched_skills,
        missing_skills,
        explanation,
        total_experience
     FROM oti_sourcing_result
     WHERE run_id = $1
       AND ${QUALIFYING_SOURCING_RESULT_SQL}
     ORDER BY match_pct DESC, total_experience DESC NULLS LAST, rank_order ASC, result_id ASC
     LIMIT $2 OFFSET $3`,
    [runRow.run_id, pageSize, internalOffset]
  );

  const actions = await pool.query(
    `SELECT result_id, action_type, note, actor_employee_code, created_on
     FROM oti_recruiter_action
     WHERE run_id = $1
     ORDER BY created_on DESC`,
    [runRow.run_id]
  );

  const actionsByResult = new Map();
  for (const action of actions.rows) {
    const list = actionsByResult.get(action.result_id) || [];
    list.push({
      action_type: action.action_type,
      note: action.note,
      actor_employee_code: action.actor_employee_code,
      created_on: action.created_on
    });
    actionsByResult.set(action.result_id, list);
  }

  const externalLeadsAll = await otiExternalLeadService.listExternalLeadsForRun(pool, runRow.run_id);
  const externalTotal = externalLeadsAll.length;
  const externalOffset = (externalPage - 1) * externalPageSize;
  const externalLeads = externalLeadsAll.slice(externalOffset, externalOffset + externalPageSize);

  return {
    run: mapRunRow(runRow),
    external_leads: externalLeads,
    pagination: {
      internal: {
        page: internalPage,
        page_size: pageSize,
        total: internalTotal,
        total_pages: internalTotalPages
      },
      external: {
        page: externalPage,
        page_size: externalPageSize,
        total: externalTotal,
        total_pages: Math.max(1, Math.ceil(externalTotal / externalPageSize))
      }
    },
    results: results.rows.map((row) => ({
      result_id: row.result_id,
      candidate_id: row.candidate_id,
      candidate_code: row.candidate_code,
      candidate_name: row.candidate_name,
      source_type: row.source_type,
      rank_order: row.rank_order,
      match_pct: row.match_pct,
      rank_score: Number(row.rank_score),
      matched_skills: row.matched_skills,
      missing_skills: row.missing_skills,
      explanation: row.explanation,
      total_experience: row.total_experience,
      recruiter_actions: actionsByResult.get(row.result_id) || []
    }))
  };
}

module.exports = {
  executeSourcingRun,
  getRunByPublicId,
  listRunsForRequisition,
  listRunResults,
  loadRunSummary
};
