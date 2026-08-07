const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");

const PDF_MIME = "application/pdf";
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

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

async function storeOfferLetterDocx(buffer, offerId) {
  const objectKey = `offer-letters/${offerId}/${Date.now()}.docx`;

  await createR2Client().send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: objectKey,
      Body: buffer,
      ContentType: DOCX_MIME
    })
  );

  return objectKey;
}

async function storeOfferLetterPdf(buffer, offerId) {
  const objectKey = `offer-letters/${offerId}/${Date.now()}.pdf`;

  await createR2Client().send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: objectKey,
      Body: buffer,
      ContentType: PDF_MIME
    })
  );

  return objectKey;
}

async function downloadOfferLetterDocx(objectKey) {
  const response = await createR2Client().send(
    new GetObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: objectKey
    })
  );

  return {
    buffer: await streamToBuffer(response.Body),
    contentType: response.ContentType || DOCX_MIME
  };
}

async function downloadOfferLetterPdf(objectKey) {
  const response = await createR2Client().send(
    new GetObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: objectKey
    })
  );

  return {
    buffer: await streamToBuffer(response.Body),
    contentType: response.ContentType || PDF_MIME
  };
}

module.exports = {
  storeOfferLetterDocx,
  storeOfferLetterPdf,
  downloadOfferLetterDocx,
  downloadOfferLetterPdf,
  PDF_MIME,
  DOCX_MIME
};
