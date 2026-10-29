<p align="center"><img src="assets/icon.png" width="96" alt="RefBoard ロゴ"></p>

<p align="center"><a href="README.md">한국어</a> · <a href="README.en.md">English</a> · <b>日本語</b></p>

# RefBoard

**NAS の動画リファレンスをボードに並べ、Blender のタイムラインに合わせて見られるアプリ**です。

https://github.com/user-attachments/assets/77820e48-c7a9-4285-9323-775c173bb6a0

- **NAS から直接**: WebDAV(Synology など)やローカル · SMB フォルダの動画をサムネイルで見て、ボードにドラッグします。
- **Blender 連携**: Blender でスクラブや再生をすると、リファレンスも同じコマについてきます。ビューポートやカメラ背景にも表示できます。
- ループ区間、コマ送り、反転 · 切り抜き、描き込み、常に手前 · 透明度。

## ダウンロード · インストール

[Releases](../../releases) からダウンロードします。

| ファイル | 内容 |
| --- | --- |
| `RefBoard-Setup-x.y.z.exe` | Windows インストーラー (Windows 10/11, 64 ビット) |
| `RefBoard-Blender-Addon-x.y.z.zip` | Blender アドオン (Blender 4.2 以降)。インストーラーにも含まれているので、別途ダウンロードしなくてもかまいません |

- コード署名がないため、初回実行時に SmartScreen の警告が出ることがあります。**詳細情報 ▸ 実行** を押してください。
- **FFmpeg が必要です。** PATH にあればそのまま使い、なければ設定で `ffmpeg.exe` のパスを指定します。

  ```bash
  winget install Gyan.FFmpeg
  ```

- 初回起動時に Blender アドオンをインストールするか聞かれます。**インストール** を押すと、次に Blender を起動したときに自動で有効になります。

## NAS の接続

初回起動時に **⚙ 設定** が開きます。ここでソースを追加してください。

<img src="docs/screenshots/nas-settings.png" width="420" alt="NAS 接続設定">

| 種類 | アドレスの例 |
| --- | --- |
| WebDAV | `https://192.168.0.10:5006/refs` (Synology: WebDAV Server パッケージ, HTTPS 5006 / HTTP 5005) |
| ローカル · SMB フォルダ | `\\NAS\refs`, `Z:\refs` |

## ソースから実行 · ビルド

[Node.js](https://nodejs.org/) 20 以降が必要です。

```bash
npm install
```

```bash
npm start
```

リリースファイルの作成(`dist/` に作られます):

```bash
npm run dist
```

```bash
npm run addon
```

## サポート

RefBoard が役に立ったら、コーヒー 1 杯で応援してください。

<a href="https://buymeacoffee.com/uho3865"><img src="https://img.shields.io/badge/Buy%20Me%20a%20Coffee-ffdd00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black" alt="Buy Me a Coffee"></a>

## ライセンス

[MIT](LICENSE)
