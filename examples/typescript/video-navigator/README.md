# Video Navigator

A voice agent that never speaks. Load a YouTube video, then just ask —
"when did they add the paneer?", "what did they do after simmering?" — and
the agent jumps the video to that moment and lets it play. Its turns are
pure tool calls: the video itself is the answer, and a one-line caption on
screen is the only place the agent puts words.

What it demonstrates:

- **Tool-only turns** — an agent whose instructions forbid speech, so every
  response is a `seek` / `pause` / `resume` client tool call.
- **Client-supplied context** — the video's chapters, full timestamped
  transcript, and description are fetched on *your* machine and baked into
  the agent's instructions at session start. The Cosmo backend never touches
  YouTube.
- **A local capability server** — a dependency-free Node helper shells out
  to [yt-dlp](https://github.com/yt-dlp/yt-dlp) for metadata and captions
  (a couple of seconds per video) and caches them. The video itself streams
  through YouTube's own embedded player, driven via the IFrame Player API.

## Run it

You need a **current** `yt-dlp` on your PATH (`brew install yt-dlp` /
`pipx install yt-dlp`) — YouTube rotates its protocols often, and a stale
yt-dlp fails in confusing ways.

```bash
npm install
cosmo init             # once — signs in and stores the credential /token mints with

npm run yt-server      # terminal 1: the local yt-dlp helper (port 8793)
npm run dev            # terminal 2: the app (http://localhost:7893)
```

Paste a YouTube URL, wait a few seconds for the transcript, then
**Start talking**. The "What the agent sees" panel shows the exact briefing
the agent gets.

## How it fits together

```
you speak ──► Cosmo realtime session ──► tool call: seek(seconds, caption)
                    ▲                            │
   chapters + transcript + description           ▼
        in the agent instructions        YouTube IFrame player + caption overlay
                    │
   yt-dlp helper (localhost:8793) — captions and metadata only, cached locally
```

- `server/yt_dlp_server.mjs` — the helper: metadata, chapters, description,
  and English captions as json3, cached under `server/cache/`.
- `src/transcript.ts` — merges caption cues into `[m:ss]` windows and
  assembles the briefing (chapters → transcript → description).
- `src/agent.ts` — the silent-operator instructions plus the briefing.
- `src/tools.ts` — `seek` (with the on-screen caption), `pause`, `resume`.
- `src/player.ts` — the embedded YouTube player and jump history as a small
  external store shared by the tools and React.

## Notes

- Not every video narrates what it does: music-only cooking videos caption
  as pure `[Music]`, which the helper filters out. The description and
  chapters often carry the real steps, which is why they ride along — but a
  video with no speech, no chapters, and a bare description gives the agent
  little to navigate by. Narrated videos work best.
- The video plays out of your speakers while the mic is open; browser echo
  cancellation keeps the agent from hearing the video as you. Headphones
  make it airtight.
- Videos without English captions are still navigable if they have chapters
  or a detailed description; the helper only rejects a video that has none
  of the three.
