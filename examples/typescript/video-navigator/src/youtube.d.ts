// The slice of the YouTube IFrame Player API this app uses.
// https://developers.google.com/youtube/iframe_api_reference

declare namespace YT {
  class Player {
    constructor(
      elementId: string,
      options: {
        videoId: string;
        width?: string;
        height?: string;
        playerVars?: Record<string, string | number>;
        events?: { onReady?: () => void };
      },
    );
    seekTo(seconds: number, allowSeekAhead: boolean): void;
    playVideo(): void;
    pauseVideo(): void;
    getDuration(): number;
    destroy(): void;
  }
}

interface Window {
  YT?: { Player: typeof YT.Player };
  onYouTubeIframeAPIReady?: () => void;
}
