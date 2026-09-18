---
name: cosmo
description: >-
  Teaches the current Cosmo Realtime SDK API across TypeScript (`cosmo-ai`
  on npm), Python (`cosmo-ai-sdk` on PyPI), and Swift (`cosmo-swift-sdk` via
  Swift Package Manager, imported as `CosmoRealtime`): login and credentials,
  voice/multimodal agents, realtime sessions, client tools and the tools
  the platform ships (server tools, on-screen renderers), hooks, agent
  skills, telephony, minting end-user tokens, and deploying/sharing apps
  built on the SDK. Use when writing, reviewing, or debugging code that uses
  any of these SDKs — read reference/core.md before writing any realtime
  code. Also use when a build breaks after an SDK version bump —
  reference/migrations.md maps each release's breaking changes to their
  replacements.
---

# Cosmo Realtime SDK

One wire protocol, three SDKs, one shape: a **client** (credential +
endpoint) builds an immutable **agent** (persona: instructions, voice,
tools), and `agent.start()` runs a **session** (a stream of typed events).

This skill is a summary; the docs at https://platform.askcosmo.ai/docs are
the source of truth. **Before your first SDK change, fetch the docs page for
each capability the app uses.** The map of pages is in
[reference/core.md](reference/core.md#where-to-look-in-the-docs); read this
file and that one whole, since a `head` stops above the map. The page is the
contract. The installed package's `.d.ts` only says what compiles, and grepping
`node_modules` is not a substitute for reading it.

```bash
curl -fsSL https://platform.askcosmo.ai/docs/llms.txt                 # every page, one line each
curl -fsSL https://platform.askcosmo.ai/docs/raw/concepts/transcripts  # one page, plain markdown
```

## Step 1: get a credential (start here, all three SDKs)

On a developer machine, the fastest path is the Cosmo CLI:

```bash
curl -fsSL https://platform.askcosmo.ai/docs/install.sh | sh
cosmo init     # browser sign-in; stores an API key in ~/.cosmo/credentials
```

`uv tool install cosmo-cli` and `pipx install cosmo-cli` install the CLI
directly. `cosmo login` is the sign-in on its own, and is what re-auth and
a workspace switch call.

After sign-in, zero-argument construction works out of the box — the
SDK resolves `COSMO_API_KEY` from the environment, else the stored
credentials file, and adopts the backend the stored key was issued for:

```python
client = RealtimeClient()                       # Python
```

```ts
const client = new RealtimeClient({});         // TypeScript (Node)
```

```swift
let client = try RealtimeClient()              // Swift
```

Two rules that must always hold:

- An API key (`cosmo_…`) lives on servers and laptops only. Anything
  shipped to an end user (browser, phone, binary) gets a short-lived
  minted JWT instead — pass `TokenSource.endpoint(url)` as the `token`
  credential and the SDK fetches and refreshes it itself. Never put an API
  key behind a `VITE_` / `NEXT_PUBLIC_` variable.
- Minting is the productionization step, for when an app ships to end
  users. For local dev and server-side apps, the logged-in key alone is
  the whole story — don't scaffold token minting for a prototype.

## Step 2: read the reference for the language being written

Always: [reference/core.md](reference/core.md) — the full credential
rules and the cross-SDK gotchas. Then the language layer:

- **TypeScript**: [reference/typescript.md](reference/typescript.md) —
  React bindings, the `cosmo-ai/server` entry, the `session.on` callback
  layer, Zod tools
- **Python**: [reference/python.md](reference/python.md) — install and
  platform notes, Pydantic tools
- **Swift**: [reference/swift.md](reference/swift.md) — SwiftPM install,
  zero-argument options, TLS and backend selection

## Step 3: read the docs page for each capability the app uses

The reference pages above are summaries. Before writing against a capability —
tools the platform ships, hooks, skills, telephony, video, screen share, state
— fetch its docs page (the `curl` at the top of this file) from the map in
[reference/core.md](reference/core.md#where-to-look-in-the-docs).

## Choose the realtime engine

For managed Cosmo sessions, use **Grok realtime for voice-only apps** and **Gemini realtime for apps
that need camera, video, or shared-screen understanding**, including apps
that combine voice with those inputs. Set the agent model explicitly;
see [provider selection](reference/core.md#choose-the-realtime-engine)
for the cross-language configuration and voice rules. The local OSS
`cosmo-server` supports only Gemini; use Gemini for its voice sessions.

## Before you write a tool

The platform ships tools of its own — web search, a close-up of the camera or
screen, locating something in the frame and drawing it on the user's screen,
acting on a shared screen, hanging up a call. Check the docs before writing a
client tool for a job like that; an app-local tool that estimates what the
platform measures ships broken. The map of where to look is in
[reference/core.md](reference/core.md#where-to-look-in-the-docs); the docs
describe the released SDK, so their spelling is the one your install accepts.

## Workflows

- **Build a voice agent with a tool** (Python):
  [examples/build-a-voice-agent.md](examples/build-a-voice-agent.md)
- **Ship a browser app and share it** (TypeScript — mint route + deploy):
  [examples/share-a-web-app.md](examples/share-a-web-app.md)
- **Production credentials — the token server and the end-user token
  lifecycle** (mint scope, TokenSource, TTL, revocation; all languages):
  [reference/end-user-tokens.md](reference/end-user-tokens.md)
- **Build broke after an SDK version bump** (all languages — grep the
  symbol the compiler lost, apply the sections between your version and
  the target): [reference/migrations.md](reference/migrations.md)

## Debug a session

Set `COSMO_LOG_LEVEL` to `debug` to make the SDK verbose on standard error,
including each session's connect-latency breakdown. Values are `silent`,
`error`, `warn`, `info`, `debug`. TypeScript reads it outside the browser,
where `setLogLevel('debug')` is the way in. In Swift the variable gates only
the connect-latency line; read a Swift session in full through `os_log`
instead (`log stream --predicate 'subsystem == "socratic.cosmo-realtime"'
--info --debug`).

After a session ends, read it back from the shell:

```bash
cosmo sessions list                         # recent sessions, newest first
cosmo sessions logs <session-id>            # print the transcript
cosmo sessions logs <session-id> --bundle   # zip it with the recordings
cosmo sessions usage <session-id>           # duration, talk time, tokens
cosmo sessions timeline <session-id>        # when each turn happened
```

## Start from a runnable example

Complete runnable examples for all three SDKs live in the
[cosmo-ai repository](https://github.com/socratic-ai/cosmo-ai) under
`examples/`: a token-minting server, a browser voice page (Vite + React),
a deployable docs agent, a video-grounded voice coach, and a live-camera
plant doctor that locates what you ask about and draws over the preview
(TypeScript); a
minimal session, a terminal voice client, outbound calling, and
hooks/skills/MCP agents (Python); HelloRealtime with MCP/hooks/skills
variants and a GUI agent app (Swift). Derive new apps from the closest
example rather than starting from a blank file.

## More

Full docs, guides, and an MCP endpoint for live API lookup:
https://platform.askcosmo.ai/docs (agents:
`https://platform.askcosmo.ai/docs/llms.txt` and
`https://platform.askcosmo.ai/docs/llms-full.txt` — the paths are under
`/docs`; the site root serves the app, not the agent files).
