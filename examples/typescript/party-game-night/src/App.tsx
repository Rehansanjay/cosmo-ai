import { useCallback, useRef, useState } from 'react';

import { RealtimeClient, TokenSource, type RealtimeSession } from 'cosmo-ai';
import { RealtimeProvider } from 'cosmo-ai/react';

import { partyGameNightAgent } from './agent';
import { GameStore } from './game/state';
import { LiveView } from './LiveView';

// No key in page code: the /token route (vite.config's tokenRoute plugin in
// dev; a real route when deployed) mints short-lived tokens. The paste box
// below stays as an override for a deployment without one.

type Phase = 'idle' | 'starting' | 'live';

export function App() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [apiKey, setApiKey] = useState('');
  const [session, setSession] = useState<RealtimeSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  // One store for the whole evening: it survives across sessions, so a
  // dropped call resumes with the scores still on the strip.
  const storeRef = useRef<GameStore | null>(null);
  if (storeRef.current === null) storeRef.current = new GameStore();
  const store = storeRef.current;

  const sessionRef = useRef<RealtimeSession | null>(null);

  const handleEnded = useCallback((reason: string | null) => {
    // An abandoned session keeps the microphone it captured; close() resolves
    // once the release lands, and the start button stays disabled until then.
    const spent = sessionRef.current;
    sessionRef.current = null;
    setSession(null);
    setWarning(null);
    setNote(reason === null || reason === 'client_ended' ? null : `The show ended (${reason}).`);
    void (async () => {
      try {
        await spent?.close();
      } catch (err) {
        console.error('[party-game-night] close failed', err);
      }
      setPhase('idle');
    })();
  }, []);

  const start = useCallback(async () => {
    if (phase !== 'idle') return;
    setPhase('starting');
    setError(null);
    setNote(null);
    setWarning(null);

    let session: RealtimeSession;
    try {
      // Empty box → the app's own /token route; a pasted key overrides it.
      const live = new RealtimeClient(
        apiKey.trim() ? { apiKey } : { token: TokenSource.endpoint('/token') },
      );
      session = await live.agent(partyGameNightAgent(store)).start();
    } catch (err) {
      console.error('[party-game-night] session start failed', err);
      // Refresh-abandoned sessions are reclaimed after a short window; a
      // fresh start can 429 until then. Say so instead of the raw error.
      const busy = (err as { status?: number }).status === 429;
      setError(
        busy
          ? 'The stage is still busy — try again in a minute.'
          : err instanceof Error
            ? err.message
            : String(err),
      );
      setPhase('idle');
      return;
    }

    sessionRef.current = session;

    session.on('ready', (ev) => {
      if (ev.rejectedTools.length === 0) return;
      const names = ev.rejectedTools.map((tool) => tool.name).join(', ');
      console.error('[party-game-night] server rejected tools', ev.rejectedTools);
      setWarning(`This backend rejected: ${names}`);
    });
    // Fires exactly once on any exit path — End button, the MC's own
    // end_call, network loss — so every teardown funnels through here.
    session.on('session_ended', (ev) => handleEnded(ev.reason ?? null));

    setSession(session);
    setPhase('live');
  }, [apiKey, phase, store, handleEnded]);

  const end = useCallback(async () => {
    // A clean end frees the server slot immediately (no 429 on restart);
    // the session_ended handler does the teardown.
    try {
      await sessionRef.current?.end();
    } catch (err) {
      console.error('[party-game-night] end failed', err);
      handleEnded('client_ended');
    }
  }, [handleEnded]);

  if (phase === 'live' && session !== null) {
    return (
      <RealtimeProvider session={session}>
        <LiveView store={store} warning={warning} onEnd={() => void end()} />
      </RealtimeProvider>
    );
  }

  return (
    <div className="start">
      <div className="marquee">
        <p className="eyebrow">Cosmo Realtime presents</p>
        <h1>
          Party
          <br />
          Game Night
        </h1>
      </div>
      <p className="lede">
        An AI game-show host on your TV: it conjures the board, flips the
        answers you shout, and keeps score — one device, the whole room playing.
      </p>
      <input
        type="password"
        value={apiKey}
        placeholder="API key (optional — the /token route is used when empty)"
        autoComplete="off"
        onChange={(event) => setApiKey(event.target.value)}
      />
      {error !== null && <p className="err">{error}</p>}
      {note !== null && <p className="note">{note}</p>}
      <button
        className="btn primary"
        onClick={() => void start()}
        disabled={phase === 'starting'}
      >
        {phase === 'starting' ? 'Warming up the stage…' : 'Start game night'}
      </button>
      <p className="fine">Best on the biggest screen in the room, volume up.</p>
    </div>
  );
}
