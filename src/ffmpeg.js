// 쓸 ffmpeg / ffprobe 고르기
//  1. 설정에 경로를 적었으면 그것
//  2. MoRef 에 함께 들어 있는 것 (설치판: resources/ffmpeg, 소스 폴더: vendor/ffmpeg - scripts/fetch-ffmpeg.js)
//  3. 없으면 PATH 의 ffmpeg
// 설정의 기본값 'ffmpeg' 은 "알아서" 라는 뜻이다 (예전 설정과 같은 값).
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const sources = require('./sources');

const exe = process.platform === 'win32' ? '.exe' : '';

function bundledDir() {
  return app.isPackaged ? path.join(process.resourcesPath, 'ffmpeg') : path.join(__dirname, '..', 'vendor', 'ffmpeg');
}

let bundled; // 경로 | null (한 번만 확인)
function bundledFfmpeg() {
  if (bundled === undefined) {
    const f = path.join(bundledDir(), 'ffmpeg' + exe);
    bundled = fs.existsSync(f) ? f : null;
  }
  return bundled;
}

function custom() {
  const p = (sources.loadConfig().settings.ffmpegPath || '').trim();
  return p && p !== 'ffmpeg' ? p : null;
}

function ffmpegPath() {
  return custom() || bundledFfmpeg() || 'ffmpeg';
}

// ffmpeg 옆의 ffprobe
function ffprobePath() {
  const ff = ffmpegPath();
  return ff.replace(/ffmpeg(\.exe)?$/i, (m) => (m.toLowerCase().endsWith('.exe') ? 'ffprobe.exe' : 'ffprobe'));
}

// 설정 화면에 보여 줄 것: 지금 무엇을 쓰는지
function describe() {
  return { custom: custom(), bundled: !!bundledFfmpeg(), using: ffmpegPath() };
}

module.exports = { ffmpegPath, ffprobePath, describe };
