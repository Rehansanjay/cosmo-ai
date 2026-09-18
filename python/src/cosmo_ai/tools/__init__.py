"""Tool authoring beyond the basics: the ``@tool`` decorator, the background
variant and its job handle, the construction-time schema error, and the
renderer client tools the SDK ships itself (:func:`draw_box_tool` /
:func:`draw_point_tool`).

Every tool is built by calling its constructor and every constructor returns
:data:`~cosmo_ai.AgentTool`, which is the only tool type a caller names."""

from cosmo_ai.errors import (
    ToolDefinitionError,
    ToolDefinitionErrorCode,
    ToolInputIssue,
    ToolInputValidationError,
)
from cosmo_ai.tools._server import (
    detect_objects_tool,
    end_call_tool,
    examine_image_tool,
    point_at_object_tool,
    speaker_log_tool,
    web_search_tool,
)
from cosmo_ai.tools._draw import (
    DRAW_BOX_TOOL_NAME,
    DRAW_POINT_TOOL_NAME,
    DrawBoxHandler,
    DrawBoxRequest,
    DrawOutcome,
    DrawPointHandler,
    DrawPointRequest,
    NormalizedBox,
    NormalizedPoint,
    draw_box_tool,
    draw_point_tool,
)
from cosmo_ai.tools._screen import (
    screen_click_element_tool,
    screen_highlight_box_tool,
    screen_highlight_element_tool,
    screen_locate_tool,
)
from cosmo_ai.tools._screen_capture import (
    SCREEN_CLICK_TOOL_NAME,
    SCREEN_HIGHLIGHT_BOX_TOOL_NAME,
    SCREEN_HIGHLIGHT_TOOL_NAME,
)
from cosmo_ai.tools._screen_types import (
    ScreenAffordance,
    ScreenBox,
    ScreenCapture,
    ScreenCaptureHandler,
    ScreenCaptureRequest,
    ScreenClickAction,
    ScreenClickButton,
    ScreenClickHandler,
    ScreenClickOutcome,
    ScreenClickTarget,
    ScreenElement,
    ScreenElementHint,
    ScreenHighlightBoxHandler,
    ScreenHighlightBoxRequest,
    ScreenHighlightHandler,
    ScreenHighlightOutcome,
    ScreenHighlightTarget,
    ScreenPlacement,
)
from cosmo_ai.tools._jobs import ClientToolJob
from cosmo_ai.tools._video_geometry import (
    Point,
    Rect,
    Size,
    VideoContentMode,
    box_rect,
    point_position,
)
from cosmo_ai.tools._decorator import background_client_tool, client_tool, tool

__all__ = [
    "ClientToolJob",
    "background_client_tool",
    "client_tool",
    "detect_objects_tool",
    "end_call_tool",
    "examine_image_tool",
    "point_at_object_tool",
    "speaker_log_tool",
    "web_search_tool",
    "DRAW_BOX_TOOL_NAME",
    "DRAW_POINT_TOOL_NAME",
    "DrawBoxHandler",
    "DrawBoxRequest",
    "DrawOutcome",
    "DrawPointHandler",
    "DrawPointRequest",
    "NormalizedBox",
    "NormalizedPoint",
    "Point",
    "Rect",
    "SCREEN_CLICK_TOOL_NAME",
    "SCREEN_HIGHLIGHT_BOX_TOOL_NAME",
    "SCREEN_HIGHLIGHT_TOOL_NAME",
    "ScreenAffordance",
    "ScreenBox",
    "ScreenCapture",
    "ScreenCaptureHandler",
    "ScreenCaptureRequest",
    "ScreenClickAction",
    "ScreenClickButton",
    "ScreenClickHandler",
    "ScreenClickOutcome",
    "ScreenClickTarget",
    "ScreenElement",
    "ScreenElementHint",
    "ScreenHighlightBoxHandler",
    "ScreenHighlightBoxRequest",
    "ScreenHighlightHandler",
    "ScreenHighlightOutcome",
    "ScreenHighlightTarget",
    "ScreenPlacement",
    "Size",
    "ToolInputIssue",
    "ToolInputValidationError",
    "ToolDefinitionError",
    "ToolDefinitionErrorCode",
    "VideoContentMode",
    "box_rect",
    "draw_box_tool",
    "draw_point_tool",
    "point_position",
    "screen_click_element_tool",
    "screen_highlight_box_tool",
    "screen_highlight_element_tool",
    "screen_locate_tool",
    "tool",
]
