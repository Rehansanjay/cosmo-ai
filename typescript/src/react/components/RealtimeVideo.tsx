'use client';

import { useEffect, useRef } from 'react';

import { useRealtimeSessionContext } from '../RealtimeProvider';

/** Plays the session's remote video — an avatar renderer speaking for the
 *  agent — into a ``<video>`` the caller styles. A session without a
 *  renderer never gets a track, so the element stays empty; size it with
 *  ``className`` and hide it yourself when nothing is playing.
 *
 *  Muted on purpose: the renderer's audio arrives as a separate track that
 *  <RealtimeAudio/> already plays, and a second sink would double it. */
export function RealtimeVideo({ className }: { className?: string }): React.ReactElement {
  const session = useRealtimeSessionContext();
  const ref = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (session === null || el === null) return;
    session.attachVideoElement(el);
    return () => {
      session.attachVideoElement(null);
    };
  }, [session]);

  return <video ref={ref} className={className} autoPlay muted playsInline />;
}
