// api/_lib/library.js — the eBook shelf is read LIVE from the private bucket.
// No code change is needed to add, replace or remove eBooks:
//
//   ebooks/<code>/<any name>.pdf   → every file in the folder is part of that eBook product
//   ebooks/<code>.pdf              → (single-file layout, also supported)
//
// <code> is a folder from src/_data/products.js → EBOOK_FOLDERS (dev, adm, fin, os, lnapi, …).
// Besides PDFs, Excel / Word / PowerPoint / ZIP files are allowed (e.g. the "+ Excel tool" kits);
// they are offered as downloads. Only PDFs can be read online and are watermarked.
//
// Title shown to customers = file name without extension, with an optional ordering
// prefix removed:  "01 - Session Basics.pdf"  →  "Session Basics"   (sorted by the prefix)
// Files whose name starts with "_" or "." are hidden (drafts, folder markers).
//
// Thumbnails:  ebooks/<code>/_thumbs/<file name>.jpg — made automatically by /members-admin.
const r2 = require('./r2');
const catalog = require('./catalog');

const ROOT = 'ebooks/';
const TYPES = {
  pdf:  'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  xls:  'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip:  'application/zip'
};
const EXT_RE = new RegExp('\\.(' + Object.keys(TYPES).join('|') + ')$', 'i');

function extOf(name) { const m = String(name).match(EXT_RE); return m ? m[1].toLowerCase() : null; }
function contentType(name) { return TYPES[extOf(name)] || 'application/octet-stream'; }
function isPdf(name) { return extOf(name) === 'pdf'; }

function titleFromFile(name) {
  return String(name).replace(EXT_RE, '')
    .replace(/^\s*\d{1,3}\s*[-_.):]+\s*/, '')     // "01 - " / "2_" / "03) "
    .replace(/_/g, ' ').replace(/\s+/g, ' ').trim() || 'eBook';
}

// id = path relative to ebooks/  e.g. "dev/01 - Sessions.pdf"  or single-file "dev.pdf"
function parseKey(key) {
  if (!key.startsWith(ROOT) || !extOf(key)) return null;
  const rel = key.slice(ROOT.length);
  const parts = rel.split('/');
  if (parts.length === 1) {                                  // ebooks/dev.pdf
    if (!isPdf(parts[0])) return null;
    const g = parts[0].replace(/\.pdf$/i, '');
    if (!catalog.isEbook(g)) return null;
    return { guide: g, id: rel, file: parts[0], title: catalog.EBOOKS[g].name, legacy: true, ext: 'pdf' };
  }
  if (parts.length !== 2) return null;                       // no deeper folders (e.g. _thumbs)
  const [g, file] = parts;
  if (!catalog.isEbook(g) || !file || /^[_.]/.test(file)) return null;
  return { guide: g, id: rel, file, title: titleFromFile(file), legacy: false, ext: extOf(file) };
}

function thumbKeyForId(id) {
  const i = id.lastIndexOf('/');
  return ROOT + (i >= 0 ? id.slice(0, i + 1) : '') + '_thumbs/' + id.slice(i + 1) + '.jpg';
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

// → { dev: [ {id, key, title, size, updated, ext, …}, … ], fin: [...], … }  (every code present, maybe empty)
async function shelf() {
  const objs = await r2.listObjects(ROOT);
  const byKey = {}; objs.forEach(o => { byKey[o.key] = o; });
  const out = {}; Object.keys(catalog.EBOOKS).forEach(g => { out[g] = []; });
  objs.forEach(o => {
    const p = parseKey(o.key);
    if (!p) return;
    const tk = thumbKeyForId(p.id), t = byKey[tk];
    out[p.guide].push({
      id: p.id, key: o.key, file: p.file, title: p.title, size: o.size, updated: o.lastModified, legacy: p.legacy, ext: p.ext,
      thumbKey: t ? tk : null,
      thumbStale: p.ext === 'pdf' && (!t || !!(o.lastModified && t.lastModified && new Date(t.lastModified) < new Date(o.lastModified)))
    });
  });
  Object.keys(out).forEach(g => out[g].sort((a, b) => (b.legacy - a.legacy) || collator.compare(a.file, b.file)));
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
function safeFileName(name) {
  const base = String(name || '').split(/[\\/]/).pop();
  const ext = extOf(base) || 'pdf';
  let n = base.replace(/[^\w\s.,()&+'-]/g, ' ').replace(/\s+/g, ' ').trim();
  n = n.replace(/^\.+/, '').replace(EXT_RE, '').trim();
  if (!n) return null;
  return n.slice(0, 140) + '.' + ext;
}

module.exports = { ROOT, TYPES, shelf, keyForId, thumbKeyForId, titleFromFile, safeFileName, parseKey, extOf, isPdf, contentType };
