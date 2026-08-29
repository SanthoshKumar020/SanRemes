"""Tests for the Nous-SanRemes-3/4 non-agentic warning detector.

Prior to this check, the warning fired on any model whose name contained
``"sanremes"`` anywhere (case-insensitive). That false-positived on unrelated
local Modelfiles such as ``sanremes-brain:qwen3-14b-ctx16k`` — a tool-capable
Qwen3 wrapper that happens to live under the "sanremes" tag namespace.

``is_nous_sanremes_non_agentic`` should only match the actual Nous Research
SanRemes-3 / SanRemes-4 chat family.
"""

from __future__ import annotations

import pytest

from sanremes_cli.model_switch import (
    _SANREMES_MODEL_WARNING,
    _check_sanremes_model_warning,
    is_nous_sanremes_non_agentic,
)


@pytest.mark.parametrize(
    "model_name",
    [
        "NousResearch/SanRemes-3-Llama-3.1-70B",
        "NousResearch/SanRemes-3-Llama-3.1-405B",
        "sanremes-3",
        "SanRemes-3",
        "sanremes-4",
        "sanremes-4-405b",
        "sanremes_4_70b",
        "openrouter/sanremes3:70b",
        "openrouter/nousresearch/sanremes-4-405b",
        "NousResearch/SanRemes3",
        "sanremes-3.1",
    ],
)
def test_matches_real_nous_sanremes_chat_models(model_name: str) -> None:
    assert is_nous_sanremes_non_agentic(model_name), (
        f"expected {model_name!r} to be flagged as Nous SanRemes 3/4"
    )
    assert _check_sanremes_model_warning(model_name) == _SANREMES_MODEL_WARNING


