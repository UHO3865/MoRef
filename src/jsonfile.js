// JSON 파일을 안전하게 쓰고 읽는다.
//  * 쓰기: 같은 폴더의 임시 파일에 다 쓴 뒤 이름을 바꿔 덮는다. 쓰는 도중 꺼지거나 앱이 죽어도 원래 파일은 온전하다.
//    backup 이면 바로 전 내용을 <파일>.bak 로 남긴다 (설정 / 구간처럼 다시 만들 수 없는 것).
//  * 읽기: 파일이 깨졌으면 .bak 를 읽는다. 둘 다 안 되면 깨진 파일을 <파일>.broken-<시각> 으로 옮겨 두고 fallback 을 돌려준다
//    (빈 값으로 덮어써서 원래 내용을 잃지 않게 - 손으로 되살릴 수 있다).
//  * writer(): 자주 바뀌는 파일은 모아서(debounce) 한 번에 하나씩 쓴다. 앱을 끌 때 flushAll() 로 남은 것을 마저 쓴다.
const fs = require('fs');
const path = require('path');

let seq = 0;
const tmpOf = (file) => `${file}.${process.pid}.${++seq}.tmp`;

// 이름 바꾸기: 백신 / 검색 색인이 잠깐 파일을 잡고 있으면 Windows 에서 EPERM / EBUSY 가 난다 → 조금 쉬었다 다시
function renameSync(from, to) {
  for (let i = 0; ; i++) {
    try {
      return fs.renameSync(from, to);
    } catch (e) {
      if (i >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30 * (i + 1));
    }
  }
}

// durable: 디스크까지 내려쓴 뒤 바꾼다 (fsync). 다시 받을 수 있는 캐시는 false 로 가볍게
function writeSync(file, data, { backup = false, durable = true, space } = {}) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, space);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = tmpOf(file);
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, text);
      if (durable) fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (backup) {
      try {
        fs.copyFileSync(file, file + '.bak');
      } catch {}
    }
    renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

function parse(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readSync(file, fallback) {
  let err;
  try {
    return parse(file);
  } catch (e) {
    err = e;
  }
  const fb = () => (typeof fallback === 'function' ? fallback() : fallback);
  // 파일이 없으면 처음 쓰는 것 (또는 일부러 지운 것) - .bak 로 되살리지 않는다
  if (err.code === 'ENOENT') return fb();
  // 깨진 파일은 먼저 옮겨 둔다 (그대로 두면 다음 쓰기에서 깨진 내용이 .bak 를 덮는다)
  try {
    fs.renameSync(file, `${file}.broken-${Date.now()}`);
  } catch {}
  console.error('JSON 파일이 깨져 있어 따로 옮겨 두었습니다', file, err.message);
  try {
    return parse(file + '.bak');
  } catch {}
  return fb();
}

const writers = new Set();

// getData: 쓸 때 부를 함수 (그때의 최신 값). save() 를 여러 번 불러도 delay 동안 모아 한 번 쓴다.
function writer(file, getData, { delay = 500, backup = false, durable = true } = {}) {
  let timer = null;
  let dirty = false;
  const flush = () => {
    clearTimeout(timer);
    timer = null;
    if (!dirty) return;
    dirty = false;
    try {
      writeSync(file(), getData(), { backup, durable });
    } catch (e) {
      console.error('저장 실패', file(), e.message);
    }
  };
  const w = {
    save() {
      dirty = true;
      if (!timer) timer = setTimeout(flush, delay);
    },
    flush,
  };
  writers.add(w);
  return w;
}

function flushAll() {
  for (const w of writers) w.flush();
}

module.exports = { writeSync, readSync, writer, flushAll };
