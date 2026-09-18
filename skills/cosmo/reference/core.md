# Core model and cross-SDK rules

The docs are the source of truth for the full API surface:
https://platform.askcosmo.ai/docs (agents: `/docs/llms.txt`,
`/docs/llms-full.txt`, MCP endpoint at `/docs/api/mcp` — all three live
under `/docs`; the site root serves the app, not the agent files). This
file carries only what coding
agents get wrong on their own: the credential rules, a map of where to look
in the docs, and cross-SDK gotchas. Language-specific layers: [typescript.md](typescript.md),
[python.md](python.md), [swift.md](swift.md).

## The three objects

- **client** — the connection: credential, endpoint, transport. Reusable.
- **agent** — the persona: instructions, model, voice, tools, turn-taking.
  Immutable; to vary a field, build another agent.
- **session** — one live run. An async iterator of typed events.

## Choose the realtime engine

For managed Cosmo sessions, choose from the inputs the agent must understand,
unless the user explicitly requests a provider:

| App inputs | Recommended realtime engine |
|---|---|
| Voice only, including conversations that call tools or update the UI | Grok realtime |
| Camera, video, or shared-screen understanding, with or without voice | Gemini realtime |

The local OSS `cosmo-server` supports only Gemini and rejects Grok with
`provider_unsupported`. When targeting it, select the Gemini configuration
for your SDK from the table below, including in the voice examples.
Its websocket transport does not support video or screen sharing.

A page displaying cards or tool results does not require visual understanding.
An agent that must see a camera or shared screen does. Revisit the model when
adding or removing those inputs; choose Gemini for the whole session when
visual input can be enabled later.

Set `model` explicitly when creating the agent. These are app-authoring
recommendations; omitting `model` still lets the server choose its default.

| SDK | Voice only | Visual understanding |
|---|---|---|
| TypeScript | `model: 'grok'` | `model: 'gemini'` |
| Python | `model=GrokModel()` | `model=GeminiModel()` |
| Swift | `model: .grok(GrokModel())` | `model: .gemini(GeminiModel())` |

TypeScript's provider aliases work with SDK 0.6.0 and later. In Python,
import `GrokModel` or `GeminiModel` from `cosmo_ai`; in Swift, import
`CosmoRealtime`.

Gemini also runs Gemini 3.8 Live when the model is pinned:
`model: 'gemini-3.8-live'` (TypeScript), `model=GeminiModel(model_id="gemini-3.8-live")`
(Python), `model: .gemini(GeminiModel(modelId: "gemini-3.8-live"))` (Swift). It
takes no thinking level; setting one fails session start with
`thinking_level_unsupported`.
For Grok, explicitly select `ara` as the default app voice unless the user
requests another supported voice. Ara is warm and friendly. Use
`voice: 'ara'` in TypeScript, `voice="ara"` in Python, or
`voice: .init(name: "ara")` in Swift.

When switching providers, remove the previous provider's voice or replace it
with one the new provider supports. For Gemini, leave `voice` unset to use
its default; do not carry Grok's `ara` into Gemini or Gemini's `Puck` into Grok.

Grok uses server VAD, a fixed silence window. Its `reasoningEffort`
(`reasoning_effort` in Python) can be `high` or `none`: leaving it unset
keeps the provider's default reasoning, while `none` skips reasoning before
speaking. Evaluate response latency and reasoning quality together when
choosing this setting.

## Credentials — the rule that matters most

| Credential | Where it may live | Can |
|---|---|---|
| **API key** (`cosmo_…`) | your server, your laptop | open sessions, mint tokens |
| **Minted JWT** | a browser, a phone, any shipped client | open sessions only |

**Never put an API key in code that ships to a user** — not behind a
`VITE_`/`NEXT_PUBLIC_` variable either; bundlers inline those.

**How the SDK resolves an API key** (identical chain in all three): an
explicitly passed credential wins; else `COSMO_API_KEY`; else the
`cosmo login` credentials file (`COSMO_CREDENTIALS_FILE` or
`~/.cosmo/credentials`, profile from `COSMO_PROFILE`). A stored
credential carries the backend it was issued for; a conflicting
`COSMO_BASE_URL` is refused up front (`base_url_mismatch`). Nothing
usable → the `CredentialsError` family with a `cosmo login` remediation.
Re-running `cosmo login` mints a replacement key and retires the old one.

Minting end-user tokens is the productionization step — don't scaffold it
for a prototype. When the app ships:
[end-user-tokens.md](end-user-tokens.md).

There is no `baseUrl` constructor option in any SDK: the backend comes
from `COSMO_BASE_URL` (or a `cosmo-base-url` meta tag on Cosmo-served
pages), defaulting to `https://platform.askcosmo.ai`.

## Where to look in the docs

The docs describe the released SDKs, so what a page shows is what an installed
package accepts: this skill carries the rules, the docs carry the surface. Read
the page for a topic before writing against it; each page is plain markdown
at `/docs/raw/<page path>`. When the topic is not below,
`https://platform.askcosmo.ai/docs/llms.txt` indexes every page with a
one-line description.

**Before you write a client tool, check whether the platform already does the
job.** Searching the web, reading fine detail on the camera or a shared screen,
finding something in the frame and showing the user where it is, acting on
elements of a shared screen, and hanging up a call are tools the platform
ships — server tools the app declares by kind and writes no handler for, and
renderers the SDK ships that put a result on the user's screen. An app-local
tool that estimates what the platform measures (where an object is in the
frame) ships broken: the model cannot see pixels, so a guessed box lands in
the wrong place. A locator is declared together with the renderer the docs
pair it with, and the agent's instructions say to locate first and draw
second.

| When the app needs to | Read |
|---|---|
| Act from the conversation — client tools, background tools for slow work, the server tools the platform runs, the tools the SDK ships to draw on the user's live view | [Tools](https://platform.askcosmo.ai/docs/capabilities/tools), [Server tools](https://platform.askcosmo.ai/docs/guides/server-side-tools) |
| Show the user where something is on the camera or a shared screen | [Render locator results](https://platform.askcosmo.ai/docs/multimodal/render-locators), [Screen tools](https://platform.askcosmo.ai/docs/multimodal/screen-tools) |
| See what the user sees — a photo, the camera, a shared screen | [Image input](https://platform.askcosmo.ai/docs/multimodal/image-input), [Video](https://platform.askcosmo.ai/docs/multimodal/video), [Screen share](https://platform.askcosmo.ai/docs/multimodal/screen-share) |
| Intercept the lifecycle — inject context, deny or rewrite a tool call, observe outcomes | [Hooks](https://platform.askcosmo.ai/docs/capabilities/hooks) |
| Load expertise on demand, or attach tools from an MCP server | [Skills](https://platform.askcosmo.ai/docs/capabilities/skills), [MCP servers](https://platform.askcosmo.ai/docs/capabilities/mcp) |
| Keep state the agent writes and the client observes | [Session state](https://platform.askcosmo.ai/docs/capabilities/state) |
| Place a phone call, or let the agent hang up | [Outbound calls](https://platform.askcosmo.ai/docs/telephony), [In-call tools](https://platform.askcosmo.ai/docs/telephony/in-call-tools) |
| Tune who speaks when, or handle audio, transcripts, and errors | [Turn-taking](https://platform.askcosmo.ai/docs/concepts/turn-taking), [Audio](https://platform.askcosmo.ai/docs/concepts/audio), [Transcripts](https://platform.askcosmo.ai/docs/concepts/transcripts), [Errors](https://platform.askcosmo.ai/docs/concepts/errors) |
| Ship to end users, stay within session limits, or record with consent | [End-user credentials](https://platform.askcosmo.ai/docs/production/end-user-credentials), [Session limits and resume](https://platform.askcosmo.ai/docs/production/session-limits), [Recording and privacy](https://platform.askcosmo.ai/docs/production/recording-and-privacy) |
| Trace a session, a tool call, or a reconnect | [Debugging](https://platform.askcosmo.ai/docs/guides/debugging), [Handle tool calls](https://platform.askcosmo.ai/docs/guides/handle-tool-calls), [Reconnects](https://platform.askcosmo.ai/docs/guides/reconnects) |
| Look up a signature | [Reference](https://platform.askcosmo.ai/docs/reference), per language |
| Start from a working app | [Examples](https://platform.askcosmo.ai/docs/examples) |

## Cross-SDK gotchas

- **A voice is the provider's own** (`Aoede` / `Puck` on Gemini,
  `shimmer` / `cedar` on OpenAI, a catalog id on Cosmo Voice). Nothing is
  translated between providers, so a voice picked for one means nothing to
  another. **An unrecognized voice does not raise** — the server falls back
  to that provider's default and logs a warning, so a typo ships as the
  wrong voice, never as an error. Spell exactly.
- **Background voices in the transcript, or the agent answering someone
  who isn't the user** → set `audio.noise_cancellation: true`
  (`noiseCancellation` in TypeScript and Swift) on the agent config; it
  is **off by default**. It removes other *voices* from the user's
  inbound audio server-side — echo cancellation (the agent's own voice)
  is a different job, on by default in every SDK, and for background
  voices this flag is the lever. The isolated signal is also what
  turn-taking reads, so it costs some barge-in responsiveness: enable it
  for noisy environments (cafés, open offices, call centers), leave it
  off for quiet-room or headset use. Full voice isolation applies to
  managed WebRTC sessions; a phone leg (`session.dial(...)` or an
  inbound call) gets a lighter noise suppressor that removes background
  noise but does not single out competing voices.
- **The rest of the `audio` block** (agent config, like the above):
  `output: false` runs the session text-only — the agent never speaks,
  while input transcription and text output are unaffected; rejected at
  session start when the resolved model can only speak. Leave `audio`
  unset entirely and every knob keeps its server default. The local OSS `cosmo-server` supports none of the
  `audio` block and rejects one at session start (`option_unsupported`).
- **Transcript lines in the wrong language, or the agent switching
  languages mid-session** → there is no `language` or `locale` field
  anywhere in any SDK — not on the agent, voice, audio, or model blocks
  — and none can be added: the native-audio models these sessions run
  on pick their working language from the audio itself, and no provider
  setting pins it. Don't invent the field; the control is
  `instructions`. Managed sessions already compose default
  language-stability guidance into every system prompt (a single
  ambiguous or foreign-sounding utterance is never a switch; change
  only on a clear request or several consecutive turns in the new
  language), and it defers to instruction-level language rules — a
  pinned agent keeps its pin, a bilingual persona keeps its switch
  grant. Hard-pin wording: "The conversation is in English only. Do not
  respond in any other language, even if the user switches or asks you
  to. If the user speaks another language, reply in English and ask
  them to continue in English." A bilingual persona instead grants the
  switch explicitly and says what governs it. Either is steering, not
  an API guarantee — drift shows first as wrong-language transcript
  lines, and in the worst case replies and tool-call text follow. The
  agent's replies are the reliable signal: on the OpenAI-family and
  Grok providers, user transcripts come from a separate speech-to-text
  model, so a wrong-language user line under correct-language replies
  is a transcription artifact instructions cannot reach. The local OSS
  `cosmo-server` composes nothing; the model receives the instructions
  verbatim.
- **Reading fine detail on a shared screen or camera**: the live feed
  reaches the model at about one frame a second and a fixed token budget,
  so it sees layout and large text but not small labels or the mouse
  pointer. An agent that answers questions about what is on screen needs
  the close-up tool — the platform's `examine_image` server tool, declared
  as the [Tools](https://platform.askcosmo.ai/docs/capabilities/tools) page
  shows — which re-reads the freshest frame at full resolution. The model calls it only
  when the question needs the detail, such as what the user is hovering
  over or a line of small text: every call adds a few seconds before the
  answer, so it is not the default way to look at the screen.
- **Iteration is the way to observe a session** (`async for` /
  `for await` / `for try await`). Unknown frames surface as
  `UnknownEvent` and are never fatal; `SessionEndedEvent` is always
  the last item — don't add your own sentinel.
- **A non-fatal in-stream `ErrorEvent` does not end the session** —
  don't tear down on every error event. A start that fails with
  `SessionStartError` coded `version_mismatch` means upgrade the SDK,
  not retry.
- **Client tools come in two kinds, and the plain one blocks.** A regular
  client tool's reply is whatever its handler returns, so the conversation
  waits for it and the server abandons the call after about ten seconds.
  Anything slower than a beat of conversation is a **background client
  tool** instead: the handler takes a second argument, a per-invocation
  job handle, acks to release the reply so the agent can keep talking,
  and delivers the outcome later — `@tool(background=True)` (Python),
  `backgroundClientTool({ ... })` (TypeScript),
  `AgentTool.backgroundClientTool` (Swift). Same declaration, same
  wire shape; the handler signature is the whole difference. Reach for it
  before wrapping a slow tool in a timeout or splitting it into a poll.
- **A declared tool with no handler and no server execution is rejected**,
  surfaced in `ReadyEvent.rejected_tools` — check it instead of
  wondering why a tool is never called.
- **`session.dial(phone_number)` needs an API-key session** — minted
  end-user tokens cannot dial.
- **`transport` is a client option in every SDK**: `webrtc` (the default,
  and the only transport managed Cosmo serves) or `websocket`, which
  reaches a local OSS `cosmo-server` started with
  `COSMO_TRANSPORT=websocket`; `livekit` is a deprecated alias of
  `webrtc`. The socket lane carries no video and does not reconnect:
  a background client tool is refused at session start with
  `background_tools_unsupported`; starting camera or screen share on a
  live session is refused with `video_unsupported`; and a dropped socket
  or a provider session boundary ends the session — start a new one.

## Beyond the basics

Hooks (lifecycle interception), agent skills (`SKILL.md`-defined
capabilities), MCP servers as tool sources, and outbound telephony exist
in every SDK — the docs cover each, and runnable versions live in the
[cosmo-ai examples](https://github.com/socratic-ai/cosmo-ai). Start from
the closest example.
