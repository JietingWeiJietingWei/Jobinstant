// onboarding.js — JobInstant v5.36 — First-install resume upload

// ── UI Elements ──
const uploadZone    = document.getElementById('upload-zone');
const fileInput     = document.getElementById('file-input');
const stateUpload   = document.getElementById('state-upload');
const stateParsing  = document.getElementById('state-parsing');
const successBadge  = document.getElementById('success-badge');
const errorDetail   = document.getElementById('error-detail');
const btnLinkedin   = document.getElementById('btn-linkedin');
const btnReplace    = document.getElementById('btn-replace');
const headerHl      = document.getElementById('header-headline');
const headerSub     = document.getElementById('header-sub');
const step1         = document.getElementById('step1');
const step2         = document.getElementById('step2');

// ── On load: check if resume already saved ──
document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.local.get(['resume', 'resumeFileName'], (data) => {
    if (data.resume) {
      showSuccess(data.resumeFileName || 'Resume', data.resume.length);
    }
  });

  // Click to open file picker
  uploadZone.addEventListener('click', () => fileInput.click());

  // File selected via picker
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  });

  // Drag & drop
  uploadZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadZone.classList.add('drag');
  });
  uploadZone.addEventListener('dragleave', () => {
    uploadZone.classList.remove('drag');
  });
  uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadZone.classList.remove('drag');
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  });

  // Go to LinkedIn
  btnLinkedin.addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://www.linkedin.com/jobs/search/' });
    window.close();
  });

  // Replace resume — re-open file picker, reset fileInput so same file can be re-selected
  btnReplace.addEventListener('click', () => {
    fileInput.value = '';
    fileInput.click();
  });
});

// ── Error messages per file type ──
const FILE_ERROR_MESSAGES = {
  jpg:   { why: "JPEG is an image — JobInstant can't read text from images.",      hint: "Export your resume as PDF or DOCX from Word or Google Docs." },
  jpeg:  { why: "JPEG is an image — JobInstant can't read text from images.",      hint: "Export your resume as PDF or DOCX from Word or Google Docs." },
  png:   { why: "PNG is an image — JobInstant can't read text from images.",       hint: "Export your resume as PDF or DOCX from Word or Google Docs." },
  gif:   { why: "GIF is an image — JobInstant can't read text from images.",       hint: "Export your resume as PDF or DOCX from Word or Google Docs." },
  webp:  { why: "WebP is an image — JobInstant can't read text from images.",      hint: "Export your resume as PDF or DOCX from Word or Google Docs." },
  pages: { why: "Apple Pages files aren't supported directly.",                    hint: "In Pages, go to File → Export To → PDF or Word." },
  rtf:   { why: "RTF format is not reliably supported.",                            hint: "Please save your resume as PDF, DOCX, or TXT and re-upload." },
  zip:   { why: "ZIP archives can't be read as a resume.",                         hint: "Upload a single resume file: PDF, DOCX, or TXT." },
  xlsx:  { why: "Excel spreadsheets aren't supported.",                            hint: "Copy your resume into Word or Google Docs and export as PDF or DOCX." },
  pptx:  { why: "PowerPoint files aren't supported.",                              hint: "Export your resume as PDF or DOCX instead." },
};

// ── Main file handler ──
async function handleFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  const sizeMB = (file.size / 1024 / 1024).toFixed(1);

  if (!['pdf', 'doc', 'docx', 'txt'].includes(ext)) {
    const msg = FILE_ERROR_MESSAGES[ext] || { why: 'This file type is not supported.', hint: 'Please use PDF, DOCX, or TXT.' };
    showUploadError(file.name, ext, sizeMB, msg.why, msg.hint);
    return;
  }

  showParsing(file.name);

  try {
    setStep('read', 'active');
    let text = '';

    if (ext === 'txt') {
      text = await readAsText(file);
    } else if (ext === 'pdf') {
      setStep('read', 'done');
      setStep('extract', 'active');
      text = await extractPdfText(file);
    } else if (ext === 'docx') {
      setStep('read', 'done');
      setStep('extract', 'active');
      text = await extractDocxText(file);
    } else if (ext === 'doc') {
      setStep('read', 'done');
      setStep('extract', 'active');
      text = await extractDocText(file);
    }

    text = text.trim();
    if (text.length < 50) {
      throw new Error('Could not extract enough text. Try saving your resume as DOCX or TXT.');
    }

    setStep('read', 'done');
    setStep('extract', 'done');
    setStep('save', 'active');
    await saveResume(text, file.name);
    setStep('save', 'done');

    await delay(300);
    showSuccess(file.name, text.length);

  } catch (err) {
    // Parse/read failure — show error with file info
    const sizeMB2 = (file.size / 1024 / 1024).toFixed(1);
    showUploadError(
      file.name, ext, sizeMB2,
      err.message,
      'Try saving your resume as DOCX or TXT and re-uploading.',
      true // isParsError — file type IS supported, just failed to read
    );
  }
}

// ── Save to chrome.storage ──
function saveResume(text, fileName) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ resume: text, resumeFileName: fileName }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        // Notify background to tell all LinkedIn tabs that resume is ready
        chrome.runtime.sendMessage({ type: 'RESUME_SAVED' }).catch(() => {});
        resolve();
      }
    });
  });
}

// ── State transitions ──

function showParsing(fileName) {
  // Reset parsing steps
  ['read', 'extract', 'save'].forEach(s => setStep(s, ''));

  stateUpload.style.display  = 'none';
  stateParsing.style.display = 'flex';
  successBadge.style.display = 'none';
  errorDetail.style.display  = 'none';

  document.getElementById('parsing-filename').textContent = 'Parsing ' + fileName;

  btnLinkedin.disabled        = true;
  btnReplace.style.display    = 'none';

  // Header stays on step 1
  headerHl.textContent  = 'Reading your resume…';
  headerSub.textContent = 'Extracting your skills, experience and keywords.';
  step1.className = 'step-dot active';
  step2.className = 'step-dot';
}

function showSuccess(fileName, charCount) {
  stateUpload.style.display   = 'none';
  stateParsing.style.display  = 'none';
  successBadge.style.display  = 'flex';
  errorDetail.style.display  = 'none';

  document.getElementById('success-filename').textContent = fileName;
  document.getElementById('success-meta').textContent = 'Saved locally ✓';

  btnLinkedin.disabled     = false;
  btnReplace.style.display = 'flex';

  // Header moves to step 2
  headerHl.textContent  = "Upload complete!";
  headerSub.innerHTML   = '🎉 Your resume is saved. Go to LinkedIn Jobs to see<br>match scores at a glance.';
  step1.className = 'step-dot done';
  step2.className = 'step-dot active';
}

function showUploadError(fileName, ext, sizeMB, why, hint, isParseError) {
  // Reset upload zone to error state
  stateUpload.style.display  = 'block';
  stateParsing.style.display = 'none';
  successBadge.style.display = 'none';

  // Upload zone visual
  const zone = document.getElementById('upload-zone');
  zone.className = 'upload-error';

  // Zone icon + text
  const zoneIcon  = zone.querySelector('.zone-icon');
  const zoneTitle = zone.querySelector('.zone-title');
  const zoneSub   = zone.querySelector('.zone-sub');
  if (zoneIcon)  { zoneIcon.textContent = '✗'; zoneIcon.style.background = '#fef2f2'; zoneIcon.style.color = '#dc2626'; }
  if (zoneTitle) { zoneTitle.textContent = 'Upload failed'; zoneTitle.style.color = '#dc2626'; }
  if (zoneSub)   { zoneSub.textContent   = isParseError ? 'Could not read this file' : 'This file type is not supported'; }

  // Fill error detail box
  document.getElementById('err-file-name').textContent = fileName;
  document.getElementById('err-file-type').textContent = ext.toUpperCase() + ' · ' + sizeMB + ' MB';
  const headline = isParseError
    ? '<strong style="color:#0f1117">Could not read .' + ext + ' file.</strong><br>'
    : '<strong style="color:#0f1117">.' + ext + ' files are not supported.</strong><br>';
  document.getElementById('err-message').innerHTML =
    headline +
    why +
    '<span style="color:#9ca3af;display:block;margin-top:4px;">' + hint + '</span>';

  // Type chips
  const chips = document.getElementById('err-chips');
  if (isParseError) {
    chips.innerHTML = ['pdf','docx','txt'].map(t =>
      '<span style="font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px;border:1px solid #bbf7d0;background:#f0fdf4;color:#16a34a;">.' + t + '</span>'
    ).join('');
  } else {
    chips.innerHTML = ['pdf','docx','txt'].map(t =>
      '<span style="font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px;border:1px solid #bbf7d0;background:#f0fdf4;color:#16a34a;">.' + t + '</span>'
    ).join('') +
    '<span style="font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px;border:1px solid #fecaca;background:#fef2f2;color:#dc2626;text-decoration:line-through;opacity:0.7;">.' + ext + '</span>';
  }

  document.getElementById('error-detail').style.display = 'block';

  // Wire retry button
  document.getElementById('err-retry-btn').onclick = () => {
    resetUploadZone();
    fileInput.value = '';
    fileInput.click();
  };

  btnLinkedin.disabled     = true;
  btnReplace.style.display = 'none';

  headerHl.textContent  = 'Upload your resume to see your best matches.';
  headerSub.textContent = 'Upload your resume once to instantly see how well jobs match your background.';
  step1.className = 'step-dot active';
  step2.className = 'step-dot';
}

function resetUploadZone() {
  const zone = document.getElementById('upload-zone');
  zone.className = '';

  const zoneIcon  = zone.querySelector('.zone-icon');
  const zoneTitle = zone.querySelector('.zone-title');
  const zoneSub   = zone.querySelector('.zone-sub');
  if (zoneIcon)  { zoneIcon.textContent = '📄'; zoneIcon.style.background = ''; zoneIcon.style.color = ''; }
  if (zoneTitle) { zoneTitle.textContent = 'Upload resume'; zoneTitle.style.color = ''; }
  if (zoneSub)   { zoneSub.textContent   = 'Drag & drop here'; }

  document.getElementById('error-detail').style.display = 'none';
}

// ── Parsing step helper ──
function setStep(name, state) {
  // name: 'read' | 'extract' | 'save'
  // state: 'active' | 'done' | '' (pending)
  const icons = { read: '○', extract: '○', save: '○' };
  const el    = document.getElementById('pstep-' + name);
  const icon  = document.getElementById('pstep-' + name + '-icon');
  if (!el || !icon) return;
  el.className = 'parsing-step' + (state ? ' ' + state : '');
  if (state === 'done')   icon.textContent = '✓';
  else if (state === 'active') icon.textContent = '⏳';
  else                    icon.textContent = '○';
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── File extraction (identical to options.js) ──
function readAsText(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload  = e => res(e.target.result);
    r.onerror = () => rej(new Error('Could not read file'));
    r.readAsText(file, 'UTF-8');
  });
}
function readAsArrayBuffer(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload  = e => res(e.target.result);
    r.onerror = () => rej(new Error('Could not read file'));
    r.readAsArrayBuffer(file);
  });
}
function stripRtf(rtf) {
  let s = rtf;

  // 1. Remove known metadata groups
  s = s.replace(/\{\\(?:fonttbl|colortbl|stylesheet|info|header|footer|pict|mmathPr|latentstyles|revtbl)[^}]*\}/gi, '');
  // Remove \* destination groups
  s = s.replace(/\{\\\*[^}]*\}/g, '');

  // 2. Replace paragraph/line breaks with newlines
  s = s.replace(/\\par\b\s*/gi, '\n');
  s = s.replace(/\\line\b\s*/gi, '\n');
  s = s.replace(/\\page\b\s*/gi, '\n');
  s = s.replace(/\\tab\b\s*/gi, '  ');
  s = s.replace(/\\bullet\b\s*/gi, '• ');

  // 3. Remove all remaining RTF control words
  s = s.replace(/\\[a-zA-Z]+-?\d*[ ]?/g, '');

  // 4. Remove remaining backslash combos
  s = s.replace(/\\./g, '');

  // 5. Remove braces
  s = s.replace(/[{}]/g, '');

  // 6. Clean whitespace and stray semicolons from font/color tables
  s = s.replace(/^[;,\s]+$/mg, '');
  s = s.replace(/[ \t]+/g, ' ').replace(/\n /g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  const nonAscii = (s.match(/[^\x00-\x7E]/g) || []).length;
  if (s.length < 50 || nonAscii > s.length * 0.3) {
    throw new Error('Could not parse RTF file. Please save your resume as DOCX or TXT and re-upload.');
  }
  return s;
}

async function extractPdfText(file) {
  const ab = await readAsArrayBuffer(file);

  // ── Primary: pdf.js (handles CIDFont, ToUnicode, LinkedIn PDFs, etc.) ──
  if (typeof pdfjsLib !== 'undefined') {
    try {
      pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.js');
      const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(ab) }).promise;
      let text = '';
      for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const content = await page.getTextContent();
        text += content.items.map(it => it.str).join(' ') + '\n';
      }
      text = text.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
      if (text.length >= 80) return text;
    } catch (e) { /* pdf.js failed, fall through to regex */ }
  }

  // ── Fallback: regex-based parser ──
  const bytes = new Uint8Array(ab);
  const raw   = Array.from(bytes).map(b => String.fromCharCode(b)).join('');
  const streamRx = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let allText = '';
  let m;

  while ((m = streamRx.exec(raw)) !== null) {
    const streamStr   = m[1];
    const streamBytes = new Uint8Array(streamStr.length);
    for (let i = 0; i < streamStr.length; i++) streamBytes[i] = streamStr.charCodeAt(i) & 0xff;

    let decompressed = null;

    if (streamBytes[0] === 0x78) {
      try {
        const ds = new DecompressionStream('deflate');
        const w = ds.writable.getWriter(); w.write(streamBytes); w.close();
        const chunks = []; const r = ds.readable.getReader();
        while (true) { const { done, value } = await r.read(); if (done) break; chunks.push(value); }
        const total = chunks.reduce((s, c) => s + c.length, 0);
        const out = new Uint8Array(total); let off = 0;
        for (const c of chunks) { out.set(c, off); off += c.length; }
        decompressed = Array.from(out).map(b => String.fromCharCode(b)).join('');
      } catch (e) { /* not zlib */ }
    }
    if (!decompressed && streamBytes.length > 10) {
      try {
        const ds = new DecompressionStream('deflate-raw');
        const w = ds.writable.getWriter(); w.write(streamBytes); w.close();
        const chunks = []; const r = ds.readable.getReader();
        while (true) { const { done, value } = await r.read(); if (done) break; chunks.push(value); }
        const total = chunks.reduce((s, c) => s + c.length, 0);
        const out = new Uint8Array(total); let off = 0;
        for (const c of chunks) { out.set(c, off); off += c.length; }
        decompressed = Array.from(out).map(b => String.fromCharCode(b)).join('');
      } catch (e) { /* not raw deflate */ }
    }
    if (!decompressed) decompressed = streamStr;

    const btRx = /BT([\s\S]*?)ET/g;
    let bt;
    while ((bt = btRx.exec(decompressed)) !== null) {
      const block  = bt[1];
      const tjRx   = /\(([^)\\]*(?:\\.[^)\\]*)*)\)\s*T[jJ]/g;
      let tj;
      while ((tj = tjRx.exec(block)) !== null) allText += pdfDecodeStr(tj[1]) + ' ';
      const arrRx = /\[([^\]]*)\]\s*TJ/g;
      let arr;
      while ((arr = arrRx.exec(block)) !== null) {
        const strRx = /\(([^)\\]*(?:\\.[^)\\]*)*)\)/g;
        let sm;
        while ((sm = strRx.exec(arr[1])) !== null) allText += pdfDecodeStr(sm[1]);
      }
      allText += '\n';
    }
  }

  if (allText.trim().length < 100) {
    const btRx2 = /BT([\s\S]*?)ET/g;
    let bt2;
    while ((bt2 = btRx2.exec(raw)) !== null) {
      const block = bt2[1];
      const tjRx2 = /\(([^)]*)\)\s*T[jJ]/g;
      let tj2;
      while ((tj2 = tjRx2.exec(block)) !== null) allText += pdfDecodeStr(tj2[1]) + ' ';
      allText += '\n';
    }
  }

  allText = allText.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (allText.length < 80) {
    throw new Error('Could not read this PDF — it may be image-based. Please try DOCX or TXT.');
  }
  return allText;
}

function pdfDecodeStr(s) {
  return s
    .replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
    .replace(/\\\(/g, '(').replace(/\\\)/g, ')').replace(/\\\\/g, '\\');
}

// ── .doc (OLE2 Word Binary) text extraction ──
async function extractDocText(file) {
  const ab = await readAsArrayBuffer(file);
  const bytes = new Uint8Array(ab);

  // Strategy 1: Extract UTF-16LE text runs from the binary
  // .doc files store text as UTF-16LE in the WordDocument stream
  let text = '';

  // Look for runs of UTF-16LE printable chars (low byte is printable ASCII, high byte is 0x00)
  const len = bytes.length;
  let run = '';
  for (let i = 0; i < len - 1; i += 2) {
    const lo = bytes[i], hi = bytes[i + 1];
    if (hi === 0 && lo >= 0x20 && lo < 0x7F) {
      run += String.fromCharCode(lo);
    } else if (hi === 0 && (lo === 0x0D || lo === 0x0A)) {
      run += '\n';
    } else if (hi === 0 && lo === 0x09) {
      run += ' ';
    } else {
      if (run.length >= 10) text += run + '\n';
      run = '';
    }
  }
  if (run.length >= 10) text += run;

  // Strategy 2: Also try ASCII extraction as fallback
  if (text.trim().length < 100) {
    let asciiText = '';
    let ascRun = '';
    for (let i = 0; i < len; i++) {
      const b = bytes[i];
      if (b >= 0x20 && b < 0x7F) {
        ascRun += String.fromCharCode(b);
      } else if (b === 0x0D || b === 0x0A) {
        ascRun += '\n';
      } else {
        if (ascRun.length >= 8) asciiText += ascRun + '\n';
        ascRun = '';
      }
    }
    if (ascRun.length >= 8) asciiText += ascRun;
    if (asciiText.trim().length > text.trim().length) text = asciiText;
  }

  text = text.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  // Remove common binary noise patterns
  text = text.replace(/^[A-Za-z]{1,3}\n/gm, '')  // single-letter lines
    .replace(/\n{3,}/g, '\n\n').trim();

  if (text.length < 80) {
    throw new Error('Could not read this .doc file. Please save as DOCX or TXT and try again.');
  }
  return text;
}

async function extractDocxText(file) {
  const bytes = new Uint8Array(await readAsArrayBuffer(file));
  const xml   = await findFileInZip(bytes, 'word/document.xml');
  if (!xml) throw new Error('Could not read DOCX. Try saving as TXT.');
  return xml
    .replace(/<w:br[^>]*\/>/g, '\n').replace(/<w:p[ >][^>]*>/g, '\n').replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/\n{3,}/g, '\n\n').trim();
}

async function findFileInZip(bytes, targetPath) {
  async function decompress(data, comp) {
    if (comp === 0) return new TextDecoder('utf-8').decode(data);
    if (comp === 8) {
      const ds = new DecompressionStream('deflate-raw');
      const w = ds.writable.getWriter(); w.write(data); w.close();
      const chunks = []; const r = ds.readable.getReader();
      while (true) { const {done,value} = await r.read(); if (done) break; chunks.push(value); }
      const total = chunks.reduce((s,c) => s + c.length, 0);
      const out = new Uint8Array(total); let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.length; }
      return new TextDecoder('utf-8').decode(out);
    }
    return null;
  }

  // Find End of Central Directory (EOCD) — scan backwards from end of file
  let eocdOff = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes[i]===0x50 && bytes[i+1]===0x4B && bytes[i+2]===0x05 && bytes[i+3]===0x06) {
      eocdOff = i; break;
    }
  }

  // Use Central Directory for correct compressed sizes (handles data descriptors / bit flag 3)
  if (eocdOff !== -1) {
    const cdOff = bytes[eocdOff+16]|(bytes[eocdOff+17]<<8)|(bytes[eocdOff+18]<<16)|(bytes[eocdOff+19]<<24);
    const cdSz  = bytes[eocdOff+12]|(bytes[eocdOff+13]<<8)|(bytes[eocdOff+14]<<16)|(bytes[eocdOff+15]<<24);
    let pos = cdOff;
    while (pos < cdOff + cdSz && pos < bytes.length - 46) {
      if (bytes[pos]!==0x50||bytes[pos+1]!==0x4B||bytes[pos+2]!==0x01||bytes[pos+3]!==0x02) break;
      const comp   = bytes[pos+10]|(bytes[pos+11]<<8);
      const csz    = bytes[pos+20]|(bytes[pos+21]<<8)|(bytes[pos+22]<<16)|(bytes[pos+23]<<24);
      const fnLen  = bytes[pos+28]|(bytes[pos+29]<<8);
      const exLen  = bytes[pos+30]|(bytes[pos+31]<<8);
      const cmtLen = bytes[pos+32]|(bytes[pos+33]<<8);
      const lhOff  = bytes[pos+42]|(bytes[pos+43]<<8)|(bytes[pos+44]<<16)|(bytes[pos+45]<<24);
      const fname  = new TextDecoder().decode(bytes.slice(pos+46, pos+46+fnLen));
      if (fname === targetPath) {
        const lfnLen = bytes[lhOff+26]|(bytes[lhOff+27]<<8);
        const lexLen = bytes[lhOff+28]|(bytes[lhOff+29]<<8);
        const dStart = lhOff + 30 + lfnLen + lexLen;
        return decompress(bytes.slice(dStart, dStart + csz), comp);
      }
      pos += 46 + fnLen + exLen + cmtLen;
    }
  }

  // Fallback: scan local file headers (works when Central Directory is missing/corrupt)
  let i = 0;
  while (i < bytes.length - 30) {
    if (bytes[i]===0x50 && bytes[i+1]===0x4B && bytes[i+2]===0x03 && bytes[i+3]===0x04) {
      const comp  = bytes[i+8]|(bytes[i+9]<<8);
      const csz   = bytes[i+18]|(bytes[i+19]<<8)|(bytes[i+20]<<16)|(bytes[i+21]<<24);
      const fnLen = bytes[i+26]|(bytes[i+27]<<8);
      const exLen = bytes[i+28]|(bytes[i+29]<<8);
      const fname = new TextDecoder().decode(bytes.slice(i+30, i+30+fnLen));
      const dStart = i + 30 + fnLen + exLen;
      if (fname === targetPath) return decompress(bytes.slice(dStart, dStart+csz), comp);
      i = dStart + csz;
    } else { i++; }
  }
  return null;
}
