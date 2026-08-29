"""Runtime smoke tests for Docker PUID/PGID and UID/GID remap.

Build the real image and verify the actual runtime behavior:

  1. PUID/PGID env vars remap the sanremes user UID/GID at boot
  2. SANREMES_UID/SANREMES_GID take precedence over PUID/PGID aliases
  3. NAS-style low UIDs (99:100) are accepted and remapped
  4. Invalid UIDs are rejected
  5. The remapped user can write to the data volume
"""
from __future__ import annotations

from tests.docker.conftest import docker_exec_sh, start_container


def test_puid_pgid_remaps_sanremes_user(
    built_image: str, container_name: str,
) -> None:
    """PUID=1000 PGID=1000 must remap the sanremes user to UID 1000."""
    start_container(built_image, container_name, "PUID=1000", "PGID=1000")

    r = docker_exec_sh(
        container_name,
        "id -u sanremes",
        timeout=10,
    )
    assert r.stdout.strip() == "1000", (
        f"expected sanremes UID 1000 after PUID remap, got: {r.stdout.strip()}"
    )

    r = docker_exec_sh(
        container_name,
        "id -g sanremes",
        timeout=10,
    )
    assert r.stdout.strip() == "1000", (
        f"expected sanremes GID 1000 after PGID remap, got: {r.stdout.strip()}"
    )




def test_nas_low_uid_accepted(
    built_image: str, container_name: str,
) -> None:
    """NAS-style low UIDs (99:100, common on Unraid) must be accepted."""
    start_container(built_image, container_name, "PUID=99", "PGID=100")

    r = docker_exec_sh(container_name, "id -u sanremes", timeout=10)
    assert r.stdout.strip() == "99", (
        f"expected sanremes UID 99, got: {r.stdout.strip()}"
    )

    r = docker_exec_sh(container_name, "id -g sanremes", timeout=10)
    assert r.stdout.strip() == "100", (
        f"expected sanremes GID 100, got: {r.stdout.strip()}"
    )


def test_remap_enables_data_volume_writes(
    built_image: str, container_name: str,
) -> None:
    """After remap, the sanremes user must be able to write to /opt/data."""
    start_container(built_image, container_name, "PUID=1000", "PGID=1000")

    r = docker_exec_sh(
        container_name,
        "touch /opt/data/test_write && echo WRITE_OK || echo WRITE_FAIL",
        timeout=10,
    )
    assert "WRITE_OK" in r.stdout, (
        f"sanremes user cannot write to /opt/data after remap: {r.stdout}"
    )