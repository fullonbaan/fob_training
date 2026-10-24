// api/_lib/library.js — the eBook shelf is read LIVE from the private bucket.
// No code change is needed to add, replace or remove files:
//
//   ebooks/<code>/<file>                      → a file directly in the kit
//   ebooks/<code>/<Section>/<file>            → a file in a SECTION of the kit (sub-folders, any depth:
//   ebooks/<code>/<Section>/<Sub>/<file>         shown as "Section / Sub")
//   ebooks/<code>.pdf                         → single-file layout, also supported
//
// <code> is a folder from src/_data/products.js → EBOOK_FOLDERS (dev, adm, fin, os, lnapi, …).
// Any file type is offered: PDFs can be read online (watermarked per buyer); everything else
// (Excel, Word, ZIP, scripts, text…) is a straight download.
//
// Titles: file / folder name without extension and without an ordering prefix:
//   "01 - Session Basics.pdf" → "Session Basics",  folder "02 - DAL Examples" → section "DAL Examples"
// Sorted by that prefix (numeric-aware). Anything whose name — or any folder on its path — starts
// with "_" or "." is hidden (drafts, _thumbs, .keep). Thumbs.db / desktop.ini are ignored too.
//
// Thumbnails:  <same folder>/_thumbs/<file name>.jpg — made automatically by /members-admin.
const r2 = require('./r2');
const catalog = require('./catalog');

const ROOT = 'ebooks/';
const TYPES = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  xls: 'application/vnd.ms-excel',
  csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',
  zip: 'application/zip',
  '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar',
  txt: 'text/plain',
  rtf: 'application/rtf',
  xml: 'application/xml',
  json: 'application/json',
  html: 'text/html',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  mp4: 'video/mp4'
};
const JUNK = /^(thumbs\.db|desktop\.ini|\.ds_store)$/i;

function extOf(name) { const m = String(name).match(/\.([A-Za-z0-9]{1,8})$/); return m ? m[1].toLowerCase() : null; }
// Non-PDF files are always downloaded, so serve unknown types as a generic binary.
function contentType(name) { return TYPES[extOf(name)] || 'application/octet-stream'; }
function isPdf(name) { return extOf(name) === 'pdf'; }

const PREFIX = /^\s*\d{1,3}\s*[-_.):]+\s*(?=\D)/;   // "01 - " / "2_" / "03) " — but NOT "10.8 Version" (a version number)
function titleFromFile(name) {
  const e = extOf(name);
  return String(name).replace(e ? new RegExp('\\.' + e + '$', 'i') : /$^/, '')
    .replace(PREFIX, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim() || 'eBook';
}
function sectionTitle(dir) { return String(dir).replace(PREFIX, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim() || dir; }

// id = path relative to ebooks/  e.g. "dev/01 - Sessions.pdf", "dev/DAL Examples/dal1.txt", or "dev.pdf"
function parseKey(key) {
  if (!key.startsWith(ROOT)) return null;
  const rel = key.slice(ROOT.length);
  const parts = rel.split('/');
  if (parts.some(p => !p)) return null;                    // folder markers ("…/") and empty segments
  if (parts.length === 1) {                                // ebooks/dev.pdf
    if (!isPdf(parts[0])) return null;
    const g = parts[0].replace(/\.pdf$/i, '');
    if (!catalog.isEbook(g)) return null;
    return { guide: g, id: rel, file: parts[0], dirs: [], section: '', title: catalog.EBOOKS[g].name, legacy: true, ext: 'pdf' };
  }
  const g = parts[0], file = parts[parts.length - 1], dirs = parts.slice(1, -1);
  if (!catalog.isEbook(g)) return null;
  if (parts.slice(1).some(p => /^[_.]/.test(p)) || JUNK.test(file) || !extOf(file)) return null;
  const ext = extOf(file);
  // PDFs get a tidy title; other files (scripts, examples, tools) keep their exact name minus the extension.
  const title = ext === 'pdf' ? titleFromFile(file) : (file.slice(0, -(ext.length + 1)).replace(PREFIX, '').trim() || file);
  return { guide: g, id: rel, file, dirs, section: dirs.map(sectionTitle).join(' / '), title, legacy: false, ext };
}

function thumbKeyForId(id) {
  const i = id.lastIndexOf('/');
  return ROOT + (i >= 0 ? id.slice(0, i + 1) : '') + '_thumbs/' + id.slice(i + 1) + '.jpg';
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

// → { dev: [ {id, key, title, section, size, updated, ext, …}, … ], fin: [...], … }  (every code present, maybe empty)
// Order: files in the kit's own folder first, then each section (by folder name), files by name.
async function shelf() {
  const objs = await r2.listObjects(ROOT);
  const byKey = {}; objs.forEach(o => { byKey[o.key] = o; });
  const out = {}; Object.keys(catalog.EBOOKS).forEach(g => { out[g] = []; });
  objs.forEach(o => {
    const p = parseKey(o.key);
    if (!p) return;
    const tk = thumbKeyForId(p.id), t = byKey[tk];
    out[p.guide].push({
      id: p.id, key: o.key, file: p.file, dir: p.dirs.join('/'), section: p.section, title: p.title, size: o.size,
      updated: o.lastModified, legacy: p.legacy, ext: p.ext,
      thumbKey: t ? tk : null,
      thumbStale: p.ext === 'pdf' && (!t || !!(o.lastModified && t.lastModified && new Date(t.lastModified) < new Date(o.lastModified)))
    });
  });
  Object.keys(out).forEach(g => out[g].sort((a, b) =>
    (b.legacy - a.legacy) || ((a.dir ? 1 : 0) - (b.dir ? 1 : 0)) || collator.compare(a.dir, b.dir) || collator.compare(a.file, b.file)));
  return out;
}

// Validate an id coming from a browser and resolve it to an object key (or null).
function keyForId(guide, id) {
  id = String(id || '');
  if (id.includes('..') || id.includes('\\') || id.startsWith('/')) return null;
  const p = parseKey(ROOT + id);
  return p && p.guide === guide ? ROOT + id : null;
}

// Clean an uploaded file name so it is safe as an object key and reads well as a title.
function cleanSegment(s) {
  return String(s || '').replace(/[^\w\s.,()&+'-]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^[.]+/, '').slice(0, 140);
}
function safeFileName(name) {
  const base = String(name || '').split(/[\\/]/).pop();
  const ext = extOf(base);
  if (!ext) return null;
  const stem = cleanSegment(base.slice(0, -(ext.length + 1)));
  return stem ? stem + '.' + ext : null;
}
// "Training EBooks / Part 2" → "Training EBooks/Part 2" (each folder cleaned; hidden "_" / "." folders refused)
function safeSection(section) {
  const segs = String(section || '').split(/[\\/]/).map(cleanSegment).filter(Boolean);
  if (segs.some(s => /^[_.]/.test(s))) return null;
  return segs.join('/');
}

module.exports = { ROOT, TYPES, shelf, keyForId, thumbKeyForId, titleFromFile, sectionTitle, safeFileName, safeSection, parseKey, extOf, isPdf, contentType };
