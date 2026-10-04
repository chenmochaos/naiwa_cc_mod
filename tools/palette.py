#!/usr/bin/env python3
"""奶蛙像素画共用库：抠背景 → 固定色板量化 → 终端格栅。

被 build_art.py / build_laugh.py 共用。手工运行没有意义，直接跑那两个脚本。

为什么用固定色板而不是自适应量化（MEDIANCUT）：
奶蛙的源图是柔和 3D 渐变，自适应量化会在渐变带上凭空造出橄榄色/粉色的脏块。
把每个像素吸附到手挑的 11 色上，出图才「在模型上」。
"""
from __future__ import annotations

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter

# 从参考图取样。索引 5 是主色 #FCDF69。
PALETTE: list[tuple[int, int, int]] = [
    (0x1A, 0x14, 0x10),   # 眼黑
    (0x6B, 0x4A, 0x1E),   # 深阴影
    (0x8A, 0x76, 0x46),   # 四肢 / 最暗黄
    (0xC9, 0x9E, 0x2E),   # 暗黄
    (0xE8, 0xB9, 0x3C),   # 阴影黄
    (0xFC, 0xDF, 0x69),   # 基色（主题色）
    (0xFF, 0xF3, 0xAE),   # 亮黄
    (0xFF, 0xFB, 0xE0),   # 高光
    (0xDF, 0xD2, 0xB0),   # 肚皮阴影
    (0xF8, 0xF0, 0xD8),   # 肚皮奶油
    (0xFF, 0xFF, 0xFF),   # 白
]

TRANSPARENT = 0x01000000  # 终端默认色 / 透明
ALPHA_CUT = 110           # alpha 低于此值算透明


def background_mask(a: np.ndarray, tol: int = 30) -> np.ndarray:
    """从四边洪水填充背景。seed 取边框像素中位数。

    注意：纯色背景里的封闭白块（身体围出来的）填不到，要另外补规则，
    见 `is_white` 的用法。
    """
    h, w, _ = a.shape
    seed = np.median(np.concatenate([a[0], a[-1], a[:, 0], a[:, -1]]), axis=0)
    d = np.abs(a.astype(np.int16) - seed).sum(2)
    mx, mn = a.max(2).astype(np.int16), a.min(2).astype(np.int16)
    soft = (mn > 185) & ((mx - mn) < 45)
    reachable = (d < tol) | soft

    bg = np.zeros((h, w), bool)
    stack: list[tuple[int, int]] = []
    for x in range(w):
        for y in (0, h - 1):
            if reachable[y, x] and not bg[y, x]:
                bg[y, x] = True
                stack.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if reachable[y, x] and not bg[y, x]:
                bg[y, x] = True
                stack.append((y, x))
    while stack:
        y, x = stack.pop()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and not bg[ny, nx] and reachable[ny, nx]:
                bg[ny, nx] = True
                stack.append((ny, nx))
    return bg


def is_white(a: np.ndarray) -> np.ndarray:
    """纯白判定：够亮 且 近中性。

    洪水填充会漏掉被身体围住的封闭白块（头与手臂之间），奶蛙弯腰时那几块
    会糊在脸上成白斑。所有源素材（4 张照片 + 视频）都是纯白影棚背景，
    直接无脑判白即可。
    肚皮奶油是 248/240/216（min=216），下面这条规则不动它。
    """
    mn, mx = a.min(2).astype(np.int16), a.max(2).astype(np.int16)
    return (mn > 235) & ((mx - mn) < 25)


def cutout(a: np.ndarray) -> Image.Image:
    """RGB 数组 → 去背的 RGBA Image，裁到主体 bbox。"""
    bg = background_mask(a) | is_white(a)
    rgba = np.dstack([a, np.where(bg, 0, 255).astype(np.uint8)])
    o = Image.fromarray(rgba, "RGBA")
    bb = o.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox()
    return o.crop(bb) if bb else o


def subject(path: str) -> Image.Image:
    """读图片 → 去背 → 裁到主体。"""
    return cutout(np.asarray(Image.open(path).convert("RGB")))


def prepare(im: Image.Image, sat: float = 1.30) -> Image.Image:
    """缩小前的锐化 + 提饱和，让量化后的色块边界更清楚。"""
    im = im.filter(ImageFilter.UnsharpMask(radius=3, percent=115, threshold=2))
    return ImageEnhance.Color(im).enhance(sat)


def snap_to_palette(im: Image.Image) -> Image.Image:
    """把 RGBA 图每个像素吸附到最近色板色。要求输入带 alpha 通道。"""
    a = np.asarray(im).astype(np.int16)
    rgb, al = a[..., :3], a[..., 3]
    pal = np.array(PALETTE, np.int16)
    d = ((rgb[:, :, None, :].astype(np.int32) - pal[None, None, :, :].astype(np.int32)) ** 2).sum(-1)
    return Image.fromarray(
        np.dstack([pal[d.argmin(-1)].astype(np.uint8), al.astype(np.uint8)]), "RGBA"
    )


def fit(im: Image.Image, w: int, h: int) -> Image.Image:
    """等比缩放并居中到 w×h 透明画布（不拉伸）。"""
    ar, tar = im.width / im.height, w / h
    if ar > tar:
        nw, nh = w, max(1, round(w / ar))
    else:
        nh, nw = h, max(1, round(h * ar))
    canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    canvas.paste(im.resize((nw, nh), Image.LANCZOS), ((w - nw) // 2, (h - nh) // 2))
    return canvas


def to_grid(im: Image.Image, cols: int, rows: int, cut: int = ALPHA_CUT) -> list[list[int]]:
    """RGBA 图 → `rows*2` 行 × `cols` 列的 0xRRGGBB 网格（一行终端格 = 两像素行）。

    这不是 Raster 的最终格式 —— Raster 用 `▀` 半块逐格编码，
    由 register.tsx 的 `sprite()` 现算，跟雨姐 mod 一致。
    """
    a = np.asarray(snap_to_palette(fit(im, cols, rows * 2))).astype(np.int32)
    return [
        [TRANSPARENT if a[y, x, 3] < cut else (a[y, x, 0] << 16) | (a[y, x, 1] << 8) | a[y, x, 2]
         for x in range(cols)]
        for y in range(rows * 2)
    ]


def render(path_or_array, cols: int, rows: int, box: tuple[float, float, float, float] | None = None,
           cut: int = ALPHA_CUT) -> list[list[int]]:
    """图片路径（或 RGB 数组）+ 可选裁剪框（占主体的比例）→ 网格。"""
    im = cutout(path_or_array) if isinstance(path_or_array, np.ndarray) else subject(str(path_or_array))
    if box is not None:
        l, t, r, b = box
        im = im.crop((int(l * im.width), int(t * im.height), int(r * im.width), int(b * im.height)))
    return to_grid(prepare(im), cols, rows, cut)


def to_ansi(grid: list[list[int]]) -> str:
    """网格 → ANSI 转义串（终端实拍用，也方便人工核对）。"""
    def cell(t: int, b: int) -> str:
        if t == TRANSPARENT and b == TRANSPARENT:
            return "\x1b[0m "
        if t == TRANSPARENT:
            return f"\x1b[0m\x1b[38;2;{b >> 16 & 255};{b >> 8 & 255};{b & 255}m▄"
        if b == TRANSPARENT:
            return f"\x1b[0m\x1b[38;2;{t >> 16 & 255};{t >> 8 & 255};{t & 255}m▀"
        return (f"\x1b[38;2;{t >> 16 & 255};{t >> 8 & 255};{t & 255}m"
                f"\x1b[48;2;{b >> 16 & 255};{b >> 8 & 255};{b & 255}m▀")

    h2, w = len(grid), len(grid[0])
    return "\n".join(
        "".join(cell(grid[y * 2][x], grid[y * 2 + 1][x]) for x in range(w)) for y in range(h2 // 2)
    ) + "\x1b[0m\n"


def preview(grid: list[list[int]], cell: int = 10, bg: tuple[int, int, int] = (24, 24, 28)) -> Image.Image:
    """网格 → 放大 PNG（人工核对用，不进产物）。"""
    h2, w = len(grid), len(grid[0])
    out = Image.new("RGB", (w * cell, (h2 // 2) * cell), bg)
    px = out.load()
    for cy in range(h2 // 2):
        for cx in range(w):
            t, b = grid[cy * 2][cx], grid[cy * 2 + 1][cx]
            for dy in range(cell):
                for dx in range(cell):
                    if t == TRANSPARENT and b == TRANSPARENT:
                        v = bg
                    elif t == TRANSPARENT:
                        v = bg if dy < cell // 2 else ((b >> 16) & 255, (b >> 8) & 255, b & 255)
                    elif b == TRANSPARENT:
                        v = ((t >> 16) & 255, (t >> 8) & 255, t & 255) if dy < cell // 2 else bg
                    else:
                        c = t if dy < cell // 2 else b
                        v = ((c >> 16) & 255, (c >> 8) & 255, c & 255)
                    px[cx * cell + dx, cy * cell + dy] = v
    return out
