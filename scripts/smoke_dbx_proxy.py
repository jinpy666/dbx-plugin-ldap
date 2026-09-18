#!/usr/bin/env python3
"""DBX proxy/tunnel smoke for dbx-plugin-ldap (方案 D5 endpoint semantics).

DBX 宿主在传输层做 SSH 隧道/代理/endpoint rewrite，把**最终拨号端点**放在
runtime.host/runtime.port 下发；sidecar 网络层一律拨 runtime 端点，TLS SNI
与证书校验用 connection.host（URL 逻辑主机名）。本套件用进程内 TCP 转发器
模拟"DBX 代理后的端点"，验证语义正确性：

    P1  runtime 端点接管拨号（逻辑主机不可达也必须连通）
    P2  负证：runtime 指向死端口 → 拨号失败（成功确实归因于 runtime 端点）
    P3  ldaps 经隧道 + 逻辑主机 localhost 证书校验（tls_verify=true）
    P4  负证：逻辑主机与证书 SAN 不符 → x509 主机名错误（校验不被代理绕过）
    P5  StartTLS 经隧道升级成功
    P6  runtime.host 混入完整 ldap:// URL 的容错（normalizeDialHost 剥离）
    P7  数据面：经转发器读取种子二进制（base64 与常量逐字节一致）+ fixture 计数

Credentials: read from LDAP_ADMIN_PASSWORD (fallback LDAP_TEST_BINDPW); no
literals here. Attach env: LDAP_TEST_HOST/PORT/ROOT/BINDDN.
"""

from __future__ import annotations

import base64
import os
import socket
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sidecar_client_jsonl import (  # noqa: E402
    SidecarClient,
    SidecarError,
    lifecycle_params,
)

HOST = os.environ.get("LDAP_TEST_HOST", "127.0.0.1")
PORT = int(os.environ.get("LDAP_TEST_PORT", "1389"))
LDAPS_PORT = int(os.environ.get("LDAP_TEST_LDAPS_PORT", "636"))
ROOT = os.environ.get("LDAP_TEST_ROOT", "dc=example,dc=org")
BIND_DN = os.environ.get("LDAP_TEST_BINDDN", f"cn=admin,{ROOT}")
BIND_PW = os.environ.get("LDAP_ADMIN_PASSWORD") or os.environ.get("LDAP_TEST_BINDPW", "")

PROVIDER = {"id": "io.dbx.ldap.connection", "databaseType": "ldap"}
DEAD_PORT = 1  # 保留端口，127.0.0.1 上必然 connection refused
UNRESOLVABLE = "ldap-proxy-test.invalid"  # RFC 6761 保留 TLD；仅作逻辑主机名


class Forwarder:
    """进程内 TCP 转发器：模拟 DBX 隧道/代理后的最终端点。"""

    def __init__(self, target_host: str, target_port: int) -> None:
        self._target = (target_host, target_port)
        self._srv = socket.socket()
        self._srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._srv.bind(("127.0.0.1", 0))
        self._srv.listen(16)
        self.port = self._srv.getsockname()[1]
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self) -> None:
        while True:
            try:
                client, _ = self._srv.accept()
            except OSError:
                return
            threading.Thread(target=self._pipe, args=(client,), daemon=True).start()

    def _pipe(self, client: socket.socket) -> None:
        try:
            upstream = socket.create_connection(self._target, timeout=10)
        except OSError:
            client.close()
            return

        def pump(src: socket.socket, dst: socket.socket) -> None:
            try:
                while True:
                    data = src.recv(65536)
                    if not data:
                        break
                    dst.sendall(data)
            except OSError:
                pass
            finally:
                try:
                    dst.shutdown(socket.SHUT_WR)
                except OSError:
                    pass

        threads = [
            threading.Thread(target=pump, args=(client, upstream), daemon=True),
            threading.Thread(target=pump, args=(upstream, client), daemon=True),
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=120)
        client.close()
        upstream.close()


def make_connection(connection_id: str, url: str, **extra_config) -> dict:
    external = {"auth_type": "simple", "bind_dn": BIND_DN, "base_dn": ROOT, "timeout_secs": 10}
    external.update(extra_config)
    return {
        "id": connection_id,
        "name": f"smoke-{connection_id}",
        "host": url,
        "external_config": external,
        "connection_secrets": {"bind_password": BIND_PW},
    }


def proxy_params(connection: dict, runtime_host: str, runtime_port: int) -> dict:
    """手动指定 runtime 端点：模拟 DBX 隧道/代理改写后的最终端点下发。"""
    params = lifecycle_params(connection)
    params["runtime"] = {"host": runtime_host, "port": runtime_port}
    return params


CURRENT = {"id": ""}


def connect(client: SidecarClient, params: dict, connection_id: str) -> None:
    CURRENT["id"] = connection_id
    client.request("connection/connect", params)


def domain(client: SidecarClient, method: str, params: dict) -> dict:
    payload = dict(params)
    payload.setdefault("connectionId", CURRENT["id"])
    return client.request(method, payload)


def search(client: SidecarClient, **params) -> dict:
    payload = {"filter": "(objectClass=*)", "scope": "sub"}
    payload.update(params)
    return domain(client, "ldap/search", payload)


def entry_get(client: SidecarClient, dn: str, attributes: list[str]) -> dict:
    return domain(client, "ldap/entry/get", {"dn": dn, "attributes": attributes})


# --- scenarios ---------------------------------------------------------------

SCENARIOS: list[tuple[str, str, object]] = []


def scenario(no: str, title: str):
    def wrap(fn):
        SCENARIOS.append((no, title, fn))
        return fn
    return wrap


@scenario("P1", "runtime 端点接管拨号（逻辑主机不可达仍连通）")
def p1(client: SidecarClient, fwd_plain: Forwarder, fwd_ldaps: Forwarder) -> None:
    conn = make_connection("proxy-p1", f"ldap://{UNRESOLVABLE}:13890")
    connect(client, proxy_params(conn, "127.0.0.1", fwd_plain.port), conn["id"])
    # connect 是惰性拨号：真正建连发生在首个领域请求。
    result = search(client, baseDn=ROOT, scope="base")
    assert result.get("entries"), f"search over tunnel returned nothing: {result}"


@scenario("P2", "负证：runtime 死端口 → 首个操作报拨号错误")
def p2(client: SidecarClient, fwd_plain: Forwarder, fwd_ldaps: Forwarder) -> None:
    conn = make_connection("proxy-p2", f"ldap://{UNRESOLVABLE}:13890")
    connect(client, proxy_params(conn, "127.0.0.1", DEAD_PORT), conn["id"])
    try:
        search(client, baseDn=ROOT, scope="base")
    except SidecarError as cause:
        text = str(cause).lower()
        markers = ("refused", "network", "connection", "timeout", "dial")
        assert any(marker in text for marker in markers), f"expected dial-class error, got: {cause}"
        return
    raise AssertionError("search via dead runtime port unexpectedly succeeded")


@scenario("P3", "ldaps 经隧道 + 逻辑主机 localhost 证书校验（私有 CA）")
def p3(client: SidecarClient, fwd_plain: Forwarder, fwd_ldaps: Forwarder) -> None:
    ca_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ldap-dev-seed", "tls", "openldap-ca.crt")
    conn = make_connection("proxy-p3", "ldaps://localhost:636", tls_verify=True, tls_ca_path=ca_path)
    connect(client, proxy_params(conn, "127.0.0.1", fwd_ldaps.port), conn["id"])
    result = search(client, baseDn=ROOT, scope="base")
    assert result.get("entries"), f"ldaps search over tunnel returned nothing: {result}"


@scenario("P4", "负证：逻辑主机与证书 SAN 不符 → x509 主机名错误")
def p4(client: SidecarClient, fwd_plain: Forwarder, fwd_ldaps: Forwarder) -> None:
    ca_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ldap-dev-seed", "tls", "openldap-ca.crt")
    conn = make_connection("proxy-p4", f"ldaps://{UNRESOLVABLE}:636", tls_verify=True, tls_ca_path=ca_path)
    connect(client, proxy_params(conn, "127.0.0.1", fwd_ldaps.port), conn["id"])
    try:
        search(client, baseDn=ROOT, scope="base")
    except SidecarError as cause:
        text = str(cause).lower()
        assert "x509" in text or "certificate" in text, (
            f"expected certificate hostname error, got: {cause}"
        )
        return
    raise AssertionError("ldaps with mismatched logical host unexpectedly succeeded")


@scenario("P5", "StartTLS 经隧道升级成功")
def p5(client: SidecarClient, fwd_plain: Forwarder, fwd_ldaps: Forwarder) -> None:
    conn = make_connection("proxy-p5", f"ldap://localhost:{PORT}", use_starttls=True, tls_verify=False)
    connect(client, proxy_params(conn, "127.0.0.1", fwd_plain.port), conn["id"])
    result = search(client, baseDn=ROOT, scope="base")
    assert result.get("entries"), f"starttls search over tunnel returned nothing: {result}"


@scenario("P6", "runtime.host 混入完整 ldap:// URL 的容错（normalizeDialHost）")
def p6(client: SidecarClient, fwd_plain: Forwarder, fwd_ldaps: Forwarder) -> None:
    conn = make_connection("proxy-p6", f"ldap://{UNRESOLVABLE}:13890")
    # runtime.host 携带完整 URL（宿主直连透传形态），port 缺省 → 从 URL 派生。
    params = proxy_params(conn, f"ldap://127.0.0.1:{PORT}", 0)
    connect(client, params, conn["id"])
    result = search(client, baseDn=ROOT, scope="base")
    assert result.get("entries"), f"search with URL-shaped runtime.host failed: {result}"


@scenario("P7", "数据面完整性：经隧道读种子二进制 + fixture 计数")
def p7(client: SidecarClient, fwd_plain: Forwarder, fwd_ldaps: Forwarder) -> None:
    seed_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ldap-dev-seed")
    jpeg_b64 = None
    folded: list[str] = []
    with open(os.path.join(seed_dir, "02-smoke-fixtures.ldif"), encoding="utf-8") as handle:
        for line in handle:
            if line.startswith("jpegPhoto::"):
                folded.append(line.split("::", 1)[1].strip())
            elif folded and line.startswith(" "):
                folded.append(line.strip())
            elif folded:
                break
    jpeg_b64 = "".join(folded)
    assert jpeg_b64, "could not parse seeded jpegPhoto constant"

    conn = make_connection("proxy-p7", f"ldap://{UNRESOLVABLE}:13890")
    connect(client, proxy_params(conn, "127.0.0.1", fwd_plain.port), conn["id"])
    fetched = entry_get(client, f"uid=seedphoto,ou=People,{ROOT}", ["jpegPhoto"])
    values = fetched.get("entry", {}).get("attributes", {}).get("jpegPhoto", [])
    assert len(values) == 1, f"seedphoto jpegPhoto missing over tunnel: {fetched}"
    got = values[0]
    # 后端对二进制属性以 base64 返回；与种子常量逐字节对齐。
    got_bytes = base64.b64decode(got) if set(got) <= set(
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=\n"
    ) else got.encode("latin-1")
    want_bytes = base64.b64decode(jpeg_b64)
    assert got_bytes == want_bytes, (
        f"binary bytes differ through tunnel: got {len(got_bytes)} bytes, want {len(want_bytes)}"
    )
    listed = search(client, baseDn=f"ou=DevFixtures,{ROOT}", scope="sub")
    assert len(listed.get("entries", [])) >= 6, "dev fixtures not fully visible through tunnel"


def main() -> int:
    if not BIND_PW:
        print("SKIP: LDAP_ADMIN_PASSWORD/LDAP_TEST_BINDPW not set (attach env required)")
        return 0
    fwd_plain = Forwarder(HOST, PORT)
    fwd_ldaps = Forwarder(HOST, LDAPS_PORT)
    client = SidecarClient.start()
    passed: list[str] = []
    failed: list[tuple[str, str]] = []
    try:
        client.initialize()
        for no, title, fn in SCENARIOS:
            try:
                fn(client, fwd_plain, fwd_ldaps)
            except (AssertionError, SidecarError) as cause:
                failed.append((no, f"{title}: {cause}"))
                print(f"{no:<4} {title:<46} FAIL   {cause}")
            else:
                passed.append(no)
                print(f"{no:<4} {title:<46} PASS")
    finally:
        client.close()
    print(f"\nproxy smoke: {len(passed)} PASS, {len(failed)} FAIL")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
