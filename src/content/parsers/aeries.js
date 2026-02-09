/**
 * SchoolSync — Aeries SIS parser.
 * Targets: *.aeries.net, aeries-hosted domains
 * Popular in California school districts.
 */

const TABLE_SELECTORS = [
  '#StudentListGrid table',
  'table.StudentList',
  '#MainContent table',
  '.aeries-grid table',
  'table[id*="Student"]',
];

const COLUMN_PATTERNS = {
  sourcedId: /^(stu.?(?:id|num)|perm.?id|student.?number|id)$/i,
  lastName: /^(last.?name|lname)$/i,
  firstName: /^(first.?name|fname)$/i,
  gradeLevel: /^(gr|grade)$/i,
  homeRoom: /^(hr|homeroom|home.?room|teacher)$/i,
  enrollStatus: /^(status|stat|enroll)$/i,
  email: /^(email)$/i,
  schoolId: /^(school|sch)$/i,
};

export function parseRoster() {
  let table = null;
  for (const sel of TABLE_SELECTORS) {
    table = document.querySelector(sel);
    if (table) break;
  }
  if (!table) {
    const tables = [...document.querySelectorAll('table')];
    table = tables.filter(t => t.rows.length > 3).sort((a, b) => b.rows.length - a.rows.length)[0];
  }
  if (!table || table.rows.length < 2) return [];

  const rows = [...table.rows];
  const headerCells = rows[0].cells || rows[0].querySelectorAll('th, td');
  const mapping = {};

  for (let i = 0; i < headerCells.length; i++) {
    const text = (headerCells[i].textContent || '').trim();
    for (const [field, pattern] of Object.entries(COLUMN_PATTERNS)) {
      if (pattern.test(text)) { mapping[i] = field; break; }
    }
    if (!mapping[i] && /^(name|student)$/i.test(text)) mapping[i] = '_combinedName';
  }

  if (Object.keys(mapping).length === 0) return [];

  const students = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r].cells || rows[r].querySelectorAll('td');
    if (!cells || cells.length === 0) continue;
    const record = {};
    for (const [colIdx, field] of Object.entries(mapping)) {
      const cell = cells[parseInt(colIdx)];
      if (!cell) continue;
      if (field === '_combinedName') {
        const text = (cell.textContent || '').trim();
        if (text.includes(',')) {
          const [last, first] = text.split(',').map(s => s.trim());
          record.firstName = first; record.lastName = last;
        } else {
          const parts = text.split(/\s+/);
          record.firstName = parts[0]; record.lastName = parts.slice(1).join(' ');
        }
        const link = cell.querySelector('a[href]');
        if (link) {
          const m = (link.href || '').match(/(?:ID|STU|perm)=(\d+)/i);
          if (m) record.sourcedId = m[1];
        }
      } else if (field === 'sourcedId') {
        record.sourcedId = (cell.textContent || '').trim();
      } else {
        record[field] = (cell.textContent || '').trim();
      }
    }
    if (record.firstName || record.lastName) {
      if (!record.sourcedId) record.sourcedId = `ae_${(record.lastName || '').toLowerCase()}_${(record.firstName || '').toLowerCase()}_${r}`;
      students.push(record);
    }
  }
  return students;
}

export function isSupported() {
  return window.location.hostname.toLowerCase().includes('aeries');
}
