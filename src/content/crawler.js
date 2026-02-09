/**
 * SchoolSync Deep Crawler — follows student links from roster pages,
 * visits each student profile, extracts all available data.
 * Runs in a background tab to avoid interrupting the user.
 */

const CRAWL_DELAY_MS = 800;  // Be respectful — don't hammer the SIS
const MAX_CONCURRENT = 1;     // One at a time to avoid session issues
const PROFILE_TIMEOUT_MS = 10_000;

/**
 * @typedef {Object} DeepStudentRecord
 * @property {string} sourcedId
 * @property {string} firstName
 * @property {string} lastName
 * @property {string} [gradeLevel]
 * @property {string} [homeRoom]
 * @property {string} [enrollStatus]
 * @property {string} [email]
 * @property {string} [schoolId]
 * @property {string} [dob]
 * @property {string} [gender]
 * @property {string} [address]
 * @property {string} [phone]
 * @property {string} [guardianName]
 * @property {string} [guardianEmail]
 * @property {string} [guardianPhone]
 * @property {string} [ethnicity]
 * @property {string} [language]
 * @property {string} [iep]
 * @property {string} [section504]
 * @property {string} [lunchStatus]
 * @property {string} [transportation]
 * @property {string} [emergencyContact]
 * @property {string} [emergencyPhone]
 * @property {string} [enrollDate]
 * @property {string} [exitDate]
 * @property {string} [gpa]
 * @property {string} [credits]
 * @property {Record<string, string>} [schedule]
 * @property {Record<string, string>} [extra]
 */

/**
 * Extract all student profile links from the current roster page.
 * @returns {{ sourcedId: string, name: string, url: string }[]}
 */
export function extractStudentLinks() {
  const links = [];
  const seen = new Set();

  // Find all links that point to student profiles
  const anchors = document.querySelectorAll('a[href]');

  for (const a of anchors) {
    const href = a.getAttribute('href') || '';
    const fullUrl = a.href;

    // Match student profile URL patterns across SIS platforms
    const patterns = [
      // PowerSchool
      /\/students\/(\d+)/i,
      /studentid=(\d+)/i,
      /frn=(\d+)/i,
      /\/guardian\/students\.html\?.*id=(\d+)/i,
      // Infinite Campus
      /personID=(\d+)/i,
      /\/person\/(\d+)/i,
      /\/student\/(\d+)/i,
      // Skyward
      /stuID=(\d+)/i,
      /studentId=(\d+)/i,
      // Aeries
      /\/student\/(\d+)/i,
      /ID=(\d+)/i,
      // Genesis
      /student_id=(\d+)/i,
      // Canvas
      /\/users\/(\d+)/i,
      // Schoology
      /\/user\/(\d+)/i,
      // Generic
      /\/profile\/(\d+)/i,
    ];

    let id = null;
    for (const pattern of patterns) {
      const match = href.match(pattern) || fullUrl.match(pattern);
      if (match) {
        id = match[1];
        break;
      }
    }

    if (id && !seen.has(id)) {
      seen.add(id);
      const name = (a.textContent || '').trim();
      // Only include links that look like they're in a student list context
      const parent = a.closest('tr, li, .student, [class*="student"], [class*="roster"]');
      if (parent || /student|person|user/i.test(href)) {
        links.push({ sourcedId: id, name, url: fullUrl });
      }
    }
  }

  return links;
}

/**
 * Known field patterns for scraping student profile pages.
 * Maps label text → field name.
 */
const PROFILE_FIELD_PATTERNS = {
  // Demographics
  sourcedId: /^(student.?(?:number|id)|sis.?id|id.?number|perm.?id|dcid)$/i,
  firstName: /^(first.?name|legal.?first|preferred.?name)$/i,
  lastName: /^(last.?name|legal.?last|surname)$/i,
  dob: /^(date.?of.?birth|dob|birth.?date|birthday)$/i,
  gender: /^(gender|sex)$/i,
  ethnicity: /^(ethnicity|race|ethnic)$/i,
  language: /^(home.?language|primary.?language|language|ell)$/i,
  gradeLevel: /^(grade|grade.?level|gr|current.?grade)$/i,
  
  // Contact
  address: /^(address|home.?address|street|mailing.?address|residence)$/i,
  phone: /^(phone|home.?phone|student.?phone|cell)$/i,
  email: /^(email|student.?email|e.?mail)$/i,
  
  // Guardian / Parent
  guardianName: /^(parent|guardian|mother|father|parent.?(?:1|name)|guardian.?name|emergency.?1.?name|custodial)$/i,
  guardianEmail: /^(parent.?email|guardian.?email|family.?email)$/i,
  guardianPhone: /^(parent.?phone|guardian.?phone|home.?phone|family.?phone|mother.?phone|father.?phone)$/i,
  
  // Emergency
  emergencyContact: /^(emergency.?contact|emergency.?name|emergency.?(?:2|3))$/i,
  emergencyPhone: /^(emergency.?phone|emergency.?(?:2|3).?phone)$/i,
  
  // School
  homeRoom: /^(home.?room|homeroom|hr|advisory|section)$/i,
  schoolId: /^(school|building|campus|school.?name)$/i,
  enrollStatus: /^(enroll.?status|status|enrollment|active)$/i,
  enrollDate: /^(enroll.?date|entry.?date|admission.?date)$/i,
  exitDate: /^(exit.?date|withdrawal.?date|leave.?date)$/i,
  
  // Academic
  gpa: /^(gpa|cumulative.?gpa|grade.?point|weighted.?gpa)$/i,
  credits: /^(credits|total.?credits|earned.?credits)$/i,
  
  // Special programs
  iep: /^(iep|special.?ed|sped|individualized|504.?plan|section.?504)$/i,
  section504: /^(504|section.?504|accommodation)$/i,
  lunchStatus: /^(lunch|free.?(?:reduced)?|meal.?status|frl)$/i,
  transportation: /^(transport|bus|transportation|route)$/i,
};

/**
 * Scrape a student profile page for all available data.
 * Works across SIS platforms by looking for label/value patterns.
 * @param {Document} doc - The loaded profile page document
 * @param {string} sourcedId - Fallback ID
 * @returns {DeepStudentRecord}
 */
export function scrapeProfilePage(doc, sourcedId) {
  /** @type {DeepStudentRecord} */
  const record = { sourcedId, extra: {}, schedule: {} };

  // Strategy 1: Label/Value pairs in tables (most SIS platforms)
  const tables = doc.querySelectorAll('table');
  for (const table of tables) {
    for (const row of table.rows) {
      if (row.cells.length >= 2) {
        processLabelValue(
          (row.cells[0].textContent || '').trim(),
          (row.cells[1].textContent || '').trim(),
          record
        );
      }
      // Some tables have label in TH, value in TD
      const th = row.querySelector('th');
      const td = row.querySelector('td');
      if (th && td) {
        processLabelValue(
          (th.textContent || '').trim(),
          (td.textContent || '').trim(),
          record
        );
      }
    }
  }

  // Strategy 2: Definition lists (dl/dt/dd)
  const dls = doc.querySelectorAll('dl');
  for (const dl of dls) {
    const dts = dl.querySelectorAll('dt');
    const dds = dl.querySelectorAll('dd');
    for (let i = 0; i < Math.min(dts.length, dds.length); i++) {
      processLabelValue(
        (dts[i].textContent || '').trim(),
        (dds[i].textContent || '').trim(),
        record
      );
    }
  }

  // Strategy 3: Label + adjacent element (div/span patterns)
  const labels = doc.querySelectorAll('label, .field-label, [class*="label"], [class*="Label"]');
  for (const label of labels) {
    const labelText = (label.textContent || '').trim();
    // Look for adjacent value element
    const next = label.nextElementSibling;
    if (next) {
      const value = (next.textContent || '').trim();
      if (value && value.length < 500) {
        processLabelValue(labelText, value, record);
      }
    }
    // Check for "for" attribute pointing to an input
    const forId = label.getAttribute('for');
    if (forId) {
      const input = doc.getElementById(forId);
      if (input) {
        const value = input.value || (input.textContent || '').trim();
        if (value) processLabelValue(labelText, value, record);
      }
    }
  }

  // Strategy 4: Heading + content blocks
  const headings = doc.querySelectorAll('h2, h3, h4, .section-header, [class*="sectionHeader"]');
  for (const heading of headings) {
    const section = (heading.textContent || '').trim().toLowerCase();
    // If it's a schedule section, parse it differently
    if (/schedule|classes|courses|period/i.test(section)) {
      parseScheduleSection(heading, record);
    }
  }

  // Strategy 5: Read-only input fields
  const inputs = doc.querySelectorAll('input[readonly], input[disabled], input.readonly, span.fieldValue, [class*="fieldValue"]');
  for (const input of inputs) {
    const value = input.value || (input.textContent || '').trim();
    if (!value) continue;
    // Try to find an associated label
    const id = input.id || input.getAttribute('name');
    if (id) {
      const label = doc.querySelector(`label[for="${id}"]`);
      if (label) {
        processLabelValue((label.textContent || '').trim(), value, record);
        continue;
      }
    }
    // Check parent for label
    const parent = input.closest('.field, .form-group, [class*="field"]');
    if (parent) {
      const label = parent.querySelector('label, .label, [class*="label"]');
      if (label) {
        processLabelValue((label.textContent || '').trim(), value, record);
      }
    }
  }

  // Extract name from page title/header if not found
  if (!record.firstName && !record.lastName) {
    const nameEl = doc.querySelector('h1, .student-name, [class*="studentName"], [class*="StudentName"]');
    if (nameEl) {
      const text = (nameEl.textContent || '').trim();
      if (text.includes(',')) {
        const [last, first] = text.split(',').map(s => s.trim());
        record.firstName = first;
        record.lastName = last;
      } else {
        const parts = text.split(/\s+/);
        record.firstName = parts[0] || '';
        record.lastName = parts.slice(1).join(' ');
      }
    }
  }

  return record;
}

/**
 * Match a label/value pair to a known field.
 */
function processLabelValue(label, value, record) {
  if (!label || !value || value.length > 500) return;
  
  // Clean label
  const cleanLabel = label.replace(/[:\s*]+$/, '').trim();
  if (!cleanLabel) return;

  for (const [field, pattern] of Object.entries(PROFILE_FIELD_PATTERNS)) {
    if (pattern.test(cleanLabel)) {
      // Don't overwrite existing values with empty ones
      if (!record[field] || record[field] === '') {
        record[field] = value;
      }
      return;
    }
  }

  // Unknown field — store in extra
  record.extra[cleanLabel] = value;
}

/**
 * Parse a schedule section (table of periods/classes).
 */
function parseScheduleSection(heading, record) {
  // Look for the next table after the heading
  let el = heading.nextElementSibling;
  let attempts = 0;
  while (el && attempts < 5) {
    if (el.tagName === 'TABLE') {
      for (const row of el.rows) {
        if (row.cells.length >= 2) {
          const period = (row.cells[0].textContent || '').trim();
          const className = (row.cells[1].textContent || '').trim();
          if (period && className && !/^(period|time|class)/i.test(period)) {
            record.schedule[period] = className;
          }
        }
      }
      break;
    }
    el = el.nextElementSibling;
    attempts++;
  }
}

/**
 * Crawl all student profiles from the current roster page.
 * Sends progress updates via chrome.runtime messages.
 * @param {(progress: { current: number, total: number, student: string }) => void} onProgress
 * @returns {Promise<DeepStudentRecord[]>}
 */
export async function deepCrawl(onProgress) {
  const studentLinks = extractStudentLinks();
  if (studentLinks.length === 0) return [];

  const results = [];

  for (let i = 0; i < studentLinks.length; i++) {
    const { sourcedId, name, url } = studentLinks[i];

    onProgress?.({ current: i + 1, total: studentLinks.length, student: name });

    try {
      const record = await fetchAndScrapeProfile(url, sourcedId);
      if (record) results.push(record);
    } catch (err) {
      console.warn(`SchoolSync: Failed to crawl ${name}: ${err.message}`);
      // Continue with next student
    }

    // Rate limiting — be respectful
    if (i < studentLinks.length - 1) {
      await sleep(CRAWL_DELAY_MS);
    }
  }

  return results;
}

/**
 * Fetch a student profile page and scrape it.
 * Uses fetch() to avoid opening new tabs.
 * @param {string} url
 * @param {string} sourcedId
 * @returns {Promise<DeepStudentRecord|null>}
 */
async function fetchAndScrapeProfile(url, sourcedId) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROFILE_TIMEOUT_MS);

  try {
    const resp = await fetch(url, {
      credentials: 'include', // Use existing session cookies
      signal: controller.signal,
      headers: { 'Accept': 'text/html' },
    });

    clearTimeout(timeout);

    if (!resp.ok) return null;

    const html = await resp.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    return scrapeProfilePage(doc, sourcedId);
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      console.warn(`SchoolSync: Timeout fetching ${url}`);
    }
    return null;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
