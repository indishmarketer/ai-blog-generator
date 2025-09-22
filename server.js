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

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Rate limiting store (simple in-memory)
const rateLimitStore = new Map();

// Middlewares
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use('/public', express.static(path.join(__dirname, 'public')));

// Database setup
const dbFile = process.env.DATABASE_FILE || './db/database.sqlite';
const dbDir = path.dirname(dbFile);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbFile);
console.log('📦 Database connected:', dbFile);

// Create tables if they don't exist
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

// Email transporter
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// OpenAI client - using openai package
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Helper functions
function renderTemplate(templateName, data = {}) {
  const layoutPath = path.join(__dirname, 'views', 'layout.html');
  const templatePath = path.join(__dirname, 'views', `${templateName}.html`);
  
  let layout = fs.readFileSync(layoutPath, 'utf8');
  let template = fs.readFileSync(templatePath, 'utf8');
  
  // Replace content placeholder
  layout = layout.replace('{{content}}', template);
  
  // Replace variables
  Object.keys(data).forEach(key => {
    const regex = new RegExp(`{{${key}}}`, 'g');
    layout = layout.replace(regex, data[key] || '');
  });
  
  return layout;
}

// Robust video ID extractor
function extractVideoId(url) {
  if (!url) return null;
  // patterns for watch?v=, youtu.be, shorts
  const patterns = [
    /v=([0-9A-Za-z_-]{11})/,
    /youtu\.be\/([0-9A-Za-z_-]{11})/,
    /youtube\.com\/shorts\/([0-9A-Za-z_-]{11})/
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m && m[1]) return m[1];
  }
  return null;
}

// Authentication middleware
function requireAuth(req, res, next) {
  const token = req.cookies[process.env.SESSION_COOKIE_NAME || 'sid'];
  if (!token) {
    return res.redirect('/login');
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.userId);
    if (!user || !user.verified) {
      return res.redirect('/login');
    }
    req.user = user;
    next();
  } catch (error) {
    console.error('Auth error:', error);
    res.clearCookie(process.env.SESSION_COOKIE_NAME || 'sid');
    res.redirect('/login');
  }
}

// Rate limiting middleware (per-user)
function rateLimit(req, res, next) {
  const userId = req.user && req.user.id;
  if (!userId) return next();

  const now = Date.now();
  const limit = 30000; // 30 seconds
  if (rateLimitStore.has(userId)) {
    const lastRequest = rateLimitStore.get(userId);
    if (now - lastRequest < limit) {
      const waitTime = Math.ceil((limit - (now - lastRequest)) / 1000);
      return res.status(429).json({ 
        error: `Please wait ${waitTime} seconds before generating another blog post.` 
      });
    }
  }
  rateLimitStore.set(userId, now);
  next();
}

// Routes

// Health check
app.get('/healthz', (req, res) => {
  res.status(200).send('OK');
});

// Root
app.get('/', (req, res) => {
  res.send(renderTemplate('index'));
});

// Signup page
app.get('/signup', (req, res) => {
  res.send(renderTemplate('signup'));
});

// Signup handler
app.post('/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).send(renderTemplate('signup', { error: 'All fields are required' }));
    }
    if (password.length < 6) {
      return res.status(400).send(renderTemplate('signup', { error: 'Password must be at least 6 characters' }));
    }
    const existingUser = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (existingUser) {
      return res.status(400).send(renderTemplate('signup', { error: 'Email already registered' }));
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const result = db.prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)').run(name, email, passwordHash);

    const token = jwt.sign({ userId: result.lastInsertRowid, email }, process.env.JWT_SECRET, { expiresIn: '24h' });

    const verificationUrl = `http://${req.get('host')}/verify?token=${token}`;

    await transporter.sendMail({
      from: process.env.MAIL_FROM,
      to: email,
      subject: 'Verify your email - AI Blog Generator',
      html: `
        <h2>Welcome to AI Blog Generator!</h2>
        <p>Hi ${name},</p>
        <p>Please click the link below to verify your email address:</p>
        <a href="${verificationUrl}" style="display:inline-block;padding:10px 20px;background-color:#007bff;color:white;text-decoration:none;border-radius:5px;">Verify Email</a>
        <p>Or copy this link: ${verificationUrl}</p>
        <p>This link expires in 24 hours.</p>
      `
    });

    console.log(`📧 Verification email sent to ${email}`);

    res.send(renderTemplate('verify', {
      message: 'Success! Check your email to verify your account.',
      type: 'success'
    }));

  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).send(renderTemplate('signup', { error: 'An error occurred. Please try again.' }));
  }
});

// Email verification
app.get('/verify', (req, res) => {
  try {
    const { token } = req.query;
    if (!token) {
      return res.send(renderTemplate('verify', { message: 'Invalid verification link', type: 'error' }));
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    db.prepare('UPDATE users SET verified = 1 WHERE id = ?').run(decoded.userId);
    console.log(`✅ User ${decoded.email} verified`);
    res.send(renderTemplate('verify', { message: 'Email verified successfully! You can now log in.', type: 'success', showLogin: 'true' }));
  } catch (error) {
    console.error('Verification error:', error);
    res.send(renderTemplate('verify', { message: 'Verification link is invalid or expired', type: 'error' }));
  }
});

// Login
app.get('/login', (req, res) => {
  res.send(renderTemplate('login'));
});

// Login handler
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) {
      return res.status(400).send(renderTemplate('login', { error: 'Invalid email or password' }));
    }
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(400).send(renderTemplate('login', { error: 'Invalid email or password' }));
    }
    if (!user.verified) {
      return res.status(400).send(renderTemplate('login', { error: 'Please verify your email before logging in' }));
    }
    const token = jwt.sign({ userId: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.cookie(process.env.SESSION_COOKIE_NAME || 'sid', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });
    console.log(`👤 User ${email} logged in`);
    res.redirect('/dashboard');
  } catch (error) {
    console.error('Login error:', error);
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
  const postsHtml = posts.map(post => `
    <div class="post-item">
      <h3>${post.title}</h3>
      <p>Created: ${new Date(post.created_at).toLocaleString()}</p>
      <div class="post-actions">
        <a href="/posts/${post.id}/edit" class="btn btn-sm">View/Edit</a>
        <a href="/posts/${post.id}/download" class="btn btn-sm">Download</a>
      </div>
    </div>
  `).join('') || '<p>No posts yet. Generate your first blog post above!</p>';

  res.send(renderTemplate('dashboard', {
    userName: req.user.name,
    posts: postsHtml
  }));
});

// ORIGINAL /generate route (YouTube URL -> transcript via youtube-transcript)
app.post('/generate', requireAuth, rateLimit, async (req, res) => {
  try {
    const { youtube_url, ai_model } = req.body;
    if (!youtube_url) {
      return res.status(400).json({ error: 'YouTube URL is required' });
    }

    console.log(`🎥 Fetching transcript for: ${youtube_url}`);
    const videoId = extractVideoId(youtube_url);
    console.log('videoId =>', videoId);
    if (!videoId) {
      return res.status(400).json({ error: 'Invalid YouTube URL format' });
    }

    // Fetch transcript
    let transcript = '';
    try {
      const transcriptData = await YoutubeTranscript.fetchTranscript(videoId);
      transcript = transcriptData.map(item => item.text).join(' ');
      console.log(`✅ Transcript fetched (${transcript.length} chars)`);
    } catch (error) {
      console.error('Transcript error:', error);
      return res.status(400).json({ error: 'Captions not available for this video. Audio transcription fallback is disabled in this MVP.' });
    }

    // Truncate transcript
    const maxLength = 10000;
    if (transcript.length > maxLength) transcript = transcript.substring(0, maxLength) + '...';

    // Build prompts
    const systemPrompt = `You are a professional blog writer. Convert YouTube video transcripts into well-structured, engaging blog posts. Always return a valid JSON object with the exact structure requested.`;
    const userPrompt = `Convert this YouTube transcript into a blog post. Return ONLY valid JSON with this exact structure:
{
  "title": "Engaging blog title here",
  "meta_description": "SEO meta description (150-160 characters)",
  "seo_keywords": "keyword1, keyword2, keyword3, keyword4, keyword5",
  "summary": "Brief 2-3 sentence summary of the content",
  "content_html": "<h2>First Section</h2><p>Content here...</p><h2>Second Section</h2><p>More content...</p>"
}
Transcript:
${transcript}`;

    console.log('🤖 Calling OpenAI API...');
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

    // Parse JSON
    let blogData;
    try {
      const cleanedResponse = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      blogData = JSON.parse(cleanedResponse);
    } catch (parseError) {
      console.error('JSON parse error:', parseError);
      return res.status(500).json({ error: 'Failed to parse AI response. Please try again.' });
    }

    blogData.content_html = sanitizeHtml(blogData.content_html || '', {
      allowedTags: sanitizeHtml.defaults.allowedTags.concat(['h1','h2','h3','h4','ul','li']),
      allowedAttributes: {}
    });

    const result = db.prepare(`
      INSERT INTO posts (user_id, title, meta_description, seo_keywords, summary, content_html, youtube_url, ai_model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.user.id, blogData.title, blogData.meta_description, blogData.seo_keywords, blogData.summary, blogData.content_html, youtube_url, ai_model || 'OpenAI');

    console.log(`📝 Blog post saved: ${blogData.title}`);
    res.json({ success: true, postId: result.lastInsertRowid, title: blogData.title });

  } catch (error) {
    console.error('Generation error:', error);
    res.status(500).json({ error: 'Failed to generate blog post. Please check your API keys and try again.' });
  }
});

// NEW ROUTE: generate from pasted transcript
app.post('/generate-from-transcript', requireAuth, rateLimit, async (req, res) => {
  try {
    const { transcript, ai_model } = req.body;
    if (!transcript || transcript.trim().length < 20) {
      return res.status(400).json({ error: 'Please paste a transcript with enough text (at least 20 characters).' });
    }

    let text = transcript.trim();
    const MAX_LEN = 10000;
    if (text.length > MAX_LEN) text = text.substring(0, MAX_LEN) + '...';

    const systemPrompt = `You are a professional blog writer. Convert supplied YouTube video transcript text into a clear, human-like, SEO-friendly blog post. Always return exactly one valid JSON object (no extra commentary).`;

    const userPrompt = `Convert the following transcript into a blog post and return ONLY valid JSON with this exact structure:
{
  "title": "Short, engaging title here",
  "meta_description": "SEO meta description (150-160 characters)",
  "seo_keywords": "keyword1, keyword2, keyword3",
  "summary": "2-3 sentence summary",
  "content_html": "<h2>Section</h2><p>Paragraphs...</p>"
}
Transcript:
${text}
Notes:
- Use short sentences and simple words.
- Use 4-6 H2 sections.
- Add bullet lists (<ul><li>) where appropriate.
- Keep the length around 600-1200 words if the transcript is long.
- Do NOT invent facts beyond what is logical from the transcript.
`;

    console.log('🤖 Calling OpenAI with pasted transcript...');
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
    console.log('✅ OpenAI response received for pasted transcript');

    let blogData;
    try {
      const cleaned = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      blogData = JSON.parse(cleaned);
    } catch (err) {
      console.error('JSON parse error (transcript route):', err, 'raw:', responseText);
      return res.status(500).json({ error: 'Failed to parse AI response. Try again or shorten the transcript.' });
    }

    blogData.content_html = sanitizeHtml(blogData.content_html || '', {
      allowedTags: sanitizeHtml.defaults.allowedTags.concat(['h1','h2','h3','h4','ul','li']),
      allowedAttributes: {}
    });

    const insert = db.prepare(`
      INSERT INTO posts (user_id, title, meta_description, seo_keywords, summary, content_html, youtube_url, ai_model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.user.id, blogData.title || 'Untitled', blogData.meta_description || '', blogData.seo_keywords || '', blogData.summary || '', blogData.content_html || '', null, ai_model || 'OpenAI');

    console.log(`📝 Saved post from pasted transcript: ${blogData.title || 'Untitled'}`);
    res.json({ success: true, postId: insert.lastInsertRowid, title: blogData.title || 'Untitled' });

  } catch (error) {
    console.error('Generation (transcript) error:', error);
    res.status(500).json({ error: 'Failed to generate blog post from transcript. Please try again.' });
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
  const sanitizedContent = sanitizeHtml(content_html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['h1','h2','h3','h4','ul','li']),
    allowedAttributes: {}
  });
  db.prepare(`
    UPDATE posts 
    SET title = ?, meta_description = ?, seo_keywords = ?, summary = ?, content_html = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ?
  `).run(title, meta_description, seo_keywords, summary, sanitizedContent, req.params.id, req.user.id);
  console.log(`📝 Post ${req.params.id} updated`);
  res.json({ success: true });
});

// Download post
app.get('/posts/:id/download', requireAuth, (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!post) return res.status(404).send('Post not found');
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="${post.meta_description || ''}">
<meta name="keywords" content="${post.seo_keywords || ''}">
<title>${post.title}</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;line-height:1.6;max-width:800px;margin:0 auto;padding:20px}
h1{color:#333;border-bottom:2px solid #007bff;padding-bottom:10px}
h2{color:#555;margin-top:30px}
p{margin:15px 0}
.summary{background:#f0f0f0;padding:15px;border-radius:5px;margin:20px 0}
</style>
</head>
<body>
<h1>${post.title}</h1>
<div class="summary">${post.summary || ''}</div>
${post.content_html}
<hr>
<p><small>Generated from: ${post.youtube_url || 'Transcript paste'}</small></p>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Content-Disposition', `attachment; filename="${post.title.replace(/[^a-z0-9]/gi, '_')}.html"`);
  res.send(html);
});

// Start server
app.listen(PORT, HOST, () => {
  console.log(`🚀 Server running at http://${HOST}:${PORT}`);
  console.log(`📧 Email notifications: ${process.env.MAIL_FROM || 'Not configured'}`);
  console.log(`🤖 AI Provider: ${process.env.AI_PROVIDER || 'OpenAI'}`);
  console.log(`🔐 Environment: ${process.env.NODE_ENV || 'development'}`);
});
