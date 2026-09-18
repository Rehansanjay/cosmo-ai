# Migration guides

One section per SDK release that removed or reshaped public API, newest
first per SDK — assembled at each release from the
[migration guides](https://platform.askcosmo.ai/docs/meta/migration), which
are the canonical copy and the place to look when the installed SDK is
newer than this file's latest section.

When a build breaks after a version bump, grep this file for the symbol
the compiler no longer finds — removed names appear as literal text under
the release that removed them. Coming from more than one version back,
apply every section between your version and the target, oldest first; a
release without a section here changed nothing you have to touch.
Coverage reaches back to each SDK's earliest section; for anything older,
follow the `Breaking` sections in the
[changelog](https://platform.askcosmo.ai/docs/meta/changelog).

## Upgrade TypeScript to 0.7

Breaking changes when moving `cosmo-ai` from v0.6.0 to v0.7.0. The [changelog](https://platform.askcosmo.ai/docs/meta/changelog) has the full release notes; more than one version behind, [chain the pages](https://platform.askcosmo.ai/docs/meta/migration).

- `TranscriptDeltaEvent` is now the wire shape — `{ role, text, isFinal }`. The client-derived `id`, `turnId`, and `append` fields are removed: they were rendering instructions, and the session's coalesced transcript — `session.transcript`, one `TranscriptItem` per turn with a stable `id` — is the render-ready form.

- `tool()` is renamed `clientTool()`, and the background form is its own constructor rather than a flag: `tool({ background: true, ... })` becomes `backgroundClientTool({ ... })`, and `background` is gone from the option types — the constructor decides the form, so a caller can no longer set it to the value contradicting the one they called. The typed, raw and unsafe input forms are unchanged; they stay overloads of each constructor.

  ```typescript
  // before
  const lookup = tool({ name: 'lookup', description: '…', parameters, handler });
  const index  = tool({ name: 'index', description: '…', parameters, handler, background: true });
  // after — the constructor decides the form
  const lookup = clientTool({ name: 'lookup', description: '…', parameters, handler });
  const index  = backgroundClientTool({ name: 'index', description: '…', parameters, handler });
  ```

- Tools are built by calling a constructor, and every constructor returns `AgentTool`. `{ kind: 'web_search' }` and the other hand-written literals are no longer the documented form — `AgentTool` is a structural union, so an existing literal still compiles, but it is unsupported and gains none of the constructors' checks. Use `webSearchTool()`, `examineImageTool()`, `detectObjectsTool()`, `pointAtObjectTool()`, `endCallTool()`, `screenLocateTool(capture)`. The SDK-shipped renderers gained the same suffix: `drawBox` → `drawBoxTool`, `drawPoint` → `drawPointTool`, `screenClickElement` → `screenClickElementTool`, `screenHighlightElement` → `screenHighlightElementTool`, `screenHighlightBox` → `screenHighlightBoxTool`. The per-tool types (`ClientToolSpec`, `WebSearchToolSpec`, and the rest) are no longer exported — annotate with `AgentTool`, which `RealtimeTool` is also renamed to.

  ```typescript
  // before
  client.agent({ tools: [{ kind: 'web_search' }, { kind: 'examine_image' }] });
  // after
  client.agent({ tools: [webSearchTool(), examineImageTool()] });
  ```

- The agent's output level is metered from its audio track instead of the `<audio>` element playing it, so a custom `RealtimeTransport` must implement the new optional `getOutputStream` and `onOutputStreamChanged` to report an output level. It keeps compiling and stays audible without them; only `useOutputLevel` goes quiet. The element tap it replaces claimed the element for the life of the page and routed its sound through the audio graph, so ending a session left the element wired to a closed graph and the next session played silently.

  A custom transport adds the two optional members:

  ```typescript
  getOutputStream?(): MediaStream | null;              // the remote agent audio
  onOutputStreamChanged?(cb: () => void): Unsubscribe; // fires when it is replaced
  ```

- `audio.noiseCancellation` takes a mode instead of a boolean — `'off'`, `'denoise'` or `'voice_focus'`. The new one is `'denoise'`: it removes non-speech noise and keeps every voice, which is what a microphone several people share needs. `'voice_focus'` is the previous behaviour, and keeps only the speaker it judges primary — on a shared microphone that treats the second person as background and filters them out.

  `true` and `false` remain valid on the wire, so a session started by an already-published SDK version is unaffected.

  `true` becomes `'voice_focus'`, `false` becomes `'off'`. A two-person setup that was passing `true` and losing the quieter speaker wants `'denoise'`:

  ```ts
  // before
  client.agent({ audio: { noiseCancellation: true } });
  // after — same behaviour
  client.agent({ audio: { noiseCancellation: 'voice_focus' } });
  // after — noise goes, both voices stay
  client.agent({ audio: { noiseCancellation: 'denoise' } });
  ```

- Passing a workspace API key (`cosmo_…`) as `token` is refused at construction in every SDK. That parameter takes a minted end-user token; a key there authenticates anyway, so the mistake used to work — and shipped the key with whatever app carried it. Pass the key as the API-key parameter, or mint a token for the user with `mintToken` and pass that. Acts-as-user tokens (`cosmo_pat_…`) are unaffected.

  ```typescript
  // before
  new RealtimeClient({ token: apiKey });
  // after
  new RealtimeClient({ apiKey });
  ```

- The client-tool option types are named and exported: `ClientToolOptions` and `RawClientToolOptions`, each taking the handler as a type parameter — the handler is the only thing the immediate and background constructors differ by, so there is one type per input form rather than one per form per constructor. `ToolInput` stops being exported — a converter mints it, so it is not a type a caller writes.

- The Standard Schema input form is removed: `clientTool` and `backgroundClientTool` no longer take `{ input: <validator>, unsafeParameters }`, and `StandardSchemaV1`, `ToolInput` and `ToolInputParseResult` are no longer exported. It existed so a validator the SDK ships no converter for could still validate handler arguments, at the cost of publishing the interop types and a third call shape nothing used. A validator without a converter goes through `{ parameters }` — the hand-written schema form — and is called inside the handler. The two remaining forms are the two Python and Swift take.

  The typed `input` form (a converter-minted schema) is unchanged; this is the
  removed unsafe form's migration:

  ```typescript
  // before — the unsafe form: a Standard Schema validator beside a hand-written schema
  tool({ name: 'lookup', description: '…', input: lookupSchema, unsafeParameters: lookupJsonSchema, handler });
  // after — keep the hand-written parameters; run the validator inside the handler
  clientTool({
    name: 'lookup',
    description: '…',
    parameters: lookupJsonSchema,
    handler: async (args) => handle(lookupSchema.parse(args)),
  });
  ```

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

  Move the block to `model` and fold the old model string into its `model_id`:

  ```typescript
  // before
  client.agent({ model: 'gemini-live', modelOptions: { provider: 'gemini', temperature: 0.7 } });
  // after — the constructor stamps the provider tag
  client.agent({ model: GeminiModel({ modelId: 'gemini-live', temperature: 0.7 }) });
  ```

- `SkillParseError` is now `SkillError` and carries a `code` naming which failure it was, so a caller can tell them apart without reading the message. The codes are `not_a_directory`, `cannot_read`, `missing_frontmatter`, `unterminated_frontmatter`, `malformed_frontmatter_line`, `duplicate_frontmatter_key`, `missing_description` and `duplicate_skill_name` — a `SkillErrorCode` enum in Python and Swift, a union of the same values in TypeScript. The old name described only the five parsing failures, while the type has always also covered a bad path and a duplicate skill name. Match on `err.code`; `err.message` is the sentence alone, and an unreadable skills directory now raises `SkillError(cannot_read)` where it used to escape as a bare `PermissionError`.

  Breaking: Attaching skills reads the same in every SDK. Swift takes a directory through the `skills:` argument itself — `client.agent(skills: .directory(skillsURL))` — instead of `loadSkills(fromDirectory:)`, which is no longer public; `.directory(_:)` is a factory on `[Skill]`, so inline skills are unchanged and the two compose with `+`. Swift's `skills` is optional rather than defaulting to an empty array. `parseSkillMd` takes `defaultName` directly in TypeScript rather than wrapped in an options object, and `parse_skill_md` is now public in Python for SKILL.md text you already hold. The skill-assembly internals — `resolveSkills`, `skillsMenuText`, `buildLoadSkillTool`, `LoadSkillWiring`, `loadSkillToolName`, `UnknownSkillError` — are no longer public in Swift; the wire name the tool registers under is unchanged, so a hook matching `cosmo_sdk_load_skill` keeps working.

- `RealtimeAgent` exposes its resolved persona as fields — `agent.instructions`, `agent.skills`, `agent.voice`, `agent.tools`, `agent.model`, `agent.audio`, `agent.greeting`, `agent.hooks`, `agent.interruptionSensitivity`, `agent.name`, `agent.inputs` — instead of nesting them under `agent.config`, which is removed. Read `agent.instructions` where you read `agent.config.instructions`. Building a persona is unchanged: `client.agent({ instructions, voice })` still takes an options object, since JavaScript has no named arguments. This matches the Python and Swift SDKs, which have always flattened the same fields onto the agent.

- `MintTokenError.code` is now a closed `MintTokenErrorCode` naming what the SDK saw — `request_failed`, `invalid_response`, `request_rejected` or `missing_api_key` — and the server's own rejection slug moves to `server_code`, set only when the code is `request_rejected`. The two were previously the same field, so `code` could hold either the SDK's category or anything the server sent, down to a synthetic `http_<status>`, with no way to tell which. Match on `err.code` for what happened to the request and read `err.server_code` for why the server refused. Handlers comparing `code` against `"transport_error"` or against a server slug such as `"auth_failed"` need updating; `str(err)` is now the message alone, without the `code: ` prefix.

  Breaking: A `TokenSource` that cannot produce a token now raises `TokenSourceError` rather than `MintTokenError`, with its own `TokenSourceErrorCode` — `request_failed`, `request_rejected`, `invalid_response` or `fetcher_failed`. Resolving a token source is not part of `mint_token`: it happens beneath every authenticated call — `verify`, `mint_token`, session start, dial and usage reads all resolve it first, and it re-resolves on expiry and after a 401 — so the failure surfaced under the name of one operation it mostly had nothing to do with. `token_source_failed` is gone from `MintTokenErrorCode` accordingly, and the four new codes say which part failed where one bucket said only that something did. A refused redirect is `request_failed` in every SDK — it never reached a token endpoint, so there is no rejection to report; Python previously reported it as an `http_<status>` rejection.

  Breaking: TypeScript gets the same two errors. `MintTokenErrorCode` and `TokenSourceErrorCode` are literal unions rather than aliases of `string`, both errors take `{ code, message, serverCode }`, and a malformed `TokenSource.endpoint` URL now throws a `TypeError` rather than an SDK error — argument validation is not part of the error family, which is what the Python SDK already did.

  Breaking: Swift gets the same two errors, as structs replacing the `MintTokenError` enum. `MintTokenError.rejected(code:detail:)`, `.transport(message:)` and `.invalidResponse(message:)` are gone; construct or match `MintTokenError(code:message:serverCode:)` with a `MintTokenErrorCode` instead, and expect `TokenSourceError` where a `TokenSource` fetch used to raise a mint error. `mintToken` now refuses a client built with a minted token or a token source before the request goes out, with code `missingApiKey`, rather than letting the server answer 401 — and `TokenSource.custom` rejects a fetcher returning an empty `jwt` instead of sending it as a bearer.

  ```typescript
  // before — code could be the SDK's category or the server's slug
  if (err.code === 'auth_failed') reauthenticate();
  // after — code is the SDK's closed set; the server's slug is serverCode
  if (err.code === 'request_rejected' && err.serverCode === 'auth_failed') reauthenticate();
  ```

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

  ```typescript
  // before
  TokenSource.custom(async () => ({ jwt, expiresAt: '2026-09-14T00:00:00Z' }));
  // after — expiresAt is a Date; annotate with MintedToken
  TokenSource.custom(async (): Promise<MintedToken> => ({ jwt, expiresAt: new Date(expiry) }));
  ```

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

  ```typescript
  // before — every failure arrived as a summary with a client bucket
  session.on('error', (e) => { if (e.code === 'auth_error') signIn(); });
  // after — the event delivers the error itself, or null on the clear
  session.on('error', (error) => {
    if (error === null) return hideBanner(); // healthy again — e.g. the next start
    if (error instanceof SessionStartError) {
      if (error.serverCode === 'auth_failed') signIn();
      else showStartFailure(error.code); // busy, entitlement, config, …
    } else if (error instanceof AudioUnavailableError) {
      askForMicrophone();
    } else {
      banner(error.code, error.fatal); // the server's ErrorEvent
    }
  });
  ```

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

  In Python a server-added value is an enum member like any other, so declared
  versus added is a list check:

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

  ```typescript
  // before — fold the deltas yourself
  let items: RealtimeTranscriptItem[] = [];
  session.on('transcript', (delta) => { items = reduceTranscript(items, delta, 100); });
  // after — the session holds the folded transcript
  session.on('transcript_updated', ({ items }) => render(items));
  render(session.transcript); // same value, readable any time
  ```

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

  ```typescript
  // before
  try { await agent.start(); } catch (e) {
    if (e instanceof SessionBusyError) retryIn(e.retryAfterSeconds);
    else if (e instanceof SessionEntitlementError) showUpgrade();
    else throw e;
  }
  // after
  try { await agent.start(); } catch (e) {
    if (!(e instanceof SessionStartError)) throw e;
    if (e.code === 'busy') retryIn(e.retryAfterSeconds);
    else if (e.code === 'entitlement') showUpgrade();
    else throw e;
  }
  ```

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

  ```typescript
  // before — the stream yielded raw wire frames
  for await (const event of session) {
    if (event.type === 'tool-call') handle(event.tool_call_id);
  }
  // after — the stream yields the SDK's own event types, camelCased
  for await (const event of session) {
    if (event.type === 'tool_call') handle(event.toolCallId);
  }
  ```

- `cosmo-ai/tool/screen` stops exporting the `ScreenLocateTool` member type and the capture plumbing (`SCREEN_CAPTURE_RPC_METHOD`, `screenCaptureRpc`, `screenCapturePayload`, `ScreenCaptureCache`). The member type was the wire model behind `screenLocateTool(capture)` — annotate tool values with `AgentTool` — and the plumbing was the wiring behind it, never consumer API; the constructor and the capture-handler contract are unchanged.

- The React bindings are no longer re-exported from the package root — import them from `cosmo-ai/react`, which carries the whole surface. `import { RealtimeProvider, useTranscript } from 'cosmo-ai'` becomes `import { RealtimeProvider, useTranscript } from 'cosmo-ai/react'`; nothing else moves, and every name keeps its spelling. In exchange `react` and `react-dom` become optional peer dependencies, so a headless Node app no longer installs React to use the SDK, and `cosmo-ai/server` is now a narrower surface by choice rather than a workaround for the root pulling React into the `react-server` graph.

## Upgrade TypeScript to 0.6

Breaking changes when moving `cosmo-ai` from v0.5.1 to v0.6.0. The [changelog](https://platform.askcosmo.ai/docs/meta/changelog) has the full release notes; more than one version behind, [chain the pages](https://platform.askcosmo.ai/docs/meta/migration).

- `RealtimeClient` no longer carries the session surface — the client is credentials, base URL, and the agent factories (`agent`, `catalogAgent`, `verify`, `mintToken`, `getSessionUsage`). Everything scoped to one run lives on the `RealtimeSession` that `agent.start()` returns: the events, the state getters, the sends, and the media controls.

  Before:

  ```typescript
  const agent = client.agent({ instructions: 'You are a helpful assistant.' });
  await agent.start();
  client.on('transcript', onTranscript);
  await client.sendText('hello');
  await client.disconnect();
  ```

  After:

  ```typescript
  const agent = client.agent({ instructions: 'You are a helpful assistant.' });
  const session = await agent.start();
  session.on('transcript', onTranscript);
  await session.sendText('hello');
  await session.end();
  ```

  Most calls keep their name on the session; the ones that don't:

  - `client.sendPing()` → `session.ping()`
  - `client.setMicMuted(muted)` → `session.setMuted(muted)`
  - `client.disconnect()` / `client.close()` → `session.end()` (graceful) or `session.close()` (abrupt)
  - `client.getSessionId()` → `session.sessionId`
  - `client.getConnectTimings()` → `session.connectTimings`
  - `client.getLifecycleState()` → `session.state`
  - `client.isActive()` → read `session.state`
  - `client.isScreenSharing()` → `session.getScreenShareState().kind === 'active'`
  - `client.setError(error)` → removed; there is no session equivalent

- `RealtimeProvider` is fed a session, not a client: the `client`, `getAuthHeaders`, and `transportFactory` props are replaced by `session?: RealtimeSession | null`. The provider no longer constructs or disconnects a client of its own.

  Before:

  ```tsx
  <RealtimeProvider client={client}>
    <App />
  </RealtimeProvider>
  ```

  After:

  ```tsx
  const { session, start, end } = useRealtimeSession({
    makeAgent: (client) => client.agent({ instructions: 'You are a helpful assistant.' }),
  });

  <RealtimeProvider session={session}>
    <App />
  </RealtimeProvider>
  ```

  Pass `useRealtimeSession`'s `session` — or your own `agent.start()` result — and `null` between runs.

- `useRealtimeClient` and the `RealtimeClientLike` type are removed. Components that need imperative calls from context use `useRealtimeSessionContext()`, which returns the provider's `RealtimeSession | null`.

## Upgrade Python to 0.6

Breaking changes when moving `cosmo-ai-sdk` from v0.5.1 to v0.6.0. The [changelog](https://platform.askcosmo.ai/docs/meta/changelog) has the full release notes; more than one version behind, [chain the pages](https://platform.askcosmo.ai/docs/meta/migration).

- Tools are built by calling a constructor, and every constructor returns `AgentTool`. `WebSearchTool()` and its siblings are replaced by `web_search_tool()`, `examine_image_tool()`, `detect_objects_tool()`, `point_at_object_tool()`, `end_call_tool()`; `draw_box`, `draw_point`, `screen_locate`, `screen_click_element`, `screen_highlight_element` and `screen_highlight_box` gain a `_tool` suffix. The tool models are no longer exported — declare a hand-written JSON Schema with `client_tool(...)` / `background_client_tool(...)` instead of constructing `ClientTool` directly, and annotate with `AgentTool`, which is now the single discriminated union (`RealtimeToolSpec` is gone).

  ```python
  # before
  client.agent(tools=[WebSearchTool(), ClientTool(name="lookup", description="…", parameters=schema, handler=handle)])
  # after
  client.agent(tools=[web_search_tool(), client_tool(name="lookup", description="…", parameters=schema, handler=handle)])
  ```

- `client_tool(...)` and `background_client_tool(...)` validate at construction, matching `@tool`: the name grammar, the reserved `cosmo_sdk_` prefix, the description, and the schema dialect. A declaration the server would refuse now fails where you wrote it instead of arriving as a `ready.rejected_tools` entry at connect.

- Server-event models no longer carry the `type` and `id` fields. `type` was a constant restating the class (`isinstance` is the idiom, and decode never read the field), and `id` was a client-generated UUID that correlated with nothing — the wire defines neither on server events. Events now expose exactly the wire payload, matching the TypeScript and Swift SDKs field-for-field. Code branching on `event.type == "…"` switches to `isinstance(event, …Event)`; code logging `event.id` drops it.

  ```python
  # before
  async for event in session:
      if event.type == "transcript":
          print(event.text)
  # after
  async for event in session:
      if isinstance(event, TranscriptDeltaEvent):
          print(event.text)
  ```

- `audio.noise_cancellation` takes a mode instead of a boolean — `'off'`, `'denoise'` or `'voice_focus'`. The new one is `'denoise'`: it removes non-speech noise and keeps every voice, which is what a microphone several people share needs. `'voice_focus'` is the previous behaviour, and keeps only the speaker it judges primary — on a shared microphone that treats the second person as background and filters them out.

  `true` and `false` remain valid on the wire, so a session started by an already-published SDK version is unaffected.

  `true` becomes `'voice_focus'`, `false` becomes `'off'`. A two-person setup that was passing `true` and losing the quieter speaker wants `'denoise'`:

  ```python
  AudioConfig(noise_cancellation=NoiseCancellation.DENOISE)
  ```

- Passing a workspace API key (`cosmo_…`) as `token` is refused at construction in every SDK. That parameter takes a minted end-user token; a key there authenticates anyway, so the mistake used to work — and shipped the key with whatever app carried it. Pass the key as the API-key parameter, or mint a token for the user with `mint_token` and pass that. Acts-as-user tokens (`cosmo_pat_…`) are unaffected.

  ```python
  # before
  RealtimeClient(token=api_key)
  # after
  RealtimeClient(api_key=api_key)
  ```

- `model_options` is gone; its provider block moves onto `model`,
  which now takes either the model string it always took or one provider block
  naming the provider once — a model that disagrees with its knobs is
  unrepresentable. The provider types drop the `Options` suffix
  (`GeminiModelOptions` → `GeminiModel`, and likewise for OpenAI, OpenAI-mini
  and Grok), each block's `turn_detection` accepts only the detectors its
  provider offers (Cosmo-VAD tuning moves to `CosmoVadConfig` on the block's
  `cosmo_vad` field), and the union is named `RealtimeModel`: `RealtimeModelOptions` is renamed, taking either the
  string or the block, with `RealtimeModelBlock` for the block alone. A block with no model id runs the provider's default,
  and `model: "gemini"` still selects a provider by name. The server keeps
  accepting `model_options` from existing releases — the old pair folds into
  `model` server-side — so upgrading the SDK is not coupled to a backend
  deploy.

  Move the block to `model` and fold the old model string into its `model_id`:

  ```python
  # before
  client.agent(model="gemini-live", model_options=GeminiModelOptions(temperature=0.7))
  # after
  client.agent(model=GeminiModel(model_id="gemini-live", temperature=0.7))
  ```

- `SkillParseError` is now `SkillError` and carries a `code` naming which failure it was, so a caller can tell them apart without reading the message. The codes are `not_a_directory`, `cannot_read`, `missing_frontmatter`, `unterminated_frontmatter`, `malformed_frontmatter_line`, `duplicate_frontmatter_key`, `missing_description` and `duplicate_skill_name` — a `SkillErrorCode` enum in Python and Swift, a union of the same values in TypeScript. The old name described only the five parsing failures, while the type has always also covered a bad path and a duplicate skill name. Match on `err.code`; `err.message` is the sentence alone, and an unreadable skills directory now raises `SkillError(cannot_read)` where it used to escape as a bare `PermissionError`.

  Breaking: Attaching skills reads the same in every SDK. Swift takes a directory through the `skills:` argument itself — `client.agent(skills: .directory(skillsURL))` — instead of `loadSkills(fromDirectory:)`, which is no longer public; `.directory(_:)` is a factory on `[Skill]`, so inline skills are unchanged and the two compose with `+`. Swift's `skills` is optional rather than defaulting to an empty array. `parseSkillMd` takes `defaultName` directly in TypeScript rather than wrapped in an options object, and `parse_skill_md` is now public in Python for SKILL.md text you already hold. The skill-assembly internals — `resolveSkills`, `skillsMenuText`, `buildLoadSkillTool`, `LoadSkillWiring`, `loadSkillToolName`, `UnknownSkillError` — are no longer public in Swift; the wire name the tool registers under is unchanged, so a hook matching `cosmo_sdk_load_skill` keeps working.

- Every MCP failure now raises `McpError`, carrying a `code` naming which one it was, so a caller can tell them apart without reading the message. The codes are `not_a_file`, `cannot_read`, `invalid_json`, `missing_servers`, `invalid_server_entry`, `missing_command`, `invalid_args`, `invalid_env`, `invalid_cwd`, `duplicate_server_name`, `connection_failed`, `invalid_response`, `server_error` and `tool_error`, plus `extra_not_installed` — an `McpErrorCode` enum. It replaces `McpConfigError`, and covers connection and tool-call failures as well as config, so
  one `except McpError` spans the whole concept. Match on `error.code`; the message is the sentence alone. `McpError` is no longer a `ValueError` — a dead subprocess is no ValueError. Two classes fold into codes: `McpToolError`, a bare `RuntimeError` outside the error family, becomes `tool_error`, and `McpExtraNotInstalledError` becomes `extra_not_installed`. The second is breaking for anyone catching `ImportError` or `ExtraNotInstalledError` around a missing `[mcp]` install — catch `McpError` and match the code instead. `ExtraNotInstalledError` is removed with it: MCP was the only extra that raised it, so it was a base class for a family of none.

  Breaking: Attaching MCP servers reads the same in both SDKs. Swift takes servers through the `mcp:` argument itself — `client.agent(mcp: .configFile(configURL))` — instead of `McpRegistry`, which is no longer public; `.configFile(_:)` is a factory on `[McpStdioServer]`, so inline servers are unchanged and the two compose with `+`. `catalogAgent` now throws, since duplicate server names are rejected when the agent is built rather than mid-call. The MCP internals — `McpRegistry`, `ConnectedMcp`, `SkippedTool`, `MCPToolInfo`, `MCPCallResult`, `MCPTransport`, `MCPTransportFactory`, `defaultMCPTransportFactory` and `parseMcpConfig` — are no longer public in Swift.

  Fixed: Swift now rejects malformed `.mcp.json` fields it previously accepted in silence. `args` that is not an array, or holds a boolean or an object, raises `invalid_args` instead of being coerced through string conversion — a `true` became the argument `"1"`. An `env` that is not an object of strings raises `invalid_env` rather than being dropped, which had launched the server without the variables it was configured with; a non-string `cwd` raises `invalid_cwd` on the same footing. Duplicate server names are now rejected in Swift as they already were in Python. In Python, an unreadable config file raises `McpError(cannot_read)` where it used to escape as a bare `PermissionError`, an invalid document is `invalid_json` rather than sharing one message with an unreadable one, and `"args": null` means absent, as it already did for `env` and `cwd`. Both SDKs run the same `mcp-config-vectors.json` conformance file.

  Fixed: The runtime codes now say what actually failed. A dead subprocess reports `connection_failed` in Python where it used to report `server_error`, and a reply the SDK cannot decode reports `invalid_response`, which nothing raised before — the three are read from the exception the `mcp` package raises rather than collapsed into one. In Swift, a well-formed `.mcp.json` whose root is not an object reports `missing_servers` instead of claiming the text is not valid JSON, and a config inside a directory the process cannot traverse reports `cannot_read` instead of `not_a_file` — `fileExists` answers false for a permission wall exactly as it does for an absent file, so the read classifies it now.

  Breaking: A number in `args` is accepted only when it is whole and fits in a signed 64-bit integer, and is written in decimal. `1.0` and `1` are indistinguishable once decoded and a larger integer reached the process in scientific notation, so neither had a spelling both SDKs agreed on; quote the value instead. Both SDKs also walk a document's entries in name order now, which fixes the order servers are attached in and which malformed entry is reported when more than one is bad — Python previously followed document order.

  Fixed: A `.mcp.json` whose bytes are not UTF-8 now raises `McpError` coded `cannot_read` in both SDKs. Python raised a bare `UnicodeDecodeError`, which is a `ValueError` rather than an `OSError` and so escaped the error family entirely; Swift reported `not_a_file` about a file that is there.

- `MintTokenError.code` is now a closed `MintTokenErrorCode` naming what the SDK saw — `request_failed`, `invalid_response`, `request_rejected` or `missing_api_key` — and the server's own rejection slug moves to `server_code`, set only when the code is `request_rejected`. The two were previously the same field, so `code` could hold either the SDK's category or anything the server sent, down to a synthetic `http_<status>`, with no way to tell which. Match on `err.code` for what happened to the request and read `err.server_code` for why the server refused. Handlers comparing `code` against `"transport_error"` or against a server slug such as `"auth_failed"` need updating; `str(err)` is now the message alone, without the `code: ` prefix.

  Breaking: A `TokenSource` that cannot produce a token now raises `TokenSourceError` rather than `MintTokenError`, with its own `TokenSourceErrorCode` — `request_failed`, `request_rejected`, `invalid_response` or `fetcher_failed`. Resolving a token source is not part of `mint_token`: it happens beneath every authenticated call — `verify`, `mint_token`, session start, dial and usage reads all resolve it first, and it re-resolves on expiry and after a 401 — so the failure surfaced under the name of one operation it mostly had nothing to do with. `token_source_failed` is gone from `MintTokenErrorCode` accordingly, and the four new codes say which part failed where one bucket said only that something did. A refused redirect is `request_failed` in every SDK — it never reached a token endpoint, so there is no rejection to report; Python previously reported it as an `http_<status>` rejection.

  Breaking: TypeScript gets the same two errors. `MintTokenErrorCode` and `TokenSourceErrorCode` are literal unions rather than aliases of `string`, both errors take `{ code, message, serverCode }`, and a malformed `TokenSource.endpoint` URL now throws a `TypeError` rather than an SDK error — argument validation is not part of the error family, which is what the Python SDK already did.

  Breaking: Swift gets the same two errors, as structs replacing the `MintTokenError` enum. `MintTokenError.rejected(code:detail:)`, `.transport(message:)` and `.invalidResponse(message:)` are gone; construct or match `MintTokenError(code:message:serverCode:)` with a `MintTokenErrorCode` instead, and expect `TokenSourceError` where a `TokenSource` fetch used to raise a mint error. `mint_token` now refuses a client built with a minted token or a token source before the request goes out, with code `missing_api_key`, rather than letting the server answer 401 — and `TokenSource.custom` rejects a fetcher returning an empty `jwt` instead of sending it as a bearer.

  ```python
  # before
  if err.code == "auth_failed": reauthenticate()
  # after
  if err.code == "request_rejected" and err.server_code == "auth_failed": reauthenticate()
  ```

- A `TokenSource.custom` fetcher now resolves with the same shape
  `mint_token` returns — a `MintedToken` — in every SDK. Python no longer
  accepts a plain `{jwt, expires_at}` mapping (construct `MintedToken`, which
  still parses an RFC 3339 `expires_at` string), and TypeScript no longer
  accepts a string `expiresAt` (pass a `Date`; the `FetchedToken` type is
  removed — annotate with `MintedToken`). Python's direct `TokenSource(...)`
  construction now validates identically to `custom` instead of bypassing it.
  Swift is unchanged.

  ```python
  # before
  async def fetch(): return {"jwt": jwt, "expires_at": expires_at}
  # after — construct MintedToken (still parses an RFC 3339 string)
  async def fetch(): return MintedToken(jwt=jwt, expires_at=expires_at)
  ```

- `AmbienceConfig` and the agent's `audio.ambience` field are removed
  from every SDK, along with `AmbienceTrack`. The field never produced
  audible ambience on any session started through this API — it was accepted and
  validated, then dropped — so removing it changes no behavior. Delete `ambience`
  from your agent's `audio` block; the rest of the block is unchanged.

- The five backend calls share an `ApiError` base — `MintTokenError`,
  `TokenSourceError`, `VerifyError`, `UsageError` and `DialError` all descend
  from it, so one catch covers any of them while catching a specific one still
  says which call it was. `server_code` moves to the base, because a rejection
  slug belongs to whichever backend answered rather than to the call that asked.

  `VerifyError`, `UsageError` and `DialError` gain closed code enums in place of
  a bare string: `request_failed`, `request_rejected`, `invalid_response`, plus
  `invalid_request` on dial and usage for a call the SDK refuses to make. Where a
  server slug was the `code`, it is now `server_code` and `code` is
  `request_rejected`. Swift gains `DialError`, which it did not have, and its
  `UsageError` and `VerifyError` become structs carrying `code` rather than
  case-carrying enums.

- One `CredentialsError` with the closed `CredentialsErrorCode`
  replaces six spellings of the same failure — TypeScript's `CredentialError`
  (singular), Python's `CredentialsError` plus its `NotFound`, `File`, `Expired`
  and `Mismatch` subclasses, and Swift's case-carrying enum. The five resolution
  codes are the slugs the cross-SDK vectors already pinned; `conflicting_credentials`,
  `api_key_in_token_slot` and `insecure_base_url` cover the construction-time
  guards, which previously threw `ValueError` or `TypeError`. `CredentialsError` is also a `ValueError`, so existing handling keeps working.

- Every error carries `message`, so `except RealtimeError as e` /
  `catch let e as RealtimeError` can read it without narrowing to a concrete
  type first. In Swift `message` is now a `RealtimeError` requirement, which a
  type conforming to the protocol outside the SDK must add. In Python
  `RealtimeError` and its argument-less subclasses — `NotConnectedError`,
  `VideoPublishAlreadyActiveError` — now take the message as their one
  positional argument. `str(error)` is unchanged, including the `"code: message"`
  form the session, dial, usage, verify and tool-schema errors render.

- Registering a hook that cannot work now throws `HookError` in every
  SDK, with the closed `HookErrorCode` — `malformed_matcher`, `invalid_hook`,
  `server_hook_not_allowed`. These previously raised `ValueError` and `TypeError`, so neither was catchable as
  `RealtimeError`. `HookError` is exported from `cosmo_ai.hooks`, beside the hooks it describes. `HookError` is a `ValueError`, so an `except ValueError` around hook declaration keeps firing;
  the two cases that raised `TypeError` no longer do.

- `AudioUnavailableError` and `AudioPublishAlreadyActiveError` now
  require the message they always carried, so `AudioUnavailableError()` with no
  arguments raises `TypeError` where it used to build an error with no text.
  Pass the message positionally, as every raise site already did.

- `session-ending-soon` now decodes to the typed
  `SessionEndingSoonEvent`, carrying `seconds_remaining` and a stable
  `reason` slug, instead of surfacing through the unknown-event
  fallthrough. Code that matched `UnknownEvent` with
  `raw_type == "session-ending-soon"` and read the raw payload must match
  `SessionEndingSoonEvent` instead — the unknown-event arm no longer fires
  for this frame. The session keeps running until `session-ended`, so use
  the warning to have the agent wrap up or show a countdown.

- `agent.start()` now resolves when the session is ready — the
  server's handshake has landed — instead of at transport join, so every
  session method works the moment it returns. This closes a silent-loss
  window: a send in the join→ready gap previously reached a data channel no
  agent was subscribed to yet, and was dropped with no error. A session
  whose ready handshake never arrives within 40 seconds is torn down and
  `start()` raises `SessionStartError` coded `ready_timeout`; a room that
  closes before ready raises it coded `handshake_failed`, carrying the
  server's boot-failure `error` frame code and message when one preceded
  the close. Cancelling a pending start tears the session down and
  re-raises `CancelledError`, so `asyncio.timeout` and task cancellation
  abort a start cleanly. Readiness is also read from the agent's
  `cosmo.ready` participant attribute, so a session that joins after the
  agent came up — a mid-call observer, a reconnect — still observes it.

- The screen-capture handler has one shape — it always receives the `ScreenCaptureRequest`. The zero-argument form is gone: in Python `screen_locate_tool`'s handler must accept the request (`lambda request: ...`; ignore it if unneeded), and in Swift the handler type is the top-level `ScreenCaptureHandler` — the request-taking signature (`{ request in ... }` or `{ _ in ... }`), matching the Python and TypeScript name — with the nested `ScreenLocateTool.Handler` and `RequestHandler` names removed. TypeScript already had this shape and is unchanged. Migrate deliberately: a zero-argument handler now fails at call time, and in Python the arity error's text would reach the model as the locator's spoken reason.

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

  In Python a server-added value is an enum member like any other, so declared
  versus added is a list check:

  ```python
  if event.code not in list(ErrorCode): log_unknown(event.code)
  ```

- Every way a start can fail now raises one `SessionStartError`, whose
  closed `SessionStartErrorCode` names how far the attempt got — `transport`,
  `invalid_response`, `join_failed`, `config`, `busy`, `entitlement`,
  `version_mismatch`, `voice_disabled`, `rejected`, `handshake_failed`,
  `ready_timeout`. Switch on
  `code` where you used to branch on a type or read an HTTP status, and read the
  server's own rejection slug from `server_code` beside it. It replaces `VersionMismatchError`. In Python
  the base error's `code` — previously open, carrying the server's own slug or
  a synthetic `http_<status>` — closes to the enum, with the slug moving to
  `server_code`.

  ```python
  # before — code carried the server's own slug
  try: session = await agent.start()
  except SessionStartError as e:
      if e.code == "concurrent_session_limit": wait_and_retry()
      else: raise
  # after — code is the closed SessionStartErrorCode; the slug is server_code
  try: session = await agent.start()
  except SessionStartError as e:
      if e.code == "busy": wait_and_retry()
      else: raise
  ```

- `SessionStartError.detail` is a `SessionStartRejection` in every SDK —
  the server's structured reason for refusing a start, which no SDK carried in full before. Each group of fields belongs
  to one server code: `limit` / `active` for `concurrent_session_limit`,
  `granted_minutes` / `used_minutes` for `free_minutes_exhausted`,
  `balance_cents` / `top_up_path` for `insufficient_credits`, `meter` /
  `included` / `used` / `reset_at` for `quota_exceeded`, and `provider` /
  `allowed_providers` / `plan` / `upgrade_path` for `provider_not_entitled`. A
  field the server adds that the SDK does not name is kept rather than dropped.
  

- Calling a session method the session cannot serve now throws
  `SessionStateError` with the closed `SessionStateErrorCode` — `not_connected`,
  `already_started`, `audio_publish_already_active`,
  `video_publish_already_active`, `screen_share_unavailable`, `invalid_payload`.
  It replaces `NotConnectedError`, `AudioPublishAlreadyActiveError` and
  `VideoPublishAlreadyActiveError`. A send issued before `ready` and one issued after the
  session ended both report `not_connected`.

- The session state machine's value type has one name in every SDK
  — `SessionState`. `RealtimeSessionState` is renamed; fields, kinds, and behaviour are unchanged, so the migration
  is the rename alone.

- `ToolSchemaError` is now `ToolDefinitionError`, and it covers the
  whole declaration — a bad tool name and a missing or overlong description
  throw it too, where a bare `ValueError` was raised before. It is now catchable as `RealtimeError` like every other SDK error, and is still a `ValueError`,
  so existing handling keeps working. `code` is the closed `ToolDefinitionErrorCode` rather than a
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

## Upgrade Swift to 0.8

Breaking changes when moving `cosmo-swift-sdk` from v0.7.0 to v0.8.0. The [changelog](https://platform.askcosmo.ai/docs/meta/changelog) has the full release notes; more than one version behind, [chain the pages](https://platform.askcosmo.ai/docs/meta/migration).

- `audio.noiseCancellation` takes a mode instead of a boolean — `'off'`, `'denoise'` or `'voice_focus'`. The new one is `'denoise'`: it removes non-speech noise and keeps every voice, which is what a microphone several people share needs. `'voice_focus'` is the previous behaviour, and keeps only the speaker it judges primary — on a shared microphone that treats the second person as background and filters them out.

  `true` and `false` remain valid on the wire, so a session started by an already-published SDK version is unaffected.

  `true` becomes `'voice_focus'`, `false` becomes `'off'`. A two-person setup that was passing `true` and losing the quieter speaker wants `'denoise'`:

  ```swift
  AudioConfig(noiseCancellation: .denoise)
  ```

- Tools are built by calling a constructor on `AgentTool`, and every constructor returns `AgentTool`, so a `tools:` literal reads `[.webSearchTool(), .drawBoxTool(onDraw:)]`. The enum cases are internal: `.webSearch`, `.examineImage`, `.detectObjects`, `.pointAtObject`, `.client(...)`, `.backgroundClient(...)` and `.screenLocate(...)` are replaced by `webSearchTool()`, `examineImageTool()`, `detectObjectsTool()`, `pointAtObjectTool()`, `clientTool(...)`, `backgroundClientTool(...)` and `screenLocateTool(capture:)`. `AgentTool.define` / `defineBackground` are renamed `clientTool` / `backgroundClientTool`, each overloading on a `ToolSchema` or raw `parameters`. `AgentTool` is now a struct; `name` and `clientToolHandler` stay readable on the built value.

  ```swift
  // before
  let agent = try client.agent(tools: [.webSearch, .client(name: "lookup", description: "…", parameters: schema, handler: handle)])
  // after
  let agent = try client.agent(tools: [.webSearchTool(), .clientTool(name: "lookup", description: "…", parameters: schema, handler: handle)])
  ```

- The session-event types move to the top level under the cross-SDK names — the same symbols Python and TypeScript publish, with the `Event` postfix the event union's members carry everywhere else. `RealtimeSession.Event` → `RealtimeSessionEvent`, and the payload typealiases follow: `RealtimeSession.Ready` → `ReadyEvent`, `.TranscriptDelta` → `TranscriptDeltaEvent`, `.ModelText` → `ModelTextEvent`, `.TurnComplete` → `TurnCompleteEvent`, `.ToolCall` → `ToolCallEvent`, `.ToolDispatchStarted` → `ToolDispatchStartedEvent`, `.ToolResult` → `ToolResultEvent`, `.ToolInvocation` → `ToolInvocationEvent`, `.Reconnecting` → `ReconnectingEvent`, `.UserSpeechTimeout` → `UserSpeechTimeoutEvent`, `.SessionEnded` → `SessionEndedEvent`, `.ErrorEvent` → `ErrorEvent`, `.ErrorCode` → `ErrorCode`, `.RejectedTool` → `RejectedTool`, `.ResolvedAgent` → `ResolvedAgent`. Case names and field shapes are unchanged — only the type spellings move.

- Passing a workspace API key (`cosmo_…`) as `token` is refused at construction in every SDK. That parameter takes a minted end-user token; a key there authenticates anyway, so the mistake used to work — and shipped the key with whatever app carried it. Pass the key as the API-key parameter, or mint a token for the user with `mintToken` and pass that. Acts-as-user tokens (`cosmo_pat_…`) are unaffected.

  ```swift
  // before
  RealtimeClient(.init(token: apiKey))
  // after
  RealtimeClient(apiKey: apiKey)
  ```

- The `.cosmo(CosmoEvent)` wrapper case is gone: wire `cosmo.usage` now surfaces directly as `.usage(UsageEvent)` (`RealtimeSession.CosmoUsage` → `UsageEvent`), matching the event's place in the Python and TypeScript unions. `if case .cosmo(.usage(let u))` becomes `if case .usage(let u)`.

- `ToolInvocationEvent.args` is now a plain `[String: JSONValue]` (empty when the wire omits it), replacing the generator's opaque `ArgsPayload` container — read arguments directly instead of digging through `additionalProperties`. `origin` is a `ToolInvocationOrigin` enum (`.realtime` / `.server`), keeping the wire's closed set exhaustively switchable.

- `ToolOutcome`'s payloads are labeled: `case ok(result:)`, `case error(message:)`, `case denied(reason:)`. The declaration now names what each case carries, matching the field names Python and TypeScript already publish. Reading one is unaffected — `case .ok(let result)` reads the same — but constructing one positionally is not: `ToolOutcome.error(text)` becomes `ToolOutcome.error(message: text)`. `PostToolUseContext.init` is public and takes an outcome, so a hook's own unit tests construct these and need the labels.

- `RealtimeClient.Transport.webrtc` is the canonical/default room transport case, replacing the vendor-named `.livekit`. The deprecated `.livekit` alias still connects through WebRTC, but exhaustive switches must add `.webrtc`.

- A client tool carries the handler that runs it: `AgentTool.clientTool(name:description:parameters:handler:)` no longer defaults `handler` to `nil`, and neither does the `.client` case. Declaring a tool this client cannot execute advertised one that failed on every invocation, which the transport layer already said it would. A tool the server invokes over RPC without ever listing it to the agent is unchanged and unaffected — that is `RealtimeAgent.start(…rpcHandlers:)`, the register-only complement, and it is now the only way to express it.

- `model_options` is gone; its provider block moves onto `model`,
  which now takes either the model string it always took or one provider block
  naming the provider once — a model that disagrees with its knobs is
  unrepresentable. The provider types drop the `Options` suffix
  (`GeminiModelOptions` → `GeminiModel`, and likewise for OpenAI, OpenAI-mini
  and Grok), each block's `turn_detection` accepts only the detectors its
  provider offers (Cosmo-VAD tuning moves to `CosmoVadConfig` on the block's
  `cosmoVad` field), and the `ModelOptions` enum becomes `RealtimeModel`, whose `.id("…")` case is the string form
  and whose block cases carry the provider's knobs. A block with no model id runs the provider's default,
  and `.id("gemini")` still selects a provider by name. The server keeps
  accepting `model_options` from existing releases — the old pair folds into
  `model` server-side — so upgrading the SDK is not coupled to a backend
  deploy.

  Move the block to `model` and fold the old model string into its `model_id`:

  ```swift
  // before
  try client.agent(model: "gemini-live", modelOptions: .gemini(temperature: 0.7))
  // after — the case is the provider
  try client.agent(model: .gemini(GeminiModel(modelId: "gemini-live", temperature: 0.7)))
  ```

- Client settings are the initializer's parameters, so `RealtimeClient.Options` is gone. `RealtimeClient(.init(apiKey: key))` becomes `RealtimeClient(apiKey: key)`, and the same for `token:` and `tokenSource:`; `try RealtimeClient()` is unchanged. Every parameter — `baseURL`, `connectTimeout`, `requestTimeout`, `verifyTLS` — keeps its name and default, one level up. `Options.Credential` goes with it: the four initializers cover the same three credential forms, so nothing is lost.

- `RealtimeClient.canMint` is removed. It reported whether a credential was an API key but gated nothing — `mintToken` always let the server rule on the credential, and it still does. A client that cannot mint raises `MintTokenError` with `code == .missingApiKey`, before the request goes out.

- The `CosmoRealtimeMint` product is removed and
  `mintToken(externalUserId:ttlSeconds:)` now ships in `CosmoRealtime`. Drop
  the product from your `Package.swift` dependencies and delete
  `import CosmoRealtimeMint`; the method is on the same `RealtimeClient` and
  its signature is unchanged. Minting still requires an api-key credential —
  a client holding a minted token or a `TokenSource` raises `MintTokenError`
  with `code == .missingApiKey` before any request goes out — and it matches
  how the Python and TypeScript SDKs expose the same call.

- `RealtimeError` is now a protocol every error in the SDK conforms to, so `catch let error as RealtimeError` catches them as one family — matching `except RealtimeError` in Python and `instanceof RealtimeError` in TypeScript. It replaces the enum of the same name, whose cases were unreachable: `.connectTimeout` was converted internally before any caller saw it, and `.sessionStartFailed`, `.notConnected`, `.alreadyConnected`, `.screenShareUnavailable` and `.invalidWirePayload` were never thrown at all. Catch the equivalent SDK error instead — `SessionStartError` for a failed start, `SessionStateError` for a call the session cannot serve.

  Changed: Failures that used to surface as raw LiveKit or Foundation errors now arrive as SDK errors, so the catch above covers them. A failed data publish, byte stream, or microphone toggle raises `SessionStartError` coded `transport`; unreadable or non-JSON `.mcp.json` raises `McpError`; and a `SKILL.md` that cannot be read or decoded, or a skills directory that cannot be listed, raises `SkillError` — matching what the Python SDK already did. Code matching on the underlying framework error types needs to read the SDK error instead.

- `SkillParseError` is now `SkillError` and carries a `code` naming which failure it was, so a caller can tell them apart without reading the message. The codes are `not_a_directory`, `cannot_read`, `missing_frontmatter`, `unterminated_frontmatter`, `malformed_frontmatter_line`, `duplicate_frontmatter_key`, `missing_description` and `duplicate_skill_name` — a `SkillErrorCode` enum in Python and Swift, a union of the same values in TypeScript. The old name described only the five parsing failures, while the type has always also covered a bad path and a duplicate skill name. Match on `err.code`; `err.message` is the sentence alone, and an unreadable skills directory now raises `SkillError(cannot_read)` where it used to escape as a bare `PermissionError`.

  Breaking: Attaching skills reads the same in every SDK. Swift takes a directory through the `skills:` argument itself — `client.agent(skills: .directory(skillsURL))` — instead of `loadSkills(fromDirectory:)`, which is no longer public; `.directory(_:)` is a factory on `[Skill]`, so inline skills are unchanged and the two compose with `+`. Swift's `skills` is optional rather than defaulting to an empty array. `parseSkillMd` takes `defaultName` directly in TypeScript rather than wrapped in an options object, and `parse_skill_md` is now public in Python for SKILL.md text you already hold. The skill-assembly internals — `resolveSkills`, `skillsMenuText`, `buildLoadSkillTool`, `LoadSkillWiring`, `loadSkillToolName`, `UnknownSkillError` — are no longer public in Swift; the wire name the tool registers under is unchanged, so a hook matching `cosmo_sdk_load_skill` keeps working.

- Every MCP failure now raises `McpError`, carrying a `code` naming which one it was, so a caller can tell them apart without reading the message. The codes are `not_a_file`, `cannot_read`, `invalid_json`, `missing_servers`, `invalid_server_entry`, `missing_command`, `invalid_args`, `invalid_env`, `invalid_cwd`, `duplicate_server_name`, `connection_failed`, `invalid_response`, `server_error` and `tool_error`, — an `McpErrorCode` enum. It replaces `MCPConfigError` and `MCPError`, and covers connection and tool-call failures as
  well as config, so one `catch let error as McpError` spans the whole concept. Match on `error.code`; the message is the sentence alone. `McpError` is no longer a `ValueError` — a dead subprocess is no ValueError. Two classes fold into codes: `McpToolError`, a bare `RuntimeError` outside the error family, becomes `tool_error`, and `McpExtraNotInstalledError` becomes `extra_not_installed`. The second is breaking for anyone catching `ImportError` or `ExtraNotInstalledError` around a missing `[mcp]` install — catch `McpError` and match the code instead. `ExtraNotInstalledError` is removed with it: MCP was the only extra that raised it, so it was a base class for a family of none.

  Breaking: Attaching MCP servers reads the same in both SDKs. Swift takes servers through the `mcp:` argument itself — `client.agent(mcp: .configFile(configURL))` — instead of `McpRegistry`, which is no longer public; `.configFile(_:)` is a factory on `[McpStdioServer]`, so inline servers are unchanged and the two compose with `+`. `catalogAgent` now throws, since duplicate server names are rejected when the agent is built rather than mid-call. The MCP internals — `McpRegistry`, `ConnectedMcp`, `SkippedTool`, `MCPToolInfo`, `MCPCallResult`, `MCPTransport`, `MCPTransportFactory`, `defaultMCPTransportFactory` and `parseMcpConfig` — are no longer public in Swift.

  Fixed: Swift now rejects malformed `.mcp.json` fields it previously accepted in silence. `args` that is not an array, or holds a boolean or an object, raises `invalid_args` instead of being coerced through string conversion — a `true` became the argument `"1"`. An `env` that is not an object of strings raises `invalid_env` rather than being dropped, which had launched the server without the variables it was configured with; a non-string `cwd` raises `invalid_cwd` on the same footing. Duplicate server names are now rejected in Swift as they already were in Python. In Python, an unreadable config file raises `McpError(cannot_read)` where it used to escape as a bare `PermissionError`, an invalid document is `invalid_json` rather than sharing one message with an unreadable one, and `"args": null` means absent, as it already did for `env` and `cwd`. Both SDKs run the same `mcp-config-vectors.json` conformance file.

  Fixed: The runtime codes now say what actually failed. A dead subprocess reports `connection_failed` in Python where it used to report `server_error`, and a reply the SDK cannot decode reports `invalid_response`, which nothing raised before — the three are read from the exception the `mcp` package raises rather than collapsed into one. In Swift, a well-formed `.mcp.json` whose root is not an object reports `missing_servers` instead of claiming the text is not valid JSON, and a config inside a directory the process cannot traverse reports `cannot_read` instead of `not_a_file` — `fileExists` answers false for a permission wall exactly as it does for an absent file, so the read classifies it now.

  Breaking: A number in `args` is accepted only when it is whole and fits in a signed 64-bit integer, and is written in decimal. `1.0` and `1` are indistinguishable once decoded and a larger integer reached the process in scientific notation, so neither had a spelling both SDKs agreed on; quote the value instead. Both SDKs also walk a document's entries in name order now, which fixes the order servers are attached in and which malformed entry is reported when more than one is bad — Python previously followed document order.

  Fixed: A `.mcp.json` whose bytes are not UTF-8 now raises `McpError` coded `cannot_read` in both SDKs. Python raised a bare `UnicodeDecodeError`, which is a `ValueError` rather than an `OSError` and so escaped the error family entirely; Swift reported `not_a_file` about a file that is there.

- `MintTokenError.code` is now a closed `MintTokenErrorCode` naming what the SDK saw — `request_failed`, `invalid_response`, `request_rejected` or `missing_api_key` — and the server's own rejection slug moves to `serverCode`, set only when the code is `request_rejected`. The two were previously the same field, so `code` could hold either the SDK's category or anything the server sent, down to a synthetic `http_<status>`, with no way to tell which. Match on `err.code` for what happened to the request and read `err.serverCode` for why the server refused. Handlers comparing `code` against `"transport_error"` or against a server slug such as `"auth_failed"` need updating; `str(err)` is now the message alone, without the `code: ` prefix.

  Breaking: A `TokenSource` that cannot produce a token now raises `TokenSourceError` rather than `MintTokenError`, with its own `TokenSourceErrorCode` — `request_failed`, `request_rejected`, `invalid_response` or `fetcher_failed`. Resolving a token source is not part of `mintToken`: it happens beneath every authenticated call — `verify`, `mintToken`, session start, dial and usage reads all resolve it first, and it re-resolves on expiry and after a 401 — so the failure surfaced under the name of one operation it mostly had nothing to do with. `token_source_failed` is gone from `MintTokenErrorCode` accordingly, and the four new codes say which part failed where one bucket said only that something did. A refused redirect is `request_failed` in every SDK — it never reached a token endpoint, so there is no rejection to report; Python previously reported it as an `http_<status>` rejection.

  Breaking: TypeScript gets the same two errors. `MintTokenErrorCode` and `TokenSourceErrorCode` are literal unions rather than aliases of `string`, both errors take `{ code, message, serverCode }`, and a malformed `TokenSource.endpoint` URL now throws a `TypeError` rather than an SDK error — argument validation is not part of the error family, which is what the Python SDK already did.

  Breaking: Swift gets the same two errors, as structs replacing the `MintTokenError` enum. `MintTokenError.rejected(code:detail:)`, `.transport(message:)` and `.invalidResponse(message:)` are gone; construct or match `MintTokenError(code:message:serverCode:)` with a `MintTokenErrorCode` instead, and expect `TokenSourceError` where a `TokenSource` fetch used to raise a mint error. `mintToken` now refuses a client built with a minted token or a token source before the request goes out, with code `missingApiKey`, rather than letting the server answer 401 — and `TokenSource.custom` rejects a fetcher returning an empty `jwt` instead of sending it as a bearer.

  ```swift
  // before — the enum's rejected case carried the server's slug
  if case .rejected(let code, _) = error, code == "auth_failed" { reauthenticate() }
  // after
  if error.code == .requestRejected, error.serverCode == "auth_failed" { reauthenticate() }
  ```

- `pushAudioBuffer(_:)` must be called from a capture queue rather than an audio render callback because transports may synchronously convert and copy the buffer. Caller-owned audio stream start and stop operations are now serialized, so a rapid stop cannot be overtaken by an older start.

- `mintToken` takes its subject unlabeled — `mintToken("user-123",
  ttlSeconds: 3600)` — matching Python and TypeScript, which pass the external
  user id positionally. The labeled `mintToken(externalUserId:)` spelling is
  removed; delete the label at each call site.

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

- `AudioUnavailableError.code` is the closed `AudioUnavailableErrorCode`
  rather than a `String` — `micDenied`, `micNotFound`, `micInUse` and
  `audioUnavailable`, the same four values every SDK already reported. A `switch`
  over it is exhaustive. Comparisons against the slug no longer compile: match
  the case (`error.code == .micDenied`), and read `error.code.rawValue` where the
  string itself is wanted.

- Hooks no longer fire for the screen-capture RPC or for caller-registered RPC methods — hooks fire for tool calls, and wire plumbing is not one. A `PreToolUse` hook that matched `screen_capture` previously observed, denied, or rewrote captures on Swift only; Python and TypeScript already behaved this way, and all three SDKs now pin the contract.

- One `CredentialsError` with the closed `CredentialsErrorCode`
  replaces six spellings of the same failure — TypeScript's `CredentialError`
  (singular), Python's `CredentialsError` plus its `NotFound`, `File`, `Expired`
  and `Mismatch` subclasses, and Swift's case-carrying enum. The five resolution
  codes are the slugs the cross-SDK vectors already pinned; `conflicting_credentials`,
  `api_key_in_token_slot` and `insecure_base_url` cover the construction-time
  guards, which previously threw an untyped error. 

- Every error carries `message`, so `except RealtimeError as e` /
  `catch let e as RealtimeError` can read it without narrowing to a concrete
  type first. In Swift `message` is now a `RealtimeError` requirement, which a
  type conforming to the protocol outside the SDK must add. In Python
  `RealtimeError` and its argument-less subclasses — `NotConnectedError`,
  `VideoPublishAlreadyActiveError` — now take the message as their one
  positional argument. `str(error)` is unchanged, including the `"code: message"`
  form the session, dial, usage, verify and tool-schema errors render.

- Registering a hook that cannot work now throws `HookError` in every
  SDK, with the closed `HookErrorCode` — `malformed_matcher`, `invalid_hook`,
  `server_hook_not_allowed`. Python raised `ValueError` and `TypeError` and
  TypeScript a bare `Error` for these, so neither was catchable as
  `RealtimeError`; in Python it is exported from `cosmo_ai.hooks`, beside the
  hooks it describes; Swift's `MalformedHookMatcherError` is replaced. In Python
  `HookError` is a `ValueError`, so an `except ValueError` around hook
  declaration keeps firing; the two cases that raised `TypeError` no longer do.

- The screen-capture handler has one shape — it always receives the `ScreenCaptureRequest`. The zero-argument form is gone: in Python `screen_locate_tool`'s handler must accept the request (`lambda request: ...`; ignore it if unneeded), and in Swift the handler type is the top-level `ScreenCaptureHandler` — the request-taking signature (`{ request in ... }` or `{ _ in ... }`), matching the Python and TypeScript name — with the nested `ScreenLocateTool.Handler` and `RequestHandler` names removed. TypeScript already had this shape and is unchanged. Migrate deliberately: a zero-argument handler now fails at call time, and in Python the arity error's text would reach the model as the locator's spoken reason.

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

  ```swift
  // before — the enums were frozen; an exhaustive switch compiled
  switch event.code {
  case .authFailed: signIn()
  case .versionMismatch: promptUpgrade()
  // …every declared case
  }
  // after — a value the server added arrives as .unknown(String)
  switch event.code {
  case .authFailed: signIn()
  case .versionMismatch: promptUpgrade()
  default: banner(event.code.rawValue)
  }
  ```

  In Python a server-added value is an enum member like any other, so declared
  versus added is a list check:

- `RealtimeSessionEvent` gains a case. The session now owns the
  coalesced transcript — read `session.transcript` (one `TranscriptItem` per
  turn, `Identifiable` by its stable `id`, with an `isFinal` flag) instead of
  folding the raw delta stream yourself, and the new
  `.transcriptUpdated(TranscriptUpdatedEvent)` is yielded on `session.events`
  with the complete updated list after every change, session-synthesized like
  `.sessionEnded`. A `switch` over the event union without a `default:` arm
  needs a new case (the forward-compatibility posture already calls for
  `default:` alongside `.unknown`). `send(text:)` now surfaces the sent text
  on the stream as its own closed user `.transcript` final (plus the update
  event) unless `transcript: false` is passed; an in-progress speech turn is
  unaffected. The raw `.transcript` delta events are otherwise unchanged.

- Every way a start can fail now raises one `SessionStartError`, whose
  closed `SessionStartErrorCode` names how far the attempt got — `transport`,
  `invalid_response`, `join_failed`, `config`, `busy`, `entitlement`,
  `version_mismatch`, `voice_disabled`, `rejected`, `handshake_failed`,
  `ready_timeout`. Switch on
  `code` where you used to branch on a type or read an HTTP status, and read the
  server's own rejection slug from `serverCode` beside it. It replaces the `RealtimeSessionError` enum. In Python
  the base error's `code` — previously open, carrying the server's own slug or
  a synthetic `http_<status>` — closes to the enum, with the slug moving to
  `serverCode`.

  ```swift
  // before
  catch let error as RealtimeSessionError { … }
  // after
  catch let error as SessionStartError where error.code == .readyTimeout { retry() }
  ```

- `SessionStartError.detail` is a `SessionStartRejection` in every SDK —
  the server's structured reason for refusing a start, which no SDK carried in full before. Each group of fields belongs
  to one server code: `limit` / `active` for `concurrent_session_limit`,
  `granted_minutes` / `used_minutes` for `free_minutes_exhausted`,
  `balance_cents` / `top_up_path` for `insufficient_credits`, `meter` /
  `included` / `used` / `reset_at` for `quota_exceeded`, and `provider` /
  `allowed_providers` / `plan` / `upgrade_path` for `provider_not_entitled`. A
  field the server adds that the SDK does not name is kept rather than dropped.
  

- Calling a session method the session cannot serve now throws
  `SessionStateError` with the closed `SessionStateErrorCode` — `not_connected`,
  `already_started`, `audio_publish_already_active`,
  `video_publish_already_active`, `screen_share_unavailable`, `invalid_payload`.
  It replaces six cases of the session error enum. A send issued before `ready` and one issued after the
  session ended both report `not_connected`.

- `AgentTool.name`, `AgentTool.clientToolHandler`, and
  `AgentTool.sdkToolNamePrefix` are removed — an `AgentTool` is
  construction-only. Keep the name and handler you pass at construction; the
  SDK registers the handler from the declaration. The reserved `cosmo_sdk_`
  prefix is still enforced at session start, with no caller decision attached.

- Audio that will not open throws `AudioUnavailableError`, whose `code`
  names the failure, where the session's own error type was thrown before. A
  refused microphone takes this path — the default `start()` publishes the mic as
  it joins — and so does an audio engine that will not start: no usable input
  format, or a converter that will not build. It reaches you the same way on both
  carriers, from `start()` and from `setMuted`. It is its own type, so a catch
  written for a start failure no longer matches it — catch `RealtimeError` for
  both, or add a second catch. Swift names `mic_denied` where the platform
  reports a refused permission and `mic_not_found` where it reports no usable
  input; an audio fault it cannot attribute is `audio_unavailable` rather than a
  transport failure.

- The six turn-taking and reasoning enums — `InterruptionSensitivity`, `GrokReasoningEffort`, `ThinkingLevel`, `EndOfSpeechSensitivity`, `SemanticEagerness` and `TurnDetectionMode` — are declared by the SDK rather than aliased to its generated internals. Reading a case or a `rawValue` off one previously needed a second `import CosmoRealtimeAPI`, a module the package does not publish; importing `CosmoRealtime` alone is now enough. Case names and wire values are unchanged, so code that spells them by name compiles as before. Code that reached into the generated module — importing `CosmoRealtimeAPI`, or naming `Components.Schemas.InterruptionSensitivity` and its siblings explicitly — drops that import and uses the SDK's own type of the same name.

- The deprecated `String`-returning `dial(phoneNumber:callerNumber:)`
  overload is removed; `dial` returns `DialResult` only. Read the id from
  `result.dialId` — code that used the returned string gets the identical
  value from `result.dialId.uuidString.lowercased()`.

- `ErrorEvent.fatal` is a plain `Bool` instead of `Bool?`. A frame
  that omits the field decodes as `false`, matching the wire default and the
  other SDKs. Read it directly — remove any unwrapping, `?? false`, or
  `== true` around it.

- `ReadyEvent.rejectedTools` is a plain `[RejectedTool]` instead of
  `[RejectedTool]?`. The server always reports the list — empty means nothing
  was rejected — and a frame that omits the field decodes as `[]`, matching
  the other SDKs. Read it directly and drop any nil-handling or `?? []`.

- The screen tools' machinery leaves the public surface. The `cache:` overloads of `screenLocateTool`, `screenClickElementTool` and `screenHighlightElementTool` are removed, and `ScreenCaptureCache`, the `ScreenLocateTool` class and its `rpcMethod` / `byteStreamTopic` constants are internal — migrate by dropping the `cache:` argument; every screen tool shares the SDK's store automatically. `ScreenCapture.context` is now opaque and optional (`(any Sendable)?`, with `elements` and `context` defaulted in the initializer) and `ScreenCaptureContext` is removed — stash your own context type at capture time and cast it back in your click/highlight handler.

- Server-sent types — the session events, `CredentialInfo`,
  `SessionUsage`, `SessionTokenUsage` and `RealtimeSessionStartTimings` — no
  longer expose member-wise initializers. They are decoded, never
  constructed: build a test fixture by decoding the wire JSON the server
  would send (`JSONDecoder().decode(ReadyEvent.self, from: json)`), which
  also validates the fixture against the wire shape. Types you construct
  yourself — `SilenceTimeout`, `Say`, `EndCall` and all agent and session
  configuration — are unchanged.

- `RealtimeSessionEvent` gains a case —
  `.sessionEndingSoon(SessionEndingSoonEvent)`, the server's session-limit
  warning with `secondsRemaining` and a stable `reason` slug, previously
  surfaced through the unknown-event fallthrough. A `switch` over the event
  union without a `default:` arm needs the new case (the
  forward-compatibility posture already calls for `default:` alongside
  `.unknown`). The session keeps running until `.sessionEnded`.

- `agent.start(...)` now returns when the session is ready — the
  server's handshake has landed — instead of at transport join, so every
  session method works the moment it returns. A session whose ready
  handshake never arrives within 40 seconds is torn down and the start
  throws `SessionStartError` coded `readyTimeout`; a room that
  closes before ready throws it coded `handshakeFailed` with a synthetic
  status of `0`, carrying the server's boot-failure `error` frame code and
  message when one preceded the close, else `handshake_disconnect`. Cancelling the
  task that awaits a start tears the session down and throws
  `CancellationError`, so `Task.cancel()` and SwiftUI's `.task` teardown
  abort a start cleanly. Readiness is also read from the agent's
  `cosmo.ready` participant attribute — at join and after a reconnect — so a
  session that joins after the agent came up still observes it.

- Session state observation now matches the other Cosmo SDKs. Read
  the current value as `await session.state`, and pass an `onStateChange:`
  handler to `agent.start` to observe every transition from `.idle` on — the
  `session.states` stream is removed. The state vocabulary is the shared
  five-state machine: the distinct `.reconnected` case is gone (a completed
  recovery re-enters `.connected`), the type is named `SessionState`, and its
  terminal case is `.disconnected(reason:detail:)` carrying the same
  five-slug `DisconnectReason` the SessionEnd hook context uses, with the
  server's end slug or transport message in `detail`.

  ```swift
  // before
  Task { for await state in session.states { render(state) } }
  // after
  let session = try await agent.start(onStateChange: { state in render(state) })
  let current = await session.state
  ```

- The token counters on `UsageEvent` and `SessionTokenUsage` are
  plain `Int` instead of `Int?`. A payload that omits a counter decodes as
  `0`, matching the wire default and the other SDKs. Read them directly —
  remove any unwrapping, `?? 0`, or `== nil` around them. `SessionUsage.tokens`
  itself stays optional: a provider that reports no token usage still yields
  no breakdown.

- `ToolSchemaError` is now `ToolDefinitionError`, and it covers the
  whole declaration — a bad tool name and a missing or overlong description
  throw it too, where Python raised a bare `ValueError` and TypeScript a bare
  `Error`. Both are now catchable as `RealtimeError` like every other SDK error;
  in Python `ToolDefinitionError` is still a `ValueError`, so existing handling
  keeps working. `code` is the closed `ToolDefinitionErrorCode` rather than a
  string. Swift's `ToolDefinitionError` and `ToolSchemaConsistencyCheck.Failure`
  are folded into it, the latter as code `schema_type_mismatch`.

- A tool-call validation failure reports its issues as
  `ToolInputIssue` in every SDK — `path`, `code`, `constraint` — where Python
  had raw dictionaries keyed `loc`/`type`/`ctx`, Swift nested the type inside
  the error, and TypeScript carried `path` as an array of segments. `path` is
  now the dotted form (`address.city`, `items[2].sku`) everywhere, the same
  string the `INVALID_INPUT` message renders.

  TypeScript exports `ToolInputIssue` from `cosmo-ai/tool`: it is the type
  `ToolInputValidationError.issues` carries, so a caller reading them has to be
  able to name it.

## Upgrade Swift to 0.7

Breaking changes when moving `CosmoAI` from v0.6.0 to v0.7.0. The [changelog](https://platform.askcosmo.ai/docs/meta/changelog) has the full release notes; more than one version behind, [chain the pages](https://platform.askcosmo.ai/docs/meta/migration).

- `ModelOptions.grok` now carries `silenceDurationMs` and `prefixPaddingMs`, both defaulted to `nil`. Spell the untuned case `.grok()` — a bare `.grok` no longer typechecks as a value.

- Sessions now start through an agent, matching the Python and TypeScript SDKs. `RealtimeSession.start(_:config:micMuted:rpcHandlers:)` and `client.start(config:)` are removed, as is direct `RealtimeAgent(...)` construction — build the agent with `client.agent(...)` or `client.catalogAgent(_:inputs:)` and open the run with `agent.start(...)`.

  Before:

  ```swift
  let config = SessionConfig(instructions: "You are a helpful assistant.")
  let session = try await client.start(config: config)
  ```

  After:

  ```swift
  let agent = try client.agent(instructions: "You are a helpful assistant.")
  let session = try await agent.start()
  ```

  The full signatures, every parameter defaulted: `client.agent(instructions:model:modelOptions:voice:audio:tools:interruptionSensitivity:greeting:skills:mcp:hooks:)`, `client.catalogAgent(_:inputs:voice:tools:mcp:hooks:)`, and `agent.start(resumeSessionId:maxSessionSeconds:storeRecording:storeAudio:storeTranscript:storeVideo:micMuted:rpcHandlers:)`.

- `SessionConfig` is removed, its fields split by scope:

  - Agent-scoped (instructions, model, `modelOptions`, voice, audio, tools, `interruptionSensitivity`, greeting, hooks) → parameters of `client.agent(...)`.
  - A catalog run's `agentName` / `agentInputs` → `client.catalogAgent(name, inputs:)`.
  - Per-run (`resumeSessionId`, `maxSessionSeconds`, `storeRecording`, `storeAudio`, `storeTranscript`, `storeVideo`, plus `micMuted` and `rpcHandlers`) → parameters of `agent.start(...)`.

- `SessionConfig`'s nested types are now top level; cases and fields are unchanged — only the spelling of the type names moves:

  - `SessionConfig.Tool` → `AgentTool` (and `SessionConfig.sdkToolNamePrefix` → `AgentTool.sdkToolNamePrefix`)
  - `SessionConfig.Voice` → `VoiceConfig`
  - `SessionConfig.Audio` → `AudioConfig`
  - `SessionConfig.Ambience` → `AmbienceConfig`
  - `SessionConfig.ModelOptions` → `ModelOptions`, with the turn-detection enums nested there (`ModelOptions.GeminiTurnDetection`, `ModelOptions.OpenAITurnDetection`)
  - The enum aliases `InterruptionSensitivity`, `ThinkingLevel`, `EndOfSpeechSensitivity`, `SemanticEagerness`, and `TurnDetectionMode` are top level under the same names.

- `RealtimeSession.Options` → `RealtimeClient.Options`, unchanged in shape: the credential is client-level configuration, not per-session.

- `RealtimeSession.installConnectTracing()` → `RealtimeClient.installConnectTracing()`. `RealtimeSession.setRecordingAlwaysPrepared(_:)` is no longer public — `MicPrewarmCoordinator.set(_:)` / `.settle()` remain the supported mic-prewarm entry points.

- `RealtimeAgent`'s fields and `RealtimeClient.Options`' fields are now `let`: an agent and a client's options are configured entirely at creation. Code that mutated a field after construction passes the value to `client.agent(...)` / `catalogAgent(...)` or the `Options` initializer instead.

- The pre-cutover event and error types are removed: `Ready`, `Transcript`, `ToolCall`, `ToolResult`, `ToolInvocation`, `Role`, `ServerError`, `VoiceClientError`, and `ConnectionCloseReason`. Sessions surface events as the `RealtimeSession.Event` enum via `session.events` — `Ready` → `.ready(RealtimeSession.Ready)`, `Transcript` → `.transcript(RealtimeSession.TranscriptDelta)` (fields `isFinal`, `role`, `text`), `ToolCall` → `.toolCall(RealtimeSession.ToolCall)`, `ToolResult` → `.toolResult(RealtimeSession.ToolResult)`, `ToolInvocation` → `.toolInvocation(RealtimeSession.ToolInvocation)` — and failures throw `RealtimeSessionError`; code still holding the other removed payload shapes should declare its own copies.
