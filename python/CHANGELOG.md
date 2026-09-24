# Changelog — `cosmo-ai-sdk`

All notable changes to this package. Dates are release dates. Versions are
per-SDK: the other Cosmo Realtime SDKs release on their own numbers.

Entries are assembled from the monorepo's pending changeset fragments when a
release is cut. A published section is immutable — a correction goes in the
next release's section, never by editing an old one.

> The v0.1.0 entries describe the API as it shipped in that release.
> Several names changed after — read the reference docs for the current
> shape, and v0.1.0 only as history.

## v0.6.1 — 2026-09-24

### Added

- `experimental.avatar` asks the server for a video avatar — a vendor renderer joins the session and republishes the agent's speech as lip-synced video, and the agent then publishes no audio of its own. One renderer today (`provider: "tavus"`, with a `face_id`); the field is discriminated on `provider` so further renderers join without a wire change. Server-gated per workspace: a session that asks for one while the gate is off simply starts without it. Rendering the video needs a client that can surface a remote video track, which this SDK does not yet do.
- `GeminiModel` accepts `tool_response_policy` and `tool_response_overrides` to let selected tools run while the agent continues speaking, with `GeminiToolResponsePolicy` controlling result scheduling. The `gemini-3.8-live-extended-thinking` model requires non-blocking tools, accepts low, medium or high thinking, and does not accept scheduling.
- `Plugin` bundles instructions, skills, tools, and hooks for inline agents through the `plugins` parameter. Contributions compose in plugin order before direct configuration, with named conflicts rejected at construction.

### Changed

- Speaker diarization is available through the speaker log server tool without a workspace rollout flag. Opt in with `speaker_log_tool()`. See the [server tools guide](https://platform.askcosmo.ai/docs/guides/server-side-tools) for setup.

### Fixed

- a `DelegationCreatedEvent` that arrived with an empty `transcript` —
  GPT Live raises a hand-off mid-turn without attaching what the user said —
  now carries the session's last user turn, so a backend answering hand-offs
  always has something to act on. Each turn stands in for at most one hand-off,
  so two blank hand-offs in a row never replay the same instruction.

## v0.6.0 — 2026-09-18

### Breaking

[Upgrade guide](https://platform.askcosmo.ai/docs/meta/migration/python/0-6)

- Tools are built by calling a constructor, and every constructor returns `AgentTool`. `WebSearchTool()` and its siblings are replaced by `web_search_tool()`, `examine_image_tool()`, `detect_objects_tool()`, `point_at_object_tool()`, `end_call_tool()`; `draw_box`, `draw_point`, `screen_locate`, `screen_click_element`, `screen_highlight_element` and `screen_highlight_box` gain a `_tool` suffix. The tool models are no longer exported — declare a hand-written JSON Schema with `client_tool(...)` / `background_client_tool(...)` instead of constructing `ClientTool` directly, and annotate with `AgentTool`, which is now the single discriminated union (`RealtimeToolSpec` is gone).
- `client_tool(...)` and `background_client_tool(...)` validate at construction, matching `@tool`: the name grammar, the reserved `cosmo_sdk_` prefix, the description, and the schema dialect. A declaration the server would refuse now fails where you wrote it instead of arriving as a `ready.rejected_tools` entry at connect.
- Server-event models no longer carry the `type` and `id` fields. `type` was a constant restating the class (`isinstance` is the idiom, and decode never read the field), and `id` was a client-generated UUID that correlated with nothing — the wire defines neither on server events. Events now expose exactly the wire payload, matching the TypeScript and Swift SDKs field-for-field. Code branching on `event.type == "…"` switches to `isinstance(event, …Event)`; code logging `event.id` drops it.
- `audio.noise_cancellation` takes a mode instead of a boolean — `'off'`, `'denoise'` or `'voice_focus'`. The new one is `'denoise'`: it removes non-speech noise and keeps every voice, which is what a microphone several people share needs. `'voice_focus'` is the previous behaviour, and keeps only the speaker it judges primary — on a shared microphone that treats the second person as background and filters them out.

  `true` and `false` remain valid on the wire, so a session started by an already-published SDK version is unaffected.
- Passing a workspace API key (`cosmo_…`) as `token` is refused at construction in every SDK. That parameter takes a minted end-user token; a key there authenticates anyway, so the mistake used to work — and shipped the key with whatever app carried it. Pass the key as the API-key parameter, or mint a token for the user with `mint_token` and pass that. Acts-as-user tokens (`cosmo_pat_…`) are unaffected.
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
- A `TokenSource.custom` fetcher now resolves with the same shape
  `mint_token` returns — a `MintedToken` — in every SDK. Python no longer
  accepts a plain `{jwt, expires_at}` mapping (construct `MintedToken`, which
  still parses an RFC 3339 `expires_at` string), and TypeScript no longer
  accepts a string `expiresAt` (pass a `Date`; the `FetchedToken` type is
  removed — annotate with `MintedToken`). Python's direct `TokenSource(...)`
  construction now validates identically to `custom` instead of bypassing it.
  Swift is unchanged.
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

### Added

- Three new knobs on the Grok model block — `reasoning_effort` (`"high"` | `"none"`; Grok's own default is `high`, which reasons for seconds before every reply — set `"none"` for conversational latency), `speed` (0.7–1.5 playback-rate multiplier for the agent's speech), and `idle_timeout_ms` (server re-engages the user after this much post-response silence, re-arming after every response). All three are optional; unset keeps Grok's defaults.
- `present_multiplier` on a silence hook, deciding how much its `timeout_seconds` widens once the caller has spoken at least once. It is optional and unset keeps the server's default, so existing hooks are unchanged; set `1` for a hook that should wait the same whether or not anyone has spoken yet.
- `transport="websocket"` on `RealtimeClient` (or `COSMO_TRANSPORT=websocket`) runs a session over a single WebSocket instead of a media room. Install `cosmo-ai-sdk[websocket]` to use it. It runs only against an OSS `cosmo-server` on your own machine, which is a local development server; managed Cosmo does not serve the socket route. Camera, screen share and reconnection are room-transport only. `start_audio_stream` takes the new `PcmAudioSource` to publish caller-owned audio on either transport; a `livekit.rtc.AudioSource` still publishes on the room transport.
- `ToolOutcome` is exported from `cosmo_ai.hooks`. The union already existed and the three cases were already public, but without a name for the union a `PostToolUse` hook could not factor its branching into a helper — which is why the hooks example read `type(outcome).__name__` instead of narrowing. Narrow with `isinstance` against `ToolOk` / `ToolError` / `ToolDenied`, and close with `assert_never` for the exhaustiveness Swift's `switch` and TypeScript's `kind` give.
- `client_tool(...)` and `background_client_tool(...)` take `input=` — a Pydantic model, the same typed form `@tool` derives from a decorated function's annotation, for the cases a decorator cannot reach: a closure, a bound method, or a tool built in a loop. The handler receives the validated model instance, and the schema is emitted and dialect-checked at the call as it is for `@tool`. `parameters=` is unchanged and remains the raw escape hatch; exactly one of the two is passed. This matches Swift's `AgentTool.clientTool(name:description:input:handler:)` and TypeScript's `clientTool({ input })`, which both already had a typed form on the constructor itself.
- `COSMO_LOG_LEVEL` turns the SDK verbose without an app change. Set it to `silent`, `error`, `warn`, `info`, or `debug` and the SDK writes to standard error at that level, including a `debug` line with the connect-latency breakdown for each session. An explicit `setLogLevel()` call, or a handler the app attached itself, still wins. In Swift the variable gates only that connect line, since `os_log` levels are set outside the process.
- The closed string sets have public names: `ScreenPlacement`, `ScreenAffordance` and `ScreenClickButton` from `cosmo_ai.tools`, `HookEventName` from `cosmo_ai.hooks`, and `ToolInvocationOrigin` from the package root. Each already typed fields you read, but without an exported name, annotating a variable or a helper's parameter meant restating the literals or widening to `str`. Swift publishes the same sets as enums and TypeScript as unions of string literals.
- `OpenAILiveModel`, a new provider block for OpenAI's GPT Live full-duplex voice model (`provider: "openai_live"`). The model listens and speaks at once and decides itself when each turn starts and ends, so it carries no turn-detection knobs. It cannot call tools itself; it delegates tool calls and reasoning to a backend Responses model, and the block configures that model: `responses_model`, `responses_instructions` (defaults to the agent's own instructions), `reasoning_effort` (`OpenAILiveReasoningEffort`: `minimal` / `low` / `medium` / `high`), `verbosity` (`OpenAILiveVerbosity`), `tool_choice` (`OpenAILiveToolChoice`: `auto` / `required` / `none`), `parallel_tool_calls`, `max_output_tokens`, and `service_tier` (`OpenAILiveServiceTier`: `auto` / `default` / `flex` / `priority`). Audio only: video and screen frames are ignored on it. The plain-string alias `"openai_live"` runs the provider default.
- `SessionConnectTimings` gains `readyMs` (`ready_ms` in Python), measured from the same instant as the session-start phase and unset until the agent reports ready. Once the agent is live the session reports its client-measured phases and the server's own start breakdown back to the session, so the whole connect waterfall is recorded against it; the report goes out once per session and never surfaces a failure to the caller. In TypeScript the new field is optional and `onConnectTimings` takes the connect origin as an optional second argument, so a custom `RealtimeTransport` written against the previous shape still type-checks.
- Echo cancellation on the websocket transport's microphone. Python runs the same software canceller as the WebRTC lane, with noise suppression and gain control off; Swift uses Apple's platform voice processing with gain control disabled. On speakers the agent no longer hears itself and self-interrupts.

  Fixed: the Swift websocket transport stops playback when the agent's turn ends, so speech you talked over no longer keeps playing after an interruption.
- GPT Live sessions can hand work off instead of calling tools. `OpenAILiveModel.delegation` picks who does it: `responses` (the default, the backend Responses model), `client` (your application), or `cosmo` (Cosmo's workspace agent on the server). Under `client` and `cosmo` the session emits a `DelegationCreatedEvent` event with the user's request, and three new session methods answer it: `append_thinking` (background the model keeps to itself), `append_commentary` (something to say now, in its own words) and `append_instructions` (how to behave from here on), each taking an optional delegation id.
- `AudioUnavailableError` carries a `code` naming which capture failure it
  was. The vocabulary is shared with the other SDKs — `mic_denied`,
  `mic_not_found`, `mic_in_use`, `audio_unavailable` — and each reports the ones
  its platform can tell apart; this one names a missing recording device and
  leaves everything else unattributed rather than guessing between a refused
  permission and a device another process holds.
- A tool the server rejects at session start is now logged as a warning — one line per rejected entry, with the tool's name and the server's reason. The ready event's rejected-tools list is unchanged; the warning just makes the drop visible without subscribing to it.
- The package identity is readable at module scope. Python exports
  `SDK_NAME` and `SDK_VERSION` from `cosmo_ai`; Swift exposes `sdkName` and
  `sdkVersion` after `import CosmoRealtime`. These are the values the SDK sends
  on `session-config` and the `X-Cosmo-SDK` header, under the names TypeScript
  already exports.

### Changed

- The wire contract tightens: `session-config` now requires the `sdk` identity block, and `send-image` requires `mime_type` and `stream_id`. Every SDK release already sends all three unconditionally, so SDK users are unaffected — the change closes the gap for direct REST callers, whose sessions were previously anonymous.
- The SDK's local message `id` (log correlation) no longer rides the wire — on the session-start body or any data-channel message. The server treats the protocol as strict (`additionalProperties: false`); the id was always ignored.
- The canonical/default room transport selector is now `webrtc` (`.webrtc` in Swift), naming the protocol rather than its LiveKit implementation. The previous `livekit` / `.livekit` spelling remains accepted as a deprecated compatibility alias.
- The README no longer suggests a version to pin. Installs track the latest release; breaking changes are announced in the [changelog](https://platform.askcosmo.ai/docs/meta/changelog) before they ship.
- The OpenAI providers (`openai`, `openai_mini`, `openai_live`) no longer need a per-workspace opt-in. Like every other provider, they are available whenever the server has an OpenAI API key configured. `openai_provider_available` on the provider-capabilities endpoint now reports that server-side configuration rather than a workspace flag.
- `agent.prepareSession()` (`agent.prepare_session()` in Python) prepares a session ahead of its start, so it starts about 1.5 seconds faster: the SDK reserves a room in the background, and the returned `PreparedSession` joins it while the session request is still in flight when you start it. The reservation is refreshed until the handle is started or closed. Purely an accelerator: a reservation that failed, lapsed, or is declined leaves the start on the ordinary path. Requires the default `webrtc` transport.

  Python's `SessionStartError` now carries `status`, the HTTP status of a server rejection (`None` when the request never reached the server), matching TypeScript.
- On the websocket transport, video and screen-share calls now fail with the error code `video_unsupported` instead of silently doing nothing. Stopping or removing a publish that could never start remains a harmless no-op, and video stays available on the WebRTC transport.
- `AudioUnavailableError.code` is typed as `AudioUnavailableErrorCode`
  rather than a bare string — `mic_denied`, `mic_not_found`, `mic_in_use` and
  `audio_unavailable`, the same four values it always carried. Every SDK declares
  all four even where its platform cannot tell them apart, so branching code
  ports between them unchanged. Existing comparisons keep working: Python's is a
  `str` enum and TypeScript's a union of the same literals.
- The reference documentation is now complete — every public symbol,
  field, enum member and the main authoring parameters carry it, so hovering a
  constructor argument or an enum value says what it means rather than only its
  type. `RealtimeModel` names the provider aliases you can pass as a string
  (`"gemini"`, `"openai"`, `"openai_mini"`, `"grok"`) and says the set is
  server-owned, `ErrorCode` says what recovery each code allows, and result
  types like `SessionUsage` describe every field they hand back. Two claims
  were also wrong and are corrected: `AudioConfig.noise_cancellation` defaults
  to **off**, not on, so enable it explicitly when the microphone will hear more
  than one voice; and `SessionParams.store_video` has the same `store_recording`
  fallback as `store_audio`, with screenshots following `store_recording`
  regardless of it.
- The screen locator's capture payload names its element list `elements` instead of `ax_elements`, matching the `ScreenCapture.elements` field it carries. Nothing changes in your code — capture handlers and `ScreenCapture` are untouched — and the Cosmo server accepts either spelling, so earlier SDK releases keep working.
- The session now owns the coalesced transcript: read `session.transcript`
  (one `TranscriptItem` per turn, with a stable `id` and an `is_final` flag)
  instead of folding the raw delta stream yourself. The session iterator
  yields a new `RealtimeSessionEvent` member, `TranscriptUpdatedEvent`,
  carrying the complete updated list after every change — a `match` with no
  arm for it skips it, per the protocol's additive evolution. `send_text` now
  also surfaces the sent text on the stream as its own closed user
  `TranscriptDeltaEvent` (plus the update event) unless `transcript=False` is
  passed; an in-progress speech turn is unaffected. The raw `transcript`
  delta events are otherwise unchanged.

### Fixed

- Minting a token now behaves the same in all three SDKs. A success
  response is accepted only when `jwt` is a non-empty string and `expires_at`
  an RFC 3339 timestamp — anything else raises `invalid_response` rather than
  returning a token that cannot be used — and a Swift expiry carrying
  fractional seconds now parses instead of failing to decode. Mint requests
  carry a 45-second deadline and refuse redirects, so the workspace API key
  cannot be re-sent to another origin.
- WebSocket sessions now authenticate the upgrade with a short-lived, single-use browser-compatible capability and do not report connected until the server's audio preamble arrives. Turn completion follows paced playback; interruption discards queued audio while preserving the complete provider transcript received so far.
- The Gemini block's `turn_detection` documentation stated that leaving
  it unset runs `server_vad`. It doesn't — unset runs `cosmo_vad`, Cosmo's
  semantic turn detection, and the `server_vad` window knobs
  (`end_of_speech_sensitivity`, `silence_duration_ms`, `prefix_padding_ms`)
  are unread until `server_vad` is named explicitly. The doc-comments now
  state the real per-provider defaults: `cosmo_vad` on Gemini, `server_vad`
  on OpenAI and Grok (whose documentation was already correct). Behavior is
  unchanged — this corrects the description, not the detector.
- A stray `realtime.frame_from_non_agent_dropped` warning naming the agent no longer appears while a session closes. The sender's kind is read off the frame itself rather than resolved against the room, which the session has already released by the time those last frames arrive.
- On the websocket transport, a clean server close (code 1000/1001, or an empty close frame) now ends the session as `server_ended` in TypeScript and Swift instead of reporting a transport error, and an abnormal close such as 1008 carries its numeric close code and reason in the error detail in all three SDKs.

  Fixed: the Python SDK caps a client-tool error at the wire's 512-character limit, so a long handler traceback no longer voids the reply and strands the tool call until its timeout.

  Changed: the Python `websocket` extra now requires `websockets>=14.1`, the release that exposes the close code and reason this reporting reads.
- The SDK reports its real version in installations where the installed
  distribution's metadata is unavailable — a vendored copy, a frozen bundle built
  with PyInstaller or py2app, or a source checkout run straight off `sys.path` —
  where it previously reported `0.0.0`. The version now travels inside the
  package, so the `X-Cosmo-SDK` header and the session's SDK identity name the
  release however the package was installed.
- A skill description containing newlines now collapses to a single
  menu line in the resident instructions, matching the Swift SDK. A
  multi-line description can no longer inject extra lines — including
  entries shaped like other skills — into the instructions block.

## v0.5.1 — 2026-08-19

### Added

- Turn-detection knobs on `GrokModelOptions`: `turn_detection` (`"server_vad"`, the one detector xAI offers), `silence_duration_ms`, and `prefix_padding_ms`. Naming `"semantic_vad"` or `"cosmo_vad"` is rejected at session start. Unset knobs keep the provider default. See [Turn-taking](https://platform.askcosmo.ai/docs/concepts/turn-taking#provider-endpointing).

## v0.5.0 — 2026-08-17

### Added

- `turn_detection` on `GeminiModelOptions`. `"cosmo_vad"` opts the session into Cosmo's semantic turn detection, which classifies whether the utterance reads as finished instead of timing a silence window; `"server_vad"` pins Gemini's silence-window detection, which is what `end_of_speech_sensitivity`, `silence_duration_ms`, and `prefix_padding_ms` tune (they are read only with `"server_vad"`). Unset keeps the server default, currently `"cosmo_vad"`. `"semantic_vad"` is OpenAI-only and rejected at session start.
- `cosmo_vad: CosmoVadConfig` on `GeminiModelOptions`: per-session tuning for the semantic detector — `pause_ms` (silence that triggers the end-of-turn inference), `prefix_ms` (audio kept from before speech was detected), `max_hold_ms` (total silence after which the turn ends regardless of the classifier's verdict). Naming one detector and sending the other one's knobs is rejected at session start.

## v0.4.0 — 2026-08-14

### Changed (repository)

- SDK source, examples, and the issue tracker now live in the consolidated [cosmo-ai](https://github.com/socratic-ai/cosmo-ai) repository; package metadata points there.

### Added

- `session.usage()` — fetch the session's usage summary (duration, talk time, token counts) over REST, during the session or after it ends. `RealtimeClient.get_session_usage(session_id)` is the client-level form, for a process that no longer holds the session. Raises `UsageError`.
- `store_audio`, `store_transcript`, and `store_video` on `RealtimeAgent.start()` — per-artifact storage opt-outs, alongside the existing `store_recording` (still the whole-run macro, so `False` persists nothing; a per-artifact argument wins over it). Narrowing only: a session can request less storage than the account's consents allow, never more.
- `session-config` now carries the SDK identity (`sdk: {"name": "cosmo-ai-sdk", "version": …}` — the distribution name and version, read from the installed package metadata), also sent as an `X-Cosmo-SDK` header on every Cosmo REST call. The server records it per session — see [Protocol compatibility](https://platform.askcosmo.ai/docs/concepts/protocol-version).
- Types that were readable off public surfaces but not importable are now exports: `SessionStartTimings` (the `server_timings` on `session.connect_timings`; root and `cosmo_ai.session`), `ResolvedAgent` (the `agent` on `ReadyEvent`), `AmbienceTrack` (the `track` on `AmbienceConfig`), and `MicrophoneCapture` (the `capture=` argument to `set_microphone_enabled`) at the root.
- `SessionHandle` names the return of `RealtimeAgent.start` — the awaitable that is also an async context manager, either form yielding the started `RealtimeSession`. Code wrapping `start()` can now annotate the actual contract instead of choosing between `Awaitable[RealtimeSession]` and a context-manager type. Created by the SDK; not constructable.
- `ToolInputValidationError` is exported from `cosmo_ai.tools`, beside the `ToolSchemaError` it complements: one is the schema being unexpressible at construction, the other is the model's arguments failing validation at call time.
- `GrokModelOptions` (`provider="grok"`) — a typed `model_options` block selecting the xAI Grok Voice provider (`grok-voice-think-fast-2.0`), with no knobs today.

### Breaking

- The recorded-session REST endpoints moved from `/api/v1/external/voice-sessions` to `/api/v1/external/sessions`, and every schema on the surface lost the `Voice` qualifier: `VoiceSession` → `SessionRecord`, `VoiceSessionUsage` → `SessionUsage`, `VoiceSessionTokenUsage` → `SessionTokenUsage`, `VoiceSessionTranscriptTurn` → `SessionTranscriptTurn`, and `VoiceSessionImportRequest` → `SessionImportRequest`. The surface is not voice-specific, and the SDKs, the `cosmo` CLI, and the docs all move with it. Anything calling the old path directly must update; the old path is not served.

### Breaking

- `publish_audio_source` is removed. It was deprecated in v0.3.0 as the former name of `start_audio_stream`; call `start_audio_stream(source, track_name=...)` instead — the signature and behavior are identical, and `stop_audio_stream()` gives the voice back.
- `McpExtraNotInstalled` is now `McpExtraNotInstalledError`, taking the `Error` suffix every other SDK exception carries. Rename the import; `except ExtraNotInstalledError` and `except RealtimeError` already caught it and are unaffected.
- `session.config` is removed. It handed out the assembled wire payload — internal machinery whose shape tracks the protocol, including the tool handlers. Read what you configured off the `RealtimeAgent` you built (it is an immutable dataclass and keeps every field you passed); `session_id` and `connect_timings` remain the session-side accessors.
- `ReadyEvent.version` and `ReconnectingEvent.version` are removed, and `session-config` no longer sends a protocol `version` — the wire protocol is unversioned and [evolves additively](https://platform.askcosmo.ai/docs/concepts/protocol-version). For a runtime version read the installed package: `importlib.metadata.version("cosmo-ai-sdk")`.

## v0.3.0 — 2026-08-08

### Added

- `TokenSource` — a credential that fetches (and keeps fresh) a minted end-user token from your backend: `TokenSource.endpoint(url)` for any endpoint returning `{ jwt, expires_at }`, `TokenSource.custom(fn)` for full control. Pass it as `token`; the SDK caches the JWT, re-fetches inside a 60-second expiry margin, and drops the cache on a `401` session start. See [End-user credentials](https://platform.askcosmo.ai/docs/production/end-user-credentials).
- `EndCallTool()` — the typed opt-in that lets the agent hang up. Python agents can now grant model-initiated hang-up, which needed the deprecated generic server-tool reference the SDK never shipped.
- Screen tools return to the Python SDK, matching TypeScript and Swift: `screen_locate` turns on the server-side locator, and `screen_click_element` / `screen_highlight_element` act on the element it finds — addressed by an opaque `found_element` handle the locator mints and the renderer spends. `screen_highlight_box` points at a box the model supplies directly, with no capture or locator round trip. Both highlights answer in one `ScreenHighlightOutcome(shown, exact)` shape. Tool names, schemas, and reply shapes are shared across all three SDKs.
- `mint_token` responses now include `token_id` — the handle for revoking that one token early (`DELETE /api/v1/external/auth/token/{token_id}`) — and `mint_token(external_user_id, ttl_seconds=...)` (60–86400) shortens the 24-hour default lifetime.
- `OpenAIMiniModelOptions` (`provider="openai_mini"`) — a typed `model_options` block selecting the OpenAI Realtime mini tier: the same API on a faster, cheaper model, with no knobs today.
- `AgentTool` — the union of every class `tools=` accepts — is a root import, so a tool list can be annotated without reaching into submodules.
- `session.connect_timings` returns the connect-latency breakdown: the client-measured phases (`ws_ms`, `room_ms`, `total_ms`) plus `server_timings`, the server's own phase breakdown — the `timings` that used to be reachable only by digging into `session.response`. `mic_ms` is always `None` here: this SDK publishes audio through an explicit call, not during the join. Swift and TypeScript expose the same shape.
- `ScreenCaptureRequest` — what the `screen_locate` capture handler is now called with: `wants_elements` is false when the caller reads only the pixels, so a handler can skip building its element list (a DOM walk, an accessibility walk) for the vision locators, which never read it. Building that list is usually the expensive part of a capture. A handler that takes no argument keeps working unchanged and simply has its elements dropped — the SDK calls whichever form you wrote.

- `start_audio_stream(source)` / `stop_audio_stream()` take the session's voice with a caller-owned `rtc.AudioSource` and give it back. A session carries one voice, so the microphone and an audio stream are mutually exclusive and only one stream runs at a time — the new `AudioPublishAlreadyActiveError` is raised rather than leaving two tracks claiming it. `publish_audio_source` is the former name of `start_audio_stream`: it still works and now warns, it had no unpublish counterpart at all, and it no longer returns a publication handle (nothing ever accepted one).

### Changed

- The screen locator's accessibility list carries names, not documents. `role`, `title`, and `label` are truncated to a descriptor length, and an element's `value` is sent only where nothing else names it — the locator grounds against the screenshot, so a named element's content is a second copy of pixels it can already read. A focused text area holding a long document previously shipped whole, and the capture could be rejected outright for its length.
- `set_microphone_enabled` now captures through WebRTC's audio device module, so echo cancellation, noise suppression, and automatic gain control are applied to microphone audio before it is sent. Sessions played through speakers no longer feed the agent its own voice. Pass `MicrophoneCapture` (`cosmo_ai.audio`) as `capture=` to select which of the three run. Device selection and processing now match the TypeScript and Swift SDKs.
- `set_microphone_enabled` no longer uses PortAudio, so a Linux host without `libportaudio2` can capture a microphone; speaker playback still needs it. A host with no usable input device raises `AudioUnavailableError` before anything is published, as before.
- `publish_audio_source` is unchanged, and remains how you publish audio the SDK cannot capture itself — a synthetic generator, WAV replay, a load generator, or a pipeline running where there is no input device.
- The package is licensed Apache-2.0, and ships a `NOTICE` and a third-party license manifest.
- Endpointing knobs on `model_options`. `GeminiModelOptions` gains `end_of_speech_sensitivity`, `silence_duration_ms`, `prefix_padding_ms`, and `include_thoughts`; `OpenAIModelOptions` gains `turn_detection` (`"server_vad"` / `"semantic_vad"`), `eagerness` for the semantic detector, and `silence_duration_ms` / `prefix_padding_ms` for the fixed window. Pairing a knob with the detector that isn't selected is rejected at session start. Unset knobs keep today's behavior. See [Turn-taking](https://platform.askcosmo.ai/docs/concepts/turn-taking#provider-endpointing).
- A client-tool result over the 15 KiB reply cap is shortened and delivered instead of discarded. Long strings are trimmed with `… [truncated]`; when the overflow is structural rather than textual, top-level entries are dropped largest-first. Either way the result carries a `cosmo_sdk_truncated` key — a note telling the model the answer is partial, plus the kept and original byte counts so it can tell losing a little from losing almost everything. Previously the whole result was replaced with a `client tool result exceeded the reply size limit` error, and a `PostToolUse` hook saw that error — it now sees an ok `ToolOutcome` carrying the handler's own untruncated result. See [Keep the reply small](https://platform.askcosmo.ai/docs/capabilities/tools#keep-the-reply-small).
- A background tool's `job.ack(note=...)` note is shortened to fit the reply cap rather than overflowing it.

### Breaking

- `CosmoRealtime` is now `RealtimeClient`, and `Agent` is now `RealtimeAgent` — the three objects you compose a call from read `RealtimeClient` → `RealtimeAgent` → `RealtimeSession`, the same in every SDK. The old names are removed rather than aliased: change `from cosmo_ai import CosmoRealtime` to `from cosmo_ai import RealtimeClient`, and annotations naming `Agent` to `RealtimeAgent`. Nothing else about either class changed.
- Every session event takes an `Event` postfix: `RealtimeReady` is `ReadyEvent`, `RealtimeTranscriptDelta` is `TranscriptDeltaEvent`, `RealtimeError` is `ErrorEvent`, and so on for all 24 members of `RealtimeSessionEvent`. `UnknownEvent` is unchanged — it already read that way. An `isinstance` chain over events needs every arm renamed; shapes and field names are untouched.
- Types you only ever read off an event lose the prefix: `RealtimeErrorCode` is `ErrorCode`, `RealtimeTranscriptRole` is `TranscriptRole`, `RealtimeRejectedTool` is `RejectedTool`.
- The turn-taking and thinking knobs lose the prefix, matching the `InterruptionSensitivity` they sit beside: `ThinkingLevel`, `EndOfSpeechSensitivity`, `SemanticEagerness`, `TurnDetectionMode`.
- `CosmoRealtimeError` is now `RealtimeError` — the base every SDK error extends, and the last `Cosmo`-prefixed name on the surface. `except CosmoRealtimeError` becomes `except RealtimeError`. The name was freed by the error event becoming `ErrorEvent`, so code catching one and matching the other must update both.
- `SessionState` is now `RealtimeSessionState`. It is written in isolation, in an `on_state_change` callback signature you author, where both halves of the old name are among the most common words in a codebase.
- `VerifyWorkspace` is now `WorkspaceInfo`, pairing with the `CredentialInfo` that carries it. It is a workspace, not an action; the old name read as an imperative.
- The minimum `livekit` version is now `1.1.12`, up from `0.18` — that is the release providing the audio device module the microphone path captures through.
- `UltravoxModelOptions` and `PersonaplexModelOptions` are gone from the package root, and `RealtimeModelOptions` narrows to `GeminiModelOptions`, `OpenAIModelOptions`, and `OpenAIMiniModelOptions`. Select a voice model with the plain `model` string instead; per-provider tuning for those models is no longer exposed.
- `session.response` is removed. It handed out the whole session-start payload, including the LiveKit join `token` — a live credential with no caller use, one `print(session.response)` away from a log. The two things worth reading are now named accessors: `session.session_id` (unchanged) and `session.connect_timings`. `livekit_url`, `room_name`, and `token` are no longer reachable; the transport spends them and they have no consumer-facing use.
- The skills loader is `cosmo_sdk_load_skill`, not `load_skill`. It joins the reserved `cosmo_sdk_` namespace the other SDK-shipped client tools use, so hooks and tool-call handlers matching the old name no longer fire, and the plain `load_skill` name is free for your own tools. A tool of your own claiming the reserved name is now rejected when you declare it, rather than silently dropping every skill on the agent.
- `activity_end()` is `send_activity_end()`. It sends the `activity-end` frame like every other wire send, so it takes the `send_` prefix the rest of that family carries — and the same name all three SDKs now use.
- `audio.noise_cancellation` defaults to off. The isolator sits ahead of the model, so the filtered signal is also what turn-taking reads, and a session that never asked for it should not pay that cost. Pass `AudioConfig(noise_cancellation=True)` to keep the previous behavior.
- A `PostToolUse` hook sees an ok `ToolOutcome` — carrying the handler's own untruncated result — where an over-cap client-tool result previously gave it an error. The cap is a transport property, not a tool failure. A hook that detected oversized results by matching the `client tool result exceeded the reply size limit` message no longer fires; read `cosmo_sdk_truncated` off the reply instead.

### Fixed
- A PortAudio library that is missing or fails to load raises a typed `AudioUnavailableError` from `set_microphone_enabled` / `set_speaker_enabled`, instead of an `ImportError` escaping from the audio backend.

## v0.2.0 — 2026-08-04

### Breaking

- One plain `pip install cosmo-ai-sdk` — `livekit` and `sounddevice` are hard dependencies; the only extra left is `[mcp]`.
- The per-turn `audio_response` flag is gone. Configure `audio=AudioConfig(output=False)` for a text-only session.
- Client tools require a handler.
- Transcript roles are lowercase (`"user"`, `"assistant"`).
- The agent derivation method is gone; build each agent from the client.
- `detect` and `point` tool kinds are now `detect_objects` and `point_at_object`.
- Screen interaction is removed from the Python SDK.

### Added

- Zero-argument construction: `CosmoRealtime()` resolves `COSMO_API_KEY`, then the `cosmo login` credentials file, adopting the stored key's backend; a conflicting `COSMO_BASE_URL` is refused up front (`base_url_mismatch`). Expired stored keys fail with a `cosmo login` remediation (`CredentialsError` family).
- `client.verify()` against `GET /realtime/verify` — a credential preflight that starts no session and costs nothing.
- `send_context()`, which gives the agent state without taking a turn.
- Camera publishing, not just screen share.
- `cosmo.usage` surfaced as a typed cumulative-usage event, and `cosmo.session-state` decoded rather than dropped.

### Changed

- The client resolves its backend from `COSMO_BASE_URL`; the documented default origin is `https://platform.askcosmo.ai`.
- `noise_cancellation` defaults to on.

## v0.1.0 — 2026-05-01

Initial release.

- `CosmoRealtimeClient` async class with `connect`, `disconnect`, `send_text`, `send_mute`, `set_microphone_enabled`, `send_ping`, `end`.
- `async with` support, using `__aenter__` / `__aexit__`.
- Typed subscriptions: `on_transcript`, `on_tool_call`, `on_tool_result`, `on_ready`, `on_conversation_link`, `on_error`, `on_message` (catch-all).
- Generated `AuthenticatedClient` and `Client` from the external API's OpenAPI schema.
- Generated models: `RealtimeClientInit`, `RealtimeSessionRequest`, `RealtimeSessionResponse`, `RealtimeTranscriptDelta`, `RealtimeToolCall`, `RealtimeToolResult`, `RealtimeReady`, `RealtimeConversationLink`, `RealtimeError`, `RealtimeErrorCode`, `RealtimeTranscriptRole`, and supporting types.
- Envelope reassembly for `server-envelope-chunk` messages.
- Optional `livekit` extra for microphone publishing support.
- `structlog`-based logging with structured fields.
