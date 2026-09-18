import { describe, it, expect, expectTypeOf } from 'vitest';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as Sdk from '..';
import * as SdkReact from '../react';
import { agentToolPayload } from '../core/agent';

function barrelSource(): string {
  const barrelPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.ts');
  return fs.readFileSync(barrelPath, 'utf-8');
}

describe('React surface', () => {
  it('lives at cosmo-ai/react, not the root barrel', () => {
    expect(typeof SdkReact.RealtimeProvider).toBe('function');
    expect(typeof SdkReact.RealtimeAudio).toBe('function');
    expect(typeof SdkReact.useMicLevel).toBe('function');
    expect(typeof SdkReact.useOutputLevel).toBe('function');
    expect(typeof SdkReact.useRealtimeError).toBe('function');
    expect(typeof SdkReact.useRealtimeSession).toBe('function');
    expect(typeof SdkReact.useRealtimeSnapshot).toBe('function');

    // The root must not pull react into a headless consumer's graph.
    expect(barrelSource()).not.toMatch(/from '\.\/react'/);
    for (const name of Object.keys(SdkReact)) {
      expect(Sdk).not.toHaveProperty(name);
    }
  });
});

describe('SDK surface', () => {
  it('exports the canonical symbols', () => {
    expect(typeof Sdk.RealtimeClient).toBe('function');
    expect(typeof Sdk.RealtimeAgent).toBe('function');
    expect(typeof Sdk.RealtimeSession).toBe('function');
    expect(typeof Sdk.DialError).toBe('function');
    expect(typeof Sdk.SessionStartError).toBe('function');
    expect(typeof Sdk.SessionStartError).toBe('function');
    expect(typeof Sdk.SessionStartError).toBe('function');
    expect(typeof Sdk.SessionStartError).toBe('function');
    expect(typeof Sdk.SessionStartError).toBe('function');
    expect(typeof Sdk.SessionStartError).toBe('function');
    expect(typeof Sdk.CredentialsError).toBe('function');
    expect(typeof Sdk.MintTokenError).toBe('function');
    expect(typeof Sdk.RealtimeError).toBe('function');
    expect(typeof Sdk.Hook).toBe('function');
    expect(typeof Sdk.sessionStart).toBe('function');
    expect(typeof Sdk.preToolUse).toBe('function');
    expect(typeof Sdk.postToolUse).toBe('function');
    expect(typeof Sdk.sessionEnd).toBe('function');
    expect(typeof Sdk.parseSkillMd).toBe('function');
    expect(typeof Sdk.drawBoxTool).toBe('function');
    expect(typeof Sdk.drawPointTool).toBe('function');
    expect(typeof Sdk.notShown).toBe('function');
    expect(typeof Sdk.screenClickElementTool).toBe('function');
    expect(typeof Sdk.screenHighlightElementTool).toBe('function');
    expect(typeof Sdk.screenHighlightBoxTool).toBe('function');
    expect(typeof Sdk.notClicked).toBe('function');
    expect(typeof Sdk.SkillError).toBe('function');
  });

  /** Every published entry is walked, and the entry list is read from
   *  ``tsup.config.ts`` rather than written here — an entry point is a
   *  separate import path, so an error reachable only from one (as the tool
   *  errors are) needs the base reachable from that same path or its
   *  consumers cannot write the catch at all. Hand-listing the entries here
   *  reintroduces exactly the drift the prototype matching avoids;
   *  ``extract_typescript.mjs`` parses the same file for the same reason. */
  it('roots every error at RealtimeError, from every entry that exports one', async () => {
    const sdkRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const config = fs.readFileSync(path.join(sdkRoot, 'tsup.config.ts'), 'utf-8');
    const entries = [
      ...new Set([...config.matchAll(/['"]((?:src)\/[^'"]+\.tsx?)['"]/g)].map((m) => m[1])),
    ];
    expect(entries.length).toBeGreaterThan(10);

    const baseless: string[] = [];
    const orphans: string[] = [];
    for (const entry of entries) {
      const exports: Record<string, unknown> = await import(path.join(sdkRoot, entry));
      // Matched on the prototype chain, not the name, so an error class that
      // breaks the ``*Error`` convention is still covered.
      const errors = Object.entries(exports).filter(
        ([name, value]) =>
          typeof value === 'function' &&
          (value as { prototype?: unknown }).prototype instanceof Error &&
          name !== 'RealtimeError',
      );
      if (errors.length === 0) continue;
      if (exports.RealtimeError !== Sdk.RealtimeError) baseless.push(entry);
      for (const [name, ctor] of errors) {
        if (!((ctor as { prototype?: unknown }).prototype instanceof Sdk.RealtimeError)) {
          orphans.push(`${entry}:${name}`);
        }
      }
    }
    expect(orphans).toEqual([]);
    expect(baseless).toEqual([]);
  });

  it('exports the agent/session type vocabulary (compile-time)', () => {
    const config: Sdk.AgentConfig = {
      instructions: 'be terse',
      voice: 'Puck',
      greeting: 'Hi!',
      audio: { noiseCancellation: 'voice_focus' },
    };
    const tool: Sdk.AgentTool = Sdk.webSearchTool();
    const optIns: Sdk.AgentTool[] = [
      Sdk.webSearchTool(),
      Sdk.examineImageTool(),
      Sdk.detectObjectsTool(),
      Sdk.pointAtObjectTool(),
      Sdk.endCallTool(),
      Sdk.speakerLogTool(),
      // The one opt-in that carries configuration: the locator grounds against
      // a screenshot and element list only the client can produce.
      Sdk.screenLocateTool(() => ({ imageJpeg: new Uint8Array(), elements: [] })),
    ];
    const lifecycle: Sdk.SessionState = {
      kind: 'disconnected',
      disconnectReason: 'client_ended',
    };
    const reason: Sdk.DisconnectReason = 'server_ended';
    const silence: Sdk.SilenceTimeout = {
      trigger: 'user.speech.timeout',
      timeout_seconds: 10,
      action: { type: 'end_call', farewell: 'Goodbye.' },
    };
    const sessionEnd: Sdk.SessionEndContext = {
      event: 'SessionEnd',
      reason: 'client_ended',
      detail: null,
      sessionId: null,
    };
    // The public type is opaque; the wire discriminator is read back through
    // the internal payload door.
    expect(config.audio?.noiseCancellation).toBe('voice_focus');
    expect(agentToolPayload(tool).kind).toBe('web_search');
    expect(optIns.map((t) => agentToolPayload(t).kind)).toEqual([
      'web_search',
      'examine_image',
      'detect_objects',
      'point_at_object',
      'end_call',
      'speaker_log',
      'screen_locate',
    ]);
    expect(lifecycle.disconnectReason).toBe('client_ended');
    expect(reason).toBe('server_ended');
    expect(silence.timeout_seconds).toBe(10);
    expect(sessionEnd.event).toBe('SessionEnd');
  });

  it('does not export the retired RealtimeConnectArgs shape', () => {
    expect('RealtimeConnectArgs' in Sdk).toBe(false);
    expect(barrelSource()).not.toMatch(/RealtimeConnectArgs/);
  });

  it('does not export the retired TransferCallToolSpec shape', () => {
    expect('TransferCallToolSpec' in Sdk).toBe(false);
    expect(barrelSource()).not.toMatch(/TransferCallToolSpec/);
  });

  // The generated wire types are an implementation detail of the hand-written
  // surface, mapped at the transport boundary. The exception is closed string
  // unions, whose members are the wire's values in every language and so carry
  // no wire spelling into user code. Anything else re-exported here reaches
  // callers with the backend's field names — ``reset_mode`` in a TypeScript
  // API — and makes generator churn a breaking change on its own.
  it('re-exports no generated type but the closed string unions', () => {
    const allowed = [
      'EndOfSpeechSensitivity',
      'GrokReasoningEffort',
      'InterruptionSensitivity',
      'NoiseCancellation',
      'OpenAiLiveDelegation as OpenAILiveDelegation',
      'OpenAiLiveReasoningEffort as OpenAILiveReasoningEffort',
      'OpenAiLiveServiceTier as OpenAILiveServiceTier',
      'OpenAiLiveToolChoice as OpenAILiveToolChoice',
      'OpenAiLiveVerbosity as OpenAILiveVerbosity',
      'SemanticEagerness',
      'ThinkingLevel',
    ];
    const reExported = [...barrelSource().matchAll(/export type \{([^}]*)\} from '\.\/wire\/[^']*';/g)]
      .flatMap((match) => match[1].split(','))
      .map((name) => name.trim())
      .filter((name) => name !== '');
    expect(reExported.sort()).toEqual([...allowed].sort());
    // A `export ... from './wire/...'` that is not a type-only export would
    // ship generated runtime values too, and the regex above would miss it.
    expect(barrelSource()).not.toMatch(/export \{[^}]*\} from '\.\/wire\//);
  });

  // The barrel check above only sees direct re-exports. This one walks the
  // type graph of every published entry point in tsup.config.ts and reports
  // every generated declaration a consumer can still reach — including
  // through a field on a hand-written type, which is how `SessionConfig`
  // and the whole stream-frame union used to get out.
  it('exposes no generated type but the closed string unions, anywhere', () => {
    const script = path.join(
      path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'generated_exposure.mjs',
    );
    const reachable = JSON.parse(
      execFileSync(process.execPath, [script, '--json'], { encoding: 'utf-8' }),
    ) as string[];
    expect(reachable).toEqual([
      'EndOfSpeechSensitivity',
      'GrokReasoningEffort',
      'InterruptionSensitivity',
      'NoiseCancellation',
      'OpenAiLiveDelegation',
      'OpenAiLiveReasoningEffort',
      'OpenAiLiveServiceTier',
      'OpenAiLiveToolChoice',
      'OpenAiLiveVerbosity',
      'SemanticEagerness',
      'ThinkingLevel',
    ]);
  }, 60_000);

  // These shapes cross the wire, so they keep the wire's field names. What
  // changed is where they are declared: ``src/protocol`` rather than the
  // generated module, which is what the reachability test above measures.
  // This one pins the shapes themselves, so a "cleanup" that renames a field
  // has to be a deliberate breaking change rather than a passing refactor.
  it('keeps the wire spelling on the shapes that cross the wire', () => {
    const silence: Sdk.SilenceTimeout = {
      trigger: 'user.speech.timeout',
      timeout_seconds: 30,
      reset_mode: 'on_user_speech',
      max_count: 2,
      action: { type: 'say', text: 'Still there?' },
    };
    expect(silence.timeout_seconds).toBe(30);
    expectTypeOf<Sdk.SessionStartTimings>().toHaveProperty('db_insert_ms');
    expectTypeOf<Sdk.RejectedTool>().toHaveProperty('reason');
  });

  // ``Spec`` is the backend's suffix for a tool declaration on the wire. The
  // SDK never uses it at any layer, so a symbol carrying it here is a wire
  // type that escaped into the public surface.
  it('leaks no Spec-suffixed symbol', () => {
    expect(Object.keys(Sdk).filter((name) => /Spec$/.test(name))).toEqual([]);
    expect(barrelSource()).not.toMatch(/\w+Spec\b/);
  });

  // A tool reaches an agent one way in every SDK: call its constructor. A
  // per-tool type on the barrel is a second way to spell the same thing.
  it('exposes tools only as constructors returning AgentTool', () => {
    for (const build of [
      Sdk.webSearchTool,
      Sdk.examineImageTool,
      Sdk.detectObjectsTool,
      Sdk.pointAtObjectTool,
      Sdk.endCallTool,
      Sdk.speakerLogTool,
    ]) {
      expect(typeof build).toBe('function');
      expect(typeof agentToolPayload(build()).kind).toBe('string');
    }
    // Opaque means opaque: a hand-written literal is not an AgentTool.
    // @ts-expect-error a tool is built by calling its constructor
    const literal: Sdk.AgentTool = { kind: 'web_search' };
    expect(literal).toBeDefined();
    for (const named of [
      'WebSearchTool',
      'ExamineImageTool',
      'DetectObjectsTool',
      'PointAtObjectTool',
      'EndCallTool',
      'SpeakerLogTool',
      'ScreenLocateTool',
      'ClientTool',
      'BackgroundClientTool',
    ]) {
      expect(barrelSource()).not.toMatch(new RegExp(`^\\s+${named},$`, 'm'));
    }
  });

  it('does not export the retired ScreenInteraction conformer shape', () => {
    // The composite screen capability is gone: a capture handler plus the
    // renderer slots replaced the one object with four methods.
    expect(barrelSource()).not.toMatch(/ScreenInteraction/);
    expect(barrelSource()).not.toMatch(/ScreenHighlightResult/);
  });

  it('keeps Cosmo-only symbols out of the neutral barrel', () => {
    expect('COSMO_ASSISTANT_TOOL' in Sdk).toBe(false);
    expect('COSMO_APP_CONNECTOR_TOOL' in Sdk).toBe(false);
  });

  it('keeps Cosmo-internal config off the neutral agent config (compile-time)', () => {
    // Cosmo product concepts never ride the neutral agent config — the
    // cosmo wire block is gone entirely; a regression here fails
    // ``tsc --noEmit``.
    expectTypeOf<Sdk.AgentConfig>().not.toHaveProperty('projectId');
    expectTypeOf<Sdk.AgentConfig>().not.toHaveProperty('conversationId');
    expectTypeOf<Sdk.AgentConfig>().not.toHaveProperty('surface');
    expectTypeOf<Sdk.AgentConfig>().not.toHaveProperty('workflowId');
    expectTypeOf<Sdk.AgentConfig>().not.toHaveProperty('playgroundAgentId');
    expectTypeOf<Sdk.AgentConfig>().not.toHaveProperty('attachedResourceIds');
    expectTypeOf<Sdk.AgentConfig>().not.toHaveProperty('structuredInputs');
    expectTypeOf<Sdk.AgentConfig>().not.toHaveProperty('ambience');
    expectTypeOf<Sdk.AgentConfig>().not.toHaveProperty('outboundPhoneNumber');
  });

  it('does not leak the app-internal session manager through the public barrel', () => {
    expect('realtimeSessionManager' in Sdk).toBe(false);
    expect('appRealtimeSessionManager' in Sdk).toBe(false);
  });

  it('does not expose raw analyser methods', () => {
    expect('getInputAnalyser' in Sdk).toBe(false);
    expect('getOutputAnalyser' in Sdk).toBe(false);
  });

  it('does not expose the unimplemented client-tools shape', () => {
    // ClientToolDef + connect-args clientTools were a "reserved but throws
    // on use" foot-gun — keep them out of the public barrel until the
    // dispatch path actually ships.
    expect('ClientToolDef' in Sdk).toBe(false);
  });

  it('does not leak start/end/connect session verbs on RealtimeClient', () => {
    // ``client.agent({...}).start()`` is the only public way to open a
    // session; the engine method behind it is the @internal _startSession.
    const proto = (Sdk.RealtimeClient.prototype ?? {}) as unknown as Record<string, unknown>;
    expect('start' in proto).toBe(false);
    expect('end' in proto).toBe(false);
    expect('connect' in proto).toBe(false);
  });

  it('does not leak livekit-client symbols through the barrel', () => {
    expect(barrelSource()).not.toMatch(/from ['"]livekit-client['"]/);
  });

  it('keeps zod off the barrel so it stays an optional peer', () => {
    // Re-exporting zodInput here would make `zod` resolve for every
    // consumer of `cosmo-ai`, not just importers of `cosmo-ai/tool/zod`.
    expect(barrelSource()).not.toMatch(/from ['"]zod(\/|['"])/);
    expect(barrelSource()).not.toMatch(/from ['"]\.\/tool\/zod['"]/);
  });

  it('does not re-export livekit DataPacket_Kind from the transport surface', () => {
    expect('DataPacket_Kind' in Sdk).toBe(false);
  });
});
