// api/_lib/r2.js — private object storage on Cloudflare R2 (S3-compatible).
// The bucket is PRIVATE: nothing in it has a public URL. The server reads/writes with
// secret keys, and hands customers short-lived signed links (default 5 minutes).
//
// Env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
// (FOB_LOCAL_STORE=/some/dir switches to a local folder — for offline testing only.)

const { AwsClient } = require('aws4fetch');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Env values are trimmed: a space or line break pasted into Vercel breaks the signature (→ 403).
const E = (k) => String(process.env[k] || '').trim();
const host = () => E('R2_ENDPOINT') ? E('R2_ENDPOINT').replace(/^https?:\/\//, '').replace(/\/+$/, '')
  : E('R2_ACCOUNT_ID') + (E('R2_JURISDICTION') ? '.' + E('R2_JURISDICTION').toLowerCase() : '') + '.r2.cloudflarestorage.com';

let _client = null;
function client() {
  if (_client) return _client;
  const need = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];
  const missing = need.filter(k => !E(k));
  if (missing.length) throw new Error('Storage not configured — missing env: ' + missing.join(', '));
  _client = new AwsClient({ accessKeyId: E('R2_ACCESS_KEY_ID'), secretAccessKey: E('R2_SECRET_ACCESS_KEY'), service: 's3', region: 'auto' });
  return _client;
}
function bucketUrl() { return 'https://' + host() + '/' + E('R2_BUCKET'); }
function objUrl(key) {
  const enc = String(key).split('/').map(encodeURIComponent).join('/');
  return bucketUrl() + '/' + enc;
}

// Turn an R2 error response into a message that says WHICH setting is wrong.
const HINTS = {
  SignatureDoesNotMatch: 'R2_SECRET_ACCESS_KEY does not match R2_ACCESS_KEY_ID (wrong value, or a space/line break was pasted with it).',
  InvalidAccessKeyId: 'R2_ACCESS_KEY_ID is not a valid R2 key (use the "Access Key ID" shown when the R2 API token was created, not the token value).',
  AccessDenied: 'This R2 API token is not allowed on bucket "' + '%B' + '". Create / edit the token with "Object Read & Write" and add this bucket (a token made for fob-interview-ebooks only works on that bucket).',
  NoSuchBucket: 'Bucket "%B" does not exist in account R2_ACCOUNT_ID — check R2_BUCKET and R2_ACCOUNT_ID.',
  Unauthorized: 'R2 rejected the credentials — check R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY.',
  InvalidBucketName: 'R2_BUCKET is not a valid bucket name.'
};
async function r2Error(op, key, r) {
  let text = ''; try { text = await r.text(); } catch (e) {}
  const code = (text.match(/<Code>([^<]+)<\/Code>/) || [])[1] || '';
  const msg = (text.match(/<Message>([^<]+)<\/Message>/) || [])[1] || '';
  let hint = HINTS[code] || (r.status === 403 ? HINTS.AccessDenied : r.status === 401 ? HINTS.Unauthorized : '');
  hint = hint.replace(/%B/g, E('R2_BUCKET'));
  const err = new Error('R2 ' + op + (key ? ' ' + key : '') + ' → ' + r.status + (code ? ' ' + code : '') + (msg ? ' (' + msg + ')' : '') + (hint ? ' — ' + hint : ''));
  err.status = r.status; err.code = code;
  return err;
}

// Quick self-check of the storage settings (used by /members-admin).
function configReport() {
  const out = [];
  if (!/^[0-9a-f]{32}$/i.test(E('R2_ACCOUNT_ID')) && !E('R2_ENDPOINT')) out.push('R2_ACCOUNT_ID should be the 32-character Cloudflare Account ID (R2 overview page, right side).');
  if (E('R2_ACCESS_KEY_ID') && E('R2_ACCESS_KEY_ID').length !== 32) out.push('R2_ACCESS_KEY_ID is ' + E('R2_ACCESS_KEY_ID').length + ' characters; R2 Access Key IDs are 32.');
  if (E('R2_SECRET_ACCESS_KEY') && E('R2_SECRET_ACCESS_KEY').length !== 64) out.push('R2_SECRET_ACCESS_KEY is ' + E('R2_SECRET_ACCESS_KEY').length + ' characters; R2 Secret Access Keys are 64.');
  ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'].forEach(k => {
    const raw = process.env[k] || ''; if (raw !== raw.trim()) out.push(k + ' has spaces / line breaks around it (ignored now, but worth cleaning in Vercel).');
  });
  return { bucket: E('R2_BUCKET'), endpoint: host(), problems: out };
}

// ── Local test backend ───────────────────────────────────────────────
const LOCAL = process.env.FOB_LOCAL_STORE;
function lp(key) { return path.join(LOCAL, key); }
function letag(buf) { return '"' + crypto.createHash('md5').update(buf).digest('hex') + '"'; }

// Returns { body:Buffer, etag } or null if missing.
async function getObject(key) {
  if (LOCAL) {
    if (!fs.existsSync(lp(key))) return null;
    const b = fs.readFileSync(lp(key)); return { body: b, etag: letag(b) };
  }
  const r = await client().fetch(objUrl(key), { method: 'GET' });
  if (r.status === 404) return null;
  if (!r.ok) throw await r2Error('GET', key, r);
  return { body: Buffer.from(await r.arrayBuffer()), etag: r.headers.get('etag') };
}

async function headObject(key) {
  if (LOCAL) {
    if (!fs.existsSync(lp(key))) return null;
    const b = fs.readFileSync(lp(key)); return { etag: letag(b), size: b.length };
  }
  const r = await client().fetch(objUrl(key), { method: 'HEAD' });
  if (r.status === 404) return null;
  if (!r.ok) throw await r2Error('HEAD', key, r);
  return { etag: r.headers.get('etag'), size: Number(r.headers.get('content-length') || 0) };
}

// cond: { ifMatch: etag } | { ifNoneMatch: '*' }. Returns true on success, false on precondition failure.
async function putObject(key, body, contentType, cond) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (LOCAL) {
    const exists = fs.existsSync(lp(key));
    if (cond && cond.ifNoneMatch === '*' && exists) return false;
    if (cond && cond.ifMatch && (!exists || letag(fs.readFileSync(lp(key))) !== cond.ifMatch)) return false;
    if (cond && cond.ifMatch && process.env.FOB_LOCAL_FAIL_IFMATCH) return false;   // test: mimic R2 412
    fs.mkdirSync(path.dirname(lp(key)), { recursive: true });
    fs.writeFileSync(lp(key), buf); return true;
  }
  const headers = { 'Content-Type': contentType || 'application/octet-stream' };
  if (cond && cond.ifMatch) headers['If-Match'] = cond.ifMatch;
  if (cond && cond.ifNoneMatch) headers['If-None-Match'] = cond.ifNoneMatch;
  const r = await client().fetch(objUrl(key), { method: 'PUT', headers, body: buf });
  if (r.status === 412) { console.warn('R2 PUT 412', key, JSON.stringify(cond)); return false; }
  if (!r.ok) throw await r2Error('PUT', key, r);
  return true;
}

async function deleteObject(key) {
  if (LOCAL) { if (fs.existsSync(lp(key))) fs.unlinkSync(lp(key)); return; }
  const r = await client().fetch(objUrl(key), { method: 'DELETE' });
  if (!r.ok && r.status !== 404) throw await r2Error('DELETE', key, r);
}

function xmlDecode(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
          .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');
}

// Every object under a prefix (recursive): [{ key, size, lastModified }]
async function listObjects(prefix) {
  if (LOCAL) {
    const out = [];
    const walk = (dir, rel) => {
      if (!fs.existsSync(dir)) return;
      fs.readdirSync(dir).forEach(f => {
        const p = path.join(dir, f), k = rel + f;
        const st = fs.statSync(p);
        if (st.isDirectory()) walk(p, k + '/'); else out.push({ key: k, size: st.size, lastModified: st.mtime.toISOString() });
      });
    };
    const base = prefix.endsWith('/') ? prefix : prefix + '/';
    walk(lp(base), base);
    return out;
  }
  const items = []; let token = null;
  do {
    const u = new URL(bucketUrl());
    u.searchParams.set('list-type', '2'); u.searchParams.set('prefix', prefix);
    if (token) u.searchParams.set('continuation-token', token);
    const r = await client().fetch(u.toString());
    if (!r.ok) throw await r2Error('LIST', prefix, r);
    const xml = await r.text();
    (xml.match(/<Contents>[\s\S]*?<\/Contents>/g) || []).forEach(c => {
      const k = c.match(/<Key>([^<]*)<\/Key>/), s = c.match(/<Size>(\d+)<\/Size>/), d = c.match(/<LastModified>([^<]*)<\/LastModified>/);
      if (k) items.push({ key: xmlDecode(k[1]), size: s ? Number(s[1]) : 0, lastModified: d ? d[1] : null });
    });
    const t = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
    token = (/<IsTruncated>true<\/IsTruncated>/.test(xml) && t) ? xmlDecode(t[1]) : null;
  } while (token);
  return items;
}
// Server-side copy inside the bucket (no download/re-upload).
async function copyObject(srcKey, dstKey) {
  if (LOCAL) { fs.mkdirSync(path.dirname(lp(dstKey)), { recursive: true }); fs.copyFileSync(lp(srcKey), lp(dstKey)); return; }
  const src = '/' + E('R2_BUCKET') + '/' + String(srcKey).split('/').map(encodeURIComponent).join('/');
  const r = await client().fetch(objUrl(dstKey), { method: 'PUT', headers: { 'x-amz-copy-source': src } });
  if (!r.ok) throw await r2Error('COPY', srcKey + ' → ' + dstKey, r);
}

async function listKeys(prefix) { return (await listObjects(prefix)).map(o => o.key); }

// Short-lived signed PUT link so the admin page can upload a PDF straight to the private bucket.
async function signedPutUrl(key, ttl) {
  if (LOCAL) return '/__local/' + key.split('/').map(encodeURIComponent).join('/');
  const u = new URL(objUrl(key));
  u.searchParams.set('X-Amz-Expires', String(ttl || 900));
  const signed = await client().sign(new Request(u.toString(), { method: 'PUT' }), { aws: { signQuery: true } });
  return signed.url;
}

async function getJson(key) {
  const o = await getObject(key);
  if (!o) return null;
  return { data: JSON.parse(o.body.toString('utf8')), etag: o.etag };
}
function putJson(key, data, cond) {
  return putObject(key, JSON.stringify(data, null, 2), 'application/json', cond);
}

// Short-lived signed GET link. disposition: 'inline' (view in browser) or 'attachment' (download).
async function signedUrl(key, opts) {
  opts = opts || {};
  const ttl = Math.max(30, Math.min(3600, opts.ttl || 300));
  if (LOCAL) return '/__local/' + key.split('/').map(encodeURIComponent).join('/') + '?ttl=' + ttl + '&disp=' + (opts.disposition || 'inline');
  const u = new URL(objUrl(key));
  u.searchParams.set('X-Amz-Expires', String(ttl));
  if (opts.filename) {
    const fn = String(opts.filename).replace(/[^A-Za-z0-9._ -]/g, '_');
    u.searchParams.set('response-content-disposition', (opts.disposition || 'inline') + '; filename="' + fn + '"');
  }
  if (opts.contentType !== null) u.searchParams.set('response-content-type', opts.contentType || 'application/pdf');
  u.searchParams.set('response-cache-control', 'private, no-store');
  const signed = await client().sign(new Request(u.toString(), { method: 'GET' }), { aws: { signQuery: true } });
  return signed.url;
}

function bareEtag(e) { return String(e || '').replace(/^W\//, '').replace(/"/g, '').trim(); }
function quoteEtag(e) { return '"' + bareEtag(e) + '"'; }
function sameEtag(a, b) { return !!bareEtag(a) && bareEtag(a) === bareEtag(b); }

module.exports = { configReport, bareEtag, quoteEtag, sameEtag, getObject, headObject, putObject, deleteObject, copyObject, listKeys, listObjects, signedPutUrl, getJson, putJson, signedUrl };
