/**
 * Read-only audit: Request Queue ordering vs wf_history.
 * Does NOT modify any data.
 */
require("dotenv").config();
const { Pool } = require("pg");
const workforcePlanningService = require("../services/workforcePlanningService");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD
});

function parseTs(value) {
  if (!value) {
    return { raw: value, numeric: 0, valid: false };
  }
  const d = new Date(value);
  const numeric = d.getTime();
  return {
    raw: value,
    iso: Number.isNaN(numeric) ? null : d.toISOString(),
    numeric: Number.isNaN(numeric) ? 0 : numeric,
    valid: !Number.isNaN(numeric) && numeric > 0
  };
}

async function main() {
  const bundle = await workforcePlanningService.getWorkforceBundle(pool);
  const queue = bundle.config.approval_queue || [];

  console.log("\n=== GET /api/v1/workforce → config.approval_queue (first 10 as API returns) ===\n");
  queue.slice(0, 10).forEach((item, index) => {
    const ts = parseTs(item.latest_activity_at);
    console.log(
      `API position ${index + 1}: ${item.id} | status=${item.status} | latest_activity_at=${ts.raw} | numeric=${ts.numeric}`
    );
  });

  const targetId = "BR-2026-1063";
  const target = queue.find((item) => item.id === targetId);
  const targetApiRank = queue.findIndex((item) => item.id === targetId) + 1;

  console.log(`\n=== ${targetId} in API response ===`);
  console.log("API array rank:", targetApiRank || "NOT IN QUEUE");
  if (target) {
    const ts = parseTs(target.latest_activity_at);
    console.log("latest_activity_at raw:", ts.raw);
    console.log("parsed ISO:", ts.iso);
    console.log("numeric:", ts.numeric);
    console.log("workflow_instance_id:", target.workflow_instance_id);
  }

  const instanceId = target?.workflow_instance_id || `WF-BR-${targetId}`;
  const history = await pool.query(
    `SELECT event_type, action, actor, recorded_on, comments
     FROM wf_history
     WHERE instance_id = $1
     ORDER BY recorded_on DESC
     LIMIT 15`,
    [instanceId]
  );

  console.log(`\n=== wf_history for ${instanceId} (newest first) ===\n`);
  history.rows.forEach((row, index) => {
    const ts = parseTs(row.recorded_on);
    console.log(
      `${index + 1}. ${row.event_type} | ${row.action} | recorded_on=${row.recorded_on} | numeric=${ts.numeric}`
    );
  });

  const maxHistory = await pool.query(
    `SELECT MAX(recorded_on) AS max_on FROM wf_history WHERE instance_id = $1`,
    [instanceId]
  );
  const maxOn = maxHistory.rows[0]?.max_on;
  const maxParsed = parseTs(maxOn);

  console.log("\n=== wf_history MAX(recorded_on) vs latest_activity_at on queue item ===");
  console.log("MAX(wf_history.recorded_on):", maxOn, "| numeric:", maxParsed.numeric);
  if (target) {
    console.log("queue item latest_activity_at:", target.latest_activity_at, "| numeric:", parseTs(target.latest_activity_at).numeric);
    console.log("MATCH:", maxParsed.numeric === parseTs(target.latest_activity_at).numeric);
  }

  // Simulate frontend sort (current code path)
  const utils = require("../../ats-frontend/src/utils/budgetApprovalHistoryUtils.js");
  const sorted = utils.sortApprovalQueueByLatestActivity(queue);

  console.log("\n=== After frontend sortApprovalQueueByLatestActivity (simulated render order, first 10) ===\n");
  sorted.slice(0, 10).forEach((item, index) => {
    const ts = parseTs(item.latest_activity_at);
    const sortTs = utils.parseLatestActivityTimestamp(item);
    console.log(
      `Render card #${index + 1}: ${item.id} | latest_activity_at=${ts.raw} | parseLatestActivityTimestamp=${sortTs}`
    );
  });

  const targetRenderRank = sorted.findIndex((item) => item.id === targetId) + 1;
  console.log(`\n${targetId} simulated render rank: ${targetRenderRank}`);

  // Find item with true max wf_history across all queue items
  const instanceIds = queue.map(
    (item) => String(item.workflow_instance_id || `WF-BR-${item.id}`)
  );
  const allMax = await pool.query(
    `SELECT instance_id, MAX(recorded_on) AS max_on
     FROM wf_history
     WHERE instance_id = ANY($1::text[])
     GROUP BY instance_id
     ORDER BY max_on DESC
     LIMIT 10`,
    [instanceIds]
  );

  console.log("\n=== Top 10 queue items by actual MAX(wf_history.recorded_on) ===\n");
  for (const row of allMax.rows) {
    const reqId = row.instance_id.replace(/^WF-BR-/, "");
    const queueItem = queue.find((item) => item.id === reqId);
    const enrichTs = parseTs(queueItem?.latest_activity_at);
    console.log(
      `${reqId} | wf_max=${row.max_on} (${parseTs(row.max_on).numeric}) | enriched latest_activity_at=${queueItem?.latest_activity_at} (${enrichTs.numeric})`
    );
  }

  const globalMaxInstance = allMax.rows[0]?.instance_id;
  const globalMaxReqId = globalMaxInstance?.replace(/^WF-BR-/, "");
  console.log("\n=== ACCEPTANCE CHECK ===");
  console.log("Request with newest wf_history activity:", globalMaxReqId);
  console.log("Should be render card #1:", globalMaxReqId);
  console.log("Actual simulated render card #1:", sorted[0]?.id);
  console.log("PASS:", sorted[0]?.id === globalMaxReqId);

  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
