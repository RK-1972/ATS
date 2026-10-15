const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { runFingerprintCheck } = require("./lib/migrationBaseline");

function pgError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

describe("runFingerprintCheck missing-relation handling", () => {
  it("treats undefined_table on data checks as failed fingerprint", async () => {
    const queryable = {
      query: async () => {
        throw pgError("42P01", 'relation "md_entity_types" does not exist');
      }
    };

    const result = await runFingerprintCheck(queryable, {
      type: "data",
      query: "SELECT COUNT(*)::int AS c FROM md_entity_types",
      field: "c",
      expectMin: 35
    });

    assert.equal(result.ok, false);
    assert.equal(result.detail, "referenced relation does not exist");
  });

  it("treats undefined_table on exists checks as failed fingerprint", async () => {
    const queryable = {
      query: async () => {
        throw pgError("42P01", 'relation "md_entity_types" does not exist');
      }
    };

    const result = await runFingerprintCheck(queryable, {
      type: "exists",
      query:
        "SELECT EXISTS (SELECT 1 FROM md_entity_types WHERE entity_type = 'x') AS exists"
    });

    assert.equal(result.ok, false);
    assert.equal(result.detail, "referenced relation does not exist");
  });

  it("treats undefined_table on constraint regclass as failed fingerprint", async () => {
    const queryable = {
      query: async () => {
        throw pgError("42P01", 'relation "public.missing_table" does not exist');
      }
    };

    const result = await runFingerprintCheck(queryable, {
      type: "constraint",
      table: "missing_table",
      constraint: "some_constraint"
    });

    assert.equal(result.ok, false);
    assert.equal(result.detail, "referenced relation does not exist");
  });

  it("propagates unrelated database errors on data checks", async () => {
    const queryable = {
      query: async () => {
        throw pgError("42501", "permission denied for table md_entity_types");
      }
    };

    await assert.rejects(
      () =>
        runFingerprintCheck(queryable, {
          type: "data",
          query: "SELECT COUNT(*)::int AS c FROM md_entity_types",
          field: "c",
          expectMin: 1
        }),
      (error) => error.code === "42501"
    );
  });

  it("returns success for data checks when the relation exists", async () => {
    const queryable = {
      query: async () => ({ rows: [{ c: 40 }] })
    };

    const result = await runFingerprintCheck(queryable, {
      type: "data",
      query: "SELECT COUNT(*)::int AS c FROM md_entity_types",
      field: "c",
      expectMin: 35
    });

    assert.equal(result.ok, true);
    assert.equal(result.detail, 40);
  });

  it("regclass checks remain non-throwing when the object is absent", async () => {
    const queryable = {
      query: async () => ({ rows: [{ reg: null }] })
    };

    const result = await runFingerprintCheck(queryable, {
      type: "regclass",
      object: "public.md_entity_types",
      expect: "present"
    });

    assert.equal(result.ok, false);
    assert.equal(result.detail, null);
  });
});
