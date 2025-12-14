import fs from 'node:fs';
import path from 'node:path';

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

export type Storage = {
  kind: 'fs' | 's3';
  ensureDirs: () => Promise<void>;
  storeOriginalFromTmp: (videoId: string, tmpPath: string, mimeType: string) => Promise<{ objectKey: string }>;
  publicUrlForKey: (objectKey: string) => string;
  resolveFsPathForKey?: (objectKey: string) => string;
};

async function renameOrCopy(src: string, dst: string) {
  try {
    await fs.promises.rename(src, dst);
  } catch (e: any) {
    if (e?.code !== 'EXDEV') throw e;
    await fs.promises.copyFile(src, dst);
    await fs.promises.unlink(src);
  }
}

function safeJoin(baseDir: string, objectKey: string): string {
  const cleaned = objectKey.replaceAll('\\', '/').replace(/^\/+/, '');
  const absBase = path.resolve(baseDir) + path.sep;
  const abs = path.resolve(baseDir, cleaned);
  if (!abs.startsWith(absBase)) throw new Error('path_traversal');
  return abs;
}

export function createFsStorage(baseDir: string, publicBaseUrl: string): Storage {
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
    storeOriginalFromTmp: async (videoId, tmpPath, _mimeType) => {
      const objectKey = `original/${videoId}/source`;
      const dst = safeJoin(absBase, objectKey);
      await fs.promises.mkdir(path.dirname(dst), { recursive: true });
      await renameOrCopy(tmpPath, dst);
      return { objectKey };
    },
    publicUrlForKey: (objectKey) => `${publicBaseUrl}/media/${objectKey.replaceAll('\\', '/')}`,
    resolveFsPathForKey: (objectKey) => safeJoin(absBase, objectKey)
  };
}

export function createS3Storage(opts: {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicBaseUrl: string;
}): Storage {
  const client = new S3Client({
    region: opts.region,
    endpoint: opts.endpoint,
    credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    forcePathStyle: true
  });

  return {
    kind: 's3',
    ensureDirs: async () => {
      return;
    },
    storeOriginalFromTmp: async (videoId, tmpPath, mimeType) => {
      const objectKey = `original/${videoId}/source`;
      const body = fs.createReadStream(tmpPath);
      await client.send(
        new PutObjectCommand({
          Bucket: opts.bucket,
          Key: objectKey,
          Body: body,
          ContentType: mimeType
        })
      );
      await fs.promises.unlink(tmpPath).catch(() => {});
      return { objectKey };
    },
    publicUrlForKey: (objectKey) => `${opts.publicBaseUrl.replace(/\/+$/, '')}/${objectKey.replaceAll('\\', '/')}`
  };
}
