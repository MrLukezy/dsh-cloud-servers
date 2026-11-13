#!/usr/bin/env python3
"""dsh-cloud-servers 的密码登录助手。

宿主（Node）只在「密码类主机」时调用本脚本：把 JSON 从 stdin 喂进来，
连上 SSH 执行一条命令，再把结果以 JSON 打到 stdout。密码走 stdin，
不会出现在命令行参数 / 进程列表里。

输入：{"host": "10.0.0.5", "port": 22, "user": "root",
       "password": "...", "command": "uptime", "timeout": 25}
输出：{"ok": true, "code": 0, "stdout": "...", "stderr": "", "error": ""}
"""

import json
import sys

MAX_OUTPUT = 512 * 1024


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception as exc:  # noqa: BLE001
        json.dump({"ok": False, "code": -1, "stdout": "", "stderr": "", "error": f"bad payload: {exc}"}, sys.stdout)
        return 0

    try:
        import paramiko
    except Exception as exc:  # noqa: BLE001
        json.dump(
            {"ok": False, "code": -1, "stdout": "", "stderr": "", "error": f"paramiko 不可用：{exc}"},
            sys.stdout,
        )
        return 0

    host = str(payload.get("host") or "").strip()
    user = str(payload.get("user") or "").strip()
    password = str(payload.get("password") or "")
    command = str(payload.get("command") or "echo ok")
    timeout = float(payload.get("timeout") or 25)
    try:
        port = int(payload.get("port") or 22)
    except Exception:  # noqa: BLE001
        port = 22

    result = {"ok": False, "code": -1, "stdout": "", "stderr": "", "error": ""}
    if not host or not user:
        result["error"] = "缺少 host / user"
        json.dump(result, sys.stdout, ensure_ascii=False)
        return 0
    if not password:
        result["error"] = "该主机未配置密码"
        json.dump(result, sys.stdout, ensure_ascii=False)
        return 0

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(
            host,
            port=port,
            username=user,
            password=password,
            timeout=min(timeout, 15),
            banner_timeout=min(timeout, 15),
            auth_timeout=min(timeout, 15),
            look_for_keys=False,
            allow_agent=False,
        )
        _stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
        result["stdout"] = stdout.read(MAX_OUTPUT).decode("utf-8", "replace")
        result["stderr"] = stderr.read(MAX_OUTPUT).decode("utf-8", "replace")
        result["code"] = stdout.channel.recv_exit_status()
        result["ok"] = True
    except Exception as exc:  # noqa: BLE001
        result["error"] = f"{type(exc).__name__}: {exc}"
    finally:
        try:
            client.close()
        except Exception:  # noqa: BLE001
            pass

    json.dump(result, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())