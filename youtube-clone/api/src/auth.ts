import jwt, { type Secret, type SignOptions } from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import type { Request, Response, NextFunction } from 'express';

export type AuthedRequest = Request & { user?: { id: string; email: string; username: string } };

export function signJwt(
  payload: { id: string; email: string; username: string },
  secret: Secret,
  expiresIn: SignOptions['expiresIn']
) {
  return jwt.sign(payload, secret, { expiresIn });
}

export function hashPassword(password: string) {
  return bcrypt.hash(password, 10);
}

export function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

export function authMiddleware(secret: Secret) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const h = req.header('authorization');
    if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'missing_token' });
    const token = h.slice('Bearer '.length);
    try {
      const decoded = jwt.verify(token, secret) as any;
      req.user = { id: decoded.id, email: decoded.email, username: decoded.username };
      next();
    } catch {
      return res.status(401).json({ error: 'invalid_token' });
    }
  };
}
