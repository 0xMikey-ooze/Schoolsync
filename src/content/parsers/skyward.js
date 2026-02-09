/**
 * SchoolSync — Skyward (Qmlativ + legacy) parser.
 * Targets: *.skyward.com, skyward-hosted domains
 * Pages: Student Browse, Roster, Gradebook
 */

const TABLE_SELECTORS = [
  'table.sfDataTable',
  'table#gridStudents',
  '#dtStud table',
  '.gridContainer table',
  'table.DataGrid',
  '#contentArea table',
];

const COLUMN_PATTERNS = {
  sourcedId: /^(stu.?(?:id|num)|other.?id|id.?number|namelinkid)$/i,
  lastName: /^(last|lname|last.?name)$/i,
  firstName: /^(first|fname|first.?name)$/i,
  gradeLevel: /^(gr|grade|grd)$/i,
  homeRoom: /^(home.?room|hr|room)$/i,
  enrollStatus: /^(status|enroll|entry)$/i,
  email: /^(email|e.?mail)$/i,
  schoolId: /^(school|entity|building)$/i,
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
    if (!mapping[i] && /^(name|student.?name|student)$/i.test(text)) mapping[i] = '_combinedName';
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
          record.firstName = parts[0] || '';
          record.lastName = parts.slice(1).join(' ');
        }
        const link = cell.querySelector('a[href]');
        if (link) {
          const m = (link.href || '').match(/stuID=(\d+)|studentId=(\d+)|\/student\/(\d+)/i);
          if (m) record.sourcedId = m[1] || m[2] || m[3];
        }
      } else if (field === 'sourcedId') {
        record.sourcedId = (cell.textContent || '').trim();
      } else {
        record[field] = (cell.textContent || '').trim();
      }
    }
    if (record.firstName || record.lastName) {
      if (!record.sourcedId) record.sourcedId = `sw_${(record.lastName || '').toLowerCase()}_${(record.firstName || '').toLowerCase()}_${r}`;
      students.push(record);
    }
  }
  return students;
}

export function isSupported() {
  const host = window.location.hostname.toLowerCase();
  return host.includes('skyward');
}
