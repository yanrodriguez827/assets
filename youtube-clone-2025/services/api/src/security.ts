import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

export function sha256Hex(input: string) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}

export function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

export function signAccessToken(payload: { userId: string; username: string; role: string }, secret: string) {
  return jwt.sign(payload, secret, { expiresIn: '15m' });
}

export function signRefreshToken(payload: { sessionId: string; userId: string }, secret: string) {
  return jwt.sign(payload, secret, { expiresIn: '30d' });
}

export function verifyJwt<T>(token: string, secret: string): T {
  return jwt.verify(token, secret) as any as T;
}
