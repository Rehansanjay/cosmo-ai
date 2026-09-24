import errno
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

# The SDK is unpublished (local-path installs only); make `cosmo_ai`
# importable without an editable install.
_SRC = Path(__file__).resolve().parents[1] / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))


@pytest.fixture(autouse=True)
def _pin_base_url(monkeypatch: pytest.MonkeyPatch) -> None:
    """Pin the SDK's base URL to a fixed test host so a developer's ambient
    ``COSMO_BASE_URL`` can't leak in and change the URLs the mock transports
    match on. Tests exercising base-URL resolution override this themselves."""
    monkeypatch.setenv("COSMO_BASE_URL", "https://api.test")


@pytest.fixture
def deny_read(monkeypatch: pytest.MonkeyPatch) -> Callable[[Path], None]:
    """Make a path unreadable, the way ``chmod(0o000)`` does on POSIX.

    ``chmod`` cannot deny reads on Windows, so the permission failure is
    raised from the ``pathlib`` calls the SDK guards instead. The paths
    denied are the target and anything beneath it, matching an unreadable
    directory."""

    def deny(blocked: Path) -> None:
        # chmod(0o000) on a file still lets stat succeed and fails the open;
        # on a directory it fails the traversal too. Mirror both.
        denied = ("read_text",) if blocked.is_file() else ("is_file", "is_dir", "iterdir", "read_text")

        def is_blocked(path: Path) -> bool:
            return path == blocked or blocked in path.parents

        for name in denied:
            real = getattr(Path, name)

            def guard(self: Path, *args: object, _real: Any = real, **kwargs: object) -> Any:
                if is_blocked(self):
                    raise PermissionError(errno.EACCES, "Permission denied", str(self))
                return _real(self, *args, **kwargs)

            monkeypatch.setattr(Path, name, guard)

    return deny
