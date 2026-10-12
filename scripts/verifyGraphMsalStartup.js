/**
 * Ensures index.js module load does not require Microsoft Graph env vars.
 * Does not start listening (index.js always listens — so only graphMsalClient is checked here).
 */

const saved = {
  CLIENT_ID: process.env.CLIENT_ID,
  TENANT_ID: process.env.TENANT_ID,
  CLIENT_SECRET: process.env.CLIENT_SECRET
};

delete process.env.CLIENT_ID;
delete process.env.TENANT_ID;
delete process.env.CLIENT_SECRET;

const {
  isMicrosoftGraphAuthConfigured,
  getConfidentialClientApplication
} = require("../utils/graphMsalClient");

if (isMicrosoftGraphAuthConfigured()) {
  console.error("FAIL: expected Graph auth to be unconfigured");
  process.exit(1);
}

try {
  getConfidentialClientApplication();
  console.error("FAIL: expected GRAPH_AUTH_NOT_CONFIGURED");
  process.exit(1);
} catch (error) {
  if (error.code !== "GRAPH_AUTH_NOT_CONFIGURED") {
    console.error("FAIL: unexpected error", error);
    process.exit(1);
  }
}

process.env.CLIENT_ID = saved.CLIENT_ID || "test-client-id";
process.env.TENANT_ID = saved.TENANT_ID || "test-tenant-id";
process.env.CLIENT_SECRET = saved.CLIENT_SECRET || "test-client-secret";

const client = getConfidentialClientApplication();
if (!client) {
  console.error("FAIL: expected MSAL client when credentials are set");
  process.exit(1);
}

console.log("PASS: Graph MSAL lazy startup (no credentials at load)");
