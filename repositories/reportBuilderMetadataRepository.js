/**
 * Report Builder — metadata reads only.
 * Tables: rb_dataset, rb_field, rb_filter,
 *         rb_role_dataset_permission, rb_role_field_permission
 */

async function listAuthorizedDatasets(pool, roleName) {
  const result = await pool.query(
    `SELECT
       d.code,
       d.name,
       d.description,
       d.display_order
     FROM rb_dataset d
     INNER JOIN rb_role_dataset_permission p
       ON p.dataset_id = d.dataset_id
      AND p.role_name = $1
      AND p.can_view = TRUE
     WHERE d.is_active = TRUE
     ORDER BY d.display_order ASC, d.name ASC`,
    [roleName]
  );

  return result.rows;
}

async function getActiveDatasetByCode(pool, datasetCode) {
  const result = await pool.query(
    `SELECT
       d.dataset_id,
       d.code,
       d.name,
       d.description,
       d.display_order,
       d.base_view_key
     FROM rb_dataset d
     WHERE d.code = $1
       AND d.is_active = TRUE`,
    [datasetCode]
  );

  return result.rows[0] || null;
}

async function hasDatasetViewPermission(pool, roleName, datasetId) {
  const result = await pool.query(
    `SELECT 1
     FROM rb_role_dataset_permission
     WHERE role_name = $1
       AND dataset_id = $2
       AND can_view = TRUE`,
    [roleName, datasetId]
  );

  return result.rowCount > 0;
}

async function listAuthorizedFields(pool, roleName, datasetId) {
  const result = await pool.query(
    `SELECT
       f.code,
       f.label,
       f.data_type,
       (f.is_filterable AND p.can_filter) AS filterable,
       (f.is_sortable AND p.can_sort) AS sortable,
       (f.is_groupable AND p.can_group) AS groupable,
       f.default_visible,
       f.display_order,
       f.enum_values
     FROM rb_field f
     INNER JOIN rb_role_field_permission p
       ON p.field_id = f.field_id
      AND p.role_name = $1
      AND p.can_view = TRUE
     WHERE f.dataset_id = $2
     ORDER BY f.display_order ASC, f.label ASC`,
    [roleName, datasetId]
  );

  return result.rows;
}

async function listAuthorizedFilters(pool, roleName, datasetId) {
  const result = await pool.query(
    `SELECT
       fl.code,
       f.code AS field_code,
       fl.label,
       fl.operator_type,
       fl.is_required,
       fl.display_order
     FROM rb_filter fl
     INNER JOIN rb_field f
       ON f.field_id = fl.field_id
     INNER JOIN rb_role_field_permission p
       ON p.field_id = f.field_id
      AND p.role_name = $1
      AND p.can_view = TRUE
      AND p.can_filter = TRUE
     WHERE fl.dataset_id = $2
       AND f.is_filterable = TRUE
     ORDER BY fl.display_order ASC, fl.label ASC`,
    [roleName, datasetId]
  );

  return result.rows;
}

async function listAuthorizedQueryFields(pool, roleName, datasetId) {
  const result = await pool.query(
    `SELECT
       f.code,
       f.label,
       f.data_type,
       f.sql_expression,
       f.is_filterable,
       f.is_sortable,
       f.is_groupable,
       f.enum_values,
       (f.is_filterable AND p.can_filter) AS filterable,
       (f.is_sortable AND p.can_sort) AS sortable,
       (f.is_groupable AND p.can_group) AS groupable,
       p.can_view,
       p.can_filter,
       p.can_sort,
       p.can_group
     FROM rb_field f
     INNER JOIN rb_role_field_permission p
       ON p.field_id = f.field_id
      AND p.role_name = $1
      AND p.can_view = TRUE
     WHERE f.dataset_id = $2
     ORDER BY f.display_order ASC, f.code ASC`,
    [roleName, datasetId]
  );

  return result.rows;
}

module.exports = {
  listAuthorizedDatasets,
  getActiveDatasetByCode,
  hasDatasetViewPermission,
  listAuthorizedFields,
  listAuthorizedFilters,
  listAuthorizedQueryFields
};
