// 설치 파일에 함께 넣을 ffmpeg / ffprobe 를 받아 vendor/ffmpeg 에 둔다 (npm run dist 앞에 자동으로 실행)
//  * BtbN/FFmpeg-Builds 의 LGPL 공유 라이브러리 빌드 (ffmpeg 8.1). 매달 마지막 날 빌드는 오래 남아 있어서 그것으로 고정
//  * 받은 zip 은 SHA-256 으로 확인한다. 다르면 쓰지 않는다
//  * bin 의 실행 파일 / dll 과 라이선스만 꺼낸다 (헤더 · 문서 · 개발용 lib 은 버림)
// 이미 같은 버전이 있으면 아무것도 하지 않는다. 다른 빌드를 쓰려면 아래 세 값을 바꾼다.
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const URL = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-30-13-08/ffmpeg-n8.1.3-9-g29e619e767-win64-lgpl-shared-8.1.zip';
const SHA256 = '3e47bda1607740550141e37c0e49d1e5182b34699f15adfd137ee266d346811a';
const VERSION = 'n8.1.3-9-g29e619e767 (LGPL, shared)';

const root = path.join(__dirname, '..');
const out = path.join(root, 'vendor', 'ffmpeg');
const stamp = path.join(out, 'BUILD.txt');

function download(url, file, hops = 0) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'moref-build' } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 5) {
          res.resume();
          return resolve(download(res.headers.location, file, hops + 1));
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        const total = Number(res.headers['content-length']) || 0;
        let got = 0;
        let shown = -1;
        res.on('data', (d) => {
          got += d.length;
          const p = total ? Math.floor((got / total) * 10) : -1;
          if (p !== shown) process.stdout.write(`\r  ${Math.round(got / 1048576)}MB${total ? ` / ${Math.round(total / 1048576)}MB` : ''}`);
          shown = p;
        });
        res.pipe(fs.createWriteStream(file)).on('finish', () => (process.stdout.write('\n'), resolve())).on('error', reject);
      })
      .on('error', reject);
  });
}

async function main() {
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').includes(SHA256)) {
    console.log('ffmpeg: 이미 있음', VERSION);
    return;
  }
  const tmp = path.join(root, 'vendor', '_ffmpeg-download');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const zip = path.join(tmp, 'ffmpeg.zip');
  console.log('ffmpeg: 받는 중', URL);
  await download(URL, zip);
  const sum = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
  if (sum !== SHA256) throw new Error(`ffmpeg: SHA-256 이 다릅니다 (${sum}) - 쓰지 않습니다`);
  // Windows 10 이후에 들어 있는 tar(bsdtar) 로 zip 을 푼다
  const ex = path.join(tmp, 'x');
  fs.mkdirSync(ex);
  execFileSync('tar', ['-xf', zip, '-C', ex], { stdio: 'inherit' });
  const top = path.join(ex, fs.readdirSync(ex)[0]);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const f of fs.readdirSync(path.join(top, 'bin'))) {
    if (f === 'ffplay.exe') continue; // 쓰지 않는다
    if (/\.(exe|dll)$/i.test(f)) fs.copyFileSync(path.join(top, 'bin', f), path.join(out, f));
  }
  fs.copyFileSync(path.join(top, 'LICENSE.txt'), path.join(out, 'LICENSE.txt'));
  fs.writeFileSync(
    stamp,
    [
      `FFmpeg ${VERSION}`,
      `Source / build: https://github.com/BtbN/FFmpeg-Builds (${URL})`,
      `FFmpeg source code: https://ffmpeg.org/download.html (git describe: ${VERSION.split(' ')[0]})`,
      'License: GNU Lesser General Public License v2.1 or later (LICENSE.txt)',
      `SHA-256 of the downloaded archive: ${SHA256}`,
      '',
    ].join('\n'),
  );
  fs.rmSync(tmp, { recursive: true, force: true });
  const size = fs.readdirSync(out).reduce((a, f) => a + fs.statSync(path.join(out, f)).size, 0);
  console.log(`ffmpeg: ${out} (${Math.round(size / 1048576)}MB)`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
