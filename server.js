const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const cookieParser = require('cookie-parser');
const { YoutubeTranscript } = require('youtube-transcript');
const OpenAI = require('openai');
const sanitizeHtml = require('sanitize-html');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// App
const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Simple in-memory rate limiter store (per-user)
const rateLimitStore = new Map();

// Middleware
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use('/public', express.static(path.join(__dirname, 'public')));

// Views helper - simple templating with {{...}}
function renderTemplate(templateName, data = {}) {
  const layoutPath = path.join(__dirname, 'views', 'layout.html');
  const templatePath = path.join(__dirname, 'views', `${templateName}.html`);
  let layout = fs.readFileSync(layoutPath, 'utf8');
  let template = fs.readFileSync(templatePath, 'utf8');

  // Insert template into layout
  layout = layout.replace('{{content}}', template);

  // Replace variables (simple)
  Object.keys(data).forEach(key => {
    const regex = new RegExp(`{{${key}}}`, 'g');
    layout = layout.replace(regex, data[key] || '');
  });

  // Support simple sections like {{#error}}...{{/error}} and booleans/strings presence
  layout = layout.replace(/\{\{#([a-zA-Z0-9_]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (m, key, inner) => {
    return data[key] ? inner.replace(new RegExp(`{{${key}}}`, 'g'), data[key]) : '';
  });

  return layout;
}

// DB setup
const dbFile = process.env.DATABASE_FILE || path.join(__dirname, 'db', 'database.sqlite');
const dbDir = path.dirname(dbFile);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(dbFile);
console.log('📦 Database connected:', dbFile);

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  verified INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  meta_description TEXT,
  seo_keywords TEXT,
  summary TEXT,
  content_html TEXT,
  youtube_url TEXT,
  ai_model TEXT DEFAULT 'OpenAI',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
`);
console.log('✅ Database tables ready');

// Email transporter (Brevo/SMTP)
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Authentication middleware
function requireAuth(req, res, next) {
  const token = req.cookies[process.env.SESSION_COOKIE_NAME || 'sid'];
  if (!token) return res.redirect('/login');
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.userId);
    if (!user || !user.verified) {
      return res.redirect('/login');
    }
    req.user = user;
    next();
  } catch (err) {
    console.error('Auth error:', err);
    res.clearCookie(process.env.SESSION_COOKIE_NAME || 'sid');
    return res.redirect('/login');
  }
}

// Rate limiting middleware (simple)
function rateLimit(req, res, next) {
  if (!req.user || !req.user.id) return next(); // only limit logged-in users
  const userId = req.user.id;
  const now = Date.now();
  const limitMs = 30000; // 30 seconds per generation
  const last = rateLimitStore.get(userId) || 0;
  if (now - last < limitMs) {
    const wait = Math.ceil((limitMs - (now - last)) / 1000);
    return res.status(429).json({ error: `Please wait ${wait} seconds before generating another blog post.` });
  }
  rateLimitStore.set(userId, now);
  next();
}

// Routes - simple pages
app.get('/healthz', (req, res) => res.status(200).send('OK'));

app.get('/', (req, res) => {
  res.send(renderTemplate('index'));
});

app.get('/signup', (req, res) => {
  res.send(renderTemplate('signup'));
});

app.get('/login', (req, res) => {
  res.send(renderTemplate('login'));
});

// Signup
app.post('/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).send(renderTemplate('signup', { error: 'All fields are required' }));
    if (password.length < 6) return res.status(400).send(renderTemplate('signup', { error: 'Password must be at least 6 characters' }));
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) return res.status(400).send(renderTemplate('signup', { error: 'Email already registered' }));
    const passwordHash = await bcrypt.hash(password, 10);
    const result = db.prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)').run(name, email, passwordHash);

    const token = jwt.sign({ userId: result.lastInsertRowid, email }, process.env.JWT_SECRET, { expiresIn: '24h' });
    const verificationUrl = `http://${req.get('host')}/verify?token=${token}`;

    await transporter.sendMail({
      from: process.env.MAIL_FROM,
      to: email,
      subject: 'Verify your email - AI Blog Generator',
      html: `<h2>Welcome to AI Blog Generator!</h2>
             <p>Hi ${name},</p>
             <p>Click to verify: <a href="${verificationUrl}">Verify email</a></p>
             <p>This link expires in 24 hours.</p>`
    });

    res.send(renderTemplate('verify', { message: 'Success! Check your email to verify your account.', type: 'success', showLogin: true }));
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).send(renderTemplate('signup', { error: 'An error occurred. Please try again.' }));
  }
});

// Verify
app.get('/verify', (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.send(renderTemplate('verify', { message: 'Invalid verification link', type: 'error' }));
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    db.prepare('UPDATE users SET verified = 1 WHERE id = ?').run(decoded.userId);
    res.send(renderTemplate('verify', { message: 'Email verified successfully! You can now log in.', type: 'success', showLogin: true }));
  } catch (err) {
    console.error('Verification error:', err);
    res.send(renderTemplate('verify', { message: 'Verification link is invalid or expired', type: 'error' }));
  }
});

// Login
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) return res.status(400).send(renderTemplate('login', { error: 'Invalid email or password' }));
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(400).send(renderTemplate('login', { error: 'Invalid email or password' }));
    if (!user.verified) return res.status(400).send(renderTemplate('login', { error: 'Please verify your email before logging in' }));

    const token = jwt.sign({ userId: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.cookie(process.env.SESSION_COOKIE_NAME || 'sid', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });
    res.redirect('/dashboard');
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).send(renderTemplate('login', { error: 'An error occurred. Please try again.' }));
  }
});

// Logout
app.get('/logout', (req, res) => {
  res.clearCookie(process.env.SESSION_COOKIE_NAME || 'sid');
  res.redirect('/');
});

// Dashboard
app.get('/dashboard', requireAuth, (req, res) => {
  const posts = db.prepare('SELECT * FROM posts WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  // render simple posts HTML for dashboard template variable
  const postsHtml = posts.map(p => `
    <div class="post-item">
      <h3>${p.title}</h3>
      <p class="small">Created: ${new Date(p.created_at).toLocaleString()}</p>
      <div class="post-actions">
        <a href="/posts/${p.id}/edit" class="btn">View/Edit</a>
        <button onclick="downloadPost(${p.id})" class="btn">Download</button>
      </div>
    </div>
  `).join('') || '<p>No posts yet. Generate your first blog post above!</p>';

  res.send(renderTemplate('dashboard', { userName: req.user.name, posts: postsHtml }));
});


// ---------------------------
// UPDATED /generate handler
// Accepts posted { transcript, ai_model } OR { youtube_url, ai_model }
// ---------------------------
app.post('/generate', requireAuth, rateLimit, async (req, res) => {
  try {
    const { transcript: pastedTranscript, youtube_url, ai_model } = req.body;

    // prefer pasted transcript
    let transcript = (pastedTranscript || '').toString().trim();

    if (!transcript && !youtube_url) {
      return res.status(400).json({ error: 'Provide either a pasted transcript or a YouTube URL.' });
    }

    // if transcript empty but youtube_url is present -> attempt to fetch captions
    if (!transcript && youtube_url) {
      console.log(`🎥 Fetching transcript for: ${youtube_url}`);
      let videoId = '';
      const urlPattern = /(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\n?#]+)/;
      const match = youtube_url.match(urlPattern);
      if (match) {
        videoId = match[1];
      } else {
        return res.status(400).json({ error: 'Invalid YouTube URL format' });
      }

      try {
        const transcriptData = await YoutubeTranscript.fetchTranscript(videoId);
        transcript = transcriptData.map(item => item.text).join(' ');
        console.log(`✅ Transcript fetched (${transcript.length} chars)`);
      } catch (error) {
        console.error('Transcript error:', error);
        return res.status(400).json({ error: 'Captions not available for this video. Please paste the transcript manually.' });
      }
    }

    // Truncate if extremely long (to avoid token explosion)
    const maxLength = 12000; // characters
    if (transcript.length > maxLength) {
      transcript = transcript.substring(0, maxLength) + '...';
    }

    console.log('🤖 Calling OpenAI API with transcript length:', transcript.length);

    const systemPrompt = `You are a professional blog writer. Convert a YouTube transcript into a well-structured, readable blog post.
Always return a valid JSON object with the exact structure asked by the user.`;

    const userPrompt = `Convert this transcript into a blog post. Return ONLY a valid JSON object with this exact structure:
{
  "title": "Engaging blog title here",
  "meta_description": "SEO meta description (150-160 characters)",
  "seo_keywords": "keyword1, keyword2, keyword3",
  "summary": "Brief 2-3 sentence summary",
  "content_html": "<h2>Section</h2><p>Paragraphs...</p>"
}

Use H2 headings for sections, paragraphs, and <ul>/<li> when helpful.
Transcript:
${transcript}`;

    // Call OpenAI
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.7,
      max_tokens: 2000
    });

    const responseText = completion.choices[0].message.content;
    console.log('✅ OpenAI response received');

    // Attempt to parse JSON
    let blogData;
    try {
      const cleaned = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      blogData = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('JSON parse error:', parseErr);
      console.error('Raw AI output (first 2000 chars):', responseText.slice(0, 2000));
      return res.status(500).json({ error: 'Failed to parse AI response. Try a shorter transcript or retry.' });
    }

    // Sanitize HTML
    blogData.content_html = sanitizeHtml(blogData.content_html || '', {
      allowedTags: sanitizeHtml.defaults.allowedTags.concat(['h1', 'h2', 'h3', 'h4', 'ul', 'li']),
      allowedAttributes: {}
    });

    // Save to DB
    const result = db.prepare(`
      INSERT INTO posts (user_id, title, meta_description, seo_keywords, summary, content_html, youtube_url, ai_model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.user.id,
      blogData.title || 'Untitled',
      blogData.meta_description || '',
      blogData.seo_keywords || '',
      blogData.summary || '',
      blogData.content_html || '',
      youtube_url || '',
      ai_model || 'OpenAI'
    );

    console.log(`📝 Blog post saved: ${blogData.title || 'Untitled'}`);

    res.json({ success: true, postId: result.lastInsertRowid, title: blogData.title || '' });

  } catch (err) {
    console.error('Generation error:', err);
    res.status(500).json({ error: 'Failed to generate blog post. Check server logs and API keys.' });
  }
});

// Edit post page
app.get('/posts/:id/edit', requireAuth, (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!post) return res.status(404).send('Post not found');
  res.send(renderTemplate('post_edit', {
    postId: post.id,
    title: post.title,
    metaDescription: post.meta_description || '',
    seoKeywords: post.seo_keywords || '',
    summary: post.summary || '',
    content: post.content_html || '',
    youtubeUrl: post.youtube_url || ''
  }));
});

// Save post
app.post('/posts/:id/save', requireAuth, (req, res) => {
  const { title, meta_description, seo_keywords, summary, content_html } = req.body;
  const sanitized = sanitizeHtml(content_html || '', {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['h1', 'h2', 'h3', 'h4', 'ul', 'li']),
    allowedAttributes: {}
  });

  db.prepare(`
    UPDATE posts
    SET title = ?, meta_description = ?, seo_keywords = ?, summary = ?, content_html = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ?
  `).run(title, meta_description, seo_keywords, summary, sanitized, req.params.id, req.user.id);

  res.json({ success: true });
});

// Download post
app.get('/posts/:id/download', requireAuth, (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!post) return res.status(404).send('Post not found');

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="${post.meta_description || ''}"><meta name="keywords" content="${post.seo_keywords || ''}"><title>${post.title}</title></head><body><h1>${post.title}</h1><div>${post.summary || ''}</div>${post.content_html || ''}<hr><p><small>Generated from: ${post.youtube_url || 'transcript'}</small></p></body></html>`;

  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Content-Disposition', `attachment; filename="${(post.title || 'post').replace(/[^a-z0-9]/gi, '_')}.html"`);
  res.send(html);
});

// Start server
app.listen(PORT, HOST, () => {
  console.log(`🚀 Server running at http://${HOST}:${PORT}`);
  console.log(`📧 Email notifications: ${process.env.MAIL_FROM || 'Not configured'}`);
  console.log(`🤖 AI Provider: ${process.env.AI_PROVIDER || 'OPENAI'}`);
  console.log(`🔐 Environment: ${process.env.NODE_ENV || 'development'}`);
});

