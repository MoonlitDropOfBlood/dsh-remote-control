"""扫描 Kotlin 源码里的「块注释标记嵌套/提前闭合」问题。

Kotlin 的块注释**可嵌套**（与 Java 不同）：注释正文里出现 `/*` 会再开一层，
出现 `*/` 会关掉最近一层 → 正文里的 `*/` 会**提前闭合**外层注释，
正文里的 `/*` 会让外层**永不闭合**（编译报 Unclosed comment）。
本仓已因此踩坑两次（core/AttachmentPlan.kt、app/Theme.kt）。

用法：python tools/scan-kotlin-comments.py <根目录>
"""
import io
import os
import sys

BACKSLASH = chr(92)


def scan(path):
    s = io.open(path, encoding="utf-8").read()
    n = len(s)
    i = 0
    line = 1
    issues = []
    while i < n:
        c = s[i]
        if c == "\n":
            line += 1
            i += 1
            continue
        if s.startswith("//", i):
            j = s.find("\n", i)
            i = n if j < 0 else j
            continue
        if s.startswith("/*", i):
            start_line = line
            depth = 1
            j = i + 2
            while j < n and depth > 0:
                if s.startswith("/*", j):
                    depth += 1
                    issues.append((start_line, "嵌套 /*（外层永不闭合）"))
                    j += 2
                    continue
                if s.startswith("*/", j):
                    depth -= 1
                    if depth > 0:
                        issues.append((start_line, "嵌套 */（提前闭合外层）"))
                    j += 2
                    continue
                if s[j] == "\n":
                    line += 1
                j += 1
            if depth > 0:
                issues.append((start_line, "块注释未闭合（EOF）"))
            else:
                # 块注释**提前闭合**：注释在同一行后面还有正文 → 后面的内容会被当代码解析
                tail_end = s.find("\n", j)
                if tail_end < 0:
                    tail_end = n
                tail = s[j:tail_end].strip()
                if tail and not tail.startswith("//"):
                    issues.append((start_line, "块注释提前闭合（同一行后面还有正文）"))
            i = j
            continue
        if c == '"':
            if s.startswith('"""', i):
                j = s.find('"""', i + 3)
                if j < 0:
                    j = n
                line += s.count("\n", i, j)
                i = j + 3
                continue
            j = i + 1
            while j < n:
                if s[j] == BACKSLASH:
                    j += 2
                    continue
                if s[j] == '"' or s[j] == "\n":
                    break
                j += 1
            i = j + 1
            continue
        if c == "'":
            j = i + 1
            while j < n and s[j] != "'":
                if s[j] == BACKSLASH:
                    j += 2
                    continue
                j += 1
            i = j + 1
            continue
        i += 1
    return issues


def main():
    roots = sys.argv[1:] or ["."]
    total = 0
    for root in roots:
        for dirpath, _, files in os.walk(root):
            parts = dirpath.split(os.sep)
            if "build" in parts or ".gradle" in parts or ".kotlin" in parts:
                continue
            for name in files:
                if not name.endswith(".kt"):
                    continue
                path = os.path.join(dirpath, name)
                lines = io.open(path, encoding="utf-8").read().split("\n")
                for start_line, kind in scan(path):
                    text = lines[start_line - 1].strip()[:110]
                    print("%s:%d [%s] %s" % (path, start_line, kind, text))
                    total += 1
    print("issues: %d" % total)


if __name__ == "__main__":
    main()
