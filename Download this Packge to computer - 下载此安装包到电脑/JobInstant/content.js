// content.js — JobInstant v5.37 — floating badge + sidePanel fix

// Guard against double injection (manifest content_scripts + background.js onUpdated)
if (window.__jobinstant_loaded) { /* already running */ } else {
window.__jobinstant_loaded = true;

console.log('[JobInstant v5.37] Loaded');

// Clean up any UI from previous injection (handles re-install without page refresh)
['jdfit-panel','jdfit-bar','jdfit-batch-detail','jdfit-info-modal','jdfit-spin-style']
  .forEach(id => document.getElementById(id)?.remove());

let lastJobId = null;
let isRunning = false;
let cachedResult = {};

function getJobId() {
  const m = location.href.match(/currentJobId=(\d+)|jobs\/view\/(\d+)/);
  return m ? (m[1] || m[2]) : null;
}

function waitForJD(timeout = 15000) {
  return new Promise((resolve) => {
    // Try classic selectors first, then fall back to text-based search
    // (LinkedIn periodically changes to hashed class names)
    const sels = [
      '.jobs-description__content',
      '[class*="jobs-description__content"]',
      '.jobs-box__html-content',
      '[id*="job-details"]',
      '[class*="jobs-description"]',
      '.jobs-description',
      '.jobs-description-content',
      '[class*="job-view-layout"] .jobs-box__html-content',
      '.scaffold-layout__detail [class*="jobs-description"]',
    ];
    const checkBySelector = () => {
      for (const s of sels) {
        const el = document.querySelector(s);
        const text = (el?.innerText || el?.textContent || '').trim();
        if (text.length > 150) return text.slice(0, 5000);
      }
      return null;
    };
    const checkByText = () => {
      // Fallback: find div containing "About the job" with substantial content
      const allDivs = document.querySelectorAll('div, section');
      for (const el of allDivs) {
        if (el.children.length > 30) continue; // skip large containers
        const text = (el.innerText || '').trim();
        if (text.length > 300 && text.length < 8000 &&
            (text.includes('About the job') || text.includes('Job Description') || text.includes('Responsibilities') || text.includes('Qualifications'))) {
          return text.slice(0, 5000);
        }
      }
      return null;
    };
    const check = () => checkBySelector() || checkByText();
    const immediate = check();
    if (immediate) { resolve(immediate); return; }
    const start = Date.now();
    const poll = setInterval(() => {
      const jd = check();
      if (jd) { clearInterval(poll); resolve(jd); return; }
      if (Date.now()-start > timeout) { clearInterval(poll); resolve(''); }
    }, 300);
  });
}

// ── Settings: load once into memory + sessionStorage backup ──
// This survives service worker death because we never call chrome.storage
// after the initial page load
let _settingsCache = null;

const SESSION_KEY = 'jdfit_settings';

function saveToSession(data) {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      apiKey: data.apiKey || '',
      resume: data.resume || '',
      geminiApiKey: data.geminiApiKey || ''
    }));
  } catch(e) {}
}

function loadFromSession() {
  try {
    const s = sessionStorage.getItem(SESSION_KEY);
    return s ? JSON.parse(s) : null;
  } catch(e) { return null; }
}

function loadSettingsOnce() {
  // Already cached in memory
  if (_settingsCache) return Promise.resolve(_settingsCache);

  return new Promise((resolve) => {
    // Try chrome.storage first
    try {
      chrome.storage.local.get(['resume', 'apiKey', 'geminiApiKey'], (data) => {
        if (chrome.runtime.lastError || !data) {
          // chrome.storage failed — fall back to sessionStorage
          _settingsCache = loadFromSession() || {};
        } else {
          _settingsCache = data;
          saveToSession(data); // back up to sessionStorage
        }
        resolve(_settingsCache);
      });
    } catch(e) {
      // chrome.storage threw — fall back to sessionStorage
      _settingsCache = loadFromSession() || {};
      resolve(_settingsCache);
    }
  });
}

// Pre-load settings immediately when content script runs
loadSettingsOnce();

// Re-sync when user saves settings in popup
try {
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.apiKey || changes.resume) {
      chrome.storage.local.get(['resume', 'apiKey', 'geminiApiKey'], (data) => {
        if (!chrome.runtime.lastError && data) {
          _settingsCache = data;
          saveToSession(data);
          lastJobId = null;
          autoSidebar();
        }
      });
    }
  });
} catch(e) { /* ignore if context already gone */ }

function getSettings() {
  // Return from memory cache (never touches chrome.storage again)
  if (_settingsCache) return Promise.resolve(_settingsCache);
  // Fallback: try sessionStorage if memory was cleared
  const session = loadFromSession();
  if (session) { _settingsCache = session; return Promise.resolve(_settingsCache); }
  // Last resort: try loading fresh
  return loadSettingsOnce();
}

// ── Rate limiter: max 5 Claude API requests per 60 seconds (sliding window) ──
// NOTE: Only Claude calls are counted. Gemini fallback calls are NOT throttled.
const rateLimiter = {
  LIMIT: 5,
  WINDOW_MS: 60 * 1000,
  claudeTimestamps: [],   // tracks Claude API calls only
  activeProvider: 'claude',
  claudeFailedAt: null,

  waitTime() {
    const now = Date.now();
    this.claudeTimestamps = this.claudeTimestamps.filter(t => now - t < this.WINDOW_MS);
    if (this.claudeTimestamps.length < this.LIMIT) return 0;
    const oldest = this.claudeTimestamps[0];
    return (oldest + this.WINDOW_MS) - now;
  },

  // Call ONLY after successful Claude request (not Gemini)
  recordClaude() {
    this.claudeTimestamps.push(Date.now());
    console.log(`[JobInstant] Claude calls this minute: ${this.claudeTimestamps.length}/${this.LIMIT}`);
  },

  switchToGemini() {
    console.log('[JobInstant] Claude rate limited — switching to Gemini 1.5 Flash');
    this.activeProvider = 'gemini';
    this.claudeFailedAt = Date.now();
  },

  maybeRestoreClaude() {
    if (this.activeProvider === 'gemini' && this.claudeFailedAt) {
      if (Date.now() - this.claudeFailedAt > 5 * 60 * 1000) {
        console.log('[JobInstant] 5 min elapsed — retrying Claude');
        this.activeProvider = 'claude';
        this.claudeFailedAt = null;
      }
    }
  },
};

// ── Shared prompt builder ──
function buildSystemPrompt(resume) {
  return `You are a senior recruiter with 15+ years of experience. Analyze the job description against the resume below.

RESUME:
${resume}

Respond with ONLY valid JSON, no markdown, no code blocks:
{
  "score": <integer 0-100, overall match score>,
  "verdict": "<Strong Match | Good Match | Weak Match>",
  "basic_threshold": <integer 0-100, do they meet hard requirements? weight 30%>,
  "skills_match": <integer 0-100, how deeply do skills/experience match? weight 50%>,
  "competitive_edge": <integer 0-100, do they stand out vs other candidates? weight 20%>,
  "critical_missing_count": <integer, number of critical unmet requirements>,
  "critical_gap": <true if critical_missing_count >= 1, else false>,
  "summary": "<1-2 sentences max 30 words: what this role does day-to-day>",
  "match_summary": "<1 sentence: overall fit, mention biggest strength>",
  "industry": "<industry/sector of the company>",
  "sponsor": "<Yes | No | Not mentioned>",
  "matches": [
    {"label": "<3-5 word phrase>", "detail": "<why this matches, max 10 words>"},
    {"label": "<3-5 word phrase>", "detail": "<why this matches, max 10 words>"},
    {"label": "<3-5 word phrase>", "detail": "<why this matches, max 10 words>"}
  ],
  "gaps": [
    {"label": "<3-5 word phrase>", "detail": "<what is missing or weak, max 10 words>"},
    {"label": "<3-5 word phrase>", "detail": "<what is missing or weak, max 10 words>"}
  ],
  "tips": {
    "emphasize": "<what to highlight in application>",
    "keywords": "<3-5 exact keywords missing from resume>",
    "bridge": "<how to frame the biggest gap>"
  }
}

Score thresholds: 75-100 = Strong Match, 55-74 = Good Match, 0-54 = Weak Match.
Be honest. Do not inflate scores.`;
}

function parseAIResponse(text) {
  const clean = text.trim()
    .replace(/^```json\s*/,'').replace(/^```\s*/,'').replace(/```\s*$/,'').trim();
  try { return JSON.parse(clean); }
  catch(e) { throw new Error('Failed to parse response: ' + text.slice(0,100)); }
}

// ── API call via background service worker (bypasses LinkedIn CSP) ──
function bgAnalyze(jdText, provider) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'ANALYZE_JD', jdText, provider }, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      // Handle quota rate limit from Worker
      if (resp?.rateLimited) {
        const err = new Error(resp.message || 'Daily limit reached');
        err.rateLimited = true;
        err.rateLimitReason = resp.reason; // 'user' or 'global'
        err.userResetIn = resp.userResetIn || null; // seconds until reset
        reject(err);
        return;
      }
      if (resp?.error) {
        const err = new Error(resp.error);
        err.isRateLimit = !!resp.isRateLimit;
        reject(err);
        return;
      }
      resolve(resp.result);
    });
  });
}

// ── Rate limit countdown in the bar ──
function updateRateLimitStatus(secsRemaining) {
  const status = document.getElementById('jdfit-bar-status');
  if (!status) return;
  if (secsRemaining > 0) {
    status.textContent = `\u23f1 Claude limit: waiting ${secsRemaining}s — using Gemini\u2026`;
    status.style.color = '#d97706';
  } else {
    status.style.color = '';
  }
}

// ── Provider banner ──
let _providerBanner = null;
function showProviderBanner(provider) {
  if (_providerBanner) _providerBanner.remove();
  _providerBanner = document.createElement('div');
  _providerBanner.style.cssText = `
    position:fixed; bottom:20px; left:50%; transform:translateX(-50%);
    background:${provider === 'gemini' ? '#1e3a5f' : '#14532d'};
    color:white; padding:10px 20px; border-radius:10px; font-size:13px;
    font-family:sans-serif; z-index:999999; display:flex; align-items:center; gap:8px;
    box-shadow:0 4px 20px rgba(0,0,0,0.4); border:1px solid rgba(255,255,255,0.12);
  `;
  _providerBanner.innerHTML = provider === 'gemini'
    ? '\ud83d\udd04 <strong>Switched to Gemini 2.0 Flash</strong> \u2014 Claude rate limited. Will retry Claude in 5 min.'
    : '\u2705 <strong>Back to Claude</strong> \u2014 rate limit cleared.';
  document.body.appendChild(_providerBanner);
  setTimeout(() => { _providerBanner?.remove(); _providerBanner = null; }, 5000);
}

// ── Main entry point: rate limiting + provider fallback ──
// All API calls go through background.js to bypass LinkedIn's CSP
async function callClaude(_apiKey, _resume, jdText) {
  // Wait if we've hit the 5/min rate limit
  const wait = rateLimiter.waitTime();
  if (wait > 0) {
    const secs = Math.ceil(wait / 1000);
    updateRateLimitStatus(secs);
    await new Promise(r => setTimeout(r, wait));
    updateRateLimitStatus(0);
  }

  rateLimiter.maybeRestoreClaude();

  let result;
  let usedClaude = false;
  if (rateLimiter.activeProvider === 'gemini') {
    console.log('[JobInstant] Using Gemini 2.0 Flash via background (Claude was rate limited)');
    result = await bgAnalyze(jdText, 'gemini');
  } else {
    try {
      result = await bgAnalyze(jdText, 'claude');
      usedClaude = true; // only count successful Claude calls
    } catch(e) {
      if (e.isRateLimit || e.rateLimited) {
        // e.rateLimited = Worker daily quota hit; e.isRateLimit = Claude API rate limit
        // Both: switch to Gemini if possible, otherwise re-throw for caller to handle
        if (e.rateLimited) {
          // Worker quota — can't do anything, propagate to show user message
          throw e;
        }
        rateLimiter.switchToGemini();
        showProviderBanner('gemini');
        console.log('[JobInstant] Retrying with Gemini 2.0 Flash via background...');
        result = await bgAnalyze(jdText, 'gemini');
      } else {
        throw e;
      }
    }
  }

  if (usedClaude) rateLimiter.recordClaude(); // only throttle Claude requests
  return result;
}



// [scoreColor: needed by injectBadge, also defined in sidepanel.js]
function scoreColor(score) {
  if (score >= 75) return { color: '#16a34a', bg: '#f0fdf4' };
  if (score >= 55) return { color: '#d97706', bg: '#fffbeb' };
  return { color: '#dc2626', bg: '#fef2f2' };
}


function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }


// [removed pillHTML: moved to sidepanel.js]


// [removed INFO_TOOLTIP: moved to sidepanel.js]


// [removed: moved to sidepanel.js]




// ── Auto-sidebar: detect job → send to background → background opens sidePanel ──
let lastHref = location.href;
let autoDebounceTimer = null;

function autoSidebar() {
  const jobId = getJobId();
  if (!jobId) {
    chrome.runtime.sendMessage({ type: 'JI_IDLE' }).catch(() => {});
    return;
  }
  if (jobId === lastJobId && cachedResult[jobId]) {
    // Already analyzed — tell background to show cached result in panel
    chrome.runtime.sendMessage({ type: 'JI_SHOW_RESULT', data: cachedResult[jobId] }).catch(() => {});
    return;
  }
  clearTimeout(autoDebounceTimer);
  autoDebounceTimer = setTimeout(async () => {
    const currentJobId = getJobId();
    if (!currentJobId || currentJobId !== jobId) return;
    lastJobId = jobId;
    if (cachedResult[jobId]) {
      chrome.runtime.sendMessage({ type: 'JI_SHOW_RESULT', data: cachedResult[jobId] }).catch(() => {});
      return;
    }
    if (isRunning) return;
    isRunning = true;
    const jd = await waitForJD(15000);
    if (!jd || jd.length < 200) {
      isRunning = false;
      chrome.runtime.sendMessage({ type: 'JI_ANALYZE_ERROR', message: 'Could not read job description. Try refreshing.' }).catch(() => {});
      return;
    }
    // Save JD for resume rewrite
    const jobTitle = document.querySelector('.job-details-jobs-unified-top-card__job-title, h1')?.textContent?.trim() || '';
    chrome.storage.local.set({ lastJD: jd, lastJobTitle: jobTitle });
    // Send to background for analysis (sidePanel may or may not open depending on user gesture)
    chrome.runtime.sendMessage({ type: 'JI_ANALYZE', jdText: jd }, (resp) => {
      isRunning = false;
      if (resp?.result) {
        cachedResult[jobId] = resp.result;
        chrome.storage.local.set({ lastScore: resp.result.score || null });
      }
    });
  }, 2000);
}

// ── Floating badge removed — sidePanel shows results directly ──

// ── Listen for RESUME_SAVED from background (onboarding completed) ──
try {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'RESUME_SAVED') {
      console.log('[JobInstant] Resume saved notification received — re-initializing');
      // Force reload settings from storage (not cache)
      _settingsCache = null;
      loadSettingsOnce().then(() => {
        lastJobId = null;
        isRunning = false;
        clearTimeout(autoDebounceTimer);
        if (getJobId()) {
          autoSidebar();
        }
      });
    }
  });
} catch(e) {}


// [removed openSidebarLoading: moved to sidepanel.js]


function showRateLimitToast(reason) {
  document.getElementById('jdfit-rate-toast')?.remove();
  const toast = document.createElement('div');
  toast.id = 'jdfit-rate-toast';
  toast.style.cssText = `
    position:fixed; bottom:32px; left:50%; transform:translateX(-50%);
    z-index:2147483647;
    background:white;
    border-radius:14px; padding:15px 20px;
    display:flex; align-items:center; gap:12px;
    box-shadow:0 8px 32px rgba(0,0,0,0.12);
    border:1px solid #e2e8f0;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    max-width:300px;
    animation:jdfit-toast-in 0.3s cubic-bezier(0.34,1.56,0.64,1);
  `;
  toast.innerHTML = `
    <div style="width:38px;height:38px;border-radius:50%;flex-shrink:0;
      background:#eef0ff;display:flex;align-items:center;justify-content:center;">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <path d="M6 2h12M6 22h12" stroke="#2D31FA" stroke-width="2" stroke-linecap="round"/>
        <path d="M7 2v3.5L12 12M17 2v3.5L12 12" stroke="#2D31FA" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M7 22v-3.5L12 12M17 22v-3.5L12 12" stroke="#2D31FA" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M8.5 19.5h7" stroke="#2D31FA" stroke-width="2" stroke-linecap="round"/>
        <path d="M9.5 17.5h5" stroke="#2D31FA" stroke-width="1.5" stroke-linecap="round" opacity="0.5"/>
      </svg>
    </div>
    <div>
      <div style="font-weight:700;font-size:13px;color:#0f172a;margin-bottom:4px;">
        You've hit today's free limit.
      </div>
      <div style="font-size:12px;line-height:1.6;color:#64748b;">
        Come back tomorrow for more best matches!
      </div>
    </div>
    <div onclick="document.getElementById('jdfit-rate-toast')?.remove()"
      style="flex-shrink:0;cursor:pointer;color:#cbd5e1;font-size:14px;padding:4px;align-self:flex-start;">✕</div>
  `;
  if (!document.getElementById('jdfit-toast-style')) {
    const s = document.createElement('style');
    s.id = 'jdfit-toast-style';
    s.textContent = `@keyframes jdfit-toast-in { from { opacity:0; transform:translateX(-50%) translateY(16px); } to { opacity:1; transform:translateX(-50%) translateY(0); } }`;
    document.head.appendChild(s);
  }
  document.body.appendChild(toast);
  setTimeout(() => toast?.remove(), 6000);
}


// [removed openSidebarRateLimit: moved to sidepanel.js]



// [removed openSidebarError: moved to sidepanel.js]



// [removed openSidebarSetup: moved to sidepanel.js]



// [removed openSidebarWithResult: moved to sidepanel.js]


// ── Push layout: shrink the inner flex container so list+detail slide left together ──
const JDFIT_SB_WIDTH = 300;


// [removed applyPushLayout: moved to sidepanel.js]



// [removed removePushLayout: moved to sidepanel.js]



// [removed createSidebarShell: moved to sidepanel.js]



// [removed collapseSidebar: moved to sidepanel.js]



// [removed expandSidebar: moved to sidepanel.js]


// ── Navigation watcher — triggers autoSidebar on URL change ──
setInterval(() => {
  if (location.href !== lastHref) {
    lastHref = location.href;
    lastJobId = null;
    isRunning = false;
    clearTimeout(autoDebounceTimer);
    document.getElementById('jdfit-sidebar')?.remove();
    if (getJobId()) autoSidebar();
  }
}, 500);

// Initial trigger
setTimeout(() => { if (getJobId()) autoSidebar(); }, 1500);

// ═══════════════════════════════════════════════════════════
// v4.1 — BATCH SCORING (redesigned bar + collapsible panel)
// ═══════════════════════════════════════════════════════════

let batchRunning = false;
let batchCache = {};      // jobId -> full result
const USER_DAILY_LIMIT = 100; // must match Worker
let batchFilter = 'all';  // 'all' | 'strong' | 'good' | 'weak'

// ── Add spin keyframes once ──
function ensureSpinStyle() {
  if (document.getElementById('jdfit-spin-style')) return;
  const s = document.createElement('style');
  s.id = 'jdfit-spin-style';
  s.textContent = `
    @keyframes jdfit-spin { to { transform: rotate(360deg); } }
    .jdfit-badge-wrap { transition: opacity 0.2s; }
    #jdfit-bar * { box-sizing: border-box; font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
  `;
  document.head.appendChild(s);
}

// ── Job card helpers ──
function getJobCards() {
  // Priority order based on what actually works on LinkedIn
  const sels = [
    '[data-occludable-job-id]',              // most reliable - works on your account
    'li[class*="jobs-search-results"]',       // fallback
    'li.jobs-search-results__list-item',      // older layout
    '.jobs-search-results-list li',
  ];
  for (const s of sels) {
    const cards = [...document.querySelectorAll(s)].filter(c => c.querySelector('a[href*="/jobs/"]'));
    if (cards.length > 0) return cards;
  }
  return [];
}

function getJobIdFromCard(card) {
  const attr = card.getAttribute('data-occludable-job-id')
    || card.getAttribute('data-job-id')
    || card.querySelector('[data-occludable-job-id]')?.getAttribute('data-occludable-job-id')
    || card.querySelector('[data-job-id]')?.getAttribute('data-job-id');
  if (attr) return attr;
  const link = card.querySelector('a[href*="/jobs/view/"]');
  if (link) { const m = link.href.match(/\/jobs\/view\/(\d+)/); if (m) return m[1]; }
  return null;
}

async function getJDFromCard(card) {
  // Try LinkedIn internal API first (fast, no click needed)
  const jobId = getJobIdFromCard(card);
  if (jobId) {
    try {
      const jd = await fetchJDFromAPI(jobId);
      if (jd && jd.length > 100) return jd;
    } catch(e) {
      console.warn('[JobInstant] API fetch failed, falling back to click:', e.message);
    }
  }

  // Method 2: Silently fetch job page HTML (no click, no DOM change)
  try {
    const jd = await fetchJDFromPage(jobId);
    if (jd && jd.length > 100) return jd;
  } catch(e) {
    console.warn('[JobInstant] Page fetch failed:', e.message);
  }

  // Method 3: Read from currently visible panel if this job is already open
  try {
    const currentId = getJobId();
    if (currentId === jobId) {
      // Try classic selectors
      const panel = document.querySelector('.jobs-description__content, .jobs-description-content, [class*="job-view-layout"], [id*="job-details"]');
      const text = panel?.textContent?.replace(/\s+/g, ' ').trim();
      if (text && text.length > 100) return text;
      // Fallback: text-based search (for hashed class names)
      const allDivs = document.querySelectorAll('div, section');
      for (const el of allDivs) {
        if (el.children.length > 30) continue;
        const t = (el.innerText || '').trim();
        if (t.length > 300 && t.length < 8000 &&
            (t.includes('About the job') || t.includes('Responsibilities') || t.includes('Qualifications') || t.includes('Requirements'))) {
          return t.slice(0, 5000);
        }
      }
    }
  } catch(e) {}

  // NEVER click — return null marks card as error, never disrupts user
  return null;
}

async function fetchJDFromAPI(jobId) {
  // Try both decoration versions with correct /voyager prefix
  const urls = [
    `/voyager/api/jobs/jobPostings/${jobId}?decorationId=com.linkedin.voyager.deco.jobs.web.shared.WebFullJobPosting-65`,
    `/voyager/api/jobs/jobPostings/${jobId}?decorationId=com.linkedin.voyager.deco.jobs.web.shared.WebLightJobPosting-23`,
  ];
  const csrf = getCsrfToken();
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: {
          'accept': 'application/vnd.linkedin.normalized+json+2.1',
          'csrf-token': csrf,
          'x-restli-protocol-version': '2.0.0',
        },
        credentials: 'include'
      });
      if (!res.ok) continue;
      const data = await res.json();
      const descObj = data?.data?.description || data?.included?.find(i => i?.description)?.description;
      const desc =
        data?.data?.description?.text ||
        data?.data?.formattedDescription ||
        data?.included?.find(i => i?.description?.text)?.description?.text ||
        data?.included?.find(i => i?.formattedDescription)?.formattedDescription ||
        (typeof descObj === 'string' ? descObj : '') ||
        '';
      const text = typeof desc === 'string' ? desc : (desc?.text || '');
      if (text && text.length > 100) return text;
    } catch(e) { /* try next url */ }
  }
  throw new Error('API returned no JD');
}

async function fetchJDFromPage(jobId) {
  // Background fetch — never inserted into DOM, user sees nothing
  const res = await fetch(`/jobs/view/${jobId}/`, {
    credentials: 'include',
    headers: { 'accept': 'text/html' }
  });
  if (!res.ok) throw new Error(`Page fetch ${res.status}`);
  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');

  const selectors = [
    '.jobs-description__content',
    '.jobs-description-content',
    '#job-details',
    '[class*="description__text"]',
    '.description__text',
  ];
  for (const sel of selectors) {
    const el = doc.querySelector(sel);
    const text = el?.textContent?.replace(/\s+/g, ' ').trim();
    if (text && text.length > 100) return text;
  }

  // Fallback: JSON-LD structured data in page
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const json = JSON.parse(s.textContent);
      const desc = json?.description || json?.['@graph']?.[0]?.description;
      if (desc && desc.length > 100) return desc.replace(/<[^>]+>/g, ' ').trim();
    } catch(e) {}
  }

  throw new Error('No JD found in page HTML');
}

function getCsrfToken() {
  // LinkedIn stores CSRF token in cookies
  const match = document.cookie.match(/JSESSIONID="?([^";]+)"?/);
  return match ? match[1] : '';
}

// ── Score badge on each card ──
function injectBadge(card, state, result, errorMsg) {
  card.querySelector('.jdfit-badge-wrap')?.remove();
  if (getComputedStyle(card).position === 'static') card.style.position = 'relative';

  const wrap = document.createElement('div');
  wrap.className = 'jdfit-badge-wrap';
  wrap.style.cssText = `position:absolute;top:50%;right:8px;transform:translateY(-50%);z-index:100;`;

  if (state === 'loading') {
    wrap.innerHTML = `<div style="width:20px;height:20px;border:2px solid #dde1ff;
      border-top-color:#2D31FA;border-radius:50%;animation:jdfit-spin 0.7s linear infinite;"></div>`;
  } else if (state === 'done' && result) {
    const { color, bg } = scoreColor(result.score);
    const lbl = result.score >= 75 ? 'Strong' : result.score >= 55 ? 'Good' : 'Weak';
    wrap.style.cursor = 'pointer';
    wrap.innerHTML = `
      <div style="background:${bg};border:1.5px solid ${color}50;border-radius:10px;
        padding:5px 10px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,0.1);min-width:52px;">
        <div style="display:flex;align-items:flex-start;justify-content:center;line-height:1;">
          <div style="color:${color};font-size:16px;font-weight:900;line-height:1;">${result.score}</div>
          <div style="color:${color};font-size:7px;font-weight:700;opacity:0.5;margin-top:2px;">%</div>
        </div>
        <div style="color:${color};font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.03em;margin-top:2px;opacity:0.75;">${lbl}</div>
      </div>`;
    wrap.onclick = (e) => {
      e.stopPropagation();
      showBatchDetailPanel(result);
    };
  } else if (state === 'error') {
    const tip = errorMsg ? ` title="${errorMsg.replace(/"/g, '&quot;')}"` : '';
    wrap.innerHTML = `<div${tip} style="background:#fef2f2;border:1.5px solid #fca5a5;border-radius:7px;
      padding:3px 6px;text-align:center;cursor:help;">
      <div style="color:#dc2626;font-size:9px;font-weight:700;">ERR</div></div>`;
  }
  card.appendChild(wrap);
  // Change ④: clicking anywhere on a scored card opens sidePanel
  if (state === 'done' && result) bindCardClick(card, result);
}

// ── RIGHT SIDE: show batch detail in sidePanel ──
function showBatchDetailPanel(data) {
  chrome.runtime.sendMessage({ type: 'JI_OPEN_PANEL' }).catch(() => {});
  chrome.runtime.sendMessage({ type: 'JI_SHOW_RESULT', data }).catch(() => {});
}

// ── Bind card click → open sidePanel with cached result ──
function bindCardClick(card, result) {
  if (card._jiCardBound) return;
  card._jiCardBound = true;
  card.style.cursor = 'pointer';
  card.addEventListener('click', (e) => {
    // Don't trigger if user clicked a link, button, or the badge itself
    if (e.target.closest('a, button, .jdfit-badge-wrap')) return;
    showBatchDetailPanel(result);
  });
}

// ── TOP BAR: Score Jobs + filters (Design D — horizontal toolbar) ──
function injectScoreAllBar() {
  // Remove any stale instances
  document.getElementById('jdfit-bar')?.remove();
  document.getElementById('jdfit-score-li')?.remove();
  document.getElementById('jdfit-left-strip')?.remove();
  document.getElementById('jdfit-toolbar')?.remove();

  // ── Find insertion point: first job card's parent container ──
  const firstCard = getJobCards()[0];
  if (!firstCard) {
    console.warn('[JobInstant] no job cards found, retrying in 2s');
    setTimeout(injectScoreAllBar, 2000);
    return;
  }
  // Insert before the first card's parent UL/OL, or before the card list container
  const cardList = firstCard.closest('ul, ol') || firstCard.parentElement;
  const insertParent = cardList?.parentElement;
  if (!insertParent) {
    console.warn('[JobInstant] insert parent not found, retrying in 2s');
    setTimeout(injectScoreAllBar, 2000);
    return;
  }

  // ── Build horizontal toolbar ──
  const toolbar = document.createElement('div');
  toolbar.id = 'jdfit-toolbar';
  toolbar.innerHTML = `
    <style>
      #jdfit-toolbar {
        padding: 7px 12px;
        display: flex;
        align-items: center;
        gap: 6px;
        border-bottom: 2px solid #ededfe;
        background: #fafaff;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        box-sizing: border-box;
      }
      #jdfit-score-btn {
        display: flex; align-items: center; justify-content: center; gap: 5px;
        background: linear-gradient(135deg, #2D31FA, #4f46e5);
        border: none; border-radius: 8px;
        padding: 12px 0; width: 100%;
        color: white; cursor: pointer; font-family: inherit;
        font-size: 17px; font-weight: 800; letter-spacing: -0.01em;
        box-shadow: 0 4px 14px rgba(45,49,250,0.4);
        flex-shrink: 0;
      }
      #jdfit-score-btn.jdfit-small {
        width: auto; padding: 10px 20px;
        font-size: 15px; border-radius: 8px;
        box-shadow: 0 3px 10px rgba(45,49,250,0.35);
      }
      #jdfit-score-btn.jdfit-scoring {
        background: #f1f5f9; color: #94a3b8;
        border: 2px solid #e2e8f0; cursor: not-allowed;
        box-shadow: none;
      }
      #jdfit-toolbar-divider {
        width: 1px; height: 22px; background: #ddd;
        flex-shrink: 0; display: none;
      }
      #jdfit-filter-btns {
        display: none; align-items: center; gap: 5px;
      }
      /* Filter pill: 3 states — active, unselected, disabled */
      .jdfit-fb {
        padding: 5px 14px; border-radius: 6px;
        cursor: pointer; font-family: inherit;
        font-size: 11px; font-weight: 600;
        box-sizing: border-box;
        transition: all 0.12s ease;
        border: 1.5px solid transparent;
        background: white;
      }
      /* Unselected (available): white bg + faded color border + color text */
      .jdfit-fb[data-f="all"]    { border-color: #8b5cf640; color: #8b5cf6; }
      .jdfit-fb[data-f="strong"] { border-color: #16a34a40; color: #16a34a; }
      .jdfit-fb[data-f="good"]   { border-color: #d9770640; color: #d97706; }
      .jdfit-fb[data-f="weak"]   { border-color: #dc262640; color: #dc2626; }
      /* Active: solid fill + white text */
      .jdfit-fb[data-f="all"].jdfit-active    { border-color: #8b5cf6; background: #8b5cf6; color: white; font-weight: 800; }
      .jdfit-fb[data-f="strong"].jdfit-active { border-color: #16a34a; background: #16a34a; color: white; font-weight: 800; }
      .jdfit-fb[data-f="good"].jdfit-active   { border-color: #d97706; background: #d97706; color: white; font-weight: 800; }
      .jdfit-fb[data-f="weak"].jdfit-active   { border-color: #dc2626; background: #dc2626; color: white; font-weight: 800; }
      /* Disabled: gray + low opacity */
      .jdfit-fb.jdfit-disabled {
        opacity: 0.65; cursor: not-allowed; pointer-events: none;
        border-color: #d1d5db !important; background: #f9fafb !important; color: #6b7280 !important;
      }
    </style>

    <button id="jdfit-score-btn">⚡ Score Jobs</button>

    <div id="jdfit-toolbar-divider"></div>

    <div id="jdfit-filter-btns">
      <div class="jdfit-fb jdfit-active" data-f="all"><span class="fl">All</span></div>
      <div class="jdfit-fb" data-f="strong"><span class="fl">Strong</span></div>
      <div class="jdfit-fb" data-f="good"><span class="fl">Good</span></div>
      <div class="jdfit-fb" data-f="weak"><span class="fl">Weak</span></div>
    </div>
  `;

  // Insert toolbar before the job card list
  insertParent.insertBefore(toolbar, cardList);

  // ── stub bar for legacy code that checks #jdfit-bar ──
  if (!document.getElementById('jdfit-bar')) {
    const stub = document.createElement('div');
    stub.id = 'jdfit-bar';
    stub.style.display = 'none';
    document.body.appendChild(stub);
  }

  // ── Wire Score Jobs button ──
  document.getElementById('jdfit-score-btn').addEventListener('click', runBatchScore);

  // ── Wire filter buttons ──
  toolbar.querySelectorAll('.jdfit-fb').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('jdfit-disabled')) return;
      const f = btn.getAttribute('data-f');
      batchFilter = (batchFilter === f && f !== 'all') ? 'all' : f;
      updateFilterUI();
      applyFilter();
    });
  });

  // Show onboarding hint on first install
  showOnboardingHint();
}

// ── Update filter button active states + disabled ──
function updateFilterUI() {
  const all    = Object.values(batchCache);
  const strong = all.filter(r => r.score >= 75).length;
  const good   = all.filter(r => r.score >= 55 && r.score < 75).length;
  const weak   = all.filter(r => r.score < 55).length;

  // Show divider + filter panel once at least 1 card is scored
  if (all.length > 0) {
    const divider = document.getElementById('jdfit-toolbar-divider');
    const filterBtns = document.getElementById('jdfit-filter-btns');
    if (divider) divider.style.display = 'block';
    if (filterBtns) filterBtns.style.display = 'flex';

    // Shrink Score Jobs button when filters appear
    const btn = document.getElementById('jdfit-score-btn');
    if (btn && !btn.classList.contains('jdfit-scoring')) {
      btn.classList.add('jdfit-small');
      btn.style.width = 'auto';
    }
  }

  // Disabled state: count=0 → disabled (except All)
  const counts = { all: all.length, strong, good, weak };
  document.querySelectorAll('.jdfit-fb').forEach(b => {
    const f = b.getAttribute('data-f');
    if (f === 'all') {
      b.classList.remove('jdfit-disabled');
    } else {
      b.classList.toggle('jdfit-disabled', counts[f] === 0);
    }
  });

  // Auto-reset: if current filter has 0 results, fall back to 'all'
  if (batchFilter !== 'all' && counts[batchFilter] === 0) {
    batchFilter = 'all';
  }

  // Active state
  document.querySelectorAll('.jdfit-fb').forEach(b => {
    b.classList.toggle('jdfit-active', b.getAttribute('data-f') === batchFilter);
  });
}


// ── First-install onboarding hint ──
function showOnboardingHint() {
  chrome.storage.local.get(['onboardingShown'], (data) => {
    if (data.onboardingShown) return;

    const btn = document.getElementById('jdfit-score-btn');
    if (!btn) return;

    // Pulse animation on button
    btn.style.animation = 'jdfit-onboard-pulse 1.8s ease-in-out infinite';

    // Inject pulse keyframes if not already there
    if (!document.getElementById('jdfit-onboard-style')) {
      const s = document.createElement('style');
      s.id = 'jdfit-onboard-style';
      s.textContent = `
        @keyframes jdfit-onboard-pulse {
          0%,100% { box-shadow: 0 3px 12px rgba(45,49,250,0.35), 0 0 0 0 rgba(45,49,250,0.5); }
          50%      { box-shadow: 0 3px 12px rgba(45,49,250,0.35), 0 0 0 12px rgba(45,49,250,0); }
        }`;
      document.head.appendChild(s);
    }

    // Position tooltip using btn's bounding rect — fixed to viewport
    const btnRect = btn.getBoundingClientRect();
    const tipWidth = 360;
    const tipLeft = btnRect.left + (btnRect.width - tipWidth) / 2; // center-align with button

    // Tooltip bubble — fixed positioning, appended to body (no LinkedIn DOM interference)
    const tip = document.createElement('div');
    tip.id = 'jdfit-onboard-tip';
    tip.style.cssText = `
      position:fixed; top:${btnRect.bottom + 14}px; left:${Math.max(8, tipLeft)}px; z-index:99999;
      width:${tipWidth}px; background:white; color:#1f2937; border:2px solid #d1d5db; border-radius:10px;
      padding:12px 14px; padding-right:36px; font-size:12px; font-weight:500; line-height:1.5;
      box-shadow:0 6px 20px rgba(45,49,250,0.12);
      display:flex; align-items:flex-start; gap:10px;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    `;
    tip.innerHTML = `
      <button id="jdfit-tip-close" style="position:absolute;top:6px;right:6px;width:20px;height:20px;border-radius:50%;
        background:rgba(0,0,0,0.05);border:none;color:#9ca3af;font-size:11px;cursor:pointer;
        display:flex;align-items:center;justify-content:center;">✕</button>
      <span style="font-size:18px;flex-shrink:0;margin-top:1px;">👆</span>
      <span><b style="display:block;font-size:13px;margin-bottom:2px;color:#1f2937;">Score all jobs in one click</b><span style="color:#6b7280;">Instantly see your best matches</span></span>
    `;

    // Arrow — use overlay technique to hide the border line beneath the arrow
    const arrowOuter = document.createElement('div');
    arrowOuter.style.cssText = `
      position:absolute; top:-8px; left:50%; margin-left:-8px; width:14px; height:14px;
      background:white; transform:rotate(45deg);
      border-top:2px solid #d1d5db; border-left:2px solid #d1d5db;
    `;
    const arrowCover = document.createElement('div');
    arrowCover.style.cssText = `
      position:absolute; top:-1px; left:50%; margin-left:-10px; width:20px; height:4px;
      background:white; z-index:1;
    `;
    tip.appendChild(arrowOuter);
    tip.appendChild(arrowCover);

    // Append to body — completely outside LinkedIn DOM
    document.body.appendChild(tip);

    function dismissHint() {
      btn.style.animation = '';
      tip.remove();
      chrome.storage.local.set({ onboardingShown: true });
    }

    // Dismiss on close button
    document.getElementById('jdfit-tip-close')?.addEventListener('click', (e) => {
      e.stopPropagation();
      dismissHint();
    });

    // Dismiss when Score Jobs is clicked
    btn.addEventListener('click', dismissHint, { once: true });

    // Auto-dismiss after 10 seconds
    setTimeout(dismissHint, 10000);
  });
}

function applyFilter() {
  getJobCards().forEach(card => {
    const id = getJobIdFromCard(card);
    const result = id ? batchCache[id] : null;

    if (batchFilter === 'all') {
      card.style.opacity = '1';
      card.style.pointerEvents = '';
      return;
    }

    // Unscored cards: always show at full opacity
    if (!result) {
      card.style.opacity = '1';
      card.style.pointerEvents = '';
      return;
    }

    let show = false;
    if (batchFilter === 'strong') show = result.score >= 75;
    if (batchFilter === 'good')   show = result.score >= 55 && result.score < 75;
    if (batchFilter === 'weak')   show = result.score < 55;

    card.style.opacity = show ? '1' : '0.2';
    card.style.pointerEvents = show ? '' : 'none';
  });

  updateFilterUI();
}

// ── IntersectionObserver: auto-score cards as user scrolls ──
let _scrollObserver = null;

function observeNewCards() {
  if (!_scrollObserver) {
    _scrollObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const card = entry.target;
        const id = getJobIdFromCard(card);
        if (!id || batchCache[id] || card.querySelector('.jdfit-badge-wrap[data-state="loading"]')) return;
        // Only auto-score if user has already clicked Score Jobs at least once
        if (Object.keys(batchCache).length === 0) return;
        scoreOneCard(card);
      });
    }, { rootMargin: '200px', threshold: 0.1 });
  }
  getJobCards().forEach(card => {
    const id = getJobIdFromCard(card);
    if (id && !batchCache[id]) _scrollObserver.observe(card);
  });
}

async function scoreOneCard(card) {
  const id = getJobIdFromCard(card);
  if (!id || batchCache[id]) return;
  // Mark loading so we don't double-score
  injectBadge(card, 'loading', null);
  card.querySelector('.jdfit-badge-wrap')?.setAttribute('data-state', 'loading');
  try {
    const jd = await getJDFromCard(card);
    if (!jd || jd.length < 100) { injectBadge(card, 'error', null); return; }
    const result = await callClaude(null, null, jd);
    batchCache[id] = result;
    cachedResult[id] = result;
    injectBadge(card, 'done', result);
    applyFilter();
    // Reveal filter row after first score
    updateFilterUI();
  } catch(e) {
    console.warn('[JobInstant scroll]', e.message);
    injectBadge(card, 'error', null);
  }
}

// ── Main batch scoring ──
async function runBatchScore() {
  if (batchRunning) return;
  // Ask background.js if resume is configured (background reads chrome.storage directly)
  const check = await new Promise(resolve =>
    chrome.runtime.sendMessage({ type: 'CHECK_SETTINGS' }, r => resolve(r))
  );
  if (check?.error === 'NOT_CONFIGURED') {
    alert('Please upload your resume in JobInstant settings first.\n\nClick the ⚡ extension icon → Settings.');
    return;
  }

  // Open sidePanel on first Score Jobs click (user gesture present)
  chrome.runtime.sendMessage({ type: 'JI_OPEN_PANEL' }).catch(() => {});

  batchRunning = true;
  ensureSpinStyle();
  const btn = document.getElementById('jdfit-score-btn');
  const status = document.getElementById('jdfit-bar-status');
  btn.textContent = '⏳ Scoring…';
  btn.classList.add('jdfit-scoring');
  btn.classList.remove('jdfit-small');
  btn.style.width = '100%';
  // Hide filters during scoring
  const divider = document.getElementById('jdfit-toolbar-divider');
  const filterBtns = document.getElementById('jdfit-filter-btns');
  if (divider) divider.style.display = 'none';
  if (filterBtns) filterBtns.style.display = 'none';

  const cards = getJobCards();
  const total = cards.length;
  let done = 0;
  if (status) status.textContent = `Scoring 0 / ${total}…`;

  cards.forEach(c => injectBadge(c, 'loading', null));

  // Score all cards in parallel — no batching, results appear as each completes
  const scoreOne = async (card) => {
    const jobId = getJobIdFromCard(card);
    if (!jobId) { injectBadge(card, 'error', null); done++; updateStatus(); return; }
    if (batchCache[jobId]) {
      injectBadge(card, 'done', batchCache[jobId]);
      done++; updateStatus(); return;
    }
    try {
      const jd = await getJDFromCard(card);
      if (!jd || jd.length < 100) { injectBadge(card, 'error', null); done++; updateStatus(); return; }
      const result = await callClaude(null, null, jd);
      batchCache[jobId] = result;
      cachedResult[jobId] = result;
      injectBadge(card, 'done', result);
      // Show result immediately, update filter chips
      applyFilter();
      updateFilterUI();
    } catch(e) {
      if (e.rateLimited) {
        queue.length = 0; // stop remaining jobs
        const status = document.getElementById('jdfit-bar-status');
        if (status) {
          status.textContent = e.rateLimitReason === 'user'
            ? `⏰ ${USER_DAILY_LIMIT} free scores used today. Resets tomorrow.`
            : 'Server busy — try again tomorrow.';
        }
        injectBadge(card, 'error', null, 'Rate limit');
        showRateLimitToast(e.rateLimitReason);
        done++; updateStatus(); return;
      }
      // Retry once after 2s delay
      console.warn('[JobInstant batch] error (will retry):', jobId, e.message);
      await new Promise(r => setTimeout(r, 2000));
      try {
        const jd2 = await getJDFromCard(card);
        if (jd2 && jd2.length >= 100) {
          const result2 = await callClaude(null, null, jd2);
          batchCache[jobId] = result2;
          cachedResult[jobId] = result2;
          injectBadge(card, 'done', result2);
          applyFilter();
          updateFilterUI();
          done++; updateStatus(); return;
        }
      } catch(e2) {
        console.warn('[JobInstant batch] retry failed:', jobId, e2.message);
      }
      injectBadge(card, 'error', null, e.message?.slice(0, 40));
    }
    done++; updateStatus();
  };

  function updateStatus() {
    const strongCount = Object.values(batchCache).filter(r => r.score >= 75).length;
    const msg = done >= total
      ? `✅ ${done} scored — ${strongCount} strong`
      : `⏳ Scoring ${done} / ${total}…`;
    // Show progress in the button itself
    if (btn) btn.textContent = msg;
    if (status) status.textContent = msg;
    // Also update button style when done
    if (done >= total && btn) {
      btn.textContent = '⚡ Score Jobs';
      btn.classList.remove('jdfit-scoring');
      btn.classList.add('jdfit-small');
      btn.style.width = 'auto';
    }
  }

  // Run up to 2 in parallel with staggered start to avoid overwhelming Worker API
  const CONCURRENCY = 2;
  const queue = [...cards];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async (_, workerIdx) => {
    // Stagger start: worker 1 starts immediately, worker 2 after 500ms
    if (workerIdx > 0) await new Promise(r => setTimeout(r, 500));
    while (queue.length > 0) {
      const card = queue.shift();
      if (card) await scoreOne(card);
      // Small delay between requests to avoid rate limiting
      if (queue.length > 0) await new Promise(r => setTimeout(r, 300));
    }
  });
  await Promise.all(workers);

  batchRunning = false;
  // Restore Score Jobs button to original design
  btn.innerHTML = `⚡ Score Jobs`;
  btn.classList.remove('jdfit-scoring');
  btn.classList.add('jdfit-small');
  btn.style.width = 'auto';
  const strongCount = Object.values(batchCache).filter(r => r.score >= 75).length;
  if (status) status.textContent = `✅ ${done} scored — ${strongCount} strong match${strongCount !== 1 ? 'es' : ''}`;

  // Watch for more cards appearing as user scrolls
  observeNewCards();

  // Also watch for LinkedIn loading more cards dynamically
  setTimeout(observeNewCards, 2000);
  setTimeout(observeNewCards, 5000);
}

// ── Watch for LinkedIn SPA navigation ──
let _batchObserver = null;
let _barReinjecting = false;
let _lastHref = ''; // will be set on first checkAndReinject call
let _lastCardCount = 0;

// Extract just the search keywords from URL — ignore currentJobId/geoId/origin changes
function getSearchKey() {
  try {
    const p = new URLSearchParams(location.search);
    return (p.get('keywords') || '') + '|' + (p.get('geoId') || '') + '|' + (p.get('f_TPR') || '');
  } catch(e) { return location.href; }
}

function checkAndReinject() {
  if (!location.href.includes('/jobs/')) return;

  const currentKey  = getSearchKey();
  const searchChanged = currentKey !== _lastHref;
  const barMissing  = !document.getElementById('jdfit-bar');
  const cards       = getJobCards();
  const cardCountChanged = cards.length > 0 && cards.length !== _lastCardCount;

  if (searchChanged) {
    // New search keywords — clear cache and reset everything
    console.log('[JobInstant] New search detected:', currentKey);
    _lastHref = currentKey;
    _lastCardCount = 0;
    batchCache = {};
    if (_scrollObserver) { _scrollObserver.disconnect(); _scrollObserver = null; }
    document.getElementById('jdfit-bar')?.remove();
    document.getElementById('jdfit-toolbar')?.remove();
    document.getElementById('jdfit-batch-detail')?.remove();
    _barReinjecting = false;
  }

  if ((barMissing || (cardCountChanged && !document.getElementById('jdfit-bar'))) && !_barReinjecting) {
    _barReinjecting = true;
    setTimeout(() => {
      if (!document.getElementById('jdfit-bar') && getJobCards().length > 0) {
        _lastCardCount = getJobCards().length;
        injectScoreAllBar();
      }
      _barReinjecting = false;
    }, 700);
  }
}

function watchForJobList() {
  if (_batchObserver) return;
  _batchObserver = new MutationObserver(checkAndReinject);
  _batchObserver.observe(document.body, { childList: true, subtree: true });
}

// ── Init ──
function initBatch() {
  if (location.href.includes('/jobs/')) {
    _lastHref = getSearchKey(); // seed so first search change is detected correctly
    const tryInject = () => {
      const cards = getJobCards();
      if (cards.length > 0 && !document.getElementById('jdfit-bar')) {
        _lastCardCount = cards.length;
        injectScoreAllBar();
      }
    };
    setTimeout(tryInject, 2000);
    setTimeout(tryInject, 4000);
    setTimeout(tryInject, 7000);
  }
  watchForJobList();
}

initBatch();

// ── Score info modal — skill breakdown ──
let _lastSkillBreakdown = null; // stored when result arrives

function showScoreInfoModal() {
  document.getElementById('jdfit-score-modal')?.remove();

  const sb = _lastSkillBreakdown || {};
  const hardSkills = sb.hard_skills || [];
  const softSkills = sb.soft_skills || [];
  const prefSkills = sb.preferred_skills || [];

  const scoreColor = (n) => n >= 70 ? '#16a34a' : n >= 50 ? '#d97706' : '#dc2626';
  const avgScore = (arr) => arr.length ? Math.round(arr.reduce((s,x) => s+(x.score||0),0)/arr.length) : null;

  const skillRow = (item) => {
    const c = scoreColor(item.score||0);
    return `<div style="display:flex;align-items:center;gap:10px;
      padding:7px 0;border-bottom:1px solid #f1f5f9;">
      <div style="font-size:12px;color:#334155;flex:1;line-height:1.3;">${item.skill||''}</div>
      <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
        <div style="width:50px;height:4px;background:#f1f5f9;border-radius:3px;overflow:hidden;">
          <div style="width:${item.score||0}%;height:100%;background:${c};border-radius:3px;"></div>
        </div>
        <div style="font-size:11px;font-weight:700;color:${c};width:22px;text-align:right;">${item.score||0}</div>
      </div>
    </div>`;
  };

  const sectionCard = (title, skills) => {
    const avg = avgScore(skills);
    const ac = avg != null ? scoreColor(avg) : '#94a3b8';
    const rows = skills.length
      ? skills.map(skillRow).join('')
      : `<div style="font-size:11px;color:#94a3b8;padding:10px 0;">No data available</div>`;
    return `
      <div style="background:white;border-radius:10px;border:1px solid #e2e8f0;
        overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.05);margin-bottom:10px;">
        <div style="display:flex;align-items:center;justify-content:space-between;
          padding:11px 14px;background:#f0f1ff;border-bottom:1px solid #e2e8f0;">
          <div style="font-size:12px;font-weight:700;color:#2D31FA;">${title}</div>
          ${avg != null ? `<div style="font-size:17px;font-weight:800;color:${ac};">${avg}</div>` : ''}
        </div>
        <div style="padding:4px 14px 8px;">${rows}</div>
      </div>`;
  };

  const modal = document.createElement('div');
  modal.id = 'jdfit-score-modal';
  modal.style.cssText = `
    position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;
    background:rgba(0,0,0,0.45);
    display:flex;align-items:center;justify-content:flex-end;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  `;

  modal.innerHTML = `
    <div style="background:#f8fafc;border-radius:16px 0 0 16px;width:340px;height:100vh;
      box-shadow:-8px 0 40px rgba(0,0,0,0.2);overflow:hidden;display:flex;flex-direction:column;">

      <div style="background:linear-gradient(135deg,#1a1dcc,#2D31FA);padding:15px 18px;
        display:flex;align-items:center;justify-content:space-between;flex-shrink:0;">
        <div style="color:white;font-size:14px;font-weight:700;">Skill Match Breakdown</div>
        <button id="jdfit-modal-close"
          style="background:rgba(255,255,255,0.15);border:none;color:white;
          width:26px;height:26px;border-radius:50%;cursor:pointer;font-size:14px;
          display:flex;align-items:center;justify-content:center;">✕</button>
      </div>

      <div style="flex:1;overflow-y:auto;padding:12px;">
        ${sectionCard('🔧 Required Hard Skills', hardSkills)}
        ${sectionCard('💬 Required Soft Skills', softSkills)}
        ${sectionCard('⭐ Plus Skills', prefSkills)}
      </div>
    </div>`;

  document.body.appendChild(modal);

  modal.querySelector('#jdfit-modal-close').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
}

} // end guard: window.__jobinstant_loaded
