#!/usr/bin/env python3
"""扫描本机 Shadowrocket 的节点，报告端口可达性与节点类型。

    python3 scripts/node-scan.py            # 只测 TCP 可达性（快，TUN 开着也能用）
    python3 scripts/node-scan.py --egress   # 额外做端到端测试（需先关 VPN，见下）

为什么两种模式：
  Shadowrocket 的 TUN（utun6，0/1 + 128.0/1 分流）会接管**所有**出站流量，
  所以在 VPN 连接状态下测节点，等于让失效节点去连节点自己 —— 会全部失败。
  `--egress` 会先提示你 `scutil --nc stop`，再直连节点做真实测试。

节点信息从本机 Shadowrocket 的 Group Container 里读，脚本本身不含任何密钥。
"""
import argparse
import hashlib
import json
import os
import plistlib
import socket
import ssl
import sys
from concurrent.futures import ThreadPoolExecutor

SERVER_MANAGER = os.path.expanduser(
    "~/Library/Group Containers/group.com.liguangming.Shadowrocket/ServerManager"
)
GROUP_PLIST = os.path.expanduser(
    "~/Library/Group Containers/group.com.liguangming.Shadowrocket/Library/Preferences/"
    "group.com.liguangming.Shadowrocket.plist"
)
SKIP_TITLES = ("剩余流量", "距离下次重置", "套餐到期", "防失联网址", "过期时间", "官网")


def load_nodes():
    with open(SERVER_MANAGER, "rb") as fh:
        archive = plistlib.load(fh)
    objects = archive["$objects"]

    def resolve(value):
        while isinstance(value, plistlib.UID):
            value = objects[value.data]
        if isinstance(value, bytes):
            try:
                return value.decode("utf-8")
            except UnicodeDecodeError:
                return value.hex()
        return value

    root = resolve(archive["$top"]["root"])
    nodes = []
    for uid in root["NS.objects"]:
        entry = resolve(uid)
        node = {k: resolve(v) for k, v in entry.items() if k != "$class"}
        title = str(node.get("title", ""))
        kind = str(node.get("type", ""))
        if kind not in ("Trojan", "Hysteria2", "Shadowsocks", "VMess", "VLESS"):
            continue
        if title.startswith(SKIP_TITLES):
            continue
        try:
            node["port"] = int(float(node.get("port", 0)))
        except (TypeError, ValueError):
            continue
        if node["port"] <= 0:
            continue
        nodes.append(node)
    return nodes


def selected():
    try:
        with open(GROUP_PLIST, "rb") as fh:
            prefs = plistlib.load(fh)
        return (
            str(prefs.get("group.com.liguangming.SelectedServerName", "")),
            str(prefs.get("group.com.liguangming.SelectedServerUUID", "")),
        )
    except Exception:
        return ("", "")


def tcp_ok(host, port, timeout=3.0):
    sock = socket.socket()
    sock.settimeout(timeout)
    try:
        sock.connect((host, port))
        return True, ""
    except OSError as exc:
        return False, type(exc).__name__
    finally:
        sock.close()


def trojan_egress(node, target="api.github.com", port=80, timeout=10):
    """用最小 Trojan 客户端穿过节点，发一个明文 HTTP 请求验证出口。"""
    host = str(node["host"])
    sni = str(node.get("peer") or host)
    password = str(node.get("password", ""))
    if not password:
        return None, "无密码字段"
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    try:
        ctx.set_alpn_protocols(["http/1.1"])
    except Exception:
        pass
    raw = socket.create_connection((host, node["port"]), timeout=timeout)
    raw.settimeout(timeout)
    tls = ctx.wrap_socket(raw, server_hostname=sni)
    digest = hashlib.sha224(password.encode()).hexdigest().encode()
    host_bytes = target.encode()
    request = (
        b"GET http://" + host_bytes + b"/ HTTP/1.1\r\nHost: " + host_bytes +
        b"\r\nUser-Agent: node-scan/1\r\nConnection: close\r\n\r\n"
    )
    tls.sendall(
        digest + b"\r\n\x01\x03" + bytes([len(host_bytes)]) + host_bytes +
        port.to_bytes(2, "big") + b"\r\n" + request
    )
    buf = b""
    while b"\r\n\r\n" not in buf and len(buf) < 4096:
        chunk = tls.recv(4096)
        if not chunk:
            break
        buf += chunk
    tls.close()
    return buf.split(b"\r\n")[0].decode("latin-1", "ignore"), ""


def main():
    parser = argparse.ArgumentParser(description="Shadowrocket 节点扫描")
    parser.add_argument("--egress", action="store_true", help="端到端测试（需先关 VPN）")
    parser.add_argument("--target", default="api.github.com", help="egress 测试目标域名")
    args = parser.parse_args()

    if not os.path.exists(SERVER_MANAGER):
        print(f"读不到节点文件：{SERVER_MANAGER}")
        return 1
    nodes = load_nodes()
    name, uuid = selected()
    print(f"共 {len(nodes)} 个节点；当前选中：{name or '<未知>'}  ({uuid[:8] or '-'})")
    if args.egress:
        print("注意：--egress 必须在 VPN 断开时跑（scutil --nc stop <Shadowrocket 服务>），"
              "否则 TUN 会接管流量导致全部失败。\n")
    else:
        print("（仅 TCP 可达性；深度测出口用 --egress）\n")

    def probe(node):
        host = str(node["host"])
        ok, err = tcp_ok(host, node["port"])
        egress = ""
        if ok and args.egress and str(node.get("type")) == "Trojan":
            try:
                egress, eerr = trojan_egress(node, args.target)
                egress = egress or f"ERR {eerr}"
            except Exception as exc:  # noqa: BLE001
                egress = f"ERR {type(exc).__name__}"
        return (node, ok, err, egress)

    with ThreadPoolExecutor(max_workers=24) as pool:
        results = list(pool.map(probe, nodes))

    reachable = sum(1 for _, ok, _, _ in results if ok)
    for node, ok, err, egress in sorted(results, key=lambda r: (not r[1], str(r[0]["title"]))):
        mark = "✓" if ok else "✗"
        line = f"  {mark} {str(node['title'])[:24]:24s} {node['port']:<6d} {str(node['host'])[:26]:26s}"
        if egress:
            line += f" {egress[:48]}"
        elif not ok:
            line += f" ({err})"
        print(line)

    print(f"\nTCP 可达 {reachable}/{len(results)}")
    return 0 if reachable else 1


if __name__ == "__main__":
    sys.exit(main())
