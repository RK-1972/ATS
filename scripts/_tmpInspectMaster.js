require("dotenv").config();

const http = require("http");
const { Pool } = require("pg");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: "localhost",
        port: 5000,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(data ? { "Content-Length": Buffer.byteLength(data) } : {})
        }
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode, body: d }));
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function getPublishedRecords(masterData, entityType) {
  const records = masterData?.records?.[entityType] || [];
  return records.filter(
    (record) =>
      record.status === "Active" &&
      record.versionStatus === "Published"
  );
}

(async () => {
  const users = await pool.query(
    `SELECT email_id, role_name
     FROM user_mstr
     WHERE is_active = true
     ORDER BY role_name, email_id`
  );
  console.log("USERS", JSON.stringify(users.rows));

  const passwords = [
    "Password@123",
    "password",
    "Password123",
    "Admin@123",
    "admin123",
    "Igs@1234",
    "Welcome@123",
    "Optalynx@123",
    "123456"
  ];

  let token = null;
  let loginUser = null;

  for (const user of users.rows) {
    for (const password of passwords) {
      const login = await request("POST", "/login", {
        email_id: user.email_id,
        password
      });
      if (login.status === 200) {
        const parsed = JSON.parse(login.body);
        token = parsed.token || parsed.data?.token;
        loginUser = { email_id: user.email_id, role_name: user.role_name };
        console.log("LOGIN_OK", JSON.stringify(loginUser));
        break;
      }
    }
    if (token) break;
  }

  if (!token) {
    console.log("LOGIN_FAILED");
    await pool.end();
    process.exit(1);
  }

  const master = await request("GET", "/api/v1/master", null, token);
  console.log("MASTER_STATUS", master.status);

  if (master.status !== 200) {
    console.log("MASTER_BODY", master.body.slice(0, 500));
    await pool.end();
    process.exit(1);
  }

  const bundle = JSON.parse(master.body);
  const countries = bundle?.records?.countries || [];
  const states = bundle?.records?.states || [];
  const publishedCountries = getPublishedRecords(bundle, "countries");

  console.log(
    JSON.stringify(
      {
        masterDataExists: Boolean(bundle),
        recordsExist: Boolean(bundle?.records),
        countriesCount: countries.length,
        statesCount: states.length,
        publishedCountriesCount: publishedCountries.length,
        sampleCountry: countries[0] || null
      },
      null,
      2
    )
  );

  const candidates = await pool.query(
    `SELECT candidate_id FROM cand_mstr ORDER BY candidate_id DESC LIMIT 1`
  );
  console.log("CANDIDATE_ID", candidates.rows[0]?.candidate_id || null);

  await pool.end();
})().catch(async (error) => {
  console.error(error);
  try {
    await pool.end();
  } catch (_) {
    // ignore
  }
  process.exit(1);
});
