"""Named bundles of existing inline-agent capabilities."""

from collections.abc import Sequence
from dataclasses import dataclass
from enum import Enum

from cosmo_ai._internal.hooks import Hook
from cosmo_ai._internal.protocol import AgentTool, ClientTool, ServerHook
from cosmo_ai.errors import RealtimeError
from cosmo_ai.skills import Skill


class PluginErrorCode(str, Enum):
    """The named contribution that conflicts during plugin composition."""

    DUPLICATE_PLUGIN_NAME = "duplicate_plugin_name"
    """Two plugins have the same name."""
    DUPLICATE_SKILL_NAME = "duplicate_skill_name"
    """Two contributions contain the same skill name."""
    DUPLICATE_TOOL_NAME = "duplicate_tool_name"
    """Two contributions contain the same client name or server-tool kind."""


class PluginError(RealtimeError, ValueError):
    """Plugin composition failed before a session was started."""

    code: PluginErrorCode
    """Machine-readable reason for the conflict."""
    message: str
    """Explanation identifying the conflicting contributions."""

    def __init__(self, *, code: PluginErrorCode, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(message)


@dataclass(frozen=True, kw_only=True)
class Plugin:
    """A named bundle of contributions to an inline agent."""

    name: str
    """Identity used to reject duplicate plugins and identify conflicts."""
    instructions: str | None = None
    """Always-present instructions, appended in plugin order."""
    skills: Sequence[Skill] = ()
    """Skills offered through the agent's existing skill loader."""
    tools: Sequence[AgentTool] = ()
    """Tools contributed to the agent."""
    hooks: Sequence[Hook | ServerHook] = ()
    """Hooks contributed in declaration order."""

    def __post_init__(self) -> None:
        object.__setattr__(self, "skills", tuple(self.skills))
        object.__setattr__(self, "tools", tuple(self.tools))
        object.__setattr__(self, "hooks", tuple(self.hooks))


def _resolve_plugins(plugins: Sequence[Plugin], direct: Plugin) -> Plugin:
    """Compose plugins in list order, then the direct agent contributions."""
    names: set[str] = set()
    skill_owners: dict[str, str] = {}
    tool_owners: dict[str, str] = {}
    instructions: list[str] = []
    skills: list[Skill] = []
    tools: list[AgentTool] = []
    hooks: list[Hook | ServerHook] = []

    def claim(
        owners: dict[str, str], name: str, owner: str, code: PluginErrorCode
    ) -> None:
        if name in owners:
            raise PluginError(
                code=code,
                message=f"{name}: conflict between {owners[name]} and {owner}",
            )
        owners[name] = owner

    for plugin in plugins:
        if plugin.name in names:
            raise PluginError(
                code=PluginErrorCode.DUPLICATE_PLUGIN_NAME,
                message=f"duplicate plugin name: {plugin.name}",
            )
        names.add(plugin.name)
    for bundle, owner in [
        *((p, f"plugin '{p.name}'") for p in plugins),
        (direct, "agent"),
    ]:
        if bundle.instructions:
            instructions.append(bundle.instructions)
        for skill in bundle.skills:
            claim(skill_owners, skill.name, owner, PluginErrorCode.DUPLICATE_SKILL_NAME)
            skills.append(skill)
        for tool in bundle.tools:
            key = (
                f"client:{tool.name}"
                if isinstance(tool, ClientTool)
                else f"server:{tool.kind}"
            )
            claim(tool_owners, key, owner, PluginErrorCode.DUPLICATE_TOOL_NAME)
            tools.append(tool)
        hooks.extend(bundle.hooks)
    return Plugin(
        name=direct.name,
        instructions="\n\n".join(instructions) if instructions else direct.instructions,
        skills=skills,
        tools=tools,
        hooks=hooks,
    )
