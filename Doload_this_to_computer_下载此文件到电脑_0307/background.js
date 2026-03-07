// background.js — JobInstant v5.38 — Chrome sidePanel API
// Fix: sidePanel.open requires user gesture; auto-analyze without forcing panel open

const WORKER_URL = 'https://jobfit-ai.jdfitanalyzer.workers.dev';

console.log('[JobInstant] v5.38 started');

// ── Current state (for when sidepanel opens mid-analysis) ──
let panelState = { state: 'idle' };
function setState(s) { panelState = s; }

// ── Open sidePanel on extension icon click ──
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(async (details) => {
  // Open onboarding page only on fresh install (not on update/reload)
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
  }

  try {
    const tabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
    for (const tab of tabs) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
        await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] });
      } catch(e) {}
    }
  } catch(e) {}
  chrome.alarms.create('keepAlive', { periodInMinutes: 1 });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('keepAlive', { periodInMinutes: 1 });
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') chrome.storage.local.get('_ka', () => {});
});

// ── Ensure content.js is always injected into LinkedIn tabs ──
// Manifest content_scripts sometimes fails on fresh install or after update.
// This proactively injects when any LinkedIn tab finishes loading.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && tab.url.includes('linkedin.com/jobs')) {
    chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    }).catch(() => {});
    chrome.scripting.insertCSS({
      target: { tabId },
      files: ['content.css']
    }).catch(() => {});
  }
});

// ── Broadcast to sidepanel ──
function broadcastToPanel(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// ── Worker request ──
async function workerPost(path, body) {
  const resp = await fetch(WORKER_URL + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (resp.status === 429 || data.rateLimited) return data;
  if (!resp.ok || data.error) throw new Error(data.error || `Server error ${resp.status}`);
  return data;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === 'JI_GET_STATE') {
    sendResponse(panelState);
    return true;
  }

  if (msg.type === 'CHECK_SETTINGS') {
    chrome.storage.local.get(['resume'], (data) => {
      sendResponse(data?.resume ? { ok: true } : { error: 'NOT_CONFIGURED' });
    });
    return true;
  }

  if (msg.type === 'OPEN_REWRITE') {
    const url = chrome.runtime.getURL('resume-rewrite.html');
    chrome.tabs.query({}, (tabs) => {
      const existing = tabs.find(t => t.url?.includes('resume-rewrite.html'));
      if (existing) {
        // Always navigate back to the extension URL (tab may have drifted to another page)
        chrome.tabs.update(existing.id, { url, active: true });
      } else {
        chrome.tabs.create({ url });
      }
      sendResponse({ ok: true });
    });
    return true;
  }

  // content.js: job detected → analyze (do NOT force sidePanel open — needs user gesture)
  if (msg.type === 'JI_ANALYZE') {
    const tabId = sender.tab?.id;
    if (!tabId) { sendResponse({ error: 'no tabId' }); return true; }

    // Try opening sidePanel — this will only succeed if triggered by user gesture.
    // If it fails silently, that's fine: the result badge in content.js will let user open it.
    chrome.sidePanel.open({ tabId }).catch(() => {
      console.log('[JobInstant] sidePanel.open skipped (no user gesture) — badge will show instead');
    });

    chrome.storage.local.get(['resume'], async (data) => {
      if (!data.resume) {
        setState({ state: 'setup' });
        broadcastToPanel({ type: 'JI_SETUP' });
        sendResponse({ ok: true });
        return;
      }
      setState({ state: 'loading' });
      broadcastToPanel({ type: 'JI_LOADING' });
      try {
        const resp = await workerPost('/analyze', { resume: data.resume, jdText: msg.jdText });
        if (resp.rateLimited) {
          const s = { state: 'ratelimit', reason: resp.reason, userResetIn: resp.userResetIn };
          setState(s);
          broadcastToPanel({ type: 'JI_RATE_LIMIT', reason: resp.reason, userResetIn: resp.userResetIn });
          sendResponse(s);
          return;
        }
        setState({ state: 'result', data: resp.result });
        broadcastToPanel({ type: 'JI_RESULT', data: resp.result });
        sendResponse({ ok: true, result: resp.result });
      } catch(e) {
        setState({ state: 'error', message: e.message });
        broadcastToPanel({ type: 'JI_ERROR', message: e.message });
        sendResponse({ error: e.message });
      }
    });
    return true;
  }

  // content.js: user clicked badge → open sidePanel (has user gesture!)
  if (msg.type === 'JI_OPEN_PANEL') {
    const tabId = sender.tab?.id;
    if (tabId) {
      chrome.sidePanel.open({ tabId }).catch((e) => {
        console.log('[JobInstant] sidePanel.open failed:', e.message);
      });
    }
    sendResponse({ ok: true });
    return true;
  }

  // Onboarding saved resume → notify all LinkedIn tabs to re-init
  if (msg.type === 'RESUME_SAVED') {
    console.log('[JobInstant] Resume saved via onboarding — notifying LinkedIn tabs');
    chrome.tabs.query({ url: 'https://www.linkedin.com/*' }, (tabs) => {
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, { type: 'RESUME_SAVED' }).catch(() => {});
      }
    });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'JI_SHOW_RESULT') {
    // content.js has cached result, just show it in panel
    setState({ state: 'result', data: msg.data });
    broadcastToPanel({ type: 'JI_RESULT', data: msg.data });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'JI_ANALYZE_ERROR') {
    setState({ state: 'error', message: msg.message });
    broadcastToPanel({ type: 'JI_ERROR', message: msg.message });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'JI_IDLE') {
    setState({ state: 'idle' });
    broadcastToPanel({ type: 'JI_IDLE' });
    sendResponse({ ok: true });
    return true;
  }

  // Batch scoring (still direct)
  if (msg.type === 'ANALYZE_JD') {
    chrome.storage.local.get(['resume'], async (data) => {
      if (!data.resume) { sendResponse({ error: 'No resume saved.' }); return; }
      try {
        const resp = await workerPost('/analyze', { resume: data.resume, jdText: msg.jdText });
        if (resp.rateLimited) {
          sendResponse({ rateLimited: true, reason: resp.reason, message: resp.message, userResetIn: resp.userResetIn });
          return;
        }
        sendResponse({ ok: true, result: resp.result });
      } catch(e) {
        sendResponse({ error: e.message });
      }
    });
    return true;
  }

  if (msg.type === 'REWRITE_JD') {
    chrome.storage.local.get(['resume', 'lastScore'], async (data) => {
      if (!data.resume) { sendResponse({ error: 'No resume saved.' }); return; }
      try {
        // Step 1: rewrite resume
        const rewriteResp = await workerPost('/rewrite', { resume: data.resume, jdText: msg.jdText });
        if (rewriteResp.rateLimited) {
          sendResponse({ error: 'Rate limited — please wait a minute and try again.' });
          return;
        }
        const result = rewriteResp.result;
        if (!result || !result.resume) {
          sendResponse({ error: 'Rewrite returned empty result. Please try again.' });
          return;
        }

        // Step 2: score the rewritten resume against the JD
        let afterScore = null;
        try {
          const analyzeResp = await workerPost('/analyze', {
            resume: result.resume,
            jdText: msg.jdText
          });
          if (!analyzeResp.rateLimited) {
            afterScore = analyzeResp?.result?.score ?? null;
          }
        } catch (scoreErr) {
          console.warn('[JobInstant] Post-rewrite score failed:', scoreErr.message);
        }

        // Step 3: save scores to storage
        const beforeScore = data.lastScore ?? null;
        if (afterScore != null) {
          chrome.storage.local.set({ lastScore: afterScore, lastScoreBefore: beforeScore });
        }

        sendResponse({ ok: true, result: { ...result, afterScore, beforeScore } });
      } catch(e) {
        sendResponse({ error: e.message });
      }
    });
    return true;
  }

});
