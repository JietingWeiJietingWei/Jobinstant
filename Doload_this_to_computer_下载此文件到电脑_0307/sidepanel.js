// sidepanel.js — JobInstant v5.39 — Single view with persisted accordion state

const USER_DAILY_LIMIT = 100; // must match Worker

let _lastResultData = null; // used by event delegation for Tailor button

// ── Helpers ──
function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function scoreColor(score) {
  if (score >= 75) return '#16a34a';
  if (score >= 55) return '#d97706';
  return '#dc2626';
}
function scoreLabel(score) {
  if (score >= 75) return 'Strong Match';
  if (score >= 55) return 'Good Match';
  return 'Weak Match';
}
function scoreBgLight(score) {
  if (score >= 75) return '#f0fdf4';
  if (score >= 55) return '#fffbeb';
  return '#fef2f2';
}

function ringHTML(score, size, strokeW, trackColor) {
  const col = scoreColor(score);
  const track = trackColor || '#f3f4f6';
  const r = (size / 2) - strokeW;
  const circ = +(2 * Math.PI * r).toFixed(2);
  const offset = +(circ * (1 - score / 100)).toFixed(2);
  const h = size / 2;
  const fs = size > 50 ? 26 : 12;
  const pfs = size > 50 ? 15 : 8;
  return `
    <div style="position:relative;width:${size}px;height:${size}px;flex-shrink:0;">
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="transform:rotate(-90deg);display:block;">
        <circle cx="${h}" cy="${h}" r="${r}" fill="none" stroke="${track}" stroke-width="${strokeW}"/>
        <circle cx="${h}" cy="${h}" r="${r}" fill="none" stroke="${col}" stroke-width="${strokeW}"
          stroke-linecap="round" stroke-dasharray="${circ}" stroke-dashoffset="${offset}"/>
      </svg>
      <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;">
        <span style="font-size:${fs}px;font-weight:900;color:${col};">${score ?? '—'}</span><span style="font-size:${pfs}px;font-weight:700;color:${col};opacity:0.65;">%</span>
      </div>
    </div>`;
}

function scoreBarHTML(label, score) {
  const col = scoreColor(score);
  return `
    <div style="padding:8px 0;border-bottom:1px solid #f7f7f7;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px;">
        <span style="font-size:12px;font-weight:500;color:#374151;line-height:1.4;">${esc(label)}</span>
        <span style="font-size:11px;font-weight:700;color:${col};min-width:36px;text-align:right;">${score}%</span>
      </div>
      <div style="height:3px;background:#f0f0f0;border-radius:2px;overflow:hidden;">
        <div style="height:100%;width:${score}%;background:${col};border-radius:2px;"></div>
      </div>
    </div>`;
}

function dimSectionHTML(title, score, items, id, open) {
  const col = scoreColor(score);
  const bg = scoreBgLight(score);
  const barsHTML = items.map(it => scoreBarHTML(it.label, it.score)).join('');
  return `
    <div class="ji-dim-section">
      <button class="ji-dim-header" data-dim="${id}" style="background:${bg};">
        <div style="display:flex;align-items:center;gap:8px;">
          <div style="width:30px;height:30px;border-radius:50%;background:white;
            display:flex;align-items:center;justify-content:center;border:2px solid ${col};">
            <span style="font-size:11px;font-weight:900;color:${col};">${score}</span><span style="font-size:7px;font-weight:700;color:${col};opacity:0.65;">%</span>
          </div>
          <span style="font-size:13px;font-weight:700;color:#1f2937;">${esc(title)}</span>
        </div>
        <span class="ji-dim-arrow" style="${open ? 'transform:rotate(180deg)' : ''}">▼</span>
      </button>
      <div class="ji-dim-body" data-dim-body="${id}" style="display:${open ? 'block' : 'none'};">
        ${barsHTML}
      </div>
    </div>`;
}

// ── Accordion state persistence ──
function saveAccordionState() {
  const state = {};
  document.querySelectorAll('.ji-dim-body').forEach(body => {
    const id = body.getAttribute('data-dim-body');
    state[id] = body.style.display !== 'none';
  });
}

// ── Show/hide sections ──
function showOnly(id) {
  ['ji-loading','ji-result','ji-error','ji-ratelimit','ji-setup'].forEach(i => {
    const el = document.getElementById(i);
    if (!el) return;
    el.style.display = (i === id) ? (i === 'ji-loading' || i === 'ji-ratelimit' ? 'flex' : 'block') : 'none';
  });
}

function showIdle() { showOnly(null); }
function showLoading() { showOnly('ji-loading'); }
function showSetup() { showOnly('ji-setup'); }

// ── Open settings (reuse existing tab) ──
function openSettingsTab() {
  const url = chrome.runtime.getURL('onboarding.html');
  chrome.tabs.query({ url }, (tabs) => {
    if (tabs && tabs.length > 0) {
      chrome.tabs.update(tabs[0].id, { active: true });
      chrome.windows.update(tabs[0].windowId, { focused: true });
    } else {
      chrome.tabs.create({ url });
    }
  });
}

function showError(msg) {
  document.getElementById('ji-error-msg').innerHTML = msg;
  // Show a "Update Resume" button when error likely caused by bad resume
  const errEl = document.getElementById('ji-error');
  const existingBtn = errEl.querySelector('.ji-err-settings');
  if (!existingBtn) {
    const btn = document.createElement('button');
    btn.className = 'ji-err-settings';
    btn.textContent = '⚙ Update Resume';
    btn.style.cssText = 'margin-top:12px;padding:8px 16px;border-radius:8px;background:#f3f4f6;border:1px solid #e5e7eb;color:#374151;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;';
    btn.addEventListener('click', openSettingsTab);
    errEl.appendChild(btn);
  }
  showOnly('ji-error');
}

function showRateLimit(reason, userResetIn) {
  const isUser = reason === 'user';
  let resetStr = 'in 24 hours';
  if (userResetIn && userResetIn > 0) {
    const h = Math.floor(userResetIn / 3600);
    const m = Math.floor((userResetIn % 3600) / 60);
    resetStr = h > 0 ? `in ${h}h ${m}m` : `in ${m}m`;
  }
  document.getElementById('ji-rl-icon').textContent = isUser ? '⏰' : '⚠️';
  document.getElementById('ji-rl-title').textContent = isUser
    ? "Daily limit reached"
    : "Server busy";
  document.getElementById('ji-rl-msg').innerHTML = isUser
    ? `${USER_DAILY_LIMIT} free scores used today. Resets ${resetStr}.`
    : "Try again tomorrow. Thanks for your patience!";
  document.getElementById('ji-rl-badge').style.display = 'none';
  showOnly('ji-ratelimit');
}

function showResult(data) {
  const score = data.score ?? 0;
  const col = scoreColor(score);
  const label = scoreLabel(score);
  const summary = esc((data.match_summary || '').slice(0, 200));
  const roleSummary = esc((data.summary || '').slice(0, 300));

  const bt = data.basic_threshold ?? 0;
  const sm = data.skills_match ?? 0;
  const ce = data.competitive_edge ?? 0;

  // H1B & Industry tags
  const sp = (data.sponsor || '').toLowerCase();
  let h1bTag;
  if (sp === 'yes') h1bTag = `<span style="font-size:10px;font-weight:600;padding:3px 8px;border-radius:7px;background:#f0fdf4;color:#15803d;border:1px solid #bbf7d0;">✅ H1B Sponsored</span>`;
  else if (sp === 'no') h1bTag = `<span style="font-size:10px;font-weight:600;padding:3px 8px;border-radius:7px;background:#fef2f2;color:#dc2626;border:1px solid #fecaca;">❌ No H1B</span>`;
  else h1bTag = `<span style="font-size:10px;font-weight:600;padding:3px 8px;border-radius:7px;background:#fefce8;color:#92400e;border:1px solid #fde68a;">❓ H1B Unknown</span>`;
  const indTag = `<span style="font-size:10px;font-weight:600;padding:3px 8px;border-radius:7px;background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;">🏢 ${esc(data.industry || 'Unknown')}</span>`;

  // Dimensions — map from skill_breakdown (B/R/C aligned)
  const sb = data.skill_breakdown || {};
  const bItems = (sb.basic_threshold || sb.hard_skills || []).map(s => ({ label: s.skill, score: s.score }));
  const rItems = (sb.skills_match || sb.soft_skills || []).map(s => ({ label: s.skill, score: s.score }));
  const cItems = (sb.competitive_edge || sb.preferred_skills || []).map(s => ({ label: s.skill, score: s.score }));

  // Get accordion state (always start closed)
  const bOpen = false;
  const rOpen = true;
  const cOpen = false;

  // Tips
  const tips = data.tips || {};
  const tipsList = [];
  if (tips.emphasize) tipsList.push({ icon: '🎯', head: 'Highlight', desc: tips.emphasize });
  if (tips.keywords) tipsList.push({ icon: '🔑', head: 'Add keywords', desc: tips.keywords });
  if (tips.bridge) tipsList.push({ icon: '🌉', head: 'Bridge the gap', desc: tips.bridge });
  const tipsHTML = tipsList.map(t => `
    <div style="padding:8px 10px;border-radius:8px;background:#f9fafb;border:1px solid #e5e7eb;">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;">
        <span style="font-size:12px;">${t.icon}</span>
        <span style="font-size:12px;font-weight:700;color:#334155;">${esc(t.head)}</span>
      </div>
      <div style="font-size:12px;color:#475569;line-height:1.55;padding-left:22px;">${esc(t.desc)}</div>
    </div>`).join('');

  // Score section gradient bg
  const scoreBg = score >= 75 ? 'linear-gradient(180deg, #f0fdf4 0%, white 100%)'
    : score >= 55 ? 'linear-gradient(180deg, #fffbeb 0%, white 100%)'
    : 'linear-gradient(180deg, #fef2f2 0%, white 100%)';
  // Ring track color tinted
  const ringTrack = score >= 75 ? 'rgba(22,163,74,0.1)' : score >= 55 ? 'rgba(217,119,6,0.1)' : 'rgba(220,38,38,0.1)';

  const resultEl = document.getElementById('ji-result');
  resultEl.innerHTML = `
    <div>
      <!-- Big score with gradient bg -->
      <div style="background:${scoreBg};padding-bottom:14px;">
        <div style="padding:8px 16px 10px;display:flex;flex-direction:column;align-items:center;gap:6px;">
          ${ringHTML(score, 76, 6, ringTrack)}
          <div style="font-size:17px;font-weight:800;color:${col};">${label}</div>
        </div>

        <!-- Summary -->
        ${summary ? `
        <div style="padding:0 20px;text-align:center;">
          <div style="font-size:12px;color:#374151;line-height:1.55;">${summary}</div>
        </div>` : ''}
      </div>

      <div style="height:1px;background:#f0f0f0;margin:0 14px;"></div>

      <!-- About this role -->
      <div style="padding:10px 14px;">
        <div style="font-size:10px;font-weight:600;color:#c0c5cc;text-transform:uppercase;letter-spacing:0.07em;margin-bottom:6px;">Role Summary</div>
        ${roleSummary ? `<div style="font-size:12px;color:#4b5563;line-height:1.55;margin-bottom:8px;padding:8px 10px;background:#f9fafb;border-radius:7px;">${roleSummary}</div>` : ''}
        <div style="display:flex;gap:5px;flex-wrap:wrap;">${indTag}${h1bTag}</div>
      </div>

      <div style="height:1px;background:#f0f0f0;margin:0 14px;"></div>

      <!-- Match details -->
      <div style="padding:10px 14px 4px;">
        <div style="font-size:10px;font-weight:600;color:#c0c5cc;text-transform:uppercase;letter-spacing:0.07em;">Match Breakdown</div>
      </div>
      <div style="padding:4px 0 6px;">
        ${bItems.length ? dimSectionHTML('Must-have Fit', bt, bItems, 'b', bOpen) : ''}
        ${rItems.length ? dimSectionHTML('Skills & Experience Fit', sm, rItems, 'r', rOpen) : ''}
        ${cItems.length ? dimSectionHTML('Nice-to-have Fit', ce, cItems, 'c', cOpen) : ''}
      </div>

      <div style="height:1px;background:#f0f0f0;margin:0 14px;"></div>

      <!-- How to improve -->
      ${tipsHTML ? `
      <div style="padding:10px 14px 0;">
        <div style="font-size:10px;font-weight:600;color:#c0c5cc;text-transform:uppercase;letter-spacing:0.07em;margin-bottom:7px;">How to improve</div>
        <div style="display:flex;flex-direction:column;gap:6px;">${tipsHTML}</div>
      </div>` : ''}

      <!-- Tailor button -->
      <div style="padding:8px 14px 14px;">
        <button id="ji-rewrite-btn" style="width:100%;padding:10px;border-radius:8px;
          background:linear-gradient(135deg,#1a1dcc,#2D31FA);color:white;border:none;
          font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;
          display:flex;align-items:center;justify-content:center;gap:6px;">
          ✏️ Tailor Resume
        </button>
      </div>
    </div>
  `;

  showOnly('ji-result');

  // ── Event listeners handled by delegation (see bottom of file) ──
  // Store current score for delegation handler
  _lastResultData = data;

  // Dimension accordion toggles (re-bind each render since DOM is replaced)
  document.querySelectorAll('.ji-dim-header').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-dim');
      const body = document.querySelector(`[data-dim-body="${id}"]`);
      const arrow = btn.querySelector('.ji-dim-arrow');
      if (!body) return;
      const isOpen = body.style.display !== 'none';
      body.style.display = isOpen ? 'none' : 'block';
      if (arrow) arrow.style.transform = isOpen ? '' : 'rotate(180deg)';
    });
  });
}

// ── Settings button (setup screen) — reuse existing tab ──
document.getElementById('ji-setup-btn')?.addEventListener('click', openSettingsTab);

// ── Listen for messages from background ──
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'JI_LOADING') showLoading();
  else if (msg.type === 'JI_RESULT') showResult(msg.data);
  else if (msg.type === 'JI_ERROR') showError(msg.message);
  else if (msg.type === 'JI_RATE_LIMIT') showRateLimit(msg.reason, msg.userResetIn);
  else if (msg.type === 'JI_SETUP') showSetup();
  else if (msg.type === 'JI_IDLE') showIdle();
});

// ── On open: ask background for current state ──
chrome.runtime.sendMessage({ type: 'JI_GET_STATE' }, (resp) => {
  if (!resp) return;
  if (resp.state === 'loading') showLoading();
  else if (resp.state === 'result') showResult(resp.data);
  else if (resp.state === 'error') showError(resp.message);
  else if (resp.state === 'ratelimit') showRateLimit(resp.reason, resp.userResetIn);
  else if (resp.state === 'setup') showSetup();
  else showIdle();
});

// ── Global settings + close (always visible) ──
document.getElementById('ji-global-settings')?.addEventListener('click', openSettingsTab);
document.getElementById('ji-global-close')?.addEventListener('click', () => window.close());

// ── Event delegation: Tailor Resume button (survives innerHTML replacement) ──
document.getElementById('ji-body').addEventListener('click', (e) => {
  const btn = e.target.closest('#ji-rewrite-btn');
  if (!btn) return;
  const currentScore = _lastResultData?.score ?? null;
  if (currentScore != null) {
    chrome.storage.local.set({ lastScoreBefore: currentScore });
  }
  chrome.runtime.sendMessage({ type: 'OPEN_REWRITE' });
});
