#!/usr/bin/env python3
"""
当 `git push` 被网络拦截（github.com:443 隧道 502）时，用 GitHub Git Data API
把当前 HEAD 复刻到远端分支。

原理：commit 对象的 sha 只由 tree / parent / author / committer / message 决定。
逐字节复刻这五项，远端算出的 sha 与本地完全相同 —— 等价于一次 fast-forward push。

用法：
    gh_push_api.py [--repo owner/repo] [--branch main] [--file index.html] [--dry-run]
"""
import argparse
import base64
import datetime
import json
import os
import pathlib
import subprocess
import sys
import tempfile


def git(*args):
    r = subprocess.run(["git", *args], capture_output=True)
    if r.returncode != 0:
        raise RuntimeError("git %s 失败: %s" % (" ".join(args), r.stderr.decode().strip()))
    return r.stdout


def gh(args, payload=None):
    cmd = ["gh", "api", *args]
    tmp = None
    if payload is not None:
        fd, tmp = tempfile.mkstemp(suffix=".json")
        os.close(fd)
        pathlib.Path(tmp).write_text(json.dumps(payload))
        cmd += ["--input", tmp]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True)
    finally:
        if tmp:
            os.unlink(tmp)
    if r.returncode != 0:
        raise RuntimeError("gh api %s 失败: %s" % (" ".join(args), r.stderr.strip()))
    return r.stdout.strip()


def parse_commit(raw):
    """从 git cat-file commit 的原始字节里拆头部与消息（消息不能用 %B，会动尾换行）。"""
    head, sep, msg = raw.partition(b"\n\n")
    if not sep:
        raise RuntimeError("commit 对象格式异常")
    meta = {}
    for line in head.decode().splitlines():
        key, _, val = line.partition(" ")
        meta[key] = val
    return meta, msg


def who(value):
    """'Name <email> 1761890317 +0800' -> GitHub API 的 author/committer 结构。"""
    name_email, ts, tz = value.rsplit(" ", 2)
    name, email = name_email.rsplit(" <", 1)
    email = email.rstrip(">")
    sign = 1 if tz[0] == "+" else -1
    delta = datetime.timedelta(hours=int(tz[1:3]), minutes=int(tz[3:5]))
    dt = datetime.datetime.fromtimestamp(int(ts), datetime.timezone(sign * delta))
    return {"name": name, "email": email, "date": dt.isoformat()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="dongjunnan1-jpg/My-project-performance")
    ap.add_argument("--branch", default="main")
    ap.add_argument("--file", default="index.html")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    local_head = git("rev-parse", "HEAD").decode().strip()
    meta, msg = parse_commit(git("cat-file", "commit", local_head))
    parents = meta["parent"].split()
    if len(parents) != 1:
        raise RuntimeError("只支持单父提交，当前 %d 个父提交" % len(parents))

    blob_sha = git("rev-parse", "%s:%s" % (local_head, a.file)).decode().strip()
    blob_bytes = git("cat-file", "blob", blob_sha)
    tree_sha = git("rev-parse", "%s:" % local_head).decode().strip()
    base_tree = git("rev-parse", "%s^:" % local_head).decode().strip()

    print("  本地 HEAD   %s" % local_head)
    print("  blob        %s (%d bytes)" % (blob_sha, len(blob_bytes)))
    print("  tree        %s" % tree_sha)
    print("  parent      %s" % parents[0])

    if a.dry_run:
        print("  --dry-run：未写入远端")
        return 0

    # 1) blob
    got = json.loads(gh(["repos/%s/git/blobs" % a.repo, "--method", "POST"], {
        "content": base64.b64encode(blob_bytes).decode("ascii"),
        "encoding": "base64",
    }))["sha"]
    if got != blob_sha:
        raise RuntimeError("blob 不一致：远端 %s / 本地 %s" % (got, blob_sha))
    print("  ✓ blob 一致")

    # 2) tree
    got = json.loads(gh(["repos/%s/git/trees" % a.repo, "--method", "POST"], {
        "base_tree": base_tree,
        "tree": [{"path": a.file, "mode": "100644", "type": "blob", "sha": blob_sha}],
    }))["sha"]
    if got != tree_sha:
        raise RuntimeError("tree 不一致：远端 %s / 本地 %s" % (got, tree_sha))
    print("  ✓ tree 一致")

    # 3) commit
    got = json.loads(gh(["repos/%s/git/commits" % a.repo, "--method", "POST"], {
        "message": msg.decode(),
        "tree": tree_sha,
        "parents": parents,
        "author": who(meta["author"]),
        "committer": who(meta["committer"]),
    }))["sha"]
    if got != local_head:
        raise RuntimeError("commit 不一致：远端 %s / 本地 %s" % (got, local_head))
    print("  ✓ commit 一致（同一个对象，不是新建的等价提交）")

    # 4) 非强制快进
    gh(["repos/%s/git/refs/heads/%s" % (a.repo, a.branch), "--method", "PATCH",
        "-f", "sha=%s" % local_head, "-F", "force=false"])
    subprocess.run(["git", "update-ref", "refs/remotes/origin/%s" % a.branch, local_head], check=True)
    print("  ✓ refs/heads/%s -> %s" % (a.branch, local_head[:8]))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print("  ✗ %s" % e, file=sys.stderr)
        sys.exit(1)
