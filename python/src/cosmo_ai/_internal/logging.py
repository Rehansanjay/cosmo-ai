"""The SDK's logger factory — quiet unless the embedding app opts in.

structlog's unconfigured default renders straight to stdout, so a bare
``structlog.get_logger()`` in library code interleaves SDK diagnostics with the
app's own output the moment the SDK is imported. Libraries don't get to make
that choice for their callers, so every SDK logger binds to a stdlib logger
under the ``cosmo_ai`` namespace, which carries a :class:`~logging.NullHandler`
— nothing is emitted until the app attaches a handler and lowers the level::

    logging.basicConfig()
    logging.getLogger("cosmo_ai").setLevel(logging.INFO)

Only the *sink* is pinned. The processor chain still resolves through the
global structlog configuration, so an app that configures structlog renders SDK
logs in its own format, and ``structlog.testing.capture_logs`` still sees them.

``COSMO_LOG_LEVEL`` is the shortcut for a developer who wants that output
without editing the app: setting it to ``silent``/``error``/``warn``/``info``/
``debug`` attaches a stderr handler to the namespace at that level. It takes
the namespace over while set — the SDK's records stop propagating to the root
logger, so its output is one copy in one format rather than two.
"""

from __future__ import annotations

import logging
import os
import sys
from typing import cast

import structlog

NAMESPACE = "cosmo_ai"
LEVEL_ENV_VAR = "COSMO_LOG_LEVEL"

# Named for what the SDKs call these levels, not for stdlib's spelling, so one
# value works across all three. ``silent`` is above CRITICAL: nothing emits.
_LEVELS: dict[str, int] = {
    "silent": logging.CRITICAL + 1,
    "error": logging.ERROR,
    "warn": logging.WARNING,
    "warning": logging.WARNING,
    "info": logging.INFO,
    "debug": logging.DEBUG,
}

logging.getLogger(NAMESPACE).addHandler(logging.NullHandler())


def _apply_env_level() -> None:
    """Route the namespace to stderr when ``COSMO_LOG_LEVEL`` asks for it.

    An unrecognized value is ignored rather than fatal: a typo in a debugging
    env var must not stop the app from starting.
    """
    level = _LEVELS.get(os.environ.get(LEVEL_ENV_VAR, "").strip().lower())
    if level is None:
        return
    logger = logging.getLogger(NAMESPACE)
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("%(name)s %(levelname)s %(message)s"))
    logger.addHandler(handler)
    logger.setLevel(level)
    logger.propagate = False


_apply_env_level()


def get_logger(name: str) -> structlog.stdlib.BoundLogger:
    """A structlog logger writing through the stdlib logger named ``name``."""
    return cast(
        structlog.stdlib.BoundLogger,
        structlog.wrap_logger(
            logging.getLogger(name),
            wrapper_class=structlog.stdlib.BoundLogger,
        ),
    )
