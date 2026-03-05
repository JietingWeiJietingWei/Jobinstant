// popup.js — v5.29 single-page auto-save flow

let resumeText = '';
let resumeFileName = null;

document.addEventListener('DOMContentLoaded', () => {
  const uploadZone  = document.getElementById('upload-zone');
  const fileInput   = document.getElementById('file-input');
  const replaceBtn  = document.getElementById('replace-btn');
  const linkedinBtn = document.getElementById('linkedin-btn');

  // Click zone → open file picker
  uploadZone.addEventListener('click', () => fileInput.click());

  // Drag & drop
  uploadZone.addEventListener('dragover',  e => { e.preventDefault(); uploadZone.classList.add('drag'); });
  uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag'));
  uploadZone.addEventListener('drop', e => {
    e.preventDefault();
    uploadZone.classList.remove('drag');
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  });

  // File picker change → auto-save
  fileInput.addEventListener('change', e => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  });

  // Replace → go back to upload
  replaceBtn.addEventListener('click', showUpload);

  // Go to LinkedIn Jobs
  linkedinBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://www.linkedin.com/jobs/search/' });
    window.close();
  });

  // Check if resume already saved on open
  chrome.storage.local.get(['resume', 'resumeFileName'], data => {
    if (data.resume) {
      showSaved(data.resumeFileName || 'Resume');
    }
  });
});

// ── State transitions ──
function showUpload() {
  document.getElementById('upload-state').style.display = 'block';
  document.getElementById('saving-state').style.display = 'none';
  document.getElementById('saved-state').style.display  = 'none';
  document.getElementById('file-input').value = '';
  resumeText = '';
}

function showSaving() {
  document.getElementById('upload-state').style.display = 'none';
  document.getElementById('saving-state').style.display = 'flex';
  document.getElementById('saved-state').style.display  = 'none';
}

function showSaved(name) {
  document.getElementById('upload-state').style.display = 'none';
  document.getElementById('saving-state').style.display = 'none';
  document.getElementById('saved-state').style.display  = 'block';
  document.getElementById('saved-filename').textContent = name + ' ✓';
}

// ── File handling → auto-save ──
async function handleFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  const supported = ['pdf', 'doc', 'docx', 'odt', 'txt', 'rtf', 'md'];
  if (!supported.includes(ext)) {
    alert('Unsupported file type.\n\nSupported formats: PDF, DOCX, DOC, ODT, TXT, RTF, MD\n\nTip: If your resume is in another format, open it and copy-paste the text into a .txt file.');
    return;
  }

  showSaving();

  try {
    let text = '';
    if      (ext === 'txt' || ext === 'md') text = await readAsText(file);
    else if (ext === 'rtf')  text = stripRtf(await readAsText(file));
    else if (ext === 'pdf')  text = await extractPdfText(file);
    else if (ext === 'docx' || ext === 'odt') text = await extractDocxText(file);
    else if (ext === 'doc') {
      // Try as DOCX first (some .doc files are actually DOCX)
      try { text = await extractDocxText(file); } catch(e) {}
      if (!text || text.length < 50) {
        // Fallback: read as text and strip binary
        const raw = await readAsText(file);
        text = raw.replace(/[^\x20-\x7E\n\r\t]/g, ' ').replace(/\s{3,}/g, '\n').trim();
      }
    }

    text = text.trim();
    if (text.length < 50) throw new Error(
      'Not enough text could be extracted from this file.\n\n' +
      'Tips:\n' +
      '• If it\'s a scanned PDF, copy-paste the text into a .txt file instead\n' +
      '• Try saving your resume as DOCX from Word or Google Docs\n' +
      '• Or paste your resume text directly into a .txt file'
    );

    resumeText = text;
    resumeFileName = file.name;
    chrome.storage.local.set({ resume: text, resumeFileName: file.name }, () => {
      showSaved(file.name);
    });

  } catch(err) {
    showUpload();
    alert('Could not read your resume:\n\n' + err.message);
  }
}

// ── Text extraction helpers ──
function readAsText(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = e => res(e.target.result);
    r.onerror = () => rej(new Error('Could not read file'));
    r.readAsText(file, 'UTF-8');
  });
}
function readAsArrayBuffer(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = e => res(e.target.result);
    r.onerror = () => rej(new Error('Could not read file'));
    r.readAsArrayBuffer(file);
  });
}
function stripRtf(rtf) {
  return rtf.replace(/\{[^{}]*\}/g,'').replace(/\\[a-z]+\d*\s?/gi,'')
            .replace(/[{}\\]/g,'').replace(/\s+/g,' ').trim();
}

// ═══════════════════════════════════════════════════════════════
// PDF TEXT EXTRACTOR — multi-strategy, handles LinkedIn/Word/Mac PDFs
// Strategy order: stream parse → page-level scan → raw ASCII fallback
// ═══════════════════════════════════════════════════════════════

async function extractPdfText(file) {
  const ab = await readAsArrayBuffer(file);
  const bytes = new Uint8Array(ab);
  // latin1 decode: 1-to-1 byte mapping, preserves all binary values
  const raw = bytes.reduce((s, b) => s + String.fromCharCode(b), '');

  // ── Strategy 1: decompress & parse all content streams ──
  let text = '';
  try {
    const streams = await getAllStreams(raw, bytes);
    for (const s of streams) text += parseContentStream(s) + '\n';
  } catch(e) {}

  // ── Strategy 2: if little text, try page-by-page content stream scan ──
  if (text.trim().length < 80) {
    try { text = scanAllBTBlocks(raw); } catch(e) {}
  }

  // ── Strategy 3: raw readable ASCII (catches uncompressed PDFs) ──
  if (text.trim().length < 80) {
    text = raw.replace(/[^\x20-\x7E\n\r\t]/g, ' ')
               .replace(/\s{5,}/g, '\n').replace(/\n{4,}/g, '\n\n').trim();
  }

  text = normalizeText(text);
  if (text.length < 60) {
    throw new Error(
      'Could not extract text from this PDF.\n\n' +
      'This usually means the PDF is image-based (scanned) or uses a special font encoding.\n\n' +
      'Solutions:\n' +
      '• Open the PDF, select all text (Ctrl+A), copy and paste into a .txt file\n' +
      '• Re-save your resume as DOCX from Word or Google Docs\n' +
      '• Export from LinkedIn as DOCX instead of PDF'
    );
  }
  return text;
}

// ── Decompress all streams in the PDF ──
async function getAllStreams(raw, bytes) {
  const results = [];
  // Match stream...endstream — handles \r\n, \n, \r line endings
  const rx = /stream[\r\n]+([\s\S]*?)[\r\n]+endstream/g;
  let m;
  while ((m = rx.exec(raw)) !== null) {
    const chunk = m[1];
    if (chunk.length < 10) continue;
    const chunkBytes = new Uint8Array(chunk.length);
    for (let i = 0; i < chunk.length; i++) chunkBytes[i] = chunk.charCodeAt(i) & 0xff;

    // Try zlib (0x78 0x9C / 0x78 0x01 / 0x78 0xDA — FlateDecode)
    if (chunkBytes[0] === 0x78) {
      const dec = await tryInflate(chunkBytes, 'deflate');
      if (dec) { results.push(dec); continue; }
    }
    // Try raw deflate (no zlib header)
    const dec2 = await tryInflate(chunkBytes, 'deflate-raw');
    if (dec2) { results.push(dec2); continue; }

    // Use as-is (uncompressed or unsupported filter)
    results.push(chunk);
  }
  return results;
}

async function tryInflate(bytes, format) {
  try {
    const ds = new DecompressionStream(format);
    const w = ds.writable.getWriter();
    w.write(bytes); w.close();
    const r = ds.readable.getReader();
    const chunks = [];
    while (true) { const {done, value} = await r.read(); if (done) break; chunks.push(value); }
    const total = chunks.reduce((s,c) => s + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    // Convert back to latin1 string
    return out.reduce((s, b) => s + String.fromCharCode(b), '');
  } catch(e) { return null; }
}

// ── Parse a PDF content stream for text operators ──
function parseContentStream(stream) {
  let text = '';
  let lineBreakPending = false;

  // BT...ET blocks contain text drawing commands
  const btRx = /BT([\s\S]*?)ET/g;
  let bt;
  while ((bt = btRx.exec(stream)) !== null) {
    const block = bt[1];
    text += parseTextBlock(block) + '\n';
  }
  return text;
}

function parseTextBlock(block) {
  let text = '';
  // Split into tokens — handle multi-line operators
  // We process line by line to handle operators that span lines
  const lines = block.split(/\r?\n/);

  // Accumulate tokens that span multiple lines for array TJ
  let accumulated = '';

  for (let i = 0; i < lines.length; i++) {
    accumulated += ' ' + lines[i];

    // Check if we have a complete operator
    const t = accumulated.trim();

    // Newline operators: Td, TD, T*, Tm, '  ″
    if (/^-?[\d.]+\s+-?[\d.]+\s+T[dD]$/.test(t) ||
        /^T\*$/.test(t) ||
        /^-?[\d.]+\s+-?[\d.]+\s+-?[\d.]+\s+-?[\d.]+\s+-?[\d.]+\s+-?[\d.]+\s+Tm$/.test(t)) {
      if (text && !text.endsWith('\n')) text += '\n';
      accumulated = '';
      continue;
    }

    // (string) Tj
    const tjSimple = t.match(/^\(([^)\\]*(?:\\.[^)\\]*)*)\)\s*Tj$/);
    if (tjSimple) {
      text += decodePdfString(tjSimple[1]);
      accumulated = '';
      continue;
    }

    // (string) '  or  (string) "
    const quoteOp = t.match(/^\(([^)\\]*(?:\\.[^)\\]*)*)\)\s*['"]$/);
    if (quoteOp) {
      text += '\n' + decodePdfString(quoteOp[1]);
      accumulated = '';
      continue;
    }

    // <hex> Tj
    const tjHex = t.match(/^<([0-9A-Fa-f\s]*)>\s*Tj$/);
    if (tjHex) {
      text += decodeHexString(tjHex[1]);
      accumulated = '';
      continue;
    }

    // [...] TJ  — array form (most modern PDFs including LinkedIn)
    const tjArr = t.match(/^\[([\s\S]*)\]\s*TJ$/);
    if (tjArr) {
      text += decodeTJArray(tjArr[1]);
      accumulated = '';
      continue;
    }

    // If line is complete (no open brackets/parens), reset accumulator
    if (!t.includes('[') || t.includes(']')) {
      const openP = (t.match(/\(/g) || []).length;
      const closeP = (t.match(/\)/g) || []).length;
      if (openP === closeP) accumulated = '';
    }
  }
  return text;
}

function decodeTJArray(content) {
  let text = '';
  // Match literal strings () and hex strings <>; skip numbers (kerning)
  const rx = /\(([^)\\]*(?:\\.[^)\\]*)*)\)|<([0-9A-Fa-f\s]*)>/g;
  let m;
  while ((m = rx.exec(content)) !== null) {
    if (m[1] !== undefined) text += decodePdfString(m[1]);
    else if (m[2] !== undefined) text += decodeHexString(m[2]);
  }
  return text;
}

// ── Decode literal PDF string (handles octal escapes, special chars) ──
function decodePdfString(s) {
  return s
    .replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
    .replace(/\\\(/g, '(').replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\')
    .replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
    .replace(/\\([0-7]{1,2})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
}

// ── Decode hex string — handles UTF-16BE (LinkedIn), 1-byte, and 2-byte encodings ──
function decodeHexString(hex) {
  const h = hex.replace(/\s/g, '');
  if (!h) return '';

  // UTF-16BE BOM FEFF → Unicode
  if (h.toUpperCase().startsWith('FEFF')) {
    let out = '';
    for (let i = 4; i + 3 < h.length; i += 4) {
      const code = parseInt(h.slice(i, i + 4), 16);
      if (!isNaN(code) && code > 0) out += String.fromCodePoint(code);
    }
    return out;
  }

  // Try 4-hex pairs as Unicode codepoints (LinkedIn, modern Word PDFs)
  if (h.length % 4 === 0 && h.length >= 4) {
    let out = '', valid = true;
    for (let i = 0; i < h.length; i += 4) {
      const code = parseInt(h.slice(i, i + 4), 16);
      if (isNaN(code) || code === 0) { valid = false; break; }
      // Only accept printable Unicode
      if (code >= 0x20 && code < 0xFFFE) out += String.fromCodePoint(code);
      else if (code === 0x000A || code === 0x000D) out += '\n';
      else { valid = false; break; }
    }
    if (valid && out.trim().length > 0) return out;
  }

  // Fallback: 2-hex pairs as latin1/ASCII
  let out = '';
  for (let i = 0; i + 1 < h.length; i += 2) {
    const code = parseInt(h.slice(i, i + 2), 16);
    if (!isNaN(code) && code >= 0x20 && code < 0xFF) out += String.fromCharCode(code);
  }
  return out;
}

// ── Scan the entire raw PDF for BT/ET blocks (catches uncompressed parts) ──
function scanAllBTBlocks(raw) {
  let text = '';
  const rx = /BT([\s\S]{1,5000}?)ET/g;
  let m;
  while ((m = rx.exec(raw)) !== null) {
    text += parseTextBlock(m[1]) + '\n';
  }
  return text;
}

// ── Normalize extracted text ──
function normalizeText(text) {
  return text
    .replace(/[ \t]{2,}/g, ' ')    // collapse horizontal whitespace
    .replace(/\n{3,}/g, '\n\n')    // max 2 consecutive newlines
    .replace(/^\s+|\s+$/gm, '')    // trim each line
    .trim();
}

async function extractDocxText(file) {
  const bytes = new Uint8Array(await readAsArrayBuffer(file));

  // Try DOCX (word/document.xml)
  const xml = await findFileInZip(bytes, 'word/document.xml');
  if (xml) {
    return xml
      .replace(/<w:br[^>]*\/>/g, '\n')
      .replace(/<w:p[\s>][^>]*>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&apos;/g, "'").replace(/&quot;/g, '"')
      .replace(/\n{3,}/g, '\n\n').trim();
  }

  // Try ODT (LibreOffice content.xml)
  const odt = await findFileInZip(bytes, 'content.xml');
  if (odt) {
    return odt
      .replace(/<text:line-break\/>/g, '\n')
      .replace(/<text:p[\s>][^>]*>/g, '\n')
      .replace(/<\/text:p>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/\n{3,}/g, '\n\n').trim();
  }

  throw new Error('Could not read this file. Try saving as PDF or TXT.');
}
async function findFileInZip(bytes, targetPath) {
  let i = 0;
  while (i < bytes.length - 30) {
    if (bytes[i]===0x50&&bytes[i+1]===0x4B&&bytes[i+2]===0x03&&bytes[i+3]===0x04) {
      const comp  = bytes[i+8]|(bytes[i+9]<<8);
      const csz   = bytes[i+18]|(bytes[i+19]<<8)|(bytes[i+20]<<16)|(bytes[i+21]<<24);
      const fnLen = bytes[i+26]|(bytes[i+27]<<8);
      const exLen = bytes[i+28]|(bytes[i+29]<<8);
      const fname = new TextDecoder().decode(bytes.slice(i+30,i+30+fnLen));
      const dStart = i+30+fnLen+exLen;
      if (fname === targetPath) {
        const data = bytes.slice(dStart, dStart+csz);
        if (comp === 0) return new TextDecoder('utf-8').decode(data);
        if (comp === 8) {
          const ds = new DecompressionStream('deflate-raw');
          const w = ds.writable.getWriter(); w.write(data); w.close();
          const chunks = []; const r = ds.readable.getReader();
          while (true) { const {done,value} = await r.read(); if (done) break; chunks.push(value); }
          const total = chunks.reduce((s,c)=>s+c.length,0);
          const out = new Uint8Array(total); let off=0;
          for (const c of chunks){out.set(c,off);off+=c.length;}
          return new TextDecoder('utf-8').decode(out);
        }
        return null;
      }
      i = dStart+csz;
    } else { i++; }
  }
  return null;
}
