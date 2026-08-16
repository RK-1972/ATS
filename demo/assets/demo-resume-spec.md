# Demo Resume Specification

**Path:** `ats-backend/demo/assets/demo-resume.pdf`

Generate or refresh with:

```bash
node scripts/generateDemoResumePdf.js
```

Use fictional data only. Content must be parseable by the existing resume parser (`pdf-parse` + `parseBasicCandidateInfo` in `index.js`).

---

## Required fields

| Field | Value |
|-------|-------|
| Full name | Aarav Sharma |
| Email | demo.candidate@optalynx.demo |
| Mobile | 9876543210 |
| PAN | DEMOP1234A |
| Current company | Demo Technologies Pvt Ltd |
| Designation | Senior Software Engineer |
| Experience | 6 years |
| Location | Bangalore, India |

## Skills (include in resume body)

- Java
- Spring Boot
- PostgreSQL
- React

## Experience section (sample)

**Senior Software Engineer** — Demo Technologies Pvt Ltd (2020 – Present)

- Built enterprise APIs with Java and Spring Boot
- PostgreSQL data modeling and query optimization
- React front-end modules for internal tools

**Software Engineer** — Sample Systems Ltd (2018 – 2020)

- REST services and integration testing

## Education

B.Tech — Computer Science — Demo Institute of Technology — 2018

---

## Validation notes

- Must be a valid PDF (not scanned image-only if parser expects text)
- Filename for intake upload: `demo-resume.pdf`
- Do not use real personal information or real company logos
