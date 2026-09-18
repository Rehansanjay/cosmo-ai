// Local yt-dlp helper for the video-navigator example.
//
// The browser cannot run yt-dlp, so this tiny server does it on the caller's
// own machine: the transcript is fetched with the user's IP and cached
// locally — nothing about the video ever touches the Cosmo backend. Only
// metadata and captions are downloaded; the video itself streams from
// YouTube's own embedded player.
//
//   GET /api/video?url=<youtube-url>
//     → { id, title, durationSeconds, cues, chapters, description }
//
// Requires yt-dlp on PATH. No npm dependencies.

import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT ?? 8793);
const CACHE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cache');

function ytDlp(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`yt-dlp exited ${code}: ${err.slice(-2000)}`));
    });
  });
}

/** json3 caption events → [{ start, text }], seconds and plain text.
 *  Sound tags ([Music], [Applause]) are noise, not speech — a music-backed
 *  video produces a transcript of nothing but them. */
function parseJson3(raw) {
  const events = JSON.parse(raw).events ?? [];
  const cues = [];
  for (const event of events) {
    const text = (event.segs ?? [])
      .map((seg) => seg.utf8 ?? '')
      .join('')
      .replace(/\[[^\]]*\]?|^[^[]*\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) cues.push({ start: Math.round((event.tStartMs ?? 0) / 1000), text });
  }
  return cues;
}

async function cachedFile(prefix, extension) {
  const entries = await readdir(CACHE_DIR).catch(() => []);
  const name = entries.find((entry) => entry.startsWith(prefix) && entry.endsWith(extension));
  return name ? path.join(CACHE_DIR, name) : null;
}

async function resolveVideo(url) {
  await mkdir(CACHE_DIR, { recursive: true });

  const info = JSON.parse(await ytDlp(['-J', '--no-download', url]));
  const { id, title } = info;
  const durationSeconds = Math.round(info.duration ?? 0);
  // Narration is not the only map of a video: chapters carry timestamped
  // structure, and recipe/tutorial descriptions often carry the full steps.
  const chapters = (info.chapters ?? []).map((chapter) => ({
    start: Math.round(chapter.start_time ?? 0),
    title: chapter.title ?? '',
  }));
  const description = info.description ?? '';

  let captionsPath = await cachedFile(`${id}.`, '.json3');
  if (!captionsPath) {
    // Uploaded captions when they exist, auto-generated otherwise.
    await ytDlp([
      '--skip-download',
      '--write-subs',
      '--write-auto-subs',
      '--sub-langs',
      'en.*,en',
      '--sub-format',
      'json3',
      '-o',
      path.join(CACHE_DIR, '%(id)s'),
      url,
    ]);
    captionsPath = await cachedFile(`${id}.`, '.json3');
  }
  // No captions is not fatal — chapters and the description may still map
  // the video — but nothing at all leaves the agent blind, so reject that.
  const cues = captionsPath ? parseJson3(await readFile(captionsPath, 'utf8')) : [];
  if (cues.length === 0 && chapters.length === 0 && description.trim().length === 0) {
    throw new Error('This video has no captions, chapters, or description to navigate by.');
  }

  return { id, title, durationSeconds, cues, chapters, description };
}

const inFlight = new Map();

createServer(async (req, res) => {
  const { pathname, searchParams } = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (pathname === '/api/video') {
      const url = searchParams.get('url');
      if (!url) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing ?url=' }));
        return;
      }
      // Coalesce a re-submitted URL onto the fetch already running for it.
      if (!inFlight.has(url)) {
        inFlight.set(url, resolveVideo(url).finally(() => inFlight.delete(url)));
      }
      const payload = await inFlight.get(url);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    } else {
      res.writeHead(404).end();
    }
  } catch (error) {
    console.error(error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
}).listen(PORT, () => {
  console.log(`yt-dlp helper on http://localhost:${PORT} (cache: ${CACHE_DIR})`);
});
