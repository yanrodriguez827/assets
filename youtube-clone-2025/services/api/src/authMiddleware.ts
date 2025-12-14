import type { Response, NextFunction } from 'express';
import type { AuthedRequest } from './http.js';
import { HttpError } from './http.js';
import { verifyJwt } from './security.js';

export function requireAuth(accessSecret: string) {
  return (req: AuthedRequest, _res: Response, next: NextFunction) => {
    const h = req.header('authorization');
    if (!h?.startsWith('Bearer ')) return next(new HttpError(401, 'missing_token'));
    const token = h.slice('Bearer '.length);
    try {
      const decoded = verifyJwt<{ userId: string; username: string; role: string }>(token, accessSecret);
      req.user = { id: decoded.userId, username: decoded.username, role: decoded.role };
      return next();
    } catch {
      return next(new HttpError(401, 'invalid_token'));
    }
  };
}

export function requireAdmin() {
  return (req: AuthedRequest, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new HttpError(401, 'missing_token'));
    if (req.user.role !== 'admin') return next(new HttpError(403, 'forbidden'));
    return next();
  };
}
