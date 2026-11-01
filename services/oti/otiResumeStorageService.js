/**
 * R2 resume download for OTI indexing (mirrors AI review storage access).
 */

const { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");

function resolveStorageObjectKey(resumePath) {
  const value = String(resumePath || "").trim();

  if (!value) {
    return value;
  }

  try {
    if (/^https?:\/\//i.test(value)) {
      const parsed = new URL(value);
      const segments = parsed.pathname.split("/").filter(Boolean);
      if (segments.length === 0) {
        return value;
      }
      return decodeURIComponent(segments[segments.length - 1]);
    }
  } catch {
    // bare key
  }

  return value;
}

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function createR2Client() {
  return new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
  });
}

async function streamToBuffer(stream) {
  const chunks = [];

  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

async function downloadResumeBuffer(resumePath) {
  const objectKey = resolveStorageObjectKey(resumePath);
  const bucket = process.env.R2_BUCKET;

  if (!objectKey || !bucket) {
    throw httpError("Resume storage is not configured.", 503);
  }

  try {
    const response = await createR2Client().send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: objectKey
      })
    );

    return streamToBuffer(response.Body);
  } catch (error) {
    throw httpError("Resume file is not available.", 404);
  }
}

function buildExternalResumeObjectKey(externalLeadId, contentHash, format) {
  const ext = String(format || "bin").toLowerCase();
  return `oti/external-leads/${externalLeadId}/${contentHash}.${ext}`;
}

function buildRetrievalGrantStagingObjectKey(externalLeadId, grantUuid, contentHash, format) {
  const ext = String(format || "bin").toLowerCase();
  const grantRef = String(grantUuid || "").trim();

  if (!grantRef) {
    throw httpError("Grant reference is required for staging storage.", 400);
  }

  return `oti/external-leads/${externalLeadId}/retrieval-grants/${grantRef}/${contentHash}.${ext}`;
}

async function uploadResumeBuffer(objectKey, buffer, contentType = "application/octet-stream") {
  const bucket = process.env.R2_BUCKET;
  const key = String(objectKey || "").trim();

  if (!key || !bucket) {
    throw httpError("Resume storage is not configured.", 503);
  }

  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw httpError("Cannot store an empty document.", 400);
  }

  await createR2Client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType
    })
  );

  return { bucket, key };
}

async function deleteUploadedResumeObject(objectKey) {
  const bucket = process.env.R2_BUCKET;
  const key = String(objectKey || "").trim();

  if (!key || !bucket) {
    throw httpError("Resume storage is not configured.", 503);
  }

  await createR2Client().send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: key
    })
  );

  return { bucket, key };
}

module.exports = {
  downloadResumeBuffer,
  uploadResumeBuffer,
  deleteUploadedResumeObject,
  buildExternalResumeObjectKey,
  buildRetrievalGrantStagingObjectKey,
  resolveStorageObjectKey
};
