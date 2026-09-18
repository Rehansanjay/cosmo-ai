"""The vocabulary the screen tools are built from: the captures a host produces,
the handles and boxes the model hands back, the targets a handler acts on, and
the outcomes it reports. Every other ``_screen*`` module speaks in these types,
so they live on their own with no dependency on the schemas, decoding, capture
plumbing, or factories that consume them — the base of the dependency tree.

Names, wording, and shapes here are cross-SDK contract, pinned by
``sdk-client-tool-vectors.json``.
"""

from __future__ import annotations

import inspect
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Literal, TypeVar, Union

_T = TypeVar("_T")


async def _resolved(value: _T | Awaitable[_T]) -> _T:
    if inspect.isawaitable(value):
        return await value
    return value


SCREEN_PLACEMENTS: tuple[str, ...] = ("auto", "top", "bottom", "left", "right")
"""The ``ScreenPlacement`` values as a runtime tuple, for validation."""

ScreenPlacement = Literal["auto", "top", "bottom", "left", "right"]
"""Which side of the target the tooltip sits on; ``auto`` picks the side with
the most room."""

SCREEN_AFFORDANCES: tuple[str, ...] = (
    "pointer",
    "click",
    "double_click",
    "left_click",
    "right_click",
    "drag_show",
    "press_hold",
    "inform",
)
"""The ``ScreenAffordance`` values as a runtime tuple, for validation."""

ScreenAffordance = Literal[
    "pointer",
    "click",
    "double_click",
    "left_click",
    "right_click",
    "drag_show",
    "press_hold",
    "inform",
]
"""Which glyph the highlight draws — the action being asked of the user. A
highlight never acts on the user's behalf; see :class:`ScreenClickAction`."""

ScreenClickButton = Literal["left", "right"]
"""Which button/gesture to click with: ``left`` is a left click on desktop / tap
on touch; ``right`` a right click / long-press."""


# ─────────────────────────────────────────────────────────────────────────────
# Capture inputs — what the host's handler produces
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ScreenElement:
    """One interactive on-screen element the locator may pick. ``index`` is
    0-based and contiguous within one :class:`ScreenCapture`; ``frame`` is
    ``(x, y, w, h)`` in the platform's screen coordinates."""

    index: int
    """Position in this capture's element list, 0-based and contiguous. The
    model refers to an element by this."""
    role: str
    """What kind of control it is, in the platform's own vocabulary — e.g.
    ``button``, ``textfield``."""
    frame: tuple[float, float, float, float]
    """``(x, y, width, height)`` in the platform's screen coordinates."""
    title: str | None = None
    """Its visible title, when it has one."""
    label: str | None = None
    """Its accessibility label, when it has one."""
    value: str | None = None
    """Its current value — the text in a field, a control's setting."""


@dataclass(frozen=True)
class ScreenCaptureRequest:
    """The capture being asked for. It carries no options today; any future
    capture option lands here, inside the parameter every handler already
    accepts."""


@dataclass(frozen=True)
class ScreenCapture:
    """A snapshot the locator works from: the JPEG image plus the pickable
    elements. ``context`` is opaque per-capture state the handler may stash and
    read back at click time to validate freshness (e.g. the frontmost-app
    identity); the SDK never inspects it."""

    image_jpeg: bytes
    """The screenshot the model reasons over, JPEG-encoded."""
    elements: Sequence[ScreenElement] = field(default_factory=tuple)
    """The elements it may pick from. Empty when the capture did not gather
    them."""
    context: object | None = None
    """Opaque state you may stash and read back at click time — the SDK never
    inspects it. Use it to check the capture is still current, e.g. that the
    same app is still frontmost."""


# ─────────────────────────────────────────────────────────────────────────────
# Handles, boxes, and hints — what the model hands a renderer
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class FoundElement:
    """The two halves of a ``found_element`` handle, split back out: the capture
    an element was found in and its index there. Internal — a renderer's handler
    receives the resolved :class:`ScreenElement`, never these parts, so nothing
    downstream can address an element the locator did not pick. The index means
    nothing beside any other capture, so the two always travel together."""

    capture_id: str
    element_idx: int


@dataclass(frozen=True)
class ScreenBox:
    """A rectangle the model located itself, as fractions of the shared surface:
    ``x``/``y`` are the top-left corner (0 = left/top), all four in ``0..1``.

    Deliberately not reusing :class:`ScreenElement.frame`, which is the same
    shape in platform screen coordinates — the two spaces are not
    interchangeable, and mixing them draws a marker in the top-left one percent
    of the screen."""

    x: float
    """Left edge, ``0``–``1`` across the shared surface."""
    y: float
    """Top edge, ``0``–``1`` down the shared surface."""
    width: float
    """Width as a fraction of the surface's width."""
    height: float
    """Height as a fraction of the surface's height."""


@dataclass(frozen=True)
class ScreenElementHint:
    """What the model believes the target is *called*, alongside where it thinks
    it is. A handler with a platform accessibility tree can ask the OS for that
    control's exact frame; one without a usable tree ignores this and falls back
    to the region. ``title`` is the control's own visible text ("Files
    changed"), not the tooltip; ``role`` disambiguates a repeated title."""

    title: str
    """What the model believes the target is called — its visible text, not
    the tooltip."""
    role: str | None = None
    """The kind of control, to disambiguate a repeated title."""


@dataclass(frozen=True)
class ScreenClickAction:
    """How to click the located element: which button/gesture, and whether it's
    a double. Button and double are orthogonal axes rather than a flat enum."""

    button: ScreenClickButton
    """Which button or gesture to use."""
    double: bool
    """Whether it is a double click. Orthogonal to ``button``."""


# ─────────────────────────────────────────────────────────────────────────────
# Decoded requests — the boundary check on model output
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ScreenClickRequest:
    """A decoded ``cosmo_sdk_screen_click_element`` call, before the handle is
    resolved."""

    found_element: str
    button: ScreenClickButton
    double: bool


@dataclass(frozen=True)
class ScreenHighlightRequest:
    """A decoded ``cosmo_sdk_screen_highlight_element`` call, before the handle
    is resolved."""

    found_element: str
    label: str
    placement: ScreenPlacement
    interaction: ScreenAffordance


@dataclass(frozen=True)
class ScreenHighlightBoxRequest:
    """A decoded ``cosmo_sdk_screen_highlight_box`` call. The model gave a box
    instead of a handle, so there is nothing to resolve — the handler draws it
    directly. ``element_guess`` is a bonus signal, never a requirement; most apps
    expose no usable label."""

    box: ScreenBox
    """Where the model believes the target is."""
    label: str
    """Tooltip text to show beside the highlight."""
    placement: ScreenPlacement
    """Which side of the target the tooltip sits on."""
    interaction: ScreenAffordance
    """Which glyph to draw — the action being asked of the user."""
    element_guess: ScreenElementHint | None = None
    """What the model thinks the target is called, when it can guess. A bonus
    signal for snapping the box onto a real control — never a requirement,
    and ``None`` on most apps."""


# ─────────────────────────────────────────────────────────────────────────────
# Targets — what a ref-taking renderer's handler is asked to act on
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ScreenClickTarget:
    """What a click handler is asked to do: the element the handle resolved to,
    the capture it was picked from, and how to click it."""

    element: ScreenElement
    """The element the handle resolved to."""
    capture: ScreenCapture
    """The capture it was picked from — check ``context`` if you need to
    confirm the screen has not moved on."""
    action: ScreenClickAction
    """Which button, and whether it is a double."""


@dataclass(frozen=True)
class ScreenHighlightTarget:
    """What a highlight handler is asked to do, for a handle the locator minted."""

    element: ScreenElement
    """The element to highlight."""
    capture: ScreenCapture
    """The capture it was picked from."""
    label: str
    """Tooltip text to show beside the highlight."""
    placement: ScreenPlacement
    """Which side of the element the tooltip sits on."""
    interaction: ScreenAffordance
    """Which glyph to draw — the action being asked of the user."""


# ─────────────────────────────────────────────────────────────────────────────
# Outcomes — what a handler reports back to the model
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ScreenClickOutcome:
    """What a click handler reports back to the model.

    Clicking can fail for reasons the model has to hear about — the user stopped
    sharing, the window moved, accessibility access is off. Answering
    ``clicked=True`` regardless would leave it narrating something that never
    happened, so a refusal carries a ``reason`` the agent can say out loud
    ("the window moved — locate it again"), not an error code."""

    clicked: bool
    """Whether the click actually happened."""
    reason: str | None = None
    """Why it did not, when ``clicked`` is ``False`` — model-facing prose the
    agent says out loud, not an error code."""


@dataclass(frozen=True)
class ScreenHighlightOutcome:
    """What either highlight reports back to the model — the mark is showing, but
    is it *on* the thing?

    Shared by :func:`screen_highlight_element_tool` and :func:`screen_highlight_box_tool`
    so the model reads the same field whichever it called. A handler that
    resolved the target to a real control answers ``exact=True``; one that could
    only draw where the model estimated answers ``exact=False``, the model's cue
    to re-target through the locator. From a grounded handle the answer is always
    ``exact=True`` — the locator picked it out of a real accessibility list.

    A refusal carries the same model-facing ``reason`` contract as
    :class:`ScreenClickOutcome`: prose the agent says out loud ("the user stopped
    sharing their screen"), not an error code."""

    shown: bool
    """Whether the highlight is now visible."""
    exact: bool = False
    """Whether it landed on a real resolved control (``True``) or only where
    the model estimated (``False``) — the model's cue to re-target through
    the locator. Always ``True`` from a grounded handle."""
    reason: str | None = None
    """Why nothing is showing, when ``shown`` is ``False`` — model-facing
    prose the agent says out loud, not an error code."""


# ─────────────────────────────────────────────────────────────────────────────
# Handler type aliases (the host-facing surface)
# ─────────────────────────────────────────────────────────────────────────────


ScreenCaptureHandler = Callable[
    [ScreenCaptureRequest], Union[ScreenCapture, Awaitable[ScreenCapture]]
]
"""Snapshot the shared screen: ``(request) -> ScreenCapture``, sync or async.
Raising (or returning no elements) surfaces to the model as an inability to
see the screen — the raised message reaches the model as the locator's
reason."""

ScreenClickHandler = Callable[
    [ScreenClickTarget], Union[ScreenClickOutcome, Awaitable[ScreenClickOutcome]]
]
"""Your click renderer: ``(target) -> outcome``, sync or async."""

ScreenHighlightHandler = Callable[
    [ScreenHighlightTarget],
    Union[ScreenHighlightOutcome, Awaitable[ScreenHighlightOutcome]],
]
"""Your element-highlight renderer: ``(target) -> outcome``, sync or async.
Reports through the :class:`ScreenHighlightOutcome` both highlights share."""

ScreenHighlightBoxHandler = Callable[
    [ScreenHighlightBoxRequest],
    Union[ScreenHighlightOutcome, Awaitable[ScreenHighlightOutcome]],
]
"""Your box-highlight renderer: ``(request) -> outcome``, sync or async."""
