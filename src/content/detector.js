/**
 * SchoolSync Content Script — detects PowerSchool pages and extracts data.
 * Runs on *.powerschool.com. No data leaves the browser without user consent.
 */

(async () => {
  'use strict';

  // Only run on actual SIS pages (not login, not error pages)
  if (document.querySelector('.login-page, #loginForm, .errorPage')) return;

  const PAGE_TYPES = {
    ROSTER: 'roster',
    EXPORT: 'export',
    GRADEBOOK: 'gradebook',
    ATTENDANCE: 'attendance',
    UNKNOWN: 'unknown',
  };

  /**
   * Detect which SIS platform we're on.
   * @returns {string}
   */
  function detectSIS() {
    const host = window.location.hostname.toLowerCase();
    if (host.includes('powerschool')) return 'powerschool';
    if (host.includes('infinitecampus') || host.includes('campus')) return 'infinite-campus';
    if (host.includes('skyward')) return 'skyward';
    if (host.includes('clever')) return 'clever';
    if (host.includes('classlink') || host.includes('oneroster')) return 'classlink';
    if (host.includes('aeries')) return 'aeries';
    if (host.includes('genesis')) return 'genesis';
    if (host.includes('schoology')) return 'schoology';
    if (host.includes('instructure') || host.includes('canvas')) return 'canvas';
    return 'generic';
  }

  /**
   * Detect which page type we're on.
   * @returns {string}
   */
  function detectPageType() {
    const path = window.location.pathname.toLowerCase();

    if (/export|quickexport|data.?export/i.test(path)) return PAGE_TYPES.EXPORT;
    if (/gradebook|scores|assignment|grades/i.test(path)) return PAGE_TYPES.GRADEBOOK;
    if (/attendance/i.test(path)) return PAGE_TYPES.ATTENDANCE;
    if (/roster|studentlist|students|classroster|people|users|members|enrollment|census/i.test(path)) return PAGE_TYPES.ROSTER;

    // Heuristic: page has a large table with student-looking data
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      if (table.rows.length > 5) {
        const headerText = (table.rows[0]?.textContent || '').toLowerCase();
        if (/name|student|first|last/i.test(headerText)) return PAGE_TYPES.ROSTER;
      }
    }

    return PAGE_TYPES.UNKNOWN;
  }

  const sisType = detectSIS();

  const pageType = detectPageType();
  if (pageType === PAGE_TYPES.UNKNOWN) return;

  // Show sync badge
  showBadge(pageType);

  // Notify background script
  chrome.runtime.sendMessage({
    type: 'PAGE_DETECTED',
    pageType,
    sisType,
    url: window.location.href,
    title: document.title,
  });

  // Listen for parse requests from popup/background
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'PARSE_PAGE') {
      parsePage(pageType).then(sendResponse);
      return true; // async response
    }
    if (msg.type === 'DEEP_CRAWL') {
      importCrawler().then(async (mod) => {
        const results = await mod.deepCrawl((progress) => {
          chrome.runtime.sendMessage({ type: 'CRAWL_PROGRESS', ...progress });
        });
        sendResponse({ students: results, count: results.length });
      });
      return true;
    }
    if (msg.type === 'COUNT_LINKS') {
      importCrawler().then(mod => {
        const links = mod.extractStudentLinks();
        sendResponse({ count: links.length });
      });
      return true;
    }
    if (msg.type === 'PARSE_CSV_TEXT') {
      // Background sends CSV text for parsing
      importCSVParser().then(mod => {
        const students = mod.parseExportCSV(msg.csvText);
        sendResponse({ students, count: students.length });
      });
      return true;
    }
  });

  // Auto-detect CSV download links on export pages
  if (pageType === PAGE_TYPES.EXPORT) {
    interceptExportLinks();
  }

  /**
   * Parse the current page based on detected type.
   * @param {string} type
   * @returns {Promise<{ pageType: string, data: any, count: number }>}
   */
  async function parsePage(type) {
    try {
      // For non-PowerSchool SIS, use their specific parser for roster
      if (sisType !== 'powerschool' && sisType !== 'generic') {
        const parser = await importSISParser(sisType);
        if (parser) {
          const students = parser.parseRoster();
          return { pageType: 'roster', data: students, count: students.length, sisType };
        }
      }

      switch (type) {
        case PAGE_TYPES.ROSTER: {
          const { parseRoster } = await importRosterParser();
          const students = parseRoster();
          return { pageType: type, data: students, count: students.length, sisType };
        }
        case PAGE_TYPES.GRADEBOOK: {
          const { parseGradebook } = await importGradebookParser();
          const grades = parseGradebook();
          return { pageType: type, data: grades, count: grades.length, sisType };
        }
        case PAGE_TYPES.ATTENDANCE: {
          const { parseAttendance } = await importAttendanceParser();
          const records = parseAttendance();
          return { pageType: type, data: records, count: records.length, sisType };
        }
        case PAGE_TYPES.EXPORT: {
          const { findCSVOnPage } = await importCSVParser();
          const csvSource = findCSVOnPage();
          if (csvSource && !csvSource.startsWith('http')) {
            const { parseExportCSV } = await importCSVParser();
            const students = parseExportCSV(csvSource);
            return { pageType: type, data: students, count: students.length, sisType };
          }
          return { pageType: type, data: null, count: 0, csvLink: csvSource, sisType };
        }
        default:
          return { pageType: type, data: null, count: 0, sisType };
      }
    } catch (err) {
      return { pageType: type, data: null, count: 0, error: err.message };
    }
  }

  /**
   * Watch for CSV download links on export page and intercept clicks.
   */
  function interceptExportLinks() {
    document.addEventListener('click', async (e) => {
      const link = e.target.closest('a[href*=".csv"], a[download], input[type="submit"], button[type="submit"]');
      if (!link) return;

      // Let the download happen, but also notify background to watch for it
      chrome.runtime.sendMessage({
        type: 'WATCH_DOWNLOAD',
        url: link.href || window.location.href,
      });
    }, true);
  }

  /**
   * Show a small non-intrusive badge on the page.
   * @param {string} pageType
   */
  function showBadge(pageType) {
    const badge = document.createElement('div');
    badge.id = 'schoolsync-badge';
    badge.setAttribute('role', 'status');
    badge.setAttribute('aria-label', 'SchoolSync detected student data');

    const labels = {
      [PAGE_TYPES.ROSTER]: '📋 Roster detected',
      [PAGE_TYPES.EXPORT]: '📥 Export page detected',
      [PAGE_TYPES.GRADEBOOK]: '📊 Gradebook detected',
      [PAGE_TYPES.ATTENDANCE]: '✅ Attendance detected',
    };
    badge.textContent = labels[pageType] || '🔄 SchoolSync';

    badge.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'OPEN_POPUP' });
    });

    document.body.appendChild(badge);

    // Auto-hide after 5s
    setTimeout(() => { badge.classList.add('ss-hidden'); }, 5000);
    badge.addEventListener('mouseenter', () => badge.classList.remove('ss-hidden'));
    badge.addEventListener('mouseleave', () => {
      setTimeout(() => badge.classList.add('ss-hidden'), 2000);
    });
  }

  // Dynamic imports for code splitting
  async function importRosterParser() {
    return import(chrome.runtime.getURL('src/content/parsers/roster.js'));
  }
  async function importGradebookParser() {
    return import(chrome.runtime.getURL('src/content/parsers/gradebook.js'));
  }
  async function importAttendanceParser() {
    return import(chrome.runtime.getURL('src/content/parsers/attendance.js'));
  }
  async function importCSVParser() {
    return import(chrome.runtime.getURL('src/content/parsers/export-csv.js'));
  }
  async function importCrawler() {
    return import(chrome.runtime.getURL('src/content/crawler.js'));
  }
  async function importSISParser(sis) {
    const parserMap = {
      'infinite-campus': 'infinite-campus.js',
      'skyward': 'skyward.js',
      'clever': 'clever.js',
      'classlink': 'classlink.js',
      'aeries': 'aeries.js',
      'genesis': 'genesis.js',
      'schoology': 'schoology.js',
      'canvas': 'canvas.js',
    };
    const file = parserMap[sis];
    if (!file) return null;
    try {
      return await import(chrome.runtime.getURL(`src/content/parsers/${file}`));
    } catch {
      return null;
    }
  }
})();
