const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_DATA_PATH = path.join(__dirname, '..', 'data', 'employees.json');

function httpError(statusCode, message) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

/**
 * Read-only employee store backed by a JSON file.
 *
 * The JSON shape is { employees: [...], project_assignments: [...] }, linked by employee_id.
 * Swapping in the real iAssistant database later means replacing this module only;
 * the routes and the response contract (contracts/openapi/employee-data-api.yaml) stay the same.
 */
function createEmployeeStore(dataPath = process.env.EMPLOYEE_DATA_PATH || DEFAULT_DATA_PATH) {
  const raw = JSON.parse(fs.readFileSync(path.resolve(dataPath), 'utf8'));
  const employees = Array.isArray(raw.employees) ? raw.employees : [];
  const assignments = Array.isArray(raw.project_assignments) ? raw.project_assignments : [];

  assertIntegrity(employees, assignments);

  // end_date null sorts as "still ongoing", i.e. newest. Ties break on start_date, then id.
  const byNewest = (a, b) =>
    (b.start_date || '').localeCompare(a.start_date || '') ||
    a.assignment_id.localeCompare(b.assignment_id);

  const assignmentsByEmployee = new Map();
  for (const a of assignments) {
    if (!assignmentsByEmployee.has(a.employee_id)) assignmentsByEmployee.set(a.employee_id, []);
    assignmentsByEmployee.get(a.employee_id).push(a);
  }
  for (const list of assignmentsByEmployee.values()) list.sort(byNewest);

  const summarise = e => ({
    employee_id: e.employee_id,
    name: e.name,
    designation: e.designation,
    data_source: e.data_source
  });

  return {
    /**
     * Case-insensitive, partial name match. If both name and employee_id are given, both must match.
     */
    search({ name, employee_id, limit = 10 } = {}) {
      const needle = typeof name === 'string' ? name.trim().toLowerCase() : '';
      const id = typeof employee_id === 'string' ? employee_id.trim() : '';
      const results = employees
        .filter(e => (!id || e.employee_id === id) && (!needle || e.name.toLowerCase().includes(needle)))
        .sort((a, b) => a.name.localeCompare(b.name) || a.employee_id.localeCompare(b.employee_id))
        .slice(0, limit)
        .map(summarise);
      return { count: results.length, results };
    },

    /** Employee profile plus every assignment, or null when the id is unknown. */
    getBundle(employeeId) {
      const employee = employees.find(e => e.employee_id === employeeId);
      if (!employee) return null;
      return { employee, assignments: assignmentsByEmployee.get(employeeId) || [] };
    },

    /** Assignments for one employee (newest first), optionally filtered by status; null when the id is unknown. */
    getAssignments(employeeId, status) {
      const bundle = this.getBundle(employeeId);
      if (!bundle) return null;
      const list = status ? bundle.assignments.filter(a => a.status === status) : bundle.assignments;
      return { employee_id: employeeId, count: list.length, assignments: list };
    },

    size: { employees: employees.length, assignments: assignments.length }
  };
}

// Fail at startup, not at request time, if the dataset is inconsistent.
function assertIntegrity(employees, assignments) {
  const ids = new Set();
  for (const e of employees) {
    if (!e.employee_id || !e.name) throw new Error('Employee data: every employee needs employee_id and name.');
    if (ids.has(e.employee_id)) throw new Error(`Employee data: duplicate employee_id ${e.employee_id}.`);
    ids.add(e.employee_id);
  }
  const assignmentIds = new Set();
  for (const a of assignments) {
    if (assignmentIds.has(a.assignment_id)) throw new Error(`Employee data: duplicate assignment_id ${a.assignment_id}.`);
    assignmentIds.add(a.assignment_id);
    if (!ids.has(a.employee_id)) {
      throw new Error(`Employee data: assignment ${a.assignment_id} references unknown employee ${a.employee_id}.`);
    }
  }
}

module.exports = { createEmployeeStore, httpError };
