// ============================================================
// JobFit AI — Cloudflare Worker v4 — Speed Optimized
// 个人限额：滚动24h（对用户公平）
// 全局限额：UTC自然日（方便成本管理）
// ============================================================
const USER_DAILY_LIMIT   = 200;
const GLOBAL_DAILY_LIMIT = 2000;
export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-User-ID',
    };
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === '/quota' && request.method === 'GET') {
        return await handleQuota(request, env, cors);
      }
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405, headers: cors });
      }
      if (path === '/analyze') return await handleAnalyze(request, env, cors);
      if (path === '/rewrite') return await handleRewrite(request, env, cors);
      return new Response('Not found', { status: 404, headers: cors });
    } catch (e) {
      return json({ error: e.message }, 500, cors);
    }
  }
};
// ═══════════════════════════════════════════
// 限流核心逻辑
// ═══════════════════════════════════════════
function globalTodayKey() {
  return 'global:' + new Date().toISOString().slice(0, 10);
}
function getUserId(request) {
  const header = request.headers.get('X-User-ID');
  if (header && header.length > 4) return header;
  const ip = request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
    || 'unknown';
  return ip;
}
async function checkAndIncrement(request, env) {
  if (!env.RATE_LIMIT) {
    return { allowed: true, userCount: 0, globalCount: 0, userLimit: USER_DAILY_LIMIT, globalLimit: GLOBAL_DAILY_LIMIT, userResetIn: 86400 };
  }
  const userId    = getUserId(request);
  const userKey   = `user:${userId}`;
  const globalKey = globalTodayKey();
  const now       = Date.now();
  const [userRaw, globalRaw] = await Promise.all([
    env.RATE_LIMIT.get(userKey),
    env.RATE_LIMIT.get(globalKey),
  ]);
  let userData = userRaw ? JSON.parse(userRaw) : { count: 0, windowStart: now };
  const windowAge = now - userData.windowStart;
  if (windowAge >= 86400000) {
    userData = { count: 0, windowStart: now };
  }
  const userCount = userData.count;
  const userResetIn = Math.ceil((86400000 - (now - userData.windowStart)) / 1000);
  const globalCount = parseInt(globalRaw || '0', 10);
  if (userCount >= USER_DAILY_LIMIT) {
    return { allowed: false, reason: 'user', userCount, globalCount, userLimit: USER_DAILY_LIMIT, globalLimit: GLOBAL_DAILY_LIMIT, userResetIn };
  }
  if (globalCount >= GLOBAL_DAILY_LIMIT) {
    return { allowed: false, reason: 'global', userCount, globalCount, userLimit: USER_DAILY_LIMIT, globalLimit: GLOBAL_DAILY_LIMIT, userResetIn };
  }
  userData.count += 1;
  // Write increments in background — don't wait for KV write to complete
  const writePromise = Promise.all([
    env.RATE_LIMIT.put(userKey, JSON.stringify(userData), { expirationTtl: 90000 }),
    env.RATE_LIMIT.put(globalKey, String(globalCount + 1), { expirationTtl: 90000 }),
  ]);
  // Use waitUntil if available (Cloudflare Workers) to avoid blocking
  if (globalThis._ctx?.waitUntil) globalThis._ctx.waitUntil(writePromise);
  else await writePromise;
  return { allowed: true, userCount: userData.count, globalCount: globalCount + 1, userLimit: USER_DAILY_LIMIT, globalLimit: GLOBAL_DAILY_LIMIT, userResetIn };
}
// ═══════════════════════════════════════════
// /quota
// ═══════════════════════════════════════════
async function handleQuota(request, env, cors) {
  if (!env.RATE_LIMIT) {
    return json({ userRemaining: USER_DAILY_LIMIT, globalRemaining: GLOBAL_DAILY_LIMIT, userResetIn: 86400 }, 200, cors);
  }
  const userId  = getUserId(request);
  const now     = Date.now();
  const [userRaw, globalRaw] = await Promise.all([
    env.RATE_LIMIT.get(`user:${userId}`),
    env.RATE_LIMIT.get(globalTodayKey()),
  ]);
  let userData = userRaw ? JSON.parse(userRaw) : { count: 0, windowStart: now };
  if (now - userData.windowStart >= 86400000) userData = { count: 0, windowStart: now };
  const userCount   = userData.count;
  const globalCount = parseInt(globalRaw || '0', 10);
  const userResetIn = Math.ceil((86400000 - (now - userData.windowStart)) / 1000);
  return json({
    userRemaining:   Math.max(0, USER_DAILY_LIMIT   - userCount),
    globalRemaining: Math.max(0, GLOBAL_DAILY_LIMIT - globalCount),
    userLimit:   USER_DAILY_LIMIT,
    globalLimit: GLOBAL_DAILY_LIMIT,
    userResetIn,
  }, 200, cors);
}
// ═══════════════════════════════════════════
// /analyze — parallelized for speed
// ═══════════════════════════════════════════
async function handleAnalyze(request, env, cors) {
  // Parse body and check rate limit IN PARALLEL — saves ~20ms
  const clonedReq = request.clone();
  const [quota, body] = await Promise.all([
    checkAndIncrement(request, env),
    clonedReq.json(),
  ]);
  if (!quota.allowed) return rateLimitResponse(quota, cors);
  const { resume, jdText } = body;
  if (!resume || !jdText) return json({ error: 'Missing resume or jdText' }, 400, cors);
  const prompt = buildAnalyzePrompt(resume, jdText);
  const result = await callWithFallback(prompt, 900, env);
  result.parsed = normalizeMatches(result.parsed);
  return json({
    ok: true,
    result: result.parsed,
    _provider: result.provider,
    _quota: {
      userRemaining:   Math.max(0, USER_DAILY_LIMIT   - quota.userCount),
      globalRemaining: Math.max(0, GLOBAL_DAILY_LIMIT - quota.globalCount),
    }
  }, 200, cors);
}
// ═══════════════════════════════════════════
// /rewrite（不计入限额）
// ═══════════════════════════════════════════
async function handleRewrite(request, env, cors) {
  const { resume, jdText } = await request.json();
  if (!resume || !jdText) return json({ error: 'Missing resume or jdText' }, 400, cors);
  const prompt = buildRewritePrompt(resume, jdText);
  const result = await callWithFallback(prompt, 2000, env);
  return json({ ok: true, result: result.parsed, _provider: result.provider }, 200, cors);
}
// ═══════════════════════════════════════════
// 限流错误响应
// ═══════════════════════════════════════════
function rateLimitResponse(quota, cors) {
  const isUserLimit = quota.reason === 'user';
  const h = Math.floor(quota.userResetIn / 3600);
  const m = Math.floor((quota.userResetIn % 3600) / 60);
  const resetStr = h > 0 ? `${h}h ${m}m` : `${m}m`;
  return json({
    ok: false,
    rateLimited: true,
    reason: quota.reason,
    message: isUserLimit
      ? `You've hit today's free limit. Come back in ${resetStr} for more best matches!`
      : `JobInstant has reached its daily limit. Come back tomorrow for more best matches!`,
    userResetIn: quota.userResetIn,
    userRemaining:   0,
    globalRemaining: Math.max(0, GLOBAL_DAILY_LIMIT - quota.globalCount),
  }, 429, cors);
}
// ═══════════════════════════════════════════
// API calls — race Claude vs Gemini for speed
// ═══════════════════════════════════════════
async function callWithFallback(prompt, maxTokens, env) {
  const claudeKey = env.ANTHROPIC_API_KEY;
  const geminiKey = env.GEMINI_API_KEY;

  // If both keys available, race them: start Gemini after 2.5s delay
  // Whichever finishes first wins — eliminates sequential fallback latency
  if (claudeKey && geminiKey) {
    const claudePromise = callClaude(prompt, maxTokens, claudeKey)
      .then(text => ({ parsed: parseJSON(text), provider: 'claude' }));

    // Delayed Gemini — gives Claude a 2.5s head start, but if Claude is slow or rate-limited, Gemini catches up
    const geminiPromise = new Promise(resolve =>
      setTimeout(() => resolve(
        callGemini(prompt, maxTokens, geminiKey)
          .then(text => ({ parsed: parseJSON(text), provider: 'gemini' }))
      ), 2500)
    ).then(p => p);

    try {
      return await Promise.any([claudePromise, geminiPromise]);
    } catch (e) {
      // Both failed — throw the first meaningful error
      const errors = e.errors || [e];
      const real = errors.find(err => !err.isRateLimit) || errors[0];
      throw real;
    }
  }

  // Single key fallback
  if (claudeKey) {
    try {
      const text = await callClaude(prompt, maxTokens, claudeKey);
      return { parsed: parseJSON(text), provider: 'claude' };
    } catch (e) {
      if (!e.isRateLimit) throw e;
      if (!geminiKey) throw e;
    }
  }
  if (!geminiKey) throw new Error('No API keys configured.');
  const text = await callGemini(prompt, maxTokens, geminiKey);
  return { parsed: parseJSON(text), provider: 'gemini' };
}
async function callClaude(prompt, maxTokens, apiKey) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
  });
  const d = await resp.json();
  if (resp.status === 429 || d?.error?.type?.includes('rate_limit') || d?.error?.type?.includes('overload')) {
    const err = new Error('Rate limited'); err.isRateLimit = true; throw err;
  }
  if (d.error) throw new Error('Claude: ' + d.error.message);
  return d.content[0].text;
}
async function callGemini(prompt, maxTokens, apiKey) {
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: maxTokens, temperature: 0.1 } }) }
  );
  const d = await resp.json();
  if (d.error) throw new Error('Gemini: ' + d.error.message);
  return d?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}
// ═══════════════════════════════════════════
// Prompts — v4 compressed for faster token processing
// ═══════════════════════════════════════════
function buildAnalyzePrompt(resume, jdText) {
  return `You are a senior recruiter. Score this resume against the job description.

RESUME:
${resume.slice(0, 3500)}

JOB DESCRIPTION:
${jdText.slice(0, 2500)}
---
SCORING (use internally, do NOT output your calculations):
1. Basic Threshold B (30%): Extract critical "must-have" requirements. Score each: met=1, partial=0.5, unmet=0. B = (sum/count)×100. Track critical_missing_count.
2. Skills Match R (50%): Extract 5-7 responsibility themes. Score each: direct+quantified=100, direct=70, adjacent=40, none=0. Multiply by years-of-experience factor (meets=1.0, -1yr=0.9, -2yr=0.75, -3yr=0.55, -4+=0.35).
3. Competitive Edge C (20%): Start at 40. Add: quantified achievements +10, each "preferred" met +8, brand-name employer +10, rare skill +10, leadership +8. Cap at 100.
Final = B×0.3 + R×0.5 + C×0.2. Cap: 1 critical missing→max 65, 2→max 50, 3+→max 35.
75-100="Strong Match", 55-74="Good Match", 0-54="Weak Match".
Be honest. 75+ means you would genuinely advance this candidate. No inflation.

Respond with ONLY valid JSON (no markdown):
{"score":<0-100>,"verdict":"<Strong/Good/Weak Match>","basic_threshold":<0-100>,"skills_match":<0-100>,"competitive_edge":<0-100>,"critical_missing_count":<int>,"critical_gap":<bool>,"summary":"<what this role does, max 25 words>","match_summary":"<overall fit, max 20 words>","one_action":"<most impactful action before applying, max 15 words>","industry":"<sector>","sponsor":"<Yes|No|Not mentioned>","matches":[{"label":"<3-5 words>","detail":"<max 10 words>"},{"label":"<3-5 words>","detail":"<max 10 words>"},{"label":"<3-5 words>","detail":"<max 10 words>"}],"gaps":[{"label":"<3-5 words>","detail":"<max 10 words>"},{"label":"<3-5 words>","detail":"<max 10 words>"}],"tips":{"emphasize":"<highlight>","keywords":"<3-5 missing keywords>","bridge":"<frame biggest gap>"},"skill_breakdown":{"basic_threshold":[{"skill":"<req>","score":<0|50|100>}],"skills_match":[{"skill":"<theme>","score":<0-100>}],"competitive_edge":[{"skill":"<factor>","score":<0-100>}]}}`;
}
function buildRewritePrompt(resume, jdText) {
  return `You are a conservative resume keyword optimizer. Your task is EXTREMELY narrow: improve keyword relevance of EXISTING bullet points. Nothing else.

## ABSOLUTE RULES — VIOLATION OF ANY RULE MAKES THE OUTPUT INVALID

### NEVER CHANGE (copy these exactly from the original):
- Company names (every single one, character-for-character)
- Job titles (every single one, character-for-character)
- Dates and date ranges (every single one, character-for-character)
- Locations
- Section headers (SUMMARY, EXPERIENCE, EDUCATION, SKILLS, etc.)
- Education entries (school names, degrees, GPAs, graduation dates)
- Contact information (name, email, phone, LinkedIn, etc.)
- Number of jobs/positions listed
- Number of sections

### NEVER DO:
- NEVER add a job, project, or role that is not in the original resume
- NEVER add skills, tools, or technologies the candidate did not mention
- NEVER invent achievements, metrics, or numbers not in the original
- NEVER add new bullet points — only edit existing ones
- NEVER remove any bullet points or sections
- NEVER merge or split bullet points
- NEVER change the overall structure or section order

### WHAT YOU MAY DO (and ONLY this):
1. Rephrase existing bullet points to naturally include JD keywords — but ONLY when the candidate's existing experience genuinely relates to that keyword
2. Reorder bullet points within each job section so the most JD-relevant bullets appear first
3. Wrap ONLY the newly added or changed words in **double asterisks**

### FORMAT RULES (CRITICAL — the resume field MUST follow this exact structure):
The "resume" field in your JSON output MUST preserve the original resume's line-by-line structure using \\n characters:
- Each section header (SUMMARY, EXPERIENCE, EDUCATION, SKILLS, etc.) MUST be on its own line, preceded by \\n\\n
- Each job title MUST be on its own line
- Each date range MUST be on its own line
- Each company name MUST be on its own line
- Each bullet point MUST start with • on its own line
- Contact info (name, email, phone, links) each on their own line
- DO NOT merge multiple items onto one line
- The output structure must be IDENTICAL to the input structure — same line breaks, same order

Example structure:
"Name\\nemail | phone | location\\n\\nSUMMARY\\nSummary text here...\\n\\nEXPERIENCE\\nJob Title\\nDate Range\\nCompany Name\\n• Bullet one\\n• Bullet two\\n\\nEDUCATION\\nDegree\\nSchool Name\\nGraduation Date"

Output ONLY valid JSON, no markdown, no code blocks:
{"changes":["short description of each change made"],"resume":"the COMPLETE resume text preserving exact line structure with \\n"}

JOB DESCRIPTION:
${jdText.slice(0, 2500)}

ORIGINAL RESUME (preserve structure and line breaks exactly, only optimize bullet wording):
${resume.slice(0, 4000)}`;
}
// ═══════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════
function parseJSON(text) {
  const clean = text.trim().replace(/^```json\s*/, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(clean);
  } catch(e) {
    const match = clean.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch(e2) {}
    }
    throw new Error('Failed to parse AI response: ' + clean.slice(0, 120));
  }
}
function normalizeMatches(parsed) {
  const norm = arr => (arr || []).map(x =>
    typeof x === 'string' ? { label: x, detail: '' } : (x?.label ? x : { label: String(x), detail: '' })
  );
  parsed.matches = norm(parsed.matches);
  parsed.gaps    = norm(parsed.gaps);
  return parsed;
}
function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}
