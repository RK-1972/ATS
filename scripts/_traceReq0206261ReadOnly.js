require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

async function main() {
  const code = "REQ0206261";

  const req = (
    await pool.query(
      "SELECT * FROM rm_requisitions WHERE requisition_code = $1",
      [code]
    )
  ).rows[0];

  console.log("RM_REQUISITION:", JSON.stringify(req, null, 2));

  if (req?.req_id) {
    const legacy = (
      await pool.query("SELECT * FROM req_mstr WHERE req_id = $1", [req.req_id])
    ).rows[0];
    console.log("REQ_MSTR:", JSON.stringify(legacy, null, 2));
  }

  if (req?.approved_position_id) {
    const pos = (
      await pool.query(
        "SELECT * FROM wp_approved_positions WHERE position_id = $1",
        [req.approved_position_id]
      )
    ).rows[0];
    console.log("WP_APPROVED_POSITION:", JSON.stringify(pos, null, 2));
  }

  const audit = await pool.query(
    `SELECT event_type, action, user_name, metadata, created_on
     FROM md_enterprise_audit
     WHERE entity = 'Requisition' AND entity_id = $1
     ORDER BY created_on ASC`,
    [code]
  );
  console.log("AUDIT_EVENTS:", JSON.stringify(audit.rows, null, 2));

  const tdDraft = await pool.query(
    `SELECT * FROM td_draft_mstr WHERE requisition_code = $1 OR draft_payload::text ILIKE $2`,
    [code, `%${code}%`]
  );
  console.log("TD_DRAFT:", JSON.stringify(tdDraft.rows, null, 2));
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  })
  .finally(() => pool.end());
