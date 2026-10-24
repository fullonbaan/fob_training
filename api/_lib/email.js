// api/_lib/email.js — sends emails from the SERVER through EmailJS's REST API, using TWO accounts:
//
// 1. MEMBER ACCESS emails (access code + library link, new-code emails) — the new EmailJS account:
//      EMAILJS_SERVICE_ID (service_929have), EMAILJS_PUBLIC_KEY, EMAILJS_PRIVATE_KEY, EMAILJS_MEMBER_TEMPLATE
//      Template FOB_Member_Access: To = {{to_email}}, Subject = {{subject}}, Reply-To = {{reply_to}},
//      Content (HTML mode) = {{{html_body}}}
// 2. ALL OTHER notifications (tax-invoice / order confirmation to the customer, new-order alert,
//    payment-failed and checkout-closed alerts to you) — the ORIGINAL EmailJS account, exactly as before:
//      service_2qtgzr5 · public key 3U-YZo2UCV_RG5Gjo · templates FOB_Razorpay_Success / FOB_Razorpay_Failure
//      Override with EMAILJS_NOTIFY_SERVICE_ID / EMAILJS_NOTIFY_PUBLIC_KEY. If that account has
//      "Use Private Key" switched on, also set EMAILJS_NOTIFY_PRIVATE_KEY (that account's private key).
const fs = require('fs');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function post(body) {
  const r = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  if (!r.ok) return { ok: false, status: r.status, text: (await r.text()).slice(0, 200) };
  return { ok: true };
}

// Generic HTML email through the member template.
async function sendMail(to, subject, html, text) {
  if (process.env.FOB_EMAIL_LOG) {           // offline testing
    fs.appendFileSync(process.env.FOB_EMAIL_LOG, JSON.stringify({ kind: 'html', to, subject, text, html }) + '\n');
    return true;
  }
  const svc = process.env.EMAILJS_SERVICE_ID, pub = process.env.EMAILJS_PUBLIC_KEY,
        priv = process.env.EMAILJS_PRIVATE_KEY, tpl = process.env.EMAILJS_MEMBER_TEMPLATE;
  if (!svc || !pub || !priv || !tpl) { console.error('EmailJS env not configured — email to', to, 'not sent'); return false; }
  const r = await post({
    service_id: svc, template_id: tpl, user_id: pub, accessToken: priv,
    template_params: { to_email: to, subject, html_body: html, text_body: text, reply_to: 'support@fullonbaan.com' }
  });
  if (!r.ok) console.error('EmailJS send failed', r.status, r.text);
  return r.ok;
}

// Send with one of your existing EmailJS templates (e.g. FOB_Razorpay_Success) from the SERVER.
async function sendTemplate(templateId, params) {
  if (process.env.FOB_EMAIL_LOG) {
    if (process.env.FOB_EMAIL_TEMPLATE_FAIL) return false;              // test: template missing
    fs.appendFileSync(process.env.FOB_EMAIL_LOG, JSON.stringify({ kind: 'template', template: templateId, to: params.to_email, subject: params.subject, params }) + '\n');
    return true;
  }
  // The ORIGINAL notification account (not the member-access account).
  const svc = process.env.EMAILJS_NOTIFY_SERVICE_ID || 'service_2qtgzr5';
  const pub = process.env.EMAILJS_NOTIFY_PUBLIC_KEY || '3U-YZo2UCV_RG5Gjo';
  const priv = process.env.EMAILJS_NOTIFY_PRIVATE_KEY;
  const body = { service_id: svc, template_id: templateId, user_id: pub, template_params: params };
  if (priv) body.accessToken = priv;
  const r = await post(body);
  if (!r.ok) console.error('EmailJS template send failed', templateId, r.status, r.text);
  return r.ok;
}

// Send through the original account's template. Only if that send fails (template missing, account
// locked, quota) fall back to our own HTML through the member template, so the email still goes out.
async function sendTemplateOrHtml(templateId, params, fallbackTitle, fallbackRows, fallbackNote) {
  if (await sendTemplate(templateId, params)) return true;
  console.warn('Notification template', templateId, 'failed on the original EmailJS account — sending the HTML fallback to', params.to_email);
  const html = shell(fallbackTitle, '<p>' + esc(params.message || '') + '</p>' + rows(fallbackRows) + (fallbackNote || ''), true);
  return sendMail(params.to_email, params.subject, html, params.subject + '\n\n' + (params.message || ''));
}

function shell(title, inner, plainFooter) {
  return '<div style="background:#eef1f6;padding:28px 12px;font-family:Arial,Helvetica,sans-serif;">' +
    '<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #dde3ec;border-radius:12px;overflow:hidden;">' +
    '<div style="background:#06132a;padding:20px 28px;"><span style="color:#f6bc68;font-family:Georgia,serif;font-size:20px;font-weight:bold;">FullOnBaan</span>' +
    '<span style="color:#ba8738;font-size:12px;letter-spacing:2px;margin-left:8px;">' + (plainFooter ? 'TRAINING' : 'MEMBERS LIBRARY') + '</span></div>' +
    '<div style="padding:28px;color:#14213d;font-size:15px;line-height:1.6;"><h2 style="font-family:Georgia,serif;margin:0 0 14px;font-size:21px;color:#06132a;">' + esc(title) + '</h2>' + inner + '</div>' +
    '<div style="padding:16px 28px;background:#f5f7fa;color:#6b7686;font-size:12px;line-height:1.5;">' +
    (plainFooter ? '' : 'Your access is personal to you. Downloads are watermarked with your name and email and are logged. ') +
    'Need help? Reply to this email, WhatsApp +91 63605 93122 or write to support@fullonbaan.com.<br>&copy; FullOnBaan, Bangalore · training.fullonbaan.com</div></div></div>';
}
function rows(pairs) {
  if (!pairs || !pairs.length) return '';
  return '<table style="width:100%;border-collapse:collapse;margin:14px 0;font-size:14px;">' + pairs.map(p =>
    '<tr><td style="padding:6px 8px;border-bottom:1px solid #eef1f6;color:#6b7686;width:40%;">' + esc(p[0]) + '</td>' +
    '<td style="padding:6px 8px;border-bottom:1px solid #eef1f6;font-weight:bold;">' + esc(p[1]) + '</td></tr>').join('') + '</table>';
}
function codeBox(code) {
  return '<div style="margin:18px 0;padding:16px;border:1px dashed #ba8738;border-radius:10px;background:#fffaf0;text-align:center;">' +
    '<div style="font-size:11px;letter-spacing:2px;color:#6b7686;">YOUR ACCESS CODE</div>' +
    '<div style="font-family:Consolas,Menlo,monospace;font-size:26px;font-weight:bold;letter-spacing:3px;color:#06132a;margin-top:6px;">' + esc(code) + '</div></div>';
}
function button(url, label) {
  return '<p style="margin:22px 0;"><a href="' + esc(url) + '" style="background:#ba8738;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:bold;display:inline-block;">' + esc(label) + '</a></p>';
}
function list(names) { return '<ul style="padding-left:18px;margin:8px 0;">' + names.map(n => '<li>' + esc(n) + '</li>').join('') + '</ul>'; }

// After a purchase that includes eBooks. `code` is present only when a new code was issued.
// o.videoNote → the order also contains video lectures (delivered separately, as before).
function purchaseEmail(o) {
  const loginUrl = o.siteUrl + '/members';
  const subject = o.code ? 'Your FullOnBaan access code — read your eBooks online'
                         : 'New eBooks added to your FullOnBaan library';
  const html = shell(o.code ? 'Welcome, ' + (o.name || 'there') + '!' : 'Your library has been updated',
    '<p>Thank you for your purchase' + (o.orderRef ? ' (order <b>' + esc(o.orderRef) + '</b>)' : '') + '. These eBooks are now in your online library:</p>' +
    list(o.guideNames) +
    (o.code
      ? '<p>Sign in to the Members Library with your email <b>' + esc(o.email) + '</b> and this code:</p>' + codeBox(o.code)
      : '<p>Sign in with your email <b>' + esc(o.email) + '</b> and your existing access code. Forgot it? Use “Email me a new code” on the sign-in page.</p>') +
    button(loginUrl, 'Open my library') +
    (o.videoNote ? '<p style="background:#f5f7fa;border-left:3px solid #ba8738;padding:10px 12px;font-size:14px;">Your order also includes <b>video lectures</b>. Video course access is delivered separately to this email within 24 hours.</p>' : '') +
    '<p style="color:#4a5568;font-size:13px;">Keep this code private. Anyone with it can see your library.</p>');
  const text = subject + '\n\neBooks: ' + o.guideNames.join(', ') + '\n' + (o.code ? 'Access code: ' + o.code + '\n' : '') + 'Sign in: ' + loginUrl +
    (o.videoNote ? '\nVideo course access is delivered separately within 24 hours.' : '');
  return sendMail(o.email, subject, html, text);
}

function newCodeEmail(o) {
  const loginUrl = o.siteUrl + '/members';
  const subject = 'Your new FullOnBaan access code';
  const html = shell('Here is your new access code',
    '<p>A new access code was requested for <b>' + esc(o.email) + '</b>. Your previous code no longer works.</p>' +
    codeBox(o.code) + button(loginUrl, 'Sign in') +
    '<p style="color:#4a5568;font-size:13px;">Didn’t ask for this? You can ignore this email, but your old code has been replaced. Contact support@fullonbaan.com if this keeps happening.</p>');
  return sendMail(o.email, subject, html, subject + '\n\nAccess code: ' + o.code + '\nSign in: ' + loginUrl);
}

module.exports = { sendMail, sendTemplate, sendTemplateOrHtml, purchaseEmail, newCodeEmail, esc, shell };
