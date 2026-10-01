#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
scripts/make-icons.py — 生成两套客户端所需的全部图标（Tauri 打包要求 icons/ 齐全）

Tauri 默认读取：32x32.png / 128x128.png / 128x128@2x.png / icon.png / icon.ico / icon.icns
· PNG/ICO 用 Pillow 生成
· ICNS 手写容器（ic07/ic08/ic09 = 128/256/512 的 PNG 载荷）—— Pillow 不支持写 ICNS

设计：圆角方形底 + 白色简笔（积分 + 对勾），颜色区分教师端（靛蓝）与学生端（青绿）。
用法：python scripts/make-icons.py
"""
import os
import struct
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SIZE = 1024

APPS = {
    'teacher': {'bg': (63, 81, 181), 'fg': (255, 255, 255)},   # 靛蓝
    'student': {'bg': (0, 137, 123), 'fg': (255, 255, 255)},   # 青绿
}


def rounded_base(size, bg):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = int(size * 0.22)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=bg)
    return img


def draw_mark(img, fg, mode):
    """画一个简洁标记：一个小积分牌（短横线列表）+ 对勾"""
    size = img.size[0]
    d = ImageDraw.Draw(img)
    w = int(size * 0.075)
    x0 = int(size * 0.26)
    y = int(size * 0.30)
    gap = int(size * 0.135)
    lengths = [0.30, 0.30, 0.30] if mode == 'teacher' else [0.30, 0.30]
    for i, ln in enumerate(lengths):
        d.line([x0, y + i * gap, x0 + int(size * ln), y + i * gap], fill=fg, width=w)
    # 对勾
    cx, cy = int(size * 0.60), int(size * 0.68)
    d.line([cx - int(size * 0.14), cy, cx - int(size * 0.04), cy + int(size * 0.11)], fill=fg, width=w)
    d.line([cx - int(size * 0.04), cy + int(size * 0.11), cx + int(size * 0.20), cy - int(size * 0.16)], fill=fg, width=w)
    return img


def png(img, path, size):
    img.resize((size, size), Image.LANCZOS).save(path, 'PNG')
    print('  [png] ' + os.path.relpath(path, ROOT) + '  ' + str(size) + 'px')


def icns(images, path):
    """手写 ICNS：ic07=128, ic08=256, ic09=512"""
    entries = []
    for fourcc, size in (('ic07', 128), ('ic08', 256), ('ic09', 512)):
        tmp = os.path.join(os.path.dirname(path), '_tmp_%d.png' % size)
        images.resize((size, size), Image.LANCZOS).save(tmp, 'PNG')
        with open(tmp, 'rb') as f:
            data = f.read()
        os.remove(tmp)
        entries.append((fourcc, data))
    body = b''
    for fourcc, data in entries:
        body += fourcc.encode('ascii') + struct.pack('>I', len(data) + 8) + data
    with open(path, 'wb') as f:
        f.write(b'icns' + struct.pack('>I', len(body) + 8) + body)
    print('  [icns] ' + os.path.relpath(path, ROOT) + '  (128/256/512 layers)')


def main():
    base = rounded_base(SIZE, (255, 255, 255))
    for app, colors in APPS.items():
        out_dir = os.path.join(ROOT, 'apps', app, 'src-tauri', 'icons')
        os.makedirs(out_dir, exist_ok=True)
        print(app + ':')
        img = rounded_base(SIZE, colors['bg'])
        draw_mark(img, colors['fg'], app)

        png(img, os.path.join(out_dir, '32x32.png'), 32)
        png(img, os.path.join(out_dir, '128x128.png'), 128)
        png(img, os.path.join(out_dir, '128x128@2x.png'), 256)
        png(img, os.path.join(out_dir, 'icon.png'), 512)
        img.resize((256, 256), Image.LANCZOS).save(
            os.path.join(out_dir, 'icon.ico'),
            sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
        print('  [ico] ' + os.path.relpath(os.path.join(out_dir, 'icon.ico'), ROOT) + '  (6 sizes)')
        icns(img, os.path.join(out_dir, 'icon.icns'))
    print('\ndone: icons generated for both clients (teacher=indigo, student=teal)')


if __name__ == '__main__':
    main()
