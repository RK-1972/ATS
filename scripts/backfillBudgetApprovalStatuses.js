/**
 * One-time Sprint 2.1 backfill: migrate legacy Budget approval status strings
 * in wp_config_state draft/published payloads to enterprise Level-1/Level-2 labels.
 */
require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

const STATUS_MAP = {
  "Pending TA Lead": "Pending Level-1 Approval",
  "Pending Finance": "Pending Level-2 Approval"
};

const APPROVER_MAP = {
  "TA Lead": "Level-1 Approver",
  Finance: "Level-2 Approver",
  "TA Leader": "Level-1 Approver"
};

function migrateStatus(value) {
  return STATUS_MAP[value] || value;
}

function migrateApprover(value) {
  return APPROVER_MAP[value] || value;
}

function migrateTimeline(entries) {
  return (entries || []).map((entry) => ({
    ...entry,
    step:
      entry.step === "Approved by TA Lead"
        ? "Level-1 Approved"
        : entry.step === "Approved by Finance"
          ? "Level-2 Approved"
          : entry.step,
    actor:
      typeof entry.actor === "string"
        ? entry.actor
            .replace(/\(TA Lead\)/g, "(Level-1 Approver)")
            .replace(/\(Finance\)/g, "(Level-2 Approver)")
        : entry.actor
  }));
}

function migrateHistory(entries) {
  return (entries || []).map((entry) => ({
    ...entry,
    actor:
      typeof entry.actor === "string"
        ? entry.actor
            .replace(/\(TA Lead\)/g, "(Level-1 Approver)")
            .replace(/\(Finance\)/g, "(Level-2 Approver)")
        : entry.actor
  }));
}

function migrateBudgetItem(item) {
  if (!item || typeof item !== "object") {
    return item;
  }

  return {
    ...item,
    status: migrateStatus(item.status),
    current_approver: migrateApprover(item.current_approver),
    timeline: migrateTimeline(item.timeline),
    history: migrateHistory(item.history)
  };
}

function migratePayload(payload) {
  if (!payload || typeof payload !== "object") {
    return { payload, changed: false };
  }

  const before = JSON.stringify(payload);
  const next = {
    ...payload,
    budget_requests: (payload.budget_requests || []).map(migrateBudgetItem),
    approval_queue: (payload.approval_queue || []).map(migrateBudgetItem),
    budget_exceptions: (payload.budget_exceptions || []).map((item) => ({
      ...item,
      workflow_status: migrateStatus(item.workflow_status),
      approver: migrateApprover(item.approver)
    })),
    dashboard: {
      ...(payload.dashboard || {}),
      budget_exceptions_summary: (
        payload.dashboard?.budget_exceptions_summary || []
      ).map((item) => ({
        ...item,
        status: migrateStatus(item.status)
      }))
    }
  };

  const after = JSON.stringify(next);
  return { payload: next, changed: before !== after };
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      `SELECT draft_payload, published_payload
       FROM wp_config_state
       WHERE id = 1
       FOR UPDATE`
    );

    if (!locked.rows[0]) {
      throw new Error("wp_config_state row missing");
    }

    const draft = migratePayload(locked.rows[0].draft_payload);
    const published = migratePayload(locked.rows[0].published_payload);

    if (!draft.changed && !published.changed) {
      await client.query("ROLLBACK");
      console.log("No legacy Budget status strings found. Nothing to backfill.");
      return;
    }

    await client.query(
      `UPDATE wp_config_state
       SET draft_payload = $1,
           published_payload = $2,
           modified_by = 'Sprint 2.1 Backfill',
           modified_on = NOW()
       WHERE id = 1`,
      [JSON.stringify(draft.payload), JSON.stringify(published.payload)]
    );

    await client.query("COMMIT");
    console.log("Backfill complete.", {
      draftChanged: draft.changed,
      publishedChanged: published.changed
    });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
