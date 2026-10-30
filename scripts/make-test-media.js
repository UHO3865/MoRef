// 자동 점검(npm run selftest)에 쓰는 시험 파일을 ffmpeg 로 만든다.
//   node scripts/make-test-media.js <폴더>      (기본: ./test-media)
// 만든 폴더를 WebDAV 로 열거나(RB_TEST_TYPE=dav) 로컬 소스로 지정해서(RB_TEST_TYPE=local) 점검을 돌린다.
// ffmpeg 는 FFMPEG 환경 변수, 없으면 PATH 의 것. HEVC(libx265) / webm(libvpx) 인코더가 없으면 그 파일은 건너뛴다.
//
//   점프 01.mp4         6초 (오른쪽 클릭 구간: 30% = 1.8초)
//   hevc_test.mp4       HEVC
//   모션/ turn.mov, run.mp4   하위 폴더 · .mov
//   many/ clip_001…060.mp4    큰 폴더 (썸네일 대기열)
//   thumbtest/ fadein.mp4     검게 시작 (썸네일은 1초 지점으로)
//              broken.mp4     깨진 파일 (실패를 기억)
//              vardelay.gif   프레임 길이 50,100,…,400ms (8장, 1.8초)
//              big.gif        4MB 넘는 GIF (NAS 프록시가 끝까지 보내는지)
//              quad.png       왼쪽 위 빨강 · 오른쪽 위 초록 · 왼쪽 아래 파랑 · 오른쪽 아래 흰색
//   fpstest/ f24.mp4 f2997.mp4 f60.mp4 f25.webm   프레임 n 의 밝기 Y = 16 + 7·(n mod 30)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const out = path.resolve(process.argv[2] || 'test-media');
const FF = process.env.FFMPEG || 'ffmpeg';
const encoders = execFileSync(FF, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
const has = (name) => new RegExp(`\\s${name}\\s`).test(encoders);
const h264 = has('libx264') ? ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast'] : ['-c:v', 'mpeg4', '-q:v', '3'];

function ff(args, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', ...args, file], { stdio: 'inherit' });
  console.log('  ', path.relative(out, file));
}
const src = (d, r = 30, s = '320x180') => ['-f', 'lavfi', '-i', `testsrc2=s=${s}:r=${r}:d=${d}`];

console.log('시험 파일 →', out, has('libx264') ? '' : '(libx264 없음: mpeg4 로)');

ff([...src(6), ...h264], path.join(out, '점프 01.mp4'));
if (has('libx265')) ff([...src(4), '-c:v', 'libx265', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p', '-x265-params', 'log-level=error'], path.join(out, 'hevc_test.mp4'));
else console.log('   hevc_test.mp4 건너뜀 (libx265 없음)');

ff([...src(3, 24), ...h264, '-f', 'mov'], path.join(out, '모션', 'turn.mov'));
ff([...src(3, 30, '180x320'), ...h264], path.join(out, '모션', 'run.mp4'));

const clip = path.join(out, 'many', 'clip_001.mp4');
ff([...src(1, 15, '160x90'), ...h264], clip);
for (let i = 2; i <= 60; i++) fs.copyFileSync(clip, path.join(out, 'many', `clip_${String(i).padStart(3, '0')}.mp4`));
console.log('   many/ clip_002…060.mp4');

ff([...src(4), '-vf', 'fade=in:st=0:d=1.5', ...h264], path.join(out, 'thumbtest', 'fadein.mp4'));
fs.writeFileSync(path.join(out, 'thumbtest', 'broken.mp4'), Buffer.concat([Buffer.from('not really a video '), Buffer.alloc(64 * 1024, 7)]));
console.log('   thumbtest/broken.mp4');

// 프레임 길이가 다른 GIF: 1/100초 단위 색 띠를 이어 붙이고 같은 프레임을 버리면 남은 프레임의 길이가 제각각이 된다.
// 마지막 프레임 길이는 GIF 에 따로 적는다 (final_delay, 1/100초)
{
  const colors = ['red', 'orange', 'yellow', '0x00FF00', 'cyan', 'blue', 'purple', 'white'];
  const parts = colors.map((c, i) => `color=c=${c}:s=120x90:r=100:d=${((i + 1) * 0.05).toFixed(2)}[c${i}]`).join(';');
  const join = colors.map((_, i) => `[c${i}]`).join('') + `concat=n=${colors.length}:v=1:a=0,mpdecimate=hi=1:lo=1:frac=1,split[a][b];[a]palettegen[p];[b][p]paletteuse`;
  ff(['-filter_complex', `${parts};${join}`, '-fps_mode', 'passthrough', '-final_delay', '40', '-loop', '0'], path.join(out, 'thumbtest', 'vardelay.gif'));
}

// 4MB 넘는 GIF: 프록시가 범위 없는 요청에도 끝까지 보내는지 (예전에는 앞 4MB 만 보내 "Unexpected end of image")
ff(['-f', 'lavfi', '-i', 'testsrc2=s=960x540:r=15:d=14', '-vf', 'split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer'], path.join(out, 'thumbtest', 'big.gif'));

ff(
  ['-filter_complex', 'color=c=red:s=160x90[a];color=c=0x00FF00:s=160x90[b];color=c=blue:s=160x90[c];color=c=white:s=160x90[d];[a][b]hstack[t];[c][d]hstack[u];[t][u]vstack', '-frames:v', '1'],
  path.join(out, 'thumbtest', 'quad.png'),
);

// 프레임 번호를 밝기로: 화면에 나온 프레임과 프레임 번호 표시를 맞춰 볼 수 있다
const gray = (r) => ['-f', 'lavfi', '-i', `color=c=black:s=320x180:r=${r}:d=4,format=yuv420p,geq=lum='16+7*mod(N\\,30)':cb=128:cr=128`];
ff([...gray(24), ...h264, '-crf', '1', '-color_range', 'tv'], path.join(out, 'fpstest', 'f24.mp4'));
ff([...gray('30000/1001'), ...h264, '-crf', '1', '-color_range', 'tv'], path.join(out, 'fpstest', 'f2997.mp4'));
ff([...gray(60), ...h264, '-crf', '1', '-color_range', 'tv'], path.join(out, 'fpstest', 'f60.mp4'));
if (has('libvpx-vp9')) ff([...gray(25), '-c:v', 'libvpx-vp9', '-crf', '4', '-b:v', '0', '-pix_fmt', 'yuv420p'], path.join(out, 'fpstest', 'f25.webm'));
else console.log('   fpstest/f25.webm 건너뜀 (libvpx-vp9 없음)');

console.log('끝');
