import express from 'express';
import { Resend } from 'resend';
import { CronJob } from 'cron';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const resend = new Resend(process.env.RESEND_API_KEY);
const db = new Database(process.env.DATABASE_URL || 'thesis.db');

// ── Config ───────────────────────────────────────────────────────────────────
const SUPERVISOR_EMAIL    = process.env.SUPERVISOR_EMAIL;
const SUPERVISOR_NAME     = process.env.SUPERVISOR_NAME  || 'Supervisor';
const FROM_EMAIL          = process.env.FROM_EMAIL       || 'thesis@yourdomain.com';
const APP_URL             = process.env.APP_URL          || 'http://localhost:3000';
const DASHBOARD_PASSWORD  = process.env.DASHBOARD_PASSWORD || 'changeme';

// ── Database setup ────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS students (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL,
    email     TEXT NOT NULL UNIQUE,
    thesis    TEXT,
    enrolled  TEXT DEFAULT (date('now'))
  );

  CREATE TABLE IF NOT EXISTS checkins (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    student_email TEXT NOT NULL,
    student_name  TEXT NOT NULL,
    anxiety       INTEGER,
    mood          TEXT,
    hours         REAL,
    progress      TEXT,
    excitement    TEXT,
    challenges    TEXT,
    blockers      TEXT,
    support       TEXT,
    other         TEXT,
    tasks_next    TEXT,
    tasks_prev    TEXT,
    submitted_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS profiles (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    student_email     TEXT NOT NULL UNIQUE,
    student_name      TEXT NOT NULL,
    thesis_title      TEXT,
    research_question TEXT,
    field             TEXT,
    chapters          TEXT,
    deadline          TEXT,
    milestones        TEXT,
    current_stage     TEXT,
    timeline_concerns TEXT,
    submitted_at      TEXT DEFAULT (datetime('now'))
  );
`);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Dashboard auth middleware ─────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.headers.cookie?.includes('dash_auth=1')) return next();
  if (req.path === '/login' && req.method === 'POST') return next();
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Student check-in form → /
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'checkin.html'));
});


// Thesis context profile → /profile
app.get('/profile', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'profile.html'));
});

// ── API: Save context profile ─────────────────────────────────────────────────
app.post('/api/profiles', async (req, res) => {
  const { name, email, thesis, researchQuestion, field, chapters,
          deadline, milestones, currentStage, timelineConcerns } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });

  db.prepare(`INSERT OR IGNORE INTO students (name, email, thesis) VALUES (?, ?, ?)`)
    .run(name || 'Unknown', email, thesis || '');

  db.prepare(`
    INSERT INTO profiles
      (student_email, student_name, thesis_title, research_question, field,
       chapters, deadline, milestones, current_stage, timeline_concerns)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(student_email) DO UPDATE SET
      student_name=excluded.student_name,
      thesis_title=excluded.thesis_title,
      research_question=excluded.research_question,
      field=excluded.field,
      chapters=excluded.chapters,
      deadline=excluded.deadline,
      milestones=excluded.milestones,
      current_stage=excluded.current_stage,
      timeline_concerns=excluded.timeline_concerns,
      submitted_at=datetime('now')
  `).run(email, name, thesis, researchQuestion, field,
         JSON.stringify(chapters||[]), deadline,
         JSON.stringify(milestones||[]), currentStage, timelineConcerns);

  try {
    await resend.emails.send({
      from: FROM_EMAIL, to: SUPERVISOR_EMAIL,
      subject: `Context profile submitted — ${name}`,
      html: profileEmail({ name, email, thesis, researchQuestion, field,
        chapters: chapters||[], deadline, currentStage, timelineConcerns,
        dashUrl: `${APP_URL}/dashboard` }),
    });
  } catch(err) { console.error('Profile email error:', err); }

  res.json({ ok: true });
});

// Supervisor dashboard → /dashboard
app.get('/dashboard', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Dashboard login POST
app.post('/dashboard/login', (req, res) => {
  if (req.body.password === DASHBOARD_PASSWORD) {
    res.setHeader('Set-Cookie', 'dash_auth=1; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400');
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Incorrect password' });
  }
});

// Dashboard logout
app.get('/dashboard/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'dash_auth=0; Path=/; Max-Age=0');
  res.redirect('/dashboard');
});

// ── API: Register student ─────────────────────────────────────────────────────
app.post('/api/students', async (req, res) => {
  const { name, email, thesis } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'name and email required' });
  try {
    db.prepare(`INSERT OR IGNORE INTO students (name, email, thesis) VALUES (?, ?, ?)`)
      .run(name, email, thesis || '');
    await resend.emails.send({
      from: FROM_EMAIL, to: email,
      subject: 'Welcome to the thesis check-in system',
      html: welcomeEmail({ name, supervisorName: SUPERVISOR_NAME, appUrl: APP_URL }),
    });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── API: Get previous tasks for a student ─────────────────────────────────────
app.get('/api/students/:email/prev-tasks', (req, res) => {
  const row = db.prepare(`
    SELECT tasks_next FROM checkins
    WHERE student_email = ? ORDER BY submitted_at DESC LIMIT 1
  `).get(req.params.email);
  res.json({ tasks: row ? JSON.parse(row.tasks_next || '[]') : [] });
});

// ── API: Submit check-in ──────────────────────────────────────────────────────
app.post('/api/checkins', async (req, res) => {
  const { name, email, thesis, anxiety, mood, hours, progress, excitement,
          challenges, blockers, support, other, tasksNext, tasksPrev } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });

  db.prepare(`INSERT OR IGNORE INTO students (name, email, thesis) VALUES (?, ?, ?)`)
    .run(name || 'Unknown', email, thesis || '');

  db.prepare(`
    INSERT INTO checkins (student_email, student_name, anxiety, mood, hours,
      progress, excitement, challenges, blockers, support, other, tasks_next, tasks_prev)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(email, name, anxiety, mood, hours, progress, excitement,
         challenges, blockers, support, other,
         JSON.stringify(tasksNext || []), JSON.stringify(tasksPrev || []));

  const history = db.prepare(`
    SELECT anxiety, submitted_at FROM checkins
    WHERE student_email = ? ORDER BY submitted_at DESC LIMIT 5
  `).all(email);

  try {
    await resend.emails.send({
      from: FROM_EMAIL, to: SUPERVISOR_EMAIL,
      subject: `Check-in submitted — ${name}`,
      html: supervisorEmail({ name, email, anxiety, mood, hours, progress, excitement,
        challenges, blockers, support, other,
        tasksNext: tasksNext || [], tasksPrev: tasksPrev || [],
        history, dashUrl: `${APP_URL}/dashboard` }),
    });
    await resend.emails.send({
      from: FROM_EMAIL, to: email,
      subject: 'Your check-in has been received',
      html: confirmationEmail({ name, anxiety, tasksNext: tasksNext || [], supervisorName: SUPERVISOR_NAME }),
    });
  } catch (err) { console.error('Email error:', err); }

  res.json({ ok: true });
});

// ── API: Dashboard data (auth protected) ─────────────────────────────────────
app.get('/api/dashboard', requireAuth, (req, res) => {
  const students = db.prepare(`SELECT * FROM students`).all();
  const data = students.map(s => ({
    ...s,
    profile: db.prepare(`SELECT * FROM profiles WHERE student_email = ?`).get(s.email) || null,
    checkins: db.prepare(`
      SELECT id, anxiety, mood, submitted_at, hours, progress, excitement,
             challenges, blockers, support, tasks_next, tasks_prev
      FROM checkins WHERE student_email = ? ORDER BY submitted_at ASC
    `).all(s.email)
  }));
  res.json(data);
});


// ── API: Delete student ───────────────────────────────────────────────────────
app.delete('/api/students/:email', requireAuth, (req, res) => {
  const email = req.params.email;
  db.prepare(`DELETE FROM checkins WHERE student_email = ?`).run(email);
  db.prepare(`DELETE FROM profiles WHERE student_email = ?`).run(email);
  db.prepare(`DELETE FROM students WHERE email = ?`).run(email);
  res.json({ ok: true });
});

// ── API: Delete check-in ──────────────────────────────────────────────────────
app.delete('/api/checkins/:id', requireAuth, (req, res) => {
  db.prepare(`DELETE FROM checkins WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// ── Cron: Fortnightly reminders ───────────────────────────────────────────────
new CronJob('0 9 * * 1', async () => {
  const weekNum = Math.floor(Date.now() / (1000 * 60 * 60 * 24 * 7));
  if (weekNum % 2 !== 0) return;
  console.log('Sending fortnightly reminders...');
  for (const s of db.prepare(`SELECT * FROM students`).all()) {
    try {
      await resend.emails.send({
        from: FROM_EMAIL, to: s.email,
        subject: 'Time for your fortnightly thesis check-in',
        html: reminderEmail({ name: s.name, appUrl: APP_URL, supervisorName: SUPERVISOR_NAME }),
      });
    } catch (err) { console.error(`Reminder failed for ${s.email}:`, err); }
  }
}, null, true);

// ── Email templates ───────────────────────────────────────────────────────────
function emailWrap(body) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f5f4f0;font-family:system-ui,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 20px;">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;">
<tr><td style="background:#534AB7;padding:24px 32px;"><span style="color:#fff;font-size:16px;font-weight:500;">Thesis progress tracker</span></td></tr>
<tr><td style="padding:32px;">${body}</td></tr>
<tr><td style="padding:16px 32px 24px;border-top:1px solid #eee;"><p style="font-size:12px;color:#999;margin:0;">You're receiving this because you're registered on the thesis check-in system.</p></td></tr>
</table></td></tr></table></body></html>`;
}

function anxBadge(n) {
  const c={1:'#1D9E75',2:'#1D9E75',3:'#639922',4:'#639922',5:'#BA7517',6:'#BA7517',7:'#D85A30',8:'#D85A30',9:'#E24B4A',10:'#A32D2D'};
  return `<span style="display:inline-block;background:${c[n]||'#888'};color:#fff;border-radius:50%;width:28px;height:28px;text-align:center;line-height:28px;font-weight:600;font-size:14px;">${n}</span>`;
}

function welcomeEmail({ name, supervisorName, appUrl }) {
  return emailWrap(`
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:500;">Welcome, ${name}</h2>
    <p style="color:#555;line-height:1.7;margin:0 0 16px;">You've been registered on the thesis check-in system by ${supervisorName}. Every two weeks you'll receive a reminder to complete a short progress check-in.</p>
    <p style="color:#555;line-height:1.7;margin:0 0 24px;">You can also submit a check-in at any time using the link below.</p>
    <a href="${appUrl}" style="display:inline-block;background:#534AB7;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:500;">Go to check-in form</a>
  `);
}

function reminderEmail({ name, appUrl, supervisorName }) {
  return emailWrap(`
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:500;">Time for your check-in, ${name}</h2>
    <p style="color:#555;line-height:1.7;margin:0 0 16px;">It's been two weeks — time to reflect on your progress and let ${supervisorName} know how things are going.</p>
    <p style="color:#555;line-height:1.7;margin:0 0 24px;">It only takes a few minutes and helps your supervisor support you effectively.</p>
    <a href="${appUrl}" style="display:inline-block;background:#534AB7;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:500;">Complete your check-in</a>
  `);
}

function confirmationEmail({ name, anxiety, tasksNext, supervisorName }) {
  const tl = (tasksNext||[]).map(t=>`<li style="margin-bottom:6px;color:#555;">${t}</li>`).join('');
  return emailWrap(`
    <h2 style="margin:0 0 8px;font-size:20px;font-weight:500;">Check-in received</h2>
    <p style="color:#555;line-height:1.7;margin:0 0 20px;">Thanks, ${name}. ${supervisorName} has been notified and will review your responses.</p>
    ${anxiety?`<p style="color:#555;margin:0 0 8px;"><strong>Anxiety level recorded:</strong> ${anxBadge(anxiety)} <span style="font-size:13px;color:#888;">out of 10</span></p>`:''}
    ${tl?`<p style="color:#555;margin:16px 0 8px;font-weight:500;">Your tasks for the next two weeks:</p><ul style="margin:0;padding-left:20px;">${tl}</ul>`:''}
    <p style="color:#888;font-size:13px;margin:20px 0 0;">See you in two weeks.</p>
  `);
}

function supervisorEmail({ name, email, anxiety, mood, hours, progress, excitement,
    challenges, blockers, support, other, tasksNext, tasksPrev, history, dashUrl }) {
  const AC={1:'#1D9E75',2:'#1D9E75',3:'#639922',4:'#639922',5:'#BA7517',6:'#BA7517',7:'#D85A30',8:'#D85A30',9:'#E24B4A',10:'#A32D2D'};
  const prevDone=(tasksPrev||[]).filter(t=>t.completed).map(t=>`<li style="color:#1D9E75;margin-bottom:4px;">✓ ${t.task}</li>`).join('');
  const prevMissed=(tasksPrev||[]).filter(t=>!t.completed).map(t=>`<li style="color:#888;margin-bottom:4px;">○ ${t.task}</li>`).join('');
  const nextTasks=(tasksNext||[]).map(t=>`<li style="margin-bottom:4px;color:#555;">${t}</li>`).join('');
  const bars=[...history].reverse().map(h=>{
    const px=Math.round(((h.anxiety||0)/10)*44);
    const d=new Date(h.submitted_at).toLocaleDateString('en-GB',{day:'numeric',month:'short'});
    return `<td align="center" valign="bottom" style="width:52px;padding:0 3px;"><div style="background:${AC[h.anxiety]||'#ddd'};height:${px}px;border-radius:3px 3px 0 0;min-height:3px;"></div><div style="font-size:10px;color:#999;margin-top:4px;">${d}</div></td>`;
  }).join('');
  const row=(l,v)=>v?`<tr><td style="padding:8px 0;color:#999;font-size:13px;width:160px;vertical-align:top;">${l}</td><td style="padding:8px 0;color:#333;font-size:14px;line-height:1.6;">${v}</td></tr>`:'';
  return emailWrap(`
    ${anxiety>=8?`<div style="background:#FCEBEB;border:1px solid #F09595;border-radius:8px;padding:12px 16px;margin-bottom:20px;"><strong style="color:#A32D2D;">High anxiety reported (${anxiety}/10)</strong><p style="color:#791F1F;margin:4px 0 0;font-size:13px;">Consider reaching out to ${name} directly.</p></div>`:''}
    <h2 style="margin:0 0 4px;font-size:20px;font-weight:500;">Check-in from ${name}</h2>
    <p style="color:#999;font-size:13px;margin:0 0 20px;">${email} · ${new Date().toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'})}</p>
    <div style="margin-bottom:20px;">
      ${anxiety?`${anxBadge(anxiety)}<span style="color:#555;font-size:14px;vertical-align:middle;margin-left:8px;">Anxiety <strong>${anxiety}/10</strong></span>`:''}
      ${mood?`<span style="color:#555;font-size:14px;margin-left:20px;">Motivation: <strong>${mood}</strong></span>`:''}
      ${hours?`<span style="color:#555;font-size:14px;margin-left:20px;"><strong>${hours}h</strong> this period</span>`:''}
    </div>
    ${history.length>1?`<p style="font-size:12px;color:#999;font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin:0 0 8px;">Anxiety trend</p><table cellpadding="0" cellspacing="0" style="margin-bottom:24px;"><tr style="vertical-align:bottom;height:48px;">${bars}</tr></table>`:''}
    <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eee;margin-bottom:20px;">
      ${row('Progress',progress)}${row('Excited about',excitement)}${row('Challenges',challenges)}${row('Blockers',blockers)}${row('Needs from you',support)}${row('Other',other)}
    </table>
    ${prevDone||prevMissed?`<p style="font-size:12px;color:#999;font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin:0 0 8px;">Previous tasks</p><ul style="margin:0 0 20px;padding-left:20px;">${prevDone}${prevMissed}</ul>`:''}
    ${nextTasks?`<p style="font-size:12px;color:#999;font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin:0 0 8px;">Planned for next two weeks</p><ul style="margin:0 0 24px;padding-left:20px;">${nextTasks}</ul>`:''}
    <a href="${dashUrl}" style="display:inline-block;background:#534AB7;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:500;">View dashboard</a>
  `);
}

function profileEmail({ name, email, thesis, researchQuestion, field, chapters, deadline, currentStage, timelineConcerns, dashUrl }) {
  const chapterList = (chapters||[]).map((c,i)=>`<tr><td style="padding:8px 0;color:#999;font-size:13px;vertical-align:top;width:100px;">Chapter ${i+1}</td><td style="padding:8px 0;color:#333;font-size:14px;line-height:1.6;"><strong>${c.title||'Untitled'}</strong>${c.description?'<br>'+c.description:''}</td></tr>`).join('');
  const row=(l,v)=>v?`<tr><td style="padding:8px 0;color:#999;font-size:13px;width:160px;vertical-align:top;">${l}</td><td style="padding:8px 0;color:#333;font-size:14px;line-height:1.6;">${v}</td></tr>`:'';
  return emailWrap(`
    <h2 style="margin:0 0 4px;font-size:20px;font-weight:500;">Context profile from ${name}</h2>
    <p style="color:#999;font-size:13px;margin:0 0 24px;">${email} · ${new Date().toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'})}</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eee;margin-bottom:20px;">
      ${row('Working title',thesis)}
      ${row('Research question',researchQuestion)}
      ${row('Field',field)}
      ${row('Current stage',currentStage)}
      ${row('Deadline',deadline)}
      ${row('Timeline concerns',timelineConcerns)}
    </table>
    ${chapterList?`<p style="font-size:12px;color:#999;font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin:0 0 8px;">Chapter outline</p><table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eee;margin-bottom:24px;">${chapterList}</table>`:''}
    <a href="${dashUrl}" style="display:inline-block;background:#534AB7;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:500;">View dashboard</a>
  `);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on http://localhost:${PORT}`));
