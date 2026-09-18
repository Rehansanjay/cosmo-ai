import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { TokenSource } from 'cosmo-ai';
import { useRealtimeSession } from 'cosmo-ai/react';

import { navigatorAgent } from './agent';
import { player } from './player';
import { formatBriefing, formatTimestamp, type VideoInfo } from './transcript';

// No key in page code: the page asks its own /token route (the vite.config
// tokenRoute plugin in dev; the same mint call in a real route when
// deployed) and the SDK keeps the short-lived token fresh.

const PLAYER_ELEMENT_ID = 'yt-player';

const STATUS: Record<string, string> = {
  idle: 'Start a session, then ask aloud.',
  starting: 'Connecting and requesting microphone access…',
  live: 'Listening — answers appear on the video.',
  ending: 'Ending session…',
};

type LoadPhase = 'idle' | 'fetching' | 'ready';

export function App() {
  const [url, setUrl] = useState('');
  const [loadPhase, setLoadPhase] = useState<LoadPhase>('idle');
  const [video, setVideo] = useState<VideoInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { caption, jumps } = useSyncExternalStore(player.subscribe, player.getState);

  const { phase, start, end, error } = useRealtimeSession({
    makeAgent: (live) => {
      if (!video) throw new Error('No video loaded.');
      return live.agent(navigatorAgent(player, video));
    },
    clientOptions: { token: TokenSource.endpoint('/token') },
  });

  // yt-dlp fetches metadata and captions only — the video itself streams
  // through YouTube's embedded player, so a load takes seconds.
  const load = useCallback(async () => {
    setLoadPhase('fetching');
    setLoadError(null);
    try {
      const response = await fetch(`/api/video?url=${encodeURIComponent(url)}`);
      const payload: VideoInfo | { error: string } = await response.json();
      if (!response.ok || 'error' in payload) {
        throw new Error(
          'error' in payload
            ? payload.error
            : 'Couldn’t load this video. Check that the URL is public and has captions.',
        );
      }
      player.reset();
      setVideo(payload);
      setLoadPhase('ready');
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
      setLoadPhase(video ? 'ready' : 'idle');
    }
  }, [url, video]);

  useEffect(() => {
    if (video) void player.load(PLAYER_ELEMENT_ID, video.id);
  }, [video]);

  const live = phase === 'live';
  // The agent's briefing is fixed at session start, so swapping videos
  // mid-session would leave it navigating the old one.
  const loadLocked = loadPhase === 'fetching' || phase !== 'idle';

  return (
    <main>
      <header>
        <h1>Video Navigator</h1>
        <p>
          Load a YouTube video, then just ask — “when did they add the paneer?”, “what happens
          after simmering?” — and the agent jumps the video there. It never talks back.
        </p>
      </header>

      <form
        aria-busy={loadPhase === 'fetching'}
        onSubmit={(event) => {
          event.preventDefault();
          void load();
        }}
      >
        <label htmlFor="video-url">YouTube video URL</label>
        <div className="load-row">
          <input
            id="video-url"
            type="url"
            placeholder="https://www.youtube.com/watch?v=…"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            disabled={loadLocked}
            required
          />
          <button type="submit" disabled={loadLocked || url.length === 0}>
            {loadPhase === 'fetching'
              ? 'Loading video and transcript…'
              : video
                ? 'Load another video'
                : 'Load video'}
          </button>
        </div>
        <p className="hint">
          {phase !== 'idle'
            ? 'End the current session before loading another video.'
            : 'Use a public YouTube video with captions — narrated videos work best.'}
        </p>
      </form>
      {loadError && (
        <p className="error" role="alert">
          {loadError}
        </p>
      )}

      {video && (
        <section className="stage">
          <h2>{video.title}</h2>
          <div className="frame">
            <div className="embed">
              <div id={PLAYER_ELEMENT_ID} />
            </div>
            {caption && (
              <div className="caption" role="status" aria-live="polite" title={caption}>
                {caption}
              </div>
            )}
          </div>
          <div className="controls">
            {live ? (
              <button type="button" className="secondary" onClick={() => void end()}>
                End voice session
              </button>
            ) : (
              <button type="button" onClick={() => void start({ storeRecording: true })} disabled={phase !== 'idle'}>
                {phase === 'starting' ? 'Connecting…' : 'Start voice session'}
              </button>
            )}
            <p className="status">
              <span className={`dot dot-${phase}`} aria-hidden="true" /> {STATUS[phase]}
            </p>
          </div>
          <p className="hint">
            Uses your microphone; the agent responds only by jumping the video. This demo stores
            the session recording.
          </p>
          {error && (
            <p className="error" role="alert">
              {error.message}
            </p>
          )}

          <section className="history" aria-labelledby="history-title">
            <h3 id="history-title">Jump history</h3>
            {jumps.length === 0 ? (
              <p className="hint">Ask a question to create your first jump.</p>
            ) : (
              <ol className="jumps">
                {jumps.map((jump, index) => (
                  <li key={index}>
                    <button
                      type="button"
                      className="jump"
                      onClick={() => player.seek(jump.seconds, jump.caption)}
                    >
                      <span className="jump-time">{formatTimestamp(jump.seconds)}</span>
                      <span>{jump.caption}</span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <details className="transcript">
            <summary>Agent context · {video.cues.length} transcript cues</summary>
            <pre>{formatBriefing(video)}</pre>
          </details>
        </section>
      )}
    </main>
  );
}
