const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/server');

let server;
let base;

test.before(async () => {
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise(resolve => server.close(resolve)));

const get = async path => {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json() };
};

test('GET /health still works', async () => {
  const { status, body } = await get('/health');
  assert.equal(status, 200);
  assert.deepEqual(body, { status: 'ok' });
});

test('search by exact name returns one summary', async () => {
  const { status, body } = await get('/employees?name=Rajkumar');
  assert.equal(status, 200);
  assert.equal(body.count, 1);
  assert.deepEqual(body.results[0], {
    employee_id: 'I2I-1042', name: 'Rajkumar', designation: 'Senior Software Engineer', data_source: 'Mock'
  });
});

test('search is case-insensitive and partial; ambiguous names return every match', async () => {
  const { body } = await get('/employees?name=arun');
  assert.equal(body.count, 2);
  assert.deepEqual(body.results.map(r => r.employee_id), ['I2I-1077', 'I2I-1090']);
  // summaries only: no profile or assignment data leaks into search results
  for (const r of body.results) assert.deepEqual(Object.keys(r).sort(), ['data_source', 'designation', 'employee_id', 'name']);
});

test('search by employee_id; both filters must match when both are given', async () => {
  assert.equal((await get('/employees?employee_id=I2I-1118')).body.count, 1);
  assert.equal((await get('/employees?employee_id=I2I-1118&name=Priya')).body.count, 1);
  assert.equal((await get('/employees?employee_id=I2I-1118&name=Rajkumar')).body.count, 0);
});

test('search with no match returns count 0, not an error', async () => {
  const { status, body } = await get('/employees?name=Nobody');
  assert.equal(status, 200);
  assert.deepEqual(body, { count: 0, results: [] });
});

test('search honours limit and rejects invalid input with 400', async () => {
  assert.equal((await get('/employees?name=a&limit=2')).body.results.length, 2);
  for (const q of ['', '?limit=5', '?name=%20%20', '?employee_id=1042', '?name=a&limit=0', '?name=a&limit=51', '?name=a&limit=x']) {
    const { status, body } = await get('/employees' + q);
    assert.equal(status, 400, `expected 400 for "${q}"`);
    assert.equal(typeof body.error, 'string');
  }
});

test('GET /employees/:id returns profile plus all assignments, newest first', async () => {
  const { status, body } = await get('/employees/I2I-1118');
  assert.equal(status, 200);
  assert.equal(body.employee.name, 'Priya Raghavan');
  assert.equal(body.assignments.length, 4);
  const starts = body.assignments.map(a => a.start_date);
  assert.deepEqual(starts, [...starts].sort().reverse());
  assert.ok(body.assignments.every(a => a.employee_id === 'I2I-1118'));
});

test('the original agent example (Rajkumar) is preserved', async () => {
  const { body } = await get('/employees/I2I-1042');
  assert.equal(body.employee.total_experience_years, 6.5);
  assert.deepEqual(body.assignments.map(a => a.assignment_id), ['PA-1001', 'PA-1002']);
  assert.equal(body.assignments[0].end_date, null);
});

test('assignments endpoint filters by status', async () => {
  const all = await get('/employees/I2I-1118/assignments');
  assert.equal(all.body.count, 4);
  const active = await get('/employees/I2I-1118/assignments?status=Active');
  assert.deepEqual(active.body.assignments.map(a => a.assignment_id), ['PA-4003', 'PA-4004']);
  assert.ok(active.body.assignments.every(a => a.status === 'Active'));
  const completed = await get('/employees/I2I-1118/assignments?status=Completed');
  assert.equal(completed.body.count, 2);
});

test('unknown employee is 404; malformed id and status are 400', async () => {
  assert.equal((await get('/employees/I2I-9999')).status, 404);
  assert.equal((await get('/employees/I2I-9999/assignments')).status, 404);
  assert.equal((await get('/employees/abc')).status, 400);
  assert.equal((await get('/employees/I2I-1042/assignments?status=Bogus')).status, 400);
});

test('every record is flagged as mock data', async () => {
  for (const id of ['I2I-1042', 'I2I-1077', 'I2I-1090', 'I2I-1103', 'I2I-1118', 'I2I-1131', 'I2I-1150']) {
    const { body } = await get(`/employees/${id}`);
    assert.equal(body.employee.data_source, 'Mock');
    assert.ok(body.assignments.every(a => a.data_source === 'Mock'));
  }
});

test('dataset is internally consistent', async () => {
  const today = '2026-10-28';
  for (const id of ['I2I-1042', 'I2I-1077', 'I2I-1090', 'I2I-1103', 'I2I-1118', 'I2I-1131', 'I2I-1150']) {
    const { employee, assignments } = (await get(`/employees/${id}`)).body;
    for (const a of assignments) {
      assert.match(a.start_date, /^\d{4}-\d{2}-\d{2}$/);
      if (a.end_date === null) assert.equal(a.status, 'Active', `${a.assignment_id}: open-ended must be Active`);
      else {
        assert.ok(a.end_date >= a.start_date, `${a.assignment_id}: end before start`);
        assert.equal(a.status, 'Completed', `${a.assignment_id}: has end_date but is ${a.status}`);
      }
      assert.ok(a.start_date <= today, `${a.assignment_id}: starts in the future`);
      if (employee.date_of_joining) {
        assert.ok(a.start_date >= employee.date_of_joining, `${a.assignment_id}: starts before joining`);
      }
    }
  }
});

test('demo candidate I2I-1150 has 4 projects with 7+ facts each and 3 to 4 skills per stack', async () => {
  const { employee, assignments } = (await get('/employees/I2I-1150')).body;
  assert.equal(employee.name, 'Ananya Krishnan');
  assert.equal(assignments.length, 4);
  for (const a of assignments) {
    assert.ok(a.responsibilities.length >= 7, `${a.assignment_id} has only ${a.responsibilities.length} responsibilities`);
    assert.ok(a.description.split(/(?<=[.!?])\s+/).length >= 2, `${a.assignment_id} description should be 2+ sentences`);
    assert.ok(a.verified_technologies.length >= 4, `${a.assignment_id} lists too few technologies`);
  }
  // 13 primary skills = four stacks of 3 to 4 (languages, cloud, processing, storage), every one backed by a project.
  assert.ok(employee.primary_skills.length >= 12 && employee.primary_skills.length <= 16);
  const used = new Set(assignments.flatMap(a => a.verified_technologies));
  for (const s of employee.primary_skills) assert.ok(used.has(s), `profile skill ${s} has no project evidence`);
  // Every technology used on a project is also in the profile skills.
  const profile = new Set(employee.primary_skills);
  for (const a of assignments) for (const t of a.verified_technologies) assert.ok(profile.has(t), `${t} missing from profile skills`);
  // Joined 2020 after 3.6 years elsewhere: profile total must be consistent with the dates.
  assert.ok(employee.total_experience_years >= 10 && employee.total_experience_years <= 10.5);
  assert.equal(employee.prior_employment.length, 1);
  // Overlaps are intentional (guild runs alongside projects), so the test data exercises overlap handling.
  assert.ok(assignments.filter(a => a.end_date === null).length === 2);
});
