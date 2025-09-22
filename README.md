# AI Blog Generator from YouTube

Transform YouTube videos into SEO-optimized blog posts using AI! This is a complete, beginner-friendly web application that works with OpenAI to convert video transcripts into professional blog content.

## 🎯 Features

* **User Authentication**: Sign up with email verification, secure login
* **YouTube Integration**: Paste any YouTube URL to extract video transcripts
* **AI-Powered Generation**: Uses OpenAI GPT to create structured blog posts
* **Blog Editor**: Edit, save, and download generated content
* **SEO Optimization**: Auto-generates meta descriptions and keywords
* **Simple Deployment**: Ready for GitHub and Coolify deployment

## 🚀 Quick Start (Local Development)

### Step 1: Get the Code

#### Option A: Clone with Git

```bash
git clone <your-repo-url>
cd ai-blog-generator
```

#### Option B: Manual Upload to GitHub (For Non-Developers)

* Go to GitHub.com and sign in
* Click the + icon (top right) → New repository
* Name it `ai-blog-generator` → Create repository
* Click *uploading an existing file*
* Drag and drop all project files
* Write commit message "Initial upload" → Commit changes

### Step 2: Install Dependencies

```bash
npm install
```

### Step 3: Configure Environment

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Edit `.env` and add your credentials:

* `JWT_SECRET`: Generate with: `openssl rand -base64 32`
* `SMTP_USER`/`SMTP_PASS`: Get from Brevo.com

  * Sign up for free account
  * Go to SMTP & API → SMTP → Generate SMTP credentials
* `OPENAI_API_KEY`: Get from platform.openai.com

  * Create account → API keys → Create new secret key

### Step 4: Run the Application

```bash
npm start
```

Visit [http://localhost:3000](http://localhost:3000) in your browser!

---

## 📦 Deploy to Coolify (Step-by-Step)

### Prerequisites

* GitHub account with the code uploaded
* Coolify instance running
* Domain name (optional but recommended)

### Deployment Steps

#### 1. Create New Application in Coolify

* Log into your Coolify dashboard
* Click **+ New Resource → Application**
* Select GitHub as source
* Connect your GitHub account if not already connected
* Select your `ai-blog-generator` repository
* Choose branch: `main`

#### 2. Configure Build Settings

* **Build Pack**: Select *Nixpacks*
* **Base Directory**: Leave empty (root)
* **Start Command**: `npm start`
* **Port**: `3000`
* **Health Check Path**: `/healthz`

#### 3. Set Environment Variables

In Coolify, go to Environment Variables tab and add:

```bash
# Required Variables
JWT_SECRET=generate-a-32-character-random-string-here
OPENAI_API_KEY=sk-your-openai-api-key

# Brevo SMTP
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_USER=your-brevo-smtp-username
SMTP_PASS=your-brevo-smtp-password
MAIL_FROM="AI Blog <no-reply@yourdomain.com>"

# Settings
NODE_ENV=production
DATABASE_FILE=/data/database.sqlite
```

#### 4. Configure Persistent Storage

**IMPORTANT**: SQLite database needs persistent storage!

* Go to **Storages** tab in Coolify
* Click **+ Add Persistent Storage**
* Settings:

  * Name: `database`
  * Mount Path: `/data`
  * Size: 1GB (or more if needed)
* Click Save

#### 5. Add Custom Domain (Optional)

* Go to **General** tab
* Under Domains, add your domain: `yourdomain.com`
* Click Save
* Configure DNS:

  * Add **A record** pointing to your server IP
    Example: `A @ YOUR.SERVER.IP.ADDRESS`
* Coolify will auto-generate SSL certificate via Let's Encrypt

#### 6. Deploy

* Click **Deploy** button
* Watch the logs for any errors
* Once deployed, visit your domain or the Coolify-provided URL

---

## 🧪 Testing Your Deployment

### 1. Test Sign Up

* Go to `/signup`
* Create an account with a real email
* Check your inbox for verification email
* Click verification link

### 2. Test Blog Generation

* Log in to your account
* Paste a YouTube URL (make sure it has captions)
* Select OpenAI model
* Click **Generate Blog**
* Wait 10–30 seconds for generation

### 3. Test Editor

* Click **View/Edit** on generated post
* Make changes
* Click **Save Changes**
* Try **Download HTML**

---

## 🔧 Troubleshooting

### App Downloads File Instead of Loading

**Problem**: Browser downloads a file when visiting your domain
**Solution**:

* App not listening on correct port
* Check Coolify logs for errors
* Ensure `PORT=3000` in environment
* Verify start command is `npm start`

### Email Not Sending

**Problem**: Verification emails not arriving
**Solutions**:

* Check Brevo SMTP credentials are correct
* Check spam folder
* Verify `MAIL_FROM` email domain
* Check Coolify logs for SMTP errors

### OpenAI Errors

**Problem**: "Failed to generate blog post"
**Solutions**:

* Verify `OPENAI_API_KEY` is correct
* Check OpenAI account has credits
* Try with a different YouTube video (must have captions)

### Database Errors

**Problem**: "Database is locked" or data not persisting
**Solution**:

* Ensure persistent storage is configured in Coolify
* Check mount path matches `DATABASE_FILE` env variable
* Restart application after storage changes

### YouTube Transcript Not Found

**Problem**: "Captions not available for this video"
**Solutions**:

* Video must have captions/subtitles enabled
* Try a different video
* Check if video is public (not private/unlisted)

---

## 📈 Upgrading Later

### Add Image Generation (Future)

When ready to add image generation:

* Install image generation packages
* Add `IMAGE_PROVIDER` environment variable
* Create `/uploads` directory with persistent storage
* Map storage in Coolify: `/app/uploads → persistent volume`

### Add More AI Models

The code includes a stub for Google Gemini. To enable:

* Get Gemini API key
* Add `GEMINI_API_KEY` to environment
* Implement Gemini API calls in `server.js`

---

## 🛡️ Security Notes

* Passwords are hashed with bcrypt
* JWT tokens expire after 24 hours for email verification
* Session cookies are HTTP-only and secure in production
* Rate limiting prevents API abuse (1 request per 30 seconds)
* HTML content is sanitized before saving

---

## 📝 Environment Variables Reference

| Variable         | Description           | Example                                                   |
| ---------------- | --------------------- | --------------------------------------------------------- |
| PORT             | Server port           | 3000                                                      |
| HOST             | Server host           | 0.0.0.0                                                   |
| DATABASE\_FILE   | SQLite database path  | /data/database.sqlite                                     |
| JWT\_SECRET      | Secret for JWT tokens | 32-character random string                                |
| SMTP\_HOST       | Email server host     | smtp-relay.brevo.com                                      |
| SMTP\_PORT       | Email server port     | 587                                                       |
| SMTP\_USER       | Email username        | From Brevo dashboard                                      |
| SMTP\_PASS       | Email password        | From Brevo dashboard                                      |
| MAIL\_FROM       | Sender email          | [no-reply@yourdomain.com](mailto:no-reply@yourdomain.com) |
| OPENAI\_API\_KEY | OpenAI API key        | sk-...                                                    |
| OPENAI\_MODEL    | GPT model to use      | gpt-4o-mini                                               |
| NODE\_ENV        | Environment           | production or development                                 |

---

## ✅ Deployment Checklist

* [ ] Upload code to GitHub
* [ ] Create Coolify application
* [ ] Set build pack to Nixpacks
* [ ] Configure port 3000
* [ ] Add all environment variables
* [ ] Configure persistent storage for database
* [ ] Deploy application
* [ ] Test signup with real email
* [ ] Verify email delivery works
* [ ] Test blog generation with YouTube URL
* [ ] Add custom domain (optional)
* [ ] Enable HTTPS via Coolify

---

## 💡 Tips for Non-Developers

* **Use GitHub Web Interface**: No need for Git commands, just drag and drop files
* **Test Locally First**: Run on your computer before deploying
* **Start with Free Tiers**: Brevo and OpenAI offer free credits
* **Check Logs**: Coolify shows real-time logs - watch for errors
* **Be Patient**: First deployment might take 5–10 minutes

---

## 🆘 Getting Help

If you encounter issues:

* Check Coolify application logs
* Verify all environment variables are set
* Ensure persistent storage is configured
* Test with a simple YouTube video that definitely has captions
* Check browser console for JavaScript errors

---

## 📄 License

MIT License - Feel free to use and modify!

Built with ❤️ using Node.js, Express, SQLite, and OpenAI
