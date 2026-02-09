/**
 * SchoolSync — ClassLink / OneRoster portal parser.
 * Targets: *.classlink.com, *.oneroster.com
 */

export function parseRoster() {
  // ClassLink uses React-rendered tables — look for common patterns
  const tables = [...document.querySelectorAll('table, [role="grid"], [role="table"]')];
  const table = tables.filter(t => {
    const rows = t.querySelectorAll('tr, [role="row"]');
    return rows.length > 3;
  }).sort((a, b) => {
    return b.querySelectorAll('tr, [role="row"]').length - a.querySelectorAll('tr, [role="row"]').length;
  })[0];

  if (!table) return [];

  const rows = [...table.querySelectorAll('tr, [role="row"]')];
  if (rows.length < 2) return [];

  // Generic header detection
  const headerCells = rows[0].querySelectorAll('th, td, [role="columnheader"]');
  const mapping = {};
  const patterns = {
    sourcedId: /^(id|sis.?id|student.?id|sourcedid)$/i,
    lastName: /^(last|last.?name|family)$/i,
    firstName: /^(first|first.?name|given)$/i,
    gradeLevel: /^(grade|gr)$/i,
    email: /^(email)$/i,
    homeRoom: /^(section|class|homeroom)$/i,
  };

  for (let i = 0; i < headerCells.length; i++) {
    const text = (headerCells[i].textContent || '').trim();
    for (const [field, pattern] of Object.entries(patterns)) {
      if (pattern.test(text)) { mapping[i] = field; break; }
    }
    if (!mapping[i] && /^(name|student)$/i.test(text)) mapping[i] = '_combinedName';
  }

  if (Object.keys(mapping).length === 0) return [];

  const students = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r].querySelectorAll('td, [role="cell"], [role="gridcell"]');
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
      } else {
        record[field] = (cell.textContent || '').trim();
      }
    }
    if (record.firstName || record.lastName) {
      if (!record.sourcedId) record.sourcedId = `cll_${(record.lastName || '').toLowerCase()}_${(record.firstName || '').toLowerCase()}_${r}`;
      students.push(record);
    }
  }
  return students;
}

export function isSupported() {
  const host = window.location.hostname.toLowerCase();
  return host.includes('classlink') || host.includes('oneroster');
}
