/** The output analyser follows the remote audio track.
 *
 * The track is subscribed after the connect resolves and can be replaced
 * mid-session, so an analyser built once, at connect, reads silence for the
 * whole call — which is what ``useOutputLevel`` and every speaker indicator
 * downstream of it show.
 *
 * It is built from the track's ``MediaStream``, never from the ``<audio>``
 * element: ``createMediaElementSource`` claims an element permanently and
 * diverts its audio into the graph, so an element tap throws on the second
 * session and, once its context is closed, silences the element for good.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionEngine } from '../session_engine';
import type { RealtimeTransport } from '../../transport/types';

/** Minimal Web Audio stand-in: node has no AudioContext, and the real graph
 *  is not what is under test — which source the analyser hangs off is. */
class FakeAudioContext {
  static sourcedElements: HTMLAudioElement[] = [];
  static sourcedStreams: MediaStream[] = [];
  static lastSource: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> } | null = null;
  static closeCalls = 0;
  readonly destination = {} as AudioNode;
  createMediaElementSource(el: HTMLAudioElement) {
    if (FakeAudioContext.sourcedElements.includes(el)) {
      // Matches the browser: one source per element, ever.
      throw new Error('InvalidStateError: element already connected');
    }
    FakeAudioContext.sourcedElements.push(el);
    return { connect: vi.fn(), disconnect: vi.fn() } as unknown as MediaElementAudioSourceNode;
  }
  createMediaStreamSource(stream: MediaStream) {
    FakeAudioContext.sourcedStreams.push(stream);
    const src = { connect: vi.fn(), disconnect: vi.fn() };
    FakeAudioContext.lastSource = src;
    return src as unknown as MediaStreamAudioSourceNode;
  }
  createAnalyser() {
    return { fftSize: 0, frequencyBinCount: 128, getFloatTimeDomainData: vi.fn() } as unknown as AnalyserNode;
  }
  close() {
    FakeAudioContext.closeCalls += 1;
    return Promise.resolve();
  }
}

type SwappableTransport = RealtimeTransport & {
  setOutputStream: (stream: MediaStream | null) => void;
};

/** Transport whose remote audio arrives after connect and can be replaced,
 *  as LiveKit's does on TrackSubscribed and on a speaker handover. */
function transportWithSwappableOutput(): SwappableTransport {
  let stream: MediaStream | null = null;
  const listeners = new Set<() => void>();
  return {
    connect: async () => {},
    disconnect: async () => {},
    send: async () => {},
    setMicMuted: async () => {},
    getInputStream: () => null,
    getOutputAudioElement: () => null,
    getOutputStream: () => stream,
    onOutputStreamChanged: (cb: () => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb) as unknown as void;
    },
    attachAudioElement: () => {},
    onMessage: () => () => {},
    onClose: () => () => {},
    onReconnecting: () => () => {},
    onReconnected: () => () => {},
    setOutputStream: (next: MediaStream | null) => {
      stream = next;
      for (const cb of listeners) cb();
    },
  } as unknown as SwappableTransport;
}

function makeEngine(transport: RealtimeTransport): SessionEngine {
  return new SessionEngine({
    createTransport: () => transport,
    startUrl: () => 'https://api.example.com/start',
    dialUrl: (id) => `https://api.example.com/${id}/dial`,
    usageUrl: (id) => `https://api.example.com/${id}/usage`,
    resolveAuthHeaders: async () => ({}),
    onStartUnauthorized: () => {},
  });
}

/** Stand in for a completed connect without driving the whole start path:
 *  hold the transport and subscribe the way ``start`` does. */
function connected(transport: SwappableTransport): SessionEngine {
  const engine = makeEngine(transport);
  (engine as unknown as { connection: RealtimeTransport }).connection = transport;
  transport.onOutputStreamChanged?.(() =>
    (engine as unknown as { refreshOutputAnalyser: () => void }).refreshOutputAnalyser(),
  );
  return engine;
}

function teardown(engine: SessionEngine): Promise<void> {
  return (engine as unknown as { teardown: (o?: object) => Promise<void> }).teardown();
}

function fakeStream(id: string): MediaStream {
  return { id } as unknown as MediaStream;
}

describe('output analyser', () => {
  beforeEach(() => {
    FakeAudioContext.sourcedElements = [];
    FakeAudioContext.sourcedStreams = [];
    FakeAudioContext.lastSource = null;
    FakeAudioContext.closeCalls = 0;
    (globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext;
  });

  it('builds the analyser when the remote track arrives after the connect', async () => {
    const transport = transportWithSwappableOutput();
    const engine = connected(transport);

    expect(engine.getOutputAnalyser()).toBeNull();

    const stream = fakeStream('agent');
    transport.setOutputStream(stream);

    expect(engine.getOutputAnalyser()).not.toBeNull();
    expect(FakeAudioContext.sourcedStreams).toEqual([stream]);
    await teardown(engine);
  });

  it('rebuilds against the new stream when one replaces another', async () => {
    const transport = transportWithSwappableOutput();
    const engine = connected(transport);

    const first = fakeStream('first');
    transport.setOutputStream(first);
    const firstAnalyser = engine.getOutputAnalyser();

    const second = fakeStream('second');
    transport.setOutputStream(second);

    expect(engine.getOutputAnalyser()).not.toBe(firstAnalyser);
    expect(FakeAudioContext.sourcedStreams).toEqual([first, second]);
    await teardown(engine);
  });

  it('clears the analyser when the remote track goes away', async () => {
    const transport = transportWithSwappableOutput();
    const engine = connected(transport);
    transport.setOutputStream(fakeStream('agent'));
    const src = FakeAudioContext.lastSource;

    transport.setOutputStream(null);

    expect(engine.getOutputAnalyser()).toBeNull();
    expect(src?.disconnect).toHaveBeenCalled();
    await teardown(engine);
  });

  it('never sources the audio element', async () => {
    // The regression guard. ``createMediaElementSource`` claims an element
    // for the life of the page, so touching it here is what made a second
    // session throw and left the element routed into a closed context.
    const transport = transportWithSwappableOutput();
    const engine = connected(transport);
    transport.setOutputStream(fakeStream('agent'));

    expect(FakeAudioContext.sourcedElements).toEqual([]);
    await teardown(engine);
  });

  it('does not connect the source to the speakers', async () => {
    // The element already plays this track. A destination link here would
    // play it a second time through the graph.
    const transport = transportWithSwappableOutput();
    const engine = connected(transport);
    transport.setOutputStream(fakeStream('agent'));
    const src = FakeAudioContext.lastSource;

    const connectedTo = src!.connect.mock.calls.map((c) => c[0]);
    expect(connectedTo).toEqual([engine.getOutputAnalyser()]);
    await teardown(engine);
  });

  it('a second session reusing the page\'s audio element still meters', async () => {
    // The bug this file exists for, in its original shape: a React host
    // keeps ONE <audio> across sessions. Session one used to claim it and
    // close the context holding the claim, so session two threw and the
    // element was left routed into a dead graph. The element is never
    // claimed now, so both sessions meter and neither touches it.
    const hostElement = { id: 'host' } as unknown as HTMLAudioElement;

    const transport1 = transportWithSwappableOutput();
    const engine1 = connected(transport1);
    engine1.attachAudioElement(hostElement);
    transport1.setOutputStream(fakeStream('first-call'));
    expect(engine1.getOutputAnalyser()).not.toBeNull();
    await teardown(engine1);

    const transport2 = transportWithSwappableOutput();
    const engine2 = connected(transport2);
    engine2.attachAudioElement(hostElement);
    transport2.setOutputStream(fakeStream('second-call'));

    expect(engine2.getOutputAnalyser()).not.toBeNull();
    expect(FakeAudioContext.sourcedElements).toEqual([]);
    await teardown(engine2);
  });

  it('teardown disconnects the source and closes the context', async () => {
    const transport = transportWithSwappableOutput();
    const engine = connected(transport);
    transport.setOutputStream(fakeStream('agent'));
    const src = FakeAudioContext.lastSource;
    expect(src).not.toBeNull();

    await teardown(engine);

    expect(src?.disconnect).toHaveBeenCalled();
    expect(engine.getOutputAnalyser()).toBeNull();
    // Safe to close precisely because nothing here outlives the session.
    expect(FakeAudioContext.closeCalls).toBeGreaterThan(0);
  });

  it('does not rebuild for an unchanged stream', async () => {
    const transport = transportWithSwappableOutput();
    const engine = connected(transport);

    const stream = fakeStream('agent');
    transport.setOutputStream(stream);
    const analyser = engine.getOutputAnalyser();

    transport.setOutputStream(stream);

    expect(engine.getOutputAnalyser()).toBe(analyser);
    expect(FakeAudioContext.sourcedStreams).toEqual([stream]);
    await teardown(engine);
  });
});
