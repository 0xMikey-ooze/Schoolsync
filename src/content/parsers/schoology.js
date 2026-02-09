/**
 * SchoolSync — Schoology (PowerSchool Unified Classroom) parser.
 * Targets: *.schoology.com, app.schoology.com
 * LMS with roster data.
 */

export function parseRoster() {
  // Schoology uses React — look for member lists
  const memberLists = document.querySelectorAll('.enrollment-list, .members-list, [class*="MemberList"], [class*="roster"]');
  
  // Try table format first
  const tables = [...document.querySelectorAll('table')];
  const table = tables.filter(t => t.rows.length > 3).sort((a, b) => b.rows.length - a.rows.length)[0];
  
  if (table) return parseTable(table);
  
  // Card/list format
  const items = document.querySelectorAll('.enrollment-list li, .members-list li, [class*="member-item"], [class*="UserRow"]');
  if (items.length > 0) return parseList(items);

  return [];
}

function parseTable(table) {
  const rows = [...table.rows];
  const mapping = {};
  const patterns = {
    sourcedId: /^(id|sis|student)$/i,
    lastName: /^(last)$/i,
    firstName: /^(first)$/i,
    gradeLevel: /^(grade)$/i,
    email: /^(email)$/i,
  };

  const headerCells = rows[0].querySelectorAll('th, td');
  for (let i = 0; i < headerCells.length; i++) {
    const text = (headerCells[i].textContent || '').trim();
    for (const [field, pattern] of Object.entries(patterns)) {
      if (pattern.test(text)) { mapping[i] = field; break; }
    }
    if (!mapping[i] && /^(name)$/i.test(text)) mapping[i] = '_combinedName';
  }

  const students = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r].querySelectorAll('td');
    const record = {};
    for (const [colIdx, field] of Object.entries(mapping)) {
      const cell = cells[parseInt(colIdx)];
      if (!cell) continue;
      if (field === '_combinedName') {
        const text = (cell.textContent || '').trim();
        const parts = text.split(/\s+/);
        record.firstName = parts[0]; record.lastName = parts.slice(1).join(' ');
      } else {
        record[field] = (cell.textContent || '').trim();
      }
    }
    if (record.firstName || record.lastName) {
      if (!record.sourcedId) record.sourcedId = `sc_${(record.lastName || '').toLowerCase()}_${(record.firstName || '').toLowerCase()}_${r}`;
      students.push(record);
    }
  }
  return students;
}

function parseList(items) {
  const students = [];
  items.forEach((item, i) => {
    const name = item.querySelector('.name, [class*="Name"], a')?.textContent?.trim() || '';
    const link = item.querySelector('a[href]');
    let id = '';
    if (link) {
      const m = (link.href || '').match(/\/user\/(\d+)/i);
      if (m) id = m[1];
    }
    if (name) {
      const parts = name.split(/\s+/);
      students.push({
        sourcedId: id || `sc_${name.toLowerCase().replace(/\s+/g, '_')}_${i}`,
        firstName: parts[0],
        lastName: parts.slice(1).join(' '),
      });
    }
  });
  return students;
}

export function isSupported() {
  return window.location.hostname.toLowerCase().includes('schoology');
}
