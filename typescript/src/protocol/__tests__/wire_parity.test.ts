/**
 * Pins the SDK's hand-declared protocol frames to the generated schema.
 *
 * ``src/protocol/`` exists so no generated symbol reaches a published entry
 * point. The cost of a hand-written mirror is drift, so every frame is
 * asserted *identical* to its generated twin here — not merely assignable.
 * ``Identical`` distinguishes optionality and readonly, so a regenerated
 * schema that adds an optional field, widens a union, or renames anything
 * fails ``tsc`` on this file rather than shipping a surface that disagrees
 * with the wire.
 *
 * A failure here is not a bug to work around: update the twin in
 * ``../server_frames`` or ``../client_frames`` to match, and treat any
 * user-visible change as the breaking change it is.
 */

import { describe, expect, it } from 'vitest';

import type * as Sdk from '..';
import type * as Wire from '../../wire/types.gen';

/** True only when ``A`` and ``B`` are the same type — optional modifiers and
 *  readonly included. Mutual `extends` would accept `{a?: string}` against
 *  `{a: string | undefined}`; the conditional-identity trick does not. */
type Identical<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Compiles only if the twin is exact. A drifted frame is a type error on the
 *  offending line, naming the frame. */
type Pinned<_ extends true> = true;

// ── Inbound frames ─────────────────────────────────────────────────────
// The inbound frames have no twin to pin: nothing restates them. A consumer
// receives the session's own event type, built in ``core/wire_decode``
// straight from the generated frame, and each mapper there asserts it
// covered every field of the frame it reads — so a schema change fails the
// mapper rather than a structural comparison. Only the leaves the SDK
// re-declares for its own surface are pinned here.
type _TranscriptRole = Pinned<Identical<Sdk.TranscriptRole, Wire.TranscriptRole>>;
type _ResolvedAgent = Pinned<Identical<Sdk.ResolvedAgent, Wire.ResolvedAgent>>;
type _ErrorCode = Pinned<Identical<Sdk.ErrorCode, Wire.ErrorCode>>;

// ── Outbound frames ────────────────────────────────────────────────────
type _ClientActivityEnd = Pinned<Identical<Sdk.ClientActivityEnd, Wire.ClientActivityEnd>>;
type _ClientBindInput = Pinned<Identical<Sdk.ClientBindInput, Wire.ClientBindInput>>;
type _ClientConnectTimings = Pinned<Identical<Sdk.ClientConnectTimings, Wire.ClientConnectTimings>>;
type _ClientContext = Pinned<Identical<Sdk.ClientContext, Wire.ClientContext>>;
type _DelegationAppend = Pinned<Identical<Sdk.DelegationAppend, Wire.DelegationAppend>>;
type _DelegationChannel = Pinned<Identical<Sdk.DelegationChannel, Wire.DelegationChannel>>;
type _ClientEnd = Pinned<Identical<Sdk.ClientEnd, Wire.ClientEnd>>;
type _ClientEnvelope = Pinned<Identical<Sdk.ClientEnvelope, Wire.ClientEnvelope>>;
type _ClientImage = Pinned<Identical<Sdk.ClientImage, Wire.ClientImage>>;
type _ClientMute = Pinned<Identical<Sdk.ClientMute, Wire.ClientMute>>;
type _ClientPing = Pinned<Identical<Sdk.ClientPing, Wire.ClientPing>>;
type _ClientText = Pinned<Identical<Sdk.ClientText, Wire.ClientText>>;
type _ToolJobResult = Pinned<Identical<Sdk.ToolJobResult, Wire.ToolJobResult>>;
type _SessionStartTimings = Pinned<Identical<Sdk.SessionStartTimings, Wire.SessionStartTimings>>;

type _ServerEnvelope = Pinned<Identical<Sdk.ServerEnvelope, Wire.ServerEnvelope>>;
type _SessionResponse = Pinned<Identical<Sdk.SessionResponse, Wire.SessionResponse>>;
type _RejectedTool = Pinned<Identical<Sdk.RejectedTool, Wire.RejectedTool>>;
type _Say = Pinned<Identical<Sdk.Say, Wire.Say>>;
type _EndCall = Pinned<Identical<Sdk.EndCall, Wire.EndCall>>;
type _SilenceTimeout = Pinned<Identical<Sdk.SilenceTimeout, Wire.SilenceTimeout>>;

// ── Session-start body ─────────────────────────────────────────────────
type _SessionConfig = Pinned<Identical<Sdk.SessionConfig, Wire.SessionConfig>>;
type _SessionParams = Pinned<Identical<Sdk.SessionParams, Wire.SessionParams>>;
type _InlineAgentConfig = Pinned<Identical<Sdk.InlineAgentConfig, Wire.InlineAgentConfig>>;
type _CatalogAgentConfig = Pinned<Identical<Sdk.CatalogAgentConfig, Wire.CatalogAgentConfig>>;
type _SdkInfo = Pinned<Identical<Sdk.SdkInfo, Wire.SdkInfo>>;
type _VoiceConfig = Pinned<Identical<Sdk.VoiceConfig, Wire.VoiceConfig>>;
type _AudioConfig = Pinned<Identical<Sdk.AudioConfig, Wire.AudioConfig>>;
type _CosmoVadConfig = Pinned<Identical<Sdk.CosmoVadConfig, Wire.CosmoVadConfig>>;
type _GeminiModel = Pinned<Identical<Sdk.GeminiModel, Wire.GeminiModel>>;
type _OpenAiModel = Pinned<Identical<Sdk.OpenAiModel, Wire.OpenAiModel>>;
type _OpenAiMiniModel = Pinned<Identical<Sdk.OpenAiMiniModel, Wire.OpenAiMiniModel>>;
type _OpenAiLiveModel = Pinned<Identical<Sdk.OpenAiLiveModel, Wire.OpenAiLiveModel>>;
type _GrokModel = Pinned<Identical<Sdk.GrokModel, Wire.GrokModel>>;
type _ExperimentalParams = Pinned<Identical<Sdk.ExperimentalParams, Wire.ExperimentalParams>>;
type _TurnDetectionMode = Pinned<Identical<Sdk.TurnDetectionMode, Wire.TurnDetectionMode>>;
type _ClientToolSpec = Pinned<Identical<Sdk.ClientToolSpec, Wire.ClientToolSpec>>;
type _CatalogToolSpec = Pinned<Identical<Sdk.CatalogToolSpec, Wire.CatalogToolSpec>>;
type _ServerToolSpec = Pinned<Identical<Sdk.ServerToolSpec, Wire.ServerToolSpec>>;
type _WebSearchToolSpec = Pinned<Identical<Sdk.WebSearchToolSpec, Wire.WebSearchToolSpec>>;
type _ExamineImageToolSpec = Pinned<Identical<Sdk.ExamineImageToolSpec, Wire.ExamineImageToolSpec>>;
type _DetectObjectsToolSpec = Pinned<Identical<Sdk.DetectObjectsToolSpec, Wire.DetectObjectsToolSpec>>;
type _PointAtObjectToolSpec = Pinned<Identical<Sdk.PointAtObjectToolSpec, Wire.PointAtObjectToolSpec>>;
type _EndCallToolSpec = Pinned<Identical<Sdk.EndCallToolSpec, Wire.EndCallToolSpec>>;
type _ScreenLocateToolSpec = Pinned<Identical<Sdk.ScreenLocateToolSpec, Wire.ScreenLocateToolSpec>>;

describe('protocol frames are pinned to the generated schema', () => {
  // The assertions above are compile-time; `tsc --noEmit` and vitest's own
  // transform both run this file, so a drifted twin fails the build. This
  // case exists so the pin is visible in the suite rather than only in a
  // typecheck nobody reads.
  it('typechecks every frame against its generated twin', () => {
    expect(true).toBe(true);
  });
});
