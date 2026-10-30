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
    'B.E., Example Univ (2012) - 8.1 CGPA',
    'Proj X', 'Client: ClientCo', 'Domain: Fintech', 'Replaced a monolith.', 'Technologies: Java, Kafka', 'Designed event streams.'
  ]) {
    assert.ok(text.includes(expected), `missing "${expected}"`);
  }
  for (const phrase of ['distributed systems', 'platform migration', 'monolith', 'event streams']) {
    assert.ok(bold.includes(phrase), `"${phrase}" should be a bold run`);
  }
  // Employer-level experience is accepted but intentionally not rendered (keeps page 1 to one page).
  for (const hidden of ['Jan 2020 - Present', 'Owned service reliability.', 'Chennai']) {
    assert.ok(!text.includes(hidden), `experience content "${hidden}" must not be rendered`);
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

/** Paragraphs of the right-hand cell of the main table ("Professional summary and Key highlights"). */
function rightCellParagraphs(buffer) {
  const xml = new PizZip(buffer).file('word/document.xml').asText();
  const main = xml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g).find(t => t.includes('Professional summary and Key highlights'));
  const cell = main.match(/<w:tc>[\s\S]*?<\/w:tc>/g)[1];
  return cell.match(/<w:p[ >](?:(?!<w:p[ >])[\s\S])*?<\/w:p>/g).map(p => ({
    text: [...p.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(m => m[1]).join(''),
    bullet: /<w:numPr>/.test(p)
  }));
}

test('page 1 right column: bullets only (summary folded in as the first bullet), with no experience and no blank lines between bullets', async () => {
  const payload = clone(sample);
  payload.resumeContent.summary = rt('SUMMARY LINE');
  payload.resumeContent.highlights = Array.from({ length: 8 }, (_, i) => rt(`Highlight bullet ${i + 1}.`));
  payload.resumeContent.experience = [{ role: 'EXPERIENCE_ROLE', company: 'EXPERIENCE_CO', startDate: '2020', endDate: 'Present', bullets: [rt('EXPERIENCE_BULLET')] }];
  const res = await post(payload);
  assert.equal(res.status, 200);
  const paras = rightCellParagraphs(Buffer.from(await res.arrayBuffer()));

  const texts = paras.map(p => p.text).join('\n');
  assert.ok(!texts.includes('EXPERIENCE_ROLE') && !texts.includes('EXPERIENCE_BULLET'), 'experience must be ignored');

  const bullets = paras.filter(p => p.bullet);
  // The summary is folded in as the first bullet, followed by the 8 highlights.
  assert.equal(bullets.length, 9);
  assert.deepEqual(bullets.map(b => b.text), ['SUMMARY LINE', ...Array.from({ length: 8 }, (_, i) => `Highlight bullet ${i + 1}.`)]);

  // Between the summary and the last bullet there must be nothing but the bullets themselves.
  const first = paras.findIndex(p => p.bullet);
  const last = paras.map(p => p.bullet).lastIndexOf(true);
  assert.ok(paras.slice(first, last + 1).every(p => p.bullet), 'blank paragraphs left between bullets');
  // Nothing but the section headings may come before the first bullet: no summary paragraph, no blank line.
  assert.deepEqual(paras.slice(0, first).map(p => p.text.trim()).filter(Boolean), ['EXPERIENCE', 'Professional summary and Key highlights']);
  assert.ok(paras.slice(0, first).every(p => !p.bullet));
  assert.equal(paras[first - 1].text, ' Professional summary and Key highlights');
  // Only the cell's mandatory trailing paragraph may follow the last bullet.
  assert.ok(paras.length - 1 - last <= 1, 'extra empty paragraphs after the bullets');
});

test('project details keep their blank-free bullet lists and the PROJECT DETAILS page break', async () => {
  const payload = clone(sample);
  payload.resumeContent.projects = [{ name: 'P1', client: 'C', domain: 'D', summary: rt('Desc.'), technologies: ['A'], responsibilities: Array.from({ length: 7 }, (_, i) => rt(`Resp ${i + 1}.`)) }];
  const res = await post(payload);
  const { text, xml } = inspect(Buffer.from(await res.arrayBuffer()));
  for (let i = 1; i <= 7; i += 1) assert.ok(text.includes(`Resp ${i}.`));
  assert.match(xml, /<w:pageBreakBefore\/>[\s\S]{0,1500}PROJECT DETAILS/);
});

test('an empty summary adds no bullet and no blank paragraph', async () => {
  const payload = clone(sample);
  payload.resumeContent.summary = rt('   ');
  payload.resumeContent.highlights = [rt('Only highlight.')];
  const paras = rightCellParagraphs(Buffer.from(await (await post(payload)).arrayBuffer()));
  assert.deepEqual(paras.filter(p => p.bullet).map(p => p.text), ['Only highlight.']);
  const first = paras.findIndex(p => p.bullet);
  assert.equal(paras[first - 1].text, ' Professional summary and Key highlights');
});

test('demo payload (Ananya): 8 page-1 bullets, 4 projects with 7+ bullets, no experience section', async () => {
  const demo = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ananya-payload.json'), 'utf8'));
  const res = await post(demo);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="ananya-krishnan-resume.docx"');
  const buf = Buffer.from(await res.arrayBuffer());
  const paras = rightCellParagraphs(buf);
  assert.equal(paras.filter(p => p.bullet).length, 8, 'summary + 7 highlights');
  const { text, xml } = inspect(buf);
  for (const project of ['Healthcare Data Platform', 'Regulatory Reporting Pipeline', 'Clinical Trials Data Lake', 'Data Engineering Guild']) {
    assert.ok(text.includes(project), `missing project ${project}`);
  }
  // Count bullets per project from the PROJECT DETAILS part of the document.
  const details = xml.slice(xml.indexOf('PROJECT DETAILS'));
  const projectParas = details.match(/<w:p[ >](?:(?!<w:p[ >])[\s\S])*?<\/w:p>/g).map(p => ({
    t: [...p.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(m => m[1]).join(''), b: /<w:numPr>/.test(p)
  }));
  const counts = []; let n = -1;
  for (const p of projectParas) {
    if (/^Client: /.test(p.t)) { counts.push(0); n += 1; } else if (p.b && n >= 0) counts[n] += 1;
  }
  assert.equal(counts.length, 4);
  assert.ok(counts.every(c => c >= 7), `each project needs 7+ bullets, got ${counts}`);
  assert.ok(!/Ideas2IT\s*\|/.test(text), 'no employer-level experience entry');
  assert.ok(!text.includes('Terraform .'), 'no stray space before punctuation');
});
