import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';

export type Storage = {
  kind: 'fs' | 's3';
  ensureDirs: () => Promise<void>;
  downloadObjectToFile: (objectKey: string, localPath: string) => Promise<void>;
  uploadDirToPrefix: (localDir: string, prefix: string) => Promise<void>;
  deletePrefix: (prefix: string) => Promise<void>;
  resolveFsPathForKey?: (objectKey: string) => string;
};

function safeJoin(baseDir: string, objectKey: string): string {
  const cleaned = objectKey.replaceAll('\\', '/').replace(/^\/+/, '');
  const absBase = path.resolve(baseDir) + path.sep;
  const abs = path.resolve(baseDir, cleaned);
  if (!abs.startsWith(absBase)) throw new Error('path_traversal');
  return abs;
}

async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkFiles(p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function mimeForPath(p: string): string {
  if (p.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (p.endsWith('.ts')) return 'video/mp2t';
  return 'application/octet-stream';
}

export function createFsStorage(baseDir: string): Storage {
  const absBase = path.resolve(baseDir);
  const tmpDir = path.join(absBase, 'tmp');

  return {
    kind: 'fs',
    ensureDirs: async () => {
      await fs.promises.mkdir(absBase, { recursive: true });
      await fs.promises.mkdir(tmpDir, { recursive: true });
      await fs.promises.mkdir(path.join(absBase, 'original'), { recursive: true });
      await fs.promises.mkdir(path.join(absBase, 'hls'), { recursive: true });
    },
    resolveFsPathForKey: (objectKey) => safeJoin(absBase, objectKey),
    downloadObjectToFile: async (objectKey, localPath) => {
      const src = safeJoin(absBase, objectKey);
      await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
      await fs.promises.copyFile(src, localPath);
    },
    uploadDirToPrefix: async (localDir, prefix) => {
      const files = await walkFiles(localDir);
      for (const f of files) {
        const rel = path.relative(localDir, f).replaceAll('\\', '/');
        const objectKey = `${prefix.replace(/\/+$/, '')}/${rel}`.replace(/^\/+/, '');
        const dst = safeJoin(absBase, objectKey);
        await fs.promises.mkdir(path.dirname(dst), { recursive: true });
        await fs.promises.copyFile(f, dst);
      }
    },
    deletePrefix: async (prefix) => {
      const dir = safeJoin(absBase, prefix.replace(/\/+$/, ''));
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  };
}

export function createS3Storage(opts: { endpoint: string; region: string; accessKeyId: string; secretAccessKey: string; bucket: string }): Storage {
  const client = new S3Client({
    region: opts.region,
    endpoint: opts.endpoint,
    credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    forcePathStyle: true
  });

  return {
    kind: 's3',
    ensureDirs: async () => {},
    deletePrefix: async (prefix) => {
      const clean = prefix.replace(/^\/+/, '').replace(/\/+$/, '') + '/';
      let token: string | undefined = undefined;
      while (true) {
        const listed: any = await client.send(
          new ListObjectsV2Command({
            Bucket: opts.bucket,
            Prefix: clean,
            ContinuationToken: token
          })
        );
        const keys = (listed.Contents || []).map((c: any) => c.Key).filter(Boolean) as string[];
        for (const k of keys) {
          await client.send(new DeleteObjectCommand({ Bucket: opts.bucket, Key: k }));
        }
        if (!listed.IsTruncated) break;
        token = listed.NextContinuationToken;
      }
    },
    downloadObjectToFile: async (objectKey, localPath) => {
      const r = await client.send(new GetObjectCommand({ Bucket: opts.bucket, Key: objectKey }));
      const body = r.Body as any;
      if (!body) throw new Error('s3_missing_body');
      const stream: Readable = body instanceof Readable ? body : Readable.from(body);
      await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
      await new Promise<void>((resolve, reject) => {
        const w = fs.createWriteStream(localPath);
        stream.pipe(w);
        w.on('finish', () => resolve());
        w.on('error', reject);
        stream.on('error', reject);
      });
    },
    uploadDirToPrefix: async (localDir, prefix) => {
      const files = await walkFiles(localDir);
      const cleanPrefix = prefix.replace(/^\/+/, '').replace(/\/+$/, '');
      for (const f of files) {
        const rel = path.relative(localDir, f).replaceAll('\\', '/');
        const key = `${cleanPrefix}/${rel}`;
        await client.send(
          new PutObjectCommand({
            Bucket: opts.bucket,
            Key: key,
            Body: fs.createReadStream(f),
            ContentType: mimeForPath(f)
          })
        );
      }
    }
  };
}
