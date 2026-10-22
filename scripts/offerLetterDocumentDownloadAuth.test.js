const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

const documentMergePath = require.resolve("../services/documentMergeService");
const offerManagementPath = require.resolve("../services/offerManagementService");
const offerLetterGenerationPath = require.resolve(
  "../services/offerLetterGenerationService"
);

describe("offer letter document download authorization", () => {
  let originalOfferManagement;
  let originalOfferLetterGeneration;
  let readAccessCalls;
  let pdfDownloadCalls;

  before(() => {
    originalOfferManagement = require.cache[offerManagementPath];
    originalOfferLetterGeneration = require.cache[offerLetterGenerationPath];

    readAccessCalls = [];
    pdfDownloadCalls = [];

    require.cache[offerManagementPath] = {
      id: offerManagementPath,
      filename: offerManagementPath,
      loaded: true,
      exports: {
        assertOfferReadAccess: async (pool, req, offerId) => {
          readAccessCalls.push({ pool, req, offerId });
          if (req?.user?.deny) {
            const error = new Error(
              "Enterprise Access Denied. You are not authorized to access this offer."
            );
            error.status = 403;
            throw error;
          }
        }
      }
    };

    require.cache[offerLetterGenerationPath] = {
      id: offerLetterGenerationPath,
      filename: offerLetterGenerationPath,
      loaded: true,
      exports: {
        downloadOfferLetterPdf: async (pool, offerId) => {
          pdfDownloadCalls.push({ pool, offerId });
          return {
            buffer: Buffer.from("pdf"),
            contentType: "application/pdf",
            fileName: `Offer_Letter_${offerId}.pdf`
          };
        }
      }
    };
  });

  after(() => {
    if (originalOfferManagement) {
      require.cache[offerManagementPath] = originalOfferManagement;
    } else {
      delete require.cache[offerManagementPath];
    }

    if (originalOfferLetterGeneration) {
      require.cache[offerLetterGenerationPath] = originalOfferLetterGeneration;
    } else {
      delete require.cache[offerLetterGenerationPath];
    }

    delete require.cache[documentMergePath];
  });

  it("downloadGeneratedDocumentForOffer enforces offer read access before PDF fetch", async () => {
    delete require.cache[documentMergePath];
    const documentMergeService = require("../services/documentMergeService");

    const req = { user: { employee_code: "REC-1", role_name: "Recruiter" } };
    const file = await documentMergeService.downloadGeneratedDocumentForOffer(
      {},
      "OFFER-100",
      req
    );

    assert.equal(readAccessCalls.length, 1);
    assert.equal(readAccessCalls[0].offerId, "OFFER-100");
    assert.equal(pdfDownloadCalls.length, 1);
    assert.ok(file.buffer);
  });

  it("downloadGeneratedDocumentForOffer rejects out-of-scope users", async () => {
    delete require.cache[documentMergePath];
    const documentMergeService = require("../services/documentMergeService");
    const pdfCallsBefore = pdfDownloadCalls.length;

    await assert.rejects(
      () =>
        documentMergeService.downloadGeneratedDocumentForOffer(
          {},
          "OFFER-100",
          { user: { deny: true } }
        ),
      (error) => error.status === 403
    );

    assert.equal(pdfDownloadCalls.length, pdfCallsBefore);
  });

  it("downloadGeneratedDocumentForOffer requires authentication", async () => {
    delete require.cache[documentMergePath];
    const documentMergeService = require("../services/documentMergeService");

    await assert.rejects(
      () => documentMergeService.downloadGeneratedDocumentForOffer({}, "OFFER-100", {}),
      (error) => error.status === 401
    );
  });
});
