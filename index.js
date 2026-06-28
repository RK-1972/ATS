require("dotenv").config();
const axios = require("axios");

const {
  ConfidentialClientApplication
} = require("@azure/msal-node");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { Pool } = require("pg");
const Minio = require("minio");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const path = require("path");
const crypto = require("crypto");
const recruitmentLegacyHandlers = require("./handlers/recruitmentLegacyHandlers");
const recruitmentLegacyReadHandlers = require("./handlers/recruitmentLegacyReadHandlers");
const interviewLegacyHandlers = require("./handlers/interviewLegacyHandlers");
const interviewLegacyReadHandlers = require("./handlers/interviewLegacyReadHandlers");

const app = express();

app.use(cors());
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

const pool = new Pool({

  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,

});

pool.connect()
  .then(() => {

    console.log("✅ PostgreSQL Connected");

  })
  .catch((err) => {

    console.log("❌ PostgreSQL Connection Error");

    console.log(err);

  });


// =====================================================
// MinIO Configuration
// =====================================================

const minioClient = new Minio.Client({

  endPoint: process.env.MINIO_ENDPOINT,
  port: parseInt(process.env.MINIO_PORT),
  useSSL: false,
  accessKey: process.env.MINIO_ACCESS_KEY,
  secretKey: process.env.MINIO_SECRET_KEY,

});

const bucketName = process.env.MINIO_BUCKET;


// =====================================================
// Ensure Bucket Exists
// =====================================================

async function initializeBucket() {

  try {

    const exists =
      await minioClient.bucketExists(bucketName);

    if (!exists) {

      await minioClient.makeBucket(bucketName);

      console.log("✅ MinIO Bucket Created");

    }

    else {

      console.log("✅ MinIO Bucket Exists");

    }

  }

  catch (error) {

    console.log("❌ MinIO Error");

    console.log(error);

  }

}

initializeBucket();


// =====================================================
// Multer Setup
// =====================================================

const storage = multer.memoryStorage();

const upload = multer({

  storage: storage,

});


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

        const fileName =
          `${Date.now()}-${req.file.originalname}`;

        await minioClient.putObject(

          bucketName,
          fileName,
          req.file.buffer,
          req.file.size

        );

        resumePath =
          `http://localhost:9000/${bucketName}/${fileName}`;

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

      res.status(200).json({

        success: true,
        data: result.rows[0]

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

        SELECT resume_path
        FROM cand_mstr
        WHERE candidate_id = $1

        `,

        [candidateId]

      );

      let resumePath =
        existingCandidate.rows[0]?.resume_path || null;


      if (req.file) {

        const fileName =
          `${Date.now()}-${req.file.originalname}`;

        await minioClient.putObject(

          bucketName,
          fileName,
          req.file.buffer,
          req.file.size

        );

        resumePath =
          `http://localhost:9000/${bucketName}/${fileName}`;

      }

      const result = await pool.query(

        `

        UPDATE cand_mstr

        SET

          first_name = $1,
          last_name = $2,
          mobile_number = $3,
          primary_skill = $4,
          total_experience = $5,
          resume_path = $6,
          candidate_status = $7,
          updated_on = CURRENT_TIMESTAMP

        WHERE candidate_id = $8

        RETURNING *

        `,

        [

          req.body.first_name,
          req.body.last_name,
          req.body.mobile_number,
          req.body.primary_skill,
          req.body.total_experience,
          resumePath,
          req.body.candidate_status,
          candidateId

        ]

      );

      res.status(200).json({

        success: true,
        message: "Candidate Updated Successfully",
        data: result.rows[0]

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

    } = req.body;


    const userResult = await pool.query(

      `

      SELECT *
      FROM user_mstr
      WHERE email_id = $1

      `,

      [email_id]

    );

    if (userResult.rows.length === 0) {

      return res.status(401).json({

        success: false,
        message: "Invalid Email"

      });

    }

    const user = userResult.rows[0];


    const validPassword =
      await bcrypt.compare(

        password,
        user.password_hash

      );

    if (!validPassword) {

      return res.status(401).json({

        success: false,
        message: "Invalid Password"

      });

    }


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

      }

    });

  }

  catch (error) {

    console.log("❌ Login Error");

    console.log(error);

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

            crm.stage_name,

            crm.source_type,

            crm.remarks

          FROM cand_mstr c

          LEFT JOIN candidate_req_map crm
          ON c.candidate_id = crm.candidate_id

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
  req_id,
  stage_name,
  source_type,
  remarks

} = req.body;

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

          INNER JOIN candidate_req_map crm

            ON cm.candidate_id =
               crm.candidate_id

          INNER JOIN req_mstr rm

            ON crm.req_id =
               rm.req_id

          WHERE

            crm.recruiter_id = $1

            AND crm.is_active = true

          ORDER BY

            crm.applied_date DESC

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
// =====================================================

app.get(

  "/active-interviewers",

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
          ip.interviewer_type

        FROM interview_panel_mstr ip

        INNER JOIN user_mstr u

          ON ip.user_id =
            u.user_id

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
// =====================================================

app.get(
  "/interview-candidates/:reqId",
  verifyToken,
  async (req, res) => {

    try {

      const loggedInRecruiter =
        req.user.employee_code;

      const reqId =
        req.params.reqId;

      const result =
        await pool.query(

          `
          SELECT DISTINCT

            crm.map_id,

            cm.candidate_code,

            CONCAT(
              cm.first_name,
              ' ',
              cm.last_name
            ) AS candidate_name

          FROM candidate_req_map crm

          INNER JOIN cand_mstr cm
            ON cm.candidate_id =
               crm.candidate_id

          WHERE crm.is_active = true

          AND crm.recruiter_id = $1

          AND crm.req_id = $2

          ORDER BY candidate_name
          `,

          [
            loggedInRecruiter,
            reqId
          ]

        );

      res.status(200).json({

        success: true,

        data: result.rows

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
// =====================================================

app.get(
  "/interview-requisitions",
  verifyToken,
  async (req, res) => {

    try {

      const loggedInRecruiter =
        req.user.employee_code;

      const result =
        await pool.query(

          `
          SELECT DISTINCT

            rm.req_id,

            rm.req_code,

            rm.job_title

          FROM req_mstr rm

          INNER JOIN candidate_req_map crm
            ON crm.req_id = rm.req_id

          WHERE crm.recruiter_id = $1

          AND crm.is_active = true

          ORDER BY rm.req_code
          `,

          [
            loggedInRecruiter
          ]

        );

      res.status(200).json({

        success: true,

        data: result.rows

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

      const result =
        await pool.query(

          `
          SELECT

            s.schedule_id,

            s.round_type,
            s.interview_date,
            s.interview_time,
            s.interview_status,
            s.feedback_submitted,
            fh.final_outcome,
            s.meeting_link,

            crm.map_id,
            crm.stage_name,

            c.candidate_id,
            c.candidate_code,

            CONCAT(
              c.first_name,
              ' ',
              c.last_name
            ) AS candidate_name,

            c.email_id,
            c.resume_path,

            r.req_id,
            r.req_code,
            r.client_name,
            r.job_title,

            r.primary_skill,
            r.secondary_skill,

            r.experience_min,
            r.experience_max,

            ip.interviewer_name

          FROM interview_schedule_trn s

          INNER JOIN candidate_req_map crm
            ON crm.map_id = s.map_id

          INNER JOIN cand_mstr c
            ON c.candidate_id =
               crm.candidate_id

          INNER JOIN req_mstr r
            ON r.req_id =
               crm.req_id

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
// =====================================================

app.get(
  "/interviewer-dropdown",
  verifyToken,
  async (req, res) => {

    try {

      const result =
        await pool.query(

          `
          SELECT

            user_id,
            employee_code,
            full_name,
            email_id,
            department,
            designation,
            primary_skill

          FROM user_mstr

          WHERE

                role_name = 'Interviewer'

             OR secondary_role = 'Interviewer'

          ORDER BY full_name
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

            rm.req_id,

            rm.req_code,

            rm.client_name,

            rm.job_title,

            ip.interviewer_name,

            ip.employee_code
              AS interviewer_code

          FROM interview_schedule_trn ist

          INNER JOIN candidate_req_map crm
            ON crm.map_id = ist.map_id

          INNER JOIN cand_mstr cm
            ON cm.candidate_id =
               crm.candidate_id

          INNER JOIN req_mstr rm
          ON rm.req_id =
          crm.req_id

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

  async (req, res) => {

    try {

      const scheduleId =
        req.params.scheduleId;

      // ==========================
      // Feedback Header
      // ==========================

      const headerResult =
  await pool.query(

    `

    SELECT

      ifh.*,

      cm.candidate_code,

      CONCAT(
        cm.first_name,
        ' ',
        cm.last_name
      ) AS candidate_name,

      rm.req_code,

      rm.job_title,

      ipm.interviewer_name,

      ist.round_type,

      TO_CHAR(
        ist.interview_date,
        'DD-MM-YYYY'
      ) AS interview_date,

      ist.interview_time

    FROM interview_feedback_hdr ifh

    INNER JOIN interview_schedule_trn ist
      ON ist.schedule_id =
         ifh.schedule_id

    INNER JOIN candidate_req_map crm
      ON crm.map_id =
         ist.map_id

    INNER JOIN cand_mstr cm
      ON cm.candidate_id =
         crm.candidate_id

    LEFT JOIN req_mstr rm
      ON rm.req_id =
         ist.req_id

    LEFT JOIN interview_panel_mstr ipm
      ON ipm.panel_id =
         ist.interviewer_id

    WHERE ifh.schedule_id = $1

    `,

    [scheduleId]

  );

      if (
        headerResult.rows.length === 0
      ) {

        return res.status(200).json({

          success: true,

          feedbackExists: false

        });

      }

      const header =
        headerResult.rows[0];

      // ==========================
      // Feedback Details
      // ==========================

      const detailResult =
        await pool.query(

          `

          SELECT

            detail_id,
            feedback_id,
            skill_name,
            rating,
            comments

          FROM interview_feedback_dtl

          WHERE feedback_id = $1

          ORDER BY detail_id

          `,

          [header.feedback_id]

        );

      res.status(200).json({

        success: true,

        feedbackExists: true,

        header,

        details:
          detailResult.rows

      });

    }

    catch (error) {

      console.log(
        "❌ Get Feedback Error"
      );

      console.log(error);

      res.status(500).json({

        success: false,

        message:
          "Error Fetching Feedback"

      });

    }

  }

);

// =====================================================
// Serve React Frontend
// =====================================================

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

        const resetLink =

          `http://localhost:5173/reset-password/${resetToken}`;

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
// Enterprise Master Data API (PostgreSQL-backed)
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

registerMasterDataRoutes(app, pool, verifyToken, verifyAdmin);
registerPlatformConfigRoutes(app, pool, verifyToken, verifyAdmin);
registerBusinessRulesRoutes(app, pool, verifyToken, verifyAdmin);
registerWorkflowRoutes(app, pool, verifyToken, verifyAdmin);
registerWorkforcePlanningRoutes(app, pool, verifyToken, verifyAdmin);
registerRecruitmentRoutes(app, pool, verifyToken, verifyAdmin);
registerTaskRoutes(app, pool, verifyToken);
registerInterviewRoutes(app, pool, verifyToken);
registerOfferRoutes(app, pool, verifyToken);

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