const express = require('express');
const { createEmployeeStore, httpError } = require('../services/employeeStore');

const EMPLOYEE_ID_PATTERN = /^I2I-\d+$/;
const STATUSES = ['Active', 'Completed', 'On Hold'];

/**
 * Read-only Employee Data API. Contract: contracts/openapi/employee-data-api.yaml
 *   GET /employees?name=&employee_id=&limit=
 *   GET /employees/:employeeId
 *   GET /employees/:employeeId/assignments?status=
 */
function createEmployeeRouter(store = createEmployeeStore()) {
  const router = express.Router();

  const first = value => (Array.isArray(value) ? value[0] : value);

  function parseEmployeeId(value) {
    if (typeof value !== 'string' || !EMPLOYEE_ID_PATTERN.test(value)) {
      throw httpError(400, 'employee_id must look like I2I-1042.');
    }
    return value;
  }

  router.get('/employees', (req, res, next) => {
    try {
      const name = first(req.query.name);
      const employeeId = first(req.query.employee_id);
      const limitRaw = first(req.query.limit);

      if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
        throw httpError(400, 'name must be a non-empty string.');
      }
      if (employeeId !== undefined) parseEmployeeId(employeeId);
      if (name === undefined && employeeId === undefined) {
        throw httpError(400, 'Provide name or employee_id.');
      }

      let limit = 10;
      if (limitRaw !== undefined) {
        limit = Number(limitRaw);
        if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
          throw httpError(400, 'limit must be an integer between 1 and 50.');
        }
      }

      res.json(store.search({ name, employee_id: employeeId, limit }));
    } catch (err) {
      next(err);
    }
  });

  router.get('/employees/:employeeId', (req, res, next) => {
    try {
      const id = parseEmployeeId(req.params.employeeId);
      const bundle = store.getBundle(id);
      if (!bundle) throw httpError(404, 'Employee not found.');
      res.json(bundle);
    } catch (err) {
      next(err);
    }
  });

  router.get('/employees/:employeeId/assignments', (req, res, next) => {
    try {
      const id = parseEmployeeId(req.params.employeeId);
      const status = first(req.query.status);
      if (status !== undefined && !STATUSES.includes(status)) {
        throw httpError(400, `status must be one of: ${STATUSES.join(', ')}.`);
      }
      const result = store.getAssignments(id, status);
      if (!result) throw httpError(404, 'Employee not found.');
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // Errors from this router come back as { error } like the rest of the service.
  router.use((err, _req, res, _next) => {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    console.error('[employees]', err);
    return res.status(500).json({ error: 'Employee lookup failed.' });
  });

  return router;
}

module.exports = { createEmployeeRouter };
