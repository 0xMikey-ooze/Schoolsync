/**
 * SchoolSync — Clever portal parser.
 * Targets: *.clever.com
 * Pages: Student directory, class rosters, teacher dashboard
 */

const TABLE_SELECTORS = [
  'table.students-table',
  'table[data-testid="students-table"]',
  '.roster-list table',
  '.student-list table',
  '#main-content table',
];

const COLUMN_PATTERNS = {
  sourcedId: /^(sis.?id|student.?id|clever.?id|id)$/i,
  lastName: /^(last.?name|surname)$/i,
  firstName: /^(first.?name|given)$/i,
  gradeLevel: /^(grade|gr)$/i,
  homeRoom: /^(section|homeroom|class)$/i,
  email: /^(email|e.?mail)$/i,
  schoolId: /^(school)$/i,
};

export function parseRoster() {
  // Clever also uses card/list views — handle both
  const students = parseTable() || parseCards();
  return students;
}

function parseTable() {
  let table = null;
  for (const sel of TABLE_SELECTORS) {
    table = document.querySelector(sel);
    if (table) break;
  }
  if (!table) {
    const tables = [...document.querySelectorAll('table')];
    table = tables.filter(t => t.rows.length > 3).sort((a, b) => b.rows.length - a.rows.length)[0];
  }
  if (!table || table.rows.length < 2) return null;

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

  if (Object.keys(mapping).length === 0) return null;

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
      } else {
        record[field] = (cell.textContent || '').trim();
      }
    }
    if (record.firstName || record.lastName) {
      if (!record.sourcedId) record.sourcedId = `cl_${(record.lastName || '').toLowerCase()}_${(record.firstName || '').toLowerCase()}_${r}`;
      students.push(record);
    }
  }
  return students.length > 0 ? students : null;
}

function parseCards() {
  // Clever sometimes uses card/tile layouts
  const cards = document.querySelectorAll('[class*="student-card"], [class*="StudentCard"], [data-testid*="student"]');
  if (cards.length === 0) return [];

  const students = [];
  cards.forEach((card, i) => {
    const name = card.querySelector('[class*="name"], h3, h4, .title')?.textContent?.trim() || '';
    const grade = card.querySelector('[class*="grade"]')?.textContent?.trim() || '';
    const id = card.getAttribute('data-id') || card.getAttribute('data-student-id') || '';

    if (name) {
      const parts = name.split(/\s+/);
      students.push({
        sourcedId: id || `cl_${name.toLowerCase().replace(/\s+/g, '_')}_${i}`,
        firstName: parts[0] || '',
        lastName: parts.slice(1).join(' '),
        gradeLevel: grade,
      });
    }
  });
  return students;
}

export function isSupported() {
  return window.location.hostname.toLowerCase().includes('clever.com');
}
