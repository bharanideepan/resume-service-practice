const express = require('express');
const path = require('node:path');
const { generateResume } = require('./services/resumeGenerator');
const { createEmployeeRouter } = require('./routes/employees');
const { createResumesRouter } = require('./routes/resumes');
const { createArtifactStore } = require('./services/artifactStore');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.API_KEY || '';
app.use(express.json({ limit: '1mb' }));

// Optional bearer-token protection. Set API_KEY before exposing the service.
app.use((req, res, next) => {
  if (!API_KEY) return next(); // convenient for local development only
  if (req.path.startsWith('/downloads/')) return next(); // links are opened by browsers, which cannot send the header; ids are unguessable
  if (req.headers.authorization !== `Bearer ${API_KEY}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Employee Data API (mock data for now). Shares the auth middleware above.
app.use(createEmployeeRouter());

// Download-link variant of /generate-resume for agents: POST /resumes, GET /downloads/:id.
app.use(createResumesRouter({
  validatePayload,
  generateResume,
  store: createArtifactStore({
    ttlMs: Number(process.env.ARTIFACT_TTL_MINUTES || 60) * 60 * 1000,
    maxFiles: Number(process.env.ARTIFACT_MAX_FILES || 20)
  })
}));

app.post('/generate-resume', async (req, res) => {
  try {
    const payload = validatePayload(req.body);
    const buffer = await generateResume(payload);
    const slug = payload.candidate.name.normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'candidate';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${slug}-resume.docx"`);
    res.setHeader('Content-Length', buffer.length);
    return res.send(buffer);
  } catch (err) {
    console.error('[generate-resume]', err);
    return res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Resume generation failed. Check the template and service logs.' });
  }
});


function validatePayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw httpError(400, 'Request body must be a JSON object.');
  }

  if (!body.candidate || typeof body.candidate !== 'object') {
    throw httpError(400, 'candidate is required.');
  }

  if (!body.resumeContent || typeof body.resumeContent !== 'object') {
    throw httpError(400, 'resumeContent is required.');
  }

  const c = body.candidate;
  const content = body.resumeContent;

  const str = value =>
    typeof value === 'string' || typeof value === 'number'
      ? String(value)
      : '';

  const arr = value => Array.isArray(value) ? value : [];

  // Accept either a plain string or { segments: [...] }.
  function normalizeRichText(value) {
    const segments = typeof value === 'string'
      ? [{ text: value, bold: false }]
      : arr(value?.segments).map(segment => ({
          text: str(segment?.text),
          bold: segment?.bold === true
        }));

    return { segments };
  }

  return {
    candidate: {
      name: str(c.name).trim(),
      designation: str(c.designation).trim(),

      // Support both the original JSON and template field names.
      total_experience: str(
        c.total_experience ?? c.experienceSummary
      ),
      experienceSummary: str(
        c.experienceSummary ?? c.total_experience
      ),

      overview: str(
        c.overview ??
        (typeof content.summary === 'string'
          ? content.summary
          : arr(content.summary?.segments)
              .map(segment => str(segment?.text))
              .join(''))
      ),

      contact: str(c.contact),
      email: str(c.email),
      phone: str(c.phone),
      location: str(c.location),
      linkedin: str(c.linkedin)
    },

    resumeContent: {
      summary: normalizeRichText(content.summary),

      skills: arr(content.skills).map(skill => {
        const items = arr(skill?.items).map(str);
        return {
          category: str(skill?.category),
          items,
          displayItems: items.join(', ')
        };
      }),

      highlights: arr(content.highlights).map(normalizeRichText),

      experience: arr(content.experience).map(experience => ({
        role: str(experience?.role),
        company: str(experience?.company),
        location: str(experience?.location),
        startDate: str(experience?.startDate),
        endDate: str(experience?.endDate),
        bullets: arr(experience?.bullets).map(normalizeRichText)
      })),

      education: arr(content.education).map(education => ({
        qualification: str(education?.qualification),
        institution: str(education?.institution),
        year: str(education?.year),
        score: str(education?.score)
      })),

      projects: arr(content.projects).map(project => {
        const technologies = arr(project?.technologies).map(str);

        return {
          name: str(project?.name),
          client: str(project?.client),
          domain: str(project?.domain),
          summary: normalizeRichText(project?.summary),
          technologies,
          technologiesText: technologies.join(', '),
          responsibilities: arr(project?.responsibilities)
            .map(normalizeRichText)
        };
      })
    }
  };
}

function httpError(statusCode, message) { const e = new Error(message); e.statusCode = statusCode; return e; }

// Only listen when run directly, so tests can import the app.
if (require.main === module) {
  app.listen(PORT, () => console.log(`Resume generation service listening on http://localhost:${PORT}; template=${path.resolve(process.env.RESUME_TEMPLATE_PATH || 'templates/resume-template.docx')}`));
}

module.exports = app;
