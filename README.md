# 🚀 Printo Launch Portal v3.0

## Quick Start (3 steps)

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
# → Edit .env with your team emails and SMTP credentials

# 3. Run
npm start
# → http://localhost:3000
```

---

## 🔑 Email-Based Login

No passwords. Users simply enter their work email.
- The server checks if the email is registered under a team.
- If yes → they're logged in with their team's tasks.
- If no → "Email not authorised. Contact your admin."

**Admin adds/removes emails** via the Admin Panel in the portal.

---

## 📧 R&D Notifications (Fixed)

| R&D Selection | Who gets notified |
|---|---|
| ✅ Yes — Material Received | **Production Team** (to start sample prep) |
| ⏳ No — Awaiting | **Procurement Team** (to follow up with vendor) |

---

## ⚙️ Admin Panel Features

- **Add/remove team email access** — grant any email to any team
- **Reset individual tasks** — reopen a specific task without full reset
- **Full reset** — clear all data for a new launch cycle
- **Email log** — see all sent notifications

---

## 🔧 .env Configuration

```env
ADMIN_EMAIL=admin@printo.in
CATEGORY_EMAIL=rahul@printo.in,priya@printo.in
PROCUREMENT_EMAIL=procurement@printo.in
PRODUCTION_EMAIL=production@printo.in
COMMERCIAL_EMAIL=commercial@printo.in
INVENTORY_EMAIL=inventory@printo.in
SKU_EMAIL=gayathri@printo.in

SMTP_USER=your@gmail.com
SMTP_PASS=your_16char_app_password
```

Multiple emails per team: comma-separated.
Admin can also add emails live via the Admin Panel (stored in `data/users.json`).

---

## 🎨 Theme

**"Deep Space Glass"** — Custom dark theme built with pure CSS:
- Background: Deep navy `#040810` with subtle indigo radial gradient
- Cards: Glassmorphism (`rgba(255,255,255,0.04)` + `backdrop-filter: blur`)
- Primary: Indigo `#6366f1` / Electric Blue `#4f6ef7`
- Status: Green `#10b981` (done), Indigo (pending), Slate (locked)
- Typography: System font stack (`-apple-system`, `BlinkMacSystemFont`, `Segoe UI`)
- No external CSS frameworks — 100% custom CSS variables
