function buildMinimalPdfBuffer() {
  const pdfText = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Contents 4 0 R>>endobj
4 0 obj<</Length 120>>stream
BT /F1 12 Tf 72 720 Td (John Portal Doe) Tj 0 -20 Td (Email: portal.test@example.com) Tj 0 -20 Td (Mobile: 9876543210) Tj 0 -20 Td (Skills: Java SQL) Tj 0 -20 Td (Experience: 5 years) Tj ET
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
400
%%EOF`;

  return Buffer.from(pdfText, "utf8");
}

async function fetchJson(apiBaseUrl, path, token, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function completePortalProfileFlow(apiBaseUrl, token, emailId) {
  const intakeResult = await fetchJson(apiBaseUrl, "/candidate-portal/profile/intake", token, {
    method: "POST"
  });

  const intakeId = intakeResult.body.data?.intake_id;

  if (!intakeResult.response.ok || !intakeId) {
    throw new Error(intakeResult.body.message || "failed to create profile intake");
  }

  const formData = new FormData();
  formData.append(
    "resume",
    new Blob([buildMinimalPdfBuffer()], { type: "application/pdf" }),
    "portal-publication-apply.pdf"
  );

  const processResponse = await fetch(
    `${apiBaseUrl}/candidate-portal/profile/intake/${intakeId}/process`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`
      },
      body: formData
    }
  );

  const processBody = await processResponse.json().catch(() => ({}));

  if (!processResponse.ok) {
    throw new Error(processBody.message || "failed to upload resume");
  }

  const parseResult = await fetchJson(
    apiBaseUrl,
    `/candidate-portal/profile/intake/${intakeId}/parse`,
    token,
    { method: "POST" }
  );

  if (!parseResult.response.ok) {
    throw new Error(parseResult.body.message || "failed to parse resume");
  }

  const profile =
    parseResult.body.data?.profile ||
    parseResult.body.data?.parsed_candidate ||
    parseResult.body.data ||
    {};

  const panSuffix = String(Date.now()).slice(-4).padStart(4, "0");
  const panNumber = `PORTL${panSuffix}Z`;

  const saveResult = await fetchJson(apiBaseUrl, "/candidate-portal/profile", token, {
    method: "PUT",
    body: {
      first_name: profile.first_name || "John",
      last_name: profile.last_name || "Doe",
      email: profile.email || emailId,
      mobile: profile.mobile || "9876504321",
      current_company: profile.current_company || "",
      designation: profile.designation || "",
      experience: profile.experience || "5",
      skills: profile.skills || "Java, SQL",
      pan_number: profile.pan_number || profile.pan || panNumber
    }
  });

  if (!saveResult.response.ok) {
    throw new Error(saveResult.body.message || "failed to save profile");
  }
}

module.exports = {
  buildMinimalPdfBuffer,
  completePortalProfileFlow
};
