/**
 * Shared Microsoft Graph sendMail adapter for orchestrated notifications.
 * Production welcome/reset/interview adapters in index.js remain unchanged.
 */

const axios = require("axios");
const { ConfidentialClientApplication } = require("@azure/msal-node");

const msalConfig = {
  auth: {
    clientId: process.env.CLIENT_ID,
    authority: `https://login.microsoftonline.com/${process.env.TENANT_ID}`,
    clientSecret: process.env.CLIENT_SECRET
  }
};

const cca = new ConfidentialClientApplication(msalConfig);

async function getGraphToken() {
  const response = await cca.acquireTokenByClientCredential({
    scopes: ["https://graph.microsoft.com/.default"]
  });

  if (!response?.accessToken) {
    throw new Error("Graph token acquisition failed.");
  }

  return response.accessToken;
}

/**
 * @param {object} message
 * @param {string} message.to
 * @param {string} message.subject
 * @param {string} message.html
 * @param {string} [message.senderMailbox]
 */
async function sendTransactionalEmail(message = {}) {
  const to = String(message.to || "").trim();
  const subject = String(message.subject || "").trim();
  const html = String(message.html || "").trim();
  const senderMailbox = String(
    message.senderMailbox || process.env.EMAIL_USER || ""
  ).trim();

  if (!to || !subject || !html) {
    throw new Error("Graph email requires to, subject, and html.");
  }

  if (!senderMailbox) {
    throw new Error("Graph email sender mailbox is not configured.");
  }

  const token = await getGraphToken();

  await axios.post(
    `https://graph.microsoft.com/v1.0/users/${senderMailbox}/sendMail`,
    {
      message: {
        subject,
        body: {
          contentType: "HTML",
          content: html
        },
        toRecipients: [
          {
            emailAddress: {
              address: to
            }
          }
        ]
      },
      saveToSentItems: true
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      }
    }
  );
}

module.exports = {
  sendTransactionalEmail
};
