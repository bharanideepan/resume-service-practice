const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const PizZip = require('pizzip');
const app = require('../src/server');

const ROOT = path.join(__dirname, '..');
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const sample = JSON.parse(fs.readFileSync(path.join(ROOT, 'sample-request.json'), 'utf8'));

let server;
let base;
test.before(async () => {
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise(resolve => server.close(resolve)));

const post = (body, url = base) =>
  fetch(`${url}/generate-resume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });

/** Reads a generated .docx: plain text, and the text of every bold run. */
function inspect(buffer) {
  const zip = new PizZip(buffer); // throws if the bytes are not a valid zip
  const xml = zip.file('word/document.xml').asText();
  const runs = [...xml.matchAll(/<w:r[ >][\s\S]*?<\/w:r>/g)].map(m => m[0]);
  const runText = r => [...r.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(m => m[1]).join('');
  const bold = runs.filter(r => /<w:b\/>|<w:b w:val="(1|true)"\/>/.test(r)).map(runText).filter(Boolean);
  const text = [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map(p => runText(p[0])).join('\n');
  return { xml, text, bold, zip };
}

const clone = o => JSON.parse(JSON.stringify(o));
const rt = (...parts) => ({ segments: parts.map(p => (typeof p === 'string' ? { text: p } : { text: p[0], bold: true })) });

test('sample-request.json returns a downloadable, valid .docx', async () => {
  const res = await post(sample);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), DOCX_MIME);
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="arun-kumar-resume.docx"');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(Number(res.headers.get('content-length')), buf.length);
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
  const { text } = inspect(buf);
  for (const expected of ['Arun Kumar', 'Project Alpha', 'Example Retail Client', 'React, Node.js, PostgreSQL', 'Bachelor of Engineering']) {
    assert.ok(text.includes(expected), `missing "${expected}"`);
  }
  assert.ok(!text.includes('{{'), 'unreplaced placeholder left in document');
});

test('structured content: every section lands in the document and bold segments become bold runs', async () => {
  const payload = {
    candidate: { name: 'Test Person', designation: 'Staff Engineer', total_experience: '9+ years of experience', overview: 'Overview line.', email: 'tp@example.com', phone: '+91-1', location: 'Pune, India', linkedin: 'https://linkedin.com/in/tp' },
    resumeContent: {
      summary: rt('Builds ', ['distributed systems'], ' at scale.'),
      skills: [{ category: 'Backend', items: ['Java', 'Kafka'] }],
      highlights: [rt('Led ', ['platform migration'], ' work.')],
      experience: [{ role: 'Staff Engineer', company: 'Ideas2IT', location: 'Chennai', startDate: 'Jan 2020', endDate: 'Present', bullets: [rt('Owned ', ['service reliability'], '.')] }],
      education: [{ qualification: 'B.E.', institution: 'Example Univ', year: '2012', score: '8.1 CGPA' }],
      projects: [{ name: 'Proj X', client: 'ClientCo', domain: 'Fintech', summary: rt('Replaced a ', ['monolith'], '.'), technologies: ['Java', 'Kafka'], responsibilities: [rt('Designed ', ['event streams'], '.')] }]
    }
  };
  const res = await post(payload);
  assert.equal(res.status, 200);
  const { text, bold } = inspect(Buffer.from(await res.arrayBuffer()));
  for (const expected of [
    'Test Person', 'Staff Engineer (9+ years of experience)', 'Overview line.', 'tp@example.com', '+91-1', 'Pune, India', 'https://linkedin.com/in/tp',
    'Backend:', 'Java, Kafka', 'Builds distributed systems at scale.', 'Led platform migration work.',
    'Ideas2IT', 'Chennai', 'Jan 2020 - Present', 'Owned service reliability.',
    'B.E., Example Univ (2012) - 8.1 CGPA',
    'Proj X', 'Client: ClientCo', 'Domain: Fintech', 'Replaced a monolith.', 'Technologies: Java, Kafka', 'Designed event streams.'
  ]) {
    assert.ok(text.includes(expected), `missing "${expected}"`);
  }
  for (const phrase of ['distributed systems', 'platform migration', 'service reliability', 'monolith', 'event streams']) {
    assert.ok(bold.includes(phrase), `"${phrase}" should be a bold run`);
  }
  // Non-bold neighbours stay non-bold.
  assert.ok(!bold.some(b => b.includes('Builds ') || b.includes('Led ')), 'plain text must not be bold');
});

test('summary and highlights do not leak into each other (template scope check)', async () => {
  const payload = clone(sample);
  payload.resumeContent.summary = rt('SUMMARYONLY marker.');
  payload.resumeContent.highlights = [rt('HIGHLIGHTONLY marker.')];
  const { text } = inspect(Buffer.from(await (await post(payload)).arrayBuffer()));
  assert.equal(text.split('SUMMARYONLY marker.').length - 1, 1, 'summary should appear exactly once');
  assert.equal(text.split('HIGHLIGHTONLY marker.').length - 1, 1, 'highlight should appear exactly once');
});

test('plain-string rich text is accepted as well as segments', async () => {
  const payload = clone(sample);
  payload.resumeContent.summary = 'A plain string summary.';
  payload.resumeContent.highlights = ['A plain highlight.'];
  const res = await post(payload);
  assert.equal(res.status, 200);
  const { text } = inspect(Buffer.from(await res.arrayBuffer()));
  assert.ok(text.includes('A plain string summary.'));
  assert.ok(text.includes('A plain highlight.'));
});

test('special characters are escaped and the document stays valid XML; unicode survives', async () => {
  const payload = clone(sample);
  payload.candidate.name = 'Zoë O\'Brien-Núñez';
  payload.resumeContent.highlights = [rt('R&D <b>"quoted"</b> & it\'s 日本語 ')];
  const res = await post(payload);
  assert.equal(res.status, 200);
  // Current behaviour: NFKD splits accents into combining marks, which the slug regex turns into hyphens
  // ("zoe-o-brien-nu-n-ez"). Safe and ASCII-only, just not pretty. Pinned here so a change is noticed.
  const disposition = res.headers.get('content-disposition');
  assert.match(disposition, /^attachment; filename="[a-z0-9-]+-resume\.docx"$/);
  assert.equal(disposition, 'attachment; filename="zoe-o-brien-nu-n-ez-resume.docx"');
  const { xml, text } = inspect(Buffer.from(await res.arrayBuffer()));
  assert.ok(xml.includes('R&amp;D &lt;b&gt;'), 'ampersand and angle brackets must be escaped');
  assert.ok(text.includes('日本語'));
  assert.ok(text.includes('Zoë'));
});

test('optional and empty content renders without error and without leftover placeholders', async () => {
  const payload = { candidate: { name: 'Min Imal' }, resumeContent: {} };
  const res = await post(payload);
  assert.equal(res.status, 200);
  const { text } = inspect(Buffer.from(await res.arrayBuffer()));
  assert.ok(text.includes('Min Imal'));
  assert.ok(!text.includes('{{') && !text.includes('undefined') && !text.includes('null'));
});

test('a long resume (many projects and bullets) renders', async () => {
  const payload = clone(sample);
  const proj = payload.resumeContent.projects[0];
  payload.resumeContent.projects = Array.from({ length: 12 }, (_, i) => ({ ...clone(proj), name: `Long Project ${i + 1}` }));
  payload.resumeContent.projects.forEach(p => { p.responsibilities = Array.from({ length: 10 }, (_, j) => rt(`Bullet ${j + 1} for ${p.name}.`)); });
  const res = await post(payload);
  assert.equal(res.status, 200);
  const { text } = inspect(Buffer.from(await res.arrayBuffer()));
  assert.ok(text.includes('Long Project 12') && text.includes('Bullet 10 for Long Project 12.'));
});

test('invalid requests are rejected with a JSON error, not a file', async () => {
  const cases = [
    [{ resumeContent: {} }, 'candidate is required.'],
    [{ candidate: { name: 'X' } }, 'resumeContent is required.'],
    [[], 'Request body must be a JSON object.'],
    [{ candidate: 'x', resumeContent: {} }, 'candidate is required.']
  ];
  for (const [body, message] of cases) {
    const res = await post(body);
    assert.equal(res.status, 400);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.equal((await res.json()).error, message);
  }
});

test('API key: with API_KEY set, requests without the bearer token get 401 and with it get the file', async () => {
  const port = 39000 + Math.floor(Math.random() * 500);
  const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), API_KEY: 'test-secret' } });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('server did not start')), 5000);
      child.stdout.on('data', d => { if (String(d).includes('listening')) { clearTimeout(t); resolve(); } });
      child.on('error', reject);
    });
    const url = `http://127.0.0.1:${port}`;
    assert.equal((await post(sample, url)).status, 401);
    assert.equal((await fetch(`${url}/employees?name=Raj`)).status, 401);
    const ok = await fetch(`${url}/generate-resume`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test-secret' }, body: JSON.stringify(sample) });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), DOCX_MIME);
    const emp = await fetch(`${url}/employees?name=Raj`, { headers: { authorization: 'Bearer test-secret' } });
    assert.equal(emp.status, 200);
  } finally {
    child.kill();
  }
});
