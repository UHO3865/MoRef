"""assets/logo-source.png (흰 바탕 검은 로고) → 앱 아이콘들.

  assets/icon.ico         창 · 작업 표시줄 · 바로가기 (흰 둥근 타일 + 검은 로고, 16~256px)
  assets/icon.png         512px 같은 모양
  src/renderer/logo.png   제목 표시줄용 (어두운 UI 위에 올리는 흰 로고, 투명 배경)

로고를 바꾸려면 logo-source.png 를 교체하고 `python scripts/make-icons.py` 를 다시 실행.
"""
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageOps

root = Path(__file__).resolve().parent.parent
src = Image.open(root / 'assets' / 'logo-source.png').convert('RGBA')

# 흰 배경 위 그림 → 알파 마스크 (어두울수록 불투명). 투명 영역은 흰색으로 본다.
bg = Image.new('RGBA', src.size, (255, 255, 255, 255))
gray = ImageOps.grayscale(Image.alpha_composite(bg, src))
mask = ImageOps.invert(gray)
mask = mask.point(lambda v: 0 if v < 24 else min(255, int((v - 24) * 255 / 200)))  # 바탕의 잡티 제거
mask = mask.crop(mask.getbbox())


def logo(color, size, pad):
    """정사각형 캔버스 가운데에 로고를 그린다 (pad = 여백 비율)."""
    inner = round(size * (1 - 2 * pad))
    w, h = mask.size
    scale = inner / max(w, h)
    m = mask.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    fill = Image.new('RGBA', m.size, color)
    out.paste(fill, ((size - m.width) // 2, (size - m.height) // 2), m)
    return out


def tile(size):
    """흰 둥근 타일 + 검은 로고. 4배로 그려서 줄여 가장자리를 매끈하게."""
    big = size * 4
    t = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    ImageDraw.Draw(t).rounded_rectangle((0, 0, big - 1, big - 1), radius=round(big * 0.22), fill=(255, 255, 255, 255))
    pad = 0.16 if size >= 32 else 0.1  # 작은 크기는 로고를 크게
    t = Image.alpha_composite(t, logo((17, 17, 17, 255), big, pad))
    return t.resize((size, size), Image.LANCZOS)


assets = root / 'assets'
sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
tiles = [tile(s) for s in sizes]
tiles[-1].save(assets / 'icon.ico', sizes=[(s, s) for s in sizes], append_images=tiles[:-1])
tile(512).save(assets / 'icon.png')
logo((255, 255, 255, 255), 128, 0.02).save(root / 'src' / 'renderer' / 'logo.png')
print('icons written:', ', '.join(str(p.relative_to(root)) for p in [assets / 'icon.ico', assets / 'icon.png', root / 'src/renderer/logo.png']))
