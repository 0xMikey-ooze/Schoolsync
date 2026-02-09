/**
 * SchoolSync — Canvas LMS parser.
 * Targets: *.instructure.com, canvas.*
 * Pages: People, Roster, Gradebook
 */

export function parseRoster() {
  // Canvas People page — /courses/:id/users
  const rosterItems = document.querySelectorAll('.roster .user_name, .student_roster .student, [class*="RosterUser"]');
  if (rosterItems.length > 0) return parseRosterCards(rosterItems);

  // Canvas Gradebook — table-based
  const table = document.querySelector('.gradebook table, #gradebook_grid, [class*="GradebookGrid"]');
  if (table) return parseGradebookTable(table);

  // Generic table fallback
  const tables = [...document.querySelectorAll('table')];
  const biggest = tables.filter(t => t.rows.length > 3).sort((a, b) => b.rows.length - a.rows.length)[0];
  if (biggest) return parseGenericTable(biggest);

  return [];
}

function parseRosterCards(items) {
  const students = [];
  items.forEach((item, i) => {
    const nameEl = item.querySelector('a, .name, [class*="name"]') || item;
    const name = (nameEl.textContent || '').trim();
    const link = item.querySelector('a[href]') || nameEl;
    let id = '';
    if (link.href) {
      const m = link.href.match(/\/users\/(\d+)/);
      if (m) id = m[1];
    }
    const sisId = item.querySelector('[class*="sis"], [class*="SIS"]')?.textContent?.trim() || '';

    if (name) {
      const parts = name.split(/\s+/);
      students.push({
        sourcedId: sisId || id || `canvas_${name.toLowerCase().replace(/\s+/g, '_')}_${i}`,
        firstName: parts[0],
        lastName: parts.slice(1).join(' '),
      });
    }
  });
  return students;
}

function parseGradebookTable(table) {
  const students = [];
  const rows = table.querySelectorAll('tr, [role="row"]');
  
  rows.forEach((row, i) => {
    if (i === 0) return; // header
    const nameCell = row.querySelector('.student-name, [class*="StudentName"], td:first-child');
    if (!nameCell) return;
    const name = (nameCell.textContent || '').trim();
    const link = nameCell.querySelector('a[href]');
    let id = '';
    if (link) {
      const m = (link.href || '').match(/\/users\/(\d+)/);
      if (m) id = m[1];
    }
    if (name) {
      const parts = name.split(/\s+/);
      students.push({
        sourcedId: id || `canvas_${name.toLowerCase().replace(/\s+/g, '_')}_${i}`,
        firstName: parts[0],
        lastName: parts.slice(1).join(' '),
      });
    }
  });
  return students;
}

function parseGenericTable(table) {
  // Same generic approach as other parsers
  const rows = [...table.rows];
  if (rows.length < 2) return [];
  const students = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r].cells;
    if (!cells || cells.length < 1) continue;
    const text = (cells[0].textContent || '').trim();
    if (text && text.length > 2) {
      const parts = text.split(/[,\s]+/);
      students.push({
        sourcedId: `canvas_${text.toLowerCase().replace(/\s+/g, '_')}_${r}`,
        firstName: parts[parts.length > 1 ? 1 : 0] || '',
        lastName: parts[0] || '',
      });
    }
  }
  return students;
}

export function isSupported() {
  const host = window.location.hostname.toLowerCase();
  return host.includes('instructure.com') || host.includes('canvas');
}
