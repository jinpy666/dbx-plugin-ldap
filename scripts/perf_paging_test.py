#!/usr/bin/env python3
"""Validate resumable LDAP search paging against a disposable local directory.

This is intentionally separate from ``smoke_container.py``: every invocation
creates its own temporary LDIF, cryptographically generated admin password,
random container name, and Docker-assigned loopback port.  It never reads a
directory URL or credential from the environment.

The sidecar hooks exercised here are the performance-search contract:

* ``ldap/search/start`` -> ``{searchId, entries, hasMore}``
* ``ldap/search/next``  -> ``{entries, hasMore}``
* ``ldap/search/cancel`` -> ``{success: true}``

Method names are overridable for a short-lived compatibility migration, but
the result shape remains deliberately strict so a partial result cannot pass
as a complete one.  Missing hooks are reported as SKIP by default; use
``LDAP_TEST_REQUIRE=1`` to make them failures (for an integration job).

Usage:
    python3 scripts/perf_paging_test.py
    LDAP_TEST_REQUIRE=1 python3 scripts/perf_paging_test.py
"""

from __future__ import annotations

import argparse
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sidecar_client_jsonl import (  # noqa: E402
    SidecarClient,
    SidecarError,
    default_binary,
    is_method_not_registered,
    lifecycle_params,
)

REPO = Path(__file__).resolve().parent.parent
IMAGE = "bitnamilegacy/openldap:2.6.10-debian-12-r4"
ROOT = "dc=perf,dc=test"
PEOPLE = f"ou=people,{ROOT}"
ENTRY_COUNT = 73
PAGE_SIZE = 17
READY_TIMEOUT_SECS = 90


class SkipTest(RuntimeError):
    """An optional local prerequisite or in-flight API hook is unavailable."""


def require_or_skip(message: str) -> None:
    if os.environ.get("LDAP_TEST_REQUIRE") == "1":
        raise AssertionError(message)
    raise SkipTest(message)


def docker(*args: str, check: bool = True, capture_output: bool = False) -> subprocess.CompletedProcess:
    """Run Docker without logging arguments (the admin password is an argument)."""
    return subprocess.run(
        ["docker", *args], check=check, capture_output=capture_output, text=True,
    )


def fixture_ldif() -> str:
    """Return a deterministic 73-entry directory, distinct enough to spot skips."""
    records = [
        "dn: dc=perf,dc=test\nobjectClass: top\nobjectClass: dcObject\nobjectClass: organization\no: Performance Test\ndc: perf\n",
        "dn: ou=people,dc=perf,dc=test\nobjectClass: organizationalUnit\nou: people\n",
    ]
    for number in range(ENTRY_COUNT):
        uid = f"page-{number:03d}"
        records.append(
            f"dn: uid={uid},{PEOPLE}\n"
            "objectClass: inetOrgPerson\n"
            f"cn: Paging {number:03d}\n"
            "sn: Paging\n"
            f"uid: {uid}\n"
        )
    return "\n".join(records) + "\n"


def expected_dns() -> set[str]:
    return {f"uid=page-{number:03d},{PEOPLE}".lower() for number in range(ENTRY_COUNT)}


def wait_for_ldap(container: str, password: str) -> None:
    deadline = time.monotonic() + READY_TIMEOUT_SECS
    probe = [
        "exec", container, "ldapsearch", "-x", "-H", "ldap://127.0.0.1:1389",
        "-D", f"cn=admin,{ROOT}", "-w", password, "-b", ROOT, "-s", "base",
        "(objectClass=*)", "1.1",
    ]
    while time.monotonic() < deadline:
        result = docker(*probe, check=False, capture_output=True)
        if result.returncode == 0:
            return
        time.sleep(1)
    raise AssertionError("disposable LDAP container did not accept its generated admin credential")


def start_container(ldif_dir: Path, password: str) -> tuple[str, int]:
    if shutil.which("docker") is None:
        require_or_skip("docker CLI not available")
    container = f"dbx-ldap-perf-{uuid.uuid4().hex[:12]}"
    docker(
        "run", "-d", "--rm", "--name", container,
        "-e", f"LDAP_ROOT={ROOT}",
        "-e", "LDAP_ADMIN_USERNAME=admin",
        "-e", f"LDAP_ADMIN_PASSWORD={password}",
        "-e", "LDAP_PORT_NUMBER=1389",
        "-e", "LDAP_CUSTOM_LDIF_DIR=/ldifs",
        "-v", f"{ldif_dir}:/ldifs:ro",
        "-p", "127.0.0.1::1389",
        IMAGE,
        capture_output=True,
    )
    try:
        wait_for_ldap(container, password)
        port = docker("port", container, "1389/tcp", capture_output=True).stdout.strip()
        # Docker returns exactly 127.0.0.1:NNNN for the explicit loopback mapping.
        host, sep, raw_port = port.rpartition(":")
        if not sep or host != "127.0.0.1" or not raw_port.isdigit():
            raise AssertionError(f"unexpected disposable LDAP port mapping: {port!r}")
        return container, int(raw_port)
    except Exception:
        docker("rm", "-f", container, check=False, capture_output=True)
        raise


def resolve_sidecar(temp_dir: Path) -> str:
    explicit = os.environ.get("DBX_PLUGIN_SIDECAR")
    if explicit:
        if not os.path.isfile(explicit):
            require_or_skip(f"DBX_PLUGIN_SIDECAR does not exist: {explicit}")
        return explicit
    candidate = REPO / default_binary()
    if candidate.is_file():
        return str(candidate)
    if shutil.which("go") is None:
        require_or_skip("sidecar binary missing and Go toolchain unavailable")
    binary = temp_dir / "dbx-plugin-ldap"
    result = subprocess.run(
        ["go", "build", "-trimpath", "-o", str(binary), "."],
        cwd=REPO / "backend", capture_output=True, text=True,
    )
    if result.returncode != 0:
        require_or_skip(f"could not build sidecar for paging test: {result.stderr.strip()}")
    return str(binary)


def make_connection(port: int, password: str) -> dict[str, Any]:
    return {
        "id": f"perf-paging-{uuid.uuid4().hex}",
        "name": "disposable performance paging fixture",
        "host": f"ldap://127.0.0.1:{port}",
        "port": port,
        "external_config": {
            "auth_type": "simple", "bind_dn": f"cn=admin,{ROOT}",
            "base_dn": ROOT, "timeout_secs": 10,
        },
        "connection_secrets": {"bind_password": password},
    }


def response_entries(response: dict[str, Any], phase: str) -> list[dict[str, Any]]:
    entries = response.get("entries")
    if not isinstance(entries, list) or not entries:
        raise AssertionError(f"{phase} must return a non-empty entries page: {response}")
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("dn"), str) or not entry["dn"].strip():
            raise AssertionError(f"{phase} returned an entry without a DN: {entry!r}")
    if len(entries) > PAGE_SIZE:
        raise AssertionError(f"{phase} returned {len(entries)} entries, above requested page size {PAGE_SIZE}")
    return entries


def assert_page_sequence(client: Any, connection_id: str, *, start_method: str, next_method: str,
                         cancel_method: str) -> None:
    """Assert the full durable sequence, including no duplicate or omitted DN."""
    start = client.request(start_method, {
        "connectionId": connection_id, "baseDn": PEOPLE, "scope": "one",
        "filter": "(uid=page-*)", "attributes": ["uid"], "pageSize": PAGE_SIZE,
    })
    search_id = start.get("searchId")
    if not isinstance(search_id, str) or not search_id.strip():
        raise AssertionError(f"search start must return non-empty searchId: {start}")

    seen: set[str] = set()
    phase = "start"
    response = start
    # 73 entries at 17/page requires five pages. This bound detects a bad
    # hasMore loop without allowing an accidental hung test.
    max_pages = (ENTRY_COUNT + PAGE_SIZE - 1) // PAGE_SIZE + 1
    try:
        for page_number in range(max_pages):
            entries = response_entries(response, phase)
            page_dns = {entry["dn"].strip().lower() for entry in entries}
            if len(page_dns) != len(entries):
                raise AssertionError(f"duplicate DN within {phase}: {entries!r}")
            overlap = seen & page_dns
            if overlap:
                raise AssertionError(f"duplicate DN across pages in {phase}: {sorted(overlap)!r}")
            seen.update(page_dns)

            has_more = response.get("hasMore")
            if not isinstance(has_more, bool):
                raise AssertionError(f"{phase} must return boolean hasMore: {response}")
            if not has_more:
                missing = expected_dns() - seen
                unexpected = seen - expected_dns()
                if missing or unexpected:
                    raise AssertionError(
                        f"paging result differs from fixture; missing={sorted(missing)!r}, "
                        f"unexpected={sorted(unexpected)!r}"
                    )
                break
            response = client.request(next_method, {"connectionId": connection_id, "searchId": search_id})
            phase = f"next page {page_number + 2}"
        else:
            raise AssertionError(f"hasMore remained true after {max_pages} pages")
    finally:
        cancelled = client.request(cancel_method, {"connectionId": connection_id, "searchId": search_id})
        if cancelled.get("success") is not True:
            raise AssertionError(f"search cancel must confirm success: {cancelled}")


def run(args: argparse.Namespace) -> None:
    with tempfile.TemporaryDirectory(prefix="dbx-ldap-perf-") as raw_temp:
        temp_dir = Path(raw_temp)
        ldif_dir = temp_dir / "ldifs"
        ldif_dir.mkdir()
        (ldif_dir / "01-perf-paging.ldif").write_text(fixture_ldif(), encoding="utf-8")
        password = secrets.token_urlsafe(30)
        sidecar = resolve_sidecar(temp_dir)
        container, port = start_container(ldif_dir, password)
        client: SidecarClient | None = None
        try:
            client = SidecarClient.start(sidecar, data_dir=str(temp_dir / "sidecar-data"))
            client.initialize()
            connection = make_connection(port, password)
            client.request("connection/connect", lifecycle_params(connection))
            assert_page_sequence(
                client, connection["id"], start_method=args.start_method,
                next_method=args.next_method, cancel_method=args.cancel_method,
            )
        finally:
            if client is not None:
                client.close()
            docker("rm", "-f", container, check=False, capture_output=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start-method", default="ldap/search/start")
    parser.add_argument("--next-method", default="ldap/search/next")
    parser.add_argument("--cancel-method", default="ldap/search/cancel")
    return parser.parse_args()


def main() -> int:
    try:
        run(parse_args())
    except SkipTest as cause:
        print(f"SKIP: {cause}")
        return 0
    except SidecarError as cause:
        if is_method_not_registered(cause) and os.environ.get("LDAP_TEST_REQUIRE") != "1":
            print(f"SKIP: resumable paging hooks are not registered yet: {cause}")
            return 0
        print(f"FAIL: {cause}", file=sys.stderr)
        return 1
    except (AssertionError, OSError, subprocess.SubprocessError) as cause:
        print(f"FAIL: {cause}", file=sys.stderr)
        return 1
    print(f"PASS: resumable paging returned all {ENTRY_COUNT} fixture entries exactly once")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
