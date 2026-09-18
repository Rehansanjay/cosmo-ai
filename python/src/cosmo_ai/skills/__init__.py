"""Skills for the realtime SDK: SKILL.md files (the Agent Skills standard)
loaded just-in-time via a single ``cosmo_sdk_load_skill`` tool, with the skill
menu resident in the prompt.

Attach skills with the ``skills`` argument on :meth:`RealtimeClient.agent` — a
directory, or a list whose elements are directories and/or inline
:class:`Skill` objects. See :mod:`cosmo_ai.skills._engine` for the
directory-detection and error semantics.

:func:`parse_skill_md` turns a SKILL.md document you already hold into a
:class:`Skill` — for text that never touches a local directory, such as one
fetched over HTTP or read out of a database.
"""

from cosmo_ai.skills._engine import (
    Skill,
    SkillError,
    SkillErrorCode,
    SkillsInput,
    parse_skill_md,
)

__all__ = [
    "Skill",
    "SkillError",
    "SkillErrorCode",
    "SkillsInput",
    "parse_skill_md",
]
