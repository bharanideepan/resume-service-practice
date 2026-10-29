const express = require('express');
const { createArtifactStore, DOCX_MIME } = require('../services/artifactStore');

const DOWNLOAD_ID = /^[a-f0-9]{32}$/;

/**
 * Download-link flavour of the generator, for agents (which cannot handle raw bytes).
 * Contract: contracts/openapi/resume-generation-api.yaml
 *   POST /resumes          same request body as /generate-resume; returns JSON with a download_url
 *   GET  /downloads/:id    serves the stored .docx (id may end in .docx)
 *
 * /generate-resume is unchanged. This router reuses its validator and generator.
 */
function createResumesRouter({ validatePayload, generateResume, store = createArtifactStore() }) {
  const router = express.Router();

  // Render sets RENDER_EXTERNAL_URL automatically. PUBLIC_BASE_URL overrides it.
  function baseUrl(req) {
    const configured = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL;
    if (configured) return configured.replace(/\/+$/, '');
    const proto = String(req.get('x-forwarded-proto') || req.protocol).split(',')[0].trim();
    return `${proto}://${req.get('host')}`;
  }

  // Same slug rule as /generate-resume, so the file name matches.
  const slugOf = name =>
    name.normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'candidate';

  router.post('/resumes', async (req, res) => {
    try {
      const payload = validatePayload(req.body);
      const buffer = await generateResume(payload);
      const artifact = store.save(buffer, `${slugOf(payload.candidate.name)}-resume.docx`);
      return res.json({
        generation_status: 'generated',
        http_status: 200,
        artifact: { ...artifact, download_url: `${baseUrl(req)}/downloads/${artifact.artifact_id}.docx` }
      });
    } catch (err) {
      console.error('[resumes]', err);
      return res
        .status(err.statusCode || 500)
        .json({ error: err.statusCode ? err.message : 'Resume generation failed. Check the template and service logs.' });
    }
  });

  router.get('/downloads/:id', (req, res) => {
    const id = req.params.id.replace(/\.docx$/, '');
    const found = DOWNLOAD_ID.test(id) ? store.get(id) : null;
    if (!found) {
      return res.status(404).json({ error: 'Download not found or expired. Generate the resume again.' });
    }
    res.setHeader('Content-Type', DOCX_MIME);
    res.setHeader('Content-Disposition', `attachment; filename="${found.file_name}"`);
    res.setHeader('Content-Length', found.buffer.length);
    return res.send(found.buffer);
  });

  return router;
}

module.exports = { createResumesRouter };
