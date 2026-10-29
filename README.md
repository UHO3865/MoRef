<p align="center"><img src="assets/icon.png" width="96" alt="RefBoard 로고"></p>

<p align="center"><b>한국어</b> · <a href="README.en.md">English</a> · <a href="README.ja.md">日本語</a></p>

# RefBoard

**NAS의 영상 레퍼런스를 보드에 띄우고, Blender 타임라인에 맞춰 보는 앱**입니다.

https://github.com/user-attachments/assets/2c60ea89-3a38-4594-82d6-5f23b848b247

- **NAS에서 바로**: WebDAV(Synology 등)나 로컬 · SMB 폴더의 영상을 썸네일로 넘겨 보고 보드에 끌어다 놓습니다.
- **Blender 연결**: Blender에서 스크럽하거나 재생하면 레퍼런스가 같은 프레임으로 따라옵니다. 뷰포트나 카메라 배경에도 띄울 수 있습니다.
- 반복 구간, 프레임 단위 이동, 반전 · 자르기, 그리기, 항상 위 · 투명도.

## 다운로드 · 설치

[Releases](../../releases)에서 받습니다.

| 파일 | 내용 |
| --- | --- |
| `RefBoard-Setup-x.y.z.exe` | Windows 설치 프로그램 (Windows 10/11, 64비트) |
| `RefBoard-Blender-Addon-x.y.z.zip` | Blender 애드온 (Blender 4.2 이상). 설치 프로그램에도 들어 있어서 따로 받지 않아도 됩니다 |

- 코드 서명이 없어서 처음 실행할 때 SmartScreen 경고가 나올 수 있습니다. **추가 정보 ▸ 실행**을 누르세요.
- **FFmpeg가 필요합니다.** PATH에 있으면 그대로 쓰고, 아니면 설정에서 `ffmpeg.exe` 경로를 지정합니다.

  ```bash
  winget install Gyan.FFmpeg
  ```

- Blender 애드온은 처음 실행할 때 설치할지 묻습니다. **설치**를 누르면 다음에 Blender를 켤 때 자동으로 켜집니다.

## NAS 연결

처음 실행하면 **⚙ 설정**이 열립니다. 여기서 소스를 추가하세요.

<img src="docs/screenshots/nas-settings.png" width="420" alt="NAS 연결 설정">

| 종류 | 주소 예시 |
| --- | --- |
| WebDAV | `https://192.168.0.10:5006/refs` (Synology: WebDAV Server 패키지, HTTPS 5006 / HTTP 5005) |
| 로컬 · SMB 폴더 | `\\NAS\refs`, `Z:\refs` |

## 소스에서 실행 · 빌드

[Node.js](https://nodejs.org/) 20 이상이 필요합니다.

```bash
npm install
```

```bash
npm start
```

릴리즈 파일 만들기 (`dist/`에 생깁니다):

```bash
npm run dist
```

```bash
npm run addon
```

## 후원

RefBoard가 도움이 됐다면 커피 한 잔으로 응원해 주세요.<br>
If RefBoard helps you, you can buy me a coffee.<br>
RefBoard が役に立ったら、コーヒー 1 杯で応援してください。

<a href="https://buymeacoffee.com/uho3865"><img src="https://img.shields.io/badge/Buy%20Me%20a%20Coffee-ffdd00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black" alt="Buy Me a Coffee"></a>

## 라이선스

[MIT](LICENSE)
