/** The locator's capture plumbing: the RPC body the transport wires up, the
 *  byte-stream payload it publishes, and the handle store the renderers
 *  resolve against. Package-private — nothing here is consumer API; the
 *  consumer surface is ``./screen``. */

import type { ScreenLocateTool } from '../core/agent';
import { errorMessage } from '../core/client_tools';
import { log } from '../core/logger';
import { bytesToBase64 } from '../transport/envelope';
import type { ScreenCapture } from './screen';

/** RPC method + byte-stream topic the locator's capture step drives; must
 *  match the backend's ``SCREEN_CAPTURE_*`` constants and the sibling
 *  SDKs. */
export const SCREEN_CAPTURE_RPC_METHOD = 'screen_capture';
const SCREEN_CAPTURE_TOPIC = 'screen_capture';

/** Pairs a capture with the handles minted from it, keyed by ``captureId``.
 *  Entries expire (``ttlMs``) and the count is bounded (``maxEntries``).
 *  @internal */
export class ScreenCaptureCache {
  private readonly entries = new Map<string, { at: number; capture: ScreenCapture }>();

  constructor(
    private readonly ttlMs = 30_000,
    private readonly maxEntries = 4,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Store a capture under the id handed to the model. Also evicts entries
   *  past the TTL and, beyond the size cap, the oldest live one. */
  put(captureId: string, capture: ScreenCapture): void {
    const t = this.now();
    this.entries.set(captureId, { at: t, capture });
    for (const [id, entry] of this.entries) {
      if (t - entry.at >= this.ttlMs) this.entries.delete(id);
    }
    // Map preserves insertion order, so the oldest live entry is first.
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** The capture for an id, or ``undefined`` when it was never stored or
   *  has aged past the TTL — a stale handle and an unknown one are the same
   *  answer, since neither can be resolved against the screen. */
  get(captureId: string): ScreenCapture | undefined {
    const entry = this.entries.get(captureId);
    if (entry === undefined || this.now() - entry.at >= this.ttlMs) return undefined;
    return entry.capture;
  }
}

/** The captures handles currently address. Module-scoped because the slots are
 *  built independently — the capture handler fills it and the renderers read
 *  it, with no object in between for the caller to thread. Capture ids are
 *  server-minted per call, so an entry is only ever read back by the handle it
 *  was created for. */
export const captureCache = new ScreenCaptureCache();

/** Descriptor budgets, matching the backend's ``ScreenElement``. A descriptor is
 *  a *name* for a click target, so anything longer is a document the screenshot
 *  already shows; ``value`` is content rather than identity and is held tighter.
 *  The backend clamps too — capping here keeps the bytes off the wire rather
 *  than guarding validation. */
const ROLE_MAX_CHARS = 64;
const LABEL_MAX_CHARS = 512;
const VALUE_MAX_CHARS = 256;

/** Truncate to `limit` Unicode scalars — the clamp unit every SDK shares
 *  (and the one the reply shrinker already counts), so the same descriptor
 *  clamps to the same text in all three. */
function clampDescriptor(text: string, limit: number): string {
  // An untyped-JS caller can hand us a null descriptor, which passed straight
  // through before there was anything to clamp.
  if (typeof text !== 'string' || text.length <= limit) return text;
  const scalars = [...text];
  return scalars.length <= limit ? text : scalars.slice(0, limit).join('');
}

/** Encode a capture into the ``ScreenCapturePayload`` JSON bytes
 *  the byte stream carries. Absent descriptors are omitted.
 *  @internal */
export function screenCapturePayload(
  captureId: string,
  capture: ScreenCapture,
): Uint8Array {
  const elements = capture.elements.map((element) => {
    const obj: Record<string, unknown> = {
      idx: element.index,
      role: clampDescriptor(element.role, ROLE_MAX_CHARS),
      frame: [element.frame[0], element.frame[1], element.frame[2], element.frame[3]],
    };
    if (element.title !== undefined)
      obj.title = clampDescriptor(element.title, LABEL_MAX_CHARS);
    if (element.label !== undefined)
      obj.label = clampDescriptor(element.label, LABEL_MAX_CHARS);
    // Carried only where it is the element's sole name: the grounder reads the
    // screenshot, so a named element's content is a second copy of pixels it
    // can already see. A blank descriptor names nothing.
    const named = Boolean(
      (obj.title as string | undefined)?.trim() || (obj.label as string | undefined)?.trim(),
    );
    if (element.value !== undefined && !named)
      obj.value = clampDescriptor(element.value, VALUE_MAX_CHARS);
    return obj;
  });
  const payload = {
    capture_id: captureId,
    image_b64: bytesToBase64(capture.imageJpeg),
    mime_type: 'image/jpeg',
    elements,
  };
  return new TextEncoder().encode(JSON.stringify(payload));
}

/** The ``screen_capture`` RPC body: take the snapshot, keep it
 *  for the handles the locator is about to mint, publish it, and ack. A handler
 *  that throws is answered as "no capture" rather than as an RPC error — the
 *  locator has its own typed answer for it.
 *  @internal — wired to the transport by ``RealtimeClient``. */
export function screenCaptureRpc(
  spec: ScreenLocateTool,
  sendBytes: (data: Uint8Array, topic: string) => Promise<void>,
): (args: Record<string, unknown>) => Promise<Record<string, unknown>> {
  return async (args) => {
    const captureId = args.capture_id;
    if (typeof captureId !== 'string' || captureId === '') {
      // The server mints an id for every capture, so a missing one is a
      // protocol violation, not a decline.
      throw new Error("screen_capture: missing required 'capture_id'");
    }
    let capture: ScreenCapture;
    try {
      capture = await spec.capture({});
    } catch (err) {
      log.error('[realtime] screen capture failed', err);
      // The message is what the locator says to the model when it cannot
      // see the screen, so a handler that explains itself ("the user
      // stopped sharing") reaches them rather than the generic fallback.
      return { captured: false, message: errorMessage(err) };
    }
    captureCache.put(captureId, capture);
    await sendBytes(screenCapturePayload(captureId, capture), SCREEN_CAPTURE_TOPIC);
    return { captured: true };
  };
}
