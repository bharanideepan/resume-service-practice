const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn } = require('node:child_process');
const PizZip = require('pizzip');
// Tests assume no externally configured base URL.
delete process.env.PUBLIC_BASE_URL;
delete process.env.RENDER_EXTERNAL_URL;
const app = require('../src/server');
const { createArtifactStore } = require('../src/services/artifactStore');

const ROOT = path.join(__dirname, '..');
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const sample = JSON.parse(fs.readFileSync(path.join(ROOT, 'sample-request.json'), 'utf8'));
const generatorPayload = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'generator-payload.json'), 'utf8'));

let server;
let base;
test.before(async () => {
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise(resolve => server.close(resolve)));

const postResume = (body, url = base) =>
  fetch(`${url}/resumes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('POST /resumes returns JSON metadata and a working download link', async () => {
  const res = await postResume(generatorPayload);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  const body = await res.json();

  assert.equal(body.generation_status, 'generated');
  assert.equal(body.http_status, 200);
  const a = body.artifact;
  assert.equal(a.file_name, 'rajkumar-resume.docx');
  assert.equal(a.content_type, DOCX_MIME);
  assert.match(a.artifact_id, /^[a-f0-9]{32}$/);
  assert.match(a.sha256, /^[a-f0-9]{64}$/);
  assert.equal(a.download_url, `${base}/downloads/${a.artifact_id}.docx`);
  assert.ok(new Date(a.expires_at) > new Date());

  const file = await fetch(a.download_url);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), DOCX_MIME);
  assert.equal(file.headers.get('content-disposition'), 'attachment; filename="rajkumar-resume.docx"');
  const buf = Buffer.from(await file.arrayBuffer());
  assert.equal(buf.length, a.size_bytes);
  assert.equal(crypto.createHash('sha256').update(buf).digest('hex'), a.sha256);
  const xml = new PizZip(buf).file('word/document.xml').asText();
  assert.ok(xml.includes('Rajkumar') && xml.includes('Healthcare Data Platform'));
});

test('download works with or without the .docx suffix', async () => {
  const { artifact } = await (await postResume(sample)).json();
  assert.equal((await fetch(`${base}/downloads/${artifact.artifact_id}`)).status, 200);
  assert.equal((await fetch(`${base}/downloads/${artifact.artifact_id}.docx`)).status, 200);
});

test('POST /resumes output matches POST /generate-resume content', async () => {
  const viaLink = await (await postResume(sample)).json();
  const linked = Buffer.from(await (await fetch(viaLink.artifact.download_url)).arrayBuffer());
  const direct = Buffer.from(await (await fetch(`${base}/generate-resume`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sample)
  })).arrayBuffer());
  const text = b => new PizZip(b).file('word/document.xml').asText();
  assert.equal(text(linked), text(direct));
});

test('invalid bodies get the same 400 errors as /generate-resume', async () => {
  for (const [body, message] of [
    [{ resumeContent: {} }, 'candidate is required.'],
    [{ candidate: { name: 'X' } }, 'resumeContent is required.'],
    [[], 'Request body must be a JSON object.']
  ]) {
    const res = await postResume(body);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, message);
  }
});

test('unknown, malformed, traversal and expired-looking ids all return 404 JSON', async () => {
  for (const id of ['0'.repeat(32), 'abc', '..%2F..%2Fetc%2Fpasswd', `${'f'.repeat(32)}.docx`, 'G'.repeat(32)]) {
    const res = await fetch(`${base}/downloads/${id}`);
    assert.equal(res.status, 404, id);
    assert.match((await res.json()).error, /not found or expired/);
  }
});

test('public base URL: proxy headers are used when PUBLIC_BASE_URL is unset, and PUBLIC_BASE_URL wins when set', async () => {
  // fetch() ignores a custom Host header, so use a raw http request to simulate Render's proxy.
  const body = JSON.stringify(sample);
  const proxied = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: server.address().port, path: '/resumes', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), host: 'resume-demo.onrender.com', 'x-forwarded-proto': 'https' } },
      res => { let d = ''; res.on('data', c => (d += c)); res.on('end', () => resolve(JSON.parse(d))); }
    );
    req.on('error', reject);
    req.end(body);
  });
  assert.equal(proxied.artifact.download_url, `https://resume-demo.onrender.com/downloads/${proxied.artifact.artifact_id}.docx`);

  const port = 39500 + Math.floor(Math.random() * 400);
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(port), PUBLIC_BASE_URL: 'https://resume-demo.onrender.com/' }
  });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('server did not start')), 5000);
      child.stdout.on('data', d => { if (String(d).includes('listening')) { clearTimeout(t); resolve(); } });
    });
    const r = await (await postResume(sample, `http://127.0.0.1:${port}`)).json();
    assert.equal(r.artifact.download_url, `https://resume-demo.onrender.com/downloads/${r.artifact.artifact_id}.docx`);
  } finally {
    child.kill();
  }
});

test('with API_KEY set: generate and employee routes need the token, downloads do not', async () => {
  const port = 39000 + Math.floor(Math.random() * 400);
  const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), API_KEY: 'k' } });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('server did not start')), 5000);
      child.stdout.on('data', d => { if (String(d).includes('listening')) { clearTimeout(t); resolve(); } });
    });
    const url = `http://127.0.0.1:${port}`;
    assert.equal((await postResume(sample, url)).status, 401);
    const made = await fetch(`${url}/resumes`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer k' }, body: JSON.stringify(sample) });
    assert.equal(made.status, 200);
    const { artifact } = await made.json();
    assert.equal((await fetch(artifact.download_url)).status, 200, 'download link must open without a header');
  } finally {
    child.kill();
  }
});

// ---- artifact store unit tests (no HTTP) ----

test('store: files expire after the TTL and are deleted from disk', () => {
  let t = 1_000_000;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-ttl-'));
  const store = createArtifactStore({ dir, ttlMs: 60_000, now: () => t });
  const a = store.save(Buffer.from('hello'), 'x-resume.docx');
  assert.equal(store.get(a.artifact_id).buffer.toString(), 'hello');
  assert.equal(fs.readdirSync(dir).length, 1);
  t += 59_999;
  assert.ok(store.get(a.artifact_id));
  t += 2;
  assert.equal(store.get(a.artifact_id), null);
  assert.equal(fs.readdirSync(dir).length, 0, 'expired file must be removed from disk');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('store: keeps at most maxFiles, evicting the oldest first', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-max-'));
  const store = createArtifactStore({ dir, maxFiles: 3 });
  const ids = [1, 2, 3, 4, 5].map(n => store.save(Buffer.from(`f${n}`), `f${n}.docx`).artifact_id);
  assert.equal(store.size, 3);
  assert.equal(store.get(ids[0]), null);
  assert.equal(store.get(ids[1]), null);
  assert.deepEqual(ids.slice(2).map(id => store.get(id).buffer.toString()), ['f3', 'f4', 'f5']);
  assert.equal(fs.readdirSync(dir).length, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('store: a file deleted behind its back returns null instead of throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-gone-'));
  const store = createArtifactStore({ dir });
  const a = store.save(Buffer.from('x'), 'x.docx');
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(store.get(a.artifact_id), null);
});
