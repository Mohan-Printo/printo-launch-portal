require('dotenv').config();
const express = require('express');
const nodemailer = require('nodemailer');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Directories ──────────────────────────────────────────────────────────────
const DATA_DIR    = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
[DATA_DIR, UPLOADS_DIR].forEach(d => fs.existsSync(d) || fs.mkdirSync(d, { recursive: true }));

const STATE_FILE    = path.join(DATA_DIR, 'state.json');
const EMAIL_LOG     = path.join(DATA_DIR, 'email_log.json');
const USERS_FILE    = path.join(DATA_DIR, 'users.json');
const PASSWORDS_FILE = path.join(DATA_DIR, 'passwords.json');
const TOKENS_FILE   = path.join(DATA_DIR, 'reset_tokens.json');

// ─── Helpers ──────────────────────────────────────────────────────────────────
const readJSON  = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return typeof fallback === 'function' ? fallback() : fallback; } };
const writeJSON = (file, data)     => fs.writeFileSync(file, JSON.stringify(data, null, 2));

// ─── Password Helpers ─────────────────────────────────────────────────────────
function hashPassword(password, salt) {
  if (!salt) salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return { hash, salt };
}
function verifyPassword(password, storedHash, storedSalt) {
  const { hash } = hashPassword(password, storedSalt);
  return hash === storedHash;
}

// ─── Default state ────────────────────────────────────────────────────────────
const makeState = () => ({
  productName: '', launchId: crypto.randomBytes(4).toString('hex').toUpperCase(),
  createdAt: new Date().toISOString(),
  vendorCheckResult: null, vendorPath: null, rdReceived: null,
  inventoryDecision: null, inventoryRejectionReason: '',
  tasks: {
    product_info:            { status: 'pending', team: 'category',    label: 'Product Information',         completedBy: null, completedAt: null, data: {} },
    vendor_check:            { status: 'locked',  team: 'category',    label: 'Vendor Check',                completedBy: null, completedAt: null, data: {} },
    vendor_path:             { status: 'locked',  team: 'category',    label: 'Sourcing Path Decision',      completedBy: null, completedAt: null, data: {} },
    procurement_vendor:      { status: 'locked',  team: 'procurement', label: 'Vendor Identification',       completedBy: null, completedAt: null, data: {} },
    vendor_onboarding:       { status: 'locked',  team: 'procurement', label: 'Vendor Onboarding',           completedBy: null, completedAt: null, data: {} },
    rd_process:              { status: 'locked',  team: 'category',    label: 'R&D Process',                 completedBy: null, completedAt: null, data: {} },
    sample_prep:             { status: 'locked',  team: 'production',  label: 'Sample Preparation',          completedBy: null, completedAt: null, data: {} },
    inventory_form:          { status: 'locked',  team: 'category',    label: 'Inventory Form',              completedBy: null, completedAt: null, data: {} },
    inventory_approval:      { status: 'locked',  team: 'commercial',  label: 'Inventory Approval',          completedBy: null, completedAt: null, data: {} },
    po_confirmation:         { status: 'locked',  team: 'procurement', label: 'Purchase Order Confirmation', completedBy: null, completedAt: null, data: {} },
    sku_update:              { status: 'locked',  team: 'sku',         label: 'SKU Update & Verification',   completedBy: null, completedAt: null, data: {} },
    website_content:         { status: 'locked',  team: 'commercial',  label: 'Website Content',             completedBy: null, completedAt: null, data: {} },
    material_dispatch:       { status: 'locked',  team: 'inventory',   label: 'Material Dispatch',           completedBy: null, completedAt: null, data: {} },
    material_received_update:{ status: 'locked',  team: 'sku',         label: 'Material Received Update',    completedBy: null, completedAt: null, data: {} },
    hub_briefing:            { status: 'locked',  team: 'inventory',   label: 'Hub Briefing',                completedBy: null, completedAt: null, data: {} },
    stock_dispatch:          { status: 'locked',  team: 'inventory',   label: 'Stock Dispatch',              completedBy: null, completedAt: null, data: {} },
    marketing_collateral:    { status: 'locked',  team: 'inventory',   label: 'Marketing Collateral',        completedBy: null, completedAt: null, data: {} },
    express_delivery:        { status: 'locked',  team: 'category',    label: 'Express Delivery Setup',      completedBy: null, completedAt: null, data: {} },
    sales_briefing:          { status: 'locked',  team: 'category',    label: 'Sales Team Briefing',         completedBy: null, completedAt: null, data: {} },
    release_notes:           { status: 'locked',  team: 'category',    label: 'Release Notes',               completedBy: null, completedAt: null, data: {} },
  }
});

// ─── Default users (from .env) ─────────────────────────────────────────────────
const makeUsers = () => ({
  admin:       (process.env.ADMIN_EMAIL       || '').split(',').map(e=>e.trim()).filter(Boolean),
  category:    (process.env.CATEGORY_EMAIL    || '').split(',').map(e=>e.trim()).filter(Boolean),
  procurement: (process.env.PROCUREMENT_EMAIL || '').split(',').map(e=>e.trim()).filter(Boolean),
  production:  (process.env.PRODUCTION_EMAIL  || '').split(',').map(e=>e.trim()).filter(Boolean),
  commercial:  (process.env.COMMERCIAL_EMAIL  || '').split(',').map(e=>e.trim()).filter(Boolean),
  inventory:   (process.env.INVENTORY_EMAIL   || '').split(',').map(e=>e.trim()).filter(Boolean),
  sku:         (process.env.SKU_EMAIL         || '').split(',').map(e=>e.trim()).filter(Boolean),
});

// ─── State Machine ─────────────────────────────────────────────────────────────
function recalculate(state) {
  const t  = state.tasks;
  const done   = id => t[id]?.status === 'done';
  const unlock = id => { if (t[id]?.status === 'locked') t[id].status = 'pending'; };

  if (done('product_info'))        unlock('vendor_check');
  if (done('vendor_check')) {
    if (state.vendorCheckResult === 'can_supply')     { unlock('rd_process'); }
    if (state.vendorCheckResult === 'cannot_supply')  { unlock('vendor_path'); }
  }
  if (done('vendor_path')) {
    if (state.vendorPath === 'category')    unlock('rd_process');
    if (state.vendorPath === 'procurement') unlock('procurement_vendor');
  }
  if (done('procurement_vendor'))          unlock('vendor_onboarding');
  if (done('vendor_onboarding'))           unlock('rd_process');
  if (done('rd_process') && state.rdReceived === 'yes') unlock('sample_prep');
  if (done('sample_prep')) { unlock('inventory_form'); unlock('express_delivery'); }
  if (done('inventory_form'))              unlock('inventory_approval');
  if (done('inventory_approval')) {
    if (state.inventoryDecision === 'approved')  { unlock('po_confirmation'); unlock('website_content'); }
    if (state.inventoryDecision === 'rejected')  {
      if (t['inventory_form'].status === 'done') t['inventory_form'].status = 'pending';
      t['inventory_form'].completedBy = null; t['inventory_form'].completedAt = null;
      if (t['inventory_approval'].status === 'done') t['inventory_approval'].status = 'pending';
      state.inventoryDecision = null;
    }
  }
  if (done('po_confirmation'))    { unlock('sku_update'); unlock('material_dispatch'); }
  if (done('material_dispatch'))           unlock('material_received_update');
  if (done('material_received_update'))    unlock('hub_briefing');
  if (done('hub_briefing'))                unlock('stock_dispatch');
  if (done('stock_dispatch'))              unlock('marketing_collateral');
  if (done('marketing_collateral'))        unlock('sales_briefing');
  if (done('sales_briefing'))              unlock('release_notes');
  return state;
}

// ─── Email ─────────────────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST   || 'smtp.gmail.com',
  port:   parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_SECURE === 'true',
  auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

async function sendEmail({ to, subject, html }) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) { console.log('[EMAIL SKIP] SMTP not configured'); return { skipped: true }; }
  const recipients = Array.isArray(to) ? to.filter(Boolean) : [to].filter(Boolean);
  if (!recipients.length) { console.log('[EMAIL SKIP] No recipients'); return { skipped: true }; }
  const info = await transporter.sendMail({
    from: `"Printo Launch Portal" <${process.env.SMTP_USER}>`,
    to: recipients.join(', '), subject, html,
  });
  const log = readJSON(EMAIL_LOG, []); log.push({ to: recipients, subject, sentAt: new Date().toISOString(), messageId: info.messageId });
  writeJSON(EMAIL_LOG, log); return info;
}

// ─── Multer ────────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => { const d = path.join(UPLOADS_DIR, req.params.taskId||'misc'); fs.mkdirSync(d,{recursive:true}); cb(null,d); },
  filename:    (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage, limits: { fileSize: 20*1024*1024 } });

// ─── Email Templates ───────────────────────────────────────────────────────────
const emailTpl = (product, body) => `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0d1117;color:#e2e8f0;padding:24px;border-radius:12px;">
  <div style="background:linear-gradient(135deg,#4f6ef7,#6366f1);padding:16px 24px;border-radius:8px;margin-bottom:24px;">
    <h2 style="margin:0;color:white;">Printo Launch Portal</h2>
    <p style="margin:4px 0 0;color:rgba(255,255,255,.8);font-size:14px;">Product: <strong>${product}</strong></p>
  </div>
  ${body}
  <p style="color:#475569;font-size:12px;margin-top:24px;border-top:1px solid #1e2a3a;padding-top:16px;">Automated notification — Printo Launch Portal</p>
</div>`;

const authEmailTpl = (body) => `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0d1117;color:#e2e8f0;padding:24px;border-radius:12px;">
  <div style="background:linear-gradient(135deg,#4f6ef7,#6366f1);padding:16px 24px;border-radius:8px;margin-bottom:24px;">
    <h2 style="margin:0;color:white;">Printo Launch Portal</h2>
    <p style="margin:4px 0 0;color:rgba(255,255,255,.8);font-size:14px;">Account Security</p>
  </div>
  ${body}
  <p style="color:#475569;font-size:12px;margin-top:24px;border-top:1px solid #1e2a3a;padding-top:16px;">If you did not request this, please contact your admin immediately.</p>
</div>`;

// ─── Routes ────────────────────────────────────────────────────────────────────
app.get('/api/health', (_, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ── Auth: Check if email has password set ──────────────────────────────────────
app.post('/api/auth/check', (req, res) => {
  const email = (req.body.email||'').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'Email required' });
  const users = readJSON(USERS_FILE, makeUsers);
  let foundTeam = null;
  for (const [team, emails] of Object.entries(users)) {
    if ((emails||[]).map(e=>e.toLowerCase()).includes(email)) { foundTeam = team; break; }
  }
  if (!foundTeam) return res.status(403).json({ error: 'Email not authorised. Please contact your admin to get access.' });
  const passwords = readJSON(PASSWORDS_FILE, {});
  const hasPassword = !!(passwords[email] && passwords[email].hash);
  res.json({ exists: true, hasPassword, team: foundTeam });
});

// ── Auth: Login ────────────────────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const email    = (req.body.email||'').trim().toLowerCase();
  const password = req.body.password || '';
  if (!email) return res.status(400).json({ error: 'Email required' });
  const users = readJSON(USERS_FILE, makeUsers);
  let foundTeam = null;
  for (const [team, emails] of Object.entries(users)) {
    if ((emails||[]).map(e=>e.toLowerCase()).includes(email)) { foundTeam = team; break; }
  }
  if (!foundTeam) return res.status(403).json({ error: 'Email not authorised. Please contact your admin.' });

  const passwords = readJSON(PASSWORDS_FILE, {});
  const record    = passwords[email];
  if (record && record.hash) {
    if (!password) return res.status(401).json({ error: 'Password required', needsPassword: true });
    if (!verifyPassword(password, record.hash, record.salt))
      return res.status(401).json({ error: 'Incorrect password. Please try again or use Forgot Password.' });
  }
  // No password set OR correct password
  res.json({ success: true, team: foundTeam, email, displayName: email.split('@')[0] });
});

// ── Auth: Forgot Password ──────────────────────────────────────────────────────
app.post('/api/auth/forgot-password', async (req, res) => {
  const email = (req.body.email||'').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'Email required' });

  const users = readJSON(USERS_FILE, makeUsers);
  let found = false;
  for (const emails of Object.values(users)) {
    if ((emails||[]).map(e=>e.toLowerCase()).includes(email)) { found = true; break; }
  }
  // Always return success (don't reveal if email exists or not)
  if (!found) return res.json({ success: true, message: 'If this email is registered, a reset link has been sent.' });

  const token   = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + 60 * 60 * 1000; // 1 hour
  const tokens  = readJSON(TOKENS_FILE, {});
  // Remove any old tokens for this email
  for (const [t, d] of Object.entries(tokens)) { if (d.email === email) delete tokens[t]; }
  tokens[token] = { email, expires };
  writeJSON(TOKENS_FILE, tokens);

  const host    = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
  const resetUrl = `${host}/reset-password.html?token=${token}`;

  const html = authEmailTpl(`
    <p style="font-size:16px;">Hi <strong>${email}</strong>,</p>
    <p>We received a request to reset your Printo Launch Portal password. Click the button below to set a new password:</p>
    <div style="text-align:center;margin:32px 0;">
      <a href="${resetUrl}" style="background:linear-gradient(135deg,#4f6ef7,#6366f1);color:white;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:600;">Reset My Password</a>
    </div>
    <p style="font-size:13px;color:#64748b;">This link expires in 1 hour. If you did not request a password reset, you can safely ignore this email.</p>
    <p style="font-size:12px;color:#475569;">Reset link: <a href="${resetUrl}" style="color:#6366f1;">${resetUrl}</a></p>`);

  try {
    await sendEmail({ to: email, subject: '[Printo Portal] Password Reset Request', html });
  } catch(e) { console.error('[FORGOT PWD EMAIL]', e.message); }

  res.json({ success: true, message: 'If this email is registered, a reset link has been sent.' });
});

// ── Auth: Reset Password (via token) ──────────────────────────────────────────
app.post('/api/auth/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).json({ error: 'Token and new password required' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const tokens = readJSON(TOKENS_FILE, {});
  const record = tokens[token];
  if (!record || Date.now() > record.expires)
    return res.status(400).json({ error: 'Reset link has expired or is invalid. Please request a new one.' });

  const email = record.email;
  const { hash, salt } = hashPassword(newPassword);
  const passwords = readJSON(PASSWORDS_FILE, {});
  passwords[email] = { hash, salt, updatedAt: new Date().toISOString() };
  writeJSON(PASSWORDS_FILE, passwords);

  // Remove used token
  delete tokens[token];
  writeJSON(TOKENS_FILE, tokens);

  // Notify the user
  const userHtml = authEmailTpl(`
    <p>Hi <strong>${email}</strong>,</p>
    <p>Your Printo Launch Portal password has been successfully changed.</p>
    <p style="font-size:13px;color:#64748b;">Changed at: ${new Date().toLocaleString()}</p>`);
  sendEmail({ to: email, subject: '[Printo Portal] Password Changed Successfully', html: userHtml }).catch(()=>{});

  // Notify all admins
  const users = readJSON(USERS_FILE, makeUsers);
  const admins = (users['admin'] || []).filter(Boolean);
  if (admins.length) {
    const adminHtml = authEmailTpl(`
      <p>Hi Admin,</p>
      <p>This is a security notification: user <strong>${email}</strong> has successfully changed their portal password.</p>
      <p style="font-size:13px;color:#64748b;">Changed at: ${new Date().toLocaleString()}</p>
      <p style="font-size:13px;color:#64748b;">If you did not authorise this change, please reset this user's password via the Admin Panel.</p>`);
    sendEmail({ to: admins, subject: `[Printo Portal] Security Alert: ${email} changed their password`, html: adminHtml }).catch(()=>{});
  }

  res.json({ success: true, message: 'Password updated successfully. You can now log in.' });
});

// ── Admin: Set/Reset password for a user ──────────────────────────────────────
app.post('/api/auth/admin/set-password', async (req, res) => {
  const { email, newPassword } = req.body;
  if (!email || !newPassword) return res.status(400).json({ error: 'email and newPassword required' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const { hash, salt } = hashPassword(newPassword);
  const passwords = readJSON(PASSWORDS_FILE, {});
  passwords[email.toLowerCase()] = { hash, salt, updatedAt: new Date().toISOString(), setByAdmin: true };
  writeJSON(PASSWORDS_FILE, passwords);

  // Notify the user
  const userHtml = authEmailTpl(`
    <p>Hi <strong>${email}</strong>,</p>
    <p>An admin has set a new password for your Printo Launch Portal account.</p>
    <p>Please log in and use the password provided to you by your admin. You can change it anytime using "Forgot Password" on the login page.</p>
    <p style="font-size:13px;color:#64748b;">Changed at: ${new Date().toLocaleString()}</p>`);
  sendEmail({ to: email, subject: '[Printo Portal] Your Password Has Been Set by Admin', html: userHtml }).catch(()=>{});

  res.json({ success: true });
});

// ── Admin: Clear password for a user (back to email-only login) ───────────────
app.post('/api/auth/admin/clear-password', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  const passwords = readJSON(PASSWORDS_FILE, {});
  delete passwords[email.toLowerCase()];
  writeJSON(PASSWORDS_FILE, passwords);
  res.json({ success: true });
});

// ── Admin: Check which users have passwords ────────────────────────────────────
app.get('/api/auth/password-status', (_, res) => {
  const passwords = readJSON(PASSWORDS_FILE, {});
  const status = {};
  for (const [email, rec] of Object.entries(passwords)) {
    status[email] = { hasPassword: true, updatedAt: rec.updatedAt, setByAdmin: rec.setByAdmin || false };
  }
  res.json(status);
});

// Users CRUD
app.get('/api/users', (_, res) => res.json(readJSON(USERS_FILE, makeUsers)));

app.post('/api/users', (req, res) => {
  const { email, team } = req.body;
  if (!email || !team) return res.status(400).json({ error: 'email and team required' });
  const valid = ['admin','category','procurement','production','commercial','inventory','sku'];
  if (!valid.includes(team)) return res.status(400).json({ error: 'Invalid team' });
  const users = readJSON(USERS_FILE, makeUsers);
  if (!users[team]) users[team] = [];
  const norm = email.trim().toLowerCase();
  if (!users[team].map(e=>e.toLowerCase()).includes(norm)) users[team].push(norm);
  writeJSON(USERS_FILE, users);
  res.json({ success:true, users });
});

app.delete('/api/users', (req, res) => {
  const { email, team } = req.body;
  const users = readJSON(USERS_FILE, makeUsers);
  if (users[team]) users[team] = users[team].filter(e=>e.toLowerCase()!==email.toLowerCase());
  writeJSON(USERS_FILE, users);
  res.json({ success:true, users });
});

// State
app.get('/api/state', (_, res) => {
  let s = readJSON(STATE_FILE, makeState);
  s = recalculate(s); writeJSON(STATE_FILE, s); res.json(s);
});

app.post('/api/state', (req, res) => {
  let s = readJSON(STATE_FILE, makeState);
  Object.assign(s, req.body); s = recalculate(s); writeJSON(STATE_FILE, s); res.json(s);
});

// Complete task
app.post('/api/task/done', async (req, res) => {
  const { taskId, completedBy, data } = req.body;
  if (!taskId) return res.status(400).json({ error: 'taskId required' });
  let s = readJSON(STATE_FILE, makeState);
  if (!s.tasks[taskId]) return res.status(404).json({ error: 'Task not found' });

  s.tasks[taskId].status      = 'done';
  s.tasks[taskId].completedBy = completedBy || 'unknown';
  s.tasks[taskId].completedAt = new Date().toISOString();
  s.tasks[taskId].data        = { ...s.tasks[taskId].data, ...(data||{}) };

  if (taskId==='vendor_check'    && data?.result)   s.vendorCheckResult         = data.result;
  if (taskId==='vendor_path'     && data?.path)     s.vendorPath                = data.path;
  if (taskId==='rd_process'      && data?.received) s.rdReceived                = data.received;
  if (taskId==='inventory_approval') { s.inventoryDecision = data?.decision; s.inventoryRejectionReason = data?.reason||''; }

  s = recalculate(s); writeJSON(STATE_FILE, s);
  triggerNotifications(taskId, s, data||{}).catch(e=>console.error('[NOTIFY]',e.message));
  res.json(s);
});

// Reset specific task (admin)
app.post('/api/task/reset/:taskId', (req, res) => {
  const { taskId } = req.params;
  let s = readJSON(STATE_FILE, makeState);
  if (!s.tasks[taskId]) return res.status(404).json({ error: 'Task not found' });
  s.tasks[taskId] = { ...s.tasks[taskId], status:'pending', completedBy:null, completedAt:null, data:{} };
  if (taskId==='vendor_check')        { s.vendorCheckResult=null; s.vendorPath=null; }
  if (taskId==='vendor_path')         { s.vendorPath=null; }
  if (taskId==='rd_process')          { s.rdReceived=null; }
  if (taskId==='inventory_approval')  { s.inventoryDecision=null; s.inventoryRejectionReason=''; }
  s = recalculate(s); writeJSON(STATE_FILE, s); res.json(s);
});

// Email log + send
app.get('/api/email/log', (_, res) => res.json(readJSON(EMAIL_LOG, [])));
app.post('/api/email', async (req, res) => {
  try { const r = await sendEmail(req.body); res.json({ success:true, result:r }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Files
app.post('/api/upload/:taskId', upload.array('files',10), (req, res) => {
  res.json({ files: req.files.map(f=>({ name:f.originalname, saved:f.filename, size:f.size })) });
});
app.get('/api/files/:taskId', (req, res) => {
  const dir = path.join(UPLOADS_DIR, req.params.taskId);
  if (!fs.existsSync(dir)) return res.json([]);
  res.json(fs.readdirSync(dir).map(f=>({ name:f, taskId:req.params.taskId })));
});

// Reset all
app.post('/api/reset', (req, res) => {
  const s = makeState(); writeJSON(STATE_FILE, s); writeJSON(EMAIL_LOG, []);
  res.json({ success:true, state:s });
});

// Config
app.get('/api/config', (_, res) => res.json({
  emailConfigured: !!(process.env.SMTP_USER && process.env.SMTP_PASS),
  smtpUser: process.env.SMTP_USER ? process.env.SMTP_USER.replace(/(.{2}).*(@.*)/, '$1***$2') : null,
}));

// ─── Notifications ─────────────────────────────────────────────────────────────
async function triggerNotifications(taskId, state, data) {
  const users = readJSON(USERS_FILE, makeUsers);
  const e = team => (users[team]||[]).filter(Boolean);
  const product = state.productName || 'New Product';
  const b = html => emailTpl(product, `<div style="padding:8px 0;">${html}</div>`);

  const notify = async (to, subject, html) => {
    try { await sendEmail({ to: Array.isArray(to)?to:[to], subject, html }); } catch(err) { console.error('[EMAIL]',err.message); }
  };

  if (taskId==='vendor_path' && data.path==='procurement')
    await notify(e('procurement'), `[Action Required] Vendor Identification Needed — ${product}`,
      b(`<p>Category Team needs Procurement to identify a vendor for <strong>${product}</strong>. Please log in and complete the Vendor Identification task.</p>`));

  if (taskId==='vendor_onboarding')
    await notify(e('commercial'), `[Update] New Vendor Onboarded — ${product}`,
      b(`<p>A new vendor has been onboarded for <strong>${product}</strong>. Please review and proceed with your tasks.</p>`));

  if (taskId==='rd_process') {
    if (data.received==='yes')
      await notify(e('production'), `[Action Required] R&D Material Received — ${product}`,
        b(`<p>R&D material for <strong>${product}</strong> has been received. Please proceed with Sample Preparation.</p>`));
    if (data.received==='no')
      await notify(e('procurement'), `[Alert] R&D Material Not Received — ${product}`,
        b(`<p>R&D material for <strong>${product}</strong> has NOT been received. Please follow up with the vendor to arrange delivery immediately.</p>`));
  }

  if (taskId==='sample_prep')
    await notify([...e('category'), ...e('commercial')], `[Update] Sample Ready — ${product}`,
      b(`<p>Sample for <strong>${product}</strong> is ready. <br>Category Team: please submit the Inventory Form.<br>Commercial Team: please prepare for Inventory Approval.</p>`));

  if (taskId==='inventory_form')
    await notify(e('commercial'), `[Action Required] Inventory Form Submitted — ${product}`,
      b(`<p>The inventory form for <strong>${product}</strong> has been submitted. Please log in to Approve or Reject.</p>`));

  if (taskId==='inventory_approval') {
    if (data.decision==='approved')
      await notify([...e('procurement'), ...e('category')], `[Approved] Inventory Approved — ${product}`,
        b(`<p>Inventory for <strong>${product}</strong> has been APPROVED.<br>Procurement: please raise a Purchase Order.<br>Category: please proceed with next steps.</p>`));
    else
      await notify(e('category'), `[Rejected] Inventory Rejected — ${product}`,
        b(`<p>Inventory for <strong>${product}</strong> has been REJECTED.</p><p><strong>Reason:</strong> ${data.reason||'No reason given'}</p><p>Please review and resubmit the inventory form.</p>`));
  }

  if (taskId==='po_confirmation')
    await notify(e('sku'), `[Action Required] PO Raised — SKU Update Needed — ${product}`,
      b(`<p>A Purchase Order has been raised for <strong>${product}</strong>. Please update the SKU accordingly in the portal.</p>`));

  if (taskId==='sku_update' && data.doubt)
    await notify(e('category'), `[Query] SKU Doubt Raised — ${product}`,
      b(`<p>Gayathri has raised a doubt about SKU for <strong>${product}</strong>:<br><em>"${data.doubt}"</em></p><p>Please log in and clarify.</p>`));

  const coreTasks = ['product_info','rd_process','sample_prep','inventory_form','inventory_approval',
    'po_confirmation','sku_update','material_dispatch','hub_briefing','stock_dispatch','marketing_collateral','sales_briefing','release_notes'];
  if (coreTasks.every(id => state.tasks[id]?.status==='done')) {
    const allEmails = Object.values(users).flat().filter(Boolean);
    await notify(allEmails, `Launch Complete! — ${product}`,
      b(`<p>All tasks for <strong>${product}</strong> have been completed! The product is ready to launch.</p>`));
  }
}

// ─── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  if (!fs.existsSync(STATE_FILE))  writeJSON(STATE_FILE,  makeState());
  if (!fs.existsSync(EMAIL_LOG))   writeJSON(EMAIL_LOG,   []);
  if (!fs.existsSync(USERS_FILE))  writeJSON(USERS_FILE,  makeUsers());
  if (!fs.existsSync(PASSWORDS_FILE)) writeJSON(PASSWORDS_FILE, {});
  if (!fs.existsSync(TOKENS_FILE))    writeJSON(TOKENS_FILE, {});
  console.log('\nPrinto Launch Portal -> http://localhost:' + PORT);
  console.log('   Email  : ' + (process.env.SMTP_USER ? 'OK: ' + process.env.SMTP_USER : 'NOT configured'));
  console.log('   Admin  : ' + (process.env.ADMIN_EMAIL || 'Set ADMIN_EMAIL in .env') + '\n');
});
