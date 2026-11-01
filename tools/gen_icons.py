# -*- coding: utf-8 -*-
"""
橙果图标库生成脚本
------------------------------------------------------------------
设计规范（全站唯一来源，改风格只改这里）：
  · 网格 24×24，所有图形绘制在 3~21 的 18 单位光学框内 → 视觉大小一致
  · 线宽统一 1.75（≈ 图标短边的 7%），圆头圆角，不填充
  · 颜色集中定义在 PALETTE，图标按需生成多色版本
  · 4 倍超采样后 LANCZOS 缩小，边缘平滑无锯齿
输出：assets/icons/<name>-<color>.png（72px，适配 3x 屏）+ utils/icons.js 映射表
"""
import os
from PIL import Image, ImageDraw

U = 24            # 设计网格
PX = 72           # 输出像素
SS = 4            # 超采样倍数
SC = PX * SS / U  # 每单位像素
SW = 1.75 * SC    # 统一线宽

PALETTE = {
    'ink':    '#4A4A4A',
    'gray':   '#9C948A',
    'orange': '#E8590C',
    'white':  '#FFFFFF',
    'red':    '#D9534F',
}

COL = PALETTE['ink']


def pt(p):
    return (p[0] * SC, p[1] * SC)


def line(d, pts, close=False):
    """折线：圆头端点 + 圆滑拐角"""
    seq = [pt(p) for p in pts]
    if close:
        seq = seq + [seq[0]]
    d.line(seq, fill=COL, width=int(SW), joint='curve')
    r = SW / 2
    for p in seq if close else (seq[0], seq[-1]):
        d.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=COL)


def rrect(d, x1, y1, x2, y2, rad):
    d.rounded_rectangle([x1 * SC, y1 * SC, x2 * SC, y2 * SC],
                        radius=rad * SC, outline=COL, width=int(SW))


def circle(d, cx, cy, r):
    d.ellipse([(cx - r) * SC, (cy - r) * SC, (cx + r) * SC, (cy + r) * SC],
              outline=COL, width=int(SW))


def arc(d, cx, cy, r, start, end):
    d.arc([(cx - r) * SC, (cy - r) * SC, (cx + r) * SC, (cy + r) * SC],
          start, end, fill=COL, width=int(SW))


# ---------------------------------------------------------------- 图标定义
def i_camera(d):
    rrect(d, 3, 7, 21, 20.5, 3)
    line(d, [(8.6, 7), (9.6, 4.6), (14.4, 4.6), (15.4, 7)])
    circle(d, 12, 13.6, 3.7)


def i_album(d):
    rrect(d, 3, 4, 21, 20, 3)
    circle(d, 8.7, 9.4, 1.7)
    line(d, [(3.9, 17.4), (9, 12), (12.4, 15.4), (15, 12.8), (20.1, 18)])


def i_search(d):
    circle(d, 11, 11, 6.2)
    line(d, [(15.6, 15.6), (20.4, 20.4)])


def i_audio(d):
    arc(d, 12, 14, 8, 180, 360)
    rrect(d, 4, 13.4, 8.2, 20.4, 2.1)
    rrect(d, 15.8, 13.4, 20, 20.4, 2.1)


def i_mic(d):
    rrect(d, 8.8, 2.8, 15.2, 14, 3.2)
    arc(d, 12, 11, 7, 0, 180)
    line(d, [(12, 18.2), (12, 21.2)])


def i_play(d):
    line(d, [(8.6, 5.4), (19, 12), (8.6, 18.6)], close=True)


def i_pause(d):
    line(d, [(9.6, 5.4), (9.6, 18.6)])
    line(d, [(14.4, 5.4), (14.4, 18.6)])


def i_edit(d):
    line(d, [(3.6, 20.4), (4.8, 16.4), (16.6, 4.6), (19.4, 7.4), (7.6, 19.2), (3.6, 20.4)], close=True)
    line(d, [(4.8, 16.4), (7.6, 19.2)])


def i_trash(d):
    line(d, [(3.6, 6.8), (20.4, 6.8)])
    line(d, [(9.4, 6.8), (9.4, 4.6), (14.6, 4.6), (14.6, 6.8)])
    rrect(d, 6, 6.8, 18, 20.4, 2)
    line(d, [(10.2, 10.6), (10.2, 16.6)])
    line(d, [(13.8, 10.6), (13.8, 16.6)])


def i_close(d):
    line(d, [(6.4, 6.4), (17.6, 17.6)])
    line(d, [(17.6, 6.4), (6.4, 17.6)])


def i_check(d):
    line(d, [(4.6, 12.6), (9.8, 18), (19.6, 5.8)])


def i_plus(d):
    line(d, [(12, 4.8), (12, 19.2)])
    line(d, [(4.8, 12), (19.2, 12)])


def i_chevron(d):
    line(d, [(9.6, 4.8), (16.6, 12), (9.6, 19.2)])


def i_chevron_down(d):
    line(d, [(4.8, 9.4), (12, 16.4), (19.2, 9.4)])


def i_user(d):
    circle(d, 12, 8, 3.9)
    arc(d, 12, 21.5, 8.5, 180, 360)


def i_users(d):
    circle(d, 9.4, 8.4, 3.4)
    arc(d, 9.4, 21, 7.6, 180, 360)
    circle(d, 17, 9.4, 2.6)
    arc(d, 17.4, 21.4, 6, 205, 335)


def i_send(d):
    line(d, [(2.9, 11.8), (21.1, 3.7), (14.2, 21.1), (11.4, 13.4), (2.9, 11.8)], close=True)
    line(d, [(11.4, 13.4), (21.1, 3.7)])


def i_calendar(d):
    rrect(d, 3, 5.5, 21, 20.5, 3)
    line(d, [(3, 10.2), (21, 10.2)])
    line(d, [(8.2, 3), (8.2, 7.2)])
    line(d, [(15.8, 3), (15.8, 7.2)])


def i_clock(d):
    circle(d, 12, 12, 8.4)
    line(d, [(12, 7), (12, 12), (15.6, 14)])


def i_chart(d):
    line(d, [(3.2, 19.8), (20.8, 19.8)])
    line(d, [(7, 19.8), (7, 12)])
    line(d, [(12, 19.8), (12, 7.4)])
    line(d, [(17, 19.8), (17, 15.4)])


def i_home(d):
    line(d, [(2.9, 11.6), (12, 3.2), (21.1, 11.6)])
    line(d, [(5.2, 10.4), (5.2, 20.6), (18.8, 20.6), (18.8, 10.4)])


def i_doc(d):
    rrect(d, 5, 3, 19, 21, 2.4)
    line(d, [(8.8, 8.6), (15.2, 8.6)])
    line(d, [(8.8, 12.6), (15.2, 12.6)])
    line(d, [(8.8, 16.6), (12.6, 16.6)])


def i_filter(d):
    line(d, [(3.6, 4.6), (20.4, 4.6), (14, 12.6), (14, 20), (10, 17.6), (10, 12.6), (3.6, 4.6)], close=True)


def i_tpl(d):
    """模板：三行列表 + 勾选框"""
    rrect(d, 3.2, 4.2, 20.8, 19.8, 2.6)
    line(d, [(7.4, 9.2), (9.4, 11.2), (12.6, 7.6)])
    line(d, [(7.4, 15), (9.4, 17), (12.6, 13.4)])
    line(d, [(15, 10.2), (17.6, 10.2)])
    line(d, [(15, 16), (17.6, 16)])


ICONS = {
    'camera': i_camera, 'album': i_album, 'search': i_search, 'audio': i_audio,
    'mic': i_mic, 'play': i_play, 'pause': i_pause, 'edit': i_edit,
    'trash': i_trash, 'close': i_close, 'check': i_check, 'plus': i_plus,
    'chevron': i_chevron, 'chevron-down': i_chevron_down, 'user': i_user,
    'users': i_users, 'send': i_send, 'calendar': i_calendar, 'clock': i_clock,
    'chart': i_chart, 'home': i_home, 'doc': i_doc, 'filter': i_filter, 'tpl': i_tpl,
}

# 按需生成的配色（只做实际用得到的组合，避免文件冗余）
VARIANTS = {
    'camera': ['ink', 'orange'],
    'album': ['ink'],
    'search': ['gray', 'ink'],
    'audio': ['gray', 'orange'],
    'mic': ['orange', 'white', 'ink'],
    'play': ['orange', 'white', 'ink'],
    'pause': ['orange', 'white', 'ink'],
    'edit': ['ink', 'orange'],
    'trash': ['red', 'ink'],
    'close': ['gray', 'ink', 'white'],
    'check': ['white', 'orange', 'ink'],
    'plus': ['orange', 'ink', 'white'],
    'chevron': ['gray', 'ink'],
    'chevron-down': ['gray', 'ink'],
    'user': ['gray', 'ink'],
    'users': ['ink', 'orange'],
    'send': ['white', 'orange', 'ink'],
    'calendar': ['gray', 'ink'],
    'clock': ['gray', 'ink'],
    'chart': ['ink', 'orange'],
    'home': ['gray', 'orange'],
    'doc': ['gray', 'orange'],
    'filter': ['gray', 'ink'],
    'tpl': ['ink', 'orange'],
}

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'icons')


def hex2rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4)) + (255,)


def main():
    global COL
    os.makedirs(OUT, exist_ok=True)
    n = 0
    for name, fn in ICONS.items():
        for vk in VARIANTS[name]:
            COL = hex2rgb(PALETTE[vk])
            big = Image.new('RGBA', (PX * SS, PX * SS), (0, 0, 0, 0))
            d = ImageDraw.Draw(big)
            fn(d)
            small = big.resize((PX, PX), Image.LANCZOS)
            small.save(os.path.join(OUT, '%s-%s.png' % (name, vk)))
            n += 1
    print('生成 %d 个图标 → %s' % (n, os.path.normpath(OUT)))


if __name__ == '__main__':
    main()
