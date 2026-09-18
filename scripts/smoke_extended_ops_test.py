#!/usr/bin/env python3
"""容器级 smoke：三个扩展操作方法（F3）对真实 OpenLDAP 服务器的首次验证。

    X1  ldap/entry/compare      正确值           -> match=true
    X2  ldap/entry/compare      错误值           -> match=false（成功响应，非错误）
    X3  ldap/entry/compare      不存在属性/DN    -> 错误通道 + LDAP 结果码（16/32）
    X4  ldap/whoami             admin bind       -> authzId 非空且以 "dn:" 开头
    X5  ldap/entry/passwdModify 管理员改种子用户 -> 旧密码 bind 失效、新密码 bind 生效
    X6  ldap/entry/passwdModify read_only 连接   -> 被只读门禁拒绝

对应 RFC：Compare = RFC 4511 §4.10；WhoAmI = RFC 4532；PasswordModify = RFC 3062。
后端契约（backend/internal/ldapconn/types.go + operations.go）：
  * compareTrue/compareFalse 折算为 {match: bool}；其余结果码走业务错误通道，
    main 层 bizError 自动补 "[ldap-code=N]" 前缀；
  * whoami 返回 {authzId}（OpenLDAP 形态如 "dn:cn=admin,dc=example,dc=org"）；
  * passwdModify 返回 {success: true}；read_only 门禁报 "is read-only"。

SKIP 语义（对齐 test.sh 家族约定 / M0 §5.2）：
  * 无 Docker CLI、容器拉起失败、镜像拉取失败、sidecar 二进制缺失 -> 整套 SKIP；
  * 方法未注册（后端并行开发中）-> 单场景 SKIP；
  * LDAP_TEST_REQUIRE=1 时上述环境类 SKIP 升级为 FAIL（CI 严格模式）。

用法（自含编排，拉起 docker-compose.ldap-test.yml 并负责拆容器）：
    python3 scripts/smoke_extended_ops_test.py [--keep]
  * 管理员口令优先取环境变量 LDAP_ADMIN_PASSWORD；未导出时脚本内 secrets
    随机生成临时口令注入 compose（绝不写入代码或磁盘）；
  * --attach 复用已在跑的容器（此时必须 export LDAP_ADMIN_PASSWORD）。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sidecar_client_jsonl import (  # noqa: E402
    SidecarClient,
    SidecarError,
    default_binary,
    is_method_not_registered,
    lifecycle_params,
)

REPO = Path(__file__).resolve().parent.parent
COMPOSE_FILE = REPO / "docker-compose.ldap-test.yml"
CONTAINER = "dbx-ldap-test"
HOST = os.environ.get("LDAP_TEST_HOST", "127.0.0.1")
# 1389 与本机已占用端口（5279/5290 等）不冲突；可用 LDAP_TEST_PORT 覆盖（attach 模式）。
PORT = int(os.environ.get("LDAP_TEST_PORT", "1389"))
ROOT = os.environ.get("LDAP_TEST_ROOT", "dc=example,dc=org")
BIND_DN = os.environ.get("LDAP_TEST_BINDDN", f"cn=admin,{ROOT}")
REQUIRE = os.environ.get("LDAP_TEST_REQUIRE", "") == "1"
URL = f"ldap://{HOST}:{PORT}"
READY_TIMEOUT_SECS = 90

# 种子条目（scripts/ldap-seed/01-testdata.ldif）：uid=seedpw 携带 documented
# 假口令（非真实凭据），X5 以它验证「管理员改种子用户密码」的旧/新口令 bind 对比。
SEED_PW_DN = f"uid=seedpw,ou=People,{ROOT}"
SEED_PW_DUMMY = "dummy-seeded-value-not-a-real-secret"


class SkipScenario(Exception):
    """场景前置条件不可用时抛出 -> 该场景记 SKIP。"""


class ScenarioResult:
    def __init__(self, no: str, name: str, status: str, detail: str = ""):
        self.no = no
        self.name = name
        self.status = status
        self.detail = detail


RESULTS: list[ScenarioResult] = []


def scenario(no: str, name: str):
    """场景装饰器：SkipScenario -> SKIP；未实现方法 -> SKIP；其余异常 -> FAIL。"""
    def decorate(fn):
        def run(*args, **kwargs):
            try:
                fn(*args, **kwargs)
            except SkipScenario as cause:
                RESULTS.append(ScenarioResult(no, name, "SKIP", str(cause)))
            except (SidecarError, AssertionError) as cause:
                if is_method_not_registered(cause):
                    RESULTS.append(ScenarioResult(no, name, "SKIP", f"backend not implemented: {cause}"))
                else:
                    RESULTS.append(ScenarioResult(no, name, "FAIL", str(cause)))
            except Exception as cause:  # 意外崩溃按 FAIL 记
                RESULTS.append(ScenarioResult(no, name, "FAIL", f"unexpected: {cause}"))
            else:
                RESULTS.append(ScenarioResult(no, name, "PASS"))
        return run
    return decorate


# -- 辅助 ----------------------------------------------------------------------

def expect_error(fn, markers: tuple[str, ...] = ()) -> SidecarError:
    """执行 fn 并期望 SidecarError；给 markers 时断言错误文案包含其一。"""
    try:
        fn()
    except SidecarError as cause:
        lowered = str(cause).lower()
        if markers and not any(marker in lowered for marker in markers):
            raise AssertionError(f"error message mismatch: {cause}") from cause
        return cause
    raise AssertionError("expected a sidecar error but the call succeeded")


def ldap_code_of(cause: SidecarError) -> str:
    """从业务错误文案提取 bizError 补的 [ldap-code=N] 前缀，取不到返回空串。"""
    matched = re.search(r"\[ldap-code=(\d+)\]", str(cause))
    return matched.group(1) if matched else ""


def make_connection(client_state: dict, connection_id: str, **extra_config) -> dict:
    """构建 admin bind 的连接生命周期参数（external_config 承载门禁字段）。"""
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
        "connection_secrets": {"bind_password": client_state["admin_password"]},
    }


CURRENT_CONNECTION = {"id": ""}


def connect(client: SidecarClient, connection: dict) -> None:
    CURRENT_CONNECTION["id"] = connection["id"]
    client.request("connection/connect", lifecycle_params(connection))


def domain(client: SidecarClient, method: str, params: dict) -> dict:
    payload = dict(params)
    payload.setdefault("connectionId", CURRENT_CONNECTION["id"])
    return client.request(method, payload)


def bind_ok(client: SidecarClient, client_state: dict, bind_dn: str, password: str) -> tuple[bool, str]:
    """用给定 DN/口令做一次真实 simple bind（connection/test 短连接探活）。

    返回 (是否成功, 失败原因文案)。bind 失败可能表现为 success=false 或业务
    错误，两种包络都按失败处理；未实现类错误向上抛，由场景装饰器转 SKIP。
    """
    probe = {
        "id": "smoke-extops-bind-probe",
        "name": "smoke-extops-bind-probe",
        "host": URL,
        "port": PORT,
        "external_config": {"auth_type": "simple", "bind_dn": bind_dn, "base_dn": ROOT},
        "connection_secrets": {"bind_password": password},
    }
    try:
        result = client.request("connection/test", lifecycle_params(probe))
    except SidecarError as cause:
        if is_method_not_registered(cause):
            raise
        return False, str(cause)
    if result.get("success") is True:
        return True, ""
    return False, str(result.get("message", result))


def assert_no_credential_leak(client: SidecarClient, *secrets_to_check: str) -> None:
    """凭据红线：ldap/audit 事件流不得携带口令明文（对齐 smoke_test S12）。"""
    for event in client.events:
        if event.get("method") != "ldap/audit":
            continue
        blob = json.dumps(event.get("params", {}), ensure_ascii=True)
        for secret_value in secrets_to_check:
            if secret_value and secret_value in blob:
                raise AssertionError("ldap/audit event carries a password value")


# -- 场景（X 系列）--------------------------------------------------------------

@scenario("X1", "compare: 正确值 -> match=true")
def run_x1(client: SidecarClient, state: dict) -> None:
    """对种子条目 uid=seedpw 比对其真实持有的 uid 值，必须返回 match=true。"""
    connect(client, make_connection(state, "smoke-extops-admin", blocked_attributes=["token"]))
    result = domain(client, "ldap/entry/compare",
                    {"dn": SEED_PW_DN, "attribute": "uid", "value": "seedpw"})
    if result.get("match") is not True:
        raise AssertionError(f"compare(match=true) got: {result}")


@scenario("X2", "compare: 错误值 -> match=false（非错误）")
def run_x2(client: SidecarClient, state: dict) -> None:
    """错误值必须以 match=false 的成功响应表达（compareFalse 不走错误通道）。"""
    connect(client, make_connection(state, "smoke-extops-admin", blocked_attributes=["token"]))
    result = domain(client, "ldap/entry/compare",
                    {"dn": SEED_PW_DN, "attribute": "uid", "value": "not-the-seeded-uid"})
    if "match" not in result or result.get("match") is not False:
        raise AssertionError(f"compare(match=false) got: {result}")


@scenario("X3", "compare: 不存在属性/DN -> LDAP 结果码")
def run_x3(client: SidecarClient, state: dict) -> None:
    """条目存在但属性缺失 -> OpenLDAP noSuchAttribute(16)；DN 不存在 ->
    noSuchObject(32)。二者都必须走错误通道并携带 [ldap-code=N] 前缀。"""
    connect(client, make_connection(state, "smoke-extops-admin", blocked_attributes=["token"]))
    cause = expect_error(lambda: domain(client, "ldap/entry/compare",
                                        {"dn": SEED_PW_DN, "attribute": "employeeNumber", "value": "1"}))
    code = ldap_code_of(cause)
    if code != "16":
        raise AssertionError(f"absent attribute: expected ldap-code=16 (noSuchAttribute), got: {cause}")
    cause = expect_error(lambda: domain(client, "ldap/entry/compare",
                                        {"dn": f"uid=ghost-{secrets.token_hex(4)},ou=People,{ROOT}",
                                         "attribute": "uid", "value": "x"}))
    code = ldap_code_of(cause)
    if code != "32":
        raise AssertionError(f"absent entry: expected ldap-code=32 (noSuchObject), got: {cause}")


@scenario("X4", "whoami: admin bind -> dn: 前缀 authzId")
def run_x4(client: SidecarClient, state: dict) -> None:
    """admin bind 后 WhoAmI 扩展操作返回非空 authzId 且以 "dn:" 开头；形态以
    服务器实际返回为准（OpenLDAP 为 dn:cn=admin,dc=example,dc=org）。"""
    connect(client, make_connection(state, "smoke-extops-admin", blocked_attributes=["token"]))
    result = domain(client, "ldap/whoami", {})
    authz = result.get("authzId", "")
    if not authz:
        raise AssertionError(f"whoami returned an empty authzId: {result}")
    if not authz.startswith("dn:"):
        raise AssertionError(f"whoami authzId lacks the dn: prefix: {authz!r}")
    if "cn=admin" not in authz:
        raise AssertionError(f"whoami authzId is not the admin identity: {authz!r}")


@scenario("X5", "passwdModify: 管理员改种子用户 -> 新旧 bind 验证")
def run_x5(client: SidecarClient, state: dict) -> None:
    """管理员对种子用户 uid=seedpw 执行 RFC 3062 密码修改：
    (a) 修改前旧（种子假）口令 bind 成功；
    (b) passwdModify(old->new) 返回 success=true；
    (c) 旧口令 bind 失效、新口令 bind 生效；
    (d) 新口令不出现在 ldap/audit 事件流。"""
    connect(client, make_connection(state, "smoke-extops-admin", blocked_attributes=["token"]))
    new_password = f"Xsmoke-{secrets.token_urlsafe(18)}"  # 临时凭据，仅内存流转

    ok, detail = bind_ok(client, state, SEED_PW_DN, SEED_PW_DUMMY)
    if not ok:
        raise AssertionError(f"seeded old password should bind before the change: {detail}")

    result = domain(client, "ldap/entry/passwdModify",
                    {"dn": SEED_PW_DN, "oldPassword": SEED_PW_DUMMY, "newPassword": new_password})
    if result.get("success") is not True:
        raise AssertionError(f"passwdModify did not succeed: {result}")

    ok, _ = bind_ok(client, state, SEED_PW_DN, SEED_PW_DUMMY)
    if ok:
        raise AssertionError("old password still binds after passwdModify")
    ok, detail = bind_ok(client, state, SEED_PW_DN, new_password)
    if not ok:
        raise AssertionError(f"new password does not bind after passwdModify: {detail}")

    assert_no_credential_leak(client, new_password)


@scenario("X6", "passwdModify: read_only 连接被拒绝")
def run_x6(client: SidecarClient, state: dict) -> None:
    """read_only 门禁语义：只读连接下 passwdModify 必须被策略层拒绝
    （"is read-only"，业务错误），且不得触达服务器。"""
    connect(client, make_connection(state, "smoke-extops-ro", read_only=True,
                                    blocked_attributes=["token"]))
    cause = expect_error(lambda: domain(client, "ldap/entry/passwdModify",
                                        {"dn": SEED_PW_DN,
                                         "oldPassword": SEED_PW_DUMMY,
                                         "newPassword": f"Xsmoke-{secrets.token_urlsafe(18)}"}),
                         markers=("read-only",))
    if cause.code not in (None, -32000):
        raise AssertionError(f"expected business error -32000, got {cause.code}: {cause}")


# -- 容器编排（自含；镜像/网络不可用 -> 整套 SKIP，绝不伪装通过）------------------

def sh(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    print("+", " ".join(cmd), flush=True)
    return subprocess.run(cmd, **kwargs)


def shutil_which(binary: str) -> str | None:
    from shutil import which
    return which(binary)


def compose(*args: str, check: bool = True, env: dict | None = None) -> subprocess.CompletedProcess:
    return sh(["docker", "compose", "-f", str(COMPOSE_FILE), *args], check=check, env=env)


def port_open(port: int) -> bool:
    try:
        with socket.create_connection((HOST, port), timeout=1.0):
            return True
    except OSError:
        return False


def wait_ready(admin_password: str) -> None:
    """等 slapd 真正应答 admin bind（bitnami bootstrap 期间端口先开、slapd 后就绪）。"""
    probe = [
        "docker", "exec", CONTAINER, "ldapsearch", "-x",
        "-H", f"ldap://127.0.0.1:{PORT}",
        "-D", BIND_DN,
        "-w", admin_password,
        "-b", ROOT, "-s", "base", "(objectClass=*)", "1.1",
    ]
    deadline = time.monotonic() + READY_TIMEOUT_SECS
    while time.monotonic() < deadline:
        if port_open(PORT):
            if subprocess.run(probe, capture_output=True).returncode == 0:
                time.sleep(1)
                return
        time.sleep(1)
    raise RuntimeError(f"LDAP container not serving admin bind on {HOST}:{PORT} after {READY_TIMEOUT_SECS}s")


STEPS = [
    ("X1", "compare 正确值 -> match=true", run_x1),
    ("X2", "compare 错误值 -> match=false", run_x2),
    ("X3", "compare 缺属性/缺条目 -> 结果码 16/32", run_x3),
    ("X4", "whoami admin -> dn: authzId", run_x4),
    ("X5", "passwdModify 管理员改密 -> 新旧 bind", run_x5),
    ("X6", "passwdModify read_only 拒绝", run_x6),
]


def report() -> None:
    widths = (4, 46, 6)
    print(f"{'No.':<{widths[0]}} {'Scenario':<{widths[1]}} {'Status':<{widths[2]}} Detail")
    for result in RESULTS:
        print(f"{result.no:<{widths[0]}} {result.name:<{widths[1]}} {result.status:<{widths[2]}} {result.detail}")
    counts = {status: sum(1 for r in RESULTS if r.status == status) for status in ("PASS", "FAIL", "SKIP")}
    print(f"\ntotal={len(RESULTS)} PASS={counts['PASS']} FAIL={counts['FAIL']} SKIP={counts['SKIP']}")


def mark_all(status: str, message: str) -> None:
    for no, name, _ in STEPS:
        RESULTS.append(ScenarioResult(no, name, status, message))


def env_exit_code() -> int:
    """环境类整体 FAIL/SKIP 的退出码：REQUIRE=1（CI 严格模式）FAIL 必须
    非零让流水线失败；宽松模式整体 SKIP 按 0 处理（对齐家族约定）。"""
    return 1 if any(result.status == "FAIL" for result in RESULTS) else 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--keep", action="store_true", help="保留容器用于调试")
    parser.add_argument("--attach", action="store_true", help="复用已在运行的容器")
    args = parser.parse_args()

    # 管理员口令：环境变量优先，未导出则脚本内随机生成（不落代码/磁盘）。
    admin_password = os.environ.get("LDAP_ADMIN_PASSWORD") or f"adm-{secrets.token_urlsafe(18)}"
    state = {"admin_password": admin_password}

    compose_env = os.environ.copy()
    compose_env["LDAP_ADMIN_PASSWORD"] = admin_password

    if args.attach:
        if not port_open(PORT):
            mark_all("FAIL" if REQUIRE else "SKIP", f"no LDAP server at {HOST}:{PORT} (attach mode)")
            report()
            return env_exit_code()
    else:
        if not shutil_which("docker"):
            mark_all("FAIL" if REQUIRE else "SKIP", "docker CLI not available")
            report()
            return env_exit_code()
        # 丢弃同名的历史残留容器（名字归本 harness 所有，先删再起）。
        sh(["docker", "rm", "-f", CONTAINER], check=False,
           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if compose("up", "-d", check=False, env=compose_env).returncode != 0:
            mark_all("FAIL" if REQUIRE else "SKIP",
                     "docker compose up failed (docker daemon down / image pull failure)")
            report()
            return env_exit_code()

    try:
        if not args.attach:
            try:
                wait_ready(admin_password)
            except RuntimeError as cause:
                mark_all("FAIL" if REQUIRE else "SKIP", str(cause))
                report()
                return env_exit_code()

        binary = default_binary()
        if not os.path.exists(binary):
            mark_all("FAIL" if REQUIRE else "SKIP", f"sidecar binary not found: {binary} (set DBX_PLUGIN_SIDECAR)")
            report()
            return env_exit_code()

        client = SidecarClient.start(data_dir=tempfile.mkdtemp(prefix="dbx-ldap-extops-smoke-data-"))
        try:
            try:
                client.initialize()
            except (SidecarError, AssertionError) as cause:
                mark_all("FAIL" if REQUIRE else "SKIP", f"plugin/initialize failed: {cause}")
                report()
                return env_exit_code()
            for _, _, fn in STEPS:
                fn(client, state)
        finally:
            for connection_id in ("smoke-extops-admin", "smoke-extops-ro", "smoke-extops-bind-probe"):
                try:
                    client.request("connection/disconnect", {"connection": {"id": connection_id}})
                except Exception:
                    pass
            try:
                client.close()
            except Exception:
                pass
    finally:
        if not args.attach and not args.keep:
            compose("down", "-v", check=False, env=compose_env)

    report()
    return env_exit_code()


if __name__ == "__main__":
    raise SystemExit(main())
