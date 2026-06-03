/**
 * Standardized API response helpers.
 */

export function sendSuccess(res, data) {
  return res.json({ status: 'success', ...data });
}

export function sendError(res, statusCode, message) {
  return res.status(statusCode).json({ status: 'error', message });
}
