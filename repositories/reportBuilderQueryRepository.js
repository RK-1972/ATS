/**
 * Report Builder — query execution only.
 */

async function executeReportQuery(pool, queryPlan) {
  const countParams = queryPlan.params.slice(0, queryPlan.countParamCount);

  const [dataResult, countResult] = await Promise.all([
    pool.query(queryPlan.dataSql, queryPlan.params),
    pool.query(queryPlan.countSql, countParams)
  ]);

  return {
    rows: dataResult.rows,
    totalCount: countResult.rows[0]?.total_count || 0
  };
}

async function executeReportExportQuery(pool, queryPlan) {
  const countParams = queryPlan.params.slice(0, queryPlan.countParamCount);
  const countResult = await pool.query(queryPlan.countSql, countParams);
  const totalCount = countResult.rows[0]?.total_count || 0;
  const dataResult = await pool.query(queryPlan.dataSql, queryPlan.params);

  return {
    rows: dataResult.rows,
    totalCount
  };
}

module.exports = {
  executeReportQuery,
  executeReportExportQuery
};
