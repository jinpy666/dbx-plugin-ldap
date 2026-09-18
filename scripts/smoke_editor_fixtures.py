#!/usr/bin/env python3
"""Smoke test for the editor-kind fixtures served by the DBX LDAP dev container.

Verifies the fixture data under ou=DevFixtures,dc=example,dc=org that the dev
container (docker-compose.ldap-dev.yml, 127.0.0.1:13890) seeds from
scripts/ldap-dev-seed/01-editor-fixtures.ldif: one scenario per value-editor
kind the workbench routes on, plus a one-shot write round-trip. Mirrors the
shape of scripts/smoke_test.py (scenario decorator, PASS/FAIL/SKIP table).

    F1  initialize + connection/test (simple)   -> success
    F2  DevFixtures subtree visible             -> uid=alice found
    F3  alice typed scalars                     -> bool/integer/OID/generalizedTime
                                                   literal/userAccountControl/pwdLastSet
    F4  alice DN reference + multi-values       -> dbxManager==bob; mail>=2; dbxMultiNote>=2
    F5  alice multiline description             -> decoded value contains a newline
    F6  default blocked-attributes policy       -> userPassword/objectGUID/objectSid never leak
    F7  alice guid/sid (policy override)        -> GUID decodes to 16 bytes; SID version byte == 1
    F8  alice password family (policy override) -> userPassword {SSHA} prefix; 32-hex NT hash shape
    F9  locked account                          -> userAccountControl 514; pwdLastSet 0
    F10 certuser certificate                    -> DER starts with 0x30 (SEQUENCE)
    F11 editors group                           -> member >= 3; owner == uid=alice DN
    F12 write round-trip uid=editsmoke          -> add/modify/read-back/delete/gone

Credentials red line: no password literal lives in this file. The bind
password is read from the environment only (LDAP_ADMIN_PASSWORD, falling back
to LDAP_TEST_BINDPW); when missing the whole suite SKIPs. Fixture credentials
in the seed LDIF are throwaway dev-container literals, never real secrets.

Usage:
    cd /Users/Jinpy/btroot/dbx-plugin-ldap
    set -a; source scripts/ldap-dev-seed/.env.dev; set +a
    export LDAP_ADMIN_PASSWORD="$LDAP_DEV_PASSWORD"
    export LDAP_TEST_HOST=127.0.0.1 LDAP_TEST_PORT=13890
    export LDAP_TEST_ROOT=dc=example,dc=org
    export LDAP_TEST_BINDDN="cn=admin,dc=example,dc=org"
    python3 scripts/smoke_editor_fixtures.py
"""

from __future__ import annotations

import base64
import os
import re
import socket
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sidecar_client_jsonl import (  # noqa: E402
    SidecarClient,
    SidecarError,
    default_binary,
    is_method_not_registered,
    lifecycle_params,
)

HOST = os.environ.get("LDAP_TEST_HOST", "127.0.0.1")
PORT = int(os.environ.get("LDAP_TEST_PORT", "13890"))
ROOT = os.environ.get("LDAP_TEST_ROOT", "dc=example,dc=org")
BIND_DN = os.environ.get("LDAP_TEST_BINDDN", "cn=admin,dc=example,dc=org")
# Never hardcode a password: the dev seed keeps the throwaway value in
# scripts/ldap-dev-seed/.env.dev as LDAP_DEV_PASSWORD and the documented run
# command re-exports it as LDAP_ADMIN_PASSWORD (see module docstring).
BIND_PW = os.environ.get("LDAP_ADMIN_PASSWORD") or os.environ.get("LDAP_TEST_BINDPW", "")
REQUIRE = os.environ.get("LDAP_TEST_REQUIRE", "") == "1"

DEV_OU = f"ou=DevFixtures,{ROOT}"
ALICE_DN = f"uid=alice,{DEV_OU}"
BOB_DN = f"uid=bob,{DEV_OU}"
LOCKED_DN = f"uid=locked,{DEV_OU}"
CERT_DN = f"uid=certuser,{DEV_OU}"
GROUP_DN = f"cn=editors,{DEV_OU}"
EDIT_DN = f"uid=editsmoke,{DEV_OU}"

# connection.host: the smokes keep exercising the legacy full-URL form the
# same way scripts/smoke_test.py does (backend passes it through).
URL = f"ldap://{HOST}:{PORT}"

# Transient contention markers that justify a single 3s-later retry (parallel
# smokes sharing one dev container occasionally collide on slapd).
CONFLICT_MARKERS = ("busy", "conflict", "locked", "in use", "concurrent", "temporarily")


class SkipScenario(Exception):
    """Raised by a scenario itself when a precondition is unavailable."""


class ScenarioResult:
    def __init__(self, no: str, name: str, status: str, detail: str = ""):
        self.no = no
        self.name = name
        self.status = status
        self.detail = detail


RESULTS: list[ScenarioResult] = []


def scenario(no: str, name: str):
    def decorate(fn):
        def run(*args, **kwargs):
            try:
                note = fn(*args, **kwargs)
            except SkipScenario as cause:
                RESULTS.append(ScenarioResult(no, name, "SKIP", str(cause)))
            except (SidecarError, AssertionError) as cause:
                if is_method_not_registered(cause):
                    RESULTS.append(ScenarioResult(no, name, "SKIP", f"backend not implemented: {cause}"))
                else:
                    RESULTS.append(ScenarioResult(no, name, "FAIL", str(cause)))
            except Exception as cause:  # unexpected crash counts as FAIL
                RESULTS.append(ScenarioResult(no, name, "FAIL", f"unexpected: {cause}"))
            else:
                RESULTS.append(ScenarioResult(no, name, "PASS", note or ""))
        return run
    return decorate


# -- helpers -------------------------------------------------------------------

def domain(client: SidecarClient, method: str, params: dict) -> dict:
    """Domain call bound to the last connected connection, with one retry after
    3 seconds on transient contention (safe: a failed first attempt leaves the
    directory untouched)."""
    payload = dict(params)
    payload.setdefault("connectionId", CURRENT_CONNECTION["id"])
    try:
        return client.request(method, payload)
    except SidecarError as cause:
        text = str(cause).lower()
        if any(marker in text for marker in CONFLICT_MARKERS):
            time.sleep(3)
            return client.request(method, payload)
        raise


CURRENT_CONNECTION = {"id": ""}


def connect(client: SidecarClient, connection: dict) -> None:
    CURRENT_CONNECTION["id"] = connection["id"]
    client.request("connection/connect", lifecycle_params(connection))


def make_connection(connection_id: str, **extra_config) -> dict:
    external = {
        "auth_type": "simple",
        "bind_dn": BIND_DN,
        "base_dn": ROOT,
        "timeout_secs": 10,
    }
    external.update(extra_config)
    return {
        "id": connection_id,
        "name": f"smoke-{connection_id}",
        "host": URL,
        "port": PORT,
        "external_config": external,
        "connection_secrets": {"bind_password": BIND_PW},
    }


def search(client: SidecarClient, **params) -> dict:
    payload = {"filter": "(objectClass=*)", "scope": "sub"}
    payload.update(params)
    return domain(client, "ldap/search", payload)


def fetch_entry(client: SidecarClient, dn: str) -> dict:
    """ldap/entry/get -> attributes dict (never raises on missing entry)."""
    try:
        fetched = domain(client, "ldap/entry/get", {"dn": dn})
    except SidecarError:
        return {}
    return fetched.get("entry", {}).get("attributes", {}) or {}


def entry_exists(client: SidecarClient, dn: str) -> bool:
    try:
        search(client, baseDn=dn, scope="base", sizeLimit=1)
        return True
    except SidecarError:
        return False


def attr_key(name: str) -> str:
    """Attribute name normalization: lowercase + strip ';binary' options, the
    same shape the backend applies for its binary-value predicate."""
    key = name.lower().strip()
    return key.split(";", 1)[0]


def attr_values(attributes: dict, name: str) -> list[str]:
    wanted = attr_key(name)
    for candidate, values in attributes.items():
        if attr_key(candidate) == wanted:
            return list(values)
    return []


def one_value(attributes: dict, name: str) -> str:
    values = attr_values(attributes, name)
    if len(values) != 1:
        raise AssertionError(f"{name}: expected exactly one value, got {values!r}")
    return values[0]


def b64_bytes(value: str) -> bytes:
    """Binary attributes travel base64-encoded on the read path (backend
    ldapEntryToType); decode with a latin-1 passthrough fallback for raw-byte
    transports."""
    try:
        return base64.b64decode(value, validate=True)
    except Exception:
        return value.encode("latin-1")


# -- scenarios -----------------------------------------------------------------

STRICT = {"id": "fx-strict"}   # default blocked_attributes policy
OPEN = {"id": "fx-open"}       # blocked_attributes overridden: guid/sid/passwords readable


@scenario("F1", "initialize + connection/test (simple)")
def run_f1(client: SidecarClient) -> None:
    """F1 initialize + connection/test (simple) -> success."""
    info = client.initialize()
    if not info:
        raise AssertionError("plugin/initialize returned no result")
    result = client.request("connection/test", lifecycle_params(make_connection("fx-test")))
    if result.get("success") is not True:
        raise AssertionError(f"connection/test did not succeed: {result}")


@scenario("F2", "DevFixtures subtree visible -> uid=alice found")
def run_f2(client: SidecarClient) -> None:
    """F2 sub search under ou=DevFixtures finds the seeded uid=alice."""
    connect(client, make_connection(STRICT["id"]))
    result = search(client, baseDn=DEV_OU, scope="sub")
    dns = [entry.get("dn", "") for entry in result.get("entries", [])]
    if not dns:
        raise AssertionError(f"no entries under {DEV_OU} — fixtures not seeded?")
    if ALICE_DN not in dns:
        raise AssertionError(f"{ALICE_DN} missing; subtree returned {dns}")


@scenario("F3", "alice typed scalars (bool/int/OID/time/uac/filetime)")
def run_f3(client: SidecarClient) -> None:
    """F3 scalar kinds: boolean TRUE, integer 42, OID, generalizedTime literal,
    userAccountControl 512, pwdLastSet filetime 133900000000000000."""
    connect(client, make_connection(STRICT["id"]))
    attributes = fetch_entry(client, ALICE_DN)
    if not attributes:
        raise AssertionError(f"entry not found: {ALICE_DN}")
    expected = {
        "dbxIsActive": "TRUE",
        "dbxScore": "42",
        "dbxControlOid": "2.16.840.1.113730.3.4.2",
        "dbxLastSync": "20260918093000Z",
        "userAccountControl": "512",
        "pwdLastSet": "133900000000000000",
    }
    for name, wanted in expected.items():
        got = one_value(attributes, name)
        if got != wanted:
            raise AssertionError(f"{name}: got {got!r}, want {wanted!r}")


@scenario("F4", "alice DN reference + multi-values")
def run_f4(client: SidecarClient) -> None:
    """F4 dbxManager points at uid=bob (DN single-value); mail and dbxMultiNote
    carry at least two values each."""
    connect(client, make_connection(STRICT["id"]))
    attributes = fetch_entry(client, ALICE_DN)
    if not attributes:
        raise AssertionError(f"entry not found: {ALICE_DN}")
    if one_value(attributes, "dbxManager") != BOB_DN:
        raise AssertionError(f"dbxManager: got {one_value(attributes, 'dbxManager')!r}, want {BOB_DN!r}")
    for name in ("mail", "dbxMultiNote"):
        count = len(attr_values(attributes, name))
        if count < 2:
            raise AssertionError(f"{name}: expected >= 2 values, got {count}")


@scenario("F5", "alice multiline description contains a newline")
def run_f5(client: SidecarClient) -> None:
    """F5 description seeded as an LDIF base64 multi-line value must decode to
    text containing a newline (read path returns valid UTF-8 verbatim)."""
    connect(client, make_connection(STRICT["id"]))
    attributes = fetch_entry(client, ALICE_DN)
    raw = one_value(attributes, "description")
    text = raw
    if "\n" not in text:
        try:  # tolerate a base64-carrying transport
            text = base64.b64decode(raw).decode("utf-8", errors="replace")
        except Exception:
            pass
    if "\n" not in text:
        raise AssertionError(f"description has no newline after decode: {raw!r}")


@scenario("F6", "default blocked-attributes policy keeps secrets out of reads")
def run_f6(client: SidecarClient) -> None:
    """F6 with the default policy, userPassword/objectGUID/objectSid never
    appear in search or get results (S7 semantics over the fixture entries)."""
    connect(client, make_connection(STRICT["id"]))
    blocked = ("userpassword", "objectguid", "objectsid")
    checks: list[tuple[str, dict]] = [
        ("ldap/entry/get", fetch_entry(client, ALICE_DN)),
    ]
    if not checks[0][1]:
        raise AssertionError(f"entry not found: {ALICE_DN}")
    entries = search(client, baseDn=DEV_OU, scope="one").get("entries", [])
    if not entries:
        raise AssertionError(f"one-scope search under {DEV_OU} returned no entries")
    for entry in entries:
        checks.append(("ldap/search", entry.get("attributes", {})))
    for method, attributes in checks:
        for name in attributes:
            if attr_key(name) in blocked:
                raise AssertionError(f"blocked attribute {name} leaked via {method}")


@scenario("F7", "alice guid/sid bytes (policy override)")
def run_f7(client: SidecarClient) -> None:
    """F7 with blocked_attributes overridden, objectGUID base64-decodes to 16
    bytes and the objectSid first byte (revision) is 1."""
    connect(client, make_connection(OPEN["id"], blocked_attributes=["token"]))
    attributes = fetch_entry(client, ALICE_DN)
    if not attributes:
        raise AssertionError(f"entry not found: {ALICE_DN}")
    guid = b64_bytes(one_value(attributes, "objectGUID"))
    if len(guid) != 16:
        raise AssertionError(f"objectGUID: expected 16 decoded bytes, got {len(guid)}")
    sid = b64_bytes(one_value(attributes, "objectSid"))
    if not sid or sid[0] != 1:
        raise AssertionError(f"objectSid: revision byte {sid[:1].hex() if sid else '<empty>'}, want 01")


@scenario("F8", "alice password family (policy override)")
def run_f8(client: SidecarClient) -> None:
    """F8 userPassword keeps its {SSHA} hash prefix and sambaNTPassword matches
    the 32-hex NT-hash shape. Values are shape-checked only; never printed."""
    connect(client, make_connection(OPEN["id"], blocked_attributes=["token"]))
    attributes = fetch_entry(client, ALICE_DN)
    if not attributes:
        raise AssertionError(f"entry not found: {ALICE_DN}")
    user_password = one_value(attributes, "userPassword")
    if not user_password.startswith("{SSHA}"):
        raise AssertionError("userPassword: expected a {SSHA}-prefixed value")
    nt_hash = one_value(attributes, "sambaNTPassword")
    if not re.fullmatch(r"[0-9a-fA-F]{32}", nt_hash):
        raise AssertionError("sambaNTPassword: expected a 32-hex value")


@scenario("F9", "locked account scalars")
def run_f9(client: SidecarClient) -> None:
    """F9 uid=locked carries userAccountControl 514 and pwdLastSet 0."""
    connect(client, make_connection(STRICT["id"]))
    attributes = fetch_entry(client, LOCKED_DN)
    if not attributes:
        raise AssertionError(f"entry not found: {LOCKED_DN}")
    if one_value(attributes, "userAccountControl") != "514":
        raise AssertionError(f"userAccountControl: got {one_value(attributes, 'userAccountControl')!r}, want 514")
    if one_value(attributes, "pwdLastSet") != "0":
        raise AssertionError(f"pwdLastSet: got {one_value(attributes, 'pwdLastSet')!r}, want 0")


@scenario("F10", "certuser DER certificate starts with SEQUENCE")
def run_f10(client: SidecarClient) -> None:
    """F10 userCertificate;binary base64-decodes to a DER blob whose first byte
    is 0x30 (ASN.1 SEQUENCE)."""
    connect(client, make_connection(STRICT["id"]))
    attributes = fetch_entry(client, CERT_DN)
    if not attributes:
        raise AssertionError(f"entry not found: {CERT_DN}")
    der = b64_bytes(one_value(attributes, "userCertificate"))
    if not der or der[0] != 0x30:
        raise AssertionError(f"userCertificate: first byte {der[:1].hex() if der else '<empty>'}, want 30")


@scenario("F11", "editors group members + owner")
def run_f11(client: SidecarClient) -> None:
    """F11 cn=editors carries >= 3 member DNs and owner == uid=alice."""
    connect(client, make_connection(STRICT["id"]))
    attributes = fetch_entry(client, GROUP_DN)
    if not attributes:
        raise AssertionError(f"entry not found: {GROUP_DN}")
    members = attr_values(attributes, "member")
    if len(members) < 3:
        raise AssertionError(f"member: expected >= 3 values, got {len(members)}: {members}")
    if one_value(attributes, "owner") != ALICE_DN:
        raise AssertionError(f"owner: got {one_value(attributes, 'owner')!r}, want {ALICE_DN!r}")


@scenario("F12", "write round-trip uid=editsmoke")
def run_f12(client: SidecarClient) -> None:
    """F12 one-shot write round-trip: create a throwaway inetOrgPerson +
    dbxTestAccount entry, write dbxScore=7 / dbxIsActive=TRUE via entry/modify,
    read both back, delete the entry and confirm it is gone."""
    connect(client, make_connection(OPEN["id"], blocked_attributes=["token"]))
    try:  # clear residue from an aborted earlier run
        if entry_exists(client, EDIT_DN):
            domain(client, "ldap/entry/delete", {"dn": EDIT_DN})
    except SidecarError:
        pass
    domain(client,
        "ldap/entry/add",
        {
            "dn": EDIT_DN,
            "attributes": {
                "objectClass": ["top", "person", "inetOrgPerson", "dbxTestAccount"],
                "uid": ["editsmoke"],
                "cn": ["Edit Smoke"],
                "sn": ["Smoke"],
            },
        },
    )
    try:
        domain(client,
            "ldap/entry/modify",
            {
                "dn": EDIT_DN,
                "changes": [
                    {"operation": "add", "attribute": "dbxScore", "values": ["7"]},
                    {"operation": "add", "attribute": "dbxIsActive", "values": ["TRUE"]},
                ],
            },
        )
        attributes = fetch_entry(client, EDIT_DN)
        if not attributes:
            raise AssertionError(f"entry not found after write: {EDIT_DN}")
        if one_value(attributes, "dbxScore") != "7":
            raise AssertionError(f"dbxScore read-back: {one_value(attributes, 'dbxScore')!r}, want '7'")
        if one_value(attributes, "dbxIsActive") != "TRUE":
            raise AssertionError(f"dbxIsActive read-back: {one_value(attributes, 'dbxIsActive')!r}, want 'TRUE'")
    finally:
        try:
            domain(client, "ldap/entry/delete", {"dn": EDIT_DN})
        except SidecarError:
            pass
    if entry_exists(client, EDIT_DN):
        raise AssertionError(f"throwaway entry survived delete: {EDIT_DN}")


# -- driver --------------------------------------------------------------------

def ldap_reachable() -> tuple[bool, str]:
    try:
        with socket.create_connection((HOST, PORT), timeout=2.0):
            return True, ""
    except OSError as cause:
        return False, f"no LDAP server at {HOST}:{PORT} ({cause})"


STEPS = [
    ("F1", "initialize + connection/test (simple)", run_f1),
    ("F2", "DevFixtures subtree visible -> alice found", run_f2),
    ("F3", "alice typed scalars (bool/int/OID/time/uac/filetime)", run_f3),
    ("F4", "alice DN reference + multi-values", run_f4),
    ("F5", "alice multiline description contains a newline", run_f5),
    ("F6", "default blocked-attributes policy keeps secrets out", run_f6),
    ("F7", "alice guid/sid bytes (policy override)", run_f7),
    ("F8", "alice password family (policy override)", run_f8),
    ("F9", "locked account scalars", run_f9),
    ("F10", "certuser DER certificate starts with SEQUENCE", run_f10),
    ("F11", "editors group members + owner", run_f11),
    ("F12", "write round-trip uid=editsmoke", run_f12),
]


def skip_all(reason: str) -> None:
    for no, name, _ in STEPS:
        RESULTS.append(ScenarioResult(no, name, "FAIL" if REQUIRE else "SKIP", reason))


def main() -> int:
    if not BIND_PW:
        skip_all("bind password not provided: set LDAP_ADMIN_PASSWORD (or LDAP_TEST_BINDPW)")
        report()
        return 0

    ok, reason = ldap_reachable()
    if not ok:
        skip_all(reason)
        report()
        return 0

    binary = default_binary()
    if not os.path.exists(binary):
        skip_all(f"sidecar binary not found: {binary} (set DBX_PLUGIN_SIDECAR)")
        report()
        return 0

    client = SidecarClient.start()
    try:
        try:
            client.initialize()
        except (SidecarError, AssertionError) as cause:
            skip_all(f"plugin/initialize failed: {cause}")
            report()
            return 0
        for _, _, fn in STEPS:
            fn(client)
    finally:
        for connection_id in (STRICT["id"], OPEN["id"]):
            try:
                client.request("connection/disconnect", {"connection": {"id": connection_id}})
            except Exception:
                pass
        try:
            client.close()
        except Exception:
            pass

    report()
    return 1 if any(result.status == "FAIL" for result in RESULTS) else 0


def report() -> None:
    widths = (4, 52, 6)
    print(f"{'No.':<{widths[0]}} {'Scenario':<{widths[1]}} {'Status':<{widths[2]}} Detail")
    for result in RESULTS:
        print(f"{result.no:<{widths[0]}} {result.name:<{widths[1]}} {result.status:<{widths[2]}} {result.detail}")
    counts = {status: sum(1 for r in RESULTS if r.status == status) for status in ("PASS", "FAIL", "SKIP")}
    print(f"\ntotal={len(RESULTS)} PASS={counts['PASS']} FAIL={counts['FAIL']} SKIP={counts['SKIP']}")


if __name__ == "__main__":
    raise SystemExit(main())
