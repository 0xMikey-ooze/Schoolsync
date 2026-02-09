/**
 * SchoolSync Attendance Parser — extracts attendance data from PowerSchool.
 * Target: /teachers/attendance.html and similar views.
 */

/**
 * @typedef {Object} AttendanceRecord
 * @property {string} sourcedId
 * @property {string} studentName
 * @property {string} date
 * @property {string} status - present|absent|tardy|excused
 * @property {string} [period]
 */

const STATUS_MAP = {
  'p': 'present', 'present': 'present', '✓': 'present', '✔': 'present',
  'a': 'absent', 'absent': 'absent', '✗': 'absent', '✘': 'absent', 'x': 'absent',
  't': 'tardy', 'tardy': 'tardy', 'late': 'tardy',
  'e': 'excused', 'excused': 'excused', 'ea': 'excused',
};

/**
 * Parse attendance grid into records.
 * @returns {AttendanceRecord[]}
 */
export function parseAttendance() {
  const tables = [...document.querySelectorAll('table')];
  const table = tables.filter(t => t.rows.length > 3)
    .sort((a, b) => b.rows.length - a.rows.length)[0];
  if (!table || table.rows.length < 2) return [];

  const rows = [...table.rows];
  const headerCells = rows[0].cells || rows[0].querySelectorAll('th, td');

  // Detect date columns (MM/DD, YYYY-MM-DD, etc.)
  const dateColumns = [];
  for (let i = 1; i < headerCells.length; i++) {
    const text = (headerCells[i].textContent || '').trim();
    if (/\d{1,2}[\/\-]\d{1,2}/.test(text) || /\d{4}-\d{2}-\d{2}/.test(text)) {
      dateColumns.push({ index: i, date: text });
    }
  }

  // If no date columns, might be single-day view
  const isSingleDay = dateColumns.length === 0;
  const today = new Date().toISOString().split('T')[0];

  const records = [];

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r].cells || rows[r].querySelectorAll('td');
    if (!cells || cells.length < 2) continue;

    const nameCell = cells[0];
    const studentName = (nameCell.textContent || '').trim();
    if (!studentName) continue;

    const link = nameCell.querySelector('a[href]');
    let sourcedId = '';
    if (link) {
      const href = link.getAttribute('href') || '';
      const match = href.match(/(?:student(?:id|_id)?|id)=(\d+)/i);
      if (match) sourcedId = match[1];
    }
    if (!sourcedId) {
      sourcedId = `ps_${studentName.toLowerCase().replace(/\s+/g, '_')}_${r}`;
    }

    if (isSingleDay) {
      // Single day: each cell after name might be a period or a single status
      for (let i = 1; i < cells.length; i++) {
        const val = (cells[i].textContent || '').trim().toLowerCase();
        const status = STATUS_MAP[val];
        if (status) {
          records.push({ sourcedId, studentName, date: today, status });
          break;
        }
      }
    } else {
      for (const { index, date } of dateColumns) {
        const cell = cells[index];
        if (!cell) continue;
        const val = (cell.textContent || '').trim().toLowerCase();
        const status = STATUS_MAP[val];
        if (status) {
          records.push({ sourcedId, studentName, date, status });
        }
      }
    }
  }

  return records;
}

/**
 * Check if current page is an attendance page.
 * @returns {boolean}
 */
export function isAttendancePage() {
  return /attendance/i.test(window.location.pathname);
}
