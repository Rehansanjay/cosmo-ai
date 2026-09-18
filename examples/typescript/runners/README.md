# Commentate on a board game with AI — Runners

A push-your-luck dice game with a voice commentator. You play against a dice
engine; a Cosmo realtime agent watches and calls the action.

The game is scenery. What this example is really about is **when an app may
take the conversational floor** — the problem every app hits the moment it
wants to tell a live agent something.

## Run it

```bash
npm install
cosmo init            # once — signs in and stores the credential /token mints with
npm run dev
```

The key needs the `realtime:start` scope (**Voice — start sessions**), from Developer platform → API keys in
the Cosmo web app, and it must come from the same backend `VITE_COSMO_BASE_URL`
points at or the session 401s. With no key in `.env` the start screen asks for
one.

```bash
npm test          # rules engine, opponent engine, and the send scheduler
npm run typecheck
```

## What it demonstrates

| SDK surface | Where |
| --- | --- |
| `sendContext` — state the model is never asked to answer | `sender.ts`, `sendState` |
| `sendText` — the only way to ask for a spoken reply | `sender.ts`, `nudge` |
| `agent_state` + `transcript` as a floor-control signal | `sender.ts`, `floor` |
| Provider selection via `model` | `agent.ts` |
| Background-voice cancellation | `agent.ts`, `audio` |

## The one thing worth copying

**There are two ways to speak to a live agent and they are not
interchangeable.**

- **`sendText`** creates a conversation item *and* asks for a response. It
  arrives looking exactly like a transcribed human utterance, so it ends
  whoever is talking — the agent mid-sentence, or a person mid-word. There is
  no state in which it is polite.
- **`sendContext`** creates a conversation item and stops. It cannot
  interrupt, is never answered, and is safe to fire mid-sentence.

So the position rides on the message that asks for a line — one board, always
the newest, in the most recent thing the model read — and speech is asked for
rarely, and waits for a gap. Not an absolute rule: a hold has a ceiling,
because a room noisy enough to keep re-arming the floor would otherwise
silence the commentary altogether. See
[`docs/floor-control.md`](docs/floor-control.md) for the state machine, the
provider differences, and the measurements behind the numbers.

## Layout

| file | what it owns |
| --- | --- |
| `src/sender.ts` | Floor control: when the app may ask for a line. No game knowledge. |
| `src/turn_pump.ts` | What is worth saying, and how it is framed |
| `src/game/rules.ts` | Pure rules — column heights, dice pairings, legality, banking |
| `src/game/state.ts` | `GameStore` — seats, phase machine, the only writer of a position |
| `src/game/bot.ts` | The opponent: exact bust odds and a tuned value function |
| `src/match.ts` | Drives seats no person is holding |
| `src/persona.ts` | The commentator |
| `src/agent.ts` | The whole agent config — instructions, voice, one server hook |

## Two modes

**You vs the engine** (default) — a dice engine plays the other side instantly,
so nothing in the game ever waits on a model round-trip. **Two players, one
screen** — pass the laptop and it commentates both of you.

The agent has **no tools and no skills** in either. It cannot move anything,
which is deliberate: an agent with no way to act cannot stall the thing it is
watching.

## Notes and rough edges

- **The engine is not a toy.** Bust probability is computed exactly by
  enumerating all 1296 rolls against the live position, so closed columns and
  topped-out runners are accounted for. It wins ~90% against a plausible casual
  heuristic, with first-move alternation to cancel the opening edge.
- **A far-field microphone is the biggest source of trouble.** Faint room
  speech becomes confident nonsense in transcription, and the agent then
  answers it in good faith. `audio: { noiseCancellation: 'voice_focus' }` helps; a
  headset helps more.
- **`openai_mini` exposes no turn-detection knobs**, so there is nothing to
  tune from the SDK if faint speech still opens turns.
- The commentator's line length is prompt-enforced, not hard-capped. On the
  mini tier it tends to run long.
