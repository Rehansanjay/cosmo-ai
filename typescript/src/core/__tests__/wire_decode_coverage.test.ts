/**
 * Every inbound frame the spec defines is converted, or excused in writing.
 *
 * The mappers in ``core/wire_decode`` each guarantee they cover the frame
 * they read — a field added to a frame fails that mapper's build. What no
 * mapper can notice is a frame nobody wrote a mapper for: the dispatch
 * simply never names it, and the event reaches a consumer as ``unknown``
 * for as long as it takes someone to spot it.
 *
 * So this closes the same gap Python's
 * ``test_every_spec_component_is_pinned_or_excused`` closes, for the
 * inbound half: the list of converted frames is checked against the spec
 * rather than hand-maintained, and a frame deliberately left unconverted
 * says why here.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { decodeStreamEvent, WIRE_NAME } from '../wire_decode';

const SPEC_PATH = fileURLToPath(
  new URL('../../../../external-openapi.json', import.meta.url),
);

/** Inbound frames the SDK converts into one of its own event types. */
const CONVERTED = new Set([
  'ready',
  'transcript',
  'model-text',
  'turn-complete',
  'user-started-speaking',
  'user-stopped-speaking',
  'user-speech-timeout',
  'delegation-created',
  'bot-started-speaking',
  'bot-stopped-speaking',
  'bot-llm-started',
  'bot-llm-stopped',
  'bot-tts-started',
  'bot-tts-stopped',
  'tool-call',
  'tool-dispatch-started',
  'tool-result',
  'tool-invocation',
  'cosmo.usage',
  'cosmo.session-state',
  'reconnecting',
  'session-ending-soon',
  'session-ended',
  'error',
  'pong',
]);

/** Components that carry a ``type`` constant but are not an inbound frame a
 *  consumer receives, each with the reason. Everything named ``Client*`` is
 *  outbound by convention and filtered before this list is consulted. */
const NOT_AN_INBOUND_FRAME: Record<string, string> = {
  'server-envelope-chunk':
    'transport carrier — reassembled into the inner frame before dispatch, so it never reaches the stream',
  'session-config':
    'outbound — the SDK builds it from AgentConfig and sends it at connect',
  tool_job_result:
    'outbound — a background client tool reports through it',
  'delegation-append':
    'outbound — appendThinking / appendCommentary / appendInstructions send it',
  catalog: 'agent-config discriminator, not a frame',
  inline: 'agent-config discriminator, not a frame',
  say: 'server-hook action, carried inside the user-speech-timeout frame',
  end_call: 'server-hook action, carried inside the user-speech-timeout frame',
};

type SpecSchema = { properties?: { type?: { const?: string } } };

/** Every ``type`` constant the spec's server-frame components declare. */
function specServerFrameTypes(): Set<string> {
  const spec = JSON.parse(readFileSync(SPEC_PATH, 'utf8')) as {
    components?: { schemas?: Record<string, SpecSchema> };
  };
  const schemas = spec.components?.schemas ?? {};
  const types = new Set<string>();
  for (const [name, schema] of Object.entries(schemas)) {
    const konst = schema.properties?.type?.const;
    if (typeof konst !== 'string') continue;
    // Outbound frames are the SDK's to construct, not to convert.
    if (name.startsWith('Client')) continue;
    types.add(konst);
  }
  return types;
}

describe('inbound frame coverage', () => {
  it('converts every server frame the spec defines, or excuses it', () => {
    const spec = specServerFrameTypes();
    const accounted = new Set([...CONVERTED, ...Object.keys(NOT_AN_INBOUND_FRAME)]);
    const unaccounted = [...spec].filter((t) => !accounted.has(t)).sort();

    expect(
      unaccounted,
      'server frames neither converted nor excused: add a mapper in ' +
        'core/wire_decode and a case to decodeStreamEvent, or an entry to ' +
        'NOT_AN_INBOUND_FRAME saying why it reaches no consumer',
    ).toEqual([]);
  });

  it('names no frame the spec no longer defines', () => {
    const spec = specServerFrameTypes();
    const stale = [...CONVERTED, ...Object.keys(NOT_AN_INBOUND_FRAME)]
      .filter((t) => !spec.has(t))
      .sort();
    expect(stale, 'listed frames absent from the spec').toEqual([]);
  });

  it('dispatches every converted frame to the event named for it', () => {
    // The dispatch is a total switch over the union, so a frame with no case
    // is a compile error. This is the runtime half: each case is reached, and
    // the SDK name it yields maps back to the frame it was given.
    for (const type of CONVERTED) {
      const frame = { type } as Parameters<typeof decodeStreamEvent>[0];
      const decoded = decodeStreamEvent(frame);
      expect(
        WIRE_NAME[decoded.type],
        `${type} dispatched to the wrong event`,
      ).toBe(type);
    }
  });

  it('reads an explicitly null ready.agent as no agent', () => {
    // The server dumps its models without ``exclude_none``, so an inline or
    // default-agent session sends ``agent: null`` rather than omitting the
    // field. Reading that as "present" threw before the ready waiter settled.
    const withNull = decodeStreamEvent({
      type: 'ready',
      session_id: 'sess-1',
      agent: null,
    } as unknown as Parameters<typeof decodeStreamEvent>[0]);
    expect(withNull).toEqual({
      type: 'ready',
      sessionId: 'sess-1',
      rejectedTools: [],
      maxSessionSeconds: null,
      agent: null,
    });

    const omitted = decodeStreamEvent({
      type: 'ready',
      session_id: 'sess-1',
    } as unknown as Parameters<typeof decodeStreamEvent>[0]);
    expect(omitted).toEqual(withNull);
  });
});
