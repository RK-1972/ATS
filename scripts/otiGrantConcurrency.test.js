"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const otiResumeRetrievalGrantService = require("../services/oti/otiResumeRetrievalGrantService");

function buildGrant(overrides = {}) {
  return {
    grant_id: 11,
    grant_uuid: "grant-concurrency-1",
    external_lead_id: 42,
    requested_by: "REC-1",
    status: "retrieving",
    expires_on: new Date(Date.now() + 600000),
    consumed_on: null,
    revoked_on: null,
    replay_nonce: "nonce-1",
    attempt_count: 1,
    max_attempts: 1,
    ...overrides
  };
}

describe("oti grant revocation concurrency", () => {
  it("rejects revoke when grant is already completed before update", async () => {
    const grant = buildGrant({ status: "completed", consumed_on: new Date() });

    await assert.rejects(
      () => otiResumeRetrievalGrantService.revokeGrant(
          {
            query: async (sql) => {
              if (String(sql).includes("WHERE grant_uuid")) {
                return { rows: [grant] };
              }
              return { rows: [] };
            }
          },
          "grant-concurrency-1",
          { user: { employee_code: "REC-1", role_name: "Admin" } },
          { external_lead_id: 42 }
        ),
      (error) => error.status === 409
    );
  });

  it("cannot mark grant completed after concurrent revocation", async () => {
    const state = {
      grant: buildGrant({
        status: "revoked",
        revoked_on: new Date()
      })
    };

    const pool = {
      query: async (sql, params) => {
        const text = String(sql);

        if (text.includes("SET status = $2") && params[1] === "completed") {
          if (state.grant.revoked_on || state.grant.status === "revoked") {
            return { rowCount: 0, rows: [] };
          }
          return { rowCount: 1, rows: [{ grant_id: state.grant.grant_id }] };
        }

        return { rowCount: 0, rows: [] };
      }
    };

    await assert.rejects(
      () =>
        otiResumeRetrievalGrantService.markGrantStatus(
          pool,
          state.grant.grant_id,
          "completed",
          { consumed_on: new Date() },
          { requireStatuses: ["retrieving"] }
        ),
      (error) => error.status === 403
    );
  });

  it("reloadAndAssertGrantExecutable rejects revoked grants before completion", async () => {
    const pool = {
      query: async () => ({
        rows: [
          buildGrant({
            status: "revoked",
            revoked_on: new Date()
          })
        ]
      })
    };

    await assert.rejects(
      () =>
        otiResumeRetrievalGrantService.reloadAndAssertGrantExecutable(pool, 11, {
          requestedBy: "REC-1",
          replayNonce: "nonce-1"
        }),
      (error) => error.status === 403
    );
  });
});
