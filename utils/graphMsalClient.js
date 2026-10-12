const { ConfidentialClientApplication } = require("@azure/msal-node");

function isMicrosoftGraphAuthConfigured() {
  return Boolean(
    process.env.CLIENT_ID &&
      process.env.TENANT_ID &&
      process.env.CLIENT_SECRET
  );
}

let cachedClient = null;

function getConfidentialClientApplication() {
  if (!cachedClient) {
    if (!isMicrosoftGraphAuthConfigured()) {
      const error = new Error(
        "Microsoft Graph is not configured (CLIENT_ID, TENANT_ID, CLIENT_SECRET)."
      );
      error.code = "GRAPH_AUTH_NOT_CONFIGURED";
      throw error;
    }

    cachedClient = new ConfidentialClientApplication({
      auth: {
        clientId: process.env.CLIENT_ID,
        authority: `https://login.microsoftonline.com/${process.env.TENANT_ID}`,
        clientSecret: process.env.CLIENT_SECRET
      }
    });
  }

  return cachedClient;
}

module.exports = {
  getConfidentialClientApplication,
  isMicrosoftGraphAuthConfigured
};
