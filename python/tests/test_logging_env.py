"""``COSMO_LOG_LEVEL`` routes the SDK namespace to stderr."""

from __future__ import annotations

import importlib
import logging
import sys
from typing import Iterator

import pytest

from cosmo_ai._internal import logging as sdk_logging


@pytest.fixture(autouse=True)
def restore_namespace() -> Iterator[None]:
    """Reimporting the module mutates a process-global logger, so put the
    namespace back the way the rest of the suite expects it."""
    logger = logging.getLogger(sdk_logging.NAMESPACE)
    handlers = list(logger.handlers)
    level, propagate = logger.level, logger.propagate
    try:
        yield
    finally:
        logger.handlers = handlers
        logger.setLevel(level)
        logger.propagate = propagate


def _reload(monkeypatch: pytest.MonkeyPatch, value: str | None) -> None:
    logger = logging.getLogger(sdk_logging.NAMESPACE)
    logger.handlers = []
    logger.setLevel(logging.NOTSET)
    logger.propagate = True
    if value is None:
        monkeypatch.delenv(sdk_logging.LEVEL_ENV_VAR, raising=False)
    else:
        monkeypatch.setenv(sdk_logging.LEVEL_ENV_VAR, value)
    importlib.reload(sdk_logging)


def test_unset_leaves_the_namespace_quiet(monkeypatch: pytest.MonkeyPatch) -> None:
    _reload(monkeypatch, None)

    logger = logging.getLogger(sdk_logging.NAMESPACE)
    assert logger.level == logging.NOTSET
    assert logger.propagate is True
    assert all(isinstance(h, logging.NullHandler) for h in logger.handlers)


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("debug", logging.DEBUG),
        ("INFO", logging.INFO),
        ("  warn ", logging.WARNING),
        ("error", logging.ERROR),
        ("silent", logging.CRITICAL + 1),
    ],
)
def test_it_sets_the_namespace_level(
    monkeypatch: pytest.MonkeyPatch, value: str, expected: int
) -> None:
    _reload(monkeypatch, value)

    assert logging.getLogger(sdk_logging.NAMESPACE).level == expected


def test_a_value_that_is_not_a_level_is_ignored(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _reload(monkeypatch, "verbose")

    logger = logging.getLogger(sdk_logging.NAMESPACE)
    assert logger.level == logging.NOTSET
    assert logger.propagate is True


def test_records_reach_stderr_and_stop_propagating(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    _reload(monkeypatch, "debug")

    logger = logging.getLogger(sdk_logging.NAMESPACE)
    assert logger.propagate is False
    stream_handlers = [
        h
        for h in logger.handlers
        if isinstance(h, logging.StreamHandler) and h.stream is sys.stderr
    ]
    assert len(stream_handlers) == 1

    sdk_logging.get_logger(f"{sdk_logging.NAMESPACE}.session").debug("connect timings")

    assert "connect timings" in capsys.readouterr().err
