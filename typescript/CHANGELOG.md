# Changelog — `cosmo-ai`

All notable changes to this package. Dates are release dates. Versions are
per-SDK: the other Cosmo Realtime SDKs release on their own numbers.

Entries are assembled from the monorepo's pending changeset fragments when a
release is cut. A published section is immutable — a correction goes in the
next release's section, never by editing an old one.

> The v0.1.0 entries describe the API as it shipped in that release.
> Several names changed after — read the reference docs for the current
> shape, and v0.1.0 only as history.

## v0.7.1 — 2026-09-24

### Added

- `experimental.avatar` asks the server for a video avatar — a vendor renderer joins the session and republishes the agent's speech as lip-synced video, and the agent then publishes no audio of its own. One renderer today (`provider: "tavus"`, with a `face_id`); the field is discriminated on `provider` so further renderers join without a wire change. Server-gated per workspace: a session that asks for one while the gate is off simply starts without it.
- `GeminiModel` accepts `toolResponsePolicy` and `toolResponseOverrides` to let selected tools run while the agent continues speaking, with `GeminiToolResponsePolicy` controlling result scheduling. The `gemini-3.8-live-extended-thinking` model requires non-blocking tools, accepts low, medium or high thinking, and does not accept scheduling.
- `Plugin` bundles instructions, skills, tools, and hooks for inline agents through the `plugins` parameter. Contributions compose in plugin order before direct configuration, with named conflicts rejected at construction.
- `<RealtimeVideo />` and `session.attachVideoElement()` play the session's remote video — an avatar renderer speaking for the agent — through a `<video>` you own and style. A session without a renderer never gets a track, so the element stays empty. Muted on playback: the renderer's audio arrives as its own track that `<RealtimeAudio />` already plays, and a second sink would double it.
- `avatar` on the options `agent.start()` takes asks for one — `agent.start({ avatar: { provider: 'tavus', face_id } })`. Server-gated per workspace, so a session that asks while the gate is off runs without one.

### Changed

- Speaker diarization is available through the speaker log server tool without a workspace rollout flag. Opt in with `speakerLogTool()`. See the [server tools guide](https://platform.askcosmo.ai/docs/guides/server-side-tools) for setup.

### Fixed

- a `delegation_created` event that arrived with an empty `transcript` —
  GPT Live raises a hand-off mid-turn without attaching what the user said —
  now carries the session's last user turn, so a backend answering hand-offs
  always has something to act on. Each turn stands in for at most one hand-off,
  so two blank hand-offs in a row never replay the same instruction.
- agent state returns from thinking to listening when model work ends, without interrupting ongoing speech.

## v0.7.0 — 2026-09-18

### Breaking

[Upgrade guide](https://platform.askcosmo.ai/docs/meta/migration/typescript/0-7)

- `TranscriptDeltaEvent` is now the wire shape — `{ role, text, isFinal }`. The client-derived `id`, `turnId`, and `append` fields are removed: they were rendering instructions, and the session's coalesced transcript — `session.transcript`, one `TranscriptItem` per turn with a stable `id` — is the render-ready form.
- `tool()` is renamed `clientTool()`, and the background form is its own constructor rather than a flag: `tool({ background: true, ... })` becomes `backgroundClientTool({ ... })`, and `background` is gone from the option types — the constructor decides the form, so a caller can no longer set it to the value contradicting the one they called. The typed, raw and unsafe input forms are unchanged; they stay overloads of each constructor.
- Tools are built by calling a constructor, and every constructor returns `AgentTool`. `{ kind: 'web_search' }` and the other hand-written literals are no longer the documented form — `AgentTool` is a structural union, so an existing literal still compiles, but it is unsupported and gains none of the constructors' checks. Use `webSearchTool()`, `examineImageTool()`, `detectObjectsTool()`, `pointAtObjectTool()`, `endCallTool()`, `screenLocateTool(capture)`. The SDK-shipped renderers gained the same suffix: `drawBox` → `drawBoxTool`, `drawPoint` → `drawPointTool`, `screenClickElement` → `screenClickElementTool`, `screenHighlightElement` → `screenHighlightElementTool`, `screenHighlightBox` → `screenHighlightBoxTool`. The per-tool types (`ClientToolSpec`, `WebSearchToolSpec`, and the rest) are no longer exported — annotate with `AgentTool`, which `RealtimeTool` is also renamed to.
- The agent's output level is metered from its audio track instead of the `<audio>` element playing it, so a custom `RealtimeTransport` must implement the new optional `getOutputStream` and `onOutputStreamChanged` to report an output level. It keeps compiling and stays audible without them; only `useOutputLevel` goes quiet. The element tap it replaces claimed the element for the life of the page and routed its sound through the audio graph, so ending a session left the element wired to a closed graph and the next session played silently.
- `audio.noiseCancellation` takes a mode instead of a boolean — `'off'`, `'denoise'` or `'voice_focus'`. The new one is `'denoise'`: it removes non-speech noise and keeps every voice, which is what a microphone several people share needs. `'voice_focus'` is the previous behaviour, and keeps only the speaker it judges primary — on a shared microphone that treats the second person as background and filters them out.

  `true` and `false` remain valid on the wire, so a session started by an already-published SDK version is unaffected.
- Passing a workspace API key (`cosmo_…`) as `token` is refused at construction in every SDK. That parameter takes a minted end-user token; a key there authenticates anyway, so the mistake used to work — and shipped the key with whatever app carried it. Pass the key as the API-key parameter, or mint a token for the user with `mintToken` and pass that. Acts-as-user tokens (`cosmo_pat_…`) are unaffected.
- The client-tool option types are named and exported: `ClientToolOptions` and `RawClientToolOptions`, each taking the handler as a type parameter — the handler is the only thing the immediate and background constructors differ by, so there is one type per input form rather than one per form per constructor. `ToolInput` stops being exported — a converter mints it, so it is not a type a caller writes.
- The Standard Schema input form is removed: `clientTool` and `backgroundClientTool` no longer take `{ input: <validator>, unsafeParameters }`, and `StandardSchemaV1`, `ToolInput` and `ToolInputParseResult` are no longer exported. It existed so a validator the SDK ships no converter for could still validate handler arguments, at the cost of publishing the interop types and a third call shape nothing used. A validator without a converter goes through `{ parameters }` — the hand-written schema form — and is called inside the handler. The two remaining forms are the two Python and Swift take.
- `handler` is required on the raw form of `clientTool({ parameters })` and `backgroundClientTool({ parameters })`, matching the typed and Standard Schema forms, which always required it. A tool declared without one was advertised to the agent and then failed every time it was called.
- `model_options` is gone; its provider block moves onto `model`,
  which now takes either the model string it always took or one provider block
  naming the provider once — a model that disagrees with its knobs is
  unrepresentable. The provider types drop the `Options` suffix
  (`GeminiModelOptions` → `GeminiModel`, and likewise for OpenAI, OpenAI-mini
  and Grok), each block's `turn_detection` accepts only the detectors its
  provider offers (Cosmo-VAD tuning moves to `CosmoVadConfig` on the block's
  `cosmoVad` field), and the union is named `RealtimeModel`: `ModelOptions` is renamed, taking either the string or
  the block, with `RealtimeModelBlock` for the block alone. A block with no model id runs the provider's default,
  and `model: "gemini"` still selects a provider by name. The server keeps
  accepting `model_options` from existing releases — the old pair folds into
  `model` server-side — so upgrading the SDK is not coupled to a backend
  deploy.
- `SkillParseError` is now `SkillError` and carries a `code` naming which failure it was, so a caller can tell them apart without reading the message. The codes are `not_a_directory`, `cannot_read`, `missing_frontmatter`, `unterminated_frontmatter`, `malformed_frontmatter_line`, `duplicate_frontmatter_key`, `missing_description` and `duplicate_skill_name` — a `SkillErrorCode` enum in Python and Swift, a union of the same values in TypeScript. The old name described only the five parsing failures, while the type has always also covered a bad path and a duplicate skill name. Match on `err.code`; `err.message` is the sentence alone, and an unreadable skills directory now raises `SkillError(cannot_read)` where it used to escape as a bare `PermissionError`.

  Breaking: Attaching skills reads the same in every SDK. Swift takes a directory through the `skills:` argument itself — `client.agent(skills: .directory(skillsURL))` — instead of `loadSkills(fromDirectory:)`, which is no longer public; `.directory(_:)` is a factory on `[Skill]`, so inline skills are unchanged and the two compose with `+`. Swift's `skills` is optional rather than defaulting to an empty array. `parseSkillMd` takes `defaultName` directly in TypeScript rather than wrapped in an options object, and `parse_skill_md` is now public in Python for SKILL.md text you already hold. The skill-assembly internals — `resolveSkills`, `skillsMenuText`, `buildLoadSkillTool`, `LoadSkillWiring`, `loadSkillToolName`, `UnknownSkillError` — are no longer public in Swift; the wire name the tool registers under is unchanged, so a hook matching `cosmo_sdk_load_skill` keeps working.
- `RealtimeAgent` exposes its resolved persona as fields — `agent.instructions`, `agent.skills`, `agent.voice`, `agent.tools`, `agent.model`, `agent.audio`, `agent.greeting`, `agent.hooks`, `agent.interruptionSensitivity`, `agent.name`, `agent.inputs` — instead of nesting them under `agent.config`, which is removed. Read `agent.instructions` where you read `agent.config.instructions`. Building a persona is unchanged: `client.agent({ instructions, voice })` still takes an options object, since JavaScript has no named arguments. This matches the Python and Swift SDKs, which have always flattened the same fields onto the agent.
- `MintTokenError.code` is now a closed `MintTokenErrorCode` naming what the SDK saw — `request_failed`, `invalid_response`, `request_rejected` or `missing_api_key` — and the server's own rejection slug moves to `server_code`, set only when the code is `request_rejected`. The two were previously the same field, so `code` could hold either the SDK's category or anything the server sent, down to a synthetic `http_<status>`, with no way to tell which. Match on `err.code` for what happened to the request and read `err.server_code` for why the server refused. Handlers comparing `code` against `"transport_error"` or against a server slug such as `"auth_failed"` need updating; `str(err)` is now the message alone, without the `code: ` prefix.

  Breaking: A `TokenSource` that cannot produce a token now raises `TokenSourceError` rather than `MintTokenError`, with its own `TokenSourceErrorCode` — `request_failed`, `request_rejected`, `invalid_response` or `fetcher_failed`. Resolving a token source is not part of `mint_token`: it happens beneath every authenticated call — `verify`, `mint_token`, session start, dial and usage reads all resolve it first, and it re-resolves on expiry and after a 401 — so the failure surfaced under the name of one operation it mostly had nothing to do with. `token_source_failed` is gone from `MintTokenErrorCode` accordingly, and the four new codes say which part failed where one bucket said only that something did. A refused redirect is `request_failed` in every SDK — it never reached a token endpoint, so there is no rejection to report; Python previously reported it as an `http_<status>` rejection.

  Breaking: TypeScript gets the same two errors. `MintTokenErrorCode` and `TokenSourceErrorCode` are literal unions rather than aliases of `string`, both errors take `{ code, message, serverCode }`, and a malformed `TokenSource.endpoint` URL now throws a `TypeError` rather than an SDK error — argument validation is not part of the error family, which is what the Python SDK already did.

  Breaking: Swift gets the same two errors, as structs replacing the `MintTokenError` enum. `MintTokenError.rejected(code:detail:)`, `.transport(message:)` and `.invalidResponse(message:)` are gone; construct or match `MintTokenError(code:message:serverCode:)` with a `MintTokenErrorCode` instead, and expect `TokenSourceError` where a `TokenSource` fetch used to raise a mint error. `mintToken` now refuses a client built with a minted token or a token source before the request goes out, with code `missingApiKey`, rather than letting the server answer 401 — and `TokenSource.custom` rejects a fetcher returning an empty `jwt` instead of sending it as a bearer.
- The unused `ScreenShareOptions` type is removed. No API ever
  accepted it — `startScreenShare()` takes no options — so the only migration
  is deleting the import; annotate with your own shape if you referenced it.
- The deprecated `CosmoRealtimeProvider` and `CosmoRealtimeProviderProps` aliases are removed. Import `RealtimeProvider` and `RealtimeProviderProps` instead — the same component and props type under the names the rename already established.
- A `TokenSource.custom` fetcher now resolves with the same shape
  `mintToken` returns — a `MintedToken` — in every SDK. Python no longer
  accepts a plain `{jwt, expires_at}` mapping (construct `MintedToken`, which
  still parses an RFC 3339 `expires_at` string), and TypeScript no longer
  accepts a string `expiresAt` (pass a `Date`; the `FetchedToken` type is
  removed — annotate with `MintedToken`). Python's direct `TokenSource(...)`
  construction now validates identically to `custom` instead of bypassing it.
  Swift is unchanged.
- `AmbienceConfig` and the agent's `audio.ambience` field are removed
  from every SDK,  The field never produced
  audible ambience on any session started through this API — it was accepted and
  validated, then dropped — so removing it changes no behavior. Delete `ambience`
  from your agent's `audio` block; the rest of the block is unchanged.
- The five backend calls share an `ApiError` base — `MintTokenError`,
  `TokenSourceError`, `VerifyError`, `UsageError` and `DialError` all descend
  from it, so one catch covers any of them while catching a specific one still
  says which call it was. `serverCode` moves to the base, because a rejection
  slug belongs to whichever backend answered rather than to the call that asked.

  `VerifyError`, `UsageError` and `DialError` gain closed code enums in place of
  a bare string: `request_failed`, `request_rejected`, `invalid_response`, plus
  `invalid_request` on dial and usage for a call the SDK refuses to make. Where a
  server slug was the `code`, it is now `serverCode` and `code` is
  `request_rejected`. Swift gains `DialError`, which it did not have, and its
  `UsageError` and `VerifyError` become structs carrying `code` rather than
  case-carrying enums.
- One `CredentialsError` with the closed `CredentialsErrorCode`
  replaces six spellings of the same failure — TypeScript's `CredentialError`
  (singular), Python's `CredentialsError` plus its `NotFound`, `File`, `Expired`
  and `Mismatch` subclasses, and Swift's case-carrying enum. The five resolution
  codes are the slugs the cross-SDK vectors already pinned; `conflicting_credentials`,
  `api_key_in_token_slot` and `insecure_base_url` cover the construction-time
  guards, which previously threw a bare `Error`. 
- The session's `error` event and `useRealtimeError()` now deliver the
  error itself instead of a summary of it. The value is the `SessionStartError`
  or `AudioUnavailableError` that `start()` rejected with, or an `ErrorEvent`
  carrying the server's own `code` and `fatal` — so a banner and a `catch` block
  see the same object, and a server code is no longer collapsed into a client
  bucket. `ErrorCode` is now the server's error enum, the same one Python and
  Swift publish, and the client-side union that held the name is gone.

  Code reading `error.code` and `error.message` keeps working. Code matching the
  old client codes changes: `auth_error` becomes `auth_failed` or
  `workspace_forbidden`, `server_error` becomes the server's real code, and
  `mic_denied` and the other device failures arrive as `AudioUnavailableError`
  with an `AudioUnavailableErrorCode`. Branch with `instanceof RealtimeError`
  and `name` for the typed errors; the remaining case is the server's event.
  `ErrorEvent` gains `fatal`, always present — `false` for an error the session
  survives.

  A mid-session transport drop no longer latches on this axis — read
  `session.state` (`disconnectReason: 'transport_error'`) or the `session_ended`
  event for it — and a failed mic toggle reaches only the caller that awaited it.
  A start failure that the transport raised untyped is now wrapped in
  `SessionStartError` with `code: 'join_failed'`, carrying the original as its
  `cause`. A non-fatal error no longer moves the transport to `failed`.
- Registering a hook that cannot work now throws `HookError` in every
  SDK, with the closed `HookErrorCode` — `malformed_matcher`, `invalid_hook`,
  `server_hook_not_allowed`. These previously threw a bare `Error`, so none was catchable as `RealtimeError`. 
- A microphone that will not open now throws `AudioUnavailableError`,
  whose `code` says which failure it was — `mic_denied`, `mic_not_found`,
  `mic_in_use`, or `audio_unavailable` — where the browser's own exception was
  raised before, and `MicState` gains `'in-use'` to match. Code that switches
  exhaustively over `MicState`, or that read the browser exception off a failed
  start, needs the new member and the new type; Python and Swift raise the same
  error with the same codes.
- `ScreenCaptureRequest` no longer carries `wantsElements`
  (`wants_elements` in Python); the request is an empty envelope, and in Swift
  its initializer is `init()`. Capture handlers should always collect elements —
  the server has always requested them, so nothing changes at runtime. A handler
  that read the flag can simply drop the check.
- Declaring `screen_locate` on the websocket transport now refuses at session start with `SessionStartError` (`code: "config"`, `server_code: "screen_locate_unsupported"`) — the locator's capture payload travels as a byte stream, a channel the single-socket carrier does not have. Previously TypeScript silently skipped registration and Python and Swift captured the screen and then failed to deliver it; now the capture handler never runs. The Python background-tools refusal gains the matching `server_code: "background_tools_unsupported"`.
- `ErrorCode`, `SessionStatus`, `UsageStatus` and `CredentialKind` now
  accept a value the server added after your package shipped, instead of failing
  the payload that carried it — previously an unrecognized error code cost the
  whole error event, and an unrecognized status failed the usage request along
  with the counters you asked for. Swift switches over these enums need a
  `default` or `@unknown default` now that they carry an `unknown(String)` case
  and are no longer `@frozen`; in Python both kinds are members of the enum, so
  use `value in list(TheEnum)` rather than `isinstance` to tell them apart.
  `TranscriptRole` is unchanged.
- The session now owns the coalesced transcript, and the
  do-it-yourself folding surface is removed. Read `session.transcript` (one
  `TranscriptItem` per turn, with a stable `id` and an `isFinal` flag) or
  subscribe to `transcript_updated`, which carries the full updated list and
  replays the current value on subscribe; `useTranscript()` now reads this
  state and no longer caps at 12 items. Removed: `reduceTranscript`,
  `RealtimeTranscriptItem`, the `core/transcript_fold` and
  `core/transcript_reducer` modules, and `RealtimeProvider`'s
  `maxTranscriptLength` prop — render `session.transcript` (or pass
  `useTranscript({ limit })`) instead. `sendText` now lands the sent text in
  the transcript as its own closed user turn (an in-progress speech turn is
  unaffected) unless `transcript: false` is passed.
  The raw `transcript` delta events are unchanged and remain available.
- Every way a start can fail now raises one `SessionStartError`, whose
  closed `SessionStartErrorCode` names how far the attempt got — `transport`,
  `invalid_response`, `join_failed`, `config`, `busy`, `entitlement`,
  `version_mismatch`, `voice_disabled`, `rejected`, `handshake_failed`,
  `ready_timeout`. Switch on
  `code` where you used to branch on a type or read an HTTP status, and read the
  server's own rejection slug from `serverCode` beside it. It replaces `SessionBusyError`, `SessionEntitlementError`, `SessionConfigError`,
  `VersionMismatchError` and `SessionStartTransportError`. In Python
  the base error's `code` — previously open, carrying the server's own slug or
  a synthetic `http_<status>` — closes to the enum, with the slug moving to
  `server_code`.
- `SessionStartError.detail` is a `SessionStartRejection` in every SDK —
  the server's structured reason for refusing a start, which no SDK carried in full before. Each group of fields belongs
  to one server code: `limit` / `active` for `concurrent_session_limit`,
  `granted_minutes` / `used_minutes` for `free_minutes_exhausted`,
  `balance_cents` / `top_up_path` for `insufficient_credits`, `meter` /
  `included` / `used` / `reset_at` for `quota_exceeded`, and `provider` /
  `allowed_providers` / `plan` / `upgrade_path` for `provider_not_entitled`. A
  field the server adds that the SDK does not name is kept rather than dropped.
  `RealtimeSessionStartDetail` is renamed to `SessionStartRejection` and gains the ten fields it
  never declared.
- Calling a session method the session cannot serve now throws
  `SessionStateError` with the closed `SessionStateErrorCode` — `not_connected`,
  `already_started`, `audio_publish_already_active`,
  `video_publish_already_active`, `screen_share_unavailable`, `invalid_payload`.
  It replaces `NotReadyError` and `AudioPublishAlreadyActiveError`. A send issued before `ready` and one issued after the
  session ended both report `not_connected`.
- The session state machine's value type has one name in every SDK
  — `SessionState`. TypeScript's `SessionLifecycleState` and Python's
  `RealtimeSessionState` are renamed; fields, kinds, and behavior are
  unchanged, so the migration is the rename alone. TypeScript's `kind` field
  also gains the named `SessionStateKind` type (the same name Python
  exports); the values are unchanged, so existing code is unaffected.
- `agent.start()` now resolves when the session is ready — the
  server's handshake has landed — instead of at transport join, so every
  session method works the moment the promise settles. The naive
  `await start(); sendText(...)` sequence is now correct as written, and
  `waitUntilReady()` is no longer needed on the golden path (it remains, and
  resolves instantly after a resolved start). A session whose ready handshake
  never arrives within 40 seconds is torn down and `start()` rejects with
  `SessionStartError` coded `ready_timeout`; a room that closes before ready
  rejects with it coded `handshake_failed`, carrying the server's boot-failure
  `error` frame (code and message) when one preceded the close —
  where previously such failures surfaced only as an `error` event after the
  fact. A pre-ready `error` frame on its own never rejects `start()`; the
  close that follows carries its detail.
  `SessionStateError` coded `not_connected` from a session method now means
  the session has ended or never started. Readiness is also published as room state
  (a participant attribute on the agent), so a client that joins after the
  agent came up — a mid-call observer, a reconnect — still observes `ready`.
- `ToolSchemaError` is now `ToolDefinitionError`, and it covers the
  whole declaration — a bad tool name and a missing or overlong description
  throw it too, where a bare `Error` was thrown before. It is now catchable as `RealtimeError` like every other SDK error. `code` is the closed `ToolDefinitionErrorCode` rather than a
  string. 
- A tool-call validation failure reports its issues as
  `ToolInputIssue` in every SDK — `path`, `code`, `constraint` — where Python
  had raw dictionaries keyed `loc`/`type`/`ctx`, Swift nested the type inside
  the error, and TypeScript carried `path` as an array of segments. `path` is
  now the dotted form (`address.city`, `items[2].sku`) everywhere, the same
  string the `INVALID_INPUT` message renders.

  TypeScript exports `ToolInputIssue` from `cosmo-ai/tool`: it is the type
  `ToolInputValidationError.issues` carries, so a caller reading them has to be
  able to name it.
- `AgentTool` is now opaque — a tool is built by calling its constructor, and a hand-written object literal no longer type-checks in `tools`. The wire discriminant and the per-tool shapes are internal, as they are in the Python and Swift SDKs. Migrate each literal to the constructor that builds it: `{ kind: 'web_search' }` becomes `webSearchTool()` (likewise `examineImageTool()`, `detectObjectsTool()`, `pointAtObjectTool()`, `endCallTool()`, `speakerLogTool()`, and `screenLocateTool(capture)`), and a `kind: 'client'` spec becomes `clientTool({ name, description, parameters, handler })` — or `backgroundClientTool(...)` for the background form — with a typed `input` or raw `parameters`, exactly as before.
- A client tool carries the handler that runs it — `handler` is now required on the specs `clientTool` and `backgroundClientTool` build, so a hand-built `kind: 'client'` literal without one no longer type-checks. A handler-less spec advertised a tool that failed on every invocation; attach the handler that runs the tool. A method the server invokes over RPC without advertising it to the model is unchanged — that is `session.registerRpcMethod`, the register-only complement.
- A client constructed with no credential and no `getAuthHeaders` now
  throws `CredentialError` (`code: "no_credential"`) at its first authenticated
  call, before any request is sent, instead of sending unauthenticated requests
  the server rejects with 401. On such a client `mintToken` also throws this
  instead of `MintTokenError` (`missing_api_key`), which remains the error for
  token- and `getAuthHeaders`-credentialed clients. This matches what the
  Python and Swift constructors already do. Pass `apiKey` or `token`, set
  `COSMO_API_KEY`, sign in with `cosmo login`, or supply `getAuthHeaders`.
- The session stream now yields the SDK's own event types instead of
  raw wire frames, so the type you can import is the type you receive. A
  consumer iterating `for await (const event of session)` reads camelCase
  fields — `event.toolCallId` where it was `event.tool_call_id`,
  `event.isFinal` where it was `event.is_final`, plus `event.sessionId`,
  `event.secondsRemaining` and `event.updatedKeys` — and `ReadyEvent`,
  `ToolCallEvent`, `UsageEvent` and the rest now annotate a stream item as
  well as an `on()` payload.

  `event.type` is the SDK's own name for the event, not the wire's:
  `'tool_call'` rather than `'tool-call'`, `'model_text'` rather than
  `'model-text'`, `'usage'` and `'session_state'` rather than `'cosmo.usage'`
  and `'cosmo.session-state'`. Where an event also has a callback, that is the
  name `on()` takes, so one vocabulary names it on either surface; the `bot_*`
  and `user_*_speaking` markers and `tool_invocation` reach the stream only.
  Callback payloads are unchanged.

  Nine events that only ever reached the stream are now published types:
  `BotLlmStartedEvent`, `BotLlmStoppedEvent`, `BotStartedSpeakingEvent`,
  `BotStoppedSpeakingEvent`, `BotTtsStartedEvent`, `BotTtsStoppedEvent`,
  `UserStartedSpeakingEvent`, `UserStoppedSpeakingEvent` and
  `ToolInvocationEvent`, alongside `ToolInvocationOrigin`. Optional wire
  fields read as settled values rather than `undefined`: a missing `summary`
  is `null`, missing counters are `0`, and `args`, `state`, `updatedKeys` and
  `rejectedTools` are empty rather than absent.
- `cosmo-ai/tool/screen` stops exporting the `ScreenLocateTool` member type and the capture plumbing (`SCREEN_CAPTURE_RPC_METHOD`, `screenCaptureRpc`, `screenCapturePayload`, `ScreenCaptureCache`). The member type was the wire model behind `screenLocateTool(capture)` — annotate tool values with `AgentTool` — and the plumbing was the wiring behind it, never consumer API; the constructor and the capture-handler contract are unchanged.
- The React bindings are no longer re-exported from the package root — import them from `cosmo-ai/react`, which carries the whole surface. `import { RealtimeProvider, useTranscript } from 'cosmo-ai'` becomes `import { RealtimeProvider, useTranscript } from 'cosmo-ai/react'`; nothing else moves, and every name keeps its spelling. In exchange `react` and `react-dom` become optional peer dependencies, so a headless Node app no longer installs React to use the SDK, and `cosmo-ai/server` is now a narrower surface by choice rather than a workaround for the root pulling React into the `react-server` graph.

### Added

- Three new knobs on the Grok model block — `reasoningEffort` (`"high"` | `"none"`; Grok's own default is `high`, which reasons for seconds before every reply — set `"none"` for conversational latency), `speed` (0.7–1.5 playback-rate multiplier for the agent's speech), and `idleTimeoutMs` (server re-engages the user after this much post-response silence, re-arming after every response). All three are optional; unset keeps Grok's defaults.
- `presentMultiplier` on a silence hook, deciding how much its `timeoutSeconds` widens once the caller has spoken at least once. It is optional and unset keeps the server's default, so existing hooks are unchanged; set `1` for a hook that should wait the same whether or not anyone has spoken yet.
- `transport: "websocket"` on `RealtimeClient` runs browser sessions against a local OSS `cosmo-server` without a media room. The carrier uses the existing `MediaStream`, event and ordinary client-tool APIs; client-tool handlers receive a standard `AbortSignal` when the agent withdraws a call. Camera, screen share, reconnection, background tools, dial and usage reads remain unavailable on this local lane.
- `POST /auth/token` accepts an optional `scopes` list. The mintable set beyond the default is `realtime:read` and `realtime:delete` — both project-bound, so a token reads or deletes only its own end user's sessions — plus the connectors scopes. Scopes outside the mintable set are rejected with `400`.

  Changed: minted end-user tokens now default to `realtime:start` alone — starting sessions is what the SDK is about; reading session history back, deletion, and connector access are the app developer's explicit mint-time choices. The session object's own surface is unaffected: `session.usage()` works with a default token, since the usage read accepts `realtime:start`. The chat and resources scopes are gone entirely. Tokens minted before this release keep their stored scopes until they expire.
- `COSMO_LOG_LEVEL` turns the SDK verbose without an app change. Set it to `silent`, `error`, `warn`, `info`, or `debug` and the SDK writes to standard error at that level, including a `debug` line with the connect-latency breakdown for each session. An explicit `setLogLevel()` call, or a handler the app attached itself, still wins. In Swift the variable gates only that connect line, since `os_log` levels are set outside the process.
- Wire types for the new `GET /sessions/{id}/timeline` endpoint — `SessionTimeline`, `SessionTurn`, and `SessionResponsiveness` — regenerated from the external spec. The endpoint reports when each of a finished session's turns happened and how long its parts took, and is reachable over REST and from the shell as `cosmo sessions timeline <session-id>`. No SDK method wraps it, and the generated shapes stay inside the wire layer rather than being re-exported from the package entry point, so nothing new is importable from `cosmo-ai` in this release.
- Each model block type is now also a same-named constructor —
  `GeminiModel({...})`, `OpenAIModel({...})`, `OpenAIMiniModel({...})`,
  `GrokModel({...})` — that stamps the `provider` tag, so a caller names the
  provider once by calling it, the way Python's classes and Swift's cases
  already do. The tagged object literal remains valid as the wire shape, and
  detector-scoped knobs stay type-checked through the constructors.
- `OpenAILiveModel`, a new provider block for OpenAI's GPT Live full-duplex voice model (`provider: "openai_live"`). The model listens and speaks at once and decides itself when each turn starts and ends, so it carries no turn-detection knobs. It cannot call tools itself; it delegates tool calls and reasoning to a backend Responses model, and the block configures that model: `responsesModel`, `responsesInstructions` (defaults to the agent's own instructions), `reasoningEffort` (`OpenAILiveReasoningEffort`: `minimal` / `low` / `medium` / `high`), `verbosity` (`OpenAILiveVerbosity`), `toolChoice` (`OpenAILiveToolChoice`: `auto` / `required` / `none`), `parallelToolCalls`, `maxOutputTokens`, and `serviceTier` (`OpenAILiveServiceTier`: `auto` / `default` / `flex` / `priority`). Audio only: video and screen frames are ignored on it. The plain-string alias `"openai_live"` runs the provider default.
- The wire type for the new `connect-timings` client message — `ClientConnectTimings`, regenerated from the external spec. A client may report what its own connect took (the session-start round trip, the room join, local capture, and the wait for the agent to be ready) so the worker can join those phases to the ones it measures itself and record the whole waterfall against the session. Every duration is validated at the server boundary: milliseconds must be whole and non-negative, and a report carrying no timing at all is refused, so a malformed frame is dropped rather than stored as a measurement. Nothing sends it in this release: the generated shape stays inside the wire layer and is not re-exported from the package entry point, so nothing new is importable from `cosmo-ai` here.
- `SessionConnectTimings` gains `readyMs` (`ready_ms` in Python), measured from the same instant as the session-start phase and unset until the agent reports ready. Once the agent is live the session reports its client-measured phases and the server's own start breakdown back to the session, so the whole connect waterfall is recorded against it; the report goes out once per session and never surfaces a failure to the caller. In TypeScript the new field is optional and `onConnectTimings` takes the connect origin as an optional second argument, so a custom `RealtimeTransport` written against the previous shape still type-checks.
- The locally captured screen-share stream is now the app's to render. `session.getScreenShareStream()` returns the display `MediaStream` while a share is active (`null` otherwise), and the React binding gains `useScreenShare()`, returning `{ state, stream }` for wiring a "you are sharing this" `<video>` preview. Previously the stream was private to the SDK, so an app wanting a preview had to capture the display a second time itself — and anything captured that way never reached the model. TypeScript-only surface: the browser is the only place a display capture and a DOM preview both exist, so no Python/Swift counterpart is planned.
- Websocket sessions now report connect timings. The TypeScript transport carries the server's session-start phase breakdown and the connect-start origin into the connect-timings report, and the Swift transport records the handshake start so `readyMs` is populated — making socket and WebRTC connect latency directly comparable.
- GPT Live sessions can hand work off instead of calling tools. `OpenAILiveModel.delegation` picks who does it: `responses` (the default, the backend Responses model), `client` (your application), or `cosmo` (Cosmo's workspace agent on the server). Under `client` and `cosmo` the session emits a `delegation_created` event with the user's request, and three new session methods answer it: `appendThinking` (background the model keeps to itself), `appendCommentary` (something to say now, in its own words) and `appendInstructions` (how to behave from here on), each taking an optional delegation id.
- `cosmo-ai/react` is a real entry point — the provider, hooks and components import from there, which is where a React consumer looks first. They stay available from the package root, so existing imports are unaffected. `useRealtimeSnapshot` (one combined state read instead of four hook calls) and `UseTranscriptOptions` are now exported, and `MicToggle` and `BarVisualizer` have their own subpaths like the other components.

### Changed

- The wire contract tightens: `session-config` now requires the `sdk` identity block, and `send-image` requires `mime_type` and `stream_id`. Every SDK release already sends all three unconditionally, so SDK users are unaffected — the change closes the gap for direct REST callers, whose sessions were previously anonymous.
- `verify()` reports the credential's scopes after hierarchy expansion — the deprecated `realtime:use` umbrella now lists the child verbs it implies (`realtime:start`, `realtime:dial`, `realtime:read`, `realtime:logs`, `realtime:delete`, `support:write`) alongside itself, and `can_start_sessions` is keyed to `realtime:start`. Newly minted end-user tokens carry `realtime:start` + `realtime:read` instead of `realtime:use`; existing credentials keep working unchanged through the expansion.
- The canonical/default room transport selector is now `webrtc` (`.webrtc` in Swift), naming the protocol rather than its LiveKit implementation. The previous `livekit` / `.livekit` spelling remains accepted as a deprecated compatibility alias.
- The README no longer suggests a version to pin. Installs track the latest release; breaking changes are announced in the [changelog](https://platform.askcosmo.ai/docs/meta/changelog) before they ship.
- The OpenAI providers (`openai`, `openai_mini`, `openai_live`) no longer need a per-workspace opt-in. Like every other provider, they are available whenever the server has an OpenAI API key configured. `openai_provider_available` on the provider-capabilities endpoint now reports that server-side configuration rather than a workspace flag.
- Every options-bag parameter is now named `options` in signature help and the
  reference docs (previously a mix of `opts` and `options`). Call sites are
  unaffected — the argument is an object literal either way.
- `agent.prepareSession()` (`agent.prepare_session()` in Python) prepares a session ahead of its start, so it starts about 1.5 seconds faster: the SDK reserves a room in the background, and the returned `PreparedSession` joins it while the session request is still in flight when you start it. The reservation is refreshed until the handle is started or closed. Purely an accelerator: a reservation that failed, lapsed, or is declined leaves the start on the ordinary path. Requires the default `webrtc` transport.

  Python's `SessionStartError` now carries `status`, the HTTP status of a server rejection (`None` when the request never reached the server), matching TypeScript.
- `TokenSource.endpoint` now also accepts a `URL` instance for `url` — the
  pair `fetch` itself accepts. The string form is unchanged, and remains the
  only way to pass a relative path (a `URL` is absolute by construction).
- On the websocket transport, video and screen-share calls now fail with the error code `video_unsupported` instead of silently doing nothing. Stopping or removing a publish that could never start remains a harmless no-op, and video stays available on the WebRTC transport.
- `AudioUnavailableError.code` is typed as `AudioUnavailableErrorCode`
  rather than a bare string — `mic_denied`, `mic_not_found`, `mic_in_use` and
  `audio_unavailable`, the same four values it always carried. Every SDK declares
  all four even where its platform cannot tell them apart, so branching code
  ports between them unchanged. Existing comparisons keep working: Python's is a
  `str` enum and TypeScript's a union of the same literals.
- The screen-capture payload's descriptor clamps (role, title/label, value) now count Unicode scalars in every SDK — the same unit the reply shrinker uses — so a descriptor containing emoji or combining marks clamps to identical text regardless of which SDK the host ships. TypeScript previously counted UTF-16 units and Swift grapheme clusters; Python already counted scalars and is unchanged.
- The realtime protocol's per-field documentation now reaches the
  generated wire types, so hovering a field on `SessionStartTimings`, `ReadyEvent`
  and the other wire types shows what it means instead of just its type. The
  descriptions come from the published OpenAPI spec, which now carries 85 of them
  where it previously carried 20.
- Every field on the realtime wire types now carries documentation, so
  hovering any field on an event or message shows what it means and what its
  values imply — transcript delta semantics, tool-call correlation ids, the
  storage-consent fields, the envelope chunking fields, and the rest.
- The session, usage, timeline, transcript and auth response types now
  describe every field they return. `SessionUsage` and `SessionTokenUsage`
  explain each counter, the timeline explains what each latency span measures
  and which ones a given source populates, and the artifact listing says that a
  download URL expires. Previously these types arrived with their shapes and no
  prose.
- The screen locator's capture payload names its element list `elements` instead of `ax_elements`, matching the `ScreenCapture.elements` field it carries. Nothing changes in your code — capture handlers and `ScreenCapture` are untouched — and the Cosmo server accepts either spelling, so earlier SDK releases keep working.
- The seven realtime schemas that arrived with no prose now describe
  themselves. The four "stopped" session events — `bot-llm-stopped`,
  `bot-stopped-speaking`, `bot-tts-stopped` and `user-stopped-speaking` — say what
  they mean, where they fall relative to their "started" counterparts, and the
  distinctions that are easy to get wrong: `bot-stopped-speaking` is the last
  frame leaving the server rather than the moment the user stops hearing audio,
  and `bot-llm-stopped` means generation finished rather than the turn closing,
  which `turn-complete` marks. `InterruptionSensitivity`, the session status enum, and the
  mint-token request type also carry descriptions now.

  Fixed: `bot-tts-started` no longer says the gap to `bot-started-speaking`
  widens on a separate STT/LLM/TTS pipeline. The runtime publishes the pair
  together off one state change, so there was never a gap to observe.
- `TranscriptRole` is now a named, exported type (`'user' | 'assistant'`),
  and the `role` fields on `TranscriptDeltaEvent`, `TranscriptItem`, and
  `TurnCompleteEvent` are typed with it — the same symbol the Python and
  Swift SDKs publish. Purely a naming addition: the values are unchanged and
  existing code using the raw literals compiles as before.
- The SDK now declares the wire protocol it speaks instead of
  re-exporting types generated from the backend schema. Every published type
  keeps the shape and field names it already had — no import, annotation or
  field access changes — and the only generated types still on the surface are
  the closed string unions `InterruptionSensitivity`,
  `EndOfSpeechSensitivity`, `SemanticEagerness`, `GrokReasoningEffort` and
  `ThinkingLevel`, whose members are the wire's values in every language.
  Regenerating the backend schema can no longer change a published type on its
  own, so a change to the protocol reaches you as a release rather than as a
  surprise on upgrade.
- The session stream now yields `transcript_updated`, so the folded
  conversation reaches an iterator consumer and not just a callback one.
  It follows the event that produced it — the delta, or the turn-complete
  that closed a dangling turn — carrying the whole transcript as `items`,
  the same ordering Python and Swift already yield.

  Two folds have no inbound frame behind them and reach the stream too: the
  echo of `sendText`, and the close that settles a turn still open when the
  session ends. The closing one lands immediately before the terminal
  `session_ended` item, so a consumer that drains to the end sees a settled
  transcript rather than a turn left mid-flight.
- The published type declarations now mirror the source tree — one `.d.ts` per module at a stable path, so `dist/core/agent.d.ts` holds `AgentConfig` and go-to-definition lands somewhere that survives the next release. They were previously bundled into content-hashed chunks reached through single-letter aliases, which changed name on every build. The public API is unchanged, and every documented import path resolves as before.
- The published declarations now carry reference documentation, and so
  do their members. `RealtimeClient`, `RealtimeAgent`, `RealtimeSession` and its
  methods, the session event map, the hook contexts and results, the state
  model, the error types and the React provider, hooks and components all
  describe what they do and when they fire. Hovering a field goes further:
  `AgentConfig` and the model blocks explain each provider knob, `SessionUsage`
  describes every field it hands back, `RealtimeEventMap` says what each event
  carries and which ones replay to a late subscriber, and
  `useRealtimeSession()`'s result explains the `phase` discriminant that makes
  `client` and `session` non-null.

### Fixed

- Minting a token now behaves the same in all three SDKs. A success
  response is accepted only when `jwt` is a non-empty string and `expires_at`
  an RFC 3339 timestamp — anything else raises `invalid_response` rather than
  returning a token that cannot be used — and a Swift expiry carrying
  fractional seconds now parses instead of failing to decode. Mint requests
  carry a 45-second deadline and refuse redirects, so the workspace API key
  cannot be re-sent to another origin.
- Every error class the SDK exports now descends from `RealtimeError`, and the base is exported from every published entry that carries an error — the root barrel, `cosmo-ai/server`, `cosmo-ai/tool` and `cosmo-ai/core/types` — so one `instanceof RealtimeError` check covers them as a family whichever path you import from. Previously only `AudioPublishAlreadyActiveError` and `SkillParseError` descended from it, while `SessionStartError`, `MintTokenError`, `VerifyError`, `UsageError` and `DialError` extended `Error` directly; catching a specific error class is unaffected. An `input` that is not a minted `ToolInput` still throws a plain `TypeError` and stays outside the family.
- On the websocket transport, a clean server close (code 1000/1001, or an empty close frame) now ends the session as `server_ended` in TypeScript and Swift instead of reporting a transport error, and an abnormal close such as 1008 carries its numeric close code and reason in the error detail in all three SDKs.

  Fixed: the Python SDK caps a client-tool error at the wire's 512-character limit, so a long handler traceback no longer voids the reply and strands the tool call until its timeout.

  Changed: the Python `websocket` extra now requires `websockets>=14.1`, the release that exposes the close code and reason this reporting reads.
- A microphone acquired for a session that was ended while the browser's
  permission prompt was still open is now released, and that start rejects
  rather than resolving into a session already torn down. Previously the capture
  stayed open, so the browser went on showing its recording indicator with no
  session behind it.
- A skill description containing newlines now collapses to a single
  menu line in the resident instructions, matching the Swift SDK. A
  multi-line description can no longer inject extra lines — including
  entries shaped like other skills — into the instructions block.
- The CommonJS builds of the React entries now open with `"use client"`. The bundler emitted its interop preamble first, which left the directive as an ordinary expression rather than a directive, so a bundler resolving the `require` condition rejected `cosmo-ai/react` and every React subpath with "The `use client` directive must be placed before other expressions." The ESM builds were always correct, which is why the common paths — Next.js App Router and Vite — were unaffected.

## v0.6.0 — 2026-08-19

### Breaking

- `RealtimeClient` no longer carries the session surface — the client is credentials, base URL, and the agent factories (`agent`, `catalogAgent`, `verify`, `mintToken`, `getSessionUsage`), matching the Python and Swift clients. Everything scoped to one run moved to the `RealtimeSession` that `agent.start()` returns: the client-level `on(...)`, `getSnapshot()`, `getSessionId()`, `getConnectTimings()`, `getLifecycleState()`, `isActive()`, `waitUntilReady()`, the sends (`sendText`, `sendContext`, `sendImage`, `sendPing` → `session.ping()`, `sendActivityEnd`), `dial`, `setMicMuted` (→ `session.setMuted`), `setOutputBlocked`, `attachAudioElement`, `resumeAudioPlayback`, the screen-share/video/audio-stream controls, `getVisionInputStatus`, `registerRpcMethod`, and `setError` are removed — call the equivalent on the session. `client.disconnect()` / `client.close()` are removed with them: end a run with `session.end()` (graceful) or `session.close()` (abrupt).
- `RealtimeProvider` is fed a session, not a client: the `client`, `getAuthHeaders`, and `transportFactory` props are replaced by `session?: RealtimeSession | null` — pass `useRealtimeSession`'s `session`, or your own `agent.start()` result, and `null` between runs. The provider no longer constructs or disconnects a client of its own.
- `useRealtimeClient` and the `RealtimeClientLike` type are removed. Components that need imperative calls from context use the new `useRealtimeSessionContext()`, which returns the provider's `RealtimeSession | null`.

### Added

- `session.dial(phoneNumber, callerNumber?)` — the caller-ID override now rides the session method, as in Python and Swift.
- `onStateChange` on `SessionStartOptions`: observe the run's connection lifecycle from before the connect begins (the callback replays the current state on subscribe and stops at the run's terminal state), mirroring Python's `on_state_change`.
- `session.setOutputBlocked(blocked)` and `session.getVisionInputStatus()` — the browser-specific autoplay and vision-input status surfaces, moved from the client.
- Turn-detection knobs on `GrokModelOptions`: `turnDetection` (`'server_vad'`, the one detector xAI offers), `silenceDurationMs`, and `prefixPaddingMs`. Unset knobs keep the provider default. See [Turn-taking](https://platform.askcosmo.ai/docs/concepts/turn-taking#provider-endpointing).

## v0.5.1 — 2026-08-18

### Changed

- `CosmoRealtimeProvider` is renamed `RealtimeProvider`, and `CosmoRealtimeProviderProps` is `RealtimeProviderProps` — the last `Cosmo`-prefixed exports adopt the bare names the rest of the surface uses. The old names remain as deprecated aliases, so existing code keeps working; they will be removed in a later release.

## v0.5.0 — 2026-08-17

### Added

- `turnDetection?: 'server_vad' | 'cosmo_vad'` on `GeminiModelOptions`. `'cosmo_vad'` opts the session into Cosmo's semantic turn detection, which classifies whether the utterance reads as finished instead of timing a silence window; `'server_vad'` pins Gemini's silence-window detection, which is what `endOfSpeechSensitivity`, `silenceDurationMs`, and `prefixPaddingMs` tune (they are read only with `'server_vad'`). Unset keeps the server default, currently `'cosmo_vad'`.
- `cosmoVad?: CosmoVadConfig` on `GeminiModelOptions` (with `turnDetection: 'cosmo_vad'`): per-session tuning for the semantic detector — `pauseMs` (silence that triggers the end-of-turn inference), `prefixMs` (audio kept from before speech was detected), `maxHoldMs` (total silence after which the turn ends regardless of the classifier's verdict). The union makes pairing a knob with the other detector a type error.
- `InterruptionSensitivity`, `EndOfSpeechSensitivity`, `SemanticEagerness`, and `ThinkingLevel` are exported from the package root. They name the string unions that `AgentConfig` and the per-provider model options already accepted; previously they were only importable from the wire module.

### Fixed

- `GrokModelOptions` is now part of `ModelOptions` and exported from the package root. v0.4.0 announced it, but it was only reachable from the wire module and `agent()` rejected `provider: 'grok'` at the type level.

### Breaking

- `cosmo-ai/wire/types.gen` is no longer a published entry point. It exposed the SDK's internal wire and HTTP-codegen shapes (envelopes, per-endpoint request/response types), which were never part of the supported API and tracked the server protocol, not semver. Every name from it that is genuinely public API is exported from the package root: `EndCall`, `Say`, `SessionStartTimings`, `SilenceTimeout`, `RejectedTool`, and the four unions added above. Code that decoded raw protocol frames against the removed types should declare the frame shapes it consumes itself.

## v0.4.0 — 2026-08-14

### Changed (repository)

- SDK source, examples, and the issue tracker now live in the consolidated [cosmo-ai](https://github.com/socratic-ai/cosmo-ai) repository; package metadata points there.

### Added

- `session.usage()` — fetch the session's usage summary (duration, talk time, token counts) over REST, during the session or after it ends. `RealtimeClient.getSessionUsage(sessionId)` is the client-level form. Throws `UsageError`. Resolves to a `SessionUsage`.
- `storeAudio`, `storeTranscript`, and `storeVideo` on `session.start()` — per-artifact storage opt-outs, alongside the existing `storeRecording` (still the whole-run macro, so `false` persists nothing; a per-artifact option wins over it). Narrowing only: a session can request less storage than the account's consents allow, never more.
- `useRealtimeSession()` — React lifecycle hook for the one-session-at-a-time browser app: a fresh single-use client per run, every exit path funnelled into one teardown, cancellation of a start still in flight (`end()` or unmount while connecting disconnects the client the moment the start settles), and the Start affordance held closed until the spent client releases the microphone. Returns `{ phase, client, session, start, end, error, rejectedTools, warning, lastEnd, endedReason }`; `phase === 'live'` statically implies non-null `client`/`session`, and `start()` resolves a discriminated `RealtimeSessionStartResult` (`busy` / `failed` / `ended`). Also exports `RealtimeSessionPhase`, `RealtimeSessionEndSummary`, `RejectedTool`, `UseRealtimeSessionOptions`, and `UseRealtimeSessionResult`.
- Session-start rejections now throw typed errors, all exported: `SessionBusyError` (the workspace is at its concurrent-session limit; carries `retryAfterSeconds` when the server sends `Retry-After`), `SessionEntitlementError` (free minutes exhausted, or the plan doesn't include the model's provider), `SessionConfigError` (the config was rejected — unknown model, bad tool spec, oversize instructions, …), and `VersionMismatchError` (upgrade the SDK). All subclass `SessionStartError`, which is now exported along with `SessionStartTransportError` (the request never reached the server) — branch with `instanceof` instead of reading `status` off an untyped error. Classification keys on the server's error code, so a rejection the SDK doesn't recognize stays a plain `SessionStartError` rather than borrowing a more specific meaning. See [Errors](https://platform.askcosmo.ai/docs/concepts/errors#session-start-rejections).
- Every Cosmo REST call now carries the SDK identity as an `X-Cosmo-SDK` header (`cosmo-ai/<version>` — the npm package name and version), the same identity the SDK stamps on `session-config` as its `sdk` block. The constants are public: `SDK_NAME` and `SDK_VERSION`, both read from `package.json` at build time.
- `GrokModelOptions` (`provider: 'grok'`) — the xAI Grok Voice provider (`grok-voice-think-fast-2.0`), with no knobs today.

### Breaking

- The recorded-session REST endpoints moved from `/api/v1/external/voice-sessions` to `/api/v1/external/sessions`, and every schema on the surface lost the `Voice` qualifier: `VoiceSession` → `SessionRecord`, `VoiceSessionUsage` → `SessionUsage`, `VoiceSessionTokenUsage` → `SessionTokenUsage`, `VoiceSessionTranscriptTurn` → `SessionTranscriptTurn`, and `VoiceSessionImportRequest` → `SessionImportRequest`. The surface is not voice-specific, and the SDKs, the `cosmo` CLI, and the docs all move with it. Anything calling the old path directly must update; the old path is not served.
- `PROTOCOL_VERSION` is removed, and `session-config` no longer carries a `version` field — the wire protocol is unversioned and [evolves additively](https://platform.askcosmo.ai/docs/concepts/protocol-version). Read `SDK_VERSION` for a runtime version instead. `ready` and `reconnecting` frames no longer carry `version` either; the wire types drop the field.

### Changed

- One `RealtimeClient` now runs any number of concurrent sessions. `agent.start()` creates independent session state per call — matching Python — instead of throwing `NotReadyError` while another session is active, so server-side fan-out no longer needs one client per call. Each `RealtimeSession` owns its own state and events: `session.on(...)` and `for await (const event of session)` carry only that session's run, and no longer pick up frames from a later session started on the same client. The client-level session surface (`client.on(...)`, `client.getSnapshot()`, `client.sendText()`, mic/screen/video controls) behaves as before with a single session; with several running, client-level events aggregate every session and the methods target the most recently started one — hold the `RealtimeSession` objects to address a specific session. Code that relied on the removed throw as its concurrency guard (e.g. a double-invoked React effect) now opens two real sessions — add your own guard.
- `client.disconnect()` / `client.close()` end every live session. Called with none live, they no longer emit a transient `disconnecting` state; they still reset the client-level snapshot — clearing a failed session's error, or the `ready` transport state a server-ended session leaves behind — as before.
- `client.disconnect()` now interrupts an `agent.start()` still connecting: the start rejects with `NotReadyError` instead of the session coming up live after the disconnect resolved.
- `RealtimeSession`'s constructor (documented internal — construct via `agent.start()`) now takes the session's engine rather than the client, so external `new RealtimeSession(...)` calls no longer typecheck.

### Fixed

- A session started after an unsolicited disconnect no longer ends immediately. Previously the new session replayed the prior session's terminal state, so its stream closed before the run began.
- `session_ended` fires exactly once per session even when `session.end()` and `client.disconnect()` race each other.

### Breaking

- Session monitoring is removed: `connectAsMonitor`, `MonitorSession`, the React `useMonitorTranscript` hook, and the mic-takeover controls that existed for it (`acquireMic`, `publishHeldMic`, `releaseHeldMic`, `setListenMuted`). Monitoring a live session requires supervisor credentials that are not obtainable with external credentials (`apiKey` / minted tokens), so no external integration could ever invoke this surface.

## v0.3.0 — 2026-08-08

### Added

- `TokenSource` — a credential that fetches (and keeps fresh) a minted end-user token from your backend: `TokenSource.endpoint(url)` for any endpoint returning `{ jwt, expires_at }`, `TokenSource.custom(fn)` for full control. Pass it as `token`; the SDK caches the JWT, re-fetches inside a 60-second expiry margin, and drops the cache on a `401` session start. See [End-user credentials](https://platform.askcosmo.ai/docs/production/end-user-credentials).
- `{ kind: 'end_call' }` — the typed opt-in that lets the agent hang up. It supersedes the deprecated `{ kind: 'server', name: 'cosmo.end_call' }` reference, and a config using it now starts on the resolved session-start flow.
- `mintToken` responses now include `tokenId` — the handle for revoking that one token early (`DELETE /api/v1/external/auth/token/{token_id}`) — and `mintToken(externalUserId, { ttlSeconds })` (60–86400) shortens the 24-hour default lifetime.
- `OpenAIMiniModelOptions` (`provider: 'openai_mini'`) — the OpenAI Realtime mini tier: the same API on a faster, cheaper model, with no knobs today.
- `session.connectTimings` and `client.getConnectTimings()` return the connect-latency breakdown: the client-measured phases (`wsMs`, `roomMs`, `micMs`, `totalConnectMs`) plus `serverTimings`, the server's own phase breakdown. The server always sent its half; the SDK previously discarded it at the transport boundary, and measured none of its own. All three SDKs now expose the same shape.
- `startAudioStream(stream)` / `stopAudioStream()` take the session's voice with a caller-owned `MediaStream` — a Web Audio graph, a decoded WAV, an `<audio>` element's `captureStream()`, or a non-default input device — and give it back. Starting clears the server-side mute gate and takes the voice from the device microphone for the stream's lifetime, so the agent hears exactly what you send. A session carries one voice: starting a second stream throws the new `AudioPublishAlreadyActiveError`.
- Endpointing knobs on `modelOptions`. `GeminiModelOptions` gains `endOfSpeechSensitivity`, `silenceDurationMs`, `prefixPaddingMs`, and `includeThoughts`; `OpenAIModelOptions` gains `turnDetection` (`'server_vad'` / `'semantic_vad'`) with `eagerness` for the semantic detector and `silenceDurationMs` / `prefixPaddingMs` for the fixed window. Mixing the two detectors' knobs is a type error. Unset knobs keep today's behavior. See [Turn-taking](https://platform.askcosmo.ai/docs/concepts/turn-taking#provider-endpointing).
- `ScreenCaptureRequest` — what the `screen_locate` capture handler is now called with: `wantsElements` is false when the caller reads only the pixels, so a handler can skip building its element list (a DOM walk, an accessibility walk) for the vision locators, which never read it. Building that list is usually the expensive part of a capture. Existing zero-argument handlers keep working unchanged and simply have their elements dropped.

### Breaking

- The wire types the SDK re-exports now carry the names the server publishes, and session events take an `Event` postfix. Two public stems that disagreed with the wire are corrected: `TranscriptEvent` is `TranscriptDeltaEvent` and `SessionStateEvent` is `SessionStateWriteEvent`. Field names and shapes are unchanged.
- The error family loses its prefix down to the bare stem the other SDKs use: `MintTokenError`, `CredentialError`, `VerifyError`, `DialError`, `SessionStartError`, `SessionStartTransportError`, `NotReadyError`. `CosmoRealtimeError` is now `RealtimeError` — the root every SDK error extends, and the last `Cosmo`-prefixed name on the surface.
- `VerifyWorkspace` is now `WorkspaceInfo`, and the turn-taking and thinking knobs lose the prefix: `ThinkingLevel`, `EndOfSpeechSensitivity`, `SemanticEagerness`, `TurnDetectionMode`, `ErrorCode`.
- `RealtimeClientOptions` keeps its prefix. The generated client emits its own `ClientOptions` into the same package, so the bare name is taken.
- `UltravoxModelOptions` and `PersonaplexModelOptions` are gone from the package root, and `ModelOptions` narrows to `GeminiModelOptions | OpenAIModelOptions | OpenAIMiniModelOptions`. Select a voice model with the plain `model` string instead; per-provider tuning for those models is no longer exposed.
- `MixedSessionVocabularyError` is gone from the package root. Every session now posts to one session-start endpoint, so there is no vocabulary split left to refuse — a config that previously threw this before the request now starts.
- `cosmo-ai/cosmo` no longer exports the deprecated `COSMO_INSPECT_FRAME_TOOL` name. Opt into the typed `{ kind: 'examine_image' }` spec instead — same server tool, current vocabulary.
- The generic `{ kind: 'server', name }` tool reference is gone from `RealtimeTool`, and with it the entire `cosmo-ai/cosmo` entry point — the dot-namespaced name constants it carried (`COSMO_WEB_SEARCH_TOOL`, `COSMO_END_CALL_TOOL`, `COSMO_VIEW_STATE_TOOL`, `COSMO_SET_STATE_TOOL`, `COSMO_INSPECT_FRAME_TOOL`) had no remaining consumers once that shape left. The wire protocol already rejects the shape at session start; typed kinds (`{ kind: 'web_search' }`, `{ kind: 'end_call' }`, …) are the only way to opt into server tools.
- The skills loader is `cosmo_sdk_load_skill`, not `load_skill`. It joins the reserved `cosmo_sdk_` namespace the other SDK-shipped client tools use, so hooks and tool-call handlers matching the old name no longer fire, and the plain `load_skill` name is free for your own tools. A tool of your own claiming the reserved name is now rejected when you declare it, rather than silently dropping every skill on the agent.
- `activityEnd()` is `sendActivityEnd()`, on both the client and the session. It sends the `activity-end` frame like every other wire send, so it takes the `send` prefix the rest of that family carries — and the same name all three SDKs now use.
- `audio.noiseCancellation` defaults to off. The isolator sits ahead of the model, so the filtered signal is also what turn-taking reads, and a session that never asked for it should not pay that cost. Set `audio: { noiseCancellation: true }` to keep the previous behavior.
- A `PostToolUse` hook sees `ok` — carrying the handler's own untruncated result — where an over-cap client-tool result previously gave it an error. The cap is a transport property, not a tool failure. A hook that detected oversized results by matching the `client tool result exceeded the reply size limit` message no longer fires; read `cosmo_sdk_truncated` off the reply instead.

### Changed

- The screen locator's accessibility list carries names, not documents. `role`, `title`, and `label` are truncated to a descriptor length, and an element's `value` is sent only where nothing else names it — the locator grounds against the screenshot, so a named element's content is a second copy of pixels it can already read. A focused text area holding a long document previously shipped whole, and the capture could be rejected outright for its length.
- Launching a catalog agent by name (`client.catalogAgent(...)`) posts to the canonical session-start endpoint, like every other config.
- The packaged Agent Skill under `skills/` now covers the whole SDK family (TypeScript, Python, Swift); install it with `npx skills add socratic-ai/cosmo-ai`.
- The package is licensed Apache-2.0, and ships a `NOTICE` and a third-party license manifest.
- A client-tool result over the 15 KiB reply cap is shortened and delivered instead of discarded. Long strings are trimmed with `… [truncated]`; when the overflow is structural rather than textual, top-level entries are dropped largest-first. Either way the result carries a `cosmo_sdk_truncated` key — a note telling the model the answer is partial, plus the kept and original byte counts so it can tell losing a little from losing almost everything. Previously the whole result was replaced with a `client tool result exceeded the reply size limit` error, and a `PostToolUse` hook saw that error — it now sees `ok` with the handler's own untruncated result. See [Keep the reply small](https://platform.askcosmo.ai/docs/capabilities/tools#keep-the-reply-small).

### Fixed

- `RealtimeSessionStartError.detail` now carries the server's typed rejection — `detail.code` (`invalid_tool_config`, `free_minutes_exhausted`, `version_mismatch`, …), the real message, and any structured extras. Previously the session-start parser missed the error envelope, so `detail` was `null` and the error message was the generic status line.
- A frame the SDK cannot decode at all — malformed JSON, or an object with no `type` — now reaches the session stream as `{ type: 'unknown', rawType: null, rawText }` instead of being dropped inside the transport. A dropped frame was indistinguishable from one the server never sent, which is the opposite of what the forward-compatibility contract promises; decode failure was already non-terminal and stays so. `UnknownEvent` gains `rawText`, carrying the frame verbatim when there is no parsed payload to hand back (Python's `raw_text`).

## v0.2.0 — 2026-08-04

### Breaking

- Screen tools are SDK client tools now; the server-orchestrated screen path is gone.
- External agent config is regrouped into `voice` and `audio` blocks.
- The per-turn `audioResponse` flag is gone. Configure `audio.output: false` on the agent for a text-only session.
- `detect` and `point` tool kinds are now `detect_objects` and `point_at_object`.
- The agent derivation method is gone; build each agent from the client.
- Renderer tool text and the `draw_after` names changed.
- `react` / `react-dom` (`^19`) are required peer dependencies, and `zod` resolution settles on `^4` (a v3 install fails legibly).

### Added

- Zero-argument construction on Node: `new RealtimeClient({})` resolves `COSMO_API_KEY`, then the `cosmo login` credentials file, adopting the stored key's backend; a conflicting `COSMO_BASE_URL` is refused up front (`base_url_mismatch`). Browser behavior is unchanged.
- `cosmo-ai/server`, a React-free entry point for Next.js route handlers, server components, and other non-browser hosts.
- A packaged [Agent Skill](https://agentskills.io) under `skills/` teaching coding agents the current API, credential rules, and the deploy/share playbook — `npx skills add socratic-ai/cosmo-typescript-sdk`.
- `client.verify()` against `GET /realtime/verify` — a credential preflight that starts no session and costs nothing.
- `sendContext()`, which gives the agent state without taking a turn.
- `cosmo.usage` surfaced as a typed event, and `cosmo.session-state` decoded rather than dropped.

### Changed

- `session_ended` fires exactly once per session on any exit path — server end, client `end()`, transport failure — and the current `lifecycle` state (plus an already-fired `ready`) is replayed to late subscribers.
- The documented API origin is `https://platform.askcosmo.ai`.
- `audio.noiseCancellation` defaults to on.
- The SDK is quiet by default; opt into logging rather than out of it.
- A browser `apiKey` client falls back to the page origin instead of failing.
- The SDK owns normalized-coordinate mapping, so callers no longer convert.
- A cross-origin fetch failure is diagnosed rather than surfacing as a bare `TypeError`.

## v0.1.0 — 2026-05-01

Initial release.

- `RealtimeClient` class with `connect`, `disconnect`, `sendText`, `setMicMuted`, `waitUntilReady`.
- `CosmoRealtimeProvider` + `useRealtimeClient`, `useTransportState`, `useAgentState`, `useMediaState`, `useTranscript`, `useToolCalls`, `useRealtimeError`, `useMicLevel`, `useOutputLevel` hooks.
- `RealtimeAudio`, `MicToggle`, `BarVisualizer`, `StartAudio` components.
- Screen share: `startScreenShare`, `stopScreenShare`, `isScreenSharing`.
- Video stream API: `addVideoStream`, `removeVideoStream`.
- Automatic reconnect with configurable `maxAttempts` and `backoffMs`.
- Typed event system: `transport_state`, `agent_state`, `media_state`, `transcript`, `model_text`, `tool_call`, `tool_result`, `volume`, `error`, `ready`, `conversation_link`.
- Envelope chunking for control messages exceeding the data-channel threshold.
- Transport abstraction (`RealtimeTransport` interface) with `LiveKitTransport` default.
