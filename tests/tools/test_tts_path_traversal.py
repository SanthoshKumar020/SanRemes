"""Regression: text_to_speech_tool output_path must reject '..' traversal.

The TTS surface accepts agent/user-supplied absolute paths (writing to a
chosen file is the whole point). What it must reject is paths that use
``..`` components to escape their declared base — those are almost
always either a bug or prompt-injection-controlled
(e.g. ``output_path="audio/../../etc/cron.d/x"``).
"""

import json

from tools.tts_tool import text_to_speech_tool


def test_output_path_rejects_traversal_escape():
    """A path with '..' components must be rejected before any provider work."""
    result = json.loads(text_to_speech_tool(
        text="hello",
        output_path="audio/../../etc/cron.d/malicious",
    ))
    assert result["success"] is False
    assert "traversal" in result["error"].lower()


def test_output_path_rejects_bare_dotdot():
    """Bare '..' prefix must be rejected."""
    result = json.loads(text_to_speech_tool(
        text="hello",
        output_path="../escape.mp3",
    ))
    assert result["success"] is False
    assert "traversal" in result["error"].lower()


def test_output_path_rejects_sanremes_oauth_store(tmp_path, monkeypatch):
    """TTS output_path must not bypass the shared protected-file write guard."""
    import agent.file_safety as file_safety

    sanremes_home = tmp_path / "sanremes-home"
    sanremes_home.mkdir()
    monkeypatch.setattr(file_safety, "_sanremes_home_path", lambda: sanremes_home)
    monkeypatch.setattr(file_safety, "_sanremes_root_path", lambda: sanremes_home)

    target = sanremes_home / ".anthropic_oauth.json"
    result = json.loads(text_to_speech_tool(
        text="hello",
        output_path=str(target),
    ))

    assert result["success"] is False
    assert "protected credential" in result["error"]
    assert not target.exists()


def test_output_path_rejects_mcp_token_directory(tmp_path, monkeypatch):
    """TTS output_path must not write synthesized audio over MCP token files."""
    import agent.file_safety as file_safety

    sanremes_home = tmp_path / "sanremes-home"
    token_dir = sanremes_home / "mcp-tokens"
    token_dir.mkdir(parents=True)
    monkeypatch.setattr(file_safety, "_sanremes_home_path", lambda: sanremes_home)
    monkeypatch.setattr(file_safety, "_sanremes_root_path", lambda: sanremes_home)

    target = token_dir / "server.mp3"
    result = json.loads(text_to_speech_tool(
        text="hello",
        output_path=str(target),
    ))

    assert result["success"] is False
    assert "protected credential" in result["error"]
    assert not target.exists()
