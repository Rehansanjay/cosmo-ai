import type { AgentTool } from 'cosmo-ai';
import { clientTool } from 'cosmo-ai/tool';
import { zodInput } from 'cosmo-ai/tool/zod';
import * as z from 'zod/v4';

import type { Player } from './player';

/**
 * The agent's entire vocabulary. It has no voice in this app — a request is
 * answered by seeking the video there, and the seek's caption is the only
 * place words appear.
 */
export function makeTools(player: Player): AgentTool[] {
  const seek = clientTool({
    name: 'seek',
    description:
      'Jump the video to a moment and play from there. This is how you answer ' +
      'every "when / where / show me" request: pick the timestamp from the ' +
      'transcript, land a few seconds before the moment so it plays into it. ' +
      'The caption is shown on screen and is your only channel for words.',
    input: zodInput(
      z.object({
        seconds: z.number().min(0).describe('Where to jump, in seconds from the start.'),
        caption: z
          .string()
          .describe('One short line saying what is at this moment, e.g. "Paneer goes in at 4:32".'),
      }),
    ),
    handler: async ({ seconds, caption }) => player.seek(seconds, caption),
  });

  const pause = clientTool({
    name: 'pause',
    description: 'Pause playback. Use when the user asks to stop, hold on, or wait.',
    input: zodInput(z.object({})),
    handler: async () => player.pause(),
  });

  const resume = clientTool({
    name: 'resume',
    description: 'Resume playback from wherever the video currently is.',
    input: zodInput(z.object({})),
    handler: async () => player.resume(),
  });

  return [seek, pause, resume];
}
