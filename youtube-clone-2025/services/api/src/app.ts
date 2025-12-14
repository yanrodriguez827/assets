import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import { z } from 'zod';

import type { AppConfig } from './config.js';
import type { Db } from './db.js';
import type { Storage } from './storage.js';
import type { Queue } from './queue.js';
import { asyncHandler, errorHandler, HttpError, type AuthedRequest } from './http.js';
import { requireAuth } from './authMiddleware.js';
import { hashPassword, randomToken, sha256Hex, signAccessToken, signRefreshToken, verifyJwt, verifyPassword } from './security.js';

function ensureWithin(base: string, p: string) {
  const absBase = path.resolve(base) + path.sep;
  const abs = path.resolve(p);
  if (!abs.startsWith(absBase)) throw new Error('path_traversal');
  return abs;
}

export function createApp(config: AppConfig, db: Db, storage: Storage, queue: Queue) {
  const app = express();
  app.disable('x-powered-by');

  app.use(
    helmet({
      crossOriginResourcePolicy: false,
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          "img-src": ["'self'", 'data:'],
          "media-src": ["'self'", 'blob:'],
          "script-src": ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net']
        }
      }
    })
  );

  app.use(
    cors({
      origin: config.corsOrigin,
      credentials: true,
      allowedHeaders: ['Content-Type', 'Authorization'],
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
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

  app.use(cookieParser(config.cookieSecret));

  // Serve web
  app.use('/', express.static(config.paths.webDir));

  // Serve media (fs)
  if (storage.kind === 'fs') {
    const hlsBase = ensureWithin(config.fsStorageDir, path.join(config.fsStorageDir, 'hls'));
    app.use('/media/hls', express.static(hlsBase, { fallthrough: false, etag: true, maxAge: '1h' }));
  }

  const uploadTmpDir = path.join(config.fsStorageDir, 'tmp');
  fs.mkdirSync(uploadTmpDir, { recursive: true });

  const upload = multer({
    storage: multer.diskStorage({
      destination(_req, _file, cb) {
        cb(null, uploadTmpDir);
      },
      filename(_req, _file, cb) {
        cb(null, crypto.randomUUID());
      }
    }),
    limits: {
      fileSize: config.uploadMaxBytes,
      files: 1
    },
    fileFilter(_req, file, cb) {
      if (!file.mimetype || !file.mimetype.startsWith('video/')) return cb(new Error('invalid_file_type'));
      cb(null, true);
    }
  });

  function setRefreshCookie(res: express.Response, refreshJwt: string) {
    const isSecure = config.publicBaseUrl.startsWith('https://');
    res.cookie('refresh_token', refreshJwt, {
      httpOnly: true,
      sameSite: 'lax',
      secure: isSecure,
      path: '/api/auth/refresh',
      maxAge: 30 * 24 * 60 * 60 * 1000
    });
  }

  // Auth
  app.post(
    '/api/auth/register',
    asyncHandler(async (req, res) => {
      const body = z
        .object({
          email: z.string().email(),
          username: z.string().min(3).max(32).regex(/^[a-zA-Z0-9_\.\-]+$/),
          password: z
            .string()
            .min(12)
            .max(200)
            .refine((p) => /[a-z]/.test(p), 'password must include lowercase')
            .refine((p) => /[A-Z]/.test(p), 'password must include uppercase')
            .refine((p) => /\d/.test(p), 'password must include number')
        })
        .safeParse(req.body);
      if (!body.success) throw new HttpError(400, 'invalid_body', undefined, body.error.flatten());

      const userId = crypto.randomUUID();
      const now = Date.now();
      const passwordHash = await hashPassword(body.data.password);

      try {
        await db.run(
          `INSERT INTO users (id, email, username, password_hash, role, created_at)
           VALUES (:id, :email, :username, :password_hash, 'user', :created_at)`,
          {
            id: userId,
            email: body.data.email.toLowerCase(),
            username: body.data.username,
            password_hash: passwordHash,
            created_at: now
          }
        );
      } catch {
        throw new HttpError(409, 'user_exists');
      }

      const sessionId = crypto.randomUUID();
      const rawRefresh = randomToken(32);
      const refreshHash = sha256Hex(rawRefresh);
      const refreshJwt = signRefreshToken({ sessionId, userId }, config.jwtRefreshSecret);

      await db.run(
        `INSERT INTO refresh_sessions (id, user_id, token_hash, user_agent, ip, revoked_at, expires_at, created_at)
         VALUES (:id, :user_id, :token_hash, :user_agent, :ip, NULL, :expires_at, :created_at)`,
        {
          id: sessionId,
          user_id: userId,
          token_hash: refreshHash,
          user_agent: String(req.header('user-agent') || ''),
          ip: String(req.ip || ''),
          expires_at: now + 30 * 24 * 60 * 60 * 1000,
          created_at: now
        }
      );

      setRefreshCookie(res, `${refreshJwt}.${rawRefresh}`);

      const accessToken = signAccessToken({ userId, username: body.data.username, role: 'user' }, config.jwtAccessSecret);
      res.json({ accessToken });
    })
  );

  app.post(
    '/api/auth/login',
    asyncHandler(async (req, res) => {
      const body = z
        .object({
          email: z.string().email(),
          password: z.string().min(1)
        })
        .safeParse(req.body);
      if (!body.success) throw new HttpError(400, 'invalid_body');

      const user = await db.get<{ id: string; email: string; username: string; password_hash: string; role: string }>(
        `SELECT id, email, username, password_hash, role FROM users WHERE email = :email`,
        { email: body.data.email.toLowerCase() }
      );

      if (!user) throw new HttpError(401, 'invalid_credentials');

      const ok = await verifyPassword(body.data.password, user.password_hash);
      if (!ok) throw new HttpError(401, 'invalid_credentials');

      const now = Date.now();
      const sessionId = crypto.randomUUID();
      const rawRefresh = randomToken(32);
      const refreshHash = sha256Hex(rawRefresh);
      const refreshJwt = signRefreshToken({ sessionId, userId: user.id }, config.jwtRefreshSecret);

      await db.run(
        `INSERT INTO refresh_sessions (id, user_id, token_hash, user_agent, ip, revoked_at, expires_at, created_at)
         VALUES (:id, :user_id, :token_hash, :user_agent, :ip, NULL, :expires_at, :created_at)`,
        {
          id: sessionId,
          user_id: user.id,
          token_hash: refreshHash,
          user_agent: String(req.header('user-agent') || ''),
          ip: String(req.ip || ''),
          expires_at: now + 30 * 24 * 60 * 60 * 1000,
          created_at: now
        }
      );

      setRefreshCookie(res, `${refreshJwt}.${rawRefresh}`);

      const accessToken = signAccessToken({ userId: user.id, username: user.username, role: user.role }, config.jwtAccessSecret);
      res.json({ accessToken });
    })
  );

  app.post(
    '/api/auth/refresh',
    asyncHandler(async (req, res) => {
      const cookie = String(req.cookies?.refresh_token || '');
      const parts = cookie.split('.');
      if (parts.length < 2) throw new HttpError(401, 'missing_refresh');

      const rawRefresh = parts[parts.length - 1];
      const refreshJwt = parts.slice(0, -1).join('.');

      const decoded = verifyJwt<{ sessionId: string; userId: string }>(refreshJwt, config.jwtRefreshSecret);
      const tokenHash = sha256Hex(rawRefresh);

      const session = await db.get<{ id: string; user_id: string; revoked_at: number | null; expires_at: number }>(
        `SELECT id, user_id, revoked_at, expires_at FROM refresh_sessions WHERE id = :id`,
        { id: decoded.sessionId }
      );
      if (!session) throw new HttpError(401, 'invalid_refresh');
      if (session.revoked_at !== null) throw new HttpError(401, 'invalid_refresh');
      if (session.expires_at < Date.now()) throw new HttpError(401, 'expired_refresh');

      const match = await db.get<{ id: string }>(
        `SELECT id FROM refresh_sessions WHERE id = :id AND token_hash = :token_hash`,
        { id: decoded.sessionId, token_hash: tokenHash }
      );
      if (!match) throw new HttpError(401, 'invalid_refresh');

      const user = await db.get<{ id: string; username: string; role: string }>(
        `SELECT id, username, role FROM users WHERE id = :id`,
        { id: session.user_id }
      );
      if (!user) throw new HttpError(401, 'invalid_refresh');

      const accessToken = signAccessToken({ userId: user.id, username: user.username, role: user.role }, config.jwtAccessSecret);
      res.json({ accessToken });
    })
  );

  app.post(
    '/api/auth/logout',
    requireAuth(config.jwtAccessSecret),
    asyncHandler(async (req: AuthedRequest, res) => {
      const cookie = String(req.cookies?.refresh_token || '');
      const parts = cookie.split('.');
      if (parts.length >= 2) {
        const refreshJwt = parts.slice(0, -1).join('.');
        try {
          const decoded = verifyJwt<{ sessionId: string; userId: string }>(refreshJwt, config.jwtRefreshSecret);
          await db.run(`UPDATE refresh_sessions SET revoked_at = :revoked_at WHERE id = :id`, { revoked_at: Date.now(), id: decoded.sessionId });
        } catch {
          // ignore
        }
      }

      res.clearCookie('refresh_token', { path: '/api/auth/refresh' });
      res.json({ ok: true });
    })
  );

  app.get(
    '/api/me',
    requireAuth(config.jwtAccessSecret),
    asyncHandler(async (req: AuthedRequest, res) => {
      res.json({ user: { id: req.user!.id, username: req.user!.username, role: req.user!.role } });
    })
  );

  // Videos
  app.get(
    '/api/videos',
    asyncHandler(async (req, res) => {
      const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      const limit = Math.min(50, Math.max(1, Number(req.query.limit || 20)));
      const offset = Math.max(0, Number(req.query.offset || 0));

      const rows = await db.all<any>(
        q
          ? `SELECT v.id, v.title, v.description, v.status, v.views, v.created_at, u.username AS channel_username,
                (SELECT COUNT(1) FROM video_likes vl WHERE vl.video_id = v.id) AS like_count
             FROM videos v
             JOIN users u ON u.id = v.user_id
             WHERE v.title LIKE :q OR v.description LIKE :q
             ORDER BY v.created_at DESC
             LIMIT :limit OFFSET :offset`
          : `SELECT v.id, v.title, v.description, v.status, v.views, v.created_at, u.username AS channel_username,
                (SELECT COUNT(1) FROM video_likes vl WHERE vl.video_id = v.id) AS like_count
             FROM videos v
             JOIN users u ON u.id = v.user_id
             ORDER BY v.created_at DESC
             LIMIT :limit OFFSET :offset`,
        q ? { q: `%${q}%`, limit, offset } : { limit, offset }
      );

      res.json({ items: rows });
    })
  );

  app.get(
    '/api/videos/:id',
    asyncHandler(async (req, res) => {
      const id = req.params.id;

      const v = await db.get<any>(
        `SELECT v.*, u.username AS channel_username,
            (SELECT COUNT(1) FROM video_likes vl WHERE vl.video_id = v.id) AS like_count
         FROM videos v
         JOIN users u ON u.id = v.user_id
         WHERE v.id = :id`,
        { id }
      );

      if (!v) throw new HttpError(404, 'not_found');

      await db.run(`UPDATE videos SET views = views + 1 WHERE id = :id`, { id });

      const hls_manifest_url = v.hls_master_object_key ? storage.publicUrlForKey(String(v.hls_master_object_key)) : null;

      res.json({
        video: {
          id: v.id,
          title: v.title,
          description: v.description,
          status: v.status,
          views: v.views,
          created_at: v.created_at,
          channel_username: v.channel_username,
          like_count: v.like_count,
          duration_seconds: v.duration_seconds,
          width: v.width,
          height: v.height,
          hls_manifest_url
        }
      });
    })
  );

  app.post(
    '/api/videos/upload',
    requireAuth(config.jwtAccessSecret),
    upload.single('file'),
    asyncHandler(async (req: AuthedRequest, res) => {
      const parsed = z
        .object({
          title: z.string().min(1).max(120),
          description: z.string().max(5000).optional()
        })
        .safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'invalid_body', undefined, parsed.error.flatten());

      const file = (req as any).file as Express.Multer.File | undefined;
      if (!file) throw new HttpError(400, 'missing_file');

      const videoId = crypto.randomUUID();
      const now = Date.now();

      // Store original (FS or S3) and get object key
      const stored = await storage.storeOriginalFromTmp(videoId, file.path, file.mimetype || 'application/octet-stream');

      await db.run(
        `INSERT INTO videos (id, user_id, title, description, status, original_object_key, hls_master_object_key, duration_seconds, width, height, mime_type, size_bytes, views, created_at)
         VALUES (:id, :user_id, :title, :description, 'processing', :original_object_key, NULL, NULL, NULL, NULL, :mime_type, :size_bytes, 0, :created_at)`,
        {
          id: videoId,
          user_id: req.user!.id,
          title: parsed.data.title,
          description: parsed.data.description || '',
          original_object_key: stored.objectKey,
          mime_type: file.mimetype || 'application/octet-stream',
          size_bytes: file.size,
          created_at: now
        }
      );

      await queue.enqueueTranscode(videoId);

      res.status(201).json({ id: videoId });
    })
  );

  app.post(
    '/api/videos/:id/like',
    requireAuth(config.jwtAccessSecret),
    asyncHandler(async (req: AuthedRequest, res) => {
      const videoId = req.params.id;
      const userId = req.user!.id;

      const existing = await db.get<{ video_id: string }>(
        `SELECT video_id FROM video_likes WHERE video_id = :video_id AND user_id = :user_id`,
        { video_id: videoId, user_id: userId }
      );

      if (existing) {
        await db.run(`DELETE FROM video_likes WHERE video_id = :video_id AND user_id = :user_id`, { video_id: videoId, user_id: userId });
        return res.json({ liked: false });
      }

      await db.run(
        `INSERT INTO video_likes (video_id, user_id, created_at) VALUES (:video_id, :user_id, :created_at)`,
        { video_id: videoId, user_id: userId, created_at: Date.now() }
      );

      return res.json({ liked: true });
    })
  );

  app.get(
    '/api/videos/:id/comments',
    asyncHandler(async (req, res) => {
      const videoId = req.params.id;
      const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));

      const rows = await db.all<any>(
        `SELECT c.id, c.body, c.created_at, u.username
         FROM comments c
         JOIN users u ON u.id = c.user_id
         WHERE c.video_id = :video_id
         ORDER BY c.created_at DESC
         LIMIT :limit`,
        { video_id: videoId, limit }
      );

      res.json({ items: rows });
    })
  );

  app.post(
    '/api/videos/:id/comments',
    requireAuth(config.jwtAccessSecret),
    asyncHandler(async (req: AuthedRequest, res) => {
      const videoId = req.params.id;
      const parsed = z.object({ body: z.string().min(1).max(5000) }).safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'invalid_body');

      const id = crypto.randomUUID();
      await db.run(
        `INSERT INTO comments (id, video_id, user_id, body, created_at)
         VALUES (:id, :video_id, :user_id, :body, :created_at)`,
        { id, video_id: videoId, user_id: req.user!.id, body: parsed.data.body, created_at: Date.now() }
      );

      res.status(201).json({ id });
    })
  );

  app.post(
    '/api/channels/:channelUserId/subscribe',
    requireAuth(config.jwtAccessSecret),
    asyncHandler(async (req: AuthedRequest, res) => {
      const channelUserId = req.params.channelUserId;
      if (channelUserId === req.user!.id) throw new HttpError(400, 'cannot_subscribe_self');

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
        { s: req.user!.id, c: channelUserId, created_at: Date.now() }
      );

      res.json({ subscribed: true });
    })
  );

  app.get(
    '/api/me/subscriptions',
    requireAuth(config.jwtAccessSecret),
    asyncHandler(async (req: AuthedRequest, res) => {
      const rows = await db.all<any>(
        `SELECT u.id, u.username
         FROM subscriptions s
         JOIN users u ON u.id = s.channel_user_id
         WHERE s.subscriber_user_id = :id
         ORDER BY s.created_at DESC`,
        { id: req.user!.id }
      );

      res.json({ items: rows });
    })
  );

  app.post(
    '/api/reports',
    requireAuth(config.jwtAccessSecret),
    asyncHandler(async (req: AuthedRequest, res) => {
      const parsed = z
        .object({
          videoId: z.string().uuid().optional(),
          commentId: z.string().uuid().optional(),
          reason: z.string().min(1).max(500)
        })
        .refine((x) => !!x.videoId || !!x.commentId, { message: 'videoId or commentId required' })
        .safeParse(req.body);

      if (!parsed.success) throw new HttpError(400, 'invalid_body', undefined, parsed.error.flatten());

      const id = crypto.randomUUID();
      await db.run(
        `INSERT INTO reports (id, reporter_user_id, video_id, comment_id, reason, created_at)
         VALUES (:id, :reporter_user_id, :video_id, :comment_id, :reason, :created_at)`,
        {
          id,
          reporter_user_id: req.user!.id,
          video_id: parsed.data.videoId || null,
          comment_id: parsed.data.commentId || null,
          reason: parsed.data.reason,
          created_at: Date.now()
        }
      );

      res.status(201).json({ id });
    })
  );

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.use(errorHandler);
  return app;
}
