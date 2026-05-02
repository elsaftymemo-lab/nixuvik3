const express = require('express');
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' })); // Small limit — PDFs go through multer, not JSON
app.use(express.static(__dirname));

// ─── STORAGE SETUP ───────────────────────────────────────────────────────────
// All data lives in /data. On Railway, files persist as long as the service runs.
// For permanent storage on Railway, attach a Volume in the Railway dashboard (free).
const DATA_DIR   = path.join(__dirname, 'data');
const BOOKS_DIR  = path.join(DATA_DIR, 'books');   // PDF files live here
const COVERS_DIR = path.join(DATA_DIR, 'covers');  // Cover JPEGs live here
const DB_FILE    = path.join(DATA_DIR, 'db.json'); // Users, book metadata, chat

[DATA_DIR, BOOKS_DIR, COVERS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ─── SIMPLE JSON DATABASE ─────────────────────────────────────────────────────
function loadDB() {
  if (!fs.existsSync(DB_FILE)) return { users: [], books: [], chat: [] };
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { users: [], books: [], chat: [] }; }
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ─── MULTER — HANDLES BIG FILE UPLOADS ───────────────────────────────────────
// Files are streamed directly to disk. Memory usage stays flat even for 500MB PDFs.
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, BOOKS_DIR),
  filename:    (req, file, cb) => {
    const id = crypto.randomUUID();
    cb(null, id + '.pdf');
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files are allowed'));
  }
});

// ─── AUTH ─────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing fields' });

    const db = loadDB();
    const user = db.users.find(u => u.username === username);

    if (user) {
      const ok = await bcrypt.compare(password, user.password);
      if (!ok) return res.status(401).json({ error: 'كلمة المرور غلط' });
      return res.json({ success: true, username: user.username, settings: user.settings });
    }

    // New user — register automatically
    const hashed = await bcrypt.hash(password, 10);
    const newUser = {
      username,
      password: hashed,
      settings: { theme: 'dark', accent: '#3b82f6', radius: '12px' }
    };
    db.users.push(newUser);
    saveDB(db);
    res.json({ success: true, username: newUser.username, settings: newUser.settings });

  } catch (err) {
    console.error('Auth error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── UPLOAD BOOK ──────────────────────────────────────────────────────────────
// The PDF is streamed to disk by multer.
// The cover image (rendered on the client) is sent as a separate small base64 field.
app.post('/api/books/upload', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file received' });

    const { title, uploader, isPublic, isLearning, coverBase64 } = req.body;
    const id = path.basename(req.file.filename, '.pdf'); // The UUID multer assigned

    // Save cover image to disk
    let coverPath = null;
    if (coverBase64) {
      const coverData = coverBase64.replace(/^data:image\/\w+;base64,/, '');
      coverPath = id + '.jpg';
      fs.writeFileSync(path.join(COVERS_DIR, coverPath), Buffer.from(coverData, 'base64'));
    }

    const fileSizeMB = (req.file.size / 1024 / 1024).toFixed(1) + 'MB';

    const book = {
      id,
      title:      title || req.file.originalname.replace('.pdf', ''),
      size:       fileSizeMB,
      date:       new Date().toLocaleDateString('ar-EG'),
      uploader:   uploader || 'مجهول',
      isPublic:   isPublic === 'true',
      isLearning: isLearning === 'true',
      coverPath,
      pdfPath:    req.file.filename
    };

    const db = loadDB();
    db.books.unshift(book);
    saveDB(db);

    res.json({ success: true, book });

  } catch (err) {
    // Clean up uploaded file if something went wrong
    if (req.file) fs.unlink(req.file.path, () => {});
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message || 'Upload failed' });
  }
});

// ─── GET BOOKS LIST ───────────────────────────────────────────────────────────
app.get('/api/books', (req, res) => {
  try {
    const { user, mode, type } = req.query;
    const db = loadDB();

    let books = db.books;
    if (type === 'learning')       books = books.filter(b => b.isLearning);
    else if (mode === 'mine' && user) books = books.filter(b => b.uploader === user);
    else                           books = books.filter(b => b.isPublic && !b.isLearning);

    // Never send pdfPath in list — only send what the card needs
    const safe = books.map(({ id, title, size, date, uploader, isPublic, isLearning, coverPath }) => ({
      id, title, size, date, uploader, isPublic, isLearning,
      coverUrl: coverPath ? `/api/covers/${coverPath}` : null
    }));

    res.json(safe);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET SINGLE BOOK METADATA ─────────────────────────────────────────────────
app.get('/api/books/:id', (req, res) => {
  try {
    const db = loadDB();
    const book = db.books.find(b => b.id === req.params.id);
    if (!book) return res.status(404).json({ error: 'Not found' });

    res.json({
      id:        book.id,
      title:     book.title,
      coverUrl:  book.coverPath ? `/api/covers/${book.coverPath}` : null,
      pdfUrl:    `/api/pdf/${book.id}`
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── STREAM PDF ───────────────────────────────────────────────────────────────
// Supports HTTP Range requests so the browser can seek inside large PDFs
// without downloading the whole file first.
app.get('/api/pdf/:id', (req, res) => {
  try {
    const db = loadDB();
    const book = db.books.find(b => b.id === req.params.id);
    if (!book) return res.status(404).send('Not found');

    const filePath = path.join(BOOKS_DIR, book.pdfPath);
    if (!fs.existsSync(filePath)) return res.status(404).send('File missing');

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      // Partial content — browser is seeking or streaming
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end   = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        'Content-Range':  `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges':  'bytes',
        'Content-Length': chunkSize,
        'Content-Type':   'application/pdf',
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);

    } else {
      // Full file
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type':   'application/pdf',
        'Accept-Ranges':  'bytes',
      });
      fs.createReadStream(filePath).pipe(res);
    }

  } catch (err) {
    console.error('PDF stream error:', err);
    res.status(500).send('Error streaming file');
  }
});

// ─── SERVE COVER IMAGES ───────────────────────────────────────────────────────
app.get('/api/covers/:filename', (req, res) => {
  const filePath = path.join(COVERS_DIR, path.basename(req.params.filename));
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache covers for 1 day
  fs.createReadStream(filePath).pipe(res);
});

// ─── DELETE BOOK ──────────────────────────────────────────────────────────────
app.delete('/api/books/:id', (req, res) => {
  try {
    const adminKey = process.env.ADMIN_KEY || 'iqra-admin';
    if (req.query.admin_key !== adminKey) return res.status(403).json({ error: 'Forbidden' });

    const db = loadDB();
    const book = db.books.find(b => b.id === req.params.id);
    if (!book) return res.status(404).json({ error: 'Not found' });

    // Delete files from disk
    const pdfFile = path.join(BOOKS_DIR, book.pdfPath);
    const coverFile = book.coverPath ? path.join(COVERS_DIR, book.coverPath) : null;
    if (fs.existsSync(pdfFile)) fs.unlinkSync(pdfFile);
    if (coverFile && fs.existsSync(coverFile)) fs.unlinkSync(coverFile);

    db.books = db.books.filter(b => b.id !== req.params.id);
    saveDB(db);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── CHAT ─────────────────────────────────────────────────────────────────────
app.get('/api/chat', (req, res) => {
  try {
    const db = loadDB();
    const msgs = (db.chat || []).slice(-60); // Last 60 messages
    res.json(msgs);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/chat', (req, res) => {
  try {
    const { sender, text } = req.body;
    if (!sender || !text) return res.status(400).json({ error: 'Missing fields' });

    const db = loadDB();
    db.chat = db.chat || [];
    db.chat.push({ sender, text, date: new Date().toLocaleTimeString('ar-EG') });

    // Keep chat log from growing forever
    if (db.chat.length > 500) db.chat = db.chat.slice(-500);
    saveDB(db);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── FALLBACK ─────────────────────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Iqra running on port ${PORT}`));
