"""用 uiautomator dump 精确定位 Compose 控件并操作（避免键盘弹出导致布局位移）。

用法：
  python tools/adb-ui.py dump                     # 打印当前界面所有可点击/可输入节点
  python tools/adb-ui.py tap "中继地址"            # 按文本/描述点击
  python tools/adb-ui.py type "中继地址" "ws://…"  # 定位输入框 → 聚焦 → 输入
"""
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

ADB = r"C:\Users\wwhby\AppData\Local\Android\Sdk\platform-tools\adb.exe"


def sh(args, binary=False):
    r = subprocess.run([ADB] + args, capture_output=True)
    out = r.stdout
    return out if binary else out.decode("utf-8", "replace")


def dump():
    """返回 (xml, path)。"""
    remote = "/sdcard/uidump.xml"
    sh(["shell", "uiautomator", "dump", remote])
    xml = sh(["shell", "cat", remote])
    return xml


def nodes(xml):
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return []
    out = []
    for n in root.iter("node"):
        out.append(
            {
                "text": n.get("text", ""),
                "desc": n.get("content-desc", ""),
                "cls": n.get("class", ""),
                "clickable": n.get("clickable") == "true",
                "editable": n.get("editable") == "true",
                "bounds": n.get("bounds", ""),
            }
        )
    return out


def center(bounds):
    m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", bounds)
    if not m:
        return None
    x1, y1, x2, y2 = (int(v) for v in m.groups())
    return (x1 + x2) // 2, (y1 + y2) // 2


def find(target, xml=None, prefer_editable=False):
    xml = xml or dump()
    ns = nodes(xml)
    if prefer_editable:
        # 先在可编辑节点里找（避免命中「在下方输入提示词…」这类说明文案）
        for n in ns:
            if n["editable"] and (target == n["text"] or target == n["desc"] or target in n["text"] or target in n["desc"]):
                return n
    for n in ns:
        if target == n["text"] or target == n["desc"]:
            return n
    for n in ns:
        if target in n["text"] or target in n["desc"]:
            return n
    return None


def find_editable_any(xml=None):
    """页面上唯一/第一个可编辑节点（Compose 的 hint 是 TextView，EditText 自身 text 为空）。"""
    ns = nodes(xml or dump())
    eds = [n for n in ns if n["editable"]]
    return eds[0] if eds else None


def tap(target):
    n = find(target)
    if not n:
        print("not found:", target)
        return False
    c = center(n["bounds"])
    sh(["shell", "input", "tap", str(c[0]), str(c[1])])
    print("tapped", target, c)
    time.sleep(1.2)
    return True


def type_text(target, text):
    xml = dump()
    n = find(target, xml, prefer_editable=True)
    if not n:
        # hint 是 TextView，EditText 自身 text 为空 → 退回到页面上的可编辑节点
        n = find_editable_any(xml)
        if not n:
            print("not found:", target)
            return False
    c = center(n["bounds"])
    sh(["shell", "input", "tap", str(c[0]), str(c[1])])
    time.sleep(1.2)
    sh(["shell", "input", "text", text])
    time.sleep(1.0)
    # 校验：文本是否真的进了输入框
    after = [x for x in nodes(dump()) if x["editable"] and x["text"]]
    ok = any(text[:12] in x["text"] for x in after)
    # 只在**键盘确实可见**时才按 BACK 收键盘；否则 BACK 会把页面退回去
    if "mInputShown=true" in sh(["shell", "dumpsys", "input_method"]):
        sh(["shell", "input", "keyevent", "4"])
        time.sleep(0.8)
    print("typed into", target, "->", text, "| input verified:", ok)
    if not ok:
        print("  editable nodes:", [(x["text"], x["bounds"]) for x in after])
    return ok


def clear_field(target):
    """点进输入框 → 光标移到末尾 → 逐字符删除（清空）。"""
    n = find(target)
    if not n:
        print("not found:", target)
        return False
    c = center(n["bounds"])
    sh(["shell", "input", "tap", str(c[0]), str(c[1])])
    time.sleep(1.0)
    sh(["shell", "input", "keyevent", "123"])  # MOVE_END
    time.sleep(0.4)
    # 一次 keyevent 可带多个 keycode：67 = KEYCODE_DEL
    sh(["shell", "input", "keyevent"] + ["67"] * 120)
    time.sleep(1.0)
    # 只在**键盘确实可见**时才按 BACK 收键盘；否则 BACK 会把页面退回去
    if "mInputShown=true" in sh(["shell", "dumpsys", "input_method"]):
        sh(["shell", "input", "keyevent", "4"])
        time.sleep(0.8)
    print("cleared:", target)
    return True


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    cmd = sys.argv[1]
    if cmd == "dump":
        for n in nodes(dump()):
            if n["text"] or n["desc"]:
                print("%-6s %-40s %s" % (n["cls"].split(".")[-1], n["text"] or n["desc"], n["bounds"]))
    elif cmd == "tap":
        tap(sys.argv[2])
    elif cmd == "type":
        type_text(sys.argv[2], sys.argv[3])
    elif cmd == "clear":
        clear_field(sys.argv[2])
    elif cmd == "set":
        clear_field(sys.argv[2])
        type_text(sys.argv[2], sys.argv[3])
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
