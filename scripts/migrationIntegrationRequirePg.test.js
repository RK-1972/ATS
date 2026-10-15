const assert = require("node:assert/strict");
const { describe, it, beforeEach, afterEach } = require("node:test");

const {
  TEST_DATABASE_URL_ENV,
  REQUIRE_PG_ENV,
  REQUIRE_PG_VALUE,
  isTestDatabaseUrlConfigured,
  isIntegrationPgRequired,
  sanitizeProbeErrorMessage,
  assertIntegrationPgProbeSucceeded
} = require("./lib/migrationIntegrationGuards");

const ENV_KEYS = [TEST_DATABASE_URL_ENV, REQUIRE_PG_ENV];

describe("integration PostgreSQL probe policy", () => {
  const saved = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  it("does not require probe success when TEST_DATABASE_URL is absent", () => {
    assert.equal(isTestDatabaseUrlConfigured(), false);
    assertIntegrationPgProbeSucceeded({
      available: false,
      error: new Error(`${TEST_DATABASE_URL_ENV} is required for integration tests`)
    });
  });

  it("allows skip when URL is set but strict flag is disabled", () => {
    process.env[TEST_DATABASE_URL_ENV] =
      "postgresql://user:secret@127.0.0.1:5432/optalynx_mig_test";
    assert.equal(isIntegrationPgRequired(), false);

    assertIntegrationPgProbeSucceeded({
      available: false,
      error: new Error('password authentication failed for user "user"')
    });
  });

  it("fails when URL is set, strict flag enabled, and probe failed", () => {
    process.env[TEST_DATABASE_URL_ENV] =
      "postgresql://user:secret@127.0.0.1:5432/optalynx_mig_test";
    process.env[REQUIRE_PG_ENV] = REQUIRE_PG_VALUE;

    assert.throws(
      () =>
        assertIntegrationPgProbeSucceeded({
          available: false,
          error: new Error('password authentication failed for user "user"')
        }),
      (error) => {
        assert.match(error.message, /availability probe failed/i);
        assert.match(error.message, new RegExp(REQUIRE_PG_ENV));
        assert.doesNotMatch(error.message, /secret/);
        assert.doesNotMatch(error.message, /postgresql:\/\//i);
        return true;
      }
    );
  });

  it("does not throw when probe succeeded (PostgreSQL scenarios may run)", () => {
    process.env[TEST_DATABASE_URL_ENV] =
      "postgresql://user:secret@127.0.0.1:5432/optalynx_mig_test";
    process.env[REQUIRE_PG_ENV] = REQUIRE_PG_VALUE;

    assertIntegrationPgProbeSucceeded({
      available: true,
      config: { database: "optalynx_mig_test" }
    });
  });

  it("redacts connection URLs from probe error text", () => {
    const sanitized = sanitizeProbeErrorMessage(
      "connect failed postgresql://user:secret@127.0.0.1:5432/optalynx_mig_test"
    );
    assert.match(sanitized, /\[connection URL redacted\]/);
    assert.doesNotMatch(sanitized, /secret/);
  });
});
