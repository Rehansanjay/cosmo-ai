import type { AgentConfig } from 'cosmo-ai';

import type { GameStore } from './game/state';
import { GREETING, INSTRUCTIONS, VOICE } from './persona';

/**
 * The commentator. It holds no tools and no skills: the game runs itself, and
 * the live position is pushed to it on every change, so there is nothing for
 * it to fetch and nothing for it to move. That is the whole point — an agent
 * with no way to act cannot stall the thing it is watching.
 */
export function runnersAgent(_store: GameStore): AgentConfig {
  return {
    instructions: INSTRUCTIONS,
    greeting: GREETING,
    voice: VOICE,
    model: 'openai',
    // Background-voice cancellation, off unless asked for. A far-field mic
    // otherwise hands the transcriber faint room speech, which becomes
    // confident nonsense that the agent then answers in good faith.
    audio: { noiseCancellation: 'voice_focus' },
    hooks: [
      // One nudge, and only after a genuinely long silence. `on_user_speech`
      // would reset the counter, so in a noisy room it fires without limit.
      {
        trigger: 'user.speech.timeout',
        timeout_seconds: 120,
        reset_mode: 'never',
        max_count: 1,
        action: {
          type: 'say',
          prompt:
            'The table has been quiet a long while. One short, light line — then go back to waiting.',
        },
      },
    ],
  };
}
