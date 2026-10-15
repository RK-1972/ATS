const { Pool } = require("pg");

function isProductionSslRequired() {
  return (
    process.env.NODE_ENV === "production" ||
    Boolean(process.env.RENDER) ||
    String(process.env.OPTALYNX_DB_TARGET || "").toLowerCase() === "neon"
  );
}

function resolvePoolConfigFromEnv(env = process.env) {
  const host = env.DB_HOST;
  const port = env.DB_PORT;
  const user = env.DB_USER;
  const password = env.DB_PASSWORD;
  const database = env.DB_NAME;

  const missing = [];
  if (!host) missing.push("DB_HOST");
  if (!port) missing.push("DB_PORT");
  if (!user) missing.push("DB_USER");
  if (!password) missing.push("DB_PASSWORD");
  if (!database) missing.push("DB_NAME");

  if (missing.length) {
    throw new Error(`Missing database environment variables: ${missing.join(", ")}`);
  }

  const config = {
    host,
    port: Number(port),
    user,
    password,
    database
  };

  if (isProductionSslRequired()) {
    config.ssl = { rejectUnauthorized: false };
  }

  return config;
}

function createPool(env = process.env) {
  return new Pool(resolvePoolConfigFromEnv(env));
}

module.exports = {
  createPool,
  resolvePoolConfigFromEnv,
  isProductionSslRequired
};
