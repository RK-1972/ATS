require("dotenv").config();

const { Pool } = require("pg");
const recruitmentService = require("../services/recruitmentService");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

async function loadDashboard(fromDate, toDate) {
  const req = {
    user: { employee_code: "IGS0506", role_name: "Recruiter", user_id: 10 },
    query: { fromDate, toDate }
  };
  return recruitmentService.getMyRecruiterDashboard(pool, req);
}

function printSummary(label, bundle) {
  console.log(`\n=== ${label} (${bundle.filter.fromDate} → ${bundle.filter.toDate}) ===`);
  console.log({
    activeCandidates: bundle.summary.activeCandidates,
    interviewsInRange: bundle.summary.interviewsInRange,
    pendingFeedbackInRange: bundle.summary.pendingFeedbackInRange,
    offersInRange: bundle.summary.offersInRange,
    pendingTasks: bundle.summary.pendingTasks,
    pipelineStageCounts: bundle.summary.pipelineStageCounts,
    pipelineEntered: bundle.pipeline.length,
    activePipeline: bundle.activePipeline.length,
    interviews: bundle.interviews.length,
    tasks: bundle.tasks.length,
    offerCandidates: bundle.offerCandidates.length
  });
}

async function inspectDateSpread() {
  const spread = await pool.query(
    `SELECT
       MIN(DATE(applied_on)) AS min_applied,
       MAX(DATE(applied_on)) AS max_applied,
       COUNT(*)::int AS mapping_count,
       (SELECT COUNT(*)::int FROM rm_pipeline_history) AS history_count,
       (SELECT MIN(interview_date) FROM im_interviews) AS min_interview,
       (SELECT MAX(interview_date) FROM im_interviews) AS max_interview,
       (SELECT COUNT(*)::int FROM im_interviews) AS interview_count
     FROM rm_candidate_mappings
     WHERE is_active = true`
  );
  console.log("\n=== Database date spread ===");
  console.log(spread.rows[0]);
}

async function main() {
  const today = todayIso();
  const ranges = [
    { label: "Today", fromDate: today, toDate: today },
    { label: "Last 7 Days", fromDate: addDays(today, -6), toDate: today },
    { label: "Last 30 Days", fromDate: addDays(today, -29), toDate: today },
    { label: "April 2026", fromDate: "2026-04-01", toDate: "2026-04-30" }
  ];

  await inspectDateSpread();

  const results = [];
  for (const range of ranges) {
    const bundle = await loadDashboard(range.fromDate, range.toDate);
    printSummary(range.label, bundle);
    results.push({
      label: range.label,
      activeCandidates: bundle.summary.activeCandidates,
      interviewsInRange: bundle.summary.interviewsInRange,
      pendingFeedbackInRange: bundle.summary.pendingFeedbackInRange,
      offersInRange: bundle.summary.offersInRange,
      appliedStage: bundle.summary.pipelineStageCounts?.Applied ?? 0
    });
  }

  const uniqueSignatures = new Set(
    results.map((row) => JSON.stringify({
      activeCandidates: row.activeCandidates,
      interviewsInRange: row.interviewsInRange,
      pendingFeedbackInRange: row.pendingFeedbackInRange,
      offersInRange: row.offersInRange,
      appliedStage: row.appliedStage
    }))
  );

  console.log("\n=== Validation ===");
  if (uniqueSignatures.size <= 1) {
    console.log("WARNING: All date ranges returned identical summary values.");
    console.log("The current database may not contain sufficient historical data to demonstrate date filtering.");
    console.log("Run scripts/seedRecruiterDashboardDateSamples.sql to insert spread sample data.");
  } else {
    console.log(`PASS: ${uniqueSignatures.size} distinct summary signatures across ${results.length} ranges.`);
  }

  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});
