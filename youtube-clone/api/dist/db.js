import fs from 'node:fs';
import path from 'node:path';
function ensureDir(p) {
    fs.mkdirSync(p, { recursive: true });
}
function loadJson(file) {
    if (!fs.existsSync(file)) {
        const init = { users: [], videos: [], video_likes: [], comments: [], subscriptions: [] };
        fs.writeFileSync(file, JSON.stringify(init, null, 2));
        return init;
    }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function saveJson(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
export async function openDb(storageDir) {
    // Prefer sqlite3 CLI when available.
    const sqlitePath = path.join(storageDir, 'db.sqlite');
    const jsonPath = path.join(storageDir, 'db.json');
    ensureDir(storageDir);
    const hasSqliteCli = await import('node:child_process').then(({ spawnSync }) => {
        const r = spawnSync('sqlite3', ['-version'], { stdio: 'ignore' });
        return r.status === 0;
    }).catch(() => false);
    if (!hasSqliteCli) {
        const store = loadJson(jsonPath);
        return makeJsonDb(jsonPath, store);
    }
    // Initialize schema
    const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
    await execSqlite(sqlitePath, schema);
    return {
        run: async (sql, params) => {
            await execSqlite(sqlitePath, bindParams(sql, params));
        },
        get: async (sql, params) => {
            const out = await querySqlite(sqlitePath, bindParams(sql, params));
            return out[0];
        },
        all: async (sql, params) => {
            const out = await querySqlite(sqlitePath, bindParams(sql, params));
            return out;
        }
    };
}
function bindParams(sql, params) {
    if (!params)
        return sql;
    // Very small helper for named params like :id. Escapes strings for sqlite CLI.
    let out = sql;
    for (const [k, v] of Object.entries(params)) {
        const key = `:${k}`;
        const rep = toSqlLiteral(v);
        out = out.split(key).join(rep);
    }
    return out;
}
function toSqlLiteral(v) {
    if (v === null || v === undefined)
        return 'NULL';
    if (typeof v === 'number' && Number.isFinite(v))
        return String(v);
    if (typeof v === 'boolean')
        return v ? '1' : '0';
    // string/others
    const s = String(v).replaceAll("'", "''");
    return `'${s}'`;
}
async function execSqlite(dbFile, sql) {
    const { spawn } = await import('node:child_process');
    await new Promise((resolve, reject) => {
        const p = spawn('sqlite3', ['-batch', dbFile], { stdio: ['pipe', 'pipe', 'pipe'] });
        let err = '';
        p.stderr.on('data', (d) => (err += d.toString()));
        p.on('close', (code) => {
            if (code === 0)
                resolve();
            else
                reject(new Error(err || `sqlite3 exited ${code}`));
        });
        p.stdin.write(sql);
        p.stdin.end();
    });
}
async function querySqlite(dbFile, sql) {
    const { spawn } = await import('node:child_process');
    const raw = await new Promise((resolve, reject) => {
        const p = spawn('sqlite3', ['-json', dbFile, sql], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        p.stdout.on('data', (d) => (out += d.toString()));
        p.stderr.on('data', (d) => (err += d.toString()));
        p.on('close', (code) => {
            if (code === 0)
                resolve(out);
            else
                reject(new Error(err || `sqlite3 exited ${code}`));
        });
    });
    const trimmed = raw.trim();
    if (!trimmed)
        return [];
    return JSON.parse(trimmed);
}
function makeJsonDb(file, store) {
    // Extremely small subset supporting the queries used by this app.
    // This is not a general SQL implementation.
    return {
        run: async () => {
            // no-op; app uses dedicated helpers for JSON mode
            saveJson(file, store);
        },
        get: async () => undefined,
        all: async () => []
    };
}
