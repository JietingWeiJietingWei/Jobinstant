// options.js — v5.1 — file upload only, no API keys needed

const BACKEND_URL = 'https://jobfit-ai.jdfitanalyzer.workers.dev';
let resumeText = '';

document.addEventListener('DOMContentLoaded', () => {
  // Check server status
  checkServer();

  // Load existing resume
  chrome.storage.local.get(['resume'], (data) => {
    if (data.resume) {
      resumeText = data.resume;
      showExistingResume(data.resume);
    }
  });

  // File input change
  document.getElementById('file-input').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  });

  // Upload zone: click to open file picker
  document.getElementById('upload-zone').addEventListener('click', () => {
    document.getElementById('file-input').click();
  });

  // Upload zone: drag & drop
  document.getElementById('upload-zone').addEventListener('dragover', (e) => {
    e.preventDefault();
    handleDrag(e, true);
  });
  document.getElementById('upload-zone').addEventListener('dragleave', (e) => {
    handleDrag(e, false);
  });
  document.getElementById('upload-zone').addEventListener('drop', (e) => {
    e.preventDefault();
    handleDrop(e);
  });

  // Clear button
  document.getElementById('clear-btn').addEventListener('click', clearFile);

  // Save button
  document.getElementById('saveBtn').addEventListener('click', doSave);
});

async function checkServer() {
  const dot  = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  const box  = document.getElementById('server-status');
  try {
    const r = await fetch(BACKEND_URL + '/quota', { method: 'GET' });
    if (r.ok) {
      const data = await r.json();
      dot.classList.remove('error');
      box.classList.remove('error');
      text.textContent = `✓ Server online — ${data.userRemaining ?? '?'} scores remaining today`;
    } else {
      throw new Error('bad status');
    }
  } catch(e) {
    dot.classList.add('error');
    box.classList.add('error');
    text.textContent = '✗ Server unreachable — check your internet';
  }
}

function showExistingResume(text) {
  document.getElementById('resume-preview').value = text.slice(0, 500) + (text.length > 500 ? '\n…' : '');
  document.getElementById('upload-zone').classList.add('has-file');
  document.getElementById('file-name').textContent = 'Saved resume';
  document.getElementById('file-meta').textContent = text.length.toLocaleString() + ' characters';
  document.getElementById('file-result').style.display = 'flex';
  document.getElementById('saveBtn').disabled = false;
}

function handleDrag(e, over) {
  document.getElementById('upload-zone').classList.toggle('drag', over);
}
function handleDrop(e) {
  document.getElementById('upload-zone').classList.remove('drag');
  const file = e.dataTransfer.files?.[0];
  if (file) handleFile(file);
}

async function handleFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['pdf','doc','docx','txt'].includes(ext)) {
    showErr('Unsupported file type. Please use PDF, DOCX, DOC, or TXT.');
    return;
  }
  showParsing(true, 'Reading ' + file.name + '…');
  document.getElementById('file-result').style.display = 'none';
  document.getElementById('upload-zone').style.display = 'none';

  try {
    let text = '';
    if (ext === 'txt')       text = await readAsText(file);
    else if (ext === 'rtf')  { showErr('RTF format is not supported. Please save as PDF, DOCX, or TXT.'); return; }
    else if (ext === 'pdf')  { showParsing(true,'Parsing PDF…');  text = await extractPdfText(file); }
    else if (ext === 'docx') { showParsing(true,'Parsing DOCX…'); text = await extractDocxText(file); }
    else if (ext === 'doc')  {
      const raw = await readAsText(file);
      text = raw.replace(/[^\x20-\x7E\n\r\t]/g,' ').replace(/\s{3,}/g,'\n').trim();
    }
    text = text.trim();
    if (text.length < 50) throw new Error('Could not extract enough text. Try saving as TXT.');

    resumeText = text;
    showParsing(false);
    document.getElementById('upload-zone').style.display = 'block';
    document.getElementById('upload-zone').classList.add('has-file');
    document.getElementById('file-result').style.display = 'flex';
    document.getElementById('file-name').textContent = file.name;
    document.getElementById('file-meta').textContent = text.length.toLocaleString() + ' characters extracted ✓';
    document.getElementById('resume-preview').value = text.slice(0, 500) + (text.length > 500 ? '\n…' : '');
    document.getElementById('saveBtn').disabled = false;
  } catch(err) {
    showParsing(false);
    document.getElementById('upload-zone').style.display = 'block';
    showErr('Error: ' + err.message);
  }
}

function clearFile() {
  resumeText = '';
  document.getElementById('file-input').value = '';
  document.getElementById('file-result').style.display = 'none';
  document.getElementById('upload-zone').classList.remove('has-file');
  document.getElementById('resume-preview').value = '';
  document.getElementById('saveBtn').disabled = true;
}

function doSave() {
  if (!resumeText) { showErr('Please upload a resume first.'); return; }
  const btn = document.getElementById('saveBtn');
  btn.textContent = 'Saving…'; btn.disabled = true;
  chrome.storage.local.set({ resume: resumeText }, () => {
    btn.textContent = '✓ Save Resume'; btn.disabled = false;
    document.getElementById('msg').style.display = 'block';
    document.getElementById('err').style.display = 'none';
    setTimeout(() => { document.getElementById('msg').style.display = 'none'; }, 4000);
  });
}

function showParsing(show, label) {
  const bar = document.getElementById('parsing-bar');
  bar.style.display = show ? 'flex' : 'none';
  if (label) document.getElementById('parsing-label').textContent = label;
}

function showErr(msg) {
  document.getElementById('err').style.display = 'block';
  document.getElementById('err').textContent = msg;
}

// ── File extraction (same as popup.js) ──
function readAsText(file) {
  return new Promise((res,rej) => {
    const r = new FileReader();
    r.onload = e => res(e.target.result);
    r.onerror = () => rej(new Error('Could not read file'));
    r.readAsText(file,'UTF-8');
  });
}
function readAsArrayBuffer(file) {
  return new Promise((res,rej) => {
    const r = new FileReader();
    r.onload = e => res(e.target.result);
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
  const bytes = new Uint8Array(ab);

  // Decode raw bytes as latin1 so binary values are preserved 1:1
  const raw = Array.from(bytes).map(b => String.fromCharCode(b)).join('');

  // Find all PDF streams and decompress each
  const streamRx = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let allText = '';
  let m;

  while ((m = streamRx.exec(raw)) !== null) {
    const streamStr = m[1];
    const streamBytes = new Uint8Array(streamStr.length);
    for (let i = 0; i < streamStr.length; i++) streamBytes[i] = streamStr.charCodeAt(i) & 0xff;

    let decompressed = null;

    // Try zlib (FlateDecode — most modern PDFs: magic byte 0x78)
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
      } catch(e) { /* not zlib */ }
    }

    // Fallback: raw deflate (no zlib header)
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
      } catch(e) { /* not raw deflate */ }
    }

    // Use raw stream if no decompression worked
    if (!decompressed) decompressed = streamStr;

    // Extract text from BT...ET blocks
    const btRx = /BT([\s\S]*?)ET/g;
    let bt;
    while ((bt = btRx.exec(decompressed)) !== null) {
      const block = bt[1];
      // (text) Tj or (text) TJ
      const tjRx = /\(([^)\\]*(?:\\.[^)\\]*)*)\)\s*T[jJ]/g;
      let tj;
      while ((tj = tjRx.exec(block)) !== null) {
        allText += pdfDecodeStr(tj[1]) + ' ';
      }
      // [(text)-200(text)] TJ array form
      const arrRx = /\[([^\]]*)\]\s*TJ/g;
      let arr;
      while ((arr = arrRx.exec(block)) !== null) {
        const strRx = /\(([^)\\]*(?:\\.[^)\\]*)*)\)/g;
        let sm;
        while ((sm = strRx.exec(arr[1])) !== null) {
          allText += pdfDecodeStr(sm[1]);
        }
      }
      allText += '\n';
    }
  }

  // Fallback: also scan uncompressed root level
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

  allText = allText
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (allText.length < 80) {
    throw new Error('Could not read this PDF — it may be image-based or scanned. Please export your resume as DOCX or TXT instead.');
  }
  return allText;
}

function pdfDecodeStr(s) {
  return s
    .replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
    .replace(/\\\(/g, '(').replace(/\\\)/g, ')').replace(/\\\\/g, '\\');
}

async function extractDocxText(file) {
  const bytes = new Uint8Array(await readAsArrayBuffer(file));
  const xml = await findFileInZip(bytes, 'word/document.xml');
  if (!xml) throw new Error('Could not read DOCX. Try saving as TXT.');
  return xml
    .replace(/<w:br[^>]*\/>/g,'\n').replace(/<w:p[ >][^>]*>/g,'\n').replace(/<\/w:p>/g,'\n')
    .replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&apos;/g,"'").replace(/&quot;/g,'"').replace(/\n{3,}/g,'\n\n').trim();
}
async function findFileInZip(bytes, targetPath) {
  async function decompress(data, comp) {
    if (comp === 0) return new TextDecoder('utf-8').decode(data);
    if (comp === 8) {
      const ds = new DecompressionStream('deflate-raw');
      const w = ds.writable.getWriter(); w.write(data); w.close();
      const chunks = []; const r = ds.readable.getReader();
      while (true) { const {done,value} = await r.read(); if (done) break; chunks.push(value); }
      const total = chunks.reduce((s,c)=>s+c.length,0);
      const out = new Uint8Array(total); let off=0;
      for (const c of chunks) { out.set(c,off); off+=c.length; }
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
    if (bytes[i]===0x50&&bytes[i+1]===0x4B&&bytes[i+2]===0x03&&bytes[i+3]===0x04) {
      const comp  = bytes[i+8]|(bytes[i+9]<<8);
      const csz   = bytes[i+18]|(bytes[i+19]<<8)|(bytes[i+20]<<16)|(bytes[i+21]<<24);
      const fnLen = bytes[i+26]|(bytes[i+27]<<8);
      const exLen = bytes[i+28]|(bytes[i+29]<<8);
      const fname = new TextDecoder().decode(bytes.slice(i+30,i+30+fnLen));
      const dStart = i+30+fnLen+exLen;
      if (fname === targetPath) return decompress(bytes.slice(dStart, dStart+csz), comp);
      i = dStart+csz;
    } else { i++; }
  }
  return null;
}
