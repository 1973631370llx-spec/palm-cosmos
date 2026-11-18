"""look.py — 无图像能力时的眼睛：PNG → ASCII 明度图 + 色相图 + 色彩统计。

用法: python tools/look.py shot.png [cols] [x,y,w,h] [gamma]
"""
import sys
from PIL import Image, ImageStat

path = sys.argv[1]
cols = int(sys.argv[2]) if len(sys.argv) > 2 else 100
crop = tuple(int(v) for v in sys.argv[3].split(',')) if len(sys.argv) > 3 and sys.argv[3] else None
gamma = float(sys.argv[4]) if len(sys.argv) > 4 else 0.6

im = Image.open(path).convert('RGB')
if crop:
    x0, y0, cw, ch = crop
    im = im.crop((x0, y0, x0 + cw, y0 + ch))
w, h = im.size
rows = max(8, int(cols * (h / w) * 0.5))
small = im.resize((cols, rows), Image.LANCZOS)
px = list(small.getdata())

lums = [(0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 for r, g, b in px]
sl = sorted(lums)
lo = sl[int(len(sl) * 0.02)]
hi = max(sl[int(len(sl) * 0.995)], 0.02)

ramp = ' .:-=+*#%@'
lines = []
hue_lines = []
for y in range(rows):
    line = ''
    hline = ''
    for x in range(cols):
        i = y * cols + x
        r, g, b = px[i]
        v = max(0.0, min(1.0, (lums[i] - lo) / (hi - lo))) ** gamma
        line += ramp[min(len(ramp) - 1, int(v * (len(ramp) - 1) + 0.5))]

        mx, mn = max(r, g, b), min(r, g, b)
        sat = (mx - mn) / mx if mx else 0
        if mx < 18:
            hline += ' '
        elif sat < 0.18:
            hline += 'w'
        elif b >= r and g >= r:
            hline += 'c' if g > b * 0.7 else 'b'
        elif r > g and b > g:
            hline += 'm'
        elif r > b:
            hline += 'y'
        else:
            hline += 'b'
    lines.append(line)
    hue_lines.append(hline)

print('\n'.join(lines))
print('\nHUE (w white / c cyan / b blue / m magenta-violet / y warm)')
print('\n'.join(hue_lines))

stat = ImageStat.Stat(im)
print(f'\nSIZE {w}x{h}  MEAN RGB {[round(v,1) for v in stat.mean]}  MAX {im.getextrema()}  autocontrast lo={lo:.3f} hi={hi:.3f}')

hh = im.resize((180, 100)).getcolors(maxcolors=1 << 24)
for count, (r, g, b) in sorted(hh, reverse=True)[:6]:
    print(f'  #{r:02x}{g:02x}{b:02x}  {count}px')

bright = [(x, y) for y in range(0, h, 6) for x in range(0, w, 6) if sum(im.getpixel((x, y))) > 480]
if bright:
    xs = [p[0] for p in bright]
    ys = [p[1] for p in bright]
    print(f'BRIGHT {len(bright)}px  bbox x[{min(xs)},{max(xs)}] y[{min(ys)},{max(ys)}]')
else:
    print('BRIGHT 0')