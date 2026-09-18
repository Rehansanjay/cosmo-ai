# TypeScript (`cosmo-ai` on npm)

Read [core.md](core.md) first. Full API reference:
https://platform.askcosmo.ai/docs. This file is the TypeScript gotchas.

## Current shape

```ts
import { RealtimeClient } from 'cosmo-ai';

// Node: {} resolves COSMO_API_KEY, else the `cosmo login` credentials
// file. A browser page instead gets { token: ... } — a minted JWT or a
// TokenSource, never an API key.
const client = new RealtimeClient({});
const session = await client.agent({ instructions: 'You are terse.', model: 'grok', voice: 'ara' }).start();

for await (const event of session) {
  switch (event.type) {
    case 'ready': console.log(event.session_id); break;
    case 'transcript': console.log(`[${event.role}] ${event.text}`); break;
    case 'session-ended': console.log(event.reason); break;
  }
}
```

## Gotchas

- **Next.js route handlers / server components**: import from
  **`cosmo-ai/server`** — the credential-holding surface, with no session or
  agent API. The React bindings are at `cosmo-ai/react`, a client boundary a
  server component must not import.
- **Two event vocabularies, on purpose**: iteration yields wire frames
  with kebab-case names (`{ type: 'session-ended' }`); the
  `session.on(...)` callback layer is the normalized UI surface with
  snake_case names (`session_ended`). Two guarantees `on` makes:
  `session_ended` fires exactly once per session on any exit path, and
  late subscribers get the current `lifecycle` state (and an
  already-fired `ready`) replayed — attaching handlers after
  `agent.start()` resolves just works. Iteration stays the canonical
  form; reach for `on` only on code you don't own.
- **Tools**: `clientTool({...})` from `cosmo-ai/tool` with `zodInput` from
  `cosmo-ai/tool/zod` — the Zod schema drives the model-facing JSON
  Schema and validation; never hand-write a schema.
- **Slow tools**: `backgroundClientTool({ handler: async (args, job) =>
  … })`. The handler returns `void` — `job.ack('on it')` releases the
  reply so the agent keeps talking, then `await job.complete({ result,
  summary })` or `await job.fail({ error })` delivers the outcome
  whenever the work lands.
- **Background voices / the agent answering other speakers**:
  `client.agent({ audio: { noiseCancellation: 'voice_focus' } })` — off by
  default; the tradeoff and the rest of the `audio` block:
  [core.md](core.md). The browser's own noise suppression and auto-gain
  control stay off (they duck speech during double-talk and break
  barge-in) and are not configurable, so this flag is the lever.
- **Wrong-language transcripts / the agent flipping languages**: there
  is no `language` field to set — not on the agent options, a model
  block, or anywhere else; don't invent one. The control is
  `instructions` — the wording and what the platform already does:
  [core.md](core.md).
- **React**: wrap in `RealtimeProvider` and use the shipped hooks
  and components — the docs list them; don't rebuild transcript or
  mic-level plumbing by hand.
- **Screen share**: `session.startScreenShare()` is what puts the screen
  in front of the agent; render the "you are sharing this" preview from
  `useScreenShare().stream` (or `session.getScreenShareStream()`). Never
  call `getDisplayMedia` yourself — that capture stays local, so the
  preview may render but the agent sees nothing. For small text or what
  the user is pointing at, the agent needs the close-up tool — see
  [core.md](core.md).
- **Websocket transport**: `new RealtimeClient({ transport: 'websocket' })`
  reaches a local OSS `cosmo-server`; managed Cosmo serves WebRTC only.
  Outside the browser, `COSMO_TRANSPORT` sets the lane when the option is
  omitted. What the socket refuses: [core.md](core.md).

## Ship it

The browser-app walkthrough (mint route, deploy, 429 handling):
[../examples/share-a-web-app.md](../examples/share-a-web-app.md).
