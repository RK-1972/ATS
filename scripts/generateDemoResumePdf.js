/**
 * Generate demo-resume.pdf for E2E Candidate Intake (fictional data only).
 * Usage: node scripts/generateDemoResumePdf.js
 */
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

const OUTPUT_PATH = path.join(__dirname, "..", "demo", "assets", "demo-resume.pdf");

const RESUME_LINES = [
  "Aarav Sharma",
  "Senior Software Engineer",
  "Bangalore, India",
  "",
  "Email: demo.candidate@optalynx.demo",
  "Mobile: 9876543210",
  "PAN: DEMOP1234A",
  "",
  "Professional Summary",
  "Senior software engineer with 6 years of experience building enterprise",
  "applications using Java, Spring Boot, PostgreSQL, and React.",
  "",
  "Skills",
  "Java, Spring Boot, PostgreSQL, React, REST APIs, Microservices",
  "",
  "Work Experience",
  "Senior Software Engineer — Demo Technologies Pvt Ltd (2020 – Present)",
  "- Built enterprise APIs with Java and Spring Boot",
  "- PostgreSQL data modeling and query optimization",
  "- React front-end modules for internal tools",
  "",
  "Software Engineer — Sample Systems Ltd (2018 – 2020)",
  "- REST services and integration testing",
  "- Collaborated on backend platform enhancements",
  "",
  "Education",
  "B.Tech — Computer Science — Demo Institute of Technology — 2018"
];

function main() {
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });

  const doc = new PDFDocument({ margin: 50 });
  const stream = fs.createWriteStream(OUTPUT_PATH);
  doc.pipe(stream);

  doc.fontSize(16).text("Aarav Sharma", { underline: true });
  doc.moveDown(0.5);
  doc.fontSize(11);

  for (const line of RESUME_LINES.slice(1)) {
    if (line === "") {
      doc.moveDown(0.4);
    } else if (
      line === "Professional Summary"
      || line === "Skills"
      || line === "Work Experience"
      || line === "Education"
    ) {
      doc.moveDown(0.3);
      doc.fontSize(12).text(line, { underline: true });
      doc.fontSize(11);
    } else {
      doc.text(line);
    }
  }

  doc.end();

  stream.on("finish", () => {
    const buffer = fs.readFileSync(OUTPUT_PATH);
    const isPdf = buffer.slice(0, 4).toString() === "%PDF";
    console.log(`Created ${OUTPUT_PATH}`);
    console.log(`PDF magic bytes valid: ${isPdf}`);
    console.log(`File size: ${buffer.length} bytes`);
  });
}

main();
