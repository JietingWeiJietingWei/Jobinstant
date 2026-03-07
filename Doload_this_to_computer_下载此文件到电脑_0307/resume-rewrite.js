// resume-rewrite.js — v5.38 — new UI
'use strict';

// ─── Safe style setter ───────────────────────────────────────────────────────
function setDisplay(id, val) {
  const el = document.getElementById(id);
  if (el) el.style.display = val;
}

let storedData = {};

// ─── Score helpers (thresholds match sidepanel.js exactly) ───────────────────
function scoreStage(s) {
  return s >= 75 ? 'green' : s >= 55 ? 'yellow' : 'red';
}
function scoreColor(s) {
  return s >= 75 ? '#16a34a' : s >= 55 ? '#d97706' : '#dc2626';
}
function scoreBg(s) {
  return s >= 75 ? '#f0fdf4' : s >= 55 ? '#fffbeb' : '#fef2f2';
}

// ─── Gauge animation ──────────────────────────────────────────────────────────
function animateGauge(score) {
  const CIRCUMFERENCE = 276; // 2π × r44
  const stage = scoreStage(score);

  const fill = document.getElementById('gauge-fill');
  const num  = document.getElementById('gauge-num');
  if (!fill || !num) return;

  fill.setAttribute('class', `gauge-fill stage-${stage}`);
  num.className  = `gauge-num stage-${stage}`;

  // Start from full offset (empty), animate to target
  const targetOffset = CIRCUMFERENCE * (1 - score / 100);
  // Small delay so CSS transition fires
  requestAnimationFrame(() => {
    setTimeout(() => {
      fill.setAttribute('stroke-dashoffset', targetOffset);
    }, 80);
  });

  // Count-up number
  let current = 0;
  const step = Math.ceil(score / 40);
  const interval = setInterval(() => {
    current = Math.min(current + step, score);
    num.textContent = current + '%';
    if (current >= score) clearInterval(interval);
  }, 35);
}

// ─── Hero pills ──────────────────────────────────────────────────────────────
function renderHero(jobTitle, score, beforeScore, changeCount) {
  const _hjt = document.getElementById('hero-job-title'); if (_hjt) _hjt.textContent = jobTitle || 'this job';

  // Score pill
  if (score != null) {
    const pillScore = document.getElementById('pill-score');
    if (pillScore) {
      const stage = scoreStage(score);
      pillScore.className = `pill pill-score-${stage}`;
      if (beforeScore != null && beforeScore !== score) {
        pillScore.textContent = `Improved from ${beforeScore}% to ${score}%`;
      } else {
        pillScore.textContent = `Score: ${score}%`;
      }
      pillScore.style.display = '';
    }
    animateGauge(score);
  }

  // Changes pill
  if (changeCount > 0) {
    const pillChanges = document.getElementById('pill-changes');
    if (pillChanges) {
      pillChanges.textContent = `${changeCount} changes`;
      pillChanges.style.display = '';
    }
  }
}

// ─── Bottom bar ───────────────────────────────────────────────────────────────
function renderBottomBar(score, beforeScore, jobTitle) {
  const bar  = document.getElementById('bottom-bar');
  const info = document.getElementById('bottom-info');
  if (info) {
    if (score != null && beforeScore != null && beforeScore !== score) {
      info.innerHTML = `Score: <strong>${beforeScore} → ${score}</strong> · ${jobTitle || ''}`;
    } else if (score != null) {
      info.innerHTML = `Score: <strong>${score}%</strong> · ${jobTitle || ''}`;
    }
  }
  if (bar) bar.style.display = 'flex';
}

// ─── Changes list ─────────────────────────────────────────────────────────────
function renderChanges(changesRaw) {
  const list = document.getElementById('changes-list');
  const badge = document.getElementById('changes-badge');
  if (!list || !badge) return;

  // Accept array or newline-separated string
  const items = Array.isArray(changesRaw)
    ? changesRaw
    : String(changesRaw || '').split('\n');

  const filtered = items.map(s => s.trim().replace(/^•\s*/, '')).filter(Boolean);

  badge.textContent = `${filtered.length} edits`;

  list.innerHTML = filtered.map((text, i) => {
    // Detect type from text keywords
    const isReordered = /reorder|moved|restructur|reorgani/i.test(text);
    const tagClass = isReordered ? 'tag-reordered' : 'tag-added';
    const tagLabel = isReordered ? 'reordered' : 'added';

    // Bold any quoted words
    const formatted = text.replace(/'([^']+)'/g, '<strong>\'$1\'</strong>');

    return `
      <div class="change-item">
        <div class="c-num">${i + 1}</div>
        <span class="c-text">${formatted} <span class="tag ${tagClass}">${tagLabel}</span></span>
      </div>`;
  }).join('');
}

// ─── Pre-process resume text ──────────────────────────────────────────────────
function parseResumeText(raw) {
  // Normalize broken bullet chars from PDF extraction: (cid:127), \x7f etc → •
  raw = raw
    .replace(/\(cid:\d+\)/g, '•')
    .replace(/[\x7f\u007f]/g, '•')
    .replace(/[▪◦○■◆➢➤►▶→]/g, '•');

  // Always run full structure processing — AI output often has some \n but wrong positions
  let s = raw;

  // 1. Section headers — inject \n\n before AND \n after
  const SECTIONS = [
    'PRODUCT CASE STUDY','CASE STUDY',
    'WORK EXPERIENCE','PROFESSIONAL EXPERIENCE',
    'SUMMARY','OBJECTIVE','EXPERIENCE','EDUCATION','SKILLS',
    'CERTIFICATIONS','CERTIFICATES','PROJECTS','AWARDS',
    'PUBLICATIONS','LANGUAGES','VOLUNTEERING','INTERESTS','REFERENCES',
  ];
  // Sort longest first so "WORK EXPERIENCE" is matched before "EXPERIENCE"
  const SECTIONS_SORTED = SECTIONS.slice().sort((a, b) => b.length - a.length);
  for (const sec of SECTIONS_SORTED) {
    // Insert \n\n before section header
    s = s.replace(new RegExp(`(?<!\n)(${sec})(?=[\\s:])`, 'g'), '\n\n$1');
    // Insert \n after section header if text follows on same line
    // e.g. "EXPERIENCE Product Manager..." → "EXPERIENCE\nProduct Manager..."
    s = s.replace(new RegExp(`(${sec}):?[ \\t]+([^\\n])`, 'g'), '$1\n$2');
  }

  // 2. Job title / role header lines — split before the date range
  //    Handles multiple date formats:
  //    a) "Product Manager – Education Products 2021.10 – 2024.02"
  //    b) "IT Advisor - Subject Matter Expert 2017.09 – 2021.06"
  //    c) "Product Manager – Education & AI Oct 2021 – Feb 2024"
  //    d) "Product Manager – AI Feb 2026 – Mar 2026 CompanyName"
  const MONTHS = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|January|February|March|April|May|June|July|August|September|October|November|December';

  // 2a. Month-name dates: "Title MonthName Year – MonthName Year [Company]"
  //     Insert \n\n before title, \n before date range
  const monthDateRange = new RegExp(
    `([A-Za-z][^\\n•]{5,80}?)\\s+((?:${MONTHS})\\s+\\d{4}\\s*[–\\-–]\\s*(?:(?:${MONTHS})\\s+\\d{4}|Present|Now|Current))`,
    'gi'
  );
  s = s.replace(monthDateRange, '\n\n$1\n$2');

  // 2b. Numeric dates: "Title 2021.10 – 2024.02"
  s = s.replace(/([A-Za-z][^\n•]{5,60}?)\s+(\d{4}[.\/]\d{2}\s*[–\-]\s*(?:\d{4}[.\/]\d{2}|Present|Now|Current))/g,
    '\n\n$1\n$2');

  // 2c. Bare year dates: "Title 2019 – 2022"
  s = s.replace(/([A-Za-z][^\n•]{5,60}?)\s+(\d{4}\s*[–\-]\s*(?:\d{4}|Present))/g,
    '\n\n$1\n$2');

  // 2d. Company name after date range on same line → split to its own line
  //     "Oct 2021 – Feb 2024 LingoDeer" → "Oct 2021 – Feb 2024\nLingoDeer"
  const dateFollowedByCompany = new RegExp(
    `((?:${MONTHS})\\s+\\d{4}\\s*[–\\-–]\\s*(?:(?:${MONTHS})\\s+\\d{4}|Present|Now|Current))\\s+([A-Z][A-Za-z][A-Za-z0-9 &.,'\\-]{1,40})(?=\\s*[•(\\n]|$)`,
    'gim'
  );
  s = s.replace(dateFollowedByCompany, '$1\n$2');

  // Also handle numeric dates followed by company
  s = s.replace(/(\d{4}[.\/]\d{2}\s*[–\-]\s*(?:\d{4}[.\/]\d{2}|Present|Now|Current))\s+([A-Z][A-Za-z][A-Za-z0-9 &.,'\\-]{1,40})(?=\s*[•(\n]|$)/gm,
    '$1\n$2');

  // 2e. Education entries: "Degree Name 2020" → split year onto its own line
  //     Handles standalone year at end of a text line (not date ranges which are already handled)
  s = s.replace(/([A-Za-z][^\n]{10,80}?)\s+((?:19|20)\d{2})\s*$/gm, '$1\n$2');

  // 2f. Education: "University Name, City" or "University Name" after degree line
  //     Ensure university on its own line if merged with degree
  s = s.replace(/([A-Za-z][^\n]{5,60}?(?:University|College|Institute|School|Academy)[^\n]{0,40}?)\s+((?:Bachelor|Master|Doctor|Associate|B\.\s*[A-Z]|M\.\s*[A-Z]|Ph\.?\s*D|MBA|BS|BA|MS|MA)[^\n]{5,60})/gi,
    '$1\n$2');

  // 3. Bullets — normalize spacing
  s = s.replace(/(?<!\n)\s*•\s*/g, '\n• ');

  // 4. Contact info lines — only split onto new line if NOT preceded by pipe/bullet separator
  s = s.replace(/(?<!\n)(?<![|•]\s*)([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/g, '\n$1');
  s = s.replace(/(?<!\n)(?<![|•]\s*)(linkedin\.com\/[^\s]+)/gi, '\n$1');
  s = s.replace(/(?<!\n)(?<![|•]\s*)(https?:\/\/[^\s]+)/gi, '\n$1');

  // 5. Collapse 3+ newlines to 2
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

// ─── Resume output ────────────────────────────────────────────────────────────
function renderResume(rawText, changesRaw) {
  const output = document.getElementById('resume-output');
  if (!output) return;

  // Normalize flat text into structured lines
  rawText = parseResumeText(rawText);

  const changes = Array.isArray(changesRaw)
    ? changesRaw
    : String(changesRaw || '').split('\n');

  // Has any reorder-type change been described?
  const hasReorderChanges = changes.some(ch => /reorder|moved|restructur|reorgani|higher|lower|first/i.test(ch));

  // Highlight **word** in a line — always green (added keyword)
  function applyMarks(escaped) {
    return escaped.replace(/\*\*(.+?)\*\*/g, (_, word) => {
      return `<mark class="added">${word}</mark>`;
    });
  }

  // Is this bullet reordered?
  // Strategy: bullet has no **added keywords** AND there are reorder-type changes described
  // This is the best we can do without AI explicitly tagging reordered bullets
  function isReorderedBullet(rawLine) {
    if (!hasReorderChanges) return false;
    // If bullet has added keywords (**), it's "added" not "reordered"
    if (/\*\*/.test(rawLine)) return false;
    return true;
  }

  const lines = rawText.split('\n');
  const parts = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Empty line → spacer
    if (!trimmed) {
      parts.push('<div style="height:6px"></div>');
      i++; continue;
    }

    // Bullet line
    if (/^[•\-–*▪◦○■]|^\(cid:/.test(trimmed)) {
      const text = trimmed.replace(/^[•\-–*▪◦○■]\s*|^\(cid:\d+\)\s*/, '');
      const escaped = escapeHtml(text);
      const withMarks = applyMarks(escaped, text);
      const reordered = isReorderedBullet(trimmed);
      const cls = reordered ? 'bul bul-reordered' : 'bul';
      parts.push(`<div class="${cls}"><span class="bul-dot">•</span><span>${withMarks}</span></div>`);
      i++; continue;
    }

    // Section header: ALL CAPS line (e.g. EXPERIENCE, EDUCATION, SKILLS)
    // Exclude short known company abbreviations (IBM, AWS, etc.) — those are r-company
    const KNOWN_SECTIONS = ['SUMMARY','OBJECTIVE','EXPERIENCE','WORK EXPERIENCE','PROFESSIONAL EXPERIENCE',
      'EDUCATION','SKILLS','CERTIFICATIONS','CERTIFICATES','PROJECTS','AWARDS',
      'PUBLICATIONS','LANGUAGES','VOLUNTEERING','INTERESTS','REFERENCES',
      'PRODUCT CASE STUDY','CASE STUDY'];
    const isSectionHeader = trimmed === trimmed.toUpperCase()
      && trimmed.length > 3 && trimmed.length < 50
      && /[A-Z]{3,}/.test(trimmed)
      && (KNOWN_SECTIONS.includes(trimmed) || trimmed.split(' ').length >= 2);
    if (isSectionHeader) {
      parts.push(`<div class="r-label">${escapeHtml(trimmed)}</div>`);
      i++; continue;
    }

    // Company name line (short, standalone, after a date line)
    // e.g. "IBM", "Thomson Reuters", "MetroWall", "Self-Funded Startup"
    if (trimmed.length <= 55 && /^[A-Z]/.test(trimmed) && !/[@•–,|]/.test(trimmed)
        && !/(20\d{2}|19\d{2}|Present)/.test(trimmed)
        && parts.length > 0 && (parts[parts.length-1].includes('r-meta') || parts[parts.length-1].includes('r-role') || parts[parts.length-1].includes('r-line') || parts[parts.length-1].includes('r-label'))) {
      parts.push(`<div class="r-company">${escapeHtml(trimmed)}</div>`);
      i++; continue;
    }

    // Company name after role line with parenthetical (e.g. "JobInstant (Self-Funded Side Project)")
    if (trimmed.length <= 60 && /^[A-Z]/.test(trimmed) && /\(/.test(trimmed)
        && !/(20\d{2}|19\d{2}|Present)/.test(trimmed)
        && !/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i.test(trimmed)
        && parts.length > 0 && (parts[parts.length-1].includes('r-meta') || parts[parts.length-1].includes('r-role') || parts[parts.length-1].includes('r-line') || parts[parts.length-1].includes('r-label'))) {
      parts.push(`<div class="r-company">${escapeHtml(trimmed)}</div>`);
      i++; continue;
    }

    // Section header with trailing colon (e.g. "Experience:" or "Work History:")
    if (/^[A-Z][^\n]{1,35}:$/.test(trimmed)) {
      parts.push(`<div class="r-label">${escapeHtml(trimmed.slice(0, -1))}</div>`);
      i++; continue;
    }

    // Name line: first line OR short bold-ish line with no numbers/symbols
    // Detect: 1–4 words, no email/phone, appears early
    if (i < 4 && /^[A-Z][a-zA-Z\s'\-]{2,40}$/.test(trimmed) && trimmed.split(' ').length <= 5) {
      parts.push(`<div class="r-name">${escapeHtml(trimmed)}</div>`);
      i++; continue;
    }

    // Contact line: email, phone, or URL (but NOT company names with parentheses)
    if ((/[@]|[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-z]{2,}|\d{3}[-.)\s]\d{3}|linkedin\.com|github\.com|http/i.test(trimmed))
        && !/^[A-Z][a-zA-Z]/.test(trimmed.replace(/\s/g,''))) {
      parts.push(`<div class="r-contact">${escapeHtml(trimmed)}</div>`);
      i++; continue;
    }
    // Contact line (pipe/bullet separated): "email | phone | location"
    if (/[|•]/.test(trimmed) && /[@]|\d{3}|linkedin|github|http/i.test(trimmed)) {
      parts.push(`<div class="r-contact">${escapeHtml(trimmed)}</div>`);
      i++; continue;
    }

    // Job title + company line: "Title @ Company" or "Title, Company" or "Title | Company"
    if (/[@|,]/.test(trimmed) && trimmed.length < 80 && !/^[•\-–]/.test(trimmed)
        && !/(20\d{2}|19\d{2})/i.test(trimmed)) {
      const escaped = escapeHtml(trimmed);
      const withMarks = applyMarks(escaped, trimmed);
      parts.push(`<div class="r-role">${withMarks}</div>`);
      i++; continue;
    }

    // Job title with em/en-dash: "Product Manager – Education & AI"
    // Must NOT contain dates (those go to r-meta below)
    if (/[–—]/.test(trimmed) && trimmed.length < 80 && !/^[•]/.test(trimmed)
        && !/(20\d{2}|19\d{2})/i.test(trimmed)
        && !/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i.test(trimmed)) {
      const escaped = escapeHtml(trimmed);
      const withMarks = applyMarks(escaped, trimmed);
      parts.push(`<div class="r-role">${withMarks}</div>`);
      i++; continue;
    }

    // Date/meta line: contains year or duration pattern
    if (/\b(20\d{2}|19\d{2}|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Present|Remote|Hybrid|Full.time|Part.time)/i.test(trimmed)) {
      parts.push(`<div class="r-meta">${escapeHtml(trimmed)}</div>`);
      i++; continue;
    }

    // Default: regular paragraph line
    const escaped = escapeHtml(trimmed);
    const withMarks = applyMarks(escaped, trimmed);
    parts.push(`<div class="r-line">${withMarks}</div>`);
    i++;
  }

  output.innerHTML = parts.join('');
}

// ─── Show / hide states ───────────────────────────────────────────────────────
function showResult() {
    setDisplay('state-loading', 'none');
    setDisplay('state-error', 'none');
    setDisplay('result-wrap', 'flex');
}

function showError(msg) {
    setDisplay('state-loading', 'none');
    setDisplay('result-wrap', 'none');
    setDisplay('state-error', 'flex');
  const _em = document.getElementById('error-msg'); if (_em) _em.textContent = msg;
}

function showLoading() {
    setDisplay('state-loading', 'flex');
    setDisplay('state-error', 'none');
    setDisplay('result-wrap', 'none');
    setDisplay('bottom-bar', 'none');
}

// ─── Progress bar ─────────────────────────────────────────────────────────────
function startProgress() {
  const fill = document.getElementById('progress-fill');
  const lbl  = document.getElementById('progress-label');
  const steps = [
    [5,  'Reading your resume…'],
    [20, 'Analyzing job requirements…'],
    [40, 'Matching keywords…'],
    [60, 'Rewriting bullet points…'],
    [75, 'Tailoring language…'],
    [88, 'Scoring rewritten resume…'],
    [94, 'Almost done…'],
  ];
  let si = 0;
  return setInterval(() => {
    if (si < steps.length) {
      if (fill) fill.style.width = steps[si][0] + '%';
      if (lbl)  lbl.textContent  = steps[si][1];
      si++;
    }
  }, 1800);
}

// ─── Copy ─────────────────────────────────────────────────────────────────────
function copyResume() {
  const _ro = document.getElementById('resume-output'); const text = _ro ? _ro.textContent : '';
  navigator.clipboard.writeText(text).then(() => showToast('✓ Copied to clipboard'));
}

function showToast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2800);
}

// ─── Main rewrite ─────────────────────────────────────────────────────────────
async function runRewrite() {
  const resume = storedData.resume;
  const jd     = storedData.lastJD;

  if (!resume) { showError('No resume saved — add your resume in Settings first.'); return; }
  if (!jd)     { showError('No job description found — analyze a job on LinkedIn first.'); return; }

  showLoading();
  const timer = startProgress();

  try {
    const resp = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'REWRITE_JD', jdText: jd }, (r) => {
        if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
        if (r?.error) { reject(new Error(r.error)); return; }
        resolve(r);
      });
    });

    clearInterval(timer);
    const _pf = document.getElementById('progress-fill'); if (_pf) _pf.style.width = '100%';

    const result      = resp.result;
    const jobTitle    = storedData.lastJobTitle || 'this job';
    // Prefer scores returned directly from background (freshly computed after rewrite)
    // Guard against string "null" being stored in chrome.storage
    const _raw_after  = result.afterScore  ?? storedData.lastScore       ?? null;
    const _raw_before = result.beforeScore ?? storedData.lastScoreBefore ?? null;
    const afterScore  = (_raw_after  != null && _raw_after  !== 'null') ? Number(_raw_after)  : null;
    const beforeScore = (_raw_before != null && _raw_before !== 'null') ? Number(_raw_before) : null;
    const changeCount = Array.isArray(result.changes)
      ? result.changes.filter(Boolean).length
      : String(result.changes || '').split('\n').filter(s => s.trim()).length;

    if (result._provider === 'gemini') {
      showToast('🔄 Used Gemini AI (Claude was rate limited)');
    }

    showResult();
    renderHero(jobTitle, afterScore, beforeScore, changeCount);
    renderChanges(result.changes);
    renderResume(result.resume || '', result.changes);
    renderBottomBar(afterScore, beforeScore, jobTitle);

  } catch (e) {
    clearInterval(timer);
    showError(e.message);
  }
}

// ─── Escape HTML ──────────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Init ─────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  // Wire buttons
  document.getElementById('retry-btn')        ?.addEventListener('click', runRewrite);
  document.getElementById('rewrite-again-btn')?.addEventListener('click', runRewrite);
  document.getElementById('copy-btn-bottom')  ?.addEventListener('click', copyResume);

  try {
    storedData = await new Promise(r =>
      chrome.storage.local.get(
        ['resume', 'apiKey', 'geminiApiKey', 'lastJD', 'lastJobTitle', 'lastScore', 'lastScoreBefore'],
        r
      )
    );
    runRewrite();
  } catch (e) {
    showError('Could not load data: ' + e.message);
  }
});
