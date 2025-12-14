import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

import type { DB } from './db.js';
import { authMiddleware, hashPassword, signJwt, verifyPassword, type AuthedRequest } from './auth.js';
import type { AppConfig } from './config.js';

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

function parseRange(range: string, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d+)-(\d+)?$/.exec(range);
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || end < 0 || start > end) return null;
  if (start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

export function createApp(config: AppConfig, db: DB) {
  const app = express();
  app.disable('x-powered-by');

  app.use(
    helmet({
      crossOriginResourcePolicy: false,
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          "img-src": ["'self'", 'data:'],
          "media-src": ["'self'"]
        }
      }
    })
  );

  app.use(
    cors({
      origin: config.corsOrigin,
      credentials: true,
      methods: ['GET', 'POST', 'DELETE', 'PATCH', 'PUT', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization']
    })
  );

  app.use(morgan('dev'));

  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 240,
      standardHeaders: 'draft-7',
      legacyHeaders: false
    })
  );

  app.use(express.json({ limit: '2mb' }));

  // Static web
  app.use('/', express.static(config.webDir));

  const videosRoot = path.join(config.storageDir, 'videos');
  ensureDir(videosRoot);

  const upload = multer({
    storage: multer.diskStorage({
      destination(req, _file, cb) {
        const id = (req as any).__uploadVideoId as string | undefined;
        if (!id) return cb(new Error('missing_upload_id'), videosRoot);
        const dir = path.join(videosRoot, id);
        ensureDir(dir);
        cb(null, dir);
      },
      filename(_req, _file, cb) {
        cb(null, 'source');
      }
    }),
    fileFilter(_req, file, cb) {
      if (!file.mimetype || !file.mimetype.startsWith('video/')) {
        cb(new Error('invalid_file_type'));
        return;
      }
      cb(null, true);
    },
    limits: {
      fileSize: 1024 * 1024 * 1024,
      files: 1
    }
  });

  // --- Auth ---
  app.post('/api/auth/register', async (req, res) => {
    const body = z
      .object({
        email: z.string().email(),
        username: z.string().min(3).max(32).regex(/^[a-zA-Z0-9_\.\-]+$/),
        password: z
          .string()
          .min(12)
          .max(200)
          .refine((p) => /[a-z]/.test(p), 'password must include a lowercase letter')
          .refine((p) => /[A-Z]/.test(p), 'password must include an uppercase letter')
          .refine((p) => /\d/.test(p), 'password must include a number')
      })
      .safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid_body', details: body.error.flatten() });

    const id = crypto.randomUUID();
    const now = Date.now();
    const passwordHash = await hashPassword(body.data.password);

    try {
      await db.run(
        `INSERT INTO users (id, email, username, password_hash, created_at)
         VALUES (:id, :email, :username, :password_hash, :created_at)`,
        {
          ':id': id,
          ':email': body.data.email.toLowerCase(),
          ':username': body.data.username,
          ':password_hash': passwordHash,
          ':created_at': now
        }
      );
    } catch {
      return res.status(409).json({ error: 'user_exists' });
    }

    const token = signJwt({ id, email: body.data.email.toLowerCase(), username: body.data.username }, config.jwtSecret, config.jwtExpiresIn as any);
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
      { ':email': body.data.email.toLowerCase() }
    );

    if (!user) return res.status(401).json({ error: 'invalid_credentials' });

    const ok = await verifyPassword(body.data.password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

    const token = signJwt({ id: user.id, email: user.email, username: user.username }, config.jwtSecret, config.jwtExpiresIn as any);
    return res.json({ token });
  });

  app.get('/api/me', authMiddleware(config.jwtSecret), async (req: AuthedRequest, res) => {
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
      q
        ? { ':q': `%${q}%`, ':limit': limit, ':offset': offset }
        : { ':limit': limit, ':offset': offset }
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
      { ':id': id }
    );

    if (!v) return res.status(404).json({ error: 'not_found' });

    await db.run(`UPDATE videos SET views = views + 1 WHERE id = :id`, { ':id': id });

    return res.json({ video: v });
  });

  app.post(
    '/api/videos',
    authMiddleware(config.jwtSecret),
    (req, _res, next) => {
      (req as any).__uploadVideoId = crypto.randomUUID();
      next();
    },
    upload.single('file'),
    async (req: AuthedRequest, res) => {
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
      const safeRel = path.relative(config.storageDir, file.path);
      if (safeRel.startsWith('..') || path.isAbsolute(safeRel)) return res.status(400).json({ error: 'invalid_storage_path' });

      const now = Date.now();

      await db.run(
        `INSERT INTO videos (id, user_id, title, description, filename, mime_type, size_bytes, views, created_at)
         VALUES (:id, :user_id, :title, :description, :filename, :mime_type, :size_bytes, 0, :created_at)`,
        {
          ':id': id,
          ':user_id': req.user!.id,
          ':title': parsed.data.title,
          ':description': parsed.data.description || '',
          ':filename': safeRel,
          ':mime_type': mimeType,
          ':size_bytes': file.size,
          ':created_at': now
        }
      );

      return res.status(201).json({ id });
    }
  );

  app.get('/api/videos/:id/stream', async (req, res) => {
    const id = req.params.id;

    const v = await db.get<any>(`SELECT id, filename, mime_type FROM videos WHERE id = :id`, { ':id': id });
    if (!v) return res.status(404).end();

    const abs = path.resolve(config.storageDir, v.filename);
    if (!abs.startsWith(path.resolve(config.storageDir) + path.sep)) return res.status(404).end();
    if (!fs.existsSync(abs)) return res.status(404).end();

    const stat = fs.statSync(abs);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', v.mime_type || 'video/mp4');

    const range = typeof req.headers.range === 'string' ? req.headers.range : '';
    if (!range) {
      res.setHeader('Content-Length', stat.size);
      fs.createReadStream(abs).pipe(res);
      return;
    }

    const r = parseRange(range, stat.size);
    if (!r) {
      res.status(416).end();
      return;
    }

    const chunkSize = r.end - r.start + 1;
    res.status(206);
    res.setHeader('Content-Range', `bytes ${r.start}-${r.end}/${stat.size}`);
    res.setHeader('Content-Length', chunkSize);

    fs.createReadStream(abs, { start: r.start, end: r.end }).pipe(res);
  });

  app.post('/api/videos/:id/like', authMiddleware(config.jwtSecret), async (req: AuthedRequest, res) => {
    const videoId = req.params.id;
    const userId = req.user!.id;
    const now = Date.now();

    const existing = await db.get<{ video_id: string }>(
      `SELECT video_id FROM video_likes WHERE video_id = :video_id AND user_id = :user_id`,
      { ':video_id': videoId, ':user_id': userId }
    );

    if (existing) {
      await db.run(`DELETE FROM video_likes WHERE video_id = :video_id AND user_id = :user_id`, {
        ':video_id': videoId,
        ':user_id': userId
      });
      return res.json({ liked: false });
    }

    await db.run(
      `INSERT INTO video_likes (video_id, user_id, created_at) VALUES (:video_id, :user_id, :created_at)`,
      { ':video_id': videoId, ':user_id': userId, ':created_at': now }
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
      { ':video_id': videoId, ':limit': limit }
    );

    return res.json({ items: rows });
  });

  app.post('/api/videos/:id/comments', authMiddleware(config.jwtSecret), async (req: AuthedRequest, res) => {
    const videoId = req.params.id;
    const parsed = z.object({ body: z.string().min(1).max(5000) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });

    const id = crypto.randomUUID();
    const now = Date.now();

    await db.run(
      `INSERT INTO comments (id, video_id, user_id, body, created_at)
       VALUES (:id, :video_id, :user_id, :body, :created_at)`,
      { ':id': id, ':video_id': videoId, ':user_id': req.user!.id, ':body': parsed.data.body, ':created_at': now }
    );

    return res.status(201).json({ id });
  });

  // --- Subscriptions ---
  app.post('/api/channels/:channelUserId/subscribe', authMiddleware(config.jwtSecret), async (req: AuthedRequest, res) => {
    const channelUserId = req.params.channelUserId;
    if (channelUserId === req.user!.id) return res.status(400).json({ error: 'cannot_subscribe_self' });

    const now = Date.now();

    const existing = await db.get<{ channel_user_id: string }>(
      `SELECT channel_user_id FROM subscriptions WHERE subscriber_user_id = :s AND channel_user_id = :c`,
      { ':s': req.user!.id, ':c': channelUserId }
    );

    if (existing) {
      await db.run(`DELETE FROM subscriptions WHERE subscriber_user_id = :s AND channel_user_id = :c`, { ':s': req.user!.id, ':c': channelUserId });
      return res.json({ subscribed: false });
    }

    await db.run(
      `INSERT INTO subscriptions (subscriber_user_id, channel_user_id, created_at)
       VALUES (:s, :c, :created_at)`,
      { ':s': req.user!.id, ':c': channelUserId, ':created_at': now }
    );

    return res.json({ subscribed: true });
  });

  app.get('/api/me/subscriptions', authMiddleware(config.jwtSecret), async (req: AuthedRequest, res) => {
    const rows = await db.all<any>(
      `SELECT u.id, u.username
       FROM subscriptions s
       JOIN users u ON u.id = s.channel_user_id
       WHERE s.subscriber_user_id = :id
       ORDER BY s.created_at DESC`,
      { ':id': req.user!.id }
    );

    return res.json({ items: rows });
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  // Error handler (last)
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const msg = typeof err?.message === 'string' ? err.message : 'internal_error';
    const code = typeof err?.code === 'string' ? err.code : '';

    if (msg === 'invalid_file_type') return res.status(400).json({ error: 'invalid_file_type' });
    if (code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'file_too_large' });

    return res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
