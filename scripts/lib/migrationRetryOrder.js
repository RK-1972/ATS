/**
 * Ordering guards for --allow-retry-filename (Phase 1.7).
 */

function assertRetryOrderingAllowed(pendingSlice, enriched, allowRetryFilename) {
  const allowed = String(allowRetryFilename || "").trim();

  if (!allowed) {
    return;
  }

  const retryIndex = pendingSlice.findIndex((item) => item.filename === allowed);

  if (retryIndex === -1) {
    throw new Error(
      `Retry override refused: ${allowed} is not in the pending queue slice (check --to).`
    );
  }

  if (retryIndex === 0) {
    return;
  }

  const earlier = pendingSlice.slice(0, retryIndex);
  const lines = [];

  for (const item of earlier) {
    const assessment = enriched.pendingAssessment.find(
      (row) => row.filename === item.filename
    );
    const kind = assessment?.pendingKind || "unknown";
    const reasonText = (assessment?.reasons || []).join("; ") || "still pending";
    lines.push(`${item.filename} (${kind}): ${reasonText}`);
  }

  throw new Error(
    [
      `Retry override refused: ${allowed} is not the first pending migration in the ordered queue.`,
      "Earlier pending migrations must be resolved before retrying a later file:",
      ...lines.map((line) => `  - ${line}`)
    ].join("\n")
  );
}

module.exports = {
  assertRetryOrderingAllowed
};
