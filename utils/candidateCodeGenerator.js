function buildCandidateCodeDatePrefix(referenceDate = new Date()) {
  const today =
    referenceDate instanceof Date ? referenceDate : new Date(referenceDate);
  const day = String(today.getDate()).padStart(2, "0");
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const year = String(today.getFullYear()).slice(-2);

  return `${day}${month}${year}`;
}

function buildCandidateCodeLockKey(datePrefix) {
  return `cand_code:${datePrefix}`;
}

/**
 * Allocate the next candidate_code for today's DDMMYY prefix.
 * Must be called on a client that is already inside a transaction so
 * pg_advisory_xact_lock is held through the subsequent INSERT.
 */
async function allocateNextCandidateCode(client, referenceDate = new Date()) {
  const datePrefix = buildCandidateCodeDatePrefix(referenceDate);

  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
    buildCandidateCodeLockKey(datePrefix)
  ]);

  const result = await client.query(
    `
    SELECT COALESCE(
      MAX(
        CAST(SUBSTRING(candidate_code FROM LENGTH($1) + 1) AS BIGINT)
      ),
      0
    ) + 1 AS next_suffix
    FROM cand_mstr
    WHERE candidate_code LIKE $1 || '%'
      AND SUBSTRING(candidate_code FROM LENGTH($1) + 1) ~ '^[0-9]+$'
    `,
    [datePrefix]
  );

  const nextSuffix = Number(result.rows[0]?.next_suffix);

  if (!Number.isFinite(nextSuffix) || nextSuffix <= 0) {
    throw new Error("Failed to allocate candidate code.");
  }

  return `${datePrefix}${nextSuffix}`;
}

module.exports = {
  buildCandidateCodeDatePrefix,
  buildCandidateCodeLockKey,
  allocateNextCandidateCode
};
