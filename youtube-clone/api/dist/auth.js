import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
export function signJwt(payload, secret, expiresIn) {
    return jwt.sign(payload, secret, { expiresIn });
}
export function hashPassword(password) {
    return bcrypt.hash(password, 10);
}
export function verifyPassword(password, hash) {
    return bcrypt.compare(password, hash);
}
export function authMiddleware(secret) {
    return (req, res, next) => {
        const h = req.header('authorization');
        if (!h?.startsWith('Bearer '))
            return res.status(401).json({ error: 'missing_token' });
        const token = h.slice('Bearer '.length);
        try {
            const decoded = jwt.verify(token, secret);
            req.user = { id: decoded.id, email: decoded.email, username: decoded.username };
            next();
        }
        catch {
            return res.status(401).json({ error: 'invalid_token' });
        }
    };
}
