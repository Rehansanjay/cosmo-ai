"""Constructors for the tools Cosmo's backend executes.

Each one opts the agent in; the server owns the model-facing declaration, so
none of them takes configuration. ``screen_locate_tool`` is the exception and
lives with the screen tools, because seeing the screen is its configuration.
"""

from __future__ import annotations

from cosmo_ai._internal.protocol import (
    AgentTool,
    DetectObjectsTool,
    EndCallTool,
    ExamineImageTool,
    PointAtObjectTool,
    SpeakerLogTool,
    WebSearchTool,
)


def web_search_tool() -> AgentTool:
    """Live web search."""
    return WebSearchTool()


def examine_image_tool() -> AgentTool:
    """Read the freshest published video frame at full resolution."""
    return ExamineImageTool()


def speaker_log_tool() -> AgentTool:
    """Read who said what from the room's speaker-labelled transcript."""
    return SpeakerLogTool()


def detect_objects_tool() -> AgentTool:
    """Locate a named object in the frame, returning one box per instance."""
    return DetectObjectsTool()


def point_at_object_tool() -> AgentTool:
    """Locate a named object in the frame, returning points."""
    return PointAtObjectTool()


def end_call_tool() -> AgentTool:
    """Let the agent hang up the call itself.

    Ending binds the call, not just the agent — every leg drops — and the
    spoken goodbye is allowed to finish first.
    """
    return EndCallTool()
