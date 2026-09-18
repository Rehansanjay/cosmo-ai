"""The public export surface: every name in ``__all__`` resolves, and the
tool-authoring layering (basics at the root, raw specs under ``cosmo_ai.tools``)
holds."""

from __future__ import annotations

import pytest

from cosmo_ai.errors import ToolDefinitionError

import cosmo_ai as cr
import cosmo_ai.tools as tools_mod
from cosmo_ai._internal.protocol import AgentTool, GeminiModel


def test_every_root_export_resolves() -> None:
    for name in cr.__all__:
        assert getattr(cr, name) is not None, name


def test_every_tools_export_resolves() -> None:
    for name in tools_mod.__all__:
        assert getattr(tools_mod, name) is not None, name


def test_agent_tool_is_exported_at_the_root() -> None:
    # It annotates the ``tools=`` parameter on ``RealtimeClient.agent`` /
    # ``catalog_agent`` and the ``RealtimeAgent`` dataclass, so a caller writing
    # ``list[AgentTool]`` has a supported import.
    assert "AgentTool" in cr.__all__
    assert cr.AgentTool is AgentTool


def test_wire_models_are_reachable_from_neither_barrel() -> None:
    # A tool is built by calling its constructor, so the model it lowers to is
    # machinery. Exporting it would be a second way to spell the same tool.
    for name in (
        "ClientTool",
        "BackgroundClientTool",
        "WebSearchTool",
        "ExamineImageTool",
        "DetectObjectsTool",
        "PointAtObjectTool",
        "EndCallTool",
        "ScreenLocateTool",
    ):
        assert name not in cr.__all__, name
        assert name not in tools_mod.__all__, name
    for name in ("ToolDefinitionError", "ToolInputValidationError"):
        assert name in tools_mod.__all__, name
        assert name not in cr.__all__, name


def test_raw_json_schema_authoring_stays_reachable() -> None:
    # The decorator derives its schema from a Pydantic model, so a schema no
    # model expresses is only reachable through these. Swift keeps
    # ``clientTool`` and TypeScript ``tool({parameters})`` for the same
    # reason; dropping the Python path would leave it alone without one.
    spec = tools_mod.client_tool(
        name="raw",
        description="hand-written schema",
        parameters={"type": "object", "properties": {"q": {"type": "string"}}},
        handler=lambda args: None,
    )
    assert spec.model_dump()["kind"] == "client"
    assert spec.model_dump()["parameters"]["properties"]["q"] == {"type": "string"}


@pytest.mark.parametrize(
    ("label", "kwargs"),
    [
        ("bad name", {"name": "Bad-Name", "description": "d", "parameters": {"type": "object"}}),
        ("empty description", {"name": "ok_tool", "description": "  ", "parameters": {"type": "object"}}),
        ("reserved prefix", {"name": "cosmo_sdk_x", "description": "d", "parameters": {"type": "object"}}),
        (
            "off-dialect schema",
            {
                "name": "ok_tool",
                "description": "d",
                "parameters": {
                    "type": "object",
                    "properties": {"x": {"type": "string", "pattern": "^A+$"}},
                },
            },
        ),
    ],
)
def test_raw_declarations_are_checked_at_construction(
    label: str, kwargs: dict[str, object]
) -> None:
    # The raw path exists so a declaration the server would refuse fails while
    # the caller is looking at it, not as a ready.rejected_tools entry at
    # connect. Constructing the model directly skips every one of these.
    async def handler(args: dict[str, object]) -> None:
        return None

    with pytest.raises((ValueError, ToolDefinitionError)):
        tools_mod.client_tool(handler=handler, **kwargs)  # type: ignore[arg-type]
    with pytest.raises((ValueError, ToolDefinitionError)):
        tools_mod.background_client_tool(handler=handler, **kwargs)  # type: ignore[arg-type]


def test_every_tool_constructor_returns_the_agent_tool_union() -> None:
    built = [
        cr.web_search_tool(),
        cr.examine_image_tool(),
        cr.detect_objects_tool(),
        cr.point_at_object_tool(),
        cr.end_call_tool(),
        cr.speaker_log_tool(),
        tools_mod.screen_locate_tool(lambda request: None),
        tools_mod.draw_box_tool(lambda request: None),
    ]
    assert [t.model_dump()["kind"] for t in built] == [
        "web_search",
        "examine_image",
        "detect_objects",
        "point_at_object",
        "end_call",
        "speaker_log",
        "screen_locate",
        "client",
    ]


@pytest.mark.parametrize(
    ("old", "new"),
    [("CosmoRealtime", "RealtimeClient"), ("Agent", "RealtimeAgent")],
)
def test_renamed_entry_points_are_gone_not_aliased(old: str, new: str) -> None:
    # A silent alias would let the old spelling live on in user code and docs;
    # this rename is a clean break, so the old name must not resolve at all.
    assert not hasattr(cr, old)
    assert old not in cr.__all__
    assert new in cr.__all__


@pytest.mark.parametrize(
    ("old", "new"),
    [
        ("GeminiModelOptions", "GeminiModel"),
        ("OpenAIModelOptions", "OpenAIModel"),
        ("OpenAIMiniModelOptions", "OpenAIMiniModel"),
        ("GrokModelOptions", "GrokModel"),
        ("RealtimeModelOptions", "RealtimeModelBlock"),
    ],
)
def test_renamed_model_blocks_are_gone_not_aliased(old: str, new: str) -> None:
    # The knobs block became the model itself, so the old spelling names a
    # concept the wire no longer has. An alias would keep it constructible
    # and land it on ``model_options``, which the server rejects.
    assert not hasattr(cr, old)
    assert hasattr(cr, new)


def test_model_block_is_not_a_separate_agent_parameter() -> None:
    # ``model_options`` merged into ``model``; passing it must fail where the
    # caller is looking, not as a server-side rejection at session start.
    client = cr.RealtimeClient(api_key="k")
    with pytest.raises(TypeError):
        client.agent(model="gemini", model_options=GeminiModel())  # type: ignore[call-arg]


def test_one_tool_union_not_two() -> None:
    # There used to be a plain union for annotations and a discriminated twin
    # for the wire. One name, one union: ``AgentTool`` is both.
    assert "AgentTool" in cr.__all__
    assert not hasattr(cr, "RealtimeToolSpec")
    assert AgentTool is not None
