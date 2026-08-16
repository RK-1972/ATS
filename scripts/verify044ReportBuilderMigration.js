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
  const tables = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name LIKE 'rb_%'
    ORDER BY table_name
  `);
  console.log("=== rb_* tables ===");
  console.log(tables.rows.map((row) => row.table_name).join(", "));

  const datasets = await pool.query(`
    SELECT dataset_id, code, name, base_view_key, is_active, display_order
    FROM rb_dataset
    ORDER BY display_order
  `);
  console.log("\n=== rb_dataset ===");
  console.table(datasets.rows);

  const fieldCounts = await pool.query(`
    SELECT d.code AS dataset_code, COUNT(f.field_id)::int AS field_count
    FROM rb_dataset d
    LEFT JOIN rb_field f ON f.dataset_id = d.dataset_id
    GROUP BY d.code, d.display_order
    ORDER BY d.display_order
  `);
  console.log("\n=== field counts ===");
  console.table(fieldCounts.rows);

  const filterCounts = await pool.query(`
    SELECT d.code AS dataset_code, COUNT(fl.filter_id)::int AS filter_count
    FROM rb_dataset d
    LEFT JOIN rb_filter fl ON fl.dataset_id = d.dataset_id
    GROUP BY d.code, d.display_order
    ORDER BY d.display_order
  `);
  console.log("\n=== filter counts ===");
  console.table(filterCounts.rows);

  const datasetPerms = await pool.query(`
    SELECT r.role_name, d.code AS dataset_code, r.can_view, r.can_export
    FROM rb_role_dataset_permission r
    INNER JOIN rb_dataset d ON d.dataset_id = r.dataset_id
    ORDER BY d.code
  `);
  console.log("\n=== dataset permissions ===");
  console.table(datasetPerms.rows);

  const fieldPermCounts = await pool.query(`
    SELECT d.code AS dataset_code, COUNT(p.permission_id)::int AS admin_field_permissions
    FROM rb_dataset d
    LEFT JOIN rb_field f ON f.dataset_id = d.dataset_id
    LEFT JOIN rb_role_field_permission p
      ON p.field_id = f.field_id AND p.role_name = 'Admin'
    GROUP BY d.code, d.display_order
    ORDER BY d.display_order
  `);
  console.log("\n=== admin field permission counts ===");
  console.table(fieldPermCounts.rows);

  const orphanFields = await pool.query(`
    SELECT COUNT(*)::int AS orphan_count
    FROM rb_field f
    LEFT JOIN rb_dataset d ON d.dataset_id = f.dataset_id
    WHERE d.dataset_id IS NULL
  `);
  const orphanFilters = await pool.query(`
    SELECT COUNT(*)::int AS orphan_count
    FROM rb_filter fl
    LEFT JOIN rb_field f ON f.field_id = fl.field_id
    WHERE f.field_id IS NULL
  `);
  console.log("\n=== orphan checks ===");
  console.log("orphan fields:", orphanFields.rows[0].orphan_count);
  console.log("orphan filters:", orphanFilters.rows[0].orphan_count);

  const pipelineFields = await pool.query(`
    SELECT f.code, f.label, f.data_type, f.default_visible, f.display_order
    FROM rb_field f
    INNER JOIN rb_dataset d ON d.dataset_id = f.dataset_id
    WHERE d.code = 'CANDIDATE_PIPELINE'
    ORDER BY f.display_order
  `);
  console.log("\n=== CANDIDATE_PIPELINE fields ===");
  console.table(pipelineFields.rows);

  const reqFields = await pool.query(`
    SELECT f.code, f.label, f.data_type, f.default_visible, f.display_order
    FROM rb_field f
    INNER JOIN rb_dataset d ON d.dataset_id = f.dataset_id
    WHERE d.code = 'REQUISITION_SUMMARY'
    ORDER BY f.display_order
  `);
  console.log("\n=== REQUISITION_SUMMARY fields ===");
  console.table(reqFields.rows);

  const pipelineFilters = await pool.query(`
    SELECT fl.code, fl.label, fl.operator_type, f.code AS field_code
    FROM rb_filter fl
    INNER JOIN rb_dataset d ON d.dataset_id = fl.dataset_id
    INNER JOIN rb_field f ON f.field_id = fl.field_id
    WHERE d.code = 'CANDIDATE_PIPELINE'
    ORDER BY fl.display_order
  `);
  console.log("\n=== CANDIDATE_PIPELINE filters ===");
  console.table(pipelineFilters.rows);

  const reqFilters = await pool.query(`
    SELECT fl.code, fl.label, fl.operator_type, f.code AS field_code
    FROM rb_filter fl
    INNER JOIN rb_dataset d ON d.dataset_id = fl.dataset_id
    INNER JOIN rb_field f ON f.field_id = fl.field_id
    WHERE d.code = 'REQUISITION_SUMMARY'
    ORDER BY fl.display_order
  `);
  console.log("\n=== REQUISITION_SUMMARY filters ===");
  console.table(reqFilters.rows);

  await pool.end();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
