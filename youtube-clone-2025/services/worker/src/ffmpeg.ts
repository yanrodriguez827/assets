import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export type MediaInfo = { durationSeconds: number | null; width: number | null; height: number | null };

function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('close', (code) => resolve({ code: code ?? 0, stdout: out, stderr: err }));
  });
}

export async function probeMedia(inputPath: string): Promise<MediaInfo> {
  const r = await run('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height:format=duration',
    '-of',
    'json',
    inputPath
  ]);

  if (r.code !== 0) {
    return { durationSeconds: null, width: null, height: null };
  }

  try {
    const j = JSON.parse(r.stdout);
    const width = Number(j?.streams?.[0]?.width);
    const height = Number(j?.streams?.[0]?.height);
    const duration = Number(j?.format?.duration);

    return {
      durationSeconds: Number.isFinite(duration) ? Math.round(duration) : null,
      width: Number.isFinite(width) ? width : null,
      height: Number.isFinite(height) ? height : null
    };
  } catch {
    return { durationSeconds: null, width: null, height: null };
  }
}

export async function transcodeToHls(inputPath: string, outDir: string, threads: number): Promise<void> {
  await fs.promises.mkdir(outDir, { recursive: true });

  const indexPath = path.join(outDir, 'index.m3u8');
  const segPattern = path.join(outDir, 'seg_%05d.ts');

  const args = [
    '-y',
    '-i',
    inputPath,
    '-threads',
    String(threads),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-profile:v',
    'main',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-ac',
    '2',
    '-ar',
    '48000',
    '-f',
    'hls',
    '-hls_time',
    '4',
    '-hls_playlist_type',
    'vod',
    '-hls_segment_filename',
    segPattern,
    indexPath
  ];

  const r = await run('ffmpeg', args);
  if (r.code !== 0) {
    throw new Error(`ffmpeg_failed:${r.stderr.slice(0, 2000)}`);
  }
}
