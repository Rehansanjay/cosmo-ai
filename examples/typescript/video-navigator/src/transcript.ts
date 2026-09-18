export interface Cue {
  /** Seconds from the start of the video. */
  start: number;
  text: string;
}

export interface Chapter {
  start: number;
  title: string;
}

export interface VideoInfo {
  id: string;
  title: string;
  durationSeconds: number;
  cues: Cue[];
  chapters: Chapter[];
  description: string;
}

// Auto-captions arrive as one cue every couple of seconds. The agent gets
// every word — merging only folds cues into short windows so a timestamp
// lands every few seconds, precise enough to seek mid-step.
const WINDOW_SECONDS = 8;

// Roughly an hour of dense speech. Longer videos get the head of the
// transcript plus a note, rather than a silently clipped context.
const MAX_TRANSCRIPT_CHARS = 90_000;

const MAX_DESCRIPTION_CHARS = 4_000;

export function formatTimestamp(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

function formatTranscript(cues: Cue[]): string {
  const lines: string[] = [];
  let windowStart = -1;
  let windowText: string[] = [];
  const flush = () => {
    if (windowText.length > 0) {
      lines.push(`[${formatTimestamp(windowStart)}] ${windowText.join(' ')}`);
    }
    windowText = [];
  };
  for (const cue of cues) {
    if (windowStart < 0 || cue.start - windowStart >= WINDOW_SECONDS) {
      flush();
      windowStart = cue.start;
    }
    windowText.push(cue.text);
  }
  flush();

  const full = lines.join('\n');
  if (full.length <= MAX_TRANSCRIPT_CHARS) return full;
  const cut = full.slice(0, MAX_TRANSCRIPT_CHARS);
  return `${cut.slice(0, cut.lastIndexOf('\n'))}\n[transcript truncated — the video continues beyond this point]`;
}

/**
 * Everything the agent gets about the video, as one document: chapters when
 * the uploader set them, every spoken word with timestamps, and the
 * description — which on recipe and tutorial videos often carries the full
 * written steps that a music-only video never says out loud.
 */
export function formatBriefing(video: VideoInfo): string {
  const sections: string[] = [];
  if (video.chapters.length > 0) {
    sections.push(
      'Chapters:\n' +
        video.chapters
          .map((chapter) => `[${formatTimestamp(chapter.start)}] ${chapter.title}`)
          .join('\n'),
    );
  }
  sections.push(
    video.cues.length > 0
      ? `Spoken transcript, with timestamps:\n${formatTranscript(video.cues)}`
      : 'Spoken transcript: none — this video has no usable speech. Navigate by ' +
          'the chapters and description instead.',
  );
  if (video.description.trim().length > 0) {
    sections.push(`Video description:\n${video.description.slice(0, MAX_DESCRIPTION_CHARS)}`);
  }
  return sections.join('\n\n');
}
