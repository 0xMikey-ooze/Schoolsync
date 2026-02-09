/**
 * SchoolSync CSV Export Parser — intercepts/parses PowerSchool Quick Export CSVs.
 * Target: /admin/students/export.html and any CSV download from PowerSchool.
 */

/**
 * @typedef {import('../../lib/capsule-client.js').StudentRecord} StudentRecord
 */

/** Column header → field mapping for PowerSchool CSV exports. */
const CSV_COLUMN_MAP = {
  // PowerSchool standard export fields
  'student_number': 'sourcedId',
  'studentnumber': 'sourcedId',
  'student number': 'sourcedId',
  'id': 'sourcedId',
  'student_id': 'sourcedId',
  'dcid': 'sourcedId',
  'last_name': 'lastName',
  'lastname': 'lastName',
  'last name': 'lastName',
  'last': 'lastName',
  'first_name': 'firstName',
  'firstname': 'firstName',
  'first name': 'firstName',
  'first': 'firstName',
  'grade_level': 'gradeLevel',
  'gradelevel': 'gradeLevel',
  'grade level': 'gradeLevel',
  'grade': 'gradeLevel',
  'gr': 'gradeLevel',
  'home_room': 'homeRoom',
  'homeroom': 'homeRoom',
  'home room': 'homeRoom',
  'hr': 'homeRoom',
  'section': 'homeRoom',
  'enroll_status': 'enrollStatus',
  'enrollstatus': 'enrollStatus',
  'enrollment_status': 'enrollStatus',
  'status': 'enrollStatus',
  'student_email': 'email',
  'email': 'email',
  'email_addr': 'email',
  'schoolid': 'schoolId',
  'school_id': 'schoolId',
  'school': 'schoolId',
  'dob': 'dob',
  'date_of_birth': 'dob',
  'dateofbirth': 'dob',
  'gender': 'gender',
  'sex': 'gender',
};

/**
 * Parse a CSV string with proper quote handling (RFC 4180).
 * @param {string} csv
 * @returns {{ headers: string[], rows: string[][] }}
 */
export function parseCSV(csv) {
  const lines = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (ch === '"') {
      if (inQuotes && csv[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      lines.push(current);
      current = '';
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (current || lines.length > 0) {
        lines.push(current);
        current = '';
      }
      if (lines.length > 0) {
        // Yield row
        if (!parseCSV._rows) parseCSV._rows = [];
        parseCSV._rows.push([...lines]);
        lines.length = 0;
      }
      // Skip \r\n
      if (ch === '\r' && csv[i + 1] === '\n') i++;
    } else {
      current += ch;
    }
  }
  // Last field/row
  if (current || lines.length > 0) {
    lines.push(current);
    if (!parseCSV._rows) parseCSV._rows = [];
    parseCSV._rows.push([...lines]);
  }

  const rows = parseCSV._rows || [];
  parseCSV._rows = undefined;

  if (rows.length === 0) return { headers: [], rows: [] };

  const headers = rows[0].map(h => h.trim());
  return { headers, rows: rows.slice(1) };
}

/**
 * Map CSV headers to student record fields.
 * @param {string[]} headers
 * @returns {Record<number, string>}
 */
function mapCSVHeaders(headers) {
  const mapping = {};
  for (let i = 0; i < headers.length; i++) {
    const normalized = headers[i].toLowerCase().trim();
    if (CSV_COLUMN_MAP[normalized]) {
      mapping[i] = CSV_COLUMN_MAP[normalized];
    }
  }
  return mapping;
}

/**
 * Parse a PowerSchool CSV export into student records.
 * @param {string} csvText
 * @returns {StudentRecord[]}
 */
export function parseExportCSV(csvText) {
  // Strip BOM if present
  const clean = csvText.replace(/^\xEF\xBB\xBF/, '');
  const { headers, rows } = parseCSV(clean);

  if (headers.length === 0 || rows.length === 0) return [];

  const mapping = mapCSVHeaders(headers);

  if (Object.keys(mapping).length === 0) return [];

  const students = [];

  for (const row of rows) {
    if (row.length === 0 || row.every(c => !c.trim())) continue;

    /** @type {Partial<StudentRecord>} */
    const record = { extra: {} };

    for (const [colIdx, field] of Object.entries(mapping)) {
      const val = (row[parseInt(colIdx)] || '').trim();
      if (val) {
        record[field] = val;
      }
    }

    // Capture unmapped columns as extra
    for (let i = 0; i < headers.length; i++) {
      if (!mapping[i] && row[i] && row[i].trim()) {
        record.extra[headers[i]] = row[i].trim();
      }
    }

    if (record.firstName || record.lastName) {
      if (!record.sourcedId) {
        record.sourcedId = `ps_${(record.lastName || '').toLowerCase()}_${(record.firstName || '').toLowerCase()}`;
      }
      students.push(/** @type {StudentRecord} */ (record));
    }
  }

  return students;
}

/**
 * Check if the current page is the PowerSchool export page.
 * @returns {boolean}
 */
export function isExportPage() {
  const url = window.location.pathname.toLowerCase();
  return /export|quickexport|data.?export|students\/export/i.test(url);
}

/**
 * Try to intercept a CSV file from the page (download link or textarea).
 * @returns {string|null}
 */
export function findCSVOnPage() {
  // Check for download links
  const links = document.querySelectorAll('a[href*=".csv"], a[href*="export"], a[download]');
  for (const link of links) {
    const href = link.getAttribute('href');
    if (href && /\.csv/i.test(href)) return href;
  }

  // Check for textarea with CSV content
  const textareas = document.querySelectorAll('textarea');
  for (const ta of textareas) {
    if (ta.value && ta.value.includes(',') && ta.value.split('\n').length > 2) {
      return ta.value;
    }
  }

  return null;
}
