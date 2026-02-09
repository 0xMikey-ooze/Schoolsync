/**
 * SchoolSync Roster Parser — extracts student data from PowerSchool class roster pages.
 * Target: /teachers/classroster.html and similar list views.
 */

/**
 * @typedef {import('../../lib/capsule-client.js').StudentRecord} StudentRecord
 */

/** Known PowerSchool roster table selectors (multiple versions). */
const TABLE_SELECTORS = [
  'table.linkDescList',
  'table#studentsTable',
  'table.grid',
  '#content-main table',
  '.box-round table',
];

/** Known column header patterns → field mapping. */
const COLUMN_PATTERNS = {
  sourcedId: /^(student.?(?:number|id)|id|sis.?id|sourcedid)$/i,
  lastName: /^(last.?name|surname|family.?name)$/i,
  firstName: /^(first.?name|given.?name|preferred.?name)$/i,
  gradeLevel: /^(grade|gr|grade.?level|year)$/i,
  homeRoom: /^(home.?room|hr|section|room)$/i,
  enrollStatus: /^(status|enroll.?status|enrollment)$/i,
  email: /^(email|e-mail|student.?email)$/i,
  gender: /^(gender|sex)$/i,
  dob: /^(dob|date.?of.?birth|birth.?date|birthday)$/i,
};

/**
 * Find the roster table on the page.
 * @returns {HTMLTableElement|null}
 */
function findTable() {
  for (const sel of TABLE_SELECTORS) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  // Fallback: find largest table with >3 rows
  const tables = [...document.querySelectorAll('table')];
  return tables
    .filter(t => t.rows.length > 3)
    .sort((a, b) => b.rows.length - a.rows.length)[0] || null;
}

/**
 * Map table headers to field names.
 * @param {HTMLTableRowElement} headerRow
 * @returns {Record<number, string>}
 */
function mapHeaders(headerRow) {
  const mapping = {};
  const cells = headerRow.cells || headerRow.querySelectorAll('th, td');

  for (let i = 0; i < cells.length; i++) {
    const text = (cells[i].textContent || '').trim();
    for (const [field, pattern] of Object.entries(COLUMN_PATTERNS)) {
      if (pattern.test(text)) {
        mapping[i] = field;
        break;
      }
    }
  }

  return mapping;
}

/**
 * Extract a student name from a cell that might contain a link.
 * Handles "Last, First" and "First Last" formats.
 * @param {HTMLTableCellElement} cell
 * @returns {{ firstName: string, lastName: string }}
 */
function parseName(cell) {
  const text = (cell.textContent || '').trim();
  // "Last, First" format
  if (text.includes(',')) {
    const [last, first] = text.split(',').map(s => s.trim());
    return { firstName: first || '', lastName: last || '' };
  }
  // "First Last" format
  const parts = text.split(/\s+/);
  if (parts.length >= 2) {
    return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
  }
  return { firstName: text, lastName: '' };
}

/**
 * Extract sourcedId from a cell — check link href for student ID patterns.
 * @param {HTMLTableCellElement} cell
 * @returns {string}
 */
function extractId(cell) {
  // Check links for student ID in URL
  const link = cell.querySelector('a[href]');
  if (link) {
    const href = link.getAttribute('href') || '';
    const match = href.match(/(?:student(?:id|_id|\.id)?|frn|id)=(\d+)/i)
      || href.match(/\/students\/(\d+)/i);
    if (match) return match[1];
  }
  return (cell.textContent || '').trim();
}

/**
 * Parse the roster table into student records.
 * @returns {StudentRecord[]}
 */
export function parseRoster() {
  const table = findTable();
  if (!table) return [];

  const rows = [...table.rows];
  if (rows.length < 2) return [];

  // Find header row (first row with text matching known patterns)
  let headerIdx = 0;
  let headerMap = mapHeaders(rows[0]);
  if (Object.keys(headerMap).length === 0 && rows.length > 1) {
    headerMap = mapHeaders(rows[1]);
    headerIdx = 1;
  }

  // If we found no name columns, try to detect "Name" as combined field
  const hasName = Object.values(headerMap).some(f => f === 'firstName' || f === 'lastName');
  if (!hasName) {
    const cells = rows[headerIdx].cells || rows[headerIdx].querySelectorAll('th, td');
    for (let i = 0; i < cells.length; i++) {
      const text = (cells[i].textContent || '').trim();
      if (/^(name|student.?name|student)$/i.test(text)) {
        headerMap[i] = '_combinedName';
        break;
      }
    }
  }

  if (Object.keys(headerMap).length === 0) return [];

  const students = [];

  for (let r = headerIdx + 1; r < rows.length; r++) {
    const cells = rows[r].cells || rows[r].querySelectorAll('td');
    if (!cells || cells.length === 0) continue;

    /** @type {Partial<StudentRecord>} */
    const record = {};
    let hasData = false;

    for (const [colIdx, field] of Object.entries(headerMap)) {
      const cell = cells[parseInt(colIdx)];
      if (!cell) continue;

      if (field === '_combinedName') {
        const { firstName, lastName } = parseName(cell);
        record.firstName = firstName;
        record.lastName = lastName;
        // Try to get ID from the name cell's link
        if (!record.sourcedId) {
          const id = extractId(cell);
          if (id && /\d/.test(id)) record.sourcedId = id;
        }
        hasData = true;
      } else if (field === 'sourcedId') {
        record.sourcedId = extractId(cell);
        hasData = true;
      } else {
        const val = (cell.textContent || '').trim();
        if (val) {
          record[field] = val;
          hasData = true;
        }
      }
    }

    if (hasData && (record.firstName || record.lastName)) {
      // Generate a fallback ID if none found
      if (!record.sourcedId) {
        record.sourcedId = `ps_${(record.lastName || '').toLowerCase()}_${(record.firstName || '').toLowerCase()}_${r}`;
      }
      students.push(/** @type {StudentRecord} */ (record));
    }
  }

  return students;
}

/**
 * Check if the current page looks like a roster page.
 * @returns {boolean}
 */
export function isRosterPage() {
  const url = window.location.pathname.toLowerCase();
  if (/classroster|roster|studentlist|students\/list/i.test(url)) return true;
  // Check for a large student table
  const table = findTable();
  return table !== null && table.rows.length > 5;
}
