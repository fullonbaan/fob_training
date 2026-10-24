const path = require('path'), fs = require('fs'), os = require('os');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'fobt-'));
Object.assign(process.env, {
  TRAINING_DIR: path.resolve(__dirname, '..'),
  FOB_LOCAL_STORE: path.join(T, 'r2'), FOB_GH_LOCAL: path.join(T, 'gh'), FOB_EMAIL_LOG: path.join(T, 'mail.log'),
  FOB_RZP_MOCK: path.join(__dirname, 'mockrzp.js'),
  RAZORPAY_KEY_ID: 'rzp_test_KEY', RAZORPAY_KEY_SECRET: 'test_secret_abc', RAZORPAY_WEBHOOK_SECRET: 'whsec_test_123',
  MEMBER_SESSION_SECRET: 'x'.repeat(48), ADMIN_API_TOKEN: 'A'.repeat(20) + 'dminTokenForTests1234567890', ADMIN_PASSWORD: 'pw-test',
  SITE_URL: 'https://training.fullonbaan.com', FOB_LOCK_POLL_MS: '50'
});
fs.mkdirSync(process.env.FOB_LOCAL_STORE, { recursive: true }); fs.mkdirSync(process.env.FOB_GH_LOCAL, { recursive: true });
module.exports = { T };
