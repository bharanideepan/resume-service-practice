# Resume Generation Service (Node.js)

Express API that fills a prepared DOCX template with structured resume content and returns the generated `.docx` file.

## 1. Prepare the template first

The supplied `Sample Profile_Ideas2it.docx` contains sample text, not Docxtemplater placeholders. The service cannot infer which text to replace by meaning. Make a copy of the original DOCX and replace candidate-specific text with placeholders while preserving the logo, colors, tables/columns, Word styles, bullets, headers and layout. Save the prepared copy as `templates/resume-template.docx`.

Start by replacing a few fixed fields and test before adding repeatable sections. Keep each placeholder in a single uninterrupted Word text run; if Word splits a placeholder into multiple runs, retype it in Word as one continuous string.

## 2. Install and run

Requires Node.js 20+.

```bash
npm install
cp .env.example .env
# Copy your prepared template to templates/resume-template.docx
npm start
```

Runs at `http://localhost:3000`. The example service reads `API_KEY` from the environment; authentication is disabled when it is blank, for local development only. Load `.env` using your preferred environment loader or export the variables in your shell/container.

## 3. Test

```bash
curl http://localhost:3000/health
curl -X POST http://localhost:3000/generate-resume \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer replace-with-a-long-random-secret' \
  --data @sample-request.json \
  --output generated-resume.docx
```

## 4. Template placeholders

Use these placeholders where the relevant text belongs in the DOCX:

```text
{{candidate.name}}
{{candidate.designation}}
{{candidate.experienceSummary}}
{{candidate.contact}}
{{candidate.email}}
{{candidate.phone}}
{{candidate.location}}
{{candidate.linkedin}}
{{resume.summary}}
{{generatedOn}}
```

Skills example:

```text
{#resume.skills}
{{category}}: {{displayItems}}
{/resume.skills}
```

Highlights example (put the loop tags in surrounding paragraphs and keep `{{.}}` in the existing bullet paragraph so Word's bullet style is retained):

```text
{#resume.highlights}
{{.}}
{/resume.highlights}
```

Projects example:

```text
{#resume.projects}
{{name}}
{{summary}}
Technologies: {{technologiesText}}
{#responsibilities}
{{.}}
{/responsibilities}
{/resume.projects}
```

Docxtemplater loop placement can affect paragraph duplication. Test each repeating section in Word/LibreOffice and adjust tag placement in the template.

## 5. Important limits

- This is a starter service, not a finished template converter. It fills placeholders; it does not infer the meaning of existing sample text.
- Keep the original embedded Ideas2IT logo in the DOCX. No logo needs to be passed in JSON if it is already in the template.
- The original template may need careful editing to introduce placeholders while retaining run styles and layout.
- Long candidate content can change pagination. Render and inspect output with representative short and long resumes.
- DOCX-to-PDF conversion is not included. Add LibreOffice or another trusted renderer in a server/container if PDF output is required.
- In production, use authentication, network restrictions, rate limiting, request validation, audit logs, and safe temporary-file handling. Never let callers choose arbitrary template paths.

## 6. Employee Data API (mock data)

Read-only endpoints on the same server and port, behind the same `API_KEY` check. Contract: `employee-data-api.yaml` (OpenAPI, kept in the parent project's `contracts/openapi/` folder, outside this repo).

| Method | Path | Returns |
|---|---|---|
| GET | `/employees?name=&employee_id=&limit=` | `{ count, results: [{ employee_id, name, designation, data_source }] }`. Name is a case-insensitive partial match. At least one of `name` or `employee_id` is required |
| GET | `/employees/:employeeId` | `{ employee, assignments }`: the profile plus every project assignment, newest first |
| GET | `/employees/:employeeId/assignments?status=Active\|Completed\|On Hold` | `{ employee_id, count, assignments }` |

Errors are `{ "error": "..." }` with `400` (bad input), `401` (bad token) or `404` (unknown employee).

```bash
curl 'http://localhost:3000/employees?name=arun'
curl 'http://localhost:3000/employees/I2I-1118'
curl 'http://localhost:3000/employees/I2I-1118/assignments?status=Active'
```

Mock data lives in `src/data/employees.json` (6 employees, 11 assignments, every record has `data_source: "Mock"`). It covers a short profile, an ambiguous name (two Aruns), an employee with no assignments, an outdated profile, and senior profiles with prior employment. Set `EMPLOYEE_DATA_PATH` to use another file. The store checks the data on startup and refuses to start if an assignment points at an unknown employee or an ID is duplicated.

## 7. Agent endpoints: download link instead of raw bytes

`POST /generate-resume` returns the `.docx` bytes, which an agent cannot hand to a user. Agents use these instead (contract: `resume-generation-api.yaml`, in the parent project's `contracts/openapi/` folder, outside this repo):

| Method | Path | Returns |
|---|---|---|
| POST | `/resumes` | Same request body as `/generate-resume`. Returns JSON `{ generation_status, http_status, artifact: { artifact_id, file_name, content_type, size_bytes, sha256, download_url, expires_at } }` |
| GET | `/downloads/:id` (or `/downloads/:id.docx`) | The stored `.docx`. Not protected by `API_KEY`, because a browser cannot send the header when a link is clicked. The id is 128 random bits |

```bash
curl -X POST localhost:3000/resumes -H 'Content-Type: application/json' --data @sample-request.json
```

Files are kept in a private temp folder for 60 minutes (`ARTIFACT_TTL_MINUTES`), at most 20 at a time (`ARTIFACT_MAX_FILES`), oldest deleted first. An expired or unknown link returns `404 { "error": "Download not found or expired..." }`; the fix is to call `POST /resumes` again. `download_url` uses `PUBLIC_BASE_URL`, then Render's `RENDER_EXTERNAL_URL`, then the request's own host.

## 8. Deploying on Render (free tier)

1. Push this folder to a git repo (include `templates/resume-template.docx`).
2. New > Web Service. Root directory: `resume-generation-service` (if it is a subfolder). Build command: `npm install`. Start command: `npm start`. Instance type: Free.
3. Leave `API_KEY` unset for this practice project (everything is mock data). Anyone with the URL can then call the API.
4. Free-tier behaviour to expect: the service sleeps after 15 minutes idle and takes about a minute to wake, so call `/health` before a demo. The filesystem is ephemeral, so download links also die on restart, redeploy or sleep.

## 9. Tests

```bash
npm test
```

Covers the employee endpoints, `/generate-resume` (structured content in, valid `.docx` out, bold segments, escaping, empty and long content, validation errors, API key), and `/resumes` plus `/downloads` (link works, matches `/generate-resume`, expiry, eviction, 404s).
