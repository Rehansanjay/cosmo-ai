import { useCallback, useEffect, useRef, useState } from 'react';

import { RealtimeClient, TokenSource, type RealtimeSession } from 'cosmo-ai';
import { RealtimeProvider } from 'cosmo-ai/react';

import { runnersAgent } from './agent';
import { GameStore, type Seats } from './game/state';
import { LiveView } from './LiveView';

// No key in page code: the /token route (vite.config's tokenRoute plugin in
// dev; a real route when deployed) mints short-lived tokens. The paste box
// below stays as an override for a deployment without one.

/** Dev convenience: connect on load instead of making someone click through
 *  the start screen every reload. Off unless asked for, via
 *  VITE_DEV_AUTOSTART=1 or ?autostart on the URL. */
const AUTOSTART =
  import.meta.env.DEV &&
  (import.meta.env.VITE_DEV_AUTOSTART === '1' ||
    new URLSearchParams(window.location.search).has('autostart'));

type Mode = 'hotseat' | 'engine';

const MODES: { id: Mode; title: string; blurb: string; seats: Seats }[] = [
  {
    id: 'engine',
    title: 'You vs the engine',
    blurb: 'A dice engine plays the other side instantly. Cosmo calls the game.',
    seats: { p1: { label: 'You', by: 'human' }, p2: { label: 'The Engine', by: 'bot' } },
  },
  {
    id: 'hotseat',
    title: 'Two players, one screen',
    blurb: 'Pass the laptop. Cosmo commentates both of you.',
    seats: { p1: { label: 'Player 1', by: 'human' }, p2: { label: 'Player 2', by: 'human' } },
  },
];

type Phase = 'idle' | 'starting' | 'live';

export function App() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [mode, setMode] = useState<Mode>('engine');
  const [apiKey, setApiKey] = useState('');
  const [session, setSession] = useState<RealtimeSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  // Built at kickoff so the chosen seats are baked in; a dropped call resumes
  // the same board.
  const storeRef = useRef<GameStore | null>(null);
  const sessionRef = useRef<RealtimeSession | null>(null);

  const handleEnded = useCallback((reason: string | null) => {
    // An abandoned session keeps the microphone it captured; close() resolves
    // once the release lands, and the start button stays disabled until then.
    const spent = sessionRef.current;
    sessionRef.current = null;
    setSession(null);
    setWarning(null);
    setNote(reason === null || reason === 'client_ended' ? null : `The game ended (${reason}).`);
    void (async () => {
      try {
        await spent?.close();
      } catch (err) {
        console.error('[runners] close failed', err);
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

    const seats = MODES.find((m) => m.id === mode)!.seats;
    const store = new GameStore(seats);
    storeRef.current = store;

    let live: RealtimeSession;
    try {
      const client = new RealtimeClient(
        apiKey.trim()
          ? { apiKey }
          : { token: TokenSource.endpoint('/token') },
      );
      live = await client.agent(runnersAgent(store)).start();
    } catch (err) {
      console.error('[runners] session start failed', err);
      // Refresh-abandoned sessions are reclaimed after a short window; a fresh
      // start can 429 until then. Say so instead of the raw error.
      const busy = (err as { status?: number }).status === 429;
      setError(
        busy
          ? 'The last session is still winding down — try again in a minute.'
          : 'Could not start a session. Check the /token route (or the pasted key) and try again.',
      );
      setPhase('idle');
      return;
    }

    sessionRef.current = live;

    live.on('ready', (ev) => {
      if (ev.rejectedTools.length === 0) return;
      // Detail to the console; the screen says only what a player can act on.
      console.error('[runners] server rejected tools', ev.rejectedTools);
      setWarning('Some features are unavailable on this backend.');
    });
    // Fires exactly once on any exit path — End button, the agent's own
    // end_call, network loss — so every teardown funnels through here.
    live.on('session_ended', (ev) => handleEnded(ev.reason ?? null));

    setSession(live);
    setPhase('live');
  }, [apiKey, phase, mode, handleEnded]);

  // One shot, on load only: a reconnect after End should be deliberate.
  const autostarted = useRef(false);
  useEffect(() => {
    if (!AUTOSTART || autostarted.current || phase !== 'idle') return;
    autostarted.current = true;
    void start();
  }, [phase, start]);

  const end = useCallback(async () => {
    // A clean end frees the server slot immediately (no 429 on restart); the
    // session_ended handler does the teardown.
    try {
      await sessionRef.current?.end();
    } catch (err) {
      console.error('[runners] end failed', err);
      handleEnded('client_ended');
    }
  }, [handleEnded]);

  if (phase === 'live' && session !== null && storeRef.current !== null) {
    return (
      <RealtimeProvider session={session}>
        <LiveView store={storeRef.current} warning={warning} onEnd={() => void end()} />
      </RealtimeProvider>
    );
  }

  return (
    <div className="start">
      <h1>Runners</h1>
      <p className="lede">
        Push your luck up the columns. Cosmo watches from the commentary booth
        and will not be kind about it.
      </p>

      <div className="modes">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`mode${m.id === mode ? ' picked' : ''}`}
            onClick={() => setMode(m.id)}
          >
            <b>{m.title}</b>
            <span>{m.blurb}</span>
          </button>
        ))}
      </div>

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
        {phase === 'starting' ? 'Shaking the dice…' : 'Start'}
      </button>
      <p className="fine">Headphones recommended.</p>
    </div>
  );
}
