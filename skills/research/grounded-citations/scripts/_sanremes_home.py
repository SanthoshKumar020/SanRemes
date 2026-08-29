"""Resolve SANREMES_HOME for standalone skill scripts.

Skill scripts may run outside the SanRemes process (system Python, nix env,
CI) where ``sanremes_constants`` is not importable.  This module provides the
same ``get_sanremes_home()`` contract without requiring it on ``sys.path``.

When ``sanremes_constants`` IS available it is used directly so profile
resolution and any future enhancements are picked up automatically.
"""

from __future__ import annotations

import os
from pathlib import Path

try:
    from sanremes_constants import get_sanremes_home as get_sanremes_home
except (ModuleNotFoundError, ImportError):

    def get_sanremes_home() -> Path:
        """Return the SanRemes home directory (default: ``~/.sanremes``)."""
        val = os.environ.get("SANREMES_HOME", "").strip()
        return Path(val) if val else Path.home() / ".sanremes"
