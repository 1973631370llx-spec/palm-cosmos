"""qr.py — 把分享网址做成深空风二维码 PNG。

用法：python tools/qr.py https://xxx.trycloudflare.com shots/share-qr.png
依赖：segno（E:\\DSH\\tools\\pylibs）
"""
import sys
import os

sys.path.insert(0, r"E:\DSH\tools\pylibs")
import segno  # noqa: E402

url = sys.argv[1] if len(sys.argv) > 1 else "https://127.0.0.1:4173/"
out = sys.argv[2] if len(sys.argv) > 2 else "shots/share-qr.png"
os.makedirs(os.path.dirname(out) or ".", exist_ok=True)

qr = segno.make(url, error="m")
qr.save(
    out,
    scale=10,
    border=4,
    dark="#030409",
    light="#FFF6E8",
    kind="png",
)
print(out, url)