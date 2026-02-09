/**
 * SchoolSync Capsule Client — pushes parsed student data to Capsule API.
 * All requests over HTTPS. Token never logged or exposed.
 */

import { getToken, capsuleEndpoint } from './storage.js';

const BATCH_SIZE = 50;
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * @typedef {Object} StudentRecord
 * @property {string} sourcedId
 * @property {string} firstName
 * @property {string} lastName
 * @property {string} [gradeLevel]
 * @property {string} [homeRoom]
 * @property {string} [enrollStatus]
 * @property {string} [email]
 * @property {string} [schoolId]
 * @property {Record<string, string>} [extra]
 */

/**
 * Push student records to Capsule API in batches.
 * @param {StudentRecord[]} students
 * @param {string} passphrase - to decrypt token if needed
 * @param {(progress: { sent: number, total: number }) => void} [onProgress]
 * @returns {Promise<{ success: number, failed: number, errors: string[] }>}
 */
export async function syncStudents(students, passphrase, onProgress) {
  const token = await getToken(passphrase);
  if (!token) throw new Error('Not authenticated. Please log in.');

  const endpoint = await capsuleEndpoint();
  if (!endpoint) throw new Error('Capsule endpoint not configured.');

  const result = { success: 0, failed: 0, errors: [] };

  for (let i = 0; i < students.length; i += BATCH_SIZE) {
    const batch = students.slice(i, i + BATCH_SIZE);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      const response = await fetch(`${endpoint}/api/v1/sync/students`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'X-Source': 'schoolsync-extension',
        },
        body: JSON.stringify({ students: batch }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const body = await response.text().catch(() => 'unknown');
        result.failed += batch.length;
        result.errors.push(`Batch ${i / BATCH_SIZE + 1}: HTTP ${response.status} — ${body}`);
      } else {
        result.success += batch.length;
      }
    } catch (err) {
      result.failed += batch.length;
      result.errors.push(`Batch ${i / BATCH_SIZE + 1}: ${err.message}`);
    }

    onProgress?.({ sent: Math.min(i + BATCH_SIZE, students.length), total: students.length });
  }

  return result;
}

/**
 * Test connection to Capsule API.
 * @param {string} endpoint
 * @param {string} token
 * @returns {Promise<boolean>}
 */
export async function testConnection(endpoint, token) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);

    const response = await fetch(`${endpoint}/api/v1/health`, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: controller.signal,
    });

    clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}
