/**
 * SchoolSync Hasher — SHA-256 hashing for student record diffing.
 * Only hashes are stored locally, never PII.
 */

/**
 * Hash a student record to detect changes.
 * @param {import('./capsule-client.js').StudentRecord} student
 * @returns {Promise<string>}
 */
export async function hashStudent(student) {
  const normalized = JSON.stringify({
    id: student.sourcedId,
    fn: student.firstName,
    ln: student.lastName,
    gr: student.gradeLevel || '',
    hr: student.homeRoom || '',
    es: student.enrollStatus || '',
    em: student.email || '',
    si: student.schoolId || '',
  });
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Diff students against stored hashes. Returns only changed/new records.
 * @param {import('./capsule-client.js').StudentRecord[]} students
 * @param {Record<string, string>} existingHashes - { sourcedId: hash }
 * @returns {Promise<{ changed: import('./capsule-client.js').StudentRecord[], newHashes: Record<string, string> }>}
 */
export async function diffStudents(students, existingHashes) {
  const changed = [];
  const newHashes = {};

  for (const student of students) {
    const hash = await hashStudent(student);
    newHashes[student.sourcedId] = hash;
    if (existingHashes[student.sourcedId] !== hash) {
      changed.push(student);
    }
  }

  return { changed, newHashes };
}
