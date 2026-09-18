import { formatTimestamp } from './transcript';

export interface Jump {
  seconds: number;
  caption: string;
}

interface PlayerState {
  /** The agent's one channel for words — shown as an overlay on the video. */
  caption: string | null;
  jumps: Jump[];
}

type Listener = () => void;

const IFRAME_API = 'https://www.youtube.com/iframe_api';

/** Resolves once the IFrame API script has loaded, injecting it on first use. */
function ytApi(): Promise<typeof YT.Player> {
  return new Promise((resolve) => {
    if (window.YT) {
      resolve(window.YT.Player);
      return;
    }
    window.onYouTubeIframeAPIReady = () => resolve(window.YT!.Player);
    if (!document.querySelector(`script[src="${IFRAME_API}"]`)) {
      const script = document.createElement('script');
      script.src = IFRAME_API;
      document.head.appendChild(script);
    }
  });
}

/**
 * The embedded YouTube player plus the agent-visible state around it, as a
 * tiny external store. The tools mutate it; React reads it via
 * useSyncExternalStore. The player boots asynchronously, so every operation
 * tolerates "not ready yet" by reporting failure back to the model instead
 * of throwing.
 */
export class Player {
  private yt: YT.Player | null = null;
  private state: PlayerState = { caption: null, jumps: [] };
  private listeners = new Set<Listener>();

  /** Mount the player for a video into the container div. */
  async load(elementId: string, videoId: string): Promise<void> {
    const PlayerCtor = await ytApi();
    this.yt?.destroy();
    this.yt = null;
    const created: YT.Player = new PlayerCtor(elementId, {
      videoId,
      width: '100%',
      height: '100%',
      playerVars: { enablejsapi: 1, origin: window.location.origin, rel: 0 },
      events: { onReady: () => (this.yt = created) },
    });
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): PlayerState => this.state;

  private set(update: Partial<PlayerState>): void {
    this.state = { ...this.state, ...update };
    for (const listener of this.listeners) listener();
  }

  seek(seconds: number, caption: string): { ok: boolean; landedAt?: string; error?: string } {
    if (!this.yt) return { ok: false, error: 'The player is not ready yet.' };
    const target = Math.min(Math.max(0, seconds), Math.max(0, this.yt.getDuration() - 1));
    this.yt.seekTo(target, true);
    this.yt.playVideo();
    this.set({
      caption,
      jumps: [...this.state.jumps, { seconds: target, caption }],
    });
    return { ok: true, landedAt: formatTimestamp(target) };
  }

  pause(): { ok: boolean; error?: string } {
    if (!this.yt) return { ok: false, error: 'The player is not ready yet.' };
    this.yt.pauseVideo();
    return { ok: true };
  }

  resume(): { ok: boolean; error?: string } {
    if (!this.yt) return { ok: false, error: 'The player is not ready yet.' };
    this.yt.playVideo();
    return { ok: true };
  }

  reset(): void {
    this.set({ caption: null, jumps: [] });
  }
}

export const player = new Player();
