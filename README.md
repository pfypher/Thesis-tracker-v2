# Thesis Progress Tracker — Setup Guide

## What you get

| URL | Who uses it |
|---|---|
| `checkin.yourdomain.com` | Students — the 6-step check-in form |
| `checkin.yourdomain.com/dashboard` | You — password-protected supervisor dashboard |

---

## Step 1 — Set up email sending (Resend)

Resend sends all emails (reminders, notifications, confirmations). Free tier: 3,000 emails/month.

1. Go to **https://resend.com** and create a free account
2. Click **Domains** → **Add domain** → enter your domain (e.g. `yourdomain.com`)
3. Resend will give you DNS records to add. In your domain registrar (e.g. Namecheap, GoDaddy), add those records — usually takes 5–15 minutes to verify
4. Click **API Keys** → **Create API key** → copy it

---

## Step 2 — Deploy to Railway

Railway hosts your Node.js app for free (up to $5/month of usage, which is plenty for this).

1. Go to **https://railway.app** and sign up with GitHub
2. Click **New project** → **Deploy from GitHub repo**
3. Create a new GitHub repo and upload these project files to it
4. Connect the repo in Railway — it detects Node.js automatically and starts deploying

**Set your environment variables in Railway:**

Click your project → **Variables** → add each of these:

```
RESEND_API_KEY        re_your_key_here
SUPERVISOR_EMAIL      you@youruniversity.ac.uk
SUPERVISOR_NAME       Dr Smith
FROM_EMAIL            thesis@yourdomain.com
APP_URL               https://checkin.yourdomain.com
DASHBOARD_PASSWORD    choose-a-strong-password
```

Railway redeploys automatically when you save variables.

---

## Step 3 — Point your subdomain at Railway

**In Railway:**
1. Click your project → **Settings** → **Domains**
2. Click **Add custom domain** → type `checkin.yourdomain.com`
3. Railway shows you a CNAME target (e.g. `xyz.up.railway.app`)

**In your domain registrar:**
1. Add a new DNS record:
   - Type: `CNAME`
   - Name: `checkin`
   - Value: the target Railway gave you
2. Save — DNS propagates in 5–30 minutes

Visit `https://checkin.yourdomain.com` to confirm it's working.

---

## Step 4 — Embed in WordPress

### Option A — Link to it (simplest)
On any WordPress page, add a button linking to `https://checkin.yourdomain.com`.

### Option B — Embed the form in a page (seamless)
1. In WordPress, create or edit a page
2. Add a **Custom HTML** block
3. Paste this:

```html
<iframe
  src="https://checkin.yourdomain.com"
  width="100%"
  height="950"
  frameborder="0"
  style="border:none; border-radius:12px;">
</iframe>
```

4. Publish. The form appears directly in your WordPress page.

### Dashboard
Bookmark `https://checkin.yourdomain.com/dashboard` for yourself — it's password-protected and separate from the student form.

---

## Fortnightly reminders

The cron job runs every Monday at 9am and sends reminder emails to all registered students on alternate weeks. No action needed from you.

To change the schedule, edit this line in `server.js`:
```js
new CronJob('0 9 * * 1', ...)   // every Monday 9am
// alternatives:
// '0 9 1,15 * *'  →  1st and 15th of each month
// '0 9 * * 5'     →  every Friday 9am
```

---

## Files in this project

```
server.js          Backend — API, emails, cron job, auth
public/
  checkin.html     Student check-in form  →  /
  dashboard.html   Supervisor dashboard   →  /dashboard
  login.html       Dashboard login        →  /dashboard (unauthenticated)
package.json       Dependencies
railway.toml       Railway deployment config
.env.example       Environment variable template
```
