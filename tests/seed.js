// Puts sample eBooks into the local "bucket".
const { PDFDocument, StandardFonts } = require('pdf-lib');
const fs = require('fs'), path = require('path');
async function pdf(title, pages) {
  const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.HelveticaBold);
  for (let i = 0; i < (pages || 2); i++) { const p = d.addPage([595, 842]); p.drawText(title + ' — page ' + (i + 1), { x: 50, y: 760, size: 20, font: f }); }
  return Buffer.from(await d.save());
}
module.exports = async function seed(store) {
  const put = (k, b) => { const p = path.join(store, k); if (k.endsWith('/')) return fs.mkdirSync(p, { recursive: true }); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, b); };
  put('ebooks/dev/01 - Sessions & 4GL.pdf', await pdf('Sessions', 3));
  put('ebooks/dev/02 - DAL Scripts.pdf', await pdf('DAL', 2));
  put('ebooks/dev/_draft next.pdf', await pdf('Draft', 1));
  put('ebooks/fin/General Ledger.pdf', await pdf('GL', 2));
  put('ebooks/cloud/01 - Cloud Strategy.pdf', await pdf('Cloud', 2));
  put('ebooks/cloud/02 - Migration Planner.xlsx', Buffer.from('PK\u0003\u0004fake-xlsx'));
  put('ebooks/os.pdf', await pdf('OS single', 1));         // single-file layout
  // Kit organised in section sub-folders (exactly like the live ebooks/dev/ layout)
  put('ebooks/lnapi/Training EBooks/01 - API Basics.pdf', await pdf('API Basics', 2));
  put('ebooks/lnapi/Training EBooks/02 - BDE Calls.pdf', await pdf('BDE', 2));
  put('ebooks/lnapi/10.8 Version Docs/LN 10.8 Release Notes.pdf', await pdf('Release', 1));
  put('ebooks/lnapi/DAL Examples/dal_hook_example.txt', Buffer.from('function extern long before.save.object()\n'));
  put('ebooks/lnapi/Script Examples/Batch/02_batch_job.bc', Buffer.from('|* sample 4GL'));
  put('ebooks/lnapi/Script Examples/01_report_script.bc', Buffer.from('|* sample'));
  put('ebooks/lnapi/Training Notes/', Buffer.alloc(0));                       // folder marker made by the dashboard
  put('ebooks/lnapi/Training Notes/Thumbs.db', Buffer.from('junk'));
  put('ebooks/lnapi/_thumbs/old.jpg', Buffer.from('x'));
  put('ebooks/lnapi/_Drafts/secret.pdf', await pdf('Draft', 1));
  put('ebooks/zzz/ignored.pdf', await pdf('x', 1));        // unknown folder → ignored
};
