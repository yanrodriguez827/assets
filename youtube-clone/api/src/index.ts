import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import multer from 'multer';
import { z } from 'zod';

import { openDb } from './db.js';
import { authMiddleware, hashPassword, signJwt, verifyPassword, type AuthedRequest } from './auth.js';

const PORT = Number(process.env.PORT || 4000);
const WEB_DIR = path.resolve(process.env.WEB_DIR || '../web');
const STORAGE_DIR = path.resolve(process.env.STORAGE_DIR || '../storage');
const JWT_SECRET = process.env.JWT_SECRET || 'change-me';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const CORS_ORIGIN = process.env.CORS_ORIGIN || `http://localhost:${PORT}`;

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

const storageVideosDir = path.join(STORAGE_DIR, 'videos');
ensureDir(storageVideosDir);

const upload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      const id = crypto.randomUUID();
      (req as any).__uploadVideoId = id;
      const dir = path.join(storageVideosDir, id);
      ensureDir(dir);
      cb(null, dir);
    },
    filename(req, file, cb) {
      cb(null, 'source');
    }
  }),
  limits: {
    fileSize: 1024 * 1024 * 1024 // 1GB
  }
});

const app = express();
app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({ origin: CORS_ORIGIN, credentials: true }));
app.use(morgan('dev'));
app.use(express.json({ limit: '2mb' }));

// Static web
app.use('/', express.static(WEB_DIR));

const db = await openDb(STORAGE_DIR);

// --- Auth ---
app.post('/api/auth/register', async (req, res) => {
  const body = z
    .object({
      email: z.string().email(),
      username: z.string().min(3).max(32),
      password: z.string().min(8).max(100)
    })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', details: body.error.flatten() });

  const id = crypto.randomUUID();
  const now = Date.now();
  const passwordHash = await hashPassword(body.data.password);

  try {
    await db.run(
      `INSERT INTO users (id, email, username, password_hash, created_at)
       VALUES (:id, :email, :username, :password_hash, :created_at)`
      , { id, email: body.data.email.toLowerCase(), username: body.data.username, password_hash: passwordHash, created_at: now }
    );
  } catch {
    return res.status(409).json({ error: 'user_exists' });
  }

  const token = signJwt(
    { id, email: body.data.email.toLowerCase(), username: body.data.username },
    JWT_SECRET,
    JWT_EXPIRES_IN as any
  );
  return res.json({ token });
});

app.post('/api/auth/login', async (req, res) => {
  const body = z
    .object({
      email: z.string().email(),
      password: z.string().min(1)
    })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body' });

  const user = await db.get<{ id: string; email: string; username: string; password_hash: string }>(
    `SELECT id, email, username, password_hash FROM users WHERE email = :email`,
    { email: body.data.email.toLowerCase() }
  );
  if (!user) return res.status(401).json({ error: 'invalid_credentials' });

  const ok = await verifyPassword(body.data.password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

  const token = signJwt({ id: user.id, email: user.email, username: user.username }, JWT_SECRET, JWT_EXPIRES_IN as any);
  return res.json({ token });
});

app.get('/api/me', authMiddleware(JWT_SECRET), async (req: AuthedRequest, res) => {
  return res.json({ user: req.user });
});

// --- Videos ---
app.get('/api/videos', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const limit = Math.min(50, Math.max(1, Number(req.query.limit || 20)));
  const offset = Math.max(0, Number(req.query.offset || 0));

  const rows = await db.all<any>(
    q
      ? `SELECT v.*, u.username AS channel_username,
            (SELECT COUNT(1) FROM video_likes vl WHERE vl.video_id = v.id) AS like_count
         FROM videos v
         JOIN users u ON u.id = v.user_id
         WHERE v.title LIKE :q OR v.description LIKE :q
         ORDER BY v.created_at DESC
         LIMIT :limit OFFSET :offset`
      : `SELECT v.*, u.username AS channel_username,
            (SELECT COUNT(1) FROM video_likes vl WHERE vl.video_id = v.id) AS like_count
         FROM videos v
         JOIN users u ON u.id = v.user_id
         ORDER BY v.created_at DESC
         LIMIT :limit OFFSET :offset`,
    q ? { q: `%${q}%`, limit, offset } : { limit, offset }
  );
  return res.json({ items: rows });
});

app.get('/api/videos/:id', async (req, res) => {
  const id = req.params.id;
  const v = await db.get<any>(
    `SELECT v.*, u.username AS channel_username,
        (SELECT COUNT(1) FROM video_likes vl WHERE vl.video_id = v.id) AS like_count
     FROM videos v
     JOIN users u ON u.id = v.user_id
     WHERE v.id = :id`,
    { id }
  );
  if (!v) return res.status(404).json({ error: 'not_found' });

  // Increment views (best-effort)
  try {
    await db.run(`UPDATE videos SET views = views + 1 WHERE id = :id`, { id });
  } catch {
    // ignore
  }

  return res.json({ video: v });
});

app.post('/api/videos', authMiddleware(JWT_SECRET), upload.single('file'), async (req: AuthedRequest, res) => {
  const parsed = z
    .object({
      title: z.string().min(1).max(120),
      description: z.string().max(5000).optional()
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });

  const file = (req as any).file as Express.Multer.File | undefined;
  if (!file) return res.status(400).json({ error: 'missing_file' });

  const id = (req as any).__uploadVideoId as string;
  const mimeType = file.mimetype || 'application/octet-stream';
  const filename = path.relative(STORAGE_DIR, file.path);
  const now = Date.now();

  await db.run(
    `INSERT INTO videos (id, user_id, title, description, filename, mime_type, size_bytes, views, created_at)
     VALUES (:id, :user_id, :title, :description, :filename, :mime_type, :size_bytes, 0, :created_at)`,
    {
      id,
      user_id: req.user!.id,
      title: parsed.data.title,
      description: parsed.data.description || '',
      filename,
      mime_type: mimeType,
      size_bytes: file.size,
      created_at: now
    }
  );

  return res.status(201).json({ id });
});

app.get('/api/videos/:id/stream', async (req, res) => {
  const id = req.params.id;
  const v = await db.get<any>(`SELECT id, filename, mime_type FROM videos WHERE id = :id`, { id });
  if (!v) return res.status(404).end();

  const abs = path.join(STORAGE_DIR, v.filename);
  if (!fs.existsSync(abs)) return res.status(404).end();

  const stat = fs.statSync(abs);
  const range = req.headers.range;

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', v.mime_type || 'video/mp4');

  if (!range) {
    res.setHeader('Content-Length', stat.size);
    fs.createReadStream(abs).pipe(res);
    return;
  }

  const m = /^bytes=(\d+)-(\d+)?$/.exec(range);
  if (!m) {
    res.status(416).end();
    return;
  }

  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : stat.size - 1;
  if (Number.isNaN(start) || Number.isNaN(end) || start > end) {
    res.status(416).end();
    return;
  }

  const chunkSize = end - start + 1;
  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
  res.setHeader('Content-Length', chunkSize);

  fs.createReadStream(abs, { start, end }).pipe(res);
});

app.post('/api/videos/:id/like', authMiddleware(JWT_SECRET), async (req: AuthedRequest, res) => {
  const videoId = req.params.id;
  const userId = req.user!.id;
  const now = Date.now();

  // Toggle like
  const existing = await db.get<{ video_id: string }>(
    `SELECT video_id FROM video_likes WHERE video_id = :video_id AND user_id = :user_id`,
    { video_id: videoId, user_id: userId }
  );

  if (existing) {
    await db.run(`DELETE FROM video_likes WHERE video_id = :video_id AND user_id = :user_id`, {
      video_id: videoId,
      user_id: userId
    });
    return res.json({ liked: false });
  }

  await db.run(
    `INSERT INTO video_likes (video_id, user_id, created_at) VALUES (:video_id, :user_id, :created_at)`,
    { video_id: videoId, user_id: userId, created_at: now }
  );
  return res.json({ liked: true });
});

// --- Comments ---
app.get('/api/videos/:id/comments', async (req, res) => {
  const videoId = req.params.id;
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));
  const rows = await db.all<any>(
    `SELECT c.*, u.username
     FROM comments c
     JOIN users u ON u.id = c.user_id
     WHERE c.video_id = :video_id
     ORDER BY c.created_at DESC
     LIMIT :limit`,
    { video_id: videoId, limit }
  );
  return res.json({ items: rows });
});

app.post('/api/videos/:id/comments', authMiddleware(JWT_SECRET), async (req: AuthedRequest, res) => {
  const videoId = req.params.id;
  const parsed = z.object({ body: z.string().min(1).max(5000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });

  const id = crypto.randomUUID();
  const now = Date.now();
  await db.run(
    `INSERT INTO comments (id, video_id, user_id, body, created_at)
     VALUES (:id, :video_id, :user_id, :body, :created_at)`,
    { id, video_id: videoId, user_id: req.user!.id, body: parsed.data.body, created_at: now }
  );
  return res.status(201).json({ id });
});

// --- Subscriptions ---
app.post('/api/channels/:channelUserId/subscribe', authMiddleware(JWT_SECRET), async (req: AuthedRequest, res) => {
  const channelUserId = req.params.channelUserId;
  if (channelUserId === req.user!.id) return res.status(400).json({ error: 'cannot_subscribe_self' });

  const now = Date.now();
  const existing = await db.get<{ channel_user_id: string }>(
    `SELECT channel_user_id FROM subscriptions WHERE subscriber_user_id = :s AND channel_user_id = :c`,
    { s: req.user!.id, c: channelUserId }
  );

  if (existing) {
    await db.run(`DELETE FROM subscriptions WHERE subscriber_user_id = :s AND channel_user_id = :c`, { s: req.user!.id, c: channelUserId });
    return res.json({ subscribed: false });
  }

  await db.run(
    `INSERT INTO subscriptions (subscriber_user_id, channel_user_id, created_at)
     VALUES (:s, :c, :created_at)`,
    { s: req.user!.id, c: channelUserId, created_at: now }
  );
  return res.json({ subscribed: true });
});

app.get('/api/me/subscriptions', authMiddleware(JWT_SECRET), async (req: AuthedRequest, res) => {
  const rows = await db.all<any>(
    `SELECT u.id, u.username
     FROM subscriptions s
     JOIN users u ON u.id = s.channel_user_id
     WHERE s.subscriber_user_id = :id
     ORDER BY s.created_at DESC`,
    { id: req.user!.id }
  );
  return res.json({ items: rows });
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`youtube-clone listening on http://localhost:${PORT}`);
  console.log(`serving web from ${WEB_DIR}`);
  console.log(`storage at ${STORAGE_DIR}`);
});
