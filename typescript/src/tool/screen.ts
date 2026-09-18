/**
 * The screen tools the SDK ships: the capture handler behind the server's
 * locator, and the three renderers that act on what it finds —
 * ``cosmo_sdk_screen_click_element``, ``cosmo_sdk_screen_highlight_element``
 * and ``cosmo_sdk_screen_highlight_box``.
 *
 * The ``screen_locate`` opt-in declares the server-side locator
 * (``cosmo_screen_locate``) and answers the capture RPC it drives, which is
 * why it carries a ``capture`` handler where the other opt-ins are bare
 * kinds. The server grounds the model's
 * description against the screenshot and the accessibility list, then hands
 * the model candidates carrying a ``found_element`` handle. The model picks one
 * and passes the handle to a renderer, where the SDK resolves it back to the
 * element it addresses::
 *
 *     const agent = client.agent({
 *       instructions: 'help the user drive their machine',
 *       tools: [
 *         screenLocateTool(request => grabScreen(request)),
 *         screenClickElementTool(({ element, action }) => {
 *           if (!canControlTheDesktop()) return notClicked('I need accessibility access');
 *           press(element.frame, action);
 *           return clicked;
 *         }),
 *       ],
 *     });
 *
 * ``screenHighlightBoxTool`` stands apart: its caller already has coordinates, so
 * it skips capture and grounding and draws immediately.
 *
 * Platform-neutral: macOS clicks a mouse, iOS taps, a web client clicks the
 * DOM — only the handlers differ. Names, wording, schemas, decode and reply
 * shapes are cross-SDK contract, pinned by
 * ``sdk-client-tool-vectors.json``.
 */

import { mintAgentTool } from '../core/agent';
import type { AgentTool, ClientTool, ScreenLocateTool } from '../core/agent';
import { log } from '../core/logger';

import { notShown, type NotShown } from './draw';
import { markSdkClientTool } from './sdk_tool';
import { captureCache } from './screen_capture_rpc';

/** Which side of the target the tooltip sits on; ``auto`` picks the side with
 *  the most room. */
export const SCREEN_PLACEMENTS = ['auto', 'top', 'bottom', 'left', 'right'] as const;
/** One of ``SCREEN_PLACEMENTS``. */
export type ScreenPlacement = (typeof SCREEN_PLACEMENTS)[number];

/** Which glyph the highlight draws — the action being asked of the user. A
 *  highlight never acts on their behalf; see {@link ScreenClickAction} for
 *  that. Arrives in a field named ``interaction``, which alone would read as
 *  what a click does. */
export const SCREEN_AFFORDANCES = [
  'pointer',
  'click',
  'double_click',
  'left_click',
  'right_click',
  'drag_show',
  'press_hold',
  'inform',
] as const;
/** One of ``SCREEN_AFFORDANCES``. */
export type ScreenAffordance = (typeof SCREEN_AFFORDANCES)[number];

/** Which button/gesture to click with: ``left`` is a left click on desktop /
 *  tap on touch; ``right`` a right click / long-press. */
export type ScreenClickButton = 'left' | 'right';

/** How to click the located element: which button/gesture, and whether it's a
 *  double. Button and double are orthogonal axes rather than a flat enum. */
export type ScreenClickAction = {
  /** Which button or gesture to use. */
  button: ScreenClickButton;
  /** Whether it is a double click. Orthogonal to ``button``. */
  double: boolean;
};

/** One interactive on-screen element the locator may pick. ``index`` is
 *  0-based and contiguous within one {@link ScreenCapture}; ``frame`` is
 *  ``[x, y, w, h]`` in the platform's screen coordinates. */
export type ScreenElement = {
  /** Position in this capture's element list, 0-based and contiguous. The
   *  model refers to an element by this. */
  index: number;
  /** What kind of control it is, in the platform's own vocabulary — e.g.
   *  ``button``, ``textfield``. */
  role: string;
  /** ``[x, y, width, height]`` in the platform's screen coordinates. */
  frame: [number, number, number, number];
  /** Its visible title, when it has one. */
  title?: string;
  /** Its accessibility label, when it has one. */
  label?: string;
  /** Its current value — the text in a field, a control's setting. */
  value?: string;
};

/** A snapshot the locator works from: the image plus the pickable elements.
 *  ``context`` is opaque per-capture state the handler may stash and read back
 *  at click time to validate freshness (e.g. the frontmost-app identity); the
 *  SDK never inspects it. */
export type ScreenCapture = {
  /** The screenshot the model reasons over, JPEG-encoded. */
  imageJpeg: Uint8Array;
  /** The elements it may pick from. Empty when the capture did not gather
   *  them — the locator grounds a handle against these, so returning none
   *  leaves it nothing to resolve. */
  elements: ScreenElement[];
  /** Opaque state you may stash and read back at click time — the SDK never
   *  inspects it. Use it to check the capture is still current, e.g. that the
   *  same app is still frontmost. */
  context?: unknown;
};

/** A rectangle the model located itself, as fractions of the shared surface —
 *  the shared window's live bounds when a window is shared, else the display:
 *  ``x``/``y`` are the top-left corner (0 = left/top), all four in ``0..1``.
 *
 *  Deliberately not reusing {@link ScreenElement.frame}, which is the same
 *  shape in platform screen coordinates — the two spaces are not
 *  interchangeable, and mixing them draws a marker in the top-left one percent
 *  of the screen. */
export type ScreenBox = {
  /** Left edge, ``0``–``1`` across the shared surface. */
  x: number;
  /** Top edge, ``0``–``1`` down the shared surface. */
  y: number;
  /** Width as a fraction of the surface's width. */
  width: number;
  /** Height as a fraction of the surface's height. */
  height: number;
};

/** What the model believes the target is *called*, alongside where it thinks
 *  it is. A handler with a platform accessibility tree can ask the OS for that
 *  control's exact frame — better than any estimate — and one without a usable
 *  tree ignores this and falls back to the box.
 *
 *  ``title`` is the control's own visible text ("Files changed"), not the
 *  tooltip the highlight displays; the tooltip travels separately as
 *  ``label``. ``role`` disambiguates a title that appears more than once. */
export type ScreenElementHint = {
  /** What the model believes the target is called — its visible text, not
   *  the tooltip. */
  title: string;
  /** The kind of control, to disambiguate a repeated title. */
  role?: string;
};

/** What a click handler is asked to do: the element the handle resolved to,
 *  the capture it was picked from, and how to click it. */
export type ScreenClickRequest = {
  /** The element the handle resolved to. */
  element: ScreenElement;
  /** The capture it was picked from — check ``context`` if you need to
   *  confirm the screen has not moved on. */
  capture: ScreenCapture;
  /** Which button, and whether it is a double. */
  action: ScreenClickAction;
};

/** What a highlight handler is asked to do, for a handle the locator minted. */
export type ScreenHighlightRequest = {
  /** The element to highlight. */
  element: ScreenElement;
  /** The capture it was picked from. */
  capture: ScreenCapture;
  /** Tooltip text to show beside the highlight. */
  label: string;
  /** Which side of the element the tooltip sits on. */
  placement: ScreenPlacement;
  /** Which glyph to draw — the action being asked of the user. */
  interaction: ScreenAffordance;
};

/** What a highlight handler is asked to do when the model gave a box instead
 *  of a handle. ``elementGuess`` is a bonus signal, never a requirement — most
 *  apps expose no usable label. */
export type ScreenHighlightBoxRequest = {
  /** Where the model believes the target is. */
  box: ScreenBox;
  /** What the model thinks the target is called, when it can guess — a bonus
   *  signal for snapping the box onto a real control. */
  elementGuess?: ScreenElementHint;
  /** Tooltip text to show beside the highlight. */
  label: string;
  /** Which side of the target the tooltip sits on. */
  placement: ScreenPlacement;
  /** Which glyph to draw — the action being asked of the user. */
  interaction: ScreenAffordance;
};

/** What a click reports back.
 *
 *  Clicking can fail for reasons the model has to hear about — the user
 *  stopped sharing, the window moved, accessibility access is off. Answering
 *  "clicked" regardless would leave it narrating something that never
 *  happened, so a refusal carries a reason the agent can say out loud. */
export type ScreenClickOutcome =
  | { clicked: true }
  | {
      clicked: false;
      /** Why nothing was clicked — model-facing prose the agent says out
       *  loud, not an error code. */
      reason: string;
    };

/** The click landed. */
export const clicked: ScreenClickOutcome = { clicked: true };

/** Nothing was clicked. ``reason`` is model-facing: write it as an instruction
 *  the agent can speak ("the window moved — locate it again"), not as an error
 *  code. */
export function notClicked(reason: string): ScreenClickOutcome {
  return { clicked: false, reason };
}

/** What a highlight reports back: it is showing, but is it *on* the thing?
 *  Shared by both highlights so the model reads the same field either way — a
 *  handler that resolved the target to a real control answers
 *  {@link landedOnControl}, one that could only use the model's box answers
 *  {@link landedOnEstimate}, the model's cue to re-target through the
 *  locator. Refuse with {@link notShown}, shared with the camera renderers. */
export type ScreenHighlightOutcome =
  | {
      shown: true;
      /** Whether it landed on a real resolved control (``true``) or only
       *  where the model estimated (``false``) — the model's cue to re-target
       *  through the locator. */
      exact: boolean;
    }
  | NotShown;

/** The highlight is on a real control. The only honest answer from a handle
 *  the locator grounded; from a box, only once something confirmed it. */
export const landedOnControl: ScreenHighlightOutcome = { shown: true, exact: true };

/** The highlight is up, on the box the model gave — nothing confirmed it sits
 *  on the control. */
export const landedOnEstimate: ScreenHighlightOutcome = { shown: true, exact: false };

/** The capture being asked for. It carries no options today; any future
 *  capture option lands here, inside the parameter every handler already
 *  accepts. */
export type ScreenCaptureRequest = Record<string, never>;

/** Snapshot the shared screen: the image the locator grounds against, plus
 *  the elements it may pick from. Rejecting (or returning no elements)
 *  surfaces to the model as an inability to see the screen. A handler that
 *  ignores its {@link ScreenCaptureRequest} argument stays valid. */
export type ScreenCaptureHandler = (
  request: ScreenCaptureRequest,
) => ScreenCapture | Promise<ScreenCapture>;

/** Locate UI elements against a screenshot ``capture`` produces. */
export function screenLocateTool(capture: ScreenCaptureHandler): AgentTool {
  return mintAgentTool({ kind: 'screen_locate', capture });
}

/** Wire name of the click tool as it appears in tool-call events; a rename
 *  is a wire break. */
export const SCREEN_CLICK_TOOL_NAME = 'cosmo_sdk_screen_click_element';
/** Wire name of the element-highlight tool as it appears in tool-call
 *  events; a rename is a wire break. */
export const SCREEN_HIGHLIGHT_TOOL_NAME = 'cosmo_sdk_screen_highlight_element';
/** Wire name of the box-highlight tool as it appears in tool-call events; a
 *  rename is a wire break. */
export const SCREEN_HIGHLIGHT_BOX_TOOL_NAME = 'cosmo_sdk_screen_highlight_box';


/** Joins the two halves inside a ``found_element`` handle; must match the
 *  backend's ``encode_found_element``. */
const HANDLE_PATTERN = /^(.+)#(\d+)$/;

const SCREEN_CLICK_DESCRIPTION =
  'Click an element on the shared screen. Takes a found_element handle from ' +
  'cosmo_screen_locate — pass one back exactly as you received it, never one ' +
  'you assembled yourself.';

const SCREEN_HIGHLIGHT_DESCRIPTION =
  'Highlight an element on the shared screen — point at it without acting on ' +
  'it. Takes a found_element handle from cosmo_screen_locate; pass one back ' +
  'exactly as you received it. Visual only: it never clicks.';

const SCREEN_HIGHLIGHT_BOX_DESCRIPTION =
  'Highlight a target on the shared screen, given its box as fractions of the ' +
  'surface and a tooltip label. This is the default way to point at something: ' +
  'it draws instantly, with no capture or lookup. Reach for cosmo_screen_locate ' +
  'and cosmo_sdk_screen_highlight_element only when you cannot give a box, or ' +
  'when this answered exact: false. A screen tool: it draws on the ' +
  "user's actual screen, so use it only for the shared screen — never for a " +
  'camera feed, and never with a box taken from a camera frame.';

const FOUND_ELEMENT_PARAMETER = {
  type: 'string',
  description: 'A found_element handle exactly as cosmo_screen_locate returned it.',
};

const LABEL_PARAMETER = {
  type: 'string',
  maxLength: 80,
  description: 'Tooltip text shown beside the highlight.',
};

const PLACEMENT_PARAMETER = {
  type: 'string',
  enum: [...SCREEN_PLACEMENTS],
  description: 'Which side of the target the tooltip sits on.',
};

const INTERACTION_PARAMETER = {
  type: 'string',
  enum: [...SCREEN_AFFORDANCES],
  description:
    'Which glyph the highlight draws — the action being asked of the user.',
};

const SCREEN_CLICK_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    found_element: FOUND_ELEMENT_PARAMETER,
    button: {
      type: 'string',
      enum: ['left', 'right'],
      description: "'right' opens context menus.",
    },
    double: {
      type: 'boolean',
      description: 'True for a double-click (open a file, select a word).',
    },
  },
  required: ['found_element'],
};

const SCREEN_HIGHLIGHT_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    found_element: FOUND_ELEMENT_PARAMETER,
    label: LABEL_PARAMETER,
    placement: PLACEMENT_PARAMETER,
    interaction: INTERACTION_PARAMETER,
  },
  required: ['found_element', 'label'],
};

const SCREEN_HIGHLIGHT_BOX_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    x: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: 'Target box left edge, fraction 0-1 of the shared surface width.',
    },
    y: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description:
        'Target box top edge, fraction 0-1 of the shared surface height (0 = top).',
    },
    width: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: 'Target box width, fraction 0-1 of the surface width.',
    },
    height: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: 'Target box height, fraction 0-1 of the surface height.',
    },
    label: LABEL_PARAMETER,
    element_title: {
      type: 'string',
      maxLength: 200,
      description:
        "The control's own visible text, when it has one, e.g. 'Files changed'. " +
        "When it matches the app's accessibility tree the highlight snaps onto " +
        'that exact control instead of your box. Send the box regardless — many ' +
        'apps expose no usable label.',
    },
    element_role: {
      type: 'string',
      maxLength: 64,
      description: "Accessibility role disambiguating the title match, e.g. 'AXButton'.",
    },
    placement: PLACEMENT_PARAMETER,
    interaction: INTERACTION_PARAMETER,
  },
  required: ['x', 'y', 'width', 'height', 'label'],
};


/** Model-facing: a handle the cache can no longer resolve is a benign decline,
 *  not an error — the model's move is to locate again, not to retry. */
const UNRESOLVABLE_HANDLE_REASON =
  'that found_element is no longer valid — call cosmo_screen_locate again for a fresh one';


/** Mint a handle the way the backend's ``encode_found_element`` does. The SDK
 *  never calls this in production — the locator is the only minter — but the
 *  format is a two-party contract with the backend, so it is written down in
 *  code both sides' vectors can be checked against.
 *  @internal */
export function encodeFoundElement(captureId: string, elementIdx: number): string {
  return `${captureId}#${elementIdx}`;
}

/** Split a handle into the capture it names and the element's index there;
 *  ``null`` when it is not one this SDK minted the shape of. The rightmost
 *  separator binds, so a capture id containing one survives the round trip.
 *  @internal */
export function parseFoundElementHandle(
  handle: string,
): { captureId: string; elementIdx: number } | null {
  const match = HANDLE_PATTERN.exec(handle);
  if (match === null) return null;
  return { captureId: match[1], elementIdx: Number(match[2]) };
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

function coordinate(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? clamp01(value) : null;
}

/** Decode only checks a handle is present — its contents are the SDK's business
 *  at resolution time, so a token the model assembled itself is a miss against
 *  the cache rather than a decode error, and the model is told to locate again
 *  rather than handed a schema complaint. */
function parseFoundElement(raw: unknown): string | null {
  return typeof raw === 'string' && raw !== '' ? raw : null;
}

/** Unlike the glyph, an unknown button is rejected rather than defaulted:
 *  guessing here opens a context menu the user never asked for. */
function parseButton(raw: unknown): ScreenClickButton | null {
  if (raw === undefined) return 'left';
  return raw === 'left' || raw === 'right' ? raw : null;
}

function parsePlacement(raw: unknown): ScreenPlacement {
  return (SCREEN_PLACEMENTS as readonly unknown[]).includes(raw)
    ? (raw as ScreenPlacement)
    : 'auto';
}

/** An unrecognized glyph falls back rather than rejecting: it means the caller
 *  is newer than this SDK, and a highlight with the wrong glyph still points
 *  the user at the right control, where an error points them at nothing. */
function parseAffordance(raw: unknown): ScreenAffordance {
  return (SCREEN_AFFORDANCES as readonly unknown[]).includes(raw)
    ? (raw as ScreenAffordance)
    : 'click';
}

function parseLabel(args: Record<string, unknown>): string | null {
  return typeof args.label === 'string' ? args.label : null;
}

function parseBox(args: Record<string, unknown>): ScreenBox | null {
  const values: number[] = [];
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    const value = coordinate(args[key]);
    if (value === null) return null;
    values.push(value);
  }
  return { x: values[0], y: values[1], width: values[2], height: values[3] };
}

/** Absent or blank means the model could not read a name off the target,
 *  which is normal. */
function parseElementHint(args: Record<string, unknown>): ScreenElementHint | undefined {
  const title = args.element_title;
  if (typeof title !== 'string' || title.trim() === '') return undefined;
  const role = args.element_role;
  return {
    title,
    ...(typeof role === 'string' && role !== '' ? { role } : {}),
  };
}

/** Decoded ``cosmo_sdk_screen_click_element`` arguments, before the handle is
 *  resolved. */
export type ScreenClickArgs = {
  /** The handle ``cosmo_screen_locate`` returned, passed back verbatim.
   *  Resolve it against the capture it was issued for. */
  found_element: string;
  /** Which mouse button; ``'right'`` opens context menus. */
  button: ScreenClickButton;
  /** ``true`` for a double-click — open a file, select a word. */
  double: boolean;
};

/** Decoded ``cosmo_sdk_screen_highlight_element`` arguments, before the handle
 *  is resolved. */
export type ScreenHighlightArgs = {
  /** The handle ``cosmo_screen_locate`` returned, passed back verbatim.
   *  Resolve it against the capture it was issued for. */
  found_element: string;
  /** Tooltip text to show with the highlight. */
  label: string;
  /** Where the tooltip sits relative to the highlighted element. */
  placement: ScreenPlacement;
  /** The gesture the label suggests, which sets the affordance drawn. */
  interaction: ScreenAffordance;
};

/** Decode a ``cosmo_sdk_screen_click_element`` invocation. ``null`` when the
 *  handle is absent, or the button is one this SDK does not know — a boundary
 *  check on model output, not an invariant. */
export function parseScreenClickArgs(
  args: Record<string, unknown>,
): ScreenClickArgs | null {
  const found = parseFoundElement(args.found_element);
  if (found === null) return null;
  const button = parseButton(args.button);
  if (button === null) return null;
  return { found_element: found, button, double: args.double === true };
}

/** Decode a ``cosmo_sdk_screen_highlight_element`` invocation. ``null`` when
 *  the handle or the tooltip label is absent or malformed. */
export function parseScreenHighlightArgs(
  args: Record<string, unknown>,
): ScreenHighlightArgs | null {
  const found = parseFoundElement(args.found_element);
  const label = parseLabel(args);
  if (found === null || label === null) return null;
  return {
    found_element: found,
    label,
    placement: parsePlacement(args.placement),
    interaction: parseAffordance(args.interaction),
  };
}

/** Decode a ``cosmo_sdk_screen_highlight_box`` invocation. ``null`` when a box
 *  component or the tooltip label is absent or malformed; coordinates are
 *  clamped, so a model that overshoots the surface edge still yields a
 *  drawable box. */
export function parseScreenHighlightBoxRequest(
  args: Record<string, unknown>,
): ScreenHighlightBoxRequest | null {
  const box = parseBox(args);
  const label = parseLabel(args);
  if (box === null || label === null) return null;
  return {
    box,
    elementGuess: parseElementHint(args),
    label,
    placement: parsePlacement(args.placement),
    interaction: parseAffordance(args.interaction),
  };
}

/** Split a handle back into the capture it names and the element's index there,
 *  then look both up. A token that does not parse, names a capture the cache no
 *  longer holds, or overshoots its element list is one miss — the caller cannot
 *  tell them apart, and neither should the model.
 *
 *  A token that does not parse is that same miss to the model, but not the same
 *  event: the locator only ever mints well-formed handles, so either this SDK's
 *  pattern has drifted from the backend's encoder or the model invented one.
 *  Neither can raise — a fabricated handle is model output, not a broken
 *  invariant — so it is logged instead, or a separator that disagreed across
 *  SDKs would present as a session where every highlight quietly declines. */
function resolveFoundElement(
  foundElement: string,
): { element: ScreenElement; capture: ScreenCapture } | null {
  const parts = parseFoundElementHandle(foundElement);
  if (parts === null) {
    log.warn('[realtime] unparseable found_element handle', foundElement);
    return null;
  }
  const capture = captureCache.get(parts.captureId);
  if (capture === undefined || parts.elementIdx >= capture.elements.length) return null;
  return { element: capture.elements[parts.elementIdx], capture };
}

function highlightReply(outcome: ScreenHighlightOutcome): Record<string, unknown> {
  if (!outcome.shown) return { shown: false, reason: outcome.reason };
  return { shown: true, exact: outcome.exact };
}


/** The click renderer, ready to add to an agent's ``tools`` alongside the
 *  ``screen_locate`` opt-in that feeds it. Your handler owns only the clicking —
 *  and the honest answer about whether it happened. Malformed arguments
 *  surface to the model as the call's error without reaching your code, and a
 *  handle the capture cache can no longer resolve declines with a reason
 *  instead of clicking something else. */
export function screenClickElementTool(
  onClick: (
    request: ScreenClickRequest,
  ) => ScreenClickOutcome | Promise<ScreenClickOutcome>,
): AgentTool {
  return mintAgentTool(markSdkClientTool({
    kind: 'client',
    name: SCREEN_CLICK_TOOL_NAME,
    description: SCREEN_CLICK_DESCRIPTION,
    parameters: SCREEN_CLICK_PARAMETERS,
    handler: async (args) => {
      const parsed = parseScreenClickArgs(args);
      if (parsed === null) {
        throw new Error(
          `${SCREEN_CLICK_TOOL_NAME}: pass found_element exactly as ` +
            'cosmo_screen_locate returned it, and button left|right',
        );
      }
      const resolved = resolveFoundElement(parsed.found_element);
      if (resolved === null) return notClicked(UNRESOLVABLE_HANDLE_REASON);
      return {
        ...(await onClick({
          ...resolved,
          action: { button: parsed.button, double: parsed.double },
        })),
      };
    },
  }));
}

/** The element highlight. Same handle contract as {@link screenClickElementTool},
 *  reporting through the highlight outcome it shares with
 *  {@link screenHighlightBoxTool} — a grounded handle is on a real control, so
 *  {@link landedOnControl} is the answer here. */
export function screenHighlightElementTool(
  onHighlight: (
    request: ScreenHighlightRequest,
  ) => ScreenHighlightOutcome | Promise<ScreenHighlightOutcome>,
): AgentTool {
  return mintAgentTool(markSdkClientTool({
    kind: 'client',
    name: SCREEN_HIGHLIGHT_TOOL_NAME,
    description: SCREEN_HIGHLIGHT_DESCRIPTION,
    parameters: SCREEN_HIGHLIGHT_PARAMETERS,
    handler: async (args) => {
      const parsed = parseScreenHighlightArgs(args);
      if (parsed === null) {
        throw new Error(
          `${SCREEN_HIGHLIGHT_TOOL_NAME}: pass found_element exactly as ` +
            'cosmo_screen_locate returned it, and a label',
        );
      }
      const resolved = resolveFoundElement(parsed.found_element);
      if (resolved === null) {
        return highlightReply(notShown(UNRESOLVABLE_HANDLE_REASON));
      }
      return highlightReply(
        await onHighlight({
          ...resolved,
          label: parsed.label,
          placement: parsed.placement,
          interaction: parsed.interaction,
        }),
      );
    },
  }));
}

/** The box highlight: no capture, no locator, no cache — the model gives
 *  the box and your handler draws it. Answer {@link landedOnControl} only when
 *  something confirmed the highlight sits on a real control; {@link landedOnEstimate}
 *  is what tells the model to re-target through the locator. */
export function screenHighlightBoxTool(
  onHighlight: (
    request: ScreenHighlightBoxRequest,
  ) => ScreenHighlightOutcome | Promise<ScreenHighlightOutcome>,
): AgentTool {
  return mintAgentTool(markSdkClientTool({
    kind: 'client',
    name: SCREEN_HIGHLIGHT_BOX_TOOL_NAME,
    description: SCREEN_HIGHLIGHT_BOX_DESCRIPTION,
    parameters: SCREEN_HIGHLIGHT_BOX_PARAMETERS,
    handler: async (args) => {
      const request = parseScreenHighlightBoxRequest(args);
      if (request === null) {
        throw new Error(
          `${SCREEN_HIGHLIGHT_BOX_TOOL_NAME}: pass x, y, width and height as ` +
            'fractions of the shared surface, plus a label',
        );
      }
      return highlightReply(await onHighlight(request));
    },
  }));
}

// Re-exported so a caller reaching for this entry point alone still has the
// refusal both highlights answer in. It is ``draw``'s, because "nothing was
// drawn, and here is why" carries no detail either surface needs to qualify.
export { notShown } from './draw';
export type { NotShown } from './draw';
