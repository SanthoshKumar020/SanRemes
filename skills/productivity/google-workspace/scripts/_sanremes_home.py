"""Resolve SANREMES_HOME for standalone skill scripts.

Skill scripts may run outside the SanRemes process (e.g. system Python,
nix env, CI) where ``sanremes_constants`` is not importable.  This module
provides the same ``get_sanremes_home()`` and ``display_sanremes_home()``
contracts as ``sanremes_constants`` without requiring it on ``sys.path``.

When ``sanremes_constants`` IS available it is used directly so that any
future enhancements (profile resolution, Docker detection, etc.) are
picked up automatically.  The fallback path replicates the core logic
from ``sanremes_constants.py`` using only the stdlib.

All scripts under ``google-workspace/scripts/`` should import from here
instead of duplicating the ``SANREMES_HOME = Path(os.getenv(...))`` pattern.
"""

from __future__ import annotations

import os
from pathlib import Path

try:
    from sanremes_constants import display_sanremes_home as display_sanremes_home
    from sanremes_constants import get_sanremes_home as get_sanremes_home
except (ModuleNotFoundError, ImportError):

    def get_sanremes_home() -> Path:
        """Return the SanRemes home directory (default: ~/.sanremes).

        Mirrors ``sanremes_constants.get_sanremes_home()``."""
        val = os.environ.get("SANREMES_HOME", "").strip()
        return Path(val) if val else Path.home() / ".sanremes"

    def display_sanremes_home() -> str:
        """Return a user-friendly ``~/``-shortened display string.

        Mirrors ``sanremes_constants.display_sanremes_home()``."""
        home = get_sanremes_home()
        try:
            return "~/" + home.relative_to(Path.home()).as_posix()
        except ValueError:
            return str(home)
