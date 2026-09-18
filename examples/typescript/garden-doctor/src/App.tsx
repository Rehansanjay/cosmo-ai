import { useCallback, useEffect, useState } from 'react';

import { SessionStartError, TokenSource } from 'cosmo-ai';
import { RealtimeProvider, useRealtimeSession } from 'cosmo-ai/react';

import { gardenDoctorAgent } from './agent';
import { useCamera } from './camera/use_camera';
import { LiveView } from './LiveView';

// No key in page code: /token mints short-lived tokens in both modes — the
// vite.config tokenRoute plugin under `vite dev`, the deployed Function
// otherwise.

// A built bundle is a deployed one: its key stays server-side in the /token
// Function, so what the box collects is an access password the page trades
// for short-lived end-user tokens.
const HOSTED = import.meta.env.PROD;

// Same-origin by default. A build that doesn't ship next to its Function —
// e.g. bundled into a native shell — names the deployed endpoint absolutely.
const TOKEN_ENDPOINT = import.meta.env.VITE_TOKEN_ENDPOINT || '/token';

/** Stable per-browser identity for hosted mode — Cosmo meters and scopes per
 *  this id, so each visitor gets their own auto-provisioned project. */
function externalUserId(): string {
  const KEY = 'garden-doctor-user';
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = `visitor-${crypto.randomUUID()}`;
    localStorage.setItem(KEY, id);
  }
  return id;
}

function mintHeaders(password: string): Record<string, string> {
  return { authorization: `Bearer ${password}`, 'x-external-user-id': externalUserId() };
}

export function App() {
  const camera = useCamera();
  const [credential, setCredential] = useState('');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraWarning, setCameraWarning] = useState<string | null>(null);

  // The hook owns the session lifecycle: a single-use client per run, the
  // mic released before the next start, every exit path funnelled into one
  // teardown. The camera stays this app's job.
  const { phase, session, start, end, error, warning, endedReason } = useRealtimeSession({
    makeAgent: (c) => c.agent(gardenDoctorAgent()),
    // One path, either mode: /token mints, TokenSource keeps one fresh.
    // Hosted sends the box's access password; dev sends only the visitor id.
    clientOptions: {
      token: TokenSource.endpoint(TOKEN_ENDPOINT, {
        headers: () =>
          HOSTED ? mintHeaders(credential) : { 'x-external-user-id': externalUserId() },
      }),
    },
  });

  // Whatever ended the session — End button, hangup tool, network loss —
  // the camera goes with it.
  const stopCamera = camera.stop;
  useEffect(() => {
    if (phase === 'ending') void stopCamera();
  }, [phase, stopCamera]);

  const startVisit = useCallback(async () => {
    if ((HOSTED && !credential) || phase !== 'idle') return;
    setCameraError(null);
    setCameraWarning(null);

    try {
      await camera.start();
    } catch (err) {
      console.error('[garden-doctor] camera denied', err);
      setCameraError('The doctor needs the camera — allow access and try again.');
      return;
    }

    const result = await start();
    if (!result.ok) {
      await camera.stop();
      return;
    }
    const session = result.session;
    try {
      await camera.publish(session);
    } catch (err) {
      console.error('[garden-doctor] camera publish failed', err);
      setCameraWarning('The camera is not streaming — the doctor cannot see.');
    }
  }, [camera, credential, phase, start]);

  if (phase === 'live') {
    return (
      <RealtimeProvider session={session}>
        <LiveView
          stream={camera.stream}
          mirrored={camera.facingMode === 'user'}
          canFlip={camera.canFlip}
          onFlip={() => void camera.flip()}
          onEnd={() => void end()}
          warning={warning ?? cameraWarning}
        />
      </RealtimeProvider>
    );
  }

  // Refresh-abandoned sessions are reclaimed after a short window; a fresh
  // start can 429 until then. Say so instead of the raw error.
  const startError =
    error === null
      ? null
      : error instanceof SessionStartError && error.code === 'busy'
        ? 'The line is busy — try again in a minute.'
        : error.message;

  return (
    <div className="start">
      <p className="eyebrow">Cosmo Realtime</p>
      <h1>Garden Doctor</h1>
      <p className="lede">
        A live house call for your plants: point the camera, ask out loud, and
        watch the doctor mark what it sees.
      </p>
      {HOSTED && (
        <input
          type="password"
          value={credential}
          placeholder="Access password"
          autoComplete="current-password"
          onChange={(event) => setCredential(event.target.value)}
        />
      )}
      {(cameraError ?? startError) !== null && <p className="err">{cameraError ?? startError}</p>}
      {endedReason !== null && <p className="note">{`Call ended (${endedReason}).`}</p>}
      <button
        className="btn primary"
        onClick={() => void startVisit()}
        disabled={(HOSTED && !credential) || phase !== 'idle'}
      >
        {phase === 'starting' ? 'Connecting…' : 'Start the visit'}
      </button>
      {HOSTED && (
        <p className="fine">
          This deployment keeps its Cosmo key server-side; the password lets
          the page mint its own short-lived tokens.
        </p>
      )}
    </div>
  );
}
