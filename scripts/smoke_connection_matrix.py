#!/usr/bin/env python3
"""Connection-form smoke matrix for the dbx-ldap-plugin sidecar (M1-M11).

覆盖「连接表单的 加密方式 (tls_mode) × 认证方式 (auth_type)」组合矩阵，
针对本地 OpenLDAP dev 容器 dbx-ldap-dev（docker-compose.ldap-dev.yml）：
明文+StartTLS 在 127.0.0.1:13890，LDAPS 在 127.0.0.1:13936，自签证书
CN=localhost / SAN DNS:localhost,IP:127.0.0.1。参数形状对齐
scripts/smoke_test.py 的 make_connection 与 scripts/smoke_auth_test.py 的
T/A 场景（结构化 host+tls_mode 与 legacy URL+use_starttls 双形状）。

矩阵与每格期望依据：

    M1  tls_mode=none + simple         -> connection/test 成功 + base search 成功
        (结构化三字段 host/port/tls_mode 主链路，smoke_test S1/S2 形状)
    M2  tls_mode=none + anonymous      -> 成功且可匿名搜索
        (OpenLDAP 默认允许匿名读；manifest auth_type=anonymous 不下发 bind 密钥)
    M3  ldap:// URL + use_starttls     -> 成功
        (legacy URL 形状的 StartTLS 升级链路，smoke_auth_test T3)
    M4  ldaps:// + simple + tls_verify=false -> 成功 + search
        (InsecureSkipVerify 接受自签证书，smoke_auth_test T1)
    M5  ldaps:// + tls_verify=true     -> 预期失败，且错误是证书类
        (校验默认开启；自签证书必须报 x509/certificate 类错误而非拨号错，T4)
    M6  unauthenticated 语义：bind_dn + 空密码 -> 拒绝，错误属凭据/策略类
        (RFC 4513 §5.1.2；OpenLDAP 默认禁止 unauthenticated bind，服务器默认
         策略，观察记录 ldap-code，见 docs/PROGRESS-XC M3 节)
    M7  digest_md5                     -> 绑定成功 或 服务器无该 SASL 机制均算 PASS
        (bitnami OpenLDAP 默认不带 cyrus-sasl digest-md5 模块，mech 缺失
         也是有效观察，判定对齐 smoke_auth_test A2)
    M8  ntlm / ntlm_hash               -> 参数面正确、真绑定被服务器拒绝
        (缺 hash 必须报参数错 "ntlmHash is required"；带 hash 后 OpenLDAP 无
         NTLMSSP 机制报 bind 错而非参数错/桩错，判定对齐 A3/A4)
    M9  kerberos                       -> 无配置时干净配置错误（无 KDC）
        (报 kerberos 配置缺失而非 M1 桩错；dead-KDC 内联配置报 AS_REQ 网络错，A5)
    M10 external (SASL EXTERNAL) over TCP -> 预期失败（无 TLS 客户端证书），
        记录错误码 (真实 bind 路径被服务器拒绝，A1)
    M11 同一 sidecar 实例挂 3 个不同配置连接交替 search
        (none+simple / ldaps+simple / starttls+anonymous；验证连接注册表隔离
         与 connectionId 切换，每次都能取回正确的 base 条目)

运行（全部凭据来自环境，脚本零密码字面量）：
    cd /Users/Jinpy/btroot/dbx-plugin-ldap
    set -a; source scripts/ldap-dev-seed/.env.dev; set +a
    export LDAP_ADMIN_PASSWORD="$LDAP_DEV_PASSWORD"
    export LDAP_TEST_HOST=127.0.0.1 LDAP_TEST_PORT=13890 LDAP_TEST_LDAPS_PORT=13936
    export LDAP_TEST_ROOT=dc=example,dc=org
    export LDAP_TEST_BINDDN="cn=admin,dc=example,dc=org"
    python3 scripts/smoke_connection_matrix.py

环境变量：
    LDAP_ADMIN_PASSWORD / LDAP_TEST_BINDPW  admin 绑定密码（必填，前者优先）
    LDAP_TEST_HOST / LDAP_TEST_PORT / LDAP_TEST_LDAPS_PORT / LDAP_TEST_ROOT /
    LDAP_TEST_BINDDN                        目标服务器（缺省见下方常量）
    LDAP_TEST_REQUIRE=1                     环境 SKIP 升级为 FAIL（CI 用）

失败重试：仅当场景以「偶发网络类错误」失败时等待 3 秒重试一次。

SKIP 语义（M0 §5.2）：容器不可达 / sidecar 缺失 -> 整组 SKIP；
方法未实现 (-32601) -> 单场景 SKIP，不误报 FAIL。
"""

from __future__ import annotations

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
LDAPS_PORT = int(os.environ.get("LDAP_TEST_LDAPS_PORT", "13936"))
ROOT = os.environ.get("LDAP_TEST_ROOT", "dc=example,dc=org")
BIND_DN = os.environ.get("LDAP_TEST_BINDDN", f"cn=admin,{ROOT}")
REQUIRE = os.environ.get("LDAP_TEST_REQUIRE", "") == "1"

M3_STUB = "planned for m3"
TRANSIENT_MARKERS = (
    "connection refused", "connection reset", "broken pipe", "i/o timeout",
    "no route", "eof", "temporarily unavailable", "timed out",
)
CERT_MARKERS = ("certificate", "x509", "verify", "authority", "handshake")
DIAL_ONLY_MARKERS = ("connection refused", "no route", "i/o timeout", "broken pipe")
CREDENTIAL_CLASS_MARKERS = ("invalid credential", "invalidcredentials", "unwilling",
                            "inappropriate", "credential")
SASL_MECH_CLASS_MARKERS = ("authmethod", "auth method", "not supported", "unwilling",
                           "inappropriate", "sasl", "no secret in database")
# 凭据/策略类 LDAP 结果码：49 invalidCredentials、53 unwillingToPerform（策略拒绝）。
CREDENTIAL_LDAP_CODES = {"49", "53"}


class SkipScenario(Exception):
    """Raised by a scenario itself when a precondition is unavailable."""


class ScenarioResult:
    def __init__(self, no: str, name: str, status: str, detail: str = ""):
        self.no = no
        self.name = name
        self.status = status
        self.detail = detail


RESULTS: list[ScenarioResult] = []


def _attempt(fn, args, kwargs) -> ScenarioResult:
    try:
        note = fn(*args, **kwargs)
    except SkipScenario as cause:
        return ScenarioResult("", "", "SKIP", str(cause))
    except (SidecarError, AssertionError) as cause:
        if is_method_not_registered(cause):
            return ScenarioResult("", "", "SKIP", f"backend not implemented: {cause}")
        return ScenarioResult("", "", "FAIL", str(cause))
    except Exception as cause:  # unexpected crash counts as FAIL
        return ScenarioResult("", "", "FAIL", f"unexpected: {cause}")
    return ScenarioResult("", "", "PASS", note or "")


def scenario(no: str, name: str):
    """Register a matrix cell; retry once after 3s on transient network failures."""
    def decorate(fn):
        def run(*args, **kwargs):
            result = _attempt(fn, args, kwargs)
            result.no, result.name = no, name
            lowered = result.detail.lower()
            if result.status == "FAIL" and any(marker in lowered for marker in TRANSIENT_MARKERS):
                time.sleep(3)
                retry = _attempt(fn, args, kwargs)
                retry.no, retry.name = no, name
                retry.detail = (
                    f"[transient, recovered on 3s retry] {retry.detail}" if retry.status == "PASS"
                    else f"[transient retry failed again] {retry.detail}"
                )
                result = retry
            RESULTS.append(result)
        return run
    return decorate


# -- helpers -------------------------------------------------------------------

def expect_error(fn) -> SidecarError:
    """Run fn expecting a SidecarError (cells that must reject)."""
    try:
        fn()
    except SidecarError as cause:
        return cause
    raise AssertionError("expected the sidecar to reject this call but it succeeded")


def assert_not_m3_stub(cause: SidecarError) -> None:
    if M3_STUB in str(cause).lower():
        raise AssertionError(f"backend still answers with the M1-era stub: {cause}")


def ldap_code_of(err: SidecarError) -> str:
    """Extract the '[ldap-code=N]' prefix the backend prefixes onto LDAP errors."""
    match = re.search(r"\[ldap-code=(\d+)\]", str(err))
    return match.group(1) if match else ""


def describe(err: SidecarError) -> str:
    code = ldap_code_of(err)
    return f"code={err.code}" + (f" ldap-code={code}" if code else "") + f" msg={err}"[:160]


def make_connection(connection_id: str, url: str, *, port: int | None = None,
                    structured_tls_mode: str | None = None,
                    extra_secrets: dict | None = None,
                    **external_config) -> dict:
    """Connection payload in the manifest binding shape (config -> external_config,
    secret -> connection_secrets). url may be a legacy ldap(s):// URL or a bare
    hostname; structured_tls_mode fills external_config.tls_mode for the v0.1.19
    three-field form. bind_dn/bind_password/base_dn default to the admin bind;
    port defaults to LDAPS_PORT for ldaps:// URLs and PORT otherwise."""
    external = {
        "auth_type": "simple",
        "bind_dn": BIND_DN,
        "base_dn": ROOT,
        "timeout_secs": 10,
    }
    external.update(external_config)
    if structured_tls_mode is not None:
        external["tls_mode"] = structured_tls_mode
    secrets: dict = {}
    if external["auth_type"] in ("simple", "ntlm", "digest_md5"):
        secrets["bind_password"] = ADMIN_PW
    secrets.update(extra_secrets or {})
    return {
        "id": connection_id,
        "name": f"smoke-{connection_id}",
        "host": url,
        "port": port or (LDAPS_PORT if url.startswith("ldaps://") else PORT),
        "external_config": external,
        "connection_secrets": secrets,
    }


CURRENT_CONNECTION = {"id": ""}


def connect(client: SidecarClient, connection: dict) -> None:
    CURRENT_CONNECTION["id"] = connection["id"]
    client.request("connection/connect", lifecycle_params(connection))


def search(client: SidecarClient, connection_id: str | None = None, **params) -> dict:
    payload = {"filter": "(objectClass=*)", "scope": "base", "baseDn": ROOT}
    payload.update(params)
    payload["connectionId"] = connection_id or CURRENT_CONNECTION["id"]
    return client.request("ldap/search", payload)


def base_entry_dn(client: SidecarClient, connection_id: str | None = None) -> str:
    """Base-scope search on ROOT -> the root entry DN (must equal ROOT)."""
    result = search(client, connection_id=connection_id)
    entries = result.get("entries", [])
    if len(entries) != 1:
        raise AssertionError(f"base-scope search returned {len(entries)} entries, want 1: {result}")
    return str(entries[0].get("dn", ""))


def assert_root_entry(dn: str, connection_id: str) -> None:
    if dn.lower() != ROOT.lower():
        raise AssertionError(f"connection {connection_id} returned wrong base entry {dn}, want {ROOT}")


# -- matrix cells (M) ----------------------------------------------------------

@scenario("M1", "tls_mode=none + simple: test + search")
def run_m1(client: SidecarClient) -> None:
    """M1 structured three-field form (host/port/tls_mode=none), simple bind:
    connection/test succeeds, connect + base search returns the root entry."""
    connection = make_connection("smoke-mx-none-simple", HOST, port=PORT, structured_tls_mode="none")
    result = client.request("connection/test", lifecycle_params(connection))
    if result.get("success") is not True:
        raise AssertionError(f"connection/test failed: {result}")
    connect(client, connection)
    assert_root_entry(base_entry_dn(client), connection["id"])


@scenario("M2", "tls_mode=none + anonymous: searchable")
def run_m2(client: SidecarClient) -> str | None:
    """M2 anonymous bind over plain ldap: test + anonymous base search succeed
    (OpenLDAP default allows anonymous reads)."""
    connection = make_connection("smoke-mx-anon", HOST, port=PORT, structured_tls_mode="none",
                                 auth_type="anonymous")
    connection["external_config"].pop("bind_dn", None)  # anonymous carries no DN/secret
    result = client.request("connection/test", lifecycle_params(connection))
    if result.get("success") is not True:
        raise AssertionError(f"anonymous connection/test failed: {result}")
    connect(client, connection)
    dn = base_entry_dn(client)
    assert_root_entry(dn, connection["id"])
    return f"anonymous read allowed by server default (got base entry {dn})"


@scenario("M3", "ldap:// URL + use_starttls: test + search")
def run_m3(client: SidecarClient) -> None:
    """M3 legacy URL shape: StartTLS upgrade on the plain port with the
    self-signed cert accepted via tls_verify=false (T3 shape)."""
    connection = make_connection("smoke-mx-starttls", f"ldap://{HOST}:{PORT}",
                                 tls_verify=False, use_starttls=True)
    result = client.request("connection/test", lifecycle_params(connection))
    if result.get("success") is not True:
        raise AssertionError(f"StartTLS connection/test failed: {result}")
    connect(client, connection)
    assert_root_entry(base_entry_dn(client), connection["id"])


@scenario("M4", "ldaps:// + tls_verify=false: test + search")
def run_m4(client: SidecarClient) -> None:
    """M4 LDAPS with verification off accepts the self-signed chain (T1 shape)."""
    connection = make_connection("smoke-mx-ldaps", f"ldaps://{HOST}:{LDAPS_PORT}",
                                 tls_verify=False)
    result = client.request("connection/test", lifecycle_params(connection))
    if result.get("success") is not True:
        raise AssertionError(f"ldaps connection/test failed: {result}")
    connect(client, connection)
    assert_root_entry(base_entry_dn(client), connection["id"])


@scenario("M5", "ldaps:// + tls_verify=true rejected (cert error)")
def run_m5(client: SidecarClient) -> str | None:
    """M5 verification stays on: self-signed chain must fail with a certificate-
    class error (x509/verify), not a plain dial/network error (T4 shape)."""
    connection = make_connection("smoke-mx-ldaps-strict", f"ldaps://{HOST}:{LDAPS_PORT}",
                                 tls_verify=True)
    cause = expect_error(lambda: client.request("connection/test", lifecycle_params(connection)))
    lowered = str(cause).lower()
    if not any(marker in lowered for marker in CERT_MARKERS):
        raise AssertionError(f"expected a TLS certificate-class failure, got: {cause}")
    if any(marker in lowered for marker in DIAL_ONLY_MARKERS):
        raise AssertionError(f"failure is a dial error, not a certificate error: {cause}")
    return f"self-signed rejected as expected ({describe(cause)})"


@scenario("M6", "unauthenticated bind (DN + empty password) rejected")
def run_m6(client: SidecarClient) -> str | None:
    """M6 RFC 4513 §5.1.2 unauthenticated bind semantics: a DN with no password
    must be refused with a credential/policy-class error (ldap-code 49/53 or
    equivalent wording). OpenLDAP disallows it by default — recorded here as
    the server default policy, not a plugin defect."""
    connection = {
        "id": "smoke-mx-unauth",
        "name": "smoke-mx-unauth",
        "host": HOST,
        "port": PORT,
        "external_config": {
            "auth_type": "unauthenticated",
            "bind_dn": BIND_DN,
            "base_dn": ROOT,
            "tls_mode": "none",
            "timeout_secs": 10,
        },
        "connection_secrets": {},  # intentionally empty: the DN is sent with no password
    }
    cause = expect_error(lambda: client.request("connection/test", lifecycle_params(connection)))
    code = ldap_code_of(cause)
    lowered = str(cause).lower()
    if code not in CREDENTIAL_LDAP_CODES and not any(marker in lowered for marker in CREDENTIAL_CLASS_MARKERS):
        raise AssertionError(f"expected a credential/policy-class rejection, got: {cause}")
    return f"rejected per server default policy ({describe(cause)}) — OpenLDAP forbids unauthenticated bind"


@scenario("M7", "digest_md5: bind or mech-missing (both PASS)")
def run_m7(client: SidecarClient) -> str | None:
    """M7 DIGEST-MD5 per A2 semantics: a real bind success PASSes; when the
    container lacks the cyrus-sasl digest-md5 module the server answers an
    auth-method/mech-unavailable error, which is also a valid observation."""
    connection = make_connection("smoke-mx-digest", f"ldap://{HOST}:{PORT}",
                                 auth_type="digest_md5", username=BIND_DN)
    try:
        result = client.request("connection/test", lifecycle_params(connection))
    except SidecarError as cause:
        assert_not_m3_stub(cause)
        lowered = str(cause).lower()
        if any(marker in lowered for marker in SASL_MECH_CLASS_MARKERS):
            return f"server cannot serve DIGEST-MD5 (mech class error, accepted) ({describe(cause)})"
        raise AssertionError(f"DIGEST-MD5 failed with an unexpected error class: {cause}")
    if result.get("success") is not True:
        raise AssertionError(f"digest_md5 connection/test returned no success: {result}")
    return "DIGEST-MD5 bind succeeded (server ships the SASL mech)"


@scenario("M8", "ntlm / ntlm_hash: param surface + real bind rejected")
def run_m8(client: SidecarClient) -> str | None:
    """M8 per A3/A4: (a) ntlm with username+domain reaches a server bind
    rejection (no NTLMSSP on OpenLDAP), never a param/stub error; (b) ntlm_hash
    without a hash fails parameter validation ('ntlmHash is required'); (c)
    ntlm_hash with a hash also reaches the bind rejection."""
    url = f"ldap://{HOST}:{PORT}"
    cause = expect_error(lambda: client.request("connection/test", lifecycle_params(
        make_connection("smoke-mx-ntlm", url, auth_type="ntlm", username="admin", domain="example.org"),
    )))
    assert_not_m3_stub(cause)
    if "username or binddn is required" in str(cause).lower():
        raise AssertionError(f"NTLM param surface regressed: {cause}")
    ntlm_detail = describe(cause)

    cause = expect_error(lambda: client.request("connection/test", lifecycle_params(
        make_connection("smoke-mx-ntlmhash-empty", url, auth_type="ntlm_hash", username="admin"),
    )))
    if "ntlmhash is required" not in str(cause).lower():
        raise AssertionError(f"missing-hash case should fail parameter validation, got: {cause}")
    cause = expect_error(lambda: client.request("connection/test", lifecycle_params(
        make_connection("smoke-mx-ntlmhash", url, auth_type="ntlm_hash", username="admin",
                        domain="example.org", extra_secrets={"ntlm_hash": os.urandom(16).hex()}),
    )))
    assert_not_m3_stub(cause)
    if "username or binddn is required" in str(cause).lower() or "ntlmhash is required" in str(cause).lower():
        raise AssertionError(f"NTLM hash param surface regressed: {cause}")
    return f"ntlm bind rejected: {ntlm_detail}; ntlm_hash param gate ok, bind rejected: {describe(cause)}"


@scenario("M9", "kerberos: clean config error (no KDC)")
def run_m9(client: SidecarClient) -> str | None:
    """M9 per A5: (a) without realm/kdc/krb5.conf the bind fails with a clean
    kerberos config error; (b) inline realm+KDC pointing at a dead port fails
    with a KDC/AS_REQ network error — both prove the real gokrb5 path."""
    url = f"ldap://{HOST}:{PORT}"
    cause = expect_error(lambda: client.request("connection/test", lifecycle_params(
        make_connection("smoke-mx-krb-nocfg", url, auth_type="kerberos", username="admin"),
    )))
    assert_not_m3_stub(cause)
    if "kerberos" not in str(cause).lower():
        raise AssertionError(f"expected a kerberos config error, got: {cause}")
    no_cfg_detail = describe(cause)

    cause = expect_error(lambda: client.request("connection/test", lifecycle_params(
        make_connection("smoke-mx-krb-deadkdc", url,
                        extra_secrets={"krb_password": os.urandom(16).hex()},
                        auth_type="kerberos", username="admin",
                        krb_credential_type="password", krb_realm="EXAMPLE.ORG",
                        krb_kdc_host="127.0.0.1", krb_kdc_port=18688),
    )))
    assert_not_m3_stub(cause)
    lowered = str(cause).lower()
    if not any(marker in lowered for marker in ("kdc", "as_req", "connection", "refused", "tcp", "timeout")):
        raise AssertionError(f"expected a KDC network error, got: {cause}")
    return f"no-config: {no_cfg_detail}; dead-KDC: {describe(cause)}"


@scenario("M10", "external over TCP rejected (no client cert)")
def run_m10(client: SidecarClient) -> str | None:
    """M10 SASL EXTERNAL over plain TCP: no TLS client certificate is available,
    so the server must refuse the bind (A1 shape). The observed error code is
    the record; only the M1 stub would be a regression."""
    connection = make_connection("smoke-mx-external", f"ldap://{HOST}:{PORT}", auth_type="external")
    cause = expect_error(lambda: client.request("connection/test", lifecycle_params(connection)))
    assert_not_m3_stub(cause)
    return f"external bind refused as expected ({describe(cause)})"


@scenario("M11", "3 connections, alternating searches (isolation)")
def run_m11(client: SidecarClient) -> None:
    """M11 one sidecar instance holds three differently-configured connections
    (none+simple / ldaps+simple / starttls+anonymous); repeated switching via
    connectionId must route each search to the right bound session and return
    the correct base entry every time."""
    matrix_none = make_connection("smoke-mx-iso-none", HOST, port=PORT, structured_tls_mode="none")
    matrix_ldaps = make_connection(f"ldaps://{HOST}:{LDAPS_PORT}", f"ldaps://{HOST}:{LDAPS_PORT}",
                                   tls_verify=False)
    matrix_starttls_anon = make_connection(f"ldap://{HOST}:{PORT}", f"ldap://{HOST}:{PORT}",
                                           tls_verify=False, use_starttls=True, auth_type="anonymous")
    matrix_starttls_anon["external_config"].pop("bind_dn", None)
    for connection in (matrix_none, matrix_ldaps, matrix_starttls_anon):
        connect(client, connection)
    # interleave: A B C A B C — every leg must answer from its own connection
    for round_index in range(2):
        for connection in (matrix_none, matrix_ldaps, matrix_starttls_anon):
            dn = base_entry_dn(client, connection_id=connection["id"])
            assert_root_entry(dn, connection["id"])
    return "6 alternating searches across 3 live connections all returned the correct base entry"


# -- driver --------------------------------------------------------------------

STEPS = [
    ("M1", "none + simple: test + search", run_m1),
    ("M2", "none + anonymous: searchable", run_m2),
    ("M3", "ldap:// URL + use_starttls", run_m3),
    ("M4", "ldaps:// + tls_verify=false", run_m4),
    ("M5", "ldaps:// + tls_verify=true (cert rejected)", run_m5),
    ("M6", "unauthenticated bind rejected (server default)", run_m6),
    ("M7", "digest_md5 (bind or mech-missing)", run_m7),
    ("M8", "ntlm / ntlm_hash param + bind rejection", run_m8),
    ("M9", "kerberos config error (no KDC)", run_m9),
    ("M10", "external over TCP rejected", run_m10),
    ("M11", "3 connections alternate searches (isolation)", run_m11),
]

ALL_CONNECTION_IDS = (
    "smoke-mx-none-simple", "smoke-mx-anon", "smoke-mx-unauth", "smoke-mx-iso-none",
    "smoke-mx-iso-ldaps", "smoke-mx-iso-starttls", "smoke-mx-starttls", "smoke-mx-ldaps",
)


def ldap_reachable(port: int) -> tuple[bool, str]:
    try:
        with socket.create_connection((HOST, port), timeout=2.0):
            return True, ""
    except OSError as cause:
        return False, f"no LDAP server at {HOST}:{port} ({cause})"


def report() -> None:
    widths = (4, 44, 6)
    print(f"{'No.':<{widths[0]}} {'Scenario':<{widths[1]}} {'Status':<{widths[2]}} Detail")
    for result in RESULTS:
        print(f"{result.no:<{widths[0]}} {result.name:<{widths[1]}} {result.status:<{widths[2]}} {result.detail}")
    counts = {status: sum(1 for r in RESULTS if r.status == status) for status in ("PASS", "FAIL", "SKIP")}
    print(f"\ntotal={len(RESULTS)} PASS={counts['PASS']} FAIL={counts['FAIL']} SKIP={counts['SKIP']}")


def mark_all(status: str, message: str) -> None:
    for no, name, _ in STEPS:
        RESULTS.append(ScenarioResult(no, name, status, message))


def main() -> int:
    admin_pw = os.environ.get("LDAP_ADMIN_PASSWORD") or os.environ.get("LDAP_TEST_BINDPW")
    if not admin_pw:
        print("error: export LDAP_ADMIN_PASSWORD (or LDAP_TEST_BINDPW) before running this script", file=sys.stderr)
        return 2
    globals()["ADMIN_PW"] = admin_pw

    reachable, reason = ldap_reachable(PORT)
    if not reachable:
        mark_all("FAIL" if REQUIRE else "SKIP", reason)
        report()
        return 0

    binary = default_binary()
    if not os.path.exists(binary):
        mark_all("FAIL" if REQUIRE else "SKIP", f"sidecar binary not found: {binary} (set DBX_PLUGIN_SIDECAR)")
        report()
        return 0

    client = SidecarClient.start()
    try:
        try:
            client.initialize()
        except (SidecarError, AssertionError) as cause:
            mark_all("FAIL" if REQUIRE else "SKIP", f"plugin/initialize failed: {cause}")
            report()
            return 0
        for _, _, fn in STEPS:
            fn(client)
    finally:
        for connection_id in ALL_CONNECTION_IDS:
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


if __name__ == "__main__":
    raise SystemExit(main())
