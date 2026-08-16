require("dotenv").config();

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:5000";

function pass(label) {
  console.log(`PASS: ${label}`);
}

function fail(label, detail) {
  console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
}

function buildMinimalPdfBuffer() {
  const pdfText = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Contents 4 0 R>>endobj
4 0 obj<</Length 120>>stream
BT /F1 12 Tf 72 720 Td (John Portal Doe) Tj 0 -20 Td (Email: portal.http.test@example.com) Tj 0 -20 Td (Mobile: 9876543210) Tj 0 -20 Td (Skills: Java SQL) Tj 0 -20 Td (Experience: 5 years) Tj ET
endstream
endobj
xref
0 5
0000000000 65535 f 
0000000009 00000 n 
0000000052 00000 n 
0000000101 00000 n 
0000000204 00000 n 
trailer<</Size 5/Root 1 0 R>>
startxref
380
%%EOF`;

  return Buffer.from(pdfText, "utf8");
}

async function readJson(response) {
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch (error) {
    return { raw: text };
  }
}

async function main() {
  const uniqueSuffix = Date.now();
  const emailId = `portal.http.${uniqueSuffix}@example.com`;
  const password = "TestPass1!";

  const registerResponse = await fetch(`${API_BASE_URL}/candidate-portal/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      full_name: "Portal HTTP Candidate",
      mobile_number: "9876504321",
      email_id: emailId,
      password,
      confirm_password: password
    })
  });

  const registerBody = await readJson(registerResponse);

  if (!registerResponse.ok) {
    fail("register portal account", registerBody.message || registerResponse.status);
    return;
  }

  pass("register portal account");

  const loginResponse = await fetch(`${API_BASE_URL}/candidate-portal/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email_id: emailId,
      password
    })
  });

  const loginBody = await readJson(loginResponse);
  const token = loginBody.data?.token;

  if (!loginResponse.ok || !token) {
    fail("login portal account", loginBody.message || loginResponse.status);
    return;
  }

  pass("login portal account");

  const intakeResponse = await fetch(`${API_BASE_URL}/candidate-portal/profile/intake`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  const intakeBody = await readJson(intakeResponse);
  const intakeId = intakeBody.data?.intake_id;

  if (intakeResponse.status === 404) {
    fail(
      "create profile intake route exists",
      "Received HTTP 404 — restart backend with current code"
    );
    return;
  }

  if (!intakeResponse.ok || !intakeId) {
    fail("create profile intake", intakeBody.message || intakeResponse.status);
    return;
  }

  pass("create profile intake");

  const formData = new FormData();
  const pdfBuffer = buildMinimalPdfBuffer();
  formData.append(
    "resume",
    new Blob([pdfBuffer], { type: "application/pdf" }),
    "portal-http-test.pdf"
  );

  const processResponse = await fetch(
    `${API_BASE_URL}/candidate-portal/profile/intake/${intakeId}/process`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`
      },
      body: formData
    }
  );

  const processBody = await readJson(processResponse);

  if (!processResponse.ok) {
    fail("upload resume", processBody.message || processResponse.status);
    return;
  }

  pass("upload resume");

  const parseResponse = await fetch(
    `${API_BASE_URL}/candidate-portal/profile/intake/${intakeId}/parse`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  );

  const parseBody = await readJson(parseResponse);
  const profile =
    parseBody.data?.profile || parseBody.data?.parsed_candidate || parseBody.data;

  if (!parseResponse.ok) {
    fail("parse resume", parseBody.message || parseResponse.status);
    return;
  }

  if (!profile || (!profile.first_name && !profile.candidate_name && !profile.email)) {
    fail("parsed profile returned", JSON.stringify(parseBody).slice(0, 200));
    return;
  }

  pass("parse resume and return profile fields");

  const saveResponse = await fetch(`${API_BASE_URL}/candidate-portal/profile`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      first_name: profile.first_name || "John",
      last_name: profile.last_name || "Doe",
      email: profile.email || emailId,
      mobile: profile.mobile || "9876504321",
      current_company: profile.current_company || "",
      designation: profile.designation || "",
      experience: profile.experience || "5",
      skills: profile.skills || "Java, SQL"
    })
  });

  const saveBody = await readJson(saveResponse);

  if (!saveResponse.ok) {
    fail("save profile", saveBody.message || saveResponse.status);
    return;
  }

  if (String(saveBody.data?.candidate?.candidate_status || "").toUpperCase() !== "DRAFT") {
    fail("candidate remains DRAFT after save", saveBody.data?.candidate?.candidate_status);
    return;
  }

  pass("save profile and remain DRAFT");

  console.log("Candidate portal profile HTTP verification passed.");
}

main().catch((error) => {
  fail("unexpected error", error.message);
});
