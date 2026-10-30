"""MoRef 연결 - 데스크톱 MoRef(영상 레퍼런스 보드)를 Blender 와 이어 준다.

MoRef 는 따로 띄운 데스크톱 창 그대로 쓰고(항상 위 / 투명도로 Blender 위에 둘 수 있다), 이 애드온은 둘을 잇기만 한다.

  * 연결: MoRef 가 켜질 때 %APPDATA%\\MoRef\\blender-link.json 에 포트와 일회용 토큰을 적어 둔다.
    애드온은 이 파일을 보고 127.0.0.1 로 접속한다. 어느 쪽을 먼저 켜도 되고, 다시 켜면 다시 잇는다.
  * 타임라인: 현재 프레임 / fps / 재생 중 여부를 보낸다. MoRef 에서 🔗(Blender 타임라인에 맞추기)를 켠
    레퍼런스가 따라 움직인다.
  * 구간 반복: 맞춘 레퍼런스에 반복 구간이 있으면 씬의 미리보기 범위를 그 구간으로 바꿔 Blender 재생도 같은
    구간을 돈다. 구간을 끄거나 연결이 끊기면 원래 미리보기 범위로 되돌린다.
  * 재생: 맞춘 레퍼런스에서 Space / 재생 버튼을 누르면 Blender 재생을 켜고 끈다.
  * 카메라 배경: MoRef 에서 영상을 보내면 활성 카메라의 배경 영상(무비 클립)으로 넣는다.
  * 열기: 상단 바의 MoRef 버튼 / Ctrl+Alt+R / 3D 뷰 사이드바(N) ▸ MoRef.
    MoRef 가 꺼져 있으면 켜고, 켜져 있으면 앞으로 가져온다.
"""

bl_info = {
    "name": "MoRef 연결",
    "author": "MoRef",
    "version": (0, 5, 0),
    "blender": (4, 2, 0),
    "location": "상단 바 MoRef 버튼 · Ctrl+Alt+R · 3D 뷰 사이드바(N) ▸ MoRef",
    "description": "데스크톱 MoRef 영상 레퍼런스 보드와 Blender 타임라인 / 구간 반복 / 재생 / 카메라 배경을 연결",
    "category": "Interface",
}

import json
import os
import select
import socket
import subprocess
import sys
import time

import bpy
from bpy.app.handlers import persistent

IS_WIN = sys.platform == "win32"
TICK = 0.1
RETRY = 1.0  # 연결이 없을 때 다시 찾는 간격 (초)


class _State:
    sock = None  # MoRef 연결 (양방향)
    rbuf = b""
    next_try = 0.0
    last_sent = None  # 마지막으로 보낸 타임라인 상태
    preview_saved = None  # 구간 반복 전의 (미리보기 범위 사용, 시작, 끝) - 되돌리기용
    launched_at = 0.0  # 마지막으로 MoRef 를 켠 시각 (여는 중 표시)


S = _State()


def _prefs():
    return bpy.context.preferences.addons[__package__ or __name__].preferences


def _user_data():
    base = os.environ.get("APPDATA") or os.path.join(os.path.expanduser("~"), ".config")
    new = os.path.join(base, "MoRef")
    return new if os.path.isdir(new) else os.path.join(base, "refboard")  # 이름을 바꾸기 전(RefBoard) 폴더


def _find_refboard():
    """MoRef 를 켤 명령 [실행 파일, 인자…] 과 어디서 찾았는지. 못 찾으면 (None, 이유)
      1. MoRef 가 켜질 때마다 적어 두는 위치 (app-path.json)
      2. 설치 프로그램의 기본 설치 위치
      3. 애드온 설정의 MoRef 소스 폴더 (개발용)"""
    try:
        with open(os.path.join(_user_data(), "app-path.json"), encoding="utf8") as f:
            info = json.load(f)
        if os.path.isfile(info["exe"]):
            return [info["exe"], *info.get("args", [])], "마지막으로 실행한 MoRef"
    except (OSError, ValueError, KeyError):
        pass
    local = os.environ.get("LOCALAPPDATA", "")
    for exe in (
        os.path.join(local, "Programs", "MoRef", "MoRef.exe"),
        os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "MoRef", "MoRef.exe"),
        os.path.join(local, "Programs", "RefBoard", "RefBoard.exe"),  # 이름을 바꾸기 전 설치판
    ):
        if os.path.isfile(exe):
            return [exe], "설치된 MoRef"
    root = bpy.path.abspath(_prefs().refboard_dir).rstrip("\\/")
    exe = os.path.join(root, "node_modules", "electron", "dist", "electron.exe" if IS_WIN else "electron")
    if root and os.path.isfile(exe):
        return [exe, root], "소스 폴더"
    return None, "MoRef 를 찾을 수 없습니다 - MoRef 를 설치해서 한 번 실행하거나, 애드온 설정에서 소스 폴더를 지정하세요"


def _link_file():
    return os.path.join(_user_data(), "blender-link.json")


def _connected():
    return S.sock is not None


def _redraw_ui():
    wm = bpy.context.window_manager
    for w in wm.windows:
        for a in w.screen.areas:
            if a.type in ("TOPBAR", "VIEW_3D"):
                a.tag_redraw()


# ---------------------------------------------------------------------------
# 연결
# ---------------------------------------------------------------------------


def _close_sock():
    was = S.sock is not None
    if S.sock is not None:
        try:
            S.sock.close()
        except OSError:
            pass
        S.sock = None
    S.rbuf = b""
    if was:
        try:
            _set_loop_range(None)  # 구간에 맞춰 바꾼 미리보기 범위를 원래대로
        except Exception as e:
            print("MoRef: 미리보기 범위 복원 실패", e)
        _redraw_ui()


def _send(line):
    if S.sock is None:
        return False
    try:
        S.sock.sendall((line.replace("\n", " ") + "\n").encode("utf8"))
        return True
    except OSError:
        _close_sock()
        return False


def _toast(text):
    print("MoRef:", text)
    _send("toast " + text)


def _hello():
    name = os.path.basename(bpy.data.filepath) or "저장 안 된 파일"
    _send("hello " + name)


def _try_connect():
    now = time.monotonic()
    if now < S.next_try:
        return
    S.next_try = now + RETRY
    try:
        with open(_link_file(), encoding="utf8") as f:
            info = json.load(f)
        sock = socket.create_connection(("127.0.0.1", int(info["port"])), timeout=0.3)
    except (OSError, ValueError, KeyError):
        return  # MoRef 가 꺼져 있다
    try:
        sock.sendall(f"auth {info['token']}\n".encode())
        sock.settimeout(0.05)  # Blender 가 멈추지 않도록 짧게
    except OSError:
        sock.close()
        return
    S.sock = sock
    S.rbuf = b""
    S.last_sent = None  # 연결되면 지금 상태를 바로 보낸다
    _hello()
    _send_timeline()
    _redraw_ui()


def _poll_incoming():
    """MoRef 가 보낸 줄을 읽는다 (막히지 않게 select 로 확인만)"""
    if S.sock is None:
        return
    try:
        ready, _w, _x = select.select([S.sock], [], [], 0)
        if not ready:
            return
        data = S.sock.recv(65536)
    except OSError:
        data = b""
    if not data:
        _close_sock()  # MoRef 를 껐다
        return
    S.rbuf += data
    while b"\n" in S.rbuf:
        raw, S.rbuf = S.rbuf.split(b"\n", 1)
        line = raw.decode("utf8", "replace").strip()
        try:
            _handle_line(line)
        except Exception as e:  # 한 줄이 잘못돼도 연결은 유지
            print("MoRef: 처리 실패", line[:80], e)


def _handle_line(line):
    if line == "want play":
        toggle_play()
    elif line.startswith("range "):
        parts = line.split()
        if parts[1:] == ["none"]:
            _set_loop_range(None)
        elif len(parts) == 3:
            _set_loop_range((int(parts[1]), int(parts[2])))
    elif line.startswith("bg "):
        _camera_bg(json.loads(line[3:]))
    elif line.startswith("ref "):
        _viewport_ref(json.loads(line[4:]))
    elif line.startswith("refmap "):
        _update_ref_map(json.loads(line[7:]))


# ---------------------------------------------------------------------------
# 타임라인 / 재생 / 구간
# ---------------------------------------------------------------------------


def _timeline_state():
    scene = bpy.context.scene
    if scene is None:
        return None
    fps = scene.render.fps / (scene.render.fps_base or 1)
    playing = any(w.screen.is_animation_playing for w in bpy.context.window_manager.windows)
    return (scene.frame_current, round(fps, 6), 1 if playing else 0, scene.frame_start)


def _send_timeline():
    """'frame <번호> <fps> <재생중> <장면 시작>' 한 줄. 바뀌었을 때만 보낸다"""
    if S.sock is None:
        return
    st = _timeline_state()
    if st is None or st == S.last_sent:
        return
    if _send(f"frame {st[0]} {st[1]} {st[2]} {st[3]}"):
        S.last_sent = st


@persistent
def _frame_changed(_scene=None, _depsgraph=None):
    _send_timeline()


def _active_window():
    wm = bpy.context.window_manager
    return bpy.context.window or (wm.windows[0] if wm.windows else None)


def toggle_play():
    """Blender 재생 켜기/끄기 (MoRef 에서 타임라인에 맞춘 레퍼런스의 Space / 재생 버튼)"""
    w = _active_window()
    if w is None:
        return
    with bpy.context.temp_override(window=w, screen=w.screen):
        if w.screen.is_animation_playing:
            bpy.ops.screen.animation_cancel(restore_frame=False)
        else:
            bpy.ops.screen.animation_play()


def _set_loop_range(r):
    """MoRef 반복 구간 → 씬 미리보기 범위. 처음 바꿀 때 원래 값을 기억했다가, 구간을 끄면 되돌린다"""
    sc = bpy.context.scene
    if sc is None:
        return
    if r is None:
        if S.preview_saved is not None:
            use, start, end = S.preview_saved
            S.preview_saved = None
            if start > sc.frame_preview_end:
                sc.frame_preview_end, sc.frame_preview_start = end, start
            else:
                sc.frame_preview_start, sc.frame_preview_end = start, end
            sc.use_preview_range = use
            _toast("Blender 미리보기 범위를 원래대로 되돌렸습니다")
        return
    a, b = r
    if b < a:
        return
    if S.preview_saved is None:
        S.preview_saved = (sc.use_preview_range, sc.frame_preview_start, sc.frame_preview_end)
    sc.use_preview_range = True
    # 시작이 지금 끝보다 뒤면 끝을 먼저 옮긴다 (Blender 가 시작 ≤ 끝 으로 맞춰 버린다)
    if a > sc.frame_preview_end:
        sc.frame_preview_end, sc.frame_preview_start = b, a
    else:
        sc.frame_preview_start, sc.frame_preview_end = a, b
    if not a <= sc.frame_current <= b:
        sc.frame_current = a
    _toast(f"Blender 재생을 구간에 맞췄습니다: {a} ~ {b} 프레임 반복")


# ---------------------------------------------------------------------------
# 카메라 배경
# ---------------------------------------------------------------------------


def _camera_bg(data):
    """MoRef 에서 보낸 영상을 활성 카메라의 배경 영상(무비 클립)으로 넣는다.
    지금 MoRef 에 보이는 프레임이 지금 Blender 프레임에 오도록 시작 프레임을 맞춘다
    (Blender 타임라인에 맞추기를 켠 레퍼런스면 그 기준점으로)."""
    scene = bpy.context.scene
    cam = scene.camera if scene else None
    if cam is None or cam.type != "CAMERA":
        _toast("씬에 활성 카메라가 없습니다 - 카메라를 추가하고 활성 카메라로 지정한 뒤 다시 보내세요")
        return
    path = data["path"]
    if not os.path.isfile(path):
        _toast("영상 파일을 찾을 수 없습니다: " + path)
        return
    clip = bpy.data.movieclips.load(path, check_existing=True)
    sync = data.get("sync")
    if sync:
        clip.frame_start = int(sync["b0"]) - int(sync["frame0"])
    else:
        clip.frame_start = scene.frame_current - int(data.get("frame", 0))
    camd = cam.data
    bg = next((b for b in camd.background_images if b.source == "MOVIE_CLIP" and b.clip == clip), None)
    if bg is None:
        bg = camd.background_images.new()
        bg.source = "MOVIE_CLIP"
        bg.clip = clip
        bg.alpha = 0.7
    bg.use_camera_clip = False
    bg.frame_method = "FIT"
    bg.use_flip_x = bool(data.get("flipX"))
    bg.show_background_image = True
    camd.show_background_images = True
    msg = f"카메라 '{cam.name}' 배경에 '{data.get('name') or clip.name}' 을(를) 넣었습니다 · 카메라 시점(Numpad 0)에서 보입니다"
    scene_fps = scene.render.fps / (scene.render.fps_base or 1)
    ref_fps = float(data.get("fps") or 0)
    if ref_fps and abs(ref_fps - scene_fps) > 0.01:
        msg += f" (영상 {ref_fps:g}fps ≠ 씬 {scene_fps:g}fps: 프레임 단위로 재생됩니다)"
    _toast(msg)
    for w in bpy.context.window_manager.windows:
        for a in w.screen.areas:
            a.tag_redraw()


# ---------------------------------------------------------------------------
# 뷰포트 레퍼런스 (이미지 Empty)
#   3D 커서 자리에 정면(Front 뷰 방향)을 보고 놓인다. 일반 오브젝트처럼 옮기고 크기를 바꿀 수 있다.
# ---------------------------------------------------------------------------

REF_SIZE = 2.0  # 처음 크기 (긴 변, 블렌더 단위)


def _ref_objects(scene=None):
    scene = scene or bpy.context.scene
    return [o for o in scene.objects if o.type == "EMPTY" and o.get("refboard_ref")] if scene else []


def _image_aspect(img):
    w, h = img.size[:]
    return w / h if w and h else 16 / 9


def _same_file(a, b):
    norm = lambda p: os.path.normcase(os.path.abspath(bpy.path.abspath(p)))
    return norm(a) == norm(b)


def _viewport_ref(data):
    """MoRef 에서 보낸 영상을 이미지 Empty 로 띄운다. 같은 영상(같은 MoRef 키)이면 그 Empty 를 다시 맞춘다.
    어느 프레임을 보일지는 MoRef 와 같은 식으로 매 프레임 계산한다 (_apply_ref_frames)."""
    scene = bpy.context.scene
    path = data["path"]
    if not os.path.isfile(path):
        _toast("영상 파일을 찾을 수 없습니다: " + path)
        return
    key = data.get("key") or path
    obj = next((o for o in _ref_objects() if o.get("refboard_key") == key), None)
    img = obj.data if obj is not None and obj.data is not None and _same_file(obj.data.filepath, path) else None
    if img is None:
        img = next((i for i in bpy.data.images if i.source == "MOVIE" and _same_file(i.filepath, path)), None) or bpy.data.images.load(path)
    if obj is None:
        obj = bpy.data.objects.new("MoRef · " + (data.get("name") or img.name), None)
        obj.empty_display_type = "IMAGE"
        scene.collection.objects.link(obj)
        obj["refboard_ref"] = 1
        obj["refboard_key"] = key
        obj.use_empty_image_alpha = True
        obj.color[3] = 0.85
        obj.location = scene.cursor.location
        obj.empty_display_size = REF_SIZE
        _face_front(obj)
    obj.data = img
    iu = obj.image_user
    iu.frame_duration = max(1, img.frame_duration)
    iu.frame_offset = 0
    iu.use_cyclic = False  # 반복은 _apply_ref_frames 가 MoRef 와 같은 구간으로 한다
    iu.use_auto_refresh = True
    obj.scale.x = -abs(obj.scale.x) if data.get("flipX") else abs(obj.scale.x)
    _set_ref_map(obj, data["map"])
    _toast(f"뷰포트에 '{data.get('name') or img.name}' 을(를) 띄웠습니다 (3D 커서 자리, 정면)")


def _set_ref_map(obj, m):
    """MoRef 와 같은 대응: 영상 시각 t = t0 + (Blender 프레임 − b0) / 씬 fps × 재생 속도, 구간 [a, b) 안에서 반복"""
    obj["refboard_map"] = json.dumps(m)
    _apply_ref_frames(bpy.context.scene)


def _ref_frame_index(m, cfra, scene_fps):
    t = float(m["t0"]) + (cfra - float(m["b0"])) / scene_fps * float(m.get("rate", 1))
    a = float(m.get("a", 0))
    b = float(m.get("b") or m.get("d") or 0)
    if b > a:
        t = a + ((t - a) % (b - a))
    return max(0, int(t * float(m["fps"]) + 1e-6))


@persistent
def _apply_ref_frames(scene=None, _depsgraph=None):
    """매 프레임: 이미지 사용자의 시작 프레임을 옮겨, 지금 장면 프레임에 맞는 영상 프레임이 보이게 한다
    (보이는 영상 프레임 = 장면 프레임 − 시작 + 1)"""
    scene = scene or bpy.context.scene
    if scene is None:
        return
    scene_fps = scene.render.fps / (scene.render.fps_base or 1)
    for o in _ref_objects(scene):
        raw = o.get("refboard_map")
        if not raw or o.data is None:
            continue
        try:
            idx = _ref_frame_index(json.loads(raw), scene.frame_current, scene_fps)
        except (ValueError, KeyError, ZeroDivisionError):
            continue
        idx = min(idx, max(0, o.image_user.frame_duration - 1))
        start = scene.frame_current - idx
        if o.image_user.frame_start != start:
            o.image_user.frame_start = start


def _update_ref_map(data):
    """MoRef 에서 맞추기 기준 / 구간 / 속도를 바꿨을 때"""
    for o in _ref_objects():
        if o.get("refboard_key") == data.get("key"):
            _set_ref_map(o, data["map"])


def _face_front(obj):
    """정면(Front 뷰: −Y 에서 +Y 를 봄)을 보게 세운다"""
    obj.hide_select = False
    obj.empty_image_depth = "DEFAULT"
    obj.rotation_mode = "XYZ"
    obj.rotation_euler = (1.5707963267948966, 0.0, 0.0)


def _upgrade_old_refs(scene=None):
    """예전 버전의 "뷰 따라오기" Empty 를 정면 고정으로 바꾼다. 그 자리와 크기는 뷰에 맞춘 값이라 3D 커서 자리 / 처음 크기로"""
    scene = scene or bpy.context.scene
    for o in _ref_objects(scene):
        if "refboard_mode" in o:
            if o["refboard_mode"] != "FRONT":
                _face_front(o)
                o.location = scene.cursor.location
                o.empty_display_size = REF_SIZE
            del o["refboard_mode"]
        if "refboard_size" in o:
            del o["refboard_size"]


class REFBOARD_OT_ref_remove(bpy.types.Operator):
    bl_idname = "refboard.ref_remove"
    bl_label = "뷰포트에서 지우기"
    bl_description = "이 영상 Empty 를 장면에서 지웁니다 (영상 파일은 그대로)"
    bl_options = {"REGISTER", "UNDO"}

    name: bpy.props.StringProperty()

    def execute(self, context):
        o = bpy.data.objects.get(self.name)
        if o is not None and o.get("refboard_ref"):
            bpy.data.objects.remove(o)
        return {"FINISHED"}


# ---------------------------------------------------------------------------
# 주기 확인 / 파일 열기
# ---------------------------------------------------------------------------


def _tick():
    try:
        if S.sock is None:
            _try_connect()
        else:
            _poll_incoming()
            _send_timeline()  # 재생 시작/정지, fps 변경은 프레임 변경 없이도 일어난다
    except Exception as e:
        print("MoRef 연결 오류:", e)
    return TICK


@persistent
def _load_pre(_dummy=None):
    S.preview_saved = None  # 다른 파일의 씬이 된다 (되돌릴 대상이 사라짐)


@persistent
def _load_post(_dummy=None):
    if not bpy.app.timers.is_registered(_tick):
        bpy.app.timers.register(_tick, first_interval=TICK, persistent=True)
    _upgrade_old_refs()
    S.last_sent = None
    _hello()


# ---------------------------------------------------------------------------
# 연산자 / UI
# ---------------------------------------------------------------------------


def _status_text():
    if _connected():
        return "연결됨"
    if time.monotonic() - S.launched_at < 15:
        return "여는 중…"
    return "연결 안 됨"


class REFBOARD_OT_open(bpy.types.Operator):
    bl_idname = "refboard.open"
    bl_label = "MoRef 열기"
    bl_description = "MoRef 가 꺼져 있으면 켜고, 켜져 있으면 앞으로 가져옵니다"

    def execute(self, context):
        if _connected():
            _send("focus")
            return {"FINISHED"}
        cmd, where = _find_refboard()
        if cmd is None:
            self.report({"ERROR"}, where)
            return {"CANCELLED"}
        flags = 0
        if IS_WIN:
            flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP  # Blender 를 꺼도 MoRef 는 남는다
        subprocess.Popen(cmd, cwd=os.path.dirname(cmd[0]), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=flags, close_fds=True)
        S.launched_at = time.monotonic()
        S.next_try = 0.0
        self.report({"INFO"}, "MoRef 를 여는 중… 켜지면 자동으로 연결됩니다")
        _redraw_ui()
        return {"FINISHED"}


class REFBOARD_PT_sidebar(bpy.types.Panel):
    bl_idname = "REFBOARD_PT_sidebar"
    bl_label = "MoRef"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "MoRef"

    def draw(self, context):
        layout = self.layout
        layout.label(text="상태: " + _status_text(), icon="LINKED" if _connected() else "UNLINKED")
        row = layout.row()
        row.scale_y = 1.3
        row.operator(REFBOARD_OT_open.bl_idname, text="MoRef 앞으로" if _connected() else "MoRef 열기", icon="IMAGE_REFERENCE")
        refs = _ref_objects()
        if refs:
            box = layout.box()
            box.label(text="뷰포트에 띄운 영상", icon="IMAGE_REFERENCE")
            for o in refs:
                col = box.column(align=True)
                row = col.row(align=True)
                row.label(text=o.name.replace("MoRef · ", "").replace("RefBoard · ", ""))
                row.operator(REFBOARD_OT_ref_remove.bl_idname, text="", icon="X").name = o.name
                col.prop(o, "empty_display_size", text="크기")
                col.prop(o, "color", index=3, text="불투명도", slider=True)
        col = layout.column(align=True)
        col.label(text="영상 우클릭 ▸ Blender 뷰포트에 띄우기")
        col.label(text="MoRef 영상의 🔗: 타임라인에 맞추기")
        col.label(text="맞춘 영상의 반복 구간 → Blender 도 반복")
        col.label(text="맞춘 영상에서 Space → Blender 재생")
        col.label(text="영상 우클릭 ▸ 카메라 배경으로 보내기")
        layout.label(text="Ctrl+Alt+R: MoRef 열기 / 앞으로", icon="EVENT_R")


def _topbar(self, context):
    if context.region.alignment != "RIGHT":
        return
    try:
        if not _prefs().topbar_button:
            return
    except KeyError:
        return
    self.layout.operator(REFBOARD_OT_open.bl_idname, text="MoRef", icon="LINKED" if _connected() else "UNLINKED", depress=_connected())


class REFBOARD_Prefs(bpy.types.AddonPreferences):
    bl_idname = __package__ or __name__

    refboard_dir: bpy.props.StringProperty(
        name="소스 폴더 (개발용)",
        description="설치하지 않고 소스로 실행할 때만: MoRef 프로젝트 폴더 (package.json 과 node_modules 가 있는 곳)",
        subtype="DIR_PATH",
        default=os.path.join(os.path.expanduser("~"), "Desktop", "MoRef"),
    )
    topbar_button: bpy.props.BoolProperty(
        name="상단 바에 MoRef 버튼",
        description="Blender 상단 바 오른쪽에 연결 상태와 MoRef 열기 버튼을 둡니다",
        default=True,
    )

    def draw(self, context):
        layout = self.layout
        cmd, where = _find_refboard()
        if cmd:
            layout.label(text=f"MoRef 를 찾았습니다 ({where}): {cmd[0]}", icon="CHECKMARK")
        else:
            layout.label(text=where, icon="ERROR")
        layout.prop(self, "refboard_dir")
        layout.prop(self, "topbar_button")
        layout.label(text="상태: " + _status_text(), icon="LINKED" if _connected() else "UNLINKED")


CLASSES = (REFBOARD_Prefs, REFBOARD_OT_open, REFBOARD_OT_ref_remove, REFBOARD_PT_sidebar)
HANDLERS = (
    (bpy.app.handlers.frame_change_pre, _apply_ref_frames),
    (bpy.app.handlers.frame_change_post, _frame_changed),
    (bpy.app.handlers.load_pre, _load_pre),
    (bpy.app.handlers.load_post, _load_post),
)
_keymaps = []


def register():
    for c in CLASSES:
        bpy.utils.register_class(c)
    bpy.types.TOPBAR_HT_upper_bar.append(_topbar)
    for lst, fn in HANDLERS:
        if fn not in lst:
            lst.append(fn)
    kc = bpy.context.window_manager.keyconfigs.addon
    if kc is not None:  # 백그라운드 실행에는 없다
        km = kc.keymaps.new(name="Window", space_type="EMPTY")
        _keymaps.append((km, km.keymap_items.new(REFBOARD_OT_open.bl_idname, "R", "PRESS", ctrl=True, alt=True)))
    # Blender 를 켤 때는 애드온을 올린 다음 .blend 를 여는데, 일반 타이머는 그때 지워진다 → persistent
    bpy.app.timers.register(_tick, first_interval=TICK, persistent=True)
    bpy.app.timers.register(lambda: (_upgrade_old_refs(), None)[1], first_interval=0.5)


def unregister():
    if bpy.app.timers.is_registered(_tick):
        bpy.app.timers.unregister(_tick)
    _close_sock()
    for km, kmi in _keymaps:
        try:
            km.keymap_items.remove(kmi)
        except Exception:
            pass
    _keymaps.clear()
    for lst, fn in HANDLERS:
        if fn in lst:
            lst.remove(fn)
    bpy.types.TOPBAR_HT_upper_bar.remove(_topbar)
    for c in reversed(CLASSES):
        bpy.utils.unregister_class(c)
