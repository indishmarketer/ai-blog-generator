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

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use('/public', express.static('public'));

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

// OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Helper functions
function renderTemplate(templateName, data = {}) {
  const layoutPath = path.join(__dirname, 'views', 'layout.html');
  const templatePath = path.join(__dirname, 'views', `${templateName}.html`);
  
  let layout = fs.readFileSync(layoutPath, 'utf8');
  let template = fs.readFileSync(templatePath, 'utf8');
  
  // Replace content in layout
  layout = layout.replace('{{content}}', template);
  
  // Replace all variables
  Object.keys(data).forEach(key => {
    const regex = new RegExp(`{{${key}}}`, 'g');
    layout = layout.replace(regex, data[key] || '');
  });
  
  return layout;
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

// Rate limiting middleware
function rateLimit(req, res, next) {
  const userId = req.user.id;
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

// Home page
app.get('/', (req, res) => {
  res.send(renderTemplate('index'));
});

// Sign up page
app.get('/signup', (req, res) => {
  res.send(renderTemplate('signup'));
});

// Sign up handler
app.post('/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    
    // Basic validation
    if (!name || !email || !password) {
      return res.status(400).send(renderTemplate('signup', {
        error: 'All fields are required'
      }));
    }
    
    if (password.length < 6) {
      return res.status(400).send(renderTemplate('signup', {
        error: 'Password must be at least 6 characters'
      }));
    }
    
    // Check if email exists
    const existingUser = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (existingUser) {
      return res.status(400).send(renderTemplate('signup', {
        error: 'Email already registered'
      }));
    }
    
    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);
    
    // Create user
    const result = db.prepare(
      'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)'
    ).run(name, email, passwordHash);
    
    // Create verification token
    const token = jwt.sign(
      { userId: result.lastInsertRowid, email },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );
    
    // Send verification email
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
    res.status(500).send(renderTemplate('signup', {
      error: 'An error occurred. Please try again.'
    }));
  }
});

// Email verification
app.get('/verify', (req, res) => {
  try {
    const { token } = req.query;
    
    if (!token) {
      return res.send(renderTemplate('verify', {
        message: 'Invalid verification link',
        type: 'error'
      }));
    }
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Update user as verified
    db.prepare('UPDATE users SET verified = 1 WHERE id = ?').run(decoded.userId);
    
    console.log(`✅ User ${decoded.email} verified`);
    
    res.send(renderTemplate('verify', {
      message: 'Email verified successfully! You can now log in.',
      type: 'success',
      showLogin: 'true'
    }));
    
  } catch (error) {
    console.error('Verification error:', error);
    res.send(renderTemplate('verify', {
      message: 'Verification link is invalid or expired',
      type: 'error'
    }));
  }
});

// Login page
app.get('/login', (req, res) => {
  res.send(renderTemplate('login'));
});

// Login handler
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    // Find user
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    
    if (!user) {
      return res.status(400).send(renderTemplate('login', {
        error: 'Invalid email or password'
      }));
    }
    
    // Check password
    const validPassword = await bcrypt.compare(password, user.password_hash);
    
    if (!validPassword) {
      return res.status(400).send(renderTemplate('login', {
        error: 'Invalid email or password'
      }));
    }
    
    // Check if verified
    if (!user.verified) {
      return res.status(400).send(renderTemplate('login', {
        error: 'Please verify your email before logging in'
      }));
    }
    
    // Create session token
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    
    // Set cookie
    res.cookie(process.env.SESSION_COOKIE_NAME || 'sid', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });
    
    console.log(`👤 User ${email} logged in`);
    
    res.redirect('/dashboard');
    
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).send(renderTemplate('login', {
      error: 'An error occurred. Please try again.'
    }));
  }
});

// Logout
app.get('/logout', (req, res) => {
  res.clearCookie(process.env.SESSION_COOKIE_NAME || 'sid');
  res.redirect('/');
});

// Dashboard
app.get('/dashboard', requireAuth, (req, res) => {
  // Get user's posts
  const posts = db.prepare(
    'SELECT * FROM posts WHERE user_id = ? ORDER BY created_at DESC'
  ).all(req.user.id);
  
  // Format posts for display
  const postsHtml = posts.map(post => `
    <div class="post-item">
      <h3>${post.title}</h3>
      <p>Created: ${new Date(post.created_at).toLocaleDateString()}</p>
      <div class="post-actions">
        <a href="/posts/${post.id}/edit" class="btn btn-sm">View/Edit</a>
        <button onclick="downloadPost(${post.id})" class="btn btn-sm">Download</button>
      </div>
    </div>
  `).join('') || '<p>No posts yet. Generate your first blog post above!</p>';
  
  res.send(renderTemplate('dashboard', {
    userName: req.user.name,
    posts: postsHtml
  }));
});

// Generate blog post
app.post('/generate', requireAuth, rateLimit, async (req, res) => {
  try {
    const { youtube_url, ai_model } = req.body;
    
    if (!youtube_url) {
      return res.status(400).json({ error: 'YouTube URL is required' });
    }
    
    console.log(`🎥 Fetching transcript for: ${youtube_url}`);
    
    // Extract video ID
    let videoId = '';
    const urlPattern = /(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\n?#]+)/;
    const match = youtube_url.match(urlPattern);
    
    if (match) {
      videoId = match[1];
    } else {
      return res.status(400).json({ error: 'Invalid YouTube URL format' });
    }
    
    // Fetch transcript
    let transcript = '';
    try {
      const transcriptData = await YoutubeTranscript.fetchTranscript(videoId);
      transcript = transcriptData.map(item => item.text).join(' ');
      console.log(`✅ Transcript fetched (${transcript.length} characters)`);
    } catch (error) {
      console.error('Transcript error:', error);
      return res.status(400).json({ 
        error: 'Captions not available for this video. Audio transcription fallback is disabled in this MVP.' 
      });
    }
    
    // Truncate transcript if too long (to save tokens)
    const maxLength = 10000;
    if (transcript.length > maxLength) {
      transcript = transcript.substring(0, maxLength) + '...';
    }
    
    // Call OpenAI
    console.log('🤖 Calling OpenAI API...');
    
    const systemPrompt = `You are a professional blog writer. Convert YouTube video transcripts into well-structured, engaging blog posts. 
    Always return your response as a valid JSON object with the exact structure shown in the user message.`;
    
    const userPrompt = `Convert this YouTube transcript into a blog post. Return ONLY valid JSON with this exact structure:
    {
      "title": "Engaging blog title here",
      "meta_description": "SEO meta description (150-160 characters)",
      "seo_keywords": "keyword1, keyword2, keyword3, keyword4, keyword5",
      "summary": "Brief 2-3 sentence summary of the content",
      "content_html": "<h2>First Section</h2><p>Content here...</p><h2>Second Section</h2><p>More content...</p>"
    }
    
    Make the content_html engaging with proper HTML formatting including H2 headings for sections, paragraphs, and if relevant, bullet points using <ul> and <li> tags.
    
    Transcript to convert:
    ${transcript}`;
    
    let blogData;
    
    if (process.env.AI_PROVIDER === 'GEMINI' && ai_model === 'Gemini') {
      // Gemini stub - not implemented in MVP
      console.log('⚠️ Gemini selected but not implemented, falling back to OpenAI');
    }
    
    // Use OpenAI
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
    
    // Parse JSON response
    try {
      // Clean response if needed (remove markdown code blocks)
      const cleanedResponse = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      blogData = JSON.parse(cleanedResponse);
    } catch (parseError) {
      console.error('JSON parse error:', parseError);
      return res.status(500).json({ error: 'Failed to parse AI response. Please try again.' });
    }
    
    // Sanitize HTML content
    blogData.content_html = sanitizeHtml(blogData.content_html, {
      allowedTags: sanitizeHtml.defaults.allowedTags.concat(['h1', 'h2', 'h3']),
      allowedAttributes: {}
    });
    
    // Save to database
    const result = db.prepare(`
      INSERT INTO posts (user_id, title, meta_description, seo_keywords, summary, content_html, youtube_url, ai_model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.user.id,
      blogData.title,
      blogData.meta_description,
      blogData.seo_keywords,
      blogData.summary,
      blogData.content_html,
      youtube_url,
      ai_model || 'OpenAI'
    );
    
    console.log(`📝 Blog post saved: ${blogData.title}`);
    
    res.json({ 
      success: true, 
      postId: result.lastInsertRowid,
      title: blogData.title 
    });
    
  } catch (error) {
    console.error('Generation error:', error);
    res.status(500).json({ 
      error: 'Failed to generate blog post. Please check your API keys and try again.' 
    });
  }
});

// Edit post page
app.get('/posts/:id/edit', requireAuth, (req, res) => {
  const post = db.prepare(
    'SELECT * FROM posts WHERE id = ? AND user_id = ?'
  ).get(req.params.id, req.user.id);
  
  if (!post) {
    return res.status(404).send('Post not found');
  }
  
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
  
  // Sanitize HTML
  const sanitizedContent = sanitizeHtml(content_html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['h1', 'h2', 'h3']),
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
  const post = db.prepare(
    'SELECT * FROM posts WHERE id = ? AND user_id = ?'
  ).get(req.params.id, req.user.id);
  
  if (!post) {
    return res.status(404).send('Post not found');
  }
  
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="description" content="${post.meta_description || ''}">
    <meta name="keywords" content="${post.seo_keywords || ''}">
    <title>${post.title}</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; max-width: 800px; margin: 0 auto; padding: 20px; }
        h1 { color: #333; border-bottom: 2px solid #007bff; padding-bottom: 10px; }
        h2 { color: #555; margin-top: 30px; }
        h3 { color: #666; }
        p { margin: 15px 0; }
        .summary { background: #f0f0f0; padding: 15px; border-radius: 5px; margin: 20px 0; }
    </style>
</head>
<body>
    <h1>${post.title}</h1>
    <div class="summary">${post.summary || ''}</div>
    ${post.content_html}
    <hr>
    <p><small>Generated from: ${post.youtube_url || 'YouTube video'}</small></p>
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