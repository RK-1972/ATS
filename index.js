require("dotenv").config();
const axios = require("axios");

const {
  ConfidentialClientApplication
} = require("@azure/msal-node");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { Pool } = require("pg");
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand
} = require("@aws-sdk/client-s3");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const path = require("path");
const crypto = require("crypto");
const recruitmentLegacyHandlers = require("./handlers/recruitmentLegacyHandlers");
const recruitmentLegacyReadHandlers = require("./handlers/recruitmentLegacyReadHandlers");
const interviewLegacyHandlers = require("./handlers/interviewLegacyHandlers");
const interviewLegacyReadHandlers = require("./handlers/interviewLegacyReadHandlers");
const candidateService = require("./services/candidateService");
const recruitmentService = require("./services/recruitmentService");
const workAssignmentService = require("./services/workAssignmentService");
const workspaceResolverService = require("./services/workspaceResolverService");
const approvalRouteRepository = require("./repositories/approvalRouteRepository");

const app = express();

// =====================================================
// Runtime Environment
// =====================================================

const isProduction =
  process.env.NODE_ENV === "production" ||
  Boolean(process.env.RENDER);

const isLocalDevelopment = !isProduction;

if (process.env.FRONTEND_URL) {
  app.use(
    cors({
      origin: process.env.FRONTEND_URL
    })
  );
} else {
  app.use(cors());
}

app.use(express.json());

app.get(
  "/generate-password",
  async (req, res) => {

    const hash =
      await bcrypt.hash(
        "Welcome@123",
        10
      );

    res.json({
      hash
    });

  }
);
// =====================================================
// Microsoft Graph Configuration
// =====================================================

const msalConfig = {

  auth: {

    clientId:
      process.env.CLIENT_ID,

    authority:
      `https://login.microsoftonline.com/${process.env.TENANT_ID}`,

    clientSecret:
      process.env.CLIENT_SECRET

  }

};

const cca =
  new ConfidentialClientApplication(
    msalConfig
  );

  // =====================================================
// Get Microsoft Graph Token
// =====================================================

async function getGraphToken() {

  try {

    const tokenRequest = {

      scopes: [
        "https://graph.microsoft.com/.default"
      ]

    };

    const response =
      await cca.acquireTokenByClientCredential(
        tokenRequest
      );

    return response.accessToken;

  }

  catch (error) {

    console.error(
      "Graph Token Error:",
      error
    );

    throw error;

  }

}

// =====================================================
// Create Teams Meeting Event
// =====================================================

async function createInterviewMeeting(

  interviewDate,
  interviewTime,
  roundType,
  candidateName,
  candidateEmail,
  interviewerEmail,
  recruiterEmail

){

  try {

    const token =
      await getGraphToken();

    const startDateTime =
      `${interviewDate}T${interviewTime}`;

    const start =
      new Date(startDateTime);

    const end =
      new Date(start);

    end.setHours(
      end.getHours() + 1
    );

    const endDateTime =

      end.getFullYear() +
      "-" +
      String(
        end.getMonth() + 1
      ).padStart(2, "0") +
      "-" +
      String(
        end.getDate()
      ).padStart(2, "0") +
      "T" +
      String(
        end.getHours()
      ).padStart(2, "0") +
      ":" +
      String(
        end.getMinutes()
      ).padStart(2, "0") +
      ":" +
      String(
        end.getSeconds()
      ).padStart(2, "0");

    const attendees = [];

    // =====================================
    // ONLY INTERVIEWER IS ADDED
    // Candidate will NOT receive Teams invite
    // =====================================

    if (interviewerEmail) {

      attendees.push({

        emailAddress: {

          address:
            interviewerEmail

        },

        type:
          "required"

      });

    }

    const response =
      await axios.post(

        `https://graph.microsoft.com/v1.0/users/${recruiterEmail}/events`,

        {

          subject:
            `${roundType} - ${candidateName}`,

          start: {

            dateTime:
              startDateTime,

            timeZone:
              "India Standard Time"

          },

          end: {

            dateTime:
              endDateTime,

            timeZone:
              "India Standard Time"

          },

          isOnlineMeeting: true,

          onlineMeetingProvider:
            "teamsForBusiness",

          attendees

        },

        {

          headers: {

            Authorization:
              `Bearer ${token}`,

            "Content-Type":
              "application/json"

          }

        }

      );

    return {

      joinUrl:
        response.data.onlineMeeting
          ?.joinUrl,

      eventId:
        response.data.id

    };

  }

  catch (error) {

    console.error(

      "Create Meeting Error:",

      error?.response?.data ||

      error.message

    );

    throw error;

  }

}

// =====================================================
// Send Interview Email To Candidate
// =====================================================

async function sendInterviewEmail(

  candidateEmail,
  candidateName,
  roundType,
  interviewDate,
  interviewTime,
  teamsLink,
  recruiterEmail

) {

  try {

    const token =
      await getGraphToken();
    const formattedDate =
      new Date(interviewDate)
        .toLocaleDateString(
          "en-GB",
          {
            day: "2-digit",
            month: "short",
            year: "numeric"
          }
        )
        .replace(/ /g, "-");

    const formattedTime =
  new Date(
    `2000-01-01T${interviewTime}`
  ).toLocaleTimeString(
    "en-US",
    {
      hour: "numeric",
      minute: "2-digit",
      hour12: true
    }
  );
    await axios.post(

      `https://graph.microsoft.com/v1.0/users/${recruiterEmail}/sendMail`,

      {

        message: {

          subject:
            `Interview Scheduled - ${roundType}`,

          body: {

            contentType: "HTML",

            content: `

              <p>
  Dear ${candidateName},
</p>

<p>
  Greetings from IGS.
</p>

<p>
  Thank you for your interest in the opportunity with us.
  We are pleased to inform you that your profile has been shortlisted
  for the next stage of our recruitment process.
</p>

<p>
  Your interview has been scheduled as per the details below:
</p>

<h3>
  Interview Details
</h3>

<table
  border="1"
  cellpadding="8"
  cellspacing="0"
  style="
    border-collapse: collapse;
  "
>

  <tr>

    <td>
      <b>Interview Round</b>
    </td>

    <td>
      ${roundType}
    </td>

  </tr>

  <tr>

    <td>
      <b>Date</b>
    </td>

    <td>
      ${formattedDate}
    </td>

  </tr>

  <tr>

    <td>
      <b>Time</b>
    </td>

    <td>
      ${formattedTime}
    </td>

  </tr>

</table>

<br/>

<h3>
  Join Interview
</h3>

<p>
  Please use the following link to join the interview at the scheduled time:
</p>

<p>
  <a href="${teamsLink}">
    Click Here to Join the Interview
  </a>
</p>

<p>
  We recommend joining the meeting at least
  <b>10 minutes before</b>
  the scheduled time to avoid any last-minute technical issues.
</p>

<p>
  If you experience any difficulty accessing the meeting,
  please contact the Talent Acquisition Team.
</p>

<br/>

<p>
  We wish you all the very best for your interview.
</p>

<br/>

<p>
  Regards,<br/>
  Talent Acquisition Team<br/>
  Intact Green Services (India) Pvt Ltd
</p>

            `

          },

          toRecipients: [

            {

              emailAddress: {

                address:
                  candidateEmail

              }

            }

          ]

        },

        saveToSentItems: true

      },

      {

        headers: {

          Authorization:
            `Bearer ${token}`,

          "Content-Type":
            "application/json"

        }

      }

    );

    console.log(
      `Interview email sent to ${candidateEmail}`
    );

  }

  catch (error) {

    console.log(
      "Candidate Email Error"
    );

    console.log(

      error?.response?.data ||

      error.message

    );

  }

}

// =====================================================
// PostgreSQL Connection
// =====================================================

const poolConfig = {
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
};

if (isProduction) {
  poolConfig.ssl = {
    rejectUnauthorized: false
  };
}

const pool = new Pool(poolConfig);

// Prevent process exit when PostgreSQL drops idle pool connections (e.g. 57P01).
pool.on("error", (err) => {
  console.error("⚠️ PostgreSQL pool idle client error:", err.message);
});

pool.connect()
  .then((client) => {
    client.release();
    console.log("✅ PostgreSQL Connected");
  })
  .catch((err) => {

    console.log("❌ PostgreSQL Connection Error");

    console.log(err);

  });


// =====================================================
// Cloudflare R2 Configuration
// =====================================================

const r2Client = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const bucketName = process.env.R2_BUCKET;

async function initializeR2() {
  try {
    await r2Client.send(
      new HeadBucketCommand({
        Bucket: bucketName,
      })
    );

    console.log("✅ Cloudflare R2 Bucket Connected");

  } catch (err) {

    console.warn("⚠️ Cloudflare R2 unavailable at startup");
    console.warn(err.message);

  }
}

initializeR2();


// =====================================================
// Multer Setup
// =====================================================

const storage = multer.memoryStorage();

const upload = multer({

  storage: storage,

});


async function uploadResumeToStorage(file) {

  const fileName =
    `${Date.now()}-${file.originalname}`;

  await r2Client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: fileName,
      Body: file.buffer,
      ContentType: file.mimetype
    })
  );

  return fileName;

}


let pdfParse = null;

try {

  const { PDFParse } = require("pdf-parse");

  pdfParse = async (buffer) => {

    const parser = new PDFParse({ data: buffer });

    try {

      const textResult = await parser.getText();

      return { text: textResult.text };

    }

    finally {

      await parser.destroy();

    }

  };

}

catch (error) {

  pdfParse = null;

}


function resolveStorageObjectKey(resumePath) {

  const value = String(resumePath || "").trim();

  if (!value) {
    return value;
  }

  // Legacy MinIO stored absolute URLs (http://host:9000/bucket/key).
  // Current R2 uploads store the bare object key. Both must resolve to Key.
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
    // Fall through — treat as bare object key.
  }

  return value;

}

function resolveResumeContentType(objectKey) {

  const extension = path.extname(String(objectKey || "")).toLowerCase();

  if (extension === ".pdf") {
    return "application/pdf";
  }
  if (extension === ".png") {
    return "image/png";
  }
  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }
  if (extension === ".doc") {
    return "application/msword";
  }
  if (extension === ".docx") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (extension === ".txt") {
    return "text/plain";
  }

  return "application/octet-stream";

}


function streamToBuffer(stream) {

  return new Promise((resolve, reject) => {

    const chunks = [];

    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);

  });

}


async function downloadResumeFromStorage(resumePath) {

  const objectKey =
    resolveStorageObjectKey(resumePath);

  let response;

  try {

    response = await r2Client.send(
      new GetObjectCommand({
        Bucket: bucketName,
        Key: objectKey
      })
    );

  }

  catch (statError) {

    const error = new Error(statError.message);

    error.bucket = bucketName;
    error.objectKey = objectKey;
    error.isStatObjectFailure = true;

    throw error;

  }

  return streamToBuffer(response.Body);

}


async function extractPdfText(buffer) {

  if (!pdfParse) {

    throw new Error(
      "No PDF parser is installed. Install pdf-parse to enable resume text extraction."
    );

  }

  const parsed = await pdfParse(buffer);

  return (parsed.text || "").trim();

}


function parseBasicCandidateInfo(extractedText) {

  const text = (extractedText || "").trim();
  const lines =
    text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  const emailRegex =
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/i;

  const mobileRegex =
    /(?:\+91[\s-]*)?[6-9][\d\s-]{8,12}\d/;

  const emailMatch = text.match(emailRegex);
  const email = emailMatch ? emailMatch[0] : null;

  const mobileMatch = text.match(mobileRegex);
  const mobile = mobileMatch ? mobileMatch[0].trim() : null;

  const resumeSectionHeadings = [
    "Education",
    "Experience",
    "Work Experience",
    "Professional Experience",
    "Skills",
    "Technical Skills",
    "Projects",
    "Projects Undertaken",
    "Certifications",
    "Summary",
    "Professional Summary",
    "Objective",
    "Career Objective",
    "Profile",
    "Declaration",
    "Achievements",
    "Strengths",
    "Internship",
    "Internships",
    "Languages",
    "Interests",
    "References",
    "Contact",
    "Personal Details",
    "Personal Information",
    "About Me",
    "Work History",
    "Employment History",
    "Key Skills",
    "Core Competencies",
    "Hobbies",
    "Extra Curricular Activities",
    "Extracurricular Activities",
    "Areas of Interest",
    "Technical Proficiency",
    "Qualifications",
    "Academic Qualifications",
    "Career Summary",
    "Resume"
  ];

  const normalizeResumeHeadingLine = (line) =>
    String(line || "")
      .trim()
      .toLowerCase()
      .replace(/[:|.\-–—]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();

  const isResumeSectionHeading = (line) => {
    const normalized = normalizeResumeHeadingLine(line);

    if (!normalized) {

      return false;

    }

    return resumeSectionHeadings.some((heading) => {

      const headingNormalized = normalizeResumeHeadingLine(heading);

      return (
        normalized === headingNormalized ||
        normalized.startsWith(`${headingNormalized} `)
      );

    });

  };

  const isIgnoredCandidateNameLine = (line) => {

    const trimmedLine = line.trim();

    if (!trimmedLine) {

      return true;

    }

    if (/^\d+$/.test(trimmedLine)) {

      return true;

    }

    if (/^Page/i.test(trimmedLine)) {

      return true;

    }

    if (trimmedLine.startsWith("--")) {

      return true;

    }

    if (trimmedLine.includes("@")) {

      return true;

    }

    if (mobileRegex.test(trimmedLine)) {

      return true;

    }

    if (/^http/i.test(trimmedLine)) {

      return true;

    }

    if (/^www/i.test(trimmedLine)) {

      return true;

    }

    if (isResumeSectionHeading(trimmedLine)) {

      return true;

    }

    return false;

  };

  const looksLikeCandidateName = (line) => {

    const normalized = line.replace(/\s+/g, " ").trim();

    if (!normalized) {

      return false;

    }

    if (normalized.includes(":") || normalized.includes("|")) {

      return false;

    }

    if (isResumeSectionHeading(normalized)) {

      return false;

    }

    if (!/^[A-Za-z][A-Za-z .'-]*$/.test(normalized)) {

      return false;

    }

    const words = normalized.split(" ").filter(Boolean);

    if (words.length < 2 || words.length > 4) {

      return false;

    }

    if (
      normalized === normalized.toUpperCase() &&
      !words.every((word) => /^[A-Z][A-Z.'-]*$/.test(word) && word.length <= 15)
    ) {

      return false;

    }

    return true;

  };

  let candidate_name = null;

  for (const line of lines) {

    if (isIgnoredCandidateNameLine(line)) {

      continue;

    }

    if (!looksLikeCandidateName(line)) {

      continue;

    }

    candidate_name = line.replace(/\s+/g, " ").trim();
    break;

  }

  const experienceRegex =
    /\d+(?:\.\d+)?\+?\s*years?/i;

  const experienceMatch = text.match(experienceRegex);
  const experience =
    experienceMatch ? experienceMatch[0].trim() : null;

  const educationKeywords = [
    "Bachelor",
    "B.E",
    "B.Tech",
    "M.Tech",
    "MCA",
    "MBA",
    "Diploma",
    "Degree"
  ];

  let education = null;

  for (const line of lines) {

    const matchedKeyword = educationKeywords.find((keyword) =>
      line.toLowerCase().includes(keyword.toLowerCase())
    );

    if (matchedKeyword) {

      education = line.trim();
      break;

    }

  }

  const skillKeywords = [
    "Playwright",
    "Selenium",
    "Python",
    "Java",
    "SQL",
    "Pytest",
    "Jenkins",
    "Docker",
    "Kubernetes",
    "Postman",
    "REST Assured",
    "MySQL",
    "Jira",
    "Git",
    "TypeScript",
    "JavaScript",
    "React",
    "Node",
    "API Testing",
    "Regression Testing",
    "Smoke Testing",
    "Functional Testing"
  ];

  const lowerText = text.toLowerCase();
  const skills = [];

  for (const skill of skillKeywords) {

    if (lowerText.includes(skill.toLowerCase())) {

      skills.push(skill);

    }

  }

  return {
    candidate_name,
    email,
    mobile,
    experience,
    education,
    skills
  };

}


function splitCandidateName(candidateName) {

  const trimmed =
    (candidateName || "").trim().replace(/\s+/g, " ");

  if (!trimmed) {

    return {
      first_name: "",
      last_name: ""
    };

  }

  const parts = trimmed.split(" ");

  return {
    first_name: parts[0],
    last_name: parts.slice(1).join(" ") || ""
  };

}


function normalizeExperience(value) {

  if (value === null || value === undefined) {

    return null;

  }

  const trimmed = String(value).trim();

  if (!trimmed) {

    return null;

  }

  try {

    const lower = trimmed.toLowerCase();

    if (/\bmonth/.test(lower)) {

      const monthMatch = lower.match(/(\d+(?:\.\d+)?)/);

      if (!monthMatch) {

        return null;

      }

      const months = Number(monthMatch[1]);

      if (!Number.isFinite(months)) {

        return null;

      }

      return months / 12;

    }

    const match = trimmed.match(/(\d+(?:\.\d+)?)/);

    if (!match) {

      return null;

    }

    const parsed = Number(match[1]);

    return Number.isFinite(parsed) ? parsed : null;

  }

  catch {

    return null;

  }

}


async function createDraftCandidateFromParsedIntake({
  intake,
  parsedCandidate,
  createdBy
}) {

  const {
    first_name,
    last_name
  } = splitCandidateName(parsedCandidate.candidate_name);

  const skillsList =
    Array.isArray(parsedCandidate.skills)
      ? parsedCandidate.skills
      : [];

  const primary_skill =
    skillsList.length > 0
      ? skillsList.join(", ")
      : null;

  const remarksParts = [];

  if (parsedCandidate.education) {

    remarksParts.push(
      `Education: ${parsedCandidate.education}`
    );

  }

  remarksParts.push(
    `Intake ID: ${intake.intake_id}`
  );

  if (intake.original_file_name) {

    remarksParts.push(
      `Original File: ${intake.original_file_name}`
    );

  }

  const emailId =
    parsedCandidate.email
      ? String(parsedCandidate.email).trim()
      : null;

  if (emailId) {

    const existingByEmail = await pool.query(

      `

      SELECT
        candidate_id,
        candidate_code,
        first_name,
        last_name,
        candidate_status,
        email_id
      FROM cand_mstr
      WHERE email_id = $1
      LIMIT 1

      `,

      [emailId]

    );

    if (existingByEmail.rows.length > 0) {

      const existing = existingByEmail.rows[0];

      return {
        outcome: "DUPLICATE",
        duplicate_candidate: {
          candidate_id: existing.candidate_id,
          candidate_code: existing.candidate_code,
          first_name: existing.first_name,
          last_name: existing.last_name,
          candidate_status: existing.candidate_status,
          email_id: existing.email_id
        }
      };

    }

  }

  const today = new Date();

  const day =
    String(today.getDate()).padStart(2, "0");

  const month =
    String(today.getMonth() + 1).padStart(2, "0");

  const year =
    String(today.getFullYear()).slice(-2);

  const datePrefix =
    `${day}${month}${year}`;

  const countResult = await pool.query(

    `

    SELECT COUNT(*) AS total
    FROM cand_mstr
    WHERE TO_CHAR(created_on, 'DDMMYY') = $1

    `,

    [datePrefix]

  );

  const runningNumber =
    parseInt(countResult.rows[0].total, 10) + 1;

  const candidateCode =
    `${datePrefix}${runningNumber}`;

  const result = await pool.query(

    `

    INSERT INTO cand_mstr (
      candidate_code,
      first_name,
      last_name,
      email_id,
      mobile_number,
      total_experience,
      primary_skill,
      resume_path,
      source_channel,
      candidate_status,
      recruiter_id,
      remarks,
      created_by
    )
    VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9, $10,
      $11, $12, $13
    )
    RETURNING candidate_id

    `,

    [
      candidateCode,
      first_name,
      last_name,
      emailId || null,
      parsedCandidate.mobile || null,
      normalizeExperience(parsedCandidate.experience),
      primary_skill,
      intake.resume_path || null,
      intake.source_id || null,
      "DRAFT",
      createdBy || null,
      remarksParts.join(" | "),
      createdBy || null
    ]

  );

  return {
    outcome: "CREATED",
    candidate_id: result.rows[0].candidate_id
  };

}


async function markIntakeParsingFailed(intakeId, errorMessage) {

  await pool.query(

    `

    UPDATE rm_candidate_intake
    SET
      parsing_status = 'FAILED',
      error_message = $1
    WHERE intake_id = $2

    `,

    [errorMessage, intakeId]

  );

}


// =====================================================
// JWT TOKEN VERIFICATION MIDDLEWARE
// =====================================================

const verifyToken = (req, res, next) => {

  try {

    const authHeader =
      req.headers.authorization;

    if (!authHeader) {

      return res.status(401).json({

        success: false,
        message: "Access Denied - No Token"

      });

    }

    const token =
      authHeader.split(" ")[1];

    const verifiedUser = jwt.verify(

      token,
      process.env.JWT_SECRET

    );

    req.user = verifiedUser;

    next();

  }

  catch (error) {

    return res.status(401).json({

      success: false,
      message: "Invalid Token"

    });

  }

};


// =====================================================
// ADMIN ROLE VERIFICATION
// =====================================================

const verifyAdmin = (req, res, next) => {

  if (req.user.role_name !== "Admin") {

    return res.status(403).json({

      success: false,
      message: "Access Denied - Admin Only"

    });

  }

  next();

};


// =====================================================
// API 1 - Create Candidate
// =====================================================

app.post(

  "/candidate",

  verifyToken,

  upload.single("resume"),

  async (req, res) => {

    try {

      const {

        first_name,
        last_name,
        email_id,
        pan_number,
        mobile_number,
        total_experience,
        relevant_experience,
        current_company,
        current_ctc,
        expected_ctc,
        notice_period,
        current_location,
        preferred_location,
        primary_skill,
        secondary_skill,
        linkedin_url,
        source_channel,
        candidate_status,
        remarks,
        created_by

      } = req.body;
      console.log("PAN RECEIVED:");
      console.log(pan_number);
      let resumePath = null;


      if (req.file) {

        resumePath =
          await uploadResumeToStorage(req.file);

      }


      const today = new Date();

      const day =
        String(today.getDate()).padStart(2, "0");

      const month =
        String(today.getMonth() + 1).padStart(2, "0");

      const year =
        String(today.getFullYear()).slice(-2);

      const datePrefix =
        `${day}${month}${year}`;


      const countResult = await pool.query(

        `

        SELECT COUNT(*) AS total

        FROM cand_mstr

        WHERE TO_CHAR(created_on, 'DDMMYY') = $1

        `,

        [datePrefix]

      );

      const runningNumber =
        parseInt(countResult.rows[0].total) + 1;


      const candidateCode =
        `${datePrefix}${runningNumber}`;


      const query = `

        INSERT INTO cand_mstr (

          candidate_code,
          first_name,
          last_name,
          email_id,
          pan_number,
          mobile_number,
          total_experience,
          relevant_experience,
          current_company,
          current_ctc,
          expected_ctc,
          notice_period,
          current_location,
          preferred_location,
          primary_skill,
          secondary_skill,
          linkedin_url,
          resume_path,
          source_channel,
          candidate_status,
          recruiter_id,
          remarks,
          created_by

        )

        VALUES (

          $1,$2,$3,$4,$5,
          $6,$7,$8,$9,$10,
          $11,$12,$13,$14,$15,
          $16,$17,$18,$19,$20,
          $21,$22,$23

        )

        RETURNING *

      `;

      const values = [

        candidateCode,
        first_name,
        last_name,
        email_id,
        pan_number,
        mobile_number,
        total_experience || null,
        relevant_experience || null,
        current_company,
        current_ctc || null,
        expected_ctc || null,
        notice_period || null,
        current_location,
        preferred_location,
        primary_skill,
        secondary_skill,
        linkedin_url,
        resumePath,
        source_channel,
        candidate_status || "To be screened",
        req.user.employee_code,
        remarks,
        req.user.employee_code

      ];

      const result =
        await pool.query(query, values);

      res.status(201).json({

        success: true,
        message: "Candidate Created Successfully",
        data: result.rows[0]

      });

    }

    catch (error) {

      console.log("❌ Candidate Creation Error");

      console.log(error);

      res.status(500).json({

        success: false,
        message: "Error Creating Candidate"

      });

    }

  }

);


// =====================================================
// API 2 - Get All Candidates
// =====================================================

app.get(

  "/candidates",

  verifyToken,

  async (req, res) => {

    try {

      const result = await pool.query(`

        SELECT *
        FROM cand_mstr
        ORDER BY candidate_id DESC

      `);

      res.status(200).json({

        success: true,
        data: result.rows

      });

    }

    catch (error) {

      console.log("❌ Fetch Candidates Error");

      console.log(error);

      res.status(500).json({

        success: false,
        message: "Error Fetching Candidates"

      });

    }

  }

);


// =====================================================
// API 3 - Get Candidate By ID
// =====================================================

app.get(

  "/candidate/:id",

  verifyToken,

  async (req, res) => {

    try {

      const candidateId = req.params.id;

      const result = await pool.query(

        `

        SELECT *
        FROM cand_mstr
        WHERE candidate_id = $1

        `,

        [candidateId]

      );

      const row = result.rows[0] || null;

      if (!row) {

        return res.status(404).json({

          success: false,
          message: "Candidate not found."

        });

      }

      const addressResult = await pool.query(

        `

        SELECT country_code, state_code, city_code, address_line_1
        FROM can_address
        WHERE candidate_id = $1
          AND address_type = 'Current'
          AND active_flag = TRUE
        ORDER BY address_id DESC
        LIMIT 1

        `,

        [candidateId]

      );

      const address = addressResult.rows[0] || null;

      res.status(200).json({

        success: true,
        data: {
          ...row,
          country_code:
            row.current_country || address?.country_code || null,
          state_code:
            row.current_state || address?.state_code || null,
          city_code:
            row.current_city || address?.city_code || null,
          address_line: address?.address_line_1 || null,
          alternate_phone: row.alternate_mobile || null
        }

      });

    }

    catch (error) {

      console.log("❌ Fetch Candidate Error");

      console.log(error);

      res.status(500).json({

        success: false,
        message: "Error Fetching Candidate"

      });

    }

  }

);


// =====================================================
// API 3b - Stream Candidate Resume (inline preview)
// =====================================================
// Iframes cannot send Authorization headers, so this route also
// accepts ?token= for authenticated media preview.

app.get(

  "/candidate-resume/:candidateId",

  (req, res, next) => {

    if (!req.headers.authorization && req.query.token) {
      req.headers.authorization = `Bearer ${req.query.token}`;
    }

    return verifyToken(req, res, next);

  },

  async (req, res) => {

    try {

      const candidateId = req.params.candidateId;

      const result = await pool.query(

        `

        SELECT
          candidate_id,
          resume_path
        FROM cand_mstr
        WHERE candidate_id = $1

        `,

        [candidateId]

      );

      const candidate = result.rows[0];

      if (!candidate) {

        return res.status(404).json({

          success: false,
          message: "Candidate not found."

        });

      }

      if (!candidate.resume_path) {

        return res.status(404).json({

          success: false,
          message: "Resume not available."

        });

      }

      const objectKey =
        resolveStorageObjectKey(candidate.resume_path);

      let resumeBuffer;

      try {

        resumeBuffer =
          await downloadResumeFromStorage(candidate.resume_path);

      }

      catch (downloadError) {

        if (downloadError.isStatObjectFailure) {

          return res.status(404).json({

            success: false,
            message: "Resume not available."

          });

        }

        throw downloadError;

      }

      const fileName =
        path.basename(objectKey) || "resume.pdf";

      res.setHeader(
        "Content-Type",
        resolveResumeContentType(objectKey)
      );

      res.setHeader(
        "Content-Disposition",
        `inline; filename="${fileName.replace(/"/g, "")}"`
      );

      res.setHeader(
        "Content-Length",
        resumeBuffer.length
      );

      // Discourage caching of authenticated resume bytes.
      res.setHeader(
        "Cache-Control",
        "private, no-store"
      );

      return res.status(200).send(resumeBuffer);

    }

    catch (error) {

      console.log("❌ Stream Candidate Resume Error");

      console.log(error);

      return res.status(500).json({

        success: false,
        message: "Error retrieving resume."

      });

    }

  }

);


// =====================================================
// API 4 - Update Candidate
// =====================================================

app.put(

  "/candidate/:id",

  verifyToken,

  upload.single("resume"),

  async (req, res) => {

    try {

      const candidateId = req.params.id;

      const existingCandidate = await pool.query(

        `

        SELECT *
        FROM cand_mstr
        WHERE candidate_id = $1

        `,

        [candidateId]

      );

      if (existingCandidate.rows.length === 0) {

        return res.status(404).json({

          success: false,
          message: "Candidate not found."

        });

      }

      const existing = existingCandidate.rows[0];

      const resolveField = (fieldName) => {

        if (
          Object.prototype.hasOwnProperty.call(req.body, fieldName)
        ) {

          return req.body[fieldName];

        }

        return existing[fieldName];

      };

      const resolveAliasedField = (preferredKey, dbKey) => {

        if (
          Object.prototype.hasOwnProperty.call(req.body, preferredKey)
        ) {

          return req.body[preferredKey];

        }

        if (
          Object.prototype.hasOwnProperty.call(req.body, dbKey)
        ) {

          return req.body[dbKey];

        }

        return existing[dbKey];

      };

      const hasBodyField = (fieldName) =>
        Object.prototype.hasOwnProperty.call(req.body, fieldName);

      let resumePath = existing.resume_path || null;

      if (req.file) {

        resumePath =
          await uploadResumeToStorage(req.file);

      }

      const countryCode = resolveAliasedField(
        "country_code",
        "current_country"
      );
      const stateCode = resolveAliasedField(
        "state_code",
        "current_state"
      );
      const cityCode = resolveAliasedField(
        "city_code",
        "current_city"
      );
      const currentLocation = resolveField("current_location");
      const alternateMobile = resolveAliasedField(
        "alternate_phone",
        "alternate_mobile"
      );

      const isDraftRegistration =
        String(existing.candidate_status || "").trim().toUpperCase() ===
        "DRAFT";

      const candidateStatus = isDraftRegistration
        ? "REGISTERED"
        : resolveField("candidate_status");

      const registrationEmployeeCode =
        req.user?.employee_code || null;

      // candidate_container — optional Register Candidate field.
      // Allowed: PIPELINE | TALENT_POOL. Default PIPELINE when omitted.
      const rawCandidateContainer = hasBodyField("candidate_container")
        ? String(req.body.candidate_container || "").trim().toUpperCase()
        : "";

      let candidateContainer = "PIPELINE";

      if (rawCandidateContainer) {

        if (
          rawCandidateContainer !== "PIPELINE" &&
          rawCandidateContainer !== "TALENT_POOL"
        ) {

          return res.status(400).json({

            success: false,
            message:
              "candidate_container must be PIPELINE or TALENT_POOL."

          });

        }

        candidateContainer = rawCandidateContainer;

      }

      const registrationOwnerEmployeeCode =
        candidateContainer === "TALENT_POOL"
          ? null
          : registrationEmployeeCode;

      const result = await pool.query(

        `

        UPDATE cand_mstr

SET

    first_name      = $1,
    middle_name     = $2,
    last_name       = $3,
    preferred_name  = $4,
    gender          = $5,

    mobile_number   = $6,
    email_id        = $7,
    linkedin_url    = $8,
    alternate_mobile = $9,
    primary_skill   = $10,
    total_experience= $11,
    resume_path     = $12,
    candidate_status= $13,

    current_country = $14,
    current_state   = $15,
    current_city    = $16,
    current_location= $17,

    relevant_experience = $18,
    employment_type     = $19,
    preferred_work_mode = $20,
    current_company     = $21,
    current_designation = $22,
    current_department  = $23,
    notice_period       = $24,
    availability        = $25,
    currency_code       = $26,
    current_ctc         = $27,
    expected_ctc        = $28,
    ctc_negotiable      = $29,

    candidate_container = CASE WHEN $31 THEN $33 ELSE candidate_container END,
    owner_employee_code = CASE WHEN $31 THEN $34 ELSE owner_employee_code END,
    registered_by       = CASE WHEN $31 THEN $32 ELSE registered_by END,
    registered_on       = CASE WHEN $31 THEN CURRENT_TIMESTAMP ELSE registered_on END,

    updated_on      = CURRENT_TIMESTAMP

WHERE candidate_id = $30

RETURNING *

`,
[
    resolveField("first_name"),
    resolveField("middle_name"),
    resolveField("last_name"),
    resolveField("preferred_name"),
    resolveField("gender"),

    resolveField("mobile_number"),
    resolveField("email_id"),
    resolveField("linkedin_url"),
    alternateMobile,
    resolveField("primary_skill"),
    resolveField("total_experience"),
    resumePath,
    candidateStatus,

    countryCode,
    stateCode,
    cityCode,
    currentLocation,

    resolveField("relevant_experience"),
    resolveField("employment_type"),
    resolveField("preferred_work_mode"),
    resolveField("current_company"),
    resolveField("current_designation"),
    resolveField("current_department"),
    resolveField("notice_period"),
    resolveField("availability"),
    resolveField("currency_code"),
    resolveField("current_ctc"),
    resolveField("expected_ctc"),
    (() => {
      const value = resolveField("ctc_negotiable");
      if (value === true || value === "true") {
        return true;
      }
      if (value === false || value === "false") {
        return false;
      }
      return value;
    })(),

    candidateId,
    isDraftRegistration,
    registrationEmployeeCode,
    candidateContainer,
    registrationOwnerEmployeeCode
]

      );

      let addressLine = null;

      if (
        hasBodyField("country_code") ||
        hasBodyField("state_code") ||
        hasBodyField("city_code") ||
        hasBodyField("address_line") ||
        hasBodyField("current_country") ||
        hasBodyField("current_state") ||
        hasBodyField("current_city")
      ) {

        const existingAddress = await pool.query(

          `

          SELECT address_id, address_line_1
          FROM can_address
          WHERE candidate_id = $1
            AND address_type = 'Current'
            AND active_flag = TRUE
          ORDER BY address_id DESC
          LIMIT 1

          `,

          [candidateId]

        );

        addressLine = hasBodyField("address_line")
          ? req.body.address_line
          : (existingAddress.rows[0]?.address_line_1 || null);

        if (existingAddress.rows.length > 0) {

          await pool.query(

            `

            UPDATE can_address
            SET
              country_code = $1,
              state_code = $2,
              city_code = $3,
              address_line_1 = $4,
              modified_on = CURRENT_TIMESTAMP
            WHERE address_id = $5

            `,

            [
              countryCode || null,
              stateCode || null,
              cityCode || null,
              addressLine,
              existingAddress.rows[0].address_id
            ]

          );

        } else {

          await pool.query(

            `

            INSERT INTO can_address (
              candidate_id,
              address_type,
              address_line_1,
              city_code,
              state_code,
              country_code
            )
            VALUES ($1, 'Current', $2, $3, $4, $5)

            `,

            [
              candidateId,
              addressLine,
              cityCode || null,
              stateCode || null,
              countryCode || null
            ]

          );

        }

      } else {

        const existingAddress = await pool.query(

          `

          SELECT address_line_1
          FROM can_address
          WHERE candidate_id = $1
            AND address_type = 'Current'
            AND active_flag = TRUE
          ORDER BY address_id DESC
          LIMIT 1

          `,

          [candidateId]

        );

        addressLine = existingAddress.rows[0]?.address_line_1 || null;

      }

      const updatedRow = result.rows[0];

      res.status(200).json({

        success: true,
        message: "Candidate Updated Successfully",
        data: {
          ...updatedRow,
          country_code: updatedRow.current_country || countryCode || null,
          state_code: updatedRow.current_state || stateCode || null,
          city_code: updatedRow.current_city || cityCode || null,
          address_line: addressLine,
          alternate_phone: updatedRow.alternate_mobile || null,
          candidate_container: updatedRow.candidate_container ?? null,
          owner_employee_code: updatedRow.owner_employee_code ?? null,
          registered_by: updatedRow.registered_by ?? null,
          registered_on: updatedRow.registered_on ?? null
        }

      });

    }

    catch (error) {

      console.log("❌ Update Candidate Error");

      console.log(error);

      res.status(500).json({

        success: false,
        message: "Error Updating Candidate"

      });

    }

  }

);


// =====================================================
// Candidate Education APIs (can_education via candidateService)
// =====================================================

const EDUCATION_FIELDS = [
  "qualification",
  "institution",
  "specialization",
  "board_university",
  "year_of_passing",
  "percentage",
  "cgpa",
  "from_date",
  "to_date",
  "score_type",
  "active_flag"
];

function pickEducationPayload(body = {}) {
  const source = { ...body };

  if (
    source.university !== undefined &&
    source.board_university === undefined
  ) {
    source.board_university = source.university;
  }

  if (
    source.university_board !== undefined &&
    source.board_university === undefined
  ) {
    source.board_university = source.university_board;
  }

  // Map score + score_type → percentage/cgpa.
  // If score is not provided (missing/empty/invalid), do not touch percentage/cgpa.
  if (Object.prototype.hasOwnProperty.call(source, "score")) {
    const scoreType = String(source.score_type || "").trim();
    const scoreRaw = source.score;
    const cleanedScore =
      scoreRaw === "" || scoreRaw === null || scoreRaw === undefined
        ? null
        : String(scoreRaw)
            .trim()
            .replace(/,/g, "")
            .replace(/%/g, "")
            .replace(/cgpa/gi, "")
            .trim();
    const numericScore =
      cleanedScore === null || cleanedScore === ""
        ? null
        : Number(cleanedScore);
    const validScore =
      numericScore !== null && !Number.isNaN(numericScore)
        ? numericScore
        : null;

    if (validScore !== null) {
      if (scoreType === "CGPA") {
        source.cgpa = validScore;
        source.percentage = null;
      } else if (scoreType === "Percentage") {
        source.percentage = validScore;
        source.cgpa = null;
      }
    }
  }

  // Never persist the UI alias column; only percentage/cgpa are stored.
  delete source.score;

  if (source.to_date) {
    const year = Number(String(source.to_date).slice(0, 4));

    if (!Number.isNaN(year) && year > 1900 && year < 2100) {
      source.year_of_passing = year;
    }
  }

  const payload = {};

  EDUCATION_FIELDS.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      payload[field] = source[field];
    }
  });

  return payload;
}

app.get(

  "/candidate/:candidateId/education",

  verifyToken,

  async (req, res) => {

    try {

      const candidateId = req.params.candidateId;

      const master =
        await candidateService.getCandidateMaster(pool, candidateId);

      if (!master) {

        return res.status(404).json({

          success: false,
          message: "Candidate not found."

        });

      }

      const data =
        await candidateService.listChildRecords(
          pool,
          "education",
          candidateId
        );

      res.status(200).json({

        success: true,
        data

      });

    }

    catch (error) {

      console.log("❌ List Candidate Education Error");

      console.log(error);

      res.status(error.status || 500).json({

        success: false,
        message: error.message || "Error Fetching Candidate Education"

      });

    }

  }

);

app.post(

  "/candidate/:candidateId/education",

  verifyToken,

  async (req, res) => {

    try {

      const candidateId = req.params.candidateId;
      const payload = pickEducationPayload(req.body);

      const data =
        await candidateService.insertChildRecord(
          pool,
          "education",
          candidateId,
          payload
        );

      res.status(201).json({

        success: true,
        message: "Education record created successfully.",
        data

      });

    }

    catch (error) {

      console.log("❌ Create Candidate Education Error");

      console.log(error);

      res.status(error.status || 500).json({

        success: false,
        message: error.message || "Error Creating Candidate Education"

      });

    }

  }

);

app.put(

  "/candidate/:candidateId/education/:educationId",

  verifyToken,

  async (req, res) => {

    try {

      const candidateId = req.params.candidateId;
      const educationId = req.params.educationId;
      const payload = pickEducationPayload(req.body);

      const master =
        await candidateService.getCandidateMaster(pool, candidateId);

      if (!master) {

        return res.status(404).json({

          success: false,
          message: "Candidate not found."

        });

      }

      const records =
        await candidateService.listChildRecords(
          pool,
          "education",
          candidateId
        );

      const existing = records.find(
        (row) => String(row.education_id) === String(educationId)
      );

      if (!existing) {

        return res.status(404).json({

          success: false,
          message: "Education record not found."

        });

      }

      const columns = Object.keys(payload);

      if (!columns.length) {

        return res.status(400).json({

          success: false,
          message: "No education fields supplied."

        });

      }

      const educationConfig =
        candidateService.CHILD_TABLES.education;

      const setClauses = columns.map(
        (column, index) => `${column} = $${index + 1}`
      );

      setClauses.push(`modified_on = CURRENT_TIMESTAMP`);

      const values = [
        ...columns.map((column) => payload[column]),
        educationId,
        candidateId
      ];

      const result = await pool.query(

        `

        UPDATE ${educationConfig.table}
        SET ${setClauses.join(", ")}
        WHERE ${educationConfig.idColumn} = $${columns.length + 1}
          AND ${educationConfig.candidateColumn} = $${columns.length + 2}
        RETURNING *

        `,

        values

      );

      res.status(200).json({

        success: true,
        message: "Education record updated successfully.",
        data: result.rows[0]

      });

    }

    catch (error) {

      console.log("❌ Update Candidate Education Error");

      console.log(error);

      res.status(error.status || 500).json({

        success: false,
        message: error.message || "Error Updating Candidate Education"

      });

    }

  }

);

app.delete(

  "/candidate/:candidateId/education/:educationId",

  verifyToken,

  async (req, res) => {

    try {

      const candidateId = req.params.candidateId;
      const educationId = req.params.educationId;

      const master =
        await candidateService.getCandidateMaster(pool, candidateId);

      if (!master) {

        return res.status(404).json({

          success: false,
          message: "Candidate not found."

        });

      }

      const records =
        await candidateService.listChildRecords(
          pool,
          "education",
          candidateId
        );

      const existing = records.find(
        (row) => String(row.education_id) === String(educationId)
      );

      if (!existing) {

        return res.status(404).json({

          success: false,
          message: "Education record not found."

        });

      }

      const educationConfig =
        candidateService.CHILD_TABLES.education;

      const result = await pool.query(

        `

        DELETE FROM ${educationConfig.table}
        WHERE ${educationConfig.idColumn} = $1
          AND ${educationConfig.candidateColumn} = $2
        RETURNING *

        `,

        [educationId, candidateId]

      );

      res.status(200).json({

        success: true,
        message: "Education record deleted successfully.",
        data: result.rows[0]

      });

    }

    catch (error) {

      console.log("❌ Delete Candidate Education Error");

      console.log(error);

      res.status(error.status || 500).json({

        success: false,
        message: error.message || "Error Deleting Candidate Education"

      });

    }

  }

);


// =====================================================
// Candidate Experience APIs (can_experience via candidateService)
// =====================================================

const EXPERIENCE_FIELDS = [
  "company_name",
  "designation",
  "joining_date",
  "relieving_date",
  "role_summary",
  "technology",
  "reason_for_change"
];

function pickExperiencePayload(body = {}) {
  const source = { ...body };
  const payload = {};

  EXPERIENCE_FIELDS.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      payload[field] = source[field];
    }
  });

  return payload;
}

app.get(

  "/candidate/:candidateId/experience",

  verifyToken,

  async (req, res) => {

    try {

      const candidateId = req.params.candidateId;

      const master =
        await candidateService.getCandidateMaster(pool, candidateId);

      if (!master) {

        return res.status(404).json({

          success: false,
          message: "Candidate not found."

        });

      }

      const data =
        await candidateService.listChildRecords(
          pool,
          "experience",
          candidateId
        );

      res.status(200).json({

        success: true,
        data

      });

    }

    catch (error) {

      console.log("❌ List Candidate Experience Error");

      console.log(error);

      res.status(error.status || 500).json({

        success: false,
        message: error.message || "Error Fetching Candidate Experience"

      });

    }

  }

);

app.post(

  "/candidate/:candidateId/experience",

  verifyToken,

  async (req, res) => {

    try {

      const candidateId = req.params.candidateId;
      const payload = pickExperiencePayload(req.body);

      const data =
        await candidateService.insertChildRecord(
          pool,
          "experience",
          candidateId,
          payload
        );

      res.status(201).json({

        success: true,
        message: "Experience record created successfully.",
        data

      });

    }

    catch (error) {

      console.log("❌ Create Candidate Experience Error");

      console.log(error);

      res.status(error.status || 500).json({

        success: false,
        message: error.message || "Error Creating Candidate Experience"

      });

    }

  }

);

app.put(

  "/candidate/:candidateId/experience/:experienceId",

  verifyToken,

  async (req, res) => {

    try {

      const candidateId = req.params.candidateId;
      const experienceId = req.params.experienceId;
      const payload = pickExperiencePayload(req.body);

      const master =
        await candidateService.getCandidateMaster(pool, candidateId);

      if (!master) {

        return res.status(404).json({

          success: false,
          message: "Candidate not found."

        });

      }

      const records =
        await candidateService.listChildRecords(
          pool,
          "experience",
          candidateId
        );

      const existing = records.find(
        (row) => String(row.experience_id) === String(experienceId)
      );

      if (!existing) {

        return res.status(404).json({

          success: false,
          message: "Experience record not found."

        });

      }

      const columns = Object.keys(payload);

      if (!columns.length) {

        return res.status(400).json({

          success: false,
          message: "No experience fields supplied."

        });

      }

      const experienceConfig =
        candidateService.CHILD_TABLES.experience;

      const setClauses = columns.map(
        (column, index) => `${column} = $${index + 1}`
      );

      setClauses.push(`modified_on = CURRENT_TIMESTAMP`);

      const values = [
        ...columns.map((column) => payload[column]),
        experienceId,
        candidateId
      ];

      const result = await pool.query(

        `

        UPDATE ${experienceConfig.table}
        SET ${setClauses.join(", ")}
        WHERE ${experienceConfig.idColumn} = $${columns.length + 1}
          AND ${experienceConfig.candidateColumn} = $${columns.length + 2}
        RETURNING *

        `,

        values

      );

      res.status(200).json({

        success: true,
        message: "Experience record updated successfully.",
        data: result.rows[0]

      });

    }

    catch (error) {

      console.log("❌ Update Candidate Experience Error");

      console.log(error);

      res.status(error.status || 500).json({

        success: false,
        message: error.message || "Error Updating Candidate Experience"

      });

    }

  }

);

app.delete(

  "/candidate/:candidateId/experience/:experienceId",

  verifyToken,

  async (req, res) => {

    try {

      const candidateId = req.params.candidateId;
      const experienceId = req.params.experienceId;

      const master =
        await candidateService.getCandidateMaster(pool, candidateId);

      if (!master) {

        return res.status(404).json({

          success: false,
          message: "Candidate not found."

        });

      }

      const records =
        await candidateService.listChildRecords(
          pool,
          "experience",
          candidateId
        );

      const existing = records.find(
        (row) => String(row.experience_id) === String(experienceId)
      );

      if (!existing) {

        return res.status(404).json({

          success: false,
          message: "Experience record not found."

        });

      }

      const experienceConfig =
        candidateService.CHILD_TABLES.experience;

      const result = await pool.query(

        `

        DELETE FROM ${experienceConfig.table}
        WHERE ${experienceConfig.idColumn} = $1
          AND ${experienceConfig.candidateColumn} = $2
        RETURNING *

        `,

        [experienceId, candidateId]

      );

      res.status(200).json({

        success: true,
        message: "Experience record deleted successfully.",
        data: result.rows[0]

      });

    }

    catch (error) {

      console.log("❌ Delete Candidate Experience Error");

      console.log(error);

      res.status(error.status || 500).json({

        success: false,
        message: error.message || "Error Deleting Candidate Experience"

      });

    }

  }

);


// =====================================================
// API 5 - Register User
// =====================================================

app.post(

  "/register",

  verifyToken,

  verifyAdmin,

  async (req, res) => {

    try {

      const {

        employee_code,
        full_name,
        email_id,
        password,
        role_name

      } = req.body;


      const existingUser = await pool.query(

        `

        SELECT *
        FROM user_mstr
        WHERE email_id = $1

        `,

        [email_id]

      );

      if (existingUser.rows.length > 0) {

        return res.status(400).json({

          success: false,
          message: "User already exists"

        });

      }


      const hashedPassword =
        await bcrypt.hash(password, 10);


      const result = await pool.query(

        `

        INSERT INTO user_mstr (

          employee_code,
          full_name,
          email_id,
          password_hash,
          role_name

        )

        VALUES (

          $1,$2,$3,$4,$5

        )

        RETURNING

          user_id,
          employee_code,
          full_name,
          email_id,
          role_name,
          created_on

        `,

        [

          employee_code,
          full_name,
          email_id,
          hashedPassword,
          role_name || "Recruiter"

        ]

      );

      res.status(201).json({

        success: true,
        message: "User Registered Successfully",
        data: result.rows[0]

      });

    }

    catch (error) {

      console.log("❌ Register User Error");

      console.log(error);

      res.status(500).json({

        success: false,
        message: "Error Registering User"

      });

    }

  }

);
// =====================================================
// API 6 - Get All Users
// =====================================================

app.get(

  "/users",

  verifyToken,

  verifyAdmin,

  async (req, res) => {

    try {

      const result = await pool.query(`

        SELECT

          user_id,
          employee_code,
          full_name,
          email_id,
          role_name,
          is_active,
          created_on

        FROM user_mstr

        ORDER BY user_id DESC

      `);

      res.status(200).json({

        success: true,
        data: result.rows

      });

    }

    catch (error) {

      console.log("❌ Fetch Users Error");

      console.log(error);

      res.status(500).json({

        success: false,
        message: "Error Fetching Users"

      });

    }

  }

);
// =====================================================
// API 7 - Create Requisition
// =====================================================

app.post(

  "/requisition",

  verifyToken,

  (req, res) => recruitmentLegacyHandlers.handleLegacyCreateRequisition(pool, req, res)

);


// =====================================================
// API 8 - Get All Requisitions
// =====================================================

app.get(

  "/requisitions",

  verifyToken,

  (req, res) => recruitmentLegacyReadHandlers.handleGetRequisitions(pool, req, res)

);


// =====================================================
// API 9 - Update Requisition
// =====================================================

app.put(

  "/requisition/:id",

  verifyToken,

  async (req, res) => {

    try {

      const reqId = req.params.id;

      const {

        client_name,
        project_name,
        job_title,
        job_description,
        primary_skill,
        secondary_skill,
        experience_min,
        experience_max,
        openings_count,
        work_location,
        employment_type,
        priority_level,
        req_status,
        recruiter_id,
        hiring_manager,
        target_date

      } = req.body;


      const result = await pool.query(

        `

        UPDATE req_mstr

        SET

          client_name = $1,
          project_name = $2,
          job_title = $3,
          job_description = $4,
          primary_skill = $5,
          secondary_skill = $6,
          experience_min = $7,
          experience_max = $8,
          openings_count = $9,
          work_location = $10,
          employment_type = $11,
          priority_level = $12,
          req_status = $13,
          recruiter_id = $14,
          hiring_manager = $15,
          target_date = $16,
          updated_on = CURRENT_TIMESTAMP

        WHERE req_id = $17

        RETURNING *

        `,

        [

          client_name,
          project_name,
          job_title,
          job_description,
          primary_skill,
          secondary_skill,
          experience_min,
          experience_max,
          openings_count,
          work_location,
          employment_type,
          priority_level,
          req_status,
          recruiter_id,
          hiring_manager,
          target_date,
          reqId

        ]

      );

      res.status(200).json({

        success: true,
        message: "Requisition Updated Successfully",
        data: result.rows[0]

      });

    }

    catch (error) {

      console.log("❌ Update Requisition Error");

      console.log(error);

      res.status(500).json({

        success: false,
        message: "Error Updating Requisition"

      });

    }

  }

);
// =====================================================
// API 13 - Create Client
// =====================================================

app.post(

  "/client",

  verifyToken,

  async (req, res) => {

    try {

      const { client_name } = req.body;

      const existingClient =
        await pool.query(

          `

          SELECT *
          FROM client_mstr
          WHERE LOWER(client_name) = LOWER($1)

          `,

          [client_name]

        );

      if (existingClient.rows.length > 0) {

        return res.status(400).json({

          success: false,
          message: "Client Already Exists"

        });

      }


      // =====================================
      // Insert Client
      // =====================================

      const insertResult =
        await pool.query(

          `

          INSERT INTO client_mstr (

            client_name

          )

          VALUES ($1)

          RETURNING *

          `,

          [client_name]

        );

      const newClient =
        insertResult.rows[0];


      // =====================================
      // Generate Client Code
      // =====================================

      const clientCode =
        `CLI-${1000 + newClient.client_id}`;


      // =====================================
      // Update Client Code
      // =====================================

      await pool.query(

        `

        UPDATE client_mstr

        SET client_code = $1

        WHERE client_id = $2

        `,

        [

          clientCode,
          newClient.client_id

        ]

      );


      res.status(201).json({

        success: true,
        message: "Client Created Successfully",

        data: {

          ...newClient,
          client_code: clientCode

        }

      });

    }

    catch (error) {

      console.log("❌ Create Client Error");

      console.log(error);

      res.status(500).json({

        success: false,
        message: "Error Creating Client"

      });

    }

  }

);
// =====================================================
// API 14 - Get Clients
// =====================================================

app.get(

  "/clients",

  verifyToken,

  async (req, res) => {

    try {

      const result = await pool.query(`

        SELECT *

        FROM client_mstr

        WHERE is_active = true

        ORDER BY client_name

      `);

      res.status(200).json({

        success: true,
        data: result.rows

      });

    }

    catch (error) {

      console.log("❌ Fetch Clients Error");

      console.log(error);

      res.status(500).json({

        success: false,
        message: "Error Fetching Clients"

      });

    }

  }

);

// =====================================================
// API 15 - Create Project
// =====================================================

app.post(

  "/project",

  verifyToken,

  async (req, res) => {

    try {

      const {

        client_id,
        project_name

      } = req.body;


      // =====================================
      // Insert Project
      // =====================================

      const insertResult =
        await pool.query(

          `

          INSERT INTO project_mstr (

            client_id,
            project_name

          )

          VALUES ($1,$2)

          RETURNING *

          `,

          [

            client_id,
            project_name

          ]

        );

      const newProject =
        insertResult.rows[0];


      // =====================================
      // Generate Project Code
      // =====================================

      const projectCode =
        `PROJ-${1000 + newProject.project_id}`;


      // =====================================
      // Update Project Code
      // =====================================

      await pool.query(

        `

        UPDATE project_mstr

        SET project_code = $1

        WHERE project_id = $2

        `,

        [

          projectCode,
          newProject.project_id

        ]

      );


      res.status(201).json({

        success: true,
        message: "Project Created Successfully",

        data: {

          ...newProject,
          project_code: projectCode

        }

      });

    }

    catch (error) {

      console.log("❌ Create Project Error");

      console.log(error);

      res.status(500).json({

        success: false,
        message: "Error Creating Project"

      });

    }

  }

);

// =====================================================
// API 16 - Get All Projects
// =====================================================

app.get(

  "/all-projects",

  verifyToken,

  async (req, res) => {

    try {

      const result = await pool.query(`

        SELECT

          p.project_id,
          p.project_code,
          p.project_name,
          c.client_name

        FROM project_mstr p

        LEFT JOIN client_mstr c

        ON p.client_id = c.client_id

        WHERE p.is_active = true

        ORDER BY p.project_id DESC

      `);

      res.status(200).json({

        success: true,
        data: result.rows

      });

    }

    catch (error) {

      console.log("❌ Fetch Projects Error");

      console.log(error);

      res.status(500).json({

        success: false,
        message: "Error Fetching Projects"

      });

    }

  }

);

// =====================================================
// API 17 - Get Projects By Client
// =====================================================

app.get(

  "/projects/:clientId",

  verifyToken,

  async (req, res) => {

    try {

      const { clientId } = req.params;

      const result = await pool.query(

        `

        SELECT

          project_id,
          project_code,
          project_name

        FROM project_mstr

        WHERE client_id = $1
        AND is_active = true

        ORDER BY project_name ASC

        `,

        [clientId]

      );

      res.status(200).json({

        success: true,
        data: result.rows

      });

    }

    catch (error) {

      console.log("❌ Fetch Projects By Client Error");

      console.log(error);

      res.status(500).json({

        success: false,
        message: "Error Fetching Projects"

      });

    }

  }

);
// =====================================================
// API 18 - Create Hiring Manager
// =====================================================

app.post(

  "/hiring-manager",

  verifyToken,

  async (req, res) => {

    try {

      const {

        client_id,
        project_id,
        hiring_manager_name,
        email_id

      } = req.body;


      // =====================================
      // Insert Hiring Manager
      // =====================================

      const insertResult =
        await pool.query(

          `

          INSERT INTO hiring_manager_mstr (

            client_id,
            project_id,
            hiring_manager_name,
            email_id

          )

          VALUES ($1,$2,$3,$4)

          RETURNING *

          `,

          [

            client_id,
            project_id,
            hiring_manager_name,
            email_id

          ]

        );

      const newHM =
        insertResult.rows[0];


      // =====================================
      // Generate HM Code
      // =====================================

      const hmCode =
        `HM-${1000 + newHM.hiring_manager_id}`;


      // =====================================
      // Update HM Code
      // =====================================

      await pool.query(

        `

        UPDATE hiring_manager_mstr

        SET hiring_manager_code = $1

        WHERE hiring_manager_id = $2

        `,

        [

          hmCode,
          newHM.hiring_manager_id

        ]

      );


      res.status(201).json({

        success: true,

        message:
          "Hiring Manager Created Successfully",

        data: {

          ...newHM,
          hiring_manager_code: hmCode

        }

      });

    }

    catch (error) {

      console.log(

        "❌ Create Hiring Manager Error"

      );

      console.log(error);

      res.status(500).json({

        success: false,

        message:
          "Error Creating Hiring Manager"

      });

    }

  }

);

// =====================================================
// API 19 - Get All Hiring Managers
// =====================================================

app.get(

  "/all-hiring-managers",

  verifyToken,

  async (req, res) => {

    try {

      const result = await pool.query(`

        SELECT

          hm.hiring_manager_id,
         
          hm.hiring_manager_code,

          hm.hiring_manager_name,

          hm.email_id,

          c.client_name,

          p.project_name

        FROM hiring_manager_mstr hm

        LEFT JOIN client_mstr c

        ON hm.client_id = c.client_id

        LEFT JOIN project_mstr p

        ON hm.project_id = p.project_id

        WHERE hm.is_active = true

        ORDER BY hm.hiring_manager_id DESC

      `);

      res.status(200).json({

        success: true,
        data: result.rows

      });

    }

    catch (error) {

      console.log(

        "❌ Fetch Hiring Managers Error"

      );

      console.log(error);

      res.status(500).json({

        success: false,
        message:
          "Error Fetching Hiring Managers"

      });

    }

  }

);

// =====================================================
// API 18 - Get Hiring Managers By Project
// =====================================================

app.get(

  "/hiring-managers/:projectId",

  verifyToken,

  async (req, res) => {

    try {

      const { projectId } = req.params;

      const result = await pool.query(

        `

        SELECT

          hiring_manager_id,
          hiring_manager_name,
          email_id

        FROM hiring_manager_mstr

        WHERE project_id = $1
        AND is_active = true

        ORDER BY hiring_manager_name ASC

        `,

        [projectId]

      );

      res.status(200).json({

        success: true,
        data: result.rows

      });

    }

    catch (error) {

      console.log(
        "❌ Fetch Hiring Managers Error"
      );

      console.log(error);

      res.status(500).json({

        success: false,
        message:
          "Error Fetching Hiring Managers"

      });

    }

  }

);
// =====================================================
// API 20 - Login User
// =====================================================

app.post("/login", async (req, res) => {

  try {

    const {

      email_id,
      password

    } = req.body || {};

    console.log("[login] Incoming request", {
      email_id: email_id || null,
      has_password: typeof password === "string" && password.length > 0
    });

    if (
      !email_id ||
      typeof password !== "string"
    ) {

      return res.status(400).json({

        success: false,
        message: "Email and password are required"

      });

    }

    console.log("[login] Executing user lookup query");

    const userResult = await pool.query(

      `

      SELECT *
      FROM user_mstr
      WHERE email_id = $1

      `,

      [email_id]

    );

    console.log("[login] Query result", {
      row_count: userResult.rows.length
    });

    if (userResult.rows.length === 0) {

      return res.status(401).json({

        success: false,
        message: "Invalid Email"

      });

    }

    const user = userResult.rows[0];

    if (!user.password_hash) {

      console.error("[login] User record missing password_hash", {
        user_id: user.user_id,
        email_id: user.email_id
      });

      return res.status(401).json({

        success: false,
        message: "Invalid Password"

      });

    }

    let validPassword = false;

    try {

      validPassword =
        await bcrypt.compare(

          password,
          user.password_hash

        );

    }

    catch (compareError) {

      console.error("[login] Password comparison failed", {
        user_id: user.user_id,
        email_id: user.email_id,
        message: compareError.message
      });

      return res.status(401).json({

        success: false,
        message: "Invalid Password"

      });

    }

    console.log("[login] Password comparison result", {
      user_id: user.user_id,
      valid: validPassword
    });

    if (!validPassword) {

      return res.status(401).json({

        success: false,
        message: "Invalid Password"

      });

    }

    if (!process.env.JWT_SECRET) {

      console.error("[login] JWT_SECRET is not configured");

      return res.status(500).json({

        success: false,
        message: "Login Error"

      });

    }

    console.log("[login] Generating JWT");

    const token = jwt.sign(

  {

    user_id: user.user_id,
    employee_code: user.employee_code,
    email_id: user.email_id,
    role_name: user.role_name,
    secondary_role: user.secondary_role

  },

      process.env.JWT_SECRET,

      {

        expiresIn: "8h"

      }

    );

    console.log("[login] JWT generated", {
      user_id: user.user_id
    });

    let workAssignments = [];
    let workAssignmentStatus = "NO_ASSIGNMENTS";
    let workspace = {};

    try {
      const employeeAssignments =
        await workAssignmentService.getEmployeeWorkAssignments(
          pool,
          user.employee_code
        );

      workAssignments = (employeeAssignments || [])
        .filter((row) => row.is_active === true)
        .map((row) => ({
          assignment_code: row.assignment_code,
          assignment_name: row.assignment_name
        }));

      workAssignmentStatus =
        workAssignments.length > 0 ? "LOADED" : "NO_ASSIGNMENTS";
    } catch (workAssignmentError) {
      console.error("[login] Failed to load work assignments", {
        employee_code: user.employee_code,
        message: workAssignmentError.message
      });
      workAssignments = [];
      workAssignmentStatus = "SERVICE_UNAVAILABLE";
    }

    try {
      const resolved = await workspaceResolverService.resolveWorkspace(
        pool,
        user.employee_code
      );
      workspace = resolved?.workspace || {};
    } catch (workspaceError) {
      console.error("[login] Failed to resolve workspace", {
        employee_code: user.employee_code,
        message: workspaceError.message
      });
      workspace = {};
    }

    res.status(200).json({

      success: true,

      message: "Login Successful",

      token: token,

      user: {

        user_id: user.user_id,
        employee_code: user.employee_code,
        full_name: user.full_name,
        email_id: user.email_id,
        role_name: user.role_name,
        secondary_role: user.secondary_role

      },

      work_assignments: workAssignments,

      work_assignment_status: workAssignmentStatus,

      workspace

    });

  }

  catch (error) {

    console.log("❌ Login Error");

    console.error("[login] Exception", {
      message: error.message,
      stack: error.stack
    });

    res.status(500).json({

      success: false,
      message: "Login Error"

    });

  }

});
// =====================================================
// API 21 - Map Candidate To Requisition
// =====================================================

app.post(

  "/candidate-req-map",

  verifyToken,

  (req, res) => recruitmentLegacyHandlers.handleLegacyMapCandidate(pool, req, res)

);

// =====================================================
// API 22 - Get Candidates By Requisition
// =====================================================

app.get(

  "/candidates-by-req/:reqId",

  verifyToken,

  async (req, res) => {

    try {

      const reqId =
        req.params.reqId;

      const result =
        await pool.query(

          `

          SELECT

            crm.map_id,

            crm.stage_name,

            crm.source_type,

            crm.applied_date,

            crm.remarks,

            crm.recruiter_id,

            c.candidate_id,

            c.candidate_code,

            c.first_name,

            c.last_name,

            c.email_id,

            c.mobile_number,

            r.req_id,

            r.req_code,

            r.job_title

          FROM candidate_req_map crm

          LEFT JOIN cand_mstr c

          ON crm.candidate_id =
             c.candidate_id

          LEFT JOIN req_mstr r

          ON crm.req_id =
             r.req_id

          WHERE crm.req_id = $1
          AND crm.is_active = true

          ORDER BY crm.applied_date DESC

          `,

          [reqId]

        );

      res.status(200).json({

        success: true,

        data: result.rows

      });

    }

    catch (error) {

      console.log(
        "❌ Fetch Candidates By Req Error"
      );

      console.log(error);

      res.status(500).json({

        success: false,

        message:
          "Error Fetching Candidates"

      });

    }

  }

);

// =====================================================
// API 23 - Update ATS Stage
// =====================================================

app.put(

  "/update-ats-stage/:mapId",

  verifyToken,

  (req, res) => recruitmentLegacyHandlers.handleLegacyUpdateStage(pool, req, res)

);
// =====================================================
// API 24 - Recruiter Pipeline Dashboard
// =====================================================

app.get(

  "/recruiter-pipeline",

  verifyToken,

  async (req, res) => {

    try {

      const result =
        await pool.query(

          `

          SELECT

            crm.recruiter_id,

            crm.stage_name,

            COUNT(*) AS candidate_count

          FROM candidate_req_map crm

          WHERE crm.is_active = true

          GROUP BY

            crm.recruiter_id,
            crm.stage_name

          ORDER BY

            crm.recruiter_id,
            crm.stage_name

          `

        );

      res.status(200).json({

        success: true,

        data: result.rows

      });

    }

    catch (error) {

      console.log(
        "❌ Recruiter Pipeline Error"
      );

      console.log(error);

      res.status(500).json({

        success: false,

        message:
          "Error Fetching Recruiter Pipeline"

      });

    }

  }

);

// =====================================================
// API 25 - Recruiter Pipeline Details
// =====================================================

app.get(

  "/pipeline-details",

  verifyToken,

  async (req, res) => {

    try {

      let query = `

        SELECT

          crm.map_id,

          c.candidate_code,

          c.first_name,
          c.last_name,

          r.req_code,
          r.job_title,
          r.client_name,
          r.project_name,

          crm.stage_name,
          crm.source_type,

          crm.recruiter_id,

          crm.applied_date

        FROM candidate_req_map crm

        LEFT JOIN cand_mstr c
        ON crm.candidate_id = c.candidate_id

        LEFT JOIN req_mstr r
        ON crm.req_id::TEXT = r.req_id::TEXT

        WHERE crm.is_active = true

      `;

      const values = [];

      // =====================================
      // Recruiter Restriction
      // =====================================

      if (req.user.role_name === "Recruiter") {

        query += `

          AND crm.recruiter_id = $1

        `;

        values.push(
          req.user.employee_code
        );

      }

      query += `

        ORDER BY crm.applied_date DESC

      `;

      const result =
        await pool.query(
          query,
          values
        );

      console.log(result.rows);

      res.status(200).json({

        success: true,

        data: result.rows

      });

    }

    catch (error) {

      console.log(
        "❌ Pipeline Details Error"
      );

      console.log(error);

      res.status(500).json({

        success: false,

        message:
          "Error Fetching Pipeline Details"

      });

    }

  }

);

// =====================================================
// API 26 - Fetch Candidate Full ATS Details
// =====================================================

app.get(

  "/candidate-full-details/:candidateId",

  verifyToken,

  async (req, res) => {

    try {

      const { candidateId } = req.params;

      const result =
        await pool.query(`

          SELECT

            c.candidate_id,
            c.candidate_code,

            c.first_name,
            c.last_name,

            c.email_id,
            c.pan_number,
            c.mobile_number,

            c.primary_skill,
            c.total_experience,

            c.candidate_status,
            c.resume_path,

            crm.map_id,

            crm.req_id,

            crm.requisition_code AS req_code,

            crm.stage_name,

            crm.source_type,

            crm.remarks

          FROM cand_mstr c

          LEFT JOIN rm_candidate_mappings crm
          ON c.candidate_id = crm.candidate_id
          AND crm.is_active = true

          WHERE c.candidate_id = $1
          
          ORDER BY crm.map_id DESC

          LIMIT 1

        `,

        [candidateId]

      );

      res.status(200).json({

        success: true,

        data: result.rows[0]

      });

    }

    catch (error) {

      console.log(
        "❌ Candidate Full Details Error"
      );

      console.log(error);

      res.status(500).json({

        success: false,

        message:
          "Error Fetching Candidate Details"

      });

    }

  }

);

// =====================================================
// API 27 - Dashboard Summary
// =====================================================

app.get(

  "/dashboard-summary",

  verifyToken,

  async (req, res) => {

    try {

      const period =
        req.query.period || "month";

      let candidateDateFilter = "";
      let pipelineDateFilter = "";

      if (period === "today") {

        candidateDateFilter =
          "AND created_on::date = CURRENT_DATE";

        pipelineDateFilter =
          "AND applied_date::date = CURRENT_DATE";

      }

      else if (period === "week") {

        candidateDateFilter =
          "AND created_on >= date_trunc('week', CURRENT_DATE)";

        pipelineDateFilter =
          "AND applied_date >= date_trunc('week', CURRENT_DATE)";

      }

      else if (period === "month") {

        candidateDateFilter =
          "AND created_on >= date_trunc('month', CURRENT_DATE)";

        pipelineDateFilter =
          "AND applied_date >= date_trunc('month', CURRENT_DATE)";

      }

      else if (period === "quarter") {

        candidateDateFilter =
          "AND created_on >= date_trunc('quarter', CURRENT_DATE)";

        pipelineDateFilter =
          "AND applied_date >= date_trunc('quarter', CURRENT_DATE)";

      }

      else if (period === "year") {

        candidateDateFilter =
          "AND created_on >= date_trunc('year', CURRENT_DATE)";

        pipelineDateFilter =
          "AND applied_date >= date_trunc('year', CURRENT_DATE)";

      }

      const result =
        await pool.query(`

          SELECT

            COUNT(*) AS total_candidates,

            COUNT(*) FILTER (
              WHERE candidate_status = 'Joined'
            ) AS joined,

            COUNT(*) FILTER (
              WHERE candidate_status = 'Offered'
            ) AS offered,

            COUNT(*) FILTER (
              WHERE candidate_status = 'Screen Select'
            ) AS screen_select,

            COUNT(*) FILTER (
              WHERE candidate_status = 'Client Interview'
            ) AS client_interview

          FROM cand_mstr

          WHERE 1 = 1

          ${candidateDateFilter}

        `);

      const pipeline =
        await pool.query(`

          SELECT

            COUNT(*) AS pipeline_records

          FROM candidate_req_map

          WHERE is_active = true

          ${pipelineDateFilter}

        `);

      res.status(200).json({

        success: true,

        data: {

          ...result.rows[0],

          pipeline_records:
            pipeline.rows[0].pipeline_records,

          selected_period:
            period

        }

      });

    }

    catch (error) {

      console.log(
        "❌ Dashboard Summary Error"
      );

      console.log(error);

      res.status(500).json({

        success: false,

        message:
          "Error Fetching Dashboard Summary"

      });

    }

  }

);

// =====================================================
// API 28 - Dashboard Funnel
// =====================================================

app.get(

  "/dashboard-funnel",

  verifyToken,

  async (req, res) => {

    try {

      const result =
        await pool.query(`

          WITH stages AS (

            SELECT 'Applied' AS stage_name, 1 AS seq

            UNION ALL

            SELECT 'Screening', 2

            UNION ALL

            SELECT 'L1 Interview', 3

            UNION ALL

            SELECT 'L2 Interview', 4

            UNION ALL

            SELECT 'Client Interview', 5

            UNION ALL

            SELECT 'Offer', 6

            UNION ALL

            SELECT 'Joined', 7

          )

          SELECT

            s.stage_name,

            COALESCE(
            COUNT(crm.map_id),
            0
            )::INTEGER AS candidate_count

          FROM stages s

          LEFT JOIN candidate_req_map crm

          ON crm.stage_name = s.stage_name

          AND crm.is_active = true

          GROUP BY

            s.seq,
            s.stage_name

          ORDER BY

            s.seq

        `);

      res.status(200).json({

        success: true,

        data: result.rows

      });

    }

    catch (error) {

      console.log(
        "❌ Dashboard Funnel Error"
      );

      console.log(error);

      res.status(500).json({

        success: false,

        message:
          "Error Fetching Dashboard Funnel"

      });

    }

  }

);

// =====================================================
// API 29 - Assign Recruiter To Requisition
// =====================================================

app.post(

  "/assign-recruiter",

  verifyToken,

  (req, res) => recruitmentLegacyHandlers.handleLegacyAssignRecruiter(pool, req, res)

);

// =====================================================
// API 30 - Get My Requisitions
// =====================================================

app.get(

  "/my-requisitions",

  verifyToken,

  (req, res) => recruitmentLegacyReadHandlers.handleGetMyRequisitions(pool, req, res)

);

// =====================================================
// API 31 - Get Recruiters
// =====================================================

app.get(

  "/recruiters",

  verifyToken,

  async (req, res) => {

    try {

      const result =
        await pool.query(

          `

          SELECT

            employee_code,
            full_name

          FROM user_mstr

          WHERE role_name = 'Recruiter'
          AND is_active = true

          ORDER BY full_name

          `

        );

      res.status(200).json({

        success: true,

        count: result.rows.length,

        data: result.rows

      });

    }

    catch (error) {

      console.log(
        "❌ Get Recruiters Error"
      );

      console.log(error);

      res.status(500).json({

        success: false,

        message:
          "Error Fetching Recruiters"

      });

    }

  }

);

// =====================================================
// API 32 - Get Assigned Recruiters For Requisition
// =====================================================

app.get(

  "/assigned-recruiters/:reqId",

  verifyToken,

  (req, res) => recruitmentLegacyReadHandlers.handleGetAssignedRecruiters(pool, req, res)

);

// =====================================================
// API 34 - Map Existing Candidate To Requisition
// =====================================================

app.post(

  "/map-existing-candidate",

  verifyToken,

  async (req, res) => {

    try {
console.log("===== API 34 HIT =====");
console.log("Logged In User:");
console.log(req.user);
        const {

  candidate_id,
  requisition_code,
  stage_name,
  source_type,
  remarks

} = req.body;
const reqLookup = await pool.query(
  `
  SELECT req_id
  FROM rm_requisitions
  WHERE requisition_code = $1
  `,
  [requisition_code]
);

if (reqLookup.rows.length === 0) {
  return res.status(404).json({
    success: false,
    message: "Requisition not found"
  });
}

const req_id = reqLookup.rows[0].req_id;

if (!req_id) {
  return res.status(400).json({
    success: false,
    message: "Enterprise requisition is not linked to a legacy Req ID."
  });
}

// ===============================================
// DEBUG LOGS  ← ADD THEM HERE
// ===============================================

console.log("==================================");
console.log("Candidate ID      :", candidate_id);
console.log("Requisition Code  :", requisition_code);
console.log("Resolved Req ID   :", req_id);
console.log("==================================");

// ===============================================
// Existing Mapping Check
// ===============================================

      const existingMap =
        await pool.query(

          `

          SELECT *

          FROM candidate_req_map

          WHERE candidate_id = $1
          AND req_id = $2
          AND is_active = true

          `,

          [

            candidate_id,
            req_id

          ]

        );

      if (existingMap.rows.length > 0) {

        return res.status(400).json({

          success: false,

          message:
            "Candidate Already Mapped"

        });

      }

      const result =
        await pool.query(

          `

          INSERT INTO candidate_req_map (

            candidate_id,
            req_id,
            recruiter_id,
            stage_name,
            source_type,
            remarks

          )

          VALUES (

            $1,
            $2,
            $3,
            $4,
            $5,
            $6

          )

          RETURNING *

          `,

          [
  candidate_id,
  req_id,
  req.user.employee_code,
  stage_name || "Applied",
  source_type,
  remarks
]

        );

      res.status(201).json({

        success: true,

        message:
          "Candidate Mapped Successfully",

        data:
          result.rows[0]

      });

    }

    catch (error) {

      console.log(
        "❌ Map Existing Candidate Error"
      );

      console.log(error);

      res.status(500).json({

        success: false,

        message:
          "Error Mapping Candidate"

      });

    }

  }

);


// =====================================================
// DASHBOARD ENGINE
// =====================================================

async function getRecruiterDashboard(req, res) {
  return recruitmentLegacyReadHandlers.handleGetRecruiterDashboard(pool, req, res);
}


// =====================================================
// API 35 - Recruiter Dashboard
// =====================================================

app.get(

  "/recruiter-dashboard",

  verifyToken,

getRecruiterDashboard
);

// =====================================================
// API 36 - Remove Recruiter Assignment
// =====================================================

app.delete(

  "/remove-recruiter/:mapId",

  verifyToken,

  (req, res) => recruitmentLegacyHandlers.handleLegacyRemoveRecruiter(pool, req, res)

);

// =====================================================
// API 37 - My Candidates
// =====================================================

app.get(

  "/my-candidates",

  verifyToken,

  async (req, res) => {

    try {

      const recruiterCode =
        req.user.employee_code;

      const result =
        await pool.query(

          `

          SELECT

            crm.map_id,

            cm.candidate_id,

            cm.candidate_code,

            cm.first_name || ' ' ||
            cm.last_name
            AS candidate_name,

            rm.req_id,

            rm.req_code,

            rm.client_name,

            rm.job_title,

            crm.stage_name,

            cm.created_on
            AS applied_date

          FROM candidate_req_map crm

          INNER JOIN cand_mstr cm

          ON crm.candidate_id =
             cm.candidate_id

          INNER JOIN req_mstr rm

          ON crm.req_id =
             rm.req_id

          WHERE crm.recruiter_id = $1

          ORDER BY cm.created_on DESC

          `,

          [recruiterCode]

        );

      res.status(200).json({

        success: true,

        count: result.rows.length,

        data: result.rows

      });

    }

    catch (error) {

      console.log(
        "❌ My Candidates Error"
      );

      console.log(error);

      res.status(500).json({

        success: false,

        message:
          "Error Fetching Candidates"

      });

    }

  }

);

// =====================================================
// API 38 - Recruiter My Candidates List
// =====================================================

app.get(

  "/my-candidates-list",

  verifyToken,

  async (req, res) => {

    try {

      const result =
        await pool.query(

          `

          SELECT

            cm.candidate_id,
            cm.candidate_code,

            cm.first_name,
            cm.last_name,

            cm.email_id,
            cm.mobile_number,

            cm.primary_skill,
            cm.total_experience,

            crm.stage_name,
            crm.source_type,
            crm.applied_date,

            rm.req_code,
            rm.job_title

          FROM cand_mstr cm

          LEFT JOIN candidate_req_map crm

            ON cm.candidate_id =
               crm.candidate_id

            AND crm.is_active = true

          LEFT JOIN req_mstr rm

            ON crm.req_id =
               rm.req_id

          WHERE

            cm.candidate_container = 'PIPELINE'
            AND cm.owner_employee_code = $1

          ORDER BY

            crm.applied_date DESC NULLS LAST

          `,

          [

            req.user.employee_code

          ]

        );

      res.status(200).json({

        success: true,

        count:
          result.rows.length,

        data:
          result.rows

      });

    }

    catch (error) {

      console.log(
        "❌ My Candidates List Error"
      );

      console.log(error);

      res.status(500).json({

        success: false,

        message:
          "Error Fetching Candidates"

      });

    }

  }

);

// =====================================================
// API 39 - My Requisitions
// =====================================================

app.get(

  "/my-requisitions",

  verifyToken,

  (req, res) => recruitmentLegacyReadHandlers.handleGetMyOpenRequisitions(pool, req, res)

);

// =====================================================
// API 40 - Test Email
// =====================================================


app.get(

  "/test-email",

  async (req, res) => {

    try {

      await sendEmail(

        "raghavendra.karanik@igsglobal.com",

        "ATS Test Email",

        `
        <h2>ATS Email Service Working</h2>

        <p>
          Congratulations!
          Nodemailer has been configured successfully.
        </p>
        `

      );

      res.status(200).json({

        success: true,

        message:
          "Email Sent Successfully"

      });

    }

    catch (error) {

      console.log(error);

      res.status(500).json({

        success: false,

        message:
          "Email Sending Failed"

      });

    }

  }

);

// =====================================================
// API 41 - Add Interview Panel
// =====================================================

app.post(

  "/interview-panel",

  verifyToken,

  async (req, res) => {

    try {

      const {

        user_id,
        primary_skill,
        department,
        designation,
        interviewer_type

      } = req.body;

      // ==========================================
      // Validation
      // ==========================================

      if (
        !user_id ||
        !interviewer_type
      ) {

        return res.status(400).json({

          success: false,

          message:
            "User and Interviewer Type are mandatory"

        });

      }

      // ==========================================
      // Fetch User Details
      // ==========================================

      const userResult =
        await pool.query(

          `

          SELECT

            user_id,
            employee_code,
            full_name,
            email_id

          FROM user_mstr

          WHERE user_id = $1

          `,

          [user_id]

        );

      if (
        userResult.rows.length === 0
      ) {

        return res.status(404).json({

          success: false,

          message:
            "User not found"

        });

      }

      const user =
        userResult.rows[0];

      // ==========================================
      // Duplicate Check
      // ==========================================

      const duplicateCheck =
        await pool.query(

          `

          SELECT panel_id

          FROM interview_panel_mstr

          WHERE user_id = $1

          `,

          [user_id]

        );

      if (
        duplicateCheck.rows.length > 0
      ) {

        return res.status(400).json({

          success: false,

          message:
            "User already exists in Interview Panel"

        });

      }

      // ==========================================
      // Insert Interviewer
      // ==========================================

      const result =
        await pool.query(

          `

          INSERT INTO interview_panel_mstr (

            user_id,
            employee_code,
            interviewer_name,
            email_id,
            primary_skill,
            department,
            designation,
            interviewer_type

          )

          VALUES (

            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8

          )

          RETURNING *

          `,

          [

            user.user_id,
            user.employee_code,
            user.full_name,
            user.email_id,
            primary_skill,
            department,
            designation,
            interviewer_type

          ]

        );

      res.status(201).json({

        success: true,

        message:
          "Interviewer Added Successfully",

        data:
          result.rows[0]

      });

    }

    catch (error) {

      console.log(
        "❌ Add Interview Panel Error"
      );

      console.log(error);

      res.status(500).json({

        success: false,

        message:
          "Error Adding Interviewer"

      });

    }

  }

);
// =====================================================
// API 42 - Get Interview Panel List
// =====================================================

app.get(

  "/interview-panel",

  verifyToken,

  async (req, res) => {

    try {

      const result =
        await pool.query(

          `

          SELECT

            ip.panel_id,
            ip.user_id,

            u.employee_code,

            u.full_name
              AS interviewer_name,

            u.email_id,

            ip.primary_skill,
            ip.department,
            ip.designation,

            ip.interviewer_type,

            ip.is_active,

            ip.created_on,
            ip.updated_on

          FROM interview_panel_mstr ip

          INNER JOIN user_mstr u

            ON ip.user_id =
              u.user_id

          ORDER BY

            u.full_name

          `

        );

      res.status(200).json({

        success: true,

        count:
          result.rows.length,

        data:
          result.rows

      });

    }

    catch (error) {

      console.log(
        "❌ Interview Panel List Error"
      );

      console.log(error);

      res.status(500).json({

        success: false,

        message:
          "Error Fetching Interview Panel"

      });

    }

  }

);

// =====================================================
// API 42 - Update Interview Panel
// =====================================================

app.put(

  "/interview-panel/:id",

  verifyToken,

  async (req, res) => {

    try {

      const panelId =
        req.params.id;

      const {

        employee_code,
        interviewer_name,
        email_id,
        primary_skill,
        department,
        designation,
        is_active,
        interviewer_type      

      } = req.body;

      if (
  !employee_code ||
  !interviewer_name ||
  !interviewer_type
) {
  return res.status(400).json({
    success: false,
    message: "Mandatory fields missing"
  });
}
      const result =
        await pool.query(

          `

          UPDATE interview_panel_mstr

          SET

            employee_code = $1,
            interviewer_name = $2,
            email_id = $3,
            primary_skill = $4,
            department = $5,
            designation = $6,
            is_active = $7,
            interviewer_type = $8,
            updated_on = CURRENT_TIMESTAMP

          WHERE panel_id = $9

          RETURNING *

          `,

          [

            employee_code,
            interviewer_name,
            email_id,
            primary_skill,
            department,
            designation,
            is_active,
            interviewer_type,
            panelId

          ]

        );

      res.status(200).json({

        success: true,

        message:
          "Interviewer Updated Successfully",

        data:
          result.rows[0]

      });

    }

    catch (error) {

      console.log(
        "❌ Update Interview Panel Error"
      );

      console.log(error);

      res.status(500).json({

        success: false,

        message:
          "Error Updating Interviewer"

      });

    }

  }

);

// =====================================================
// API 44 - Active Interviewers
// Scheduling source remains interview_panel_mstr.panel_id.
// Eligibility requires active INTERVIEWER work assignment.
// =====================================================

app.get(

  "/active-interviewers",

  verifyToken,

  async (req, res) => {

    try {

      const result =
        await pool.query(

          `

         SELECT DISTINCT

          ip.panel_id,
          ip.user_id,

          u.employee_code,

          u.full_name
            AS interviewer_name,

          u.email_id,

          ip.primary_skill,
          ip.department,
          ip.designation,
          ip.interviewer_type

        FROM interview_panel_mstr ip

        INNER JOIN user_mstr u

          ON ip.user_id =
            u.user_id

        INNER JOIN employee_work_assignment ewa

          ON ewa.employee_code = u.employee_code

         AND ewa.is_active = true

        INNER JOIN work_assignment_mstr wa

          ON wa.work_assignment_id = ewa.work_assignment_id

         AND wa.is_active = true

         AND wa.assignment_code = 'INTERVIEWER'

        WHERE ip.is_active = true

        ORDER BY

          u.full_name

          `

        );

      res.status(200).json({

        success: true,

        count:
          result.rows.length,

        data:
          result.rows

      });

    }

    catch (error) {

      console.log(
        "❌ Active Interviewers Error"
      );

      console.log(error);

      res.status(500).json({

        success: false,

        message:
          "Error Fetching Active Interviewers"

      });

    }

  }

);

// =====================================================
// API 45 - Schedule Interview
// =====================================================

app.post(
  "/schedule-interview",
  verifyToken,
  (req, res) => interviewLegacyHandlers.handleScheduleInterview(pool, req, res, {
    createInterviewMeeting,
    sendInterviewEmail
  })
);

// =====================================================
// API 46 - Get Interview Schedules
// =====================================================

app.get(
  "/interview-schedules",
  verifyToken,
  (req, res) => interviewLegacyReadHandlers.handleGetInterviewSchedules(pool, req, res)
);

// =====================================================
// API 46A - Interview Candidates By Requisition
// Enterprise SoR (rm_candidate_mappings) + legacy dual-read.
// Recruiter match: employee_code, full_name, email, or owner.
// =====================================================

app.get(
  "/interview-candidates/:reqId",
  verifyToken,
  async (req, res) => {

    try {

      const employeeCode = req.user.employee_code;
      const emailId = req.user.email_id || null;
      const isAdmin = req.user.role_name === "Admin";
      const reqId = req.params.reqId;

      // JWT has no full_name; mapCandidate stores recruiter_id as full_name
      const nameLookup = await pool.query(
        `SELECT full_name
         FROM user_mstr
         WHERE employee_code = $1
         LIMIT 1`,
        [employeeCode]
      );
      const fullName = nameLookup.rows[0]?.full_name || null;

      const byMapId = new Map();

      const enterprise = await pool.query(
        `
        SELECT DISTINCT
          rcm.map_id,
          cm.candidate_id,
          cm.candidate_code,
          CONCAT(cm.first_name, ' ', cm.last_name) AS candidate_name
        FROM rm_candidate_mappings rcm
        INNER JOIN cand_mstr cm
          ON cm.candidate_id = rcm.candidate_id
        WHERE rcm.is_active = true
          AND rcm.req_id::text = $1::text
          AND rcm.map_id IS NOT NULL
          AND (
            $2::boolean = true
            OR rcm.recruiter_id = $3
            OR ($4::text IS NOT NULL AND rcm.recruiter_id = $4)
            OR ($5::text IS NOT NULL AND rcm.recruiter_id = $5)
            OR cm.owner_employee_code = $3
          )
        ORDER BY candidate_name
        `,
        [reqId, isAdmin, employeeCode, fullName, emailId]
      );

      for (const row of enterprise.rows) {
        byMapId.set(String(row.map_id), row);
      }

      const legacyTable = await pool.query(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'public'
             AND table_name = 'candidate_req_map'
         ) AS exists`
      );

      if (legacyTable.rows[0]?.exists) {
        const legacy = await pool.query(
          `
          SELECT DISTINCT
            crm.map_id,
            cm.candidate_id,
            cm.candidate_code,
            CONCAT(cm.first_name, ' ', cm.last_name) AS candidate_name
          FROM candidate_req_map crm
          INNER JOIN cand_mstr cm
            ON cm.candidate_id = crm.candidate_id
          WHERE crm.is_active = true
            AND crm.req_id::text = $1::text
            AND (
              $2::boolean = true
              OR crm.recruiter_id = $3
              OR ($4::text IS NOT NULL AND crm.recruiter_id = $4)
              OR ($5::text IS NOT NULL AND crm.recruiter_id = $5)
              OR cm.owner_employee_code = $3
            )
          ORDER BY candidate_name
          `,
          [reqId, isAdmin, employeeCode, fullName, emailId]
        );

        for (const row of legacy.rows) {
          if (!byMapId.has(String(row.map_id))) {
            byMapId.set(String(row.map_id), row);
          }
        }
      }

      res.status(200).json({
        success: true,
        data: Array.from(byMapId.values())
      });

    }

    catch (error) {

      console.error(
        "API 46A Error:",
        error
      );

      res.status(500).json({

        success: false,

        message:
          "Internal Server Error"

      });

    }

  }
);
// =====================================================
// API 46B - Interview Requisitions Dropdown
// Enterprise SoR (rm_requisitions + mappings) + legacy dual-read.
// =====================================================

app.get(
  "/interview-requisitions",
  verifyToken,
  async (req, res) => {

    try {

      const employeeCode = req.user.employee_code;
      const emailId = req.user.email_id || null;
      const isAdmin = req.user.role_name === "Admin";

      const nameLookup = await pool.query(
        `SELECT full_name
         FROM user_mstr
         WHERE employee_code = $1
         LIMIT 1`,
        [employeeCode]
      );
      const fullName = nameLookup.rows[0]?.full_name || null;

      const byReqId = new Map();

      const enterprise = await pool.query(
        `
        SELECT DISTINCT
          rr.req_id,
          rr.requisition_code AS req_code,
          rr.position_title AS job_title
        FROM rm_requisitions rr
        INNER JOIN rm_candidate_mappings rcm
          ON rcm.requisition_code = rr.requisition_code
         AND rcm.is_active = true
        LEFT JOIN cand_mstr cm
          ON cm.candidate_id = rcm.candidate_id
        WHERE rr.req_id IS NOT NULL
          AND (
            $1::boolean = true
            OR rcm.recruiter_id = $2
            OR ($3::text IS NOT NULL AND rcm.recruiter_id = $3)
            OR ($4::text IS NOT NULL AND rcm.recruiter_id = $4)
            OR cm.owner_employee_code = $2
          )
        ORDER BY rr.requisition_code
        `,
        [isAdmin, employeeCode, fullName, emailId]
      );

      for (const row of enterprise.rows) {
        byReqId.set(String(row.req_id), row);
      }

      const legacyTable = await pool.query(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'public'
             AND table_name = 'candidate_req_map'
         ) AS exists`
      );

      if (legacyTable.rows[0]?.exists) {
        const legacy = await pool.query(
          `
          SELECT DISTINCT
            rm.req_id,
            rm.req_code,
            rm.job_title
          FROM req_mstr rm
          INNER JOIN candidate_req_map crm
            ON crm.req_id = rm.req_id
          LEFT JOIN cand_mstr cm
            ON cm.candidate_id = crm.candidate_id
          WHERE crm.is_active = true
            AND (
              $1::boolean = true
              OR crm.recruiter_id = $2
              OR ($3::text IS NOT NULL AND crm.recruiter_id = $3)
              OR ($4::text IS NOT NULL AND crm.recruiter_id = $4)
              OR cm.owner_employee_code = $2
            )
          ORDER BY rm.req_code
          `,
          [isAdmin, employeeCode, fullName, emailId]
        );

        for (const row of legacy.rows) {
          if (!byReqId.has(String(row.req_id))) {
            byReqId.set(String(row.req_id), row);
          }
        }
      }

      res.status(200).json({
        success: true,
        data: Array.from(byReqId.values())
      });

    }

    catch (error) {

      console.error(
        "API 46B Error:",
        error
      );

      res.status(500).json({

        success: false,

        message:
          "Internal Server Error"

      });

    }

  }
);

// =====================================================
// TEST GRAPH AUTH
// =====================================================

app.get(
  "/test-graph",
  async (req, res) => {

    try {

      const token =
        await getGraphToken();

      res.status(200).json({

        success: true,

        token_received:
          !!token,

        token_preview:
          token.substring(0, 50)

      });

    }

    catch (error) {

      console.error(error);

      res.status(500).json({

        success: false,

        message:
          error.message

      });

    }

  }
);


// =====================================================
// Create Teams Meeting
// =====================================================

async function createTeamsMeeting() {

  try {

    const token =
      await getGraphToken();

    const response =
      await axios.post(

        `https://graph.microsoft.com/v1.0/users/${process.env.TEAMS_ORGANIZER_EMAIL}/onlineMeetings`,

        {

          startDateTime:
            "2026-06-12T10:00:00Z",

          endDateTime:
            "2026-06-12T11:00:00Z",

          subject:
            "ATS Test Interview"

        },

        {

          headers: {

            Authorization:
              `Bearer ${token}`,

            "Content-Type":
              "application/json"

          }

        }

      );

    return response.data;

  }

  catch (error) {

    console.log(
  "===================="
);

console.log(
  "GRAPH FULL ERROR"
);

console.log(
  JSON.stringify(
    error.response?.data,
    null,
    2
  )
);

console.log(
  error.message
);

console.log(
  "===================="
);

    throw error;

  }

}

// =====================================================
// TEST TEAMS MEETING
// =====================================================

app.get(
  "/test-teams",
  async (req, res) => {

    try {

      const meeting =
        await createTeamsMeeting();

      res.status(200).json({

        success: true,

        meeting

      });

    }

    catch (error) {

      res.status(500).json({

        success: false,

        merror:
        error?.response?.data,

        message:
        error.message

      });

    }

  }
);

// =====================================================
// TEST GRAPH USER
// =====================================================

app.get(
  "/test-user",
  async (req, res) => {

    try {

      const token =
        await getGraphToken();

      const response =
        await axios.get(

          `https://graph.microsoft.com/v1.0/users/${process.env.TEAMS_ORGANIZER_EMAIL}`,

          {
            headers: {
              Authorization:
                `Bearer ${token}`
            }
          }

        );

      res.status(200).json({

        success: true,

        data: response.data

      });

    }

    catch (error) {

      console.log(
        JSON.stringify(
          error.response?.data,
          null,
          2
        )
      );

      res.status(500).json({

        success: false,

        error:
          error.response?.data,

        message:
          error.message

      });

    }

  }
);

app.get(
  "/test-mailbox",
  async (req, res) => {

    try {

      const token =
        await getGraphToken();

      const response =
        await axios.get(

          `https://graph.microsoft.com/v1.0/users/${process.env.TEAMS_ORGANIZER_EMAIL}/calendar`,

          {
            headers: {
              Authorization:
                `Bearer ${token}`
            }
          }

        );

      res.json(response.data);

    }

    catch (error) {

      console.log(
        JSON.stringify(
          error.response?.data,
          null,
          2
        )
      );

      res.status(500).json({

        error:
          error.response?.data,

        message:
          error.message

      });

    }

  }
);

app.get(
  "/test-calendar-event",
  async (req, res) => {

    try {

      const token =
        await getGraphToken();

      const response =
        await axios.post(

        `https://graph.microsoft.com/v1.0/users/${process.env.TEAMS_ORGANIZER_EMAIL}/events`,

        {

          subject:
            "ATS Test Interview",

          start: {

            dateTime:
              "2026-06-15T10:00:00",

            timeZone:
              "India Standard Time"

          },

          end: {

            dateTime:
              "2026-06-15T11:00:00",

            timeZone:
              "India Standard Time"

          },

          isOnlineMeeting: true,

          onlineMeetingProvider:
            "teamsForBusiness"

        },

        {

          headers: {

            Authorization:
              `Bearer ${token}`,

            "Content-Type":
              "application/json"

          }

        }

      );

      res.json({

        success: true,

        joinUrl:

          response.data
          .onlineMeeting
          ?.joinUrl,

        data:
          response.data

      });

    }

    catch (error) {

      console.log(
        JSON.stringify(
          error.response?.data,
          null,
          2
        )
      );

      res.status(500).json({

        success: false,

        error:
          error.response?.data,

        message:
          error.message

      });

    }

  }
);

// =====================================================
// API 47 - My Interview
// =====================================================


app.get(
  "/my-interviews",
  verifyToken,
  async (req, res) => {

    try {

      const panelResult =
        await pool.query(
          `
          SELECT panel_id
          FROM interview_panel_mstr
          WHERE employee_code = $1
            AND is_active = true
          `,
          [
            req.user.employee_code
          ]
        );

      if (
        panelResult.rows.length === 0
      ) {

        return res.status(404).json({

          success: false,

          message:
            "Interviewer profile not found"

        });

      }

      const panelId =
        panelResult.rows[0].panel_id;

      // Dual-read: enterprise mappings (rm_*) preferred, legacy candidate_req_map fallback.
      // INNER JOIN on legacy map alone hid enterprise-scheduled interviews.
      const result =
        await pool.query(

          `
          SELECT

            s.schedule_id,

            s.round_type,
            s.interview_date,
            s.interview_time,
            COALESCE(i.interview_status, s.interview_status) AS interview_status,
            COALESCE(i.feedback_submitted, s.feedback_submitted, false) AS feedback_submitted,
            COALESCE(i.final_outcome, fh.final_outcome) AS final_outcome,
            COALESCE(i.meeting_link, s.meeting_link) AS meeting_link,

            COALESCE(rcm.map_id, crm.map_id) AS map_id,
            COALESCE(rcm.stage_name, crm.stage_name) AS stage_name,

            c.candidate_id,
            c.candidate_code,

            CONCAT(
              c.first_name,
              ' ',
              c.last_name
            ) AS candidate_name,

            c.email_id,
            c.resume_path,

            COALESCE(rr_by_id.req_id, rr_by_code.req_id, r.req_id, s.req_id) AS req_id,
            COALESCE(rr_by_id.requisition_code, rr_by_code.requisition_code, r.req_code) AS req_code,
            COALESCE(r.client_name, rr_by_id.department, rr_by_code.department) AS client_name,
            COALESCE(rr_by_id.position_title, rr_by_code.position_title, r.job_title) AS job_title,

            COALESCE(rr_by_id.primary_skill, rr_by_code.primary_skill, r.primary_skill, c.primary_skill) AS primary_skill,
            COALESCE(r.secondary_skill, c.secondary_skill) AS secondary_skill,

            r.experience_min,
            r.experience_max,

            ip.interviewer_name

          FROM interview_schedule_trn s

          LEFT JOIN im_interviews i
            ON i.schedule_id = s.schedule_id

          LEFT JOIN rm_candidate_mappings rcm
            ON rcm.map_id = s.map_id
           AND rcm.is_active = true

          LEFT JOIN candidate_req_map crm
            ON crm.map_id = s.map_id

          INNER JOIN cand_mstr c
            ON c.candidate_id =
               COALESCE(rcm.candidate_id, crm.candidate_id)

          LEFT JOIN rm_requisitions rr_by_id
            ON rr_by_id.req_id = COALESCE(i.req_id, rcm.req_id, s.req_id)

          LEFT JOIN rm_requisitions rr_by_code
            ON rr_by_code.requisition_code =
               COALESCE(i.requisition_code, rcm.requisition_code)

          LEFT JOIN req_mstr r
            ON r.req_id = COALESCE(crm.req_id, s.req_id)

          INNER JOIN interview_panel_mstr ip
            ON ip.panel_id =
               s.interviewer_id

          LEFT JOIN interview_feedback_hdr fh
          ON fh.schedule_id = s.schedule_id

          WHERE
            s.interviewer_id = $1

          ORDER BY

            s.interview_date DESC,

            s.interview_time DESC
          `,

          [panelId]

        
        );

      res.status(200).json({

        success: true,

        count:
          result.rows.length,

        data:
          result.rows

      });

    }

    catch (error) {

      console.error(
        "API 47 Error:",
        error
      );

      res.status(500).json({

        success: false,

        message:
          "Internal Server Error"

      });

    }

  }
);

// =====================================================
// API 48 - Interviewer Dropdown
// Eligibility from active INTERVIEWER work assignment
// (not role_name / secondary_role).
// =====================================================

app.get(
  "/interviewer-dropdown",
  verifyToken,
  async (req, res) => {

    try {

      const result =
        await pool.query(

          `
          SELECT DISTINCT

            u.user_id,
            u.employee_code,
            u.full_name,
            u.email_id,
            u.department,
            u.designation,
            u.primary_skill

          FROM user_mstr u

          INNER JOIN employee_work_assignment ewa

            ON ewa.employee_code = u.employee_code

           AND ewa.is_active = true

          INNER JOIN work_assignment_mstr wa

            ON wa.work_assignment_id = ewa.work_assignment_id

           AND wa.is_active = true

           AND wa.assignment_code = 'INTERVIEWER'

          ORDER BY u.full_name
          `

        );

      res.status(200).json({

        success: true,

        count:
          result.rows.length,

        data:
          result.rows

      });

    }

    catch (error) {

      console.error(
        "API 48 Error:",
        error
      );

      res.status(500).json({

        success: false,

        message:
          "Internal Server Error"

      });

    }

  }
);


// =====================================================
// API 49 - My Interviews
// =====================================================

app.get(

  "/my-interviews",

  verifyToken,

  async (req, res) => {

    try {

      const userId =
        req.user.user_id;

      const result =
        await pool.query(

          `

          SELECT

            s.schedule_id,

            c.candidate_id,

            c.candidate_code,

            c.first_name,
            c.last_name,

            r.req_id,
            r.position_title,

            s.round_type,
            s.interview_date,
            s.interview_time,

            s.interview_status,

            ip.panel_id,
            ip.interviewer_name

          FROM interview_schedule_trn s

          INNER JOIN interview_panel_mstr ip
            ON s.interviewer_id = ip.panel_id

          INNER JOIN candidate_req_map crm
            ON s.map_id = crm.map_id

          INNER JOIN cand_mstr c
            ON crm.candidate_id = c.candidate_id

          INNER JOIN requisition_mstr r
            ON crm.req_id = r.req_id

          WHERE ip.user_id = $1

          ORDER BY
            s.interview_date,
            s.interview_time

          `,

          [userId]

        );

      res.status(200).json({

        success: true,

        count:
          result.rows.length,

        data:
          result.rows

      });

    }

    catch (error) {

      console.log(
        "❌ API 49 Error"
      );

      console.log(error);

      res.status(500).json({

        success: false,

        message:
          "Error Fetching Interviews"

      });

    }

  }

);

// =====================================================
// API 50 - Feedback Details
// =====================================================

app.get(

  "/feedback-details/:scheduleId",

  verifyToken,

  async (req, res) => {

    try {

      const scheduleId =
        req.params.scheduleId;

      // Dual-read: enterprise mapping preferred; legacy map fallback (same SoR gap as /my-interviews).
      const result =
        await pool.query(

          `

          SELECT

            ist.schedule_id,

            ist.round_type
              AS interview_level,

            cm.candidate_code,

            CONCAT(
              cm.first_name,
              ' ',
              cm.last_name
            ) AS candidate_name,

            COALESCE(rr_by_id.req_id, rr_by_code.req_id, rm.req_id, ist.req_id) AS req_id,

            COALESCE(rr_by_id.requisition_code, rr_by_code.requisition_code, rm.req_code) AS req_code,

            COALESCE(rm.client_name, rr_by_id.department, rr_by_code.department) AS client_name,

            COALESCE(rr_by_id.position_title, rr_by_code.position_title, rm.job_title) AS job_title,

            ip.interviewer_name,

            ip.employee_code
              AS interviewer_code

          FROM interview_schedule_trn ist

          LEFT JOIN im_interviews i
            ON i.schedule_id = ist.schedule_id

          LEFT JOIN rm_candidate_mappings rcm
            ON rcm.map_id = ist.map_id
           AND rcm.is_active = true

          LEFT JOIN candidate_req_map crm
            ON crm.map_id = ist.map_id

          INNER JOIN cand_mstr cm
            ON cm.candidate_id =
               COALESCE(rcm.candidate_id, crm.candidate_id)

          LEFT JOIN rm_requisitions rr_by_id
            ON rr_by_id.req_id = COALESCE(i.req_id, rcm.req_id, ist.req_id)

          LEFT JOIN rm_requisitions rr_by_code
            ON rr_by_code.requisition_code =
               COALESCE(i.requisition_code, rcm.requisition_code)

          LEFT JOIN req_mstr rm
            ON rm.req_id = COALESCE(crm.req_id, ist.req_id)

          INNER JOIN interview_panel_mstr ip
            ON ip.panel_id =
               ist.interviewer_id

          WHERE
            ist.schedule_id = $1

          `,

          [scheduleId]

        );

      if (
        result.rows.length === 0
      ) {

        return res.status(404).json({

          success: false,

          message:
            "Interview Schedule Not Found"

        });

      }

      res.status(200).json({

        success: true,

        data:
          result.rows[0]

      });

    }

    catch (error) {

      console.log(
        "❌ Feedback Details Error"
      );

      console.log(error);

      res.status(500).json({

        success: false,

        message:
          "Error Fetching Feedback Details"

      });

    }

  }

);

// =====================================================
// API 51 - Submit Interview Feedback
// =====================================================

app.post(
  "/submit-feedback",
  verifyToken,
  (req, res) => interviewLegacyHandlers.handleSubmitFeedback(pool, req, res)
);

// =====================================================
// API 52 - Get Feedback By Schedule
// =====================================================

app.get(
  "/feedback/:scheduleId",
  verifyToken,
  (req, res) => interviewLegacyHandlers.handleGetFeedback(pool, req, res)
);

// =====================================================
// Send Password Reset Email
// =====================================================

async function sendPasswordResetEmail(

  userEmail,
  userName,
  resetLink

) {

  try {

    const token =
      await getGraphToken();

    await axios.post(

      `https://graph.microsoft.com/v1.0/users/${process.env.EMAIL_USER}/sendMail`,

      {

        message: {

          subject:
            "Action Required: Reset Your OPTALYNX Password",

          body: {

            contentType: "HTML",

            content: `

              <p>Hello ${userName},</p>

              <p>
                A password reset request
                was received for your OPTALYNX account.
              </p>

              <p>
                Click the link below to reset your password:
              </p>

              <p>
                <a href="${resetLink}">
                  Reset Password
                </a>
              </p>

              <p>
                This link will expire in
                30 minutes.
              </p>

              <p>
                If you did not request
                this change, please ignore
                this email.
              </p>

              <br/>

              <p>
                Regards,<br/>
                OPTALYNX Administration Team
              </p>

            `

          },

          toRecipients: [

            {

              emailAddress: {

                address:
                  userEmail

              }

            }

          ]

        },

        saveToSentItems: true

      },

      {

        headers: {

          Authorization:
            `Bearer ${token}`,

          "Content-Type":
            "application/json"

        }

      }

    );

    console.log(
      `Password reset email sent to ${userEmail}`
    );

  }

  catch (error) {

    console.log(
      "Password Reset Email Error"
    );

    console.log(

      error?.response?.data ||

      error.message

    );

    throw error;

  }

}

// =====================================================
// API 53 - Forgot Password
// =====================================================

app.post(

  "/forgot-password",

  async (req, res) => {

    try {

      const { email_id } =
        req.body;

      const userResult =
        await pool.query(

          `

          SELECT

            user_id,
            full_name,
            email_id

          FROM user_mstr

          WHERE LOWER(email_id) =
                LOWER($1)

          `,

          [email_id]

        );

      if (
        userResult.rows.length > 0
      ) {

        const user =
          userResult.rows[0];

          await pool.query(

  `

  UPDATE
    password_reset_tokens

  SET
    is_used = true

  WHERE
    user_id = $1

  AND
    is_used = false

  `,

  [

    user.user_id

  ]

);

        const resetToken =

          crypto
            .randomBytes(32)
            .toString("hex");

        const expiresOn =

          new Date(

            Date.now() +

            30 * 60 * 1000

          );

        await pool.query(

          `

          INSERT INTO
          password_reset_tokens

          (

            user_id,
            reset_token,
            expires_on

          )

          VALUES

          (

            $1,
            $2,
            $3

          )

          `,

          [

            user.user_id,

            resetToken,

            expiresOn

          ]

        );

        const frontendBase = (
          process.env.FRONTEND_URL || "http://localhost:5173"
        ).replace(/\/$/, "");

        const resetLink =

          `${frontendBase}/reset-password/${resetToken}`;

        await sendPasswordResetEmail(

          user.email_id,

          user.full_name,

          resetLink

        );

      }

      res.status(200).json({

        success: true,

        message:

          "If the email is registered, a reset link has been sent."

      });

    }

    catch (error) {

      console.log(
        "❌ Forgot Password Error"
      );

      console.log(error);

      res.status(500).json({

        success: false,

        message:
          "Error Processing Request"

      });

    }

  }

);


// =====================================================
// API 54 - Reset Password
// =====================================================

app.post(

  "/reset-password",

  async (req, res) => {

    try {

      const {

        token,
        new_password

      } = req.body;

      const tokenResult =
        await pool.query(

          `

          SELECT

            prt.*,
            um.user_id

          FROM password_reset_tokens prt

          INNER JOIN user_mstr um

            ON um.user_id =
               prt.user_id

          WHERE

            prt.reset_token = $1

            AND prt.is_used = false

            AND prt.expires_on > NOW()

          `,

          [token]

        );

      if (
        tokenResult.rows.length === 0
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Invalid or Expired Token"

        });

      }

      const tokenData =
        tokenResult.rows[0];

      // ==========================
// Password Validation
// ==========================

const passwordRegex =

  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;

if (

  !passwordRegex.test(
    new_password
  )

) {

  return res.status(400).json({

    success: false,

    message:
      "Password does not meet security requirements"

  });

}


      const passwordHash =

        await bcrypt.hash(

          new_password,

          10

        );

      await pool.query(

        `

        UPDATE user_mstr

        SET

          password_hash = $1,
          updated_on = CURRENT_TIMESTAMP

        WHERE user_id = $2

        `,

        [

          passwordHash,
          tokenData.user_id

        ]

      );

      await pool.query(

        `

        UPDATE password_reset_tokens

        SET

          is_used = true

        WHERE token_id = $1

        `,

        [

          tokenData.token_id

        ]

      );

      res.status(200).json({

        success: true,

        message:
          "Password Updated Successfully"

      });

    }

    catch (error) {

      console.log(
        "❌ Reset Password Error"
      );

      console.log(error);

      res.status(500).json({

        success: false,

        message:
          "Error Resetting Password"

      });

    }

  }

);

// =====================================================
// API 55 - Available Candidates (Talent Pool)
// =====================================================

app.get(

  "/available-candidates",

  verifyToken,

  async (req, res) => {

    try {

      const result = await pool.query(

        `

        SELECT

          'AVAILABLE' AS candidate_type,

          cm.candidate_id,
          cm.candidate_code,

          cm.first_name,
          cm.middle_name,
          cm.last_name,
          cm.preferred_name,

          cm.email_id,
          cm.mobile_number,

          cm.primary_skill,
          cm.total_experience,

          cm.current_company,
          cm.current_location,

          cm.candidate_status,

          cm.created_on

        FROM cand_mstr cm

        WHERE cm.candidate_container = 'TALENT_POOL'

        ORDER BY

          cm.created_on DESC

        `

      );

      res.status(200).json({

        success: true,

        count: result.rows.length,

        data: result.rows

      });

    }

    catch (error) {

      console.log("❌ Available Candidates Error");

      console.log(error);

      res.status(500).json({

        success: false,

        message: "Error Fetching Available Candidates"

      });

    }

  }

);
// =====================================================
// API 56-Enterprise Master Data API (PostgreSQL-backed)
// =====================================================

const { registerMasterDataRoutes } = require("./routes/masterDataRoutes");
const { registerPlatformConfigRoutes } = require("./routes/platformConfigRoutes");
const { registerBusinessRulesRoutes } = require("./routes/businessRulesRoutes");
const { registerWorkflowRoutes } = require("./routes/workflowRoutes");
const { registerWorkforcePlanningRoutes } = require("./routes/workforcePlanningRoutes");
const { registerRecruitmentRoutes } = require("./routes/recruitmentRoutes");
const { registerTaskRoutes } = require("./routes/taskRoutes");
const { registerInterviewRoutes } = require("./routes/interviewRoutes");
const { registerOfferRoutes } = require("./routes/offerRoutes");
const { registerUserPermissionRoutes } = require("./routes/userPermissionRoutes");
const {
  registerTalentDemandDraftRoutes
} = require("./routes/talentDemandDraftRoutes");
const {
  registerWorkAssignmentRoutes
} = require("./routes/workAssignmentRoutes");

registerMasterDataRoutes(app, pool, verifyToken, verifyAdmin);
registerPlatformConfigRoutes(app, pool, verifyToken, verifyAdmin);
registerBusinessRulesRoutes(app, pool, verifyToken, verifyAdmin);
registerWorkflowRoutes(app, pool, verifyToken, verifyAdmin);
registerWorkforcePlanningRoutes(app, pool, verifyToken, verifyAdmin);
registerRecruitmentRoutes(app, pool, verifyToken, verifyAdmin);
registerTaskRoutes(app, pool, verifyToken);
registerInterviewRoutes(app, pool, verifyToken);
registerOfferRoutes(app, pool, verifyToken);
registerUserPermissionRoutes(app, pool, verifyToken, verifyAdmin);
registerTalentDemandDraftRoutes(app, pool, verifyToken);
registerWorkAssignmentRoutes(app, pool, verifyToken, verifyAdmin);

// =====================================================
// Approval Route Management APIs
// =====================================================

app.get("/approval-routes", verifyToken, async (req, res) => {
  try {
    const appliesTo = req.query?.applies_to
      ? String(req.query.applies_to).trim()
      : null;
    const data = await approvalRouteRepository.getApprovalRoutes(pool, appliesTo);

    res.status(200).json({
      success: true,
      data
    });
  } catch (error) {
    console.log("❌ Get Approval Routes Error");
    console.log(error);

    res.status(500).json({
      success: false,
      message: error.message || "Error fetching approval routes."
    });
  }
});

app.get("/approval-routes/:routeId", verifyToken, async (req, res) => {
  try {
    const routeId = req.params.routeId;
    const route = await approvalRouteRepository.getApprovalRoute(pool, routeId);

    if (!route) {
      return res.status(404).json({
        success: false,
        message: "Approval route not found."
      });
    }

    const steps = await approvalRouteRepository.getApprovalRouteSteps(
      pool,
      routeId
    );

    res.status(200).json({
      success: true,
      data: {
        route,
        steps
      }
    });
  } catch (error) {
    console.log("❌ Get Approval Route Error");
    console.log(error);

    res.status(500).json({
      success: false,
      message: error.message || "Error fetching approval route."
    });
  }
});

app.post("/approval-routes", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const routePayload = req.body?.route || req.body;
    const steps = Array.isArray(req.body?.steps) ? req.body.steps : [];

    if (!routePayload || !routePayload.route_name) {
      return res.status(400).json({
        success: false,
        message: "route.route_name is required."
      });
    }

    const appliesTo = routePayload.applies_to || "Requisition";
    const duplicateResult = await pool.query(
      `SELECT route_id
       FROM approval_route_mstr
       WHERE LOWER(TRIM(route_name)) = LOWER(TRIM($1))
         AND LOWER(TRIM(applies_to)) = LOWER(TRIM($2))
       LIMIT 1`,
      [routePayload.route_name, appliesTo]
    );

    if (duplicateResult.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message:
          "An Approval Route with this name already exists for the selected Applies To."
      });
    }

    const routeData = {
      ...routePayload,
      created_by:
        routePayload.created_by ||
        req.user?.employee_code ||
        req.user?.email_id ||
        null
    };

    const routeId = await approvalRouteRepository.createApprovalRoute(
      pool,
      routeData
    );

    if (steps.length > 0) {
      await approvalRouteRepository.replaceApprovalRouteSteps(
        pool,
        routeId,
        steps
      );
    }

    res.status(201).json({
      success: true,
      data: {
        route_id: routeId
      }
    });
  } catch (error) {
    console.log("❌ Create Approval Route Error");
    console.log(error);

    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message:
          "An Approval Route with this name already exists for the selected Applies To."
      });
    }

    res.status(500).json({
      success: false,
      message: error.message || "Error creating approval route."
    });
  }
});

app.put("/approval-routes/:routeId", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const routeId = req.params.routeId;
    const routePayload = req.body?.route || {};
    const steps = Array.isArray(req.body?.steps) ? req.body.steps : [];

    const existing = await approvalRouteRepository.getApprovalRoute(
      pool,
      routeId
    );

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Approval route not found."
      });
    }

    const routeName =
      routePayload.route_name != null
        ? routePayload.route_name
        : existing.route_name;
    const appliesTo =
      routePayload.applies_to != null
        ? routePayload.applies_to
        : existing.applies_to;

    const duplicateResult = await pool.query(
      `SELECT route_id
       FROM approval_route_mstr
       WHERE LOWER(TRIM(route_name)) = LOWER(TRIM($1))
         AND LOWER(TRIM(applies_to)) = LOWER(TRIM($2))
         AND route_id <> $3::bigint
       LIMIT 1`,
      [routeName, appliesTo, routeId]
    );

    if (duplicateResult.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message:
          "An Approval Route with this name already exists for the selected Applies To."
      });
    }

    const routeData = {
      ...routePayload,
      updated_by:
        routePayload.updated_by ||
        req.user?.employee_code ||
        req.user?.email_id ||
        null
    };

    const route = await approvalRouteRepository.updateApprovalRoute(
      pool,
      routeId,
      routeData
    );

    const replacedSteps =
      await approvalRouteRepository.replaceApprovalRouteSteps(
        pool,
        routeId,
        steps
      );

    res.status(200).json({
      success: true,
      data: {
        route,
        steps: replacedSteps
      }
    });
  } catch (error) {
    console.log("❌ Update Approval Route Error");
    console.log(error);

    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message:
          "An Approval Route with this name already exists for the selected Applies To."
      });
    }

    res.status(500).json({
      success: false,
      message: error.message || "Error updating approval route."
    });
  }
});

// =====================================================
// Approval Route Policy Management APIs
// =====================================================

app.get("/approval-route-policies", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const data = await approvalRouteRepository.getApprovalRoutePolicies(pool);

    res.status(200).json({
      success: true,
      message: "Approval route policies fetched successfully.",
      data
    });
  } catch (error) {
    console.log("❌ Get Approval Route Policies Error");
    console.log(error);

    res.status(500).json({
      success: false,
      message: error.message || "Error fetching approval route policies."
    });
  }
});

app.get(
  "/approval-route-policies/:policyId",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const policy = await approvalRouteRepository.getApprovalRoutePolicy(
        pool,
        req.params.policyId
      );

      if (!policy) {
        return res.status(404).json({
          success: false,
          message: "Approval route policy not found."
        });
      }

      res.status(200).json({
        success: true,
        message: "Approval route policy fetched successfully.",
        data: policy
      });
    } catch (error) {
      console.log("❌ Get Approval Route Policy Error");
      console.log(error);

      res.status(500).json({
        success: false,
        message: error.message || "Error fetching approval route policy."
      });
    }
  }
);

app.post("/approval-route-policies", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const policyPayload = req.body?.policy || req.body;

    const policy = await approvalRouteRepository.createApprovalRoutePolicy(
      pool,
      {
        ...policyPayload,
        created_by:
          policyPayload.created_by
          || req.user?.employee_code
          || req.user?.email_id
          || null
      }
    );

    res.status(201).json({
      success: true,
      message: "Approval route policy created successfully.",
      data: policy
    });
  } catch (error) {
    console.log("❌ Create Approval Route Policy Error");
    console.log(error);

    const status = error.status || 500;
    res.status(status).json({
      success: false,
      message: error.message || "Error creating approval route policy."
    });
  }
});

app.put(
  "/approval-route-policies/:policyId",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const policyPayload = req.body?.policy || req.body;

      const policy = await approvalRouteRepository.updateApprovalRoutePolicy(
        pool,
        req.params.policyId,
        {
          ...policyPayload,
          updated_by:
            policyPayload.updated_by
            || req.user?.employee_code
            || req.user?.email_id
            || null
        }
      );

      if (!policy) {
        return res.status(404).json({
          success: false,
          message: "Approval route policy not found."
        });
      }

      res.status(200).json({
        success: true,
        message: "Approval route policy updated successfully.",
        data: policy
      });
    } catch (error) {
      console.log("❌ Update Approval Route Policy Error");
      console.log(error);

      const status = error.status || 500;
      res.status(status).json({
        success: false,
        message: error.message || "Error updating approval route policy."
      });
    }
  }
);

app.post(
  "/approval-route-policies/:policyId/activate",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const policy = await approvalRouteRepository.setApprovalRoutePolicyActive(
        pool,
        req.params.policyId,
        true,
        req.user?.employee_code || req.user?.email_id || null
      );

      if (!policy) {
        return res.status(404).json({
          success: false,
          message: "Approval route policy not found."
        });
      }

      res.status(200).json({
        success: true,
        message: "Approval route policy activated successfully.",
        data: policy
      });
    } catch (error) {
      console.log("❌ Activate Approval Route Policy Error");
      console.log(error);

      res.status(500).json({
        success: false,
        message: error.message || "Error activating approval route policy."
      });
    }
  }
);

app.post(
  "/approval-route-policies/:policyId/deactivate",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const policy = await approvalRouteRepository.setApprovalRoutePolicyActive(
        pool,
        req.params.policyId,
        false,
        req.user?.employee_code || req.user?.email_id || null
      );

      if (!policy) {
        return res.status(404).json({
          success: false,
          message: "Approval route policy not found."
        });
      }

      res.status(200).json({
        success: true,
        message: "Approval route policy deactivated successfully.",
        data: policy
      });
    } catch (error) {
      console.log("❌ Deactivate Approval Route Policy Error");
      console.log(error);

      res.status(500).json({
        success: false,
        message: error.message || "Error deactivating approval route policy."
      });
    }
  }
);

app.get("/health-test", (req, res) => {
  res.json({
    success: true,
    message: "THIS IS INDEX.JS",
    time: new Date()
  });
});

// =====================================================
// API 57 - Request Candidate Ownership
// =====================================================

app.post(
  "/request-candidate-ownership",
  verifyToken,
  async (req, res) => {

    try {

      const { candidate_id, reason } = req.body;

      const to_recruiter_id = req.user.employee_code;

      // -------------------------------------------------
      // Get Current Candidate Owner
      // -------------------------------------------------

      const ownerResult = await pool.query(
        `
        SELECT recruiter_id
        FROM cand_mstr
        WHERE candidate_id = $1
        `,
        [candidate_id]
      );

      if (ownerResult.rows.length === 0) {

        return res.status(404).json({

          success: false,
          message: "Candidate not found."

        });

      }

      const from_recruiter_id =
        ownerResult.rows[0].recruiter_id;

      // -------------------------------------------------
      // Prevent requesting own candidate
      // -------------------------------------------------

      if (from_recruiter_id === to_recruiter_id) {

        return res.status(400).json({

          success: false,
          message:
            "You already own this candidate."

        });

      }

      // -------------------------------------------------
      // Prevent Duplicate Pending Request
      // -------------------------------------------------

      const pendingRequest =
  await pool.query(

    `
    SELECT
      request_id,
      to_recruiter_id

    FROM rm_candidate_transfer_requests

    WHERE
      candidate_id = $1
      AND status = 'Pending'
    `,

    [

      candidate_id

    ]

  );

if (pendingRequest.rows.length > 0) {

  return res.status(400).json({

    success: false,

    message:
      "An ownership request for this candidate is already pending."

  });

}
      // -------------------------------------------------
      // Create Request
      // -------------------------------------------------

      await pool.query(

        `
        INSERT INTO
        rm_candidate_transfer_requests
        (

          candidate_id,

          from_recruiter_id,

          to_recruiter_id,

          reason,

          status,

          requested_on

        )

        VALUES

        (

          $1,

          $2,

          $3,

          $4,

          'Pending',

          NOW()

        )
        `,

        [

          candidate_id,

          from_recruiter_id,

          to_recruiter_id,

          reason

        ]

      );

      res.status(200).json({

        success: true,

        message:
          "Ownership request submitted successfully."

      });

    }

    catch (error) {

      console.log(
        "❌ Request Candidate Ownership Error"
      );

      console.log(error);

      res.status(500).json({

        success: false,

        message:
          "Error requesting candidate ownership."

      });

    }

  }

);

// =====================================================
// API 58 - Get My Pending Ownership Requests
// =====================================================

app.get(

  "/my-ownership-requests",

  verifyToken,

  async (req, res) => {

    try {

      const recruiterId = req.user.employee_code;

      const result = await pool.query(

        `

    SELECT

    r.request_id,

    r.candidate_id,

    c.candidate_code,

    c.first_name,

    c.last_name,

    c.primary_skill,

    c.total_experience,

    c.current_location,

    r.from_recruiter_id,

    owner.full_name AS owner_name,

    CONCAT(
        owner.full_name,
        ' (',
        owner.employee_code,
        ')'
    ) AS owner_display_name,

    r.to_recruiter_id,

    requester.full_name AS requester_name,

    CONCAT(
        requester.full_name,
        ' (',
        requester.employee_code,
        ')'
    ) AS requester_display_name,

    r.reason,

    r.status,

    r.requested_on

        FROM rm_candidate_transfer_requests r

        INNER JOIN cand_mstr c
        ON c.candidate_id = r.candidate_id

        LEFT JOIN user_mstr owner
        ON owner.employee_code = r.from_recruiter_id

        LEFT JOIN user_mstr requester
        ON requester.employee_code = r.to_recruiter_id

        WHERE

      r.from_recruiter_id = $1

          AND r.status = 'Pending'

        ORDER BY

          r.requested_on DESC

        `,

        [

          recruiterId

        ]

      );

      res.status(200).json({

        success: true,

        data: result.rows

      });

    }

    catch (error) {

      console.log(

        "❌ Ownership Request Inbox Error"

      );

      console.log(error);

      res.status(500).json({

        success: false,

        message:

          "Error fetching ownership requests."

      });

    }

  }

);

// =====================================================
// API 59 - Approve Candidate Ownership Transfer
// =====================================================

app.put(

  "/approve-candidate-ownership/:requestId",

  verifyToken,

  async (req, res) => {

    const client = await pool.connect();

    try {

      await client.query("BEGIN");

      const { requestId } = req.params;

      const approverId = req.user.employee_code;

      // -------------------------------------------------
      // Get Request
      // -------------------------------------------------

      const requestResult = await client.query(

        `
        SELECT *

        FROM rm_candidate_transfer_requests

        WHERE request_id = $1
        `,

        [

          requestId

        ]

      );

      if (requestResult.rows.length === 0) {

        await client.query("ROLLBACK");

        return res.status(404).json({

          success: false,

          message: "Ownership request not found."

        });

      }

      const request = requestResult.rows[0];

      // -------------------------------------------------
      // Validate Current Owner
      // -------------------------------------------------

      if (request.from_recruiter_id !== approverId) {

        await client.query("ROLLBACK");

        return res.status(403).json({

          success: false,

          message:
            "Only the current owner can approve this request."

        });

      }

      if (request.status !== "Pending") {

        await client.query("ROLLBACK");

        return res.status(400).json({

          success: false,

          message:
            "This request has already been processed."

        });

      }

      // -------------------------------------------------
      // Transfer Ownership
      // -------------------------------------------------

      await client.query(

  `
  UPDATE cand_mstr

  SET

    recruiter_id = $1

  WHERE candidate_id = $2
  `,

  [

    request.to_recruiter_id,

    request.candidate_id

  ]

);
      // -------------------------------------------------
      // Mark Request Approved
      // -------------------------------------------------

      await client.query(

        `
        UPDATE rm_candidate_transfer_requests

        SET

          status = 'Approved',

          actioned_on = NOW(),

          actioned_by = $1

        WHERE request_id = $2
        `,

        [

          approverId,

          requestId

        ]

      );

      // -------------------------------------------------
      // Cancel Other Pending Requests
      // -------------------------------------------------

await client.query(

  `

  UPDATE rm_candidate_transfer_requests

  SET

    status = 'Cancelled',

    actioned_on = NOW(),

    actioned_by = $1

  WHERE

    candidate_id = $2

    AND status = 'Pending'

    AND request_id <> $3

  `,

  [

    approverId,

    request.candidate_id,

    requestId

  ]

);

      await client.query("COMMIT");

      res.status(200).json({

        success: true,

        message:
          "Candidate ownership transferred successfully."

      });

    }

    catch (error) {

      await client.query("ROLLBACK");

      console.log(
        "❌ Approve Candidate Ownership Error"
      );

      console.log(error);

      res.status(500).json({

        success: false,

        message:
          "Error approving ownership request."

      });

    }

    finally {

      client.release();

    }

  }

);
// =====================================================
// API 60 - Reject Candidate Ownership Request
// =====================================================

app.put(

  "/reject-candidate-ownership/:requestId",

  verifyToken,

  async (req, res) => {

    try {

      const { requestId } = req.params;

      const approverId = req.user.employee_code;

      const requestResult = await pool.query(

        `

        SELECT *

        FROM rm_candidate_transfer_requests

        WHERE request_id = $1

        `,

        [

          requestId

        ]

      );

      if (requestResult.rows.length === 0) {

        return res.status(404).json({

          success: false,

          message: "Ownership request not found."

        });

      }

      const request = requestResult.rows[0];

      // ---------------------------------------------
      // Validate Current Owner
      // ---------------------------------------------

      if (request.from_recruiter_id !== approverId) {

        return res.status(403).json({

          success: false,

          message:
            "Only the current owner can reject this request."

        });

      }

      if (request.status !== "Pending") {

        return res.status(400).json({

          success: false,

          message:
            "This request has already been processed."

        });

      }

      // ---------------------------------------------
      // Reject Request
      // ---------------------------------------------

      await pool.query(

        `

        UPDATE rm_candidate_transfer_requests

        SET

          status = 'Rejected',

          actioned_on = NOW(),

          actioned_by = $1

        WHERE request_id = $2

        `,

        [

          approverId,

          requestId

        ]

      );

      res.status(200).json({

        success: true,

        message:
          "Ownership request rejected successfully."

      });

    }

    catch (error) {

      console.log(
        "❌ Reject Candidate Ownership Error"
      );

      console.log(error);

      res.status(500).json({

        success: false,

        message:
          "Error rejecting ownership request."

      });

    }

  }

);


// =====================================================
// API 61 - Get Candidate Ownership
// =====================================================

app.get(

  "/candidate-ownership/:candidateId",

  verifyToken,

  async (req, res) => {

    try {

      const { candidateId } = req.params;
      const recruiterId = req.user.employee_code;

      const result = await pool.query(

        `

        SELECT

          c.candidate_id,

          c.owner_employee_code,

          u.full_name,

          CASE
            WHEN c.candidate_container = 'TALENT_POOL'
              AND c.owner_employee_code IS NULL
            THEN NULL
            WHEN c.owner_employee_code IS NULL
            THEN NULL
            ELSE CONCAT(
              u.full_name,
              ' (',
              u.employee_code,
              ')'
            )
          END AS owner_display_name,

          CASE
            WHEN c.candidate_container = 'TALENT_POOL'
              AND c.owner_employee_code IS NULL
            THEN FALSE
            ELSE (c.owner_employee_code IS NOT NULL AND c.owner_employee_code = $2)
          END AS is_owner,

          EXISTS (

            SELECT 1

            FROM rm_candidate_transfer_requests r

            WHERE
              r.candidate_id = c.candidate_id
              AND r.status = 'Pending'
              AND r.to_recruiter_id = $2

          ) AS pending_request

        FROM cand_mstr c

        LEFT JOIN user_mstr u

          ON u.employee_code = c.owner_employee_code

        WHERE c.candidate_id = $1

        `,

        [candidateId, recruiterId]

      );

      if (result.rows.length === 0) {

        return res.status(404).json({

          success: false,

          message: "Candidate not found."

        });

      }

      res.status(200).json({

        success: true,

        data: result.rows[0]

      });

    }

    catch (error) {

      console.log("❌ Candidate Ownership Error");

      console.log(error);

      res.status(500).json({

        success: false,

        message: "Error fetching candidate ownership."

      });

    }

  }

);



// =====================================================
// API 62 - Release Candidate Mapping
// =====================================================

app.put(

  "/release-candidate-mapping/:candidateId",

  verifyToken,

  async (req, res) => {

    try {

      const result = await recruitmentService.releaseCandidate(
        pool,
        req.params.candidateId,
        req
      );

      res.status(200).json({

        success: true,

        message: result.message || "Candidate released from active requisition."

      });

    }

    catch (error) {

      console.log("❌ Release Candidate Mapping Error");

      console.log(error);

      res.status(error.status || 500).json({

        success: false,

        message:
          error.status
            ? error.message
            : "Error releasing candidate mapping."

      });

    }

  }

);



// =====================================================
// API 62b - Return Candidate to Enterprise Talent Pool
// =====================================================

app.put(

  "/return-candidate-to-talent-pool/:candidateId",

  verifyToken,

  async (req, res) => {

    try {

      const result = await recruitmentService.returnCandidateToTalentPool(
        pool,
        req.params.candidateId,
        req
      );

      res.status(200).json({

        success: true,

        message:
          result.message ||
          "Candidate returned to Enterprise Talent Pool."

      });

    }

    catch (error) {

      console.log("❌ Return to Talent Pool Error");

      console.log(error);

      res.status(error.status || 500).json({

        success: false,

        message:
          error.status
            ? error.message
            : "Error returning candidate to Talent Pool."

      });

    }

  }

);



// =====================================================
// API 63 - Get Active Candidate Sources
// =====================================================

app.get(

  "/candidate-sources",

  verifyToken,

  async (req, res) => {

    try {

      const result = await pool.query(

        `

        SELECT
          id AS source_id,
          code AS source_code,
          name AS source_name,
          NULL AS ownership_strategy

        FROM md_candidate_sources

        WHERE status = 'Active'

        ORDER BY name ASC

        `

      );

      res.status(200).json({

        success: true,

        count: result.rows.length,

        data: result.rows

      });

    }

    catch (error) {

      console.log("❌ Get Candidate Sources Error");

      console.log(error);

      res.status(500).json({

        success: false,

        message: "Error fetching candidate sources."

      });

    }

  }

);



// =====================================================
// API 64 - Create Candidate Intake Record
// =====================================================

app.post(

  "/candidate-intake",

  verifyToken,

  async (req, res) => {

    try {

      const {
        source_id,
        source_reference,
        original_file_name,
        resume_path
      } = req.body;

      if (!source_id) {

        return res.status(400).json({

          success: false,

          message: "source_id is required."

        });

      }

      const result = await pool.query(

        `

        INSERT INTO rm_candidate_intake (
          source_id,
          source_reference,
          original_file_name,
          resume_path
        ) VALUES ($1, $2, $3, $4)

        RETURNING *

        `,

        [
          source_id,
          source_reference,
          original_file_name,
          resume_path
        ]

      );

      res.status(201).json({

        success: true,

        message: "Candidate intake record created successfully.",

        data: result.rows[0]

      });

    }

    catch (error) {

      console.log("❌ Create Candidate Intake Error");

      console.log(error);

      res.status(500).json({

        success: false,

        message: "Error creating candidate intake record."

      });

    }

  }

);



// =====================================================
// API 65 - Process Candidate Intake Resume Upload
// =====================================================

app.post(

  "/candidate-intake/:intakeId/process",

  verifyToken,

  upload.single("resume"),

  async (req, res) => {

    try {

      const intakeId = req.params.intakeId;

      if (!req.file) {

        return res.status(400).json({

          success: false,

          message: "Resume file is required."

        });

      }

      const existingIntake = await pool.query(

        `

        SELECT intake_id
        FROM rm_candidate_intake
        WHERE intake_id = $1

        `,

        [intakeId]

      );

      if (existingIntake.rows.length === 0) {

        return res.status(404).json({

          success: false,

          message: "Candidate intake record not found."

        });

      }

      const resumePath =
        await uploadResumeToStorage(req.file);

      const originalFileName =
        req.file.originalname;

      const intakeStatus = "RESUME_UPLOADED";

      const result = await pool.query(

        `

        UPDATE rm_candidate_intake
        SET
          resume_path = $1,
          original_file_name = $2,
          intake_status = $3
        WHERE intake_id = $4

        RETURNING intake_id, intake_status

        `,

        [
          resumePath,
          originalFileName,
          intakeStatus,
          intakeId
        ]

      );

      res.status(200).json({

        success: true,

        intake_id: result.rows[0].intake_id,

        intake_status: result.rows[0].intake_status

      });

    }

    catch (error) {

      console.log("❌ Process Candidate Intake Error");

      console.log(error);

      res.status(500).json({

        success: false,

        message: "Error processing candidate intake resume."

      });

    }

  }

);



// =====================================================
// API 66 - Parse Candidate Intake Resume
// =====================================================

app.post(

  "/candidate-intake/:intakeId/parse",

  verifyToken,

  async (req, res) => {

    const intakeId = req.params.intakeId;

    try {

      const existingIntake = await pool.query(

        `

        SELECT
          intake_id,
          source_id,
          resume_path,
          original_file_name,
          parsing_status,
          created_draft_id
        FROM rm_candidate_intake
        WHERE intake_id = $1

        `,

        [intakeId]

      );

      if (existingIntake.rows.length === 0) {

        return res.status(404).json({

          success: false,

          message: "Candidate intake record not found."

        });

      }

      const intake = existingIntake.rows[0];

      if (!intake.resume_path) {

        const errorMessage =
          "Resume path is not set for this intake record.";

        await markIntakeParsingFailed(intakeId, errorMessage);

        return res.status(400).json({

          success: false,

          message: errorMessage

        });

      }

      let resumeBuffer;

      try {

        resumeBuffer =
          await downloadResumeFromStorage(intake.resume_path);

      }

      catch (downloadError) {

        if (downloadError.isStatObjectFailure) {

          return res.status(500).json({

            bucket: downloadError.bucket,

            objectKey: downloadError.objectKey

          });

        }

        const errorMessage =
          `Failed to download resume from storage: ${downloadError.message}`;

        await markIntakeParsingFailed(intakeId, errorMessage);

        return res.status(500).json({

          success: false,

          message: errorMessage

        });

      }

      const originalFileName =
        (intake.original_file_name || "").toLowerCase();

      if (
        originalFileName &&
        !originalFileName.endsWith(".pdf")
      ) {

        const errorMessage =
          "Only PDF resume parsing is currently supported.";

        await markIntakeParsingFailed(intakeId, errorMessage);

        return res.status(400).json({

          success: false,

          message: errorMessage

        });

      }

      let extractedText;

      try {

        extractedText =
          await extractPdfText(resumeBuffer);

      }

      catch (parseError) {

        const errorMessage =
          parseError.message ||
          "Failed to extract text from resume PDF.";

        await markIntakeParsingFailed(intakeId, errorMessage);

        return res.status(500).json({

          success: false,

          message: errorMessage

        });

      }

      const parsed_candidate =
        parseBasicCandidateInfo(extractedText);

      // Idempotent parse: if this intake already created a DRAFT, reuse it.
      // Prevents duplicate cand_mstr rows on re-parse and keeps Register on the same id.
      let draftResult;

      if (intake.created_draft_id) {

        draftResult = {
          outcome: "CREATED",
          candidate_id: intake.created_draft_id
        };

      } else {

        draftResult =
          await createDraftCandidateFromParsedIntake({
            intake,
            parsedCandidate: parsed_candidate,
            createdBy: req.user?.employee_code
          });

      }

      const draft_candidate_id =
        draftResult.outcome === "CREATED"
          ? draftResult.candidate_id
          : null;

      const result = await pool.query(

        `

        UPDATE rm_candidate_intake
        SET
          parsing_status = 'COMPLETED',
          error_message = NULL,
          created_draft_id = COALESCE($1, created_draft_id)
        WHERE intake_id = $2

        RETURNING intake_id, parsing_status, created_draft_id

        `,

        [draft_candidate_id, intakeId]

      );

      if (draftResult.outcome === "DUPLICATE") {

        return res.status(200).json({

          success: true,

          outcome: "DUPLICATE",

          duplicate_candidate: draftResult.duplicate_candidate,

          parsed_candidate,

          draft_candidate_id: result.rows[0].created_draft_id || null

        });

      }

      res.status(200).json({

        success: true,

        intake_id: result.rows[0].intake_id,

        parsing_status: result.rows[0].parsing_status,

        parsed_candidate,

        draft_candidate_id:
          result.rows[0].created_draft_id || draft_candidate_id

      });

    }

    catch (error) {

      console.log("❌ Parse Candidate Intake Error");

      console.error(error.stack || error);

      const errorMessage =
        error.message ||
        "Error parsing candidate intake resume.";

      try {

        await markIntakeParsingFailed(intakeId, errorMessage);

      }

      catch (updateError) {

        console.log("❌ Failed to update intake parsing status");

        console.log(updateError);

      }

      res.status(500).json({

        success: false,

        message: errorMessage

      });

    }

  }

);



// =====================================================
// API 67 - Candidate Intake Dashboard Summary
// =====================================================

app.get(

  "/candidate-intake/dashboard",

  verifyToken,

  async (req, res) => {

    try {

      const result = await pool.query(

        `

        SELECT
          COUNT(*)::int AS total_intakes,
          COUNT(*) FILTER (
            WHERE intake_status = 'RESUME_UPLOADED'
          )::int AS uploaded,
          COUNT(*) FILTER (
            WHERE parsing_status = 'COMPLETED'
          )::int AS parsed,
          COUNT(*) FILTER (
            WHERE review_status = 'PENDING'
          )::int AS pending_review,
          COUNT(*) FILTER (
            WHERE created_draft_id IS NOT NULL
          )::int AS candidate_created
        FROM rm_candidate_intake

        `

      );

      const dashboard = result.rows[0];

      res.status(200).json({

        success: true,

        dashboard: {
          total_intakes: dashboard.total_intakes,
          uploaded: dashboard.uploaded,
          parsed: dashboard.parsed,
          pending_review: dashboard.pending_review,
          candidate_created: dashboard.candidate_created
        }

      });

    }

    catch (error) {

      console.log("❌ Candidate Intake Dashboard Error");

      console.log(error);

      res.status(500).json({

        success: false,

        message: "Error fetching candidate intake dashboard."

      });

    }

  }

);



// =====================================================
// Serve React Frontend (local development only)
// =====================================================

if (isLocalDevelopment) {

  app.use(
    express.static(
      path.join(
        __dirname,
        "../ATS-Frontend/dist"
      )
    )
  );

  app.get(/^\/(?!api).*/, (req, res) => {

    res.sendFile(

      path.join(
        __dirname,
        "../ATS-Frontend/dist/index.html"
      )

    );

  });

}

// =====================================================
// Start Server
// =====================================================

app.listen(process.env.PORT, () => {

  console.log(`

==================================================
🚀 ATS Backend Running
🌐 http://localhost:${process.env.PORT}
==================================================

  `);

});