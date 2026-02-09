/**
 * SchoolSync Gradebook Parser — extracts grades from PowerSchool gradebook view.
 * Target: /teachers/gradebook.html and similar grade grid pages.
 */

/**
 * @typedef {Object} GradeRecord
 * @property {string} sourcedId - student ID
 * @property {string} studentName
 * @property {string} [className]
 * @property {{ assignment: string, score: string, maxScore: string, category: string }[]} grades
 */

const GRADEBOOK_SELECTORS = [
  'table#scoreTable',
  'table.linkDescList',
  '#content-main table.grid',
  '.box-round table',
];

/**
 * Parse the gradebook grid into grade records.
 * @returns {GradeRecord[]}
 */
export function parseGradebook() {
  let table = null;
  for (const sel of GRADEBOOK_SELECTORS) {
    table = document.querySelector(sel);
    if (table) break;
  }
  if (!table) {
    // Fallback: largest table
    const tables = [...document.querySelectorAll('table')];
    table = tables.sort((a, b) => b.rows.length - a.rows.length)[0];
  }
  if (!table || table.rows.length < 2) return [];

  const rows = [...table.rows];
  const headerCells = rows[0].cells || rows[0].querySelectorAll('th, td');
  
  // First column is usually student name, rest are assignments
  const assignments = [];
  for (let i = 1; i < headerCells.length; i++) {
    const text = (headerCells[i].textContent || '').trim();
    if (text && !/^(total|final|grade|avg|average|%)$/i.test(text)) {
      assignments.push({ index: i, name: text });
    }
  }

  // Extract class name from page title or breadcrumb
  const className = document.querySelector('.current_class, .breadcrumb .active, h1, h2')?.textContent?.trim() || '';

  const records = [];

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r].cells || rows[r].querySelectorAll('td');
    if (!cells || cells.length < 2) continue;

    const nameCell = cells[0];
    const studentName = (nameCell.textContent || '').trim();
    if (!studentName) continue;

    // Try to extract student ID from link
    const link = nameCell.querySelector('a[href]');
    let sourcedId = '';
    if (link) {
      const href = link.getAttribute('href') || '';
      const match = href.match(/(?:student(?:id|_id)?|frn|id)=(\d+)/i);
      if (match) sourcedId = match[1];
    }
    if (!sourcedId) {
      sourcedId = `ps_${studentName.toLowerCase().replace(/\s+/g, '_')}_${r}`;
    }

    const grades = [];
    for (const { index, name } of assignments) {
      const cell = cells[index];
      if (!cell) continue;
      const scoreText = (cell.textContent || '').trim();
      if (!scoreText) continue;

      // Parse "8/10" or "80%" or just "8"
      const slashMatch = scoreText.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
      const pctMatch = scoreText.match(/^(\d+(?:\.\d+)?)%$/);

      grades.push({
        assignment: name,
        score: slashMatch ? slashMatch[1] : pctMatch ? pctMatch[1] : scoreText,
        maxScore: slashMatch ? slashMatch[2] : pctMatch ? '100' : '',
        category: '',
      });
    }

    if (grades.length > 0) {
      records.push({ sourcedId, studentName, className, grades });
    }
  }

  return records;
}

/**
 * Check if the current page looks like a gradebook page.
 * @returns {boolean}
 */
export function isGradebookPage() {
  const url = window.location.pathname.toLowerCase();
  return /gradebook|scores|grades|assignment/i.test(url);
}
