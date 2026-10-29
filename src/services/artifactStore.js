const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Short-lived storage for generated resumes, so an agent can be handed a download link
 * instead of raw bytes.
 *
 * Files live in a private temp directory and are deleted when they expire or when more than
 * `maxFiles` exist (oldest first). Render's free tier has an ephemeral filesystem, so nothing
 * survives a restart, redeploy or spin-down; that is acceptable for a practice project and the
 * agent simply regenerates the resume.
 */
function createArtifactStore({
  dir,
  ttlMs = 60 * 60 * 1000,
  maxFiles = 20,
  now = () => Date.now()
} = {}) {
  const root = dir ? path.resolve(dir) : fs.mkdtempSync(path.join(os.tmpdir(), 'resume-artifacts-'));
  fs.mkdirSync(root, { recursive: true });
  if (!dir) process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

  const items = new Map(); // insertion order = oldest first

  function remove(id) {
    const item = items.get(id);
    if (!item) return;
    items.delete(id);
    fs.rmSync(item.file, { force: true });
  }

  function purge() {
    const t = now();
    for (const [id, item] of items) if (item.expiresAt <= t) remove(id);
    while (items.size > maxFiles) remove(items.keys().next().value);
  }

  function describe(id, item) {
    return {
      artifact_id: id,
      file_name: item.fileName,
      content_type: DOCX_MIME,
      size_bytes: item.size,
      sha256: item.sha256,
      expires_at: new Date(item.expiresAt).toISOString()
    };
  }

  return {
    save(buffer, fileName) {
      const id = crypto.randomBytes(16).toString('hex'); // 128 bits: unguessable
      const file = path.join(root, `${id}.docx`);
      fs.writeFileSync(file, buffer);
      const item = {
        fileName,
        file,
        size: buffer.length,
        sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        expiresAt: now() + ttlMs
      };
      items.set(id, item);
      purge();
      return describe(id, item);
    },

    /** Returns { ...metadata, buffer }, or null if the id is unknown or expired. */
    get(id) {
      purge();
      const item = items.get(id);
      if (!item) return null;
      try {
        return { ...describe(id, item), buffer: fs.readFileSync(item.file) };
      } catch {
        items.delete(id);
        return null;
      }
    },

    get size() {
      purge();
      return items.size;
    },

    ttlMs
  };
}

module.exports = { createArtifactStore, DOCX_MIME };
