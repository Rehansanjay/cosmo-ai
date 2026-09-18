"""The version the SDK reports is the version it was packaged as."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any

import pytest

import cosmo_ai
from cosmo_ai._internal.protocol import SDK_NAME, SDK_VERSION, SdkInfo, _sdk_info

if sys.version_info >= (3, 11):
    import tomllib
else:
    import tomli as tomllib

PYPROJECT = Path(__file__).resolve().parents[1] / "pyproject.toml"


@pytest.fixture(scope="module")
def manifest() -> dict[str, Any]:
    project: dict[str, Any] = tomllib.loads(PYPROJECT.read_text())["project"]
    return project


def test_version_matches_manifest(manifest: dict[str, Any]) -> None:
    assert SDK_VERSION == manifest["version"]


def test_name_matches_manifest(manifest: dict[str, Any]) -> None:
    """A rename that misses ``SDK_NAME`` would misattribute every request."""
    assert SDK_NAME == manifest["name"]


def test_version_module_loads_without_the_package(manifest: dict[str, Any]) -> None:
    """A vendored copy, a frozen bundle, or a source checkout has no
    distribution metadata and may have none of the dependencies imported. The
    version still has to be readable, so ``_version`` imports nothing."""
    path = Path(cosmo_ai.__file__).parent / "_version.py"
    spec = importlib.util.spec_from_file_location("cosmo_ai_version_only", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.__version__ == manifest["version"]


def test_identity_carries_the_version() -> None:
    assert _sdk_info() == SdkInfo(name=SDK_NAME, version=SDK_VERSION)
