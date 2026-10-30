"""Blender 애드온 zip 만들기: blender/refboard_dock.zip 과 dist/MoRef-Blender-Addon-<버전>.zip (릴리즈용)

    python scripts/make-addon-zip.py
"""
import json
import os
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "blender", "refboard_dock", "__init__.py")


def write(out):
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(SRC, "refboard_dock/__init__.py")
    print(out)


version = json.load(open(os.path.join(ROOT, "package.json"), encoding="utf8"))["version"]
write(os.path.join(ROOT, "blender", "refboard_dock.zip"))
write(os.path.join(ROOT, "dist", f"MoRef-Blender-Addon-{version}.zip"))
