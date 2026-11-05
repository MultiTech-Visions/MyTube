'use strict';

/**
 * Small shared helpers for the HTTP function. Nothing here swallows errors:
 * anything unexpected is thrown as an HttpError and surfaces to the client
 * as a JSON error with the real message.
 */

class HttpError extends Error {
  /**
   * @param {number} status HTTP status to send to the client
   * @param {string} code   stable machine-readable code (e.g. 'SESSION_LOST')
   * @param {string} message human-readable message
   * @param {*} [detail]    anything useful for debugging (upstream body, path...)
   */
  constructor(status, code, message, detail) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/** Reads a required nested value; throws naming the full path when it is missing. */
function need(root, path, label) {
  const parts = path.split('.');
  let cur = root;
  for (const part of parts) {
    const key = /^\d+$/.test(part) ? Number(part) : part;
    if (cur === null || cur === undefined || !(key in Object(cur))) {
      throw new HttpError(
        502,
        'UPSTREAM_SHAPE_CHANGED',
        `${label}: expected "${path}" in the YouTube response but "${part}" was missing`,
        { path }
      );
    }
    cur = cur[key];
  }
  return cur;
}

/** Reads an optional nested value; returns undefined when any step is missing. Only for genuinely optional fields. */
function opt(root, path) {
  const parts = path.split('.');
  let cur = root;
  for (const part of parts) {
    const key = /^\d+$/.test(part) ? Number(part) : part;
    if (cur === null || cur === undefined || !(key in Object(cur))) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** Collects a JSON request body (the functions framework already parses JSON into req.body). */
function jsonBody(req) {
  if (req.body === undefined || req.body === null || typeof req.body !== 'object') {
    throw new HttpError(400, 'BAD_REQUEST', 'Expected a JSON object request body');
  }
  return req.body;
}

/** Requires a string field on an object (query or body). */
function requireString(obj, key, where) {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new HttpError(400, 'BAD_REQUEST', `Missing required ${where} field "${key}"`);
  }
  return v;
}

function sendJson(res, status, payload) {
  res.status(status);
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function sendError(res, err) {
  const status = err instanceof HttpError ? err.status : 500;
  const body = {
    error: {
      code: err instanceof HttpError ? err.code : 'INTERNAL',
      message: err.message,
      detail: err instanceof HttpError ? err.detail : undefined,
    },
  };
  if (!(err instanceof HttpError)) console.error(err);
  if (res.headersSent) {
    // Streaming responses: emit the error as a final line so the client can show it.
    res.end(JSON.stringify(body) + '\n');
    return;
  }
  sendJson(res, status, body);
}

/** Random lowercase alphanumeric string (used for the Lounge "zx" cache-buster). */
function randomId(len) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

module.exports = { HttpError, need, opt, jsonBody, requireString, sendJson, sendError, randomId };
