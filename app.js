'use strict';
/*
 * VaultNote 1.1 — 독립 보안 검토 반영 (1~6단계 기능 포함)
 * 새 버전을 올릴 때는 이 APP_VERSION과 sw.js의 VERSION을 똑같이 올린다 (PRD 10-5).
 * 구조 원칙(PRD 10장): 상태 하나(state) → 변경 함수 하나(commit) → 화면 전체 다시 그리기(render)
 * 예외(10-1): 글자를 입력하는 중에는 입력창을 다시 만들지 않는다(한글 조합 보호).
 */

// ===== [CONFIG] =====
const APP_VERSION = '1.1.1';
const KDF_ITERATIONS = 600000;    // PRD 3장. 낮추지 않는다.
const MAX_ITERATIONS = 5000000;   // 조작된 파일로 기기를 멈추게 하는 것 방지
const MIN_PASSWORD = 12;          // F-1
const MAX_DEPTH = 5;              // 폴더 최대 깊이 (PRD 2장)
const UNDO_MS = 5000;             // 삭제 실행 취소 시간 (F-2)
const TOAST_MS = 2200;
const SEARCH_DELAY_MS = 150;      // 검색 디바운스 (10-1)
const BACKUP_REMIND_DAYS = 7;    // F-5
const CLIP_CLEAR_MS = 30 * 1000;  // 복사 30초 후 클립보드 비우기 (F-3)
const CLIP_MAX_MS = 3 * 60 * 1000; // 복사 후 3분이 지나면 비우지 않음 (다른 앱에서 복사한 내용 보호)
const REVEAL_MS = 10 * 1000;      // PW 10초 표시 후 숨김 (F-3)
const MAX_FAILS = 5;              // 연속 실패 허용 횟수 (F-1)
const FAIL_WAIT_MS = 30 * 1000;
const AUTOLOCK_CHOICES = [1, 3, 5];   // 미사용 자동 잠금(분), 기본 3 (F-6)
const GRACE_CHOICES = [0, 60, 180];   // 다른 앱 전환 후 유예(초), 기본 60 (F-6)
const IDLE_CHECK_MS = 5 * 1000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const EXTERNAL_MAX_MS = 5 * 60 * 1000; // 파일 선택 창 예외는 최대 5분 (취소 이벤트가 안 오는 브라우저 대비)
const SNAP_KEEP = { daily: 7, protected: 5 }; // 저장본 기록: 하루 첫 변경 전 7개 + 중요한 작업 직전 5개
const DB_NAME = 'vaultnote';
const DB_STORE = 'vault';
const TILE_COLORS = ['#007AFF', '#34C759', '#FF9500', '#FF2D55', '#AF52DE', '#5856D6', '#FF3B30', '#30B0C7', '#A2845E'];
const DISCLAIMER = '개인이 가족·지인과 나누려고 만든 앱이며, 전문 보안 검증을 받지 않았고 어떤 보증도 하지 않습니다. 데이터 손실에 대비해 백업을 꼭 만들어 두세요.';
const INPUT_ATTRS = { autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' }; // 10-2

// ===== [UTILS] =====
function uid() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });
const dateFmt = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
function now() { return Date.now(); }
function clone(obj) {
  return typeof structuredClone === 'function' ? structuredClone(obj) : JSON.parse(JSON.stringify(obj));
}
function reducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
function seconds(ms) { return `${(ms / 1000).toFixed(2)}초`; }

// 화면 요소 만들기. 사용자 입력은 항상 textContent/value로만 넣는다 (innerHTML 금지, 10-2)
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, val] of Object.entries(props)) {
      if (val === null || val === undefined || val === false) continue;
      if (key === 'class') el.className = val;
      else if (key === 'text') el.textContent = val;
      else if (key === 'value') el.value = val;
      else if (key === 'disabled') el.disabled = true;
      else if (key === 'checked') el.checked = true;
      else if (key === 'style') {
        for (const [p, v] of Object.entries(val)) el.style.setProperty(p, v);
      } else el.setAttribute(key, val === true ? '' : String(val));
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return el;
}

// 직접 그린 선 아이콘 (SF Symbols 사용 안 함, PRD 11장)
const ICONS = {
  back: ['M15 5l-7 7 7 7'],
  chevron: ['M9 5l7 7-7 7'],
  folder: ['M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2.2h8.5A1.5 1.5 0 0 1 21 9.7v7.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z'],
  folderPlus: ['M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2.2h8.5A1.5 1.5 0 0 1 21 9.7v7.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z', 'M12 11v5.4M9.3 13.7h5.4'],
  compose: ['M4 20h4.2L19.4 8.8a1.9 1.9 0 0 0 0-2.7l-1.5-1.5a1.9 1.9 0 0 0-2.7 0L4 15.8z', 'M13.8 6l4.2 4.2'],
  search: ['M10.8 17.6a6.8 6.8 0 1 0 0-13.6 6.8 6.8 0 0 0 0 13.6z', 'M20 20l-4.4-4.4'],
  clear: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6'],
  copy: ['M9 9.5A1.5 1.5 0 0 1 10.5 8h8A1.5 1.5 0 0 1 20 9.5v9a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 9 18.5z', 'M15 8V5.5A1.5 1.5 0 0 0 13.5 4h-8A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H9'],
  eye: ['M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  eyeOff: ['M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M4 4l16 16'],
  more: ['M6 12h.01M12 12h.01M18 12h.01'],
  up: ['M12 19V5', 'M6 11l6-6 6 6'],
  down: ['M12 5v14', 'M6 13l6 6 6-6'],
  check: ['M5 12.5l4.5 4.5L19 7'],
  cross: ['M6.5 6.5l11 11M17.5 6.5l-11 11'],
  dash: ['M7 12h10'],
  lock: ['M7.5 11V8a4.5 4.5 0 0 1 9 0v3', 'M5.5 11h13A1.5 1.5 0 0 1 20 12.5v7a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19.5v-7A1.5 1.5 0 0 1 5.5 11z', 'M12 15v2.5'],
  dice: ['M6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5v-11A2.5 2.5 0 0 1 6.5 4z', 'M8.6 8.6h.01M15.4 8.6h.01M12 12h.01M8.6 15.4h.01M15.4 15.4h.01'],
  refresh: ['M19.5 12a7.5 7.5 0 1 1-2.2-5.3', 'M19.5 4.5v4h-4'],
  sliders: ['M4 7h9M17 7h3M4 17h3M11 17h9', 'M15 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', 'M9 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z'],
};
function icon(name, cls) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', name === 'more' ? '3.2' : name === 'dice' ? '2.2' : '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (cls) svg.setAttribute('class', cls);
  for (const d of ICONS[name]) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

function tileColor(text) {
  let n = 0;
  for (const ch of text || '') n = (n * 31 + ch.codePointAt(0)) >>> 0;
  return TILE_COLORS[n % TILE_COLORS.length];
}
function tile(title) {
  const t = (title || '').trim();
  const letter = t ? Array.from(t)[0].toUpperCase() : '?';
  return h('span', { class: 'tile', style: { background: tileColor(t) }, 'aria-hidden': 'true', text: letter });
}
function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}

// ===== [CRYPTO] PRD 3장 =====
const textEnc = new TextEncoder();
const textDec = new TextDecoder();
function randomBytes(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return a; }
function toB64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(str) {
  const s = atob(str);
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
}
// 마스터 비밀번호 + salt → AES-GCM 256 키 (키는 꺼낼 수 없게 extractable=false)
async function deriveKey(password, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', textEnc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
// 저장할 때마다 새 IV 12바이트 (재사용 금지)
async function encryptPayload(session, payload) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, session.key, textEnc.encode(JSON.stringify(payload)));
  return {
    format: 'vaultnote', version: 1, kdf: 'PBKDF2-SHA256', iterations: session.iterations,
    salt: toB64(session.salt), iv: toB64(iv), ciphertext: toB64(ct),
  };
}
// 복호화 실패(틀린 비밀번호 또는 손상) 시 예외가 난다 — GCM 인증 태그가 검증 역할
async function decryptRecord(key, rec) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(rec.iv) }, key, fromB64(rec.ciphertext));
  return JSON.parse(textDec.decode(pt));
}
function isValidRecord(r) {
  return !!r && r.format === 'vaultnote' && r.version === 1 && r.kdf === 'PBKDF2-SHA256'
    && Number.isInteger(r.iterations) && r.iterations >= 100000 && r.iterations <= MAX_ITERATIONS
    && typeof r.salt === 'string' && typeof r.iv === 'string' && typeof r.ciphertext === 'string';
}
function isValidPayload(p) {
  return !!p && p.version === 1 && p.root && p.root.type === 'folder' && Array.isArray(p.root.children);
}
// 비밀번호 생성기: Web Crypto 난수, 치우침 없는 추출, 고른 종류마다 최소 1글자
const GEN_SETS = {
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', lower: 'abcdefghijklmnopqrstuvwxyz',
  digits: '0123456789', symbols: '!@#$%^&*-_=+?.,:;',
};
const GEN_DEFAULTS = { length: 16, upper: true, lower: true, digits: true, symbols: true };
function randomIndex(n) {
  const limit = Math.floor(0x100000000 / n) * n;
  const a = new Uint32Array(1);
  do { crypto.getRandomValues(a); } while (a[0] >= limit);
  return a[0] % n;
}
function generatePassword(opts) {
  const sets = ['upper', 'lower', 'digits', 'symbols'].filter((k) => opts[k]).map((k) => GEN_SETS[k]);
  if (!sets.length) sets.push(GEN_SETS.lower);
  const all = sets.join('');
  const chars = sets.map((set) => set[randomIndex(set.length)]);
  while (chars.length < opts.length) chars.push(all[randomIndex(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
const WEAK_MESSAGE = '추측하기 쉬운 비밀번호입니다. 흔한 단어·연속된 글자(1234, qwerty)·반복을 피하고, 서로 관련 없는 단어 4개 이상을 띄어 써 보세요.';
// 흔한 비밀번호 단어 (영문 자판으로 친 한글 포함: dkssud=안녕, tkfkd=사랑, qlalfqjsgh=비밀번호)
const COMMON_WORDS = [
  'password', 'passw0rd', 'p@ssword', 'qwerty', 'qwer', 'asdf', 'zxcv', 'qazwsx', '1q2w3e4r', '1q2w3e', 'q1w2e3', 'zaq1',
  'iloveyou', 'admin', 'welcome', 'letmein', 'dragon', 'monkey', 'master', 'sunshine', 'princess', 'football',
  'baseball', 'superman', 'batman', 'trustno1', 'login', 'hello', 'freedom', 'whatever', 'shadow', 'secret',
  'changeme', 'default', 'test', 'guest', 'user', 'root', 'love', 'korea', 'seoul', 'samsung', 'naver', 'kakao',
  'google', 'apple', 'sarang', 'saranghae', 'dkssud', 'dkssudgktpdy', 'tkfkd', 'tkfkdgo', 'qlalfqjsgh', 'ghkdlxld',
  '사랑', '사랑해', '비밀번호', '안녕', '안녕하세요', '대한민국', '화이팅',
].sort((a, b) => b.length - a.length);
const SEQUENCES = ['abcdefghijklmnopqrstuvwxyz', '01234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1qaz2wsx3edc4rfv'];
function isSequential(a, b) {
  return SEQUENCES.some((row) => { const i = row.indexOf(a); return i >= 0 && (row[i + 1] === b || row[i - 1] === b); });
}
// 대략적인 추측 난이도(비트). 흔한 단어·반복·연속 글자는 거의 0으로 친다 (검토 2)
function guessBits(pw) {
  const words = pw.trim().split(/\s+/).filter((w) => Array.from(w).length >= 2);
  const distinct = new Set(words.map((w) => w.toLocaleLowerCase())).size;
  if (words.length >= 4 && distinct >= 4 && Array.from(pw).length >= 16) {
    const commonWords = words.filter((w) => COMMON_WORDS.includes(w.toLocaleLowerCase())).length;
    return (distinct - commonWords) * 12 + commonWords * 4; // 사람이 고른 단어 하나 ≈ 12비트로 보수적으로 계산
  }
  let rest = pw.toLocaleLowerCase();
  let wordHits = 0;
  for (const w of COMMON_WORDS) while (rest.includes(w)) { rest = rest.replace(w, '\u0000'); wordHits++; }
  const chars = Array.from(rest);
  let random = 0;
  let predictable = 0;
  chars.forEach((c, i) => {
    if (c === '\u0000') return;
    const prev = chars[i - 1];
    if (prev && prev !== '\u0000' && (c === prev || isSequential(prev, c))) predictable++;
    else random++;
  });
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^A-Za-z0-9\s가-힣]/.test(pw)) pool += 33;
  if (/[가-힣]/.test(pw)) pool += 32;                  // 한글은 단어로 쓰이므로 글자당 약 5비트로 낮춰 계산
  if (/\s/.test(pw)) pool += 1;
  return random * Math.log2(Math.max(pool, 2)) + predictable + wordHits * 10;
}
function passwordStrength(pw) {
  if (!pw) return { level: 0, label: '' };
  if (Array.from(pw).length < MIN_PASSWORD) return { level: 1, label: '약함' };
  const bits = guessBits(pw);
  if (bits >= 60) return { level: 3, label: '강함' };
  if (bits >= 44) return { level: 2, label: '보통' };
  return { level: 1, label: '약함' };
}
// 같은 한글도 입력 방식에 따라 바이트가 달라질 수 있어 NFC로 맞춘다. 옛 금고 호환을 위해 원문도 한 번 시도 (검토 4)
function passwordVariants(pw) {
  return [...new Set([pw.normalize('NFC'), pw, pw.normalize('NFD')])]; // 첫 번째(NFC)가 새 기준
}

// ===== [STORAGE] IndexedDB: current(현재)·previous(직전)·snapshots(저장본 기록) 슬롯, 암호문만 저장 =====
let memoryStore = null; // 자동 테스트용 (실제 앱에서는 쓰지 않는다)
let dbPromise = null;
function openDB() {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, 1); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; }; // 다른 탭이 DB를 바꾸면 연결을 닫는다
      db.onclose = () => { dbPromise = null; };                   // 브라우저가 연결을 닫으면 다음에 다시 연다
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('blocked'));
  });
}
function getDB() {
  if (!dbPromise) dbPromise = openDB().catch((e) => { dbPromise = null; throw e; });
  return dbPromise;
}
// 연결이 끊겨 있으면 한 번 다시 연결해 재시도한다
async function withDB(fn) {
  try {
    return await fn(await getDB());
  } catch (e) {
    if (e && (e.name === 'InvalidStateError' || e.name === 'TransactionInactiveError')) {
      dbPromise = null;
      return fn(await getDB());
    }
    throw e;
  }
}
async function initStorage() {
  if (memoryStore) return true;
  if (typeof indexedDB === 'undefined') return false;
  try { await getDB(); return true; } catch { return false; }
}
async function readSlot(name) {
  if (memoryStore) return memoryStore[name] || null;
  return withDB((db) => new Promise((resolve, reject) => {
    const req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(name);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  }));
}
// 한 트랜잭션 안에서 현재 → 직전, 새 암호문 → 현재. 전부 성공하거나 전부 실패한다.
// 다른 창이 그사이 저장했다면(writeId가 다르면) 덮어쓰지 않고 'conflict'로 실패한다
async function writeRecord(rec) {
  const expected = state.writeId;
  rec.writeId = uid();                       // 비밀이 아닌 저장 번호 (충돌 감지용)
  if (memoryStore) {
    if (memoryStore.current && memoryStore.current.writeId !== expected) throw new Error('conflict');
    if (memoryStore.current) memoryStore.previous = memoryStore.current;
    memoryStore.current = rec;
    state.writeId = rec.writeId;
    return;
  }
  await withDB((db) => new Promise((resolve, reject) => {
    let conflict = false;
    const tx = db.transaction(DB_STORE, 'readwrite');
    const store = tx.objectStore(DB_STORE);
    const cur = store.get('current');
    cur.onsuccess = () => {
      if (cur.result && cur.result.writeId !== expected) { conflict = true; tx.abort(); return; }
      if (cur.result) store.put(cur.result, 'previous');
      store.put(rec, 'current');
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(conflict ? new Error('conflict') : tx.error);
    tx.onabort = () => reject(conflict ? new Error('conflict') : (tx.error || new Error('저장이 취소되었습니다')));
  }));
  state.writeId = rec.writeId;
}
// 여러 슬롯을 한 트랜잭션으로 쓴다 (값이 null이면 지움)
async function writeSlots(slots) {
  if (memoryStore) {
    for (const [k, v] of Object.entries(slots)) { if (v === null) delete memoryStore[k]; else memoryStore[k] = v; }
    return;
  }
  await withDB((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    const store = tx.objectStore(DB_STORE);
    for (const [k, v] of Object.entries(slots)) { if (v === null) store.delete(k); else store.put(v, k); }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('저장이 취소되었습니다'));
  }));
}
// ----- 저장본 기록 (검토 5): 지금 저장본을 그대로(암호문 상태로) 복사해 둔다 -----
async function readSnapshots() {
  const list = await readSlot('snapshots');
  return Array.isArray(list) ? list.filter((x) => x && isValidRecord(x.rec)) : [];
}
async function snapshotCurrent(reason, kind) {
  try {
    const cur = await readSlot('current');
    if (!isValidRecord(cur)) return;
    const list = await readSnapshots();
    list.push({ id: uid(), at: now(), reason, kind, rec: cur });
    const keep = new Set();
    for (const [k, n] of Object.entries(SNAP_KEEP)) list.filter((x) => x.kind === k).slice(-n).forEach((x) => keep.add(x.id));
    await writeSlots({ snapshots: list.filter((x) => keep.has(x.id)) });
  } catch { /* 기록을 못 남겨도 저장 자체는 막지 않는다 */ }
}
async function requestPersist() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      state.persisted = (await navigator.storage.persisted()) || (await navigator.storage.persist());
    }
  } catch { state.persisted = null; }
}
let saveChain = Promise.resolve();
// 저장과 관련된 작업은 모두 한 줄로 세워 차례대로 실행한다
function queue(task) {
  const p = saveChain.then(task);
  saveChain = p.catch(() => {});
  return p;
}
function takeSnapshot(reason) { return queue(() => snapshotCurrent(reason, 'protected')); }
function saveVault(tree) {
  const session = state.session;
  if (!session) return Promise.resolve();
  const payload = { version: 1, savedAt: now(), root: tree, meta: state.meta };
  return queue(async () => {
    if (state.dailyDay !== dateStamp()) {          // 그날 첫 저장 전에 기록을 남긴다
      await snapshotCurrent('그날 첫 변경 전', 'daily');
      state.dailyDay = dateStamp();
    }
    await writeRecord(await encryptPayload(session, payload));
    state.lastSavedAt = payload.savedAt;
    state.saveFailures = 0;
    if (state.saveBroken) { state.saveBroken = false; softRender(); }
  }).catch((e) => {
    if (e && e.message === 'conflict') {
      lockVault('다른 창에서 금고가 바뀌어 이 창을 잠갔습니다. 다시 열면 최신 내용이 보입니다.');
      return;
    }
    state.saveFailures = (state.saveFailures || 0) + 1;
    if (state.saveFailures >= 2 && state.phase === 'open') {
      state.saveBroken = true;
      state.alert = {
        title: '저장이 되지 않고 있습니다', fresh: true,
        message: '최근 변경이 기기에 저장되지 않았습니다. 잃지 않도록 지금 백업 파일을 만든 뒤, 앱을 완전히 닫았다가 다시 여세요. 그동안 편집은 막아 둡니다.',
        buttons: [{ label: '닫기' }, { label: '지금 백업', bold: true, run: () => exportBackup() }],
      };
      render();
    } else {
      showToast('저장하지 못했습니다. 다음 변경 때 다시 시도합니다.');
    }
  });
}

// ===== [TREE] 화면을 건드리지 않는 트리 조작 함수 =====
function makeFolder(name) {
  const t = now();
  return { id: uid(), type: 'folder', name, sort: 'name', children: [], createdAt: t, updatedAt: t };
}
function makeEntry(f) {
  const t = now();
  return {
    id: uid(), type: 'entry',
    title: f.title || '', url: f.url || '', username: f.username || '', password: f.password || '', memo: f.memo || '',
    createdAt: t, updatedAt: t,
  };
}
// 불러온 트리를 검사해 정리한다 (손상·옛 형식 대비). 정상 트리는 그대로 나온다
function sanitizeTree(input) {
  const seen = new Set(['root']);
  const str = (v, max) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max);
  const num = (v) => (Number.isFinite(v) ? v : now());
  const goodId = (v) => {
    const id = typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v) && !seen.has(v) ? v : uid();
    seen.add(id);
    return id;
  };
  const src = input && typeof input === 'object' ? input : {};
  const root = {
    id: 'root', type: 'folder', name: '전체', sort: src.sort === 'manual' ? 'manual' : 'name', children: [],
    createdAt: num(src.createdAt), updatedAt: num(src.updatedAt),
  };
  (function fill(from, to, depth) {
    const kids = Array.isArray(from && from.children) ? from.children : [];
    for (const c of kids) {
      if (!c || typeof c !== 'object') continue;
      if (c.type === 'folder') {
        if (depth >= MAX_DEPTH) { fill(c, to, depth); continue; }   // 너무 깊으면 위 폴더에 합친다
        const f = {
          id: goodId(c.id), type: 'folder', name: str(c.name, 200) || '이름 없는 폴더',
          sort: c.sort === 'manual' ? 'manual' : 'name', children: [], createdAt: num(c.createdAt), updatedAt: num(c.updatedAt),
        };
        to.children.push(f);
        fill(c, f, depth + 1);
      } else if (c.type === 'entry') {
        to.children.push({
          id: goodId(c.id), type: 'entry', title: str(c.title, 200) || '제목 없음',
          url: str(c.url, 2000), username: str(c.username, 500), password: str(c.password, 1000), memo: str(c.memo, 20000),
          createdAt: num(c.createdAt), updatedAt: num(c.updatedAt),
        });
      }
    }
  })(src, root, 0);
  return root;
}
function emptyTree() { const r = makeFolder('전체'); r.id = 'root'; return r; }
function nameOf(node) { return node.type === 'folder' ? node.name : node.title; }

// 노드와 그 조상 폴더 목록(path: 루트부터 부모까지)을 찾는다
function findWithPath(root, id, path = []) {
  if (root.id === id) return { node: root, path };
  if (root.type !== 'folder') return null;
  for (const child of root.children) {
    const found = findWithPath(child, id, [...path, root]);
    if (found) return found;
  }
  return null;
}
function findNode(root, id) { const r = findWithPath(root, id); return r ? r.node : null; }
function findParent(root, id) {
  const r = findWithPath(root, id);
  return r && r.path.length ? r.path[r.path.length - 1] : null;
}
function folderDepth(root, id) { const r = findWithPath(root, id); return r ? r.path.length : 0; } // 루트=0
function folderHeight(folder) {
  let max = 0;
  for (const c of folder.children) if (c.type === 'folder') max = Math.max(max, folderHeight(c));
  return 1 + max;
}
function countEntries(folder) {
  let n = 0;
  for (const c of folder.children) n += c.type === 'entry' ? 1 : countEntries(c);
  return n;
}
function allEntries(folder, out = []) {
  for (const c of folder.children) { if (c.type === 'entry') out.push(c); else allEntries(c, out); }
  return out;
}
function walkFolders(folder, fn, depth = 0) {
  fn(folder, depth);
  for (const c of sortedChildren(folder)) if (c.type === 'folder') walkFolders(c, fn, depth + 1);
}
function sortedChildren(folder) {
  if (folder.sort === 'manual') return [...folder.children];
  return [...folder.children].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return collator.compare(nameOf(a), nameOf(b));
  });
}
function canAddSubfolder(root, folderId) { return folderDepth(root, folderId) < MAX_DEPTH; }
function canMoveTo(root, id, targetId) {
  const r = findWithPath(root, id);
  if (!r || id === targetId) return false;
  const target = findWithPath(root, targetId);
  if (!target || target.node.type !== 'folder') return false;
  if (target.path.some((p) => p.id === id)) return false;               // 자기 하위로는 이동 불가
  if (r.node.type === 'folder') return target.path.length + folderHeight(r.node) <= MAX_DEPTH;
  return true;
}
function addNode(root, parentId, node) {
  const parent = findNode(root, parentId) || root;
  parent.children.push(node);
  parent.updatedAt = now();
}
function removeNode(root, id) {
  const parent = findParent(root, id);
  const index = parent.children.findIndex((c) => c.id === id);
  const [node] = parent.children.splice(index, 1);
  return { node, parentId: parent.id, index };
}
function insertNode(root, parentId, node, index) {
  const parent = findNode(root, parentId) || root;
  parent.children.splice(Math.min(index, parent.children.length), 0, node);
}
function moveNode(root, id, newParentId) {
  const { node } = removeNode(root, id);
  node.updatedAt = now();
  addNode(root, newParentId, node);
}
function reorderNode(root, id, dir) {
  const parent = findParent(root, id);
  if (parent.sort !== 'manual') { parent.children = sortedChildren(parent); parent.sort = 'manual'; }
  const i = parent.children.findIndex((c) => c.id === id);
  const j = i + dir;
  if (j < 0 || j >= parent.children.length) return;
  [parent.children[i], parent.children[j]] = [parent.children[j], parent.children[i]];
}
function pathText(path) {
  const names = path.filter((p) => p.id !== 'root').map((p) => p.name);
  return names.length ? names.join(' › ') : '최상위';
}
function searchEntries(root, query) {
  const needle = query.trim().toLocaleLowerCase('ko');
  const results = [];
  (function walk(folder, path) {
    for (const c of folder.children) {
      if (c.type === 'folder') walk(c, [...path, c]);
      else if ([c.title, c.url, c.username, c.memo].some((v) => v.toLocaleLowerCase('ko').includes(needle))) {
        results.push({ entry: c, path }); // PW는 검색 대상 아님 (F-4)
      }
    }
  })(root, []);
  return results.sort((a, b) => collator.compare(a.entry.title, b.entry.title));
}

// 테스트용 가짜 데이터 (진짜 비밀번호 아님)
function sampleTree() {
  const root = emptyTree();
  const F = (name, ...kids) => { const f = makeFolder(name); f.children = kids; return f; };
  const E = (title, url, username, password, memo = '') => makeEntry({ title, url, username, password, memo });
  root.children = [
    F('금융',
      F('은행',
        E('국민은행', 'https://www.kbstar.com', 'test_kb01', 'Fake!Kb2026', '인증서는 별도 보관'),
        E('신한은행', 'https://www.shinhan.com', 'test_sh01', 'Fake#Sh:2026')),
      F('카드', E('현대카드', 'https://www.hyundaicard.com', 'test_card', 'Fake-Card-77')),
      E('키움증권', 'https://www.kiwoom.com', 'test_stock', 'Fake$Stock1')),
    F('쇼핑',
      E('쿠팡', 'https://www.coupang.com', 'test@example.com', 'Fake!Cp2026'),
      E('11번가', 'https://www.11st.co.kr', 'test_11st', 'Fake11st!'),
      E('무신사', 'https://www.musinsa.com', 'test_ms', 'FakeMs#99')),
    F('업무',
      E('회사 메일', 'https://mail.example.com', 'hong.gildong', 'Fake:Work 01', '2단계 인증 앱 사용\n복구 코드는 종이에 보관'),
      E('그룹웨어', 'https://gw.example.com', 'hong.gildong', 'FakeGw2026')),
    F('개인',
      E('네이버', 'https://www.naver.com', 'test_naver', 'FakeNv!2026'),
      E('카카오', 'https://accounts.kakao.com', 'test@example.com', 'FakeKk#2026')),
  ];
  return root;
}

// ===== [TEXT] 트리 텍스트 형식 (PRD 2장 해석 규칙) =====
const KEY_ALIASES = {
  url: 'url', '주소': 'url',
  id: 'username', username: 'username', '아이디': 'username',
  pw: 'password', password: 'password', '비밀번호': 'password', '비번': 'password',
  memo: 'memo', '메모': 'memo',
};
function indentWidth(line) {
  let n = 0;
  while (n < line.length && line[n] === ' ') n++;
  return n;
}
function appendMemo(entry, text) {
  if (entry) entry.memo = entry.memo ? `${entry.memo}\n${text}` : text;
}
function parseTreeText(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/).map((l) => l.replace(/\t/g, '  '));
  const root = emptyTree();
  const folders = [root];               // folders[i] = 깊이 i의 폴더 (0 = 최상위)
  const warnings = [];
  const unparsed = [];
  let folderCount = 0;
  let entryCount = 0;
  let cur = null;                       // 지금 읽고 있는 계정
  let curIndent = -1;
  let memo = null;                      // 여러 줄 메모: { indent, lines }
  const finishMemo = () => {
    if (!memo) return;
    while (memo.lines.length && memo.lines[memo.lines.length - 1] === '') memo.lines.pop();
    appendMemo(cur, memo.lines.join('\n'));
    memo = null;
  };
  lines.forEach((line, i) => {
    const lineNo = i + 1;
    const ind = indentWidth(line);
    const body = line.slice(ind);
    if (memo) {
      if (body === '') { memo.lines.push(''); return; }
      if (ind > memo.indent) { memo.lines.push(line.slice(Math.min(ind, memo.indent + 2))); return; }
      finishMemo();
    }
    if (body.trim() === '') return;
    const level = Math.floor(ind / 2);

    if (body === '#' || body.startsWith('# ')) {           // 폴더
      cur = null;
      const name = body.slice(2).trim() || '이름 없는 폴더';
      const d = Math.min(level + 1, folders.length);
      folders.length = d;
      const parent = folders[d - 1];
      if (d > MAX_DEPTH) {
        warnings.push(`${lineNo}번째 줄: ‘${name}’ 폴더는 ${MAX_DEPTH}단계를 넘어 위 폴더에 합쳤습니다.`);
        folders.push(parent);
        return;
      }
      const f = makeFolder(name);
      parent.children.push(f);
      folders.push(f);
      folderCount++;
      return;
    }
    if (body === '-' || body.startsWith('- ')) {           // 계정
      const d = Math.min(level, folders.length - 1);
      folders.length = d + 1;
      cur = makeEntry({ title: body.slice(2).trim() || '제목 없음' });
      curIndent = ind;
      folders[d].children.push(cur);
      entryCount++;
      return;
    }
    const m = /^([^:]+?):( ?)(.*)$/.exec(body);             // 키: 값 (값은 콜론+공백 뒤 그대로)
    if (m && cur && ind > curIndent) {
      const key = KEY_ALIASES[m[1].trim().toLowerCase()];
      const val = m[3];
      if (key === 'memo' && val === '|') { memo = { indent: ind, lines: [] }; return; }
      if (key === 'memo') appendMemo(cur, val);
      else if (key) cur[key] = val;
      else appendMemo(cur, body);                           // 모르는 키는 메모에 그대로
      return;
    }
    unparsed.push({ line: lineNo, text: body.length > 40 ? `${body.slice(0, 40)}…` : body });
  });
  finishMemo();
  return { root, folderCount, entryCount, warnings, unparsed };
}
function treeToText(root) {
  const out = [];
  const pad = (n) => '  '.repeat(n);
  (function walk(folder, level) {
    for (const c of sortedChildren(folder)) {
      if (c.type === 'folder') {
        out.push(`${pad(level)}# ${c.name}`);
        walk(c, level + 1);
        continue;
      }
      const k = pad(level + 1);
      out.push(`${pad(level)}- ${c.title}`);
      if (c.url) out.push(`${k}url: ${c.url}`);
      if (c.username) out.push(`${k}id: ${c.username}`);
      if (c.password) out.push(`${k}pw: ${c.password}`);
      if (c.memo) {
        if (c.memo.includes('\n') || c.memo === '|') {
          out.push(`${k}memo: |`);
          for (const ln of c.memo.split('\n')) out.push(ln ? `${k}  ${ln}` : '');
        } else {
          out.push(`${k}memo: ${c.memo}`);
        }
      }
    }
  })(root, 0);
  return `${out.join('\n')}\n`;
}

// ===== [FILES] 파일 고르기·내려받기 =====
function dateStamp(ts = now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function pickFile(accept) {
  for (const old of document.querySelectorAll('.file-picker')) old.remove();
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', class: 'file-picker', accept, style: { display: 'none' } });
    let done = false;
    const finish = (file) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(file || null);
    };
    input.addEventListener('change', () => finish(input.files && input.files[0]), { once: true });
    input.addEventListener('cancel', () => finish(null), { once: true }); // 취소해도 반드시 끝나게 한다
    document.body.appendChild(input);
    input.click();
  });
}
async function readTextFile(file) {
  const buf = await file.arrayBuffer();
  let text = new TextDecoder('utf-8').decode(buf);
  let note = '';
  if (text.includes('\uFFFD')) {         // 한글 윈도 메모장(EUC-KR) 파일 대비
    try { text = new TextDecoder('euc-kr').decode(buf); note = 'EUC-KR 인코딩으로 읽었습니다.'; } catch { /* 그대로 */ }
  }
  return { text, note };
}
function downloadFile(content, filename, mime) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = h('a', { href: url, download: filename, style: { display: 'none' } });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ===== [STATE] 앱의 모든 데이터와 화면 상태 =====
const state = {
  phase: 'loading',        // loading | setup | unlock | open | error
  errorMessage: '',
  session: null,           // 잠금 해제 중에만 존재: { key, salt, iterations }
  tree: null,              // 잠금 해제 중에만 존재 (복호화된 트리)
  meta: {},                // 금고 정보(마지막 백업 시각 등). 트리와 함께 암호화된다
  bannerDismissed: false,
  importPreview: null,     // 텍스트 가져오기 미리보기 (평문, 메모리에만)
  cleanup: null,           // 가져오기 후 원본 정리 체크
  form: {},                // 설정·잠금 해제 화면 입력값
  busy: null,              // 처리 중 안내 문구
  unlockMs: null,          // 마지막 잠금 해제(키 생성) 시간
  lastSavedAt: null,
  writeId: undefined,      // 마지막으로 읽거나 쓴 저장 번호 (다른 창 충돌 감지)
  storageInfo: null,
  selfTest: null,
  expanded: new Set(),
  stack: [{ name: 'home' }],
  editing: false,
  search: '',
  sheet: null,
  alert: null,
  toast: null,
  undo: null,
  draft: null,
  reveal: new Map(),       // PW를 보이게 한 계정 id → 숨길 시각
  clipAt: null,            // 마지막으로 클립보드에 복사한 시각
  hiddenAt: null,          // 다른 앱으로 전환된 시각
  lastActivity: Date.now(),
  expectExternal: false,   // 파일 선택 창 등으로 잠시 나가는 중
  persisted: null,         // 브라우저 영구 보관 허용 여부
  gen: null,               // 비밀번호 생성기 설정과 결과
  sw: { supported: false, controlled: false, activeVersion: null, waiting: null, waitingVersion: null, error: false },
  installPrompt: null,     // 크롬의 '앱 설치' 요청 (있을 때만)
  scroll: {},
  anim: null,
  focusField: null,
  historyOK: false,
};
let toastTimer = null;
let searchTimer = null;
let clipTimer = null;

function autoLockMin() { return AUTOLOCK_CHOICES.includes(state.meta.autoLockMin) ? state.meta.autoLockMin : 3; }
function graceSec() { return GRACE_CHOICES.includes(state.meta.graceSec) ? state.meta.graceSec : 60; }
function graceLabel(sec) { return sec === 0 ? '즉시' : `${sec / 60}분 후`; }
function setMeta(patch) {
  state.meta = { ...state.meta, ...patch };
  saveVault(state.tree);
  render();
}

function topScreen() { return state.stack[state.stack.length - 1]; }
function screenKey(s) {
  if (state.phase !== 'open') return `phase:${state.phase}`;
  return s ? `${s.name}:${s.id || ''}` : '';
}

// 데이터 변경은 반드시 commit을 거친다: 변경 → 암호화 저장 → 다시 그리기
function commit(mutator) {
  if (!state.tree) return;
  if (state.saveBroken) {
    state.alert = { title: '편집을 막아 두었습니다', fresh: true, message: '저장이 되지 않는 상태입니다. 백업 파일을 만든 뒤 앱을 다시 여세요.', buttons: [{ label: '닫기' }, { label: '지금 백업', bold: true, run: () => exportBackup() }] };
    render();
    return;
  }
  const next = clone(state.tree);
  mutator(next);
  state.tree = next;
  saveVault(state.tree);
  render();
}

function expandTo(folderId) {
  const r = findWithPath(state.tree, folderId);
  if (!r) return;
  for (const p of r.path) state.expanded.add(p.id);
  state.expanded.add(folderId);
}

function showToast(message, undoable = false) {
  clearTimeout(toastTimer);
  if (!undoable) state.undo = null;
  state.toast = { message, undoable, fresh: true };
  toastTimer = setTimeout(hideToast, undoable ? UNDO_MS : TOAST_MS);
  render();
}
// 타이머로는 화면 전체를 다시 그리지 않는다 (입력 중인 한글 조합 보호, 10-1)
function hideToast() {
  state.toast = null;
  state.undo = null;
  const el = root.querySelector('.toast');
  if (el) el.remove();
}

// ----- 금고 만들기 · 잠금 해제 · 잠금 -----
async function createVault() {
  const f = state.form;
  const pw = f.setupPw || '';
  if (Array.from(pw).length < MIN_PASSWORD) return formError(`마스터 비밀번호는 ${MIN_PASSWORD}자 이상이어야 합니다.`);
  if (passwordStrength(pw).level < 2) return formError(WEAK_MESSAGE);
  if (pw.normalize('NFC') !== (f.setupPw2 || '').normalize('NFC')) return formError('비밀번호 확인이 일치하지 않습니다.');
  if (!f.agree) return formError('복구 불가 안내를 확인하고 동의해 주세요.');
  state.busy = '금고를 만드는 중…';
  render();
  try {
    if (await readSlot('current')) throw new Error('이미 금고가 있습니다.'); // 기존 금고 덮어쓰기 방지
    state.writeId = undefined;
    const salt = randomBytes(16);
    const t0 = performance.now();
    const key = await deriveKey(pw.normalize('NFC'), salt, KDF_ITERATIONS);
    state.unlockMs = performance.now() - t0;
    const session = { key, salt, iterations: KDF_ITERATIONS };
    const tree = f.sample ? sampleTree() : emptyTree();
    const savedAt = now();
    await writeRecord(await encryptPayload(session, { version: 1, savedAt, root: tree, meta: {} }));
    state.lastSavedAt = savedAt;
    openVault(session, tree, {});
    showToast('금고를 만들었습니다.');
  } catch (e) {
    state.form.setupPw = '';
    state.form.setupPw2 = '';
    formError(e && e.message === '이미 금고가 있습니다.' ? '이 기기에 이미 금고가 있습니다. 앱을 다시 열어 주세요.' : '금고를 만들지 못했습니다. 다시 시도해 주세요.');
  } finally {
    state.busy = null;
    render();
  }
}
async function unlockVault() {
  const pw = state.form.unlockPw || '';
  if (!pw) return formError('마스터 비밀번호를 입력하세요.');
  state.busy = '잠금 해제 중…';
  render();
  try {
    const guard = (await readSlot('guard')) || { fails: 0, until: 0 };
    if (now() < guard.until) {
      state.form.unlockPw = '';
      formError(`연속으로 ${MAX_FAILS}번 틀려 잠시 막았습니다. ${Math.ceil((guard.until - now()) / 1000)}초 후 다시 시도하세요.`);
      return;
    }
    const cur = await readSlot('current');
    if (!isValidRecord(cur)) throw new Error('corrupt');
    const salt = fromB64(cur.salt);
    const prev = await readSlot('previous');
    let payload = null;
    let usedPrevious = false;
    let key = null;
    let legacy = false;
    let ms = 0;
    for (const [i, variant] of passwordVariants(pw).entries()) {
      const t0 = performance.now();
      const k = await deriveKey(variant, salt, cur.iterations);
      if (i === 0) ms = performance.now() - t0;
      try {
        payload = await decryptRecord(k, cur);
      } catch {
        // 현재 저장본이 손상됐을 수 있으므로 같은 키로 직전 저장본을 시도한다
        if (isValidRecord(prev) && prev.salt === cur.salt) {
          try { payload = await decryptRecord(k, prev); usedPrevious = true; } catch { payload = null; }
        }
      }
      if (isValidPayload(payload)) { key = k; legacy = i > 0; break; }
      payload = null;
    }
    if (!isValidPayload(payload)) {
      const fails = guard.fails + 1;
      const blocked = fails >= MAX_FAILS;
      await writeSlots({ guard: blocked ? { fails: 0, until: now() + FAIL_WAIT_MS } : { fails, until: 0 } });
      state.form.unlockPw = '';
      formError(blocked
        ? `${MAX_FAILS}번 연속으로 틀렸습니다. ${FAIL_WAIT_MS / 1000}초 동안 잠금 해제를 막습니다.`
        : `비밀번호가 맞지 않습니다. (${fails}/${MAX_FAILS})`);
      return;
    }
    if (guard.fails || guard.until) await writeSlots({ guard: { fails: 0, until: 0 } });
    state.unlockMs = ms;
    state.lastSavedAt = payload.savedAt || null;
    state.writeId = cur.writeId;
    openVault({ key, salt, iterations: cur.iterations }, sanitizeTree(payload.root), payload.meta);
    if (usedPrevious) showToast('최근 저장본을 열 수 없어 직전 저장본을 열었습니다.');
    if (legacy || cur.iterations < KDF_ITERATIONS) {   // 옛 방식(정규화 전·낮은 반복 횟수)이면 새 기준으로 다시 암호화 (검토 4·12)
      state.busy = '보안 설정을 최신 기준으로 바꾸는 중…';
      render();
      try {
        await rekeyVault(pw);
        showToast('보안 설정을 최신 기준으로 바꿨습니다. 비밀번호는 그대로입니다.');
      } catch { /* 실패해도 기존 금고는 그대로 쓸 수 있다 */ }
    }
  } catch {
    formError('저장된 금고를 읽지 못했습니다. 백업 파일로 복원이 필요할 수 있습니다.');
  } finally {
    state.busy = null;
    render();
  }
}
function formError(message) {
  state.form.error = message;
  render();
}
const instanceId = uid();
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('vaultnote') : null;
if (channel) {
  // 다른 창에서 금고를 열면 이 창은 잠근다 (두 창이 서로 덮어쓰는 것 방지)
  channel.onmessage = (e) => {
    const d = e.data || {};
    if (d.type === 'opened' && d.from !== instanceId && state.phase === 'open') lockVault('다른 창에서 금고를 열어 이 창은 잠갔습니다.');
  };
}
function openVault(session, tree, meta) {
  state.session = session;
  state.tree = tree;
  state.meta = meta ? { ...meta } : {};
  state.bannerDismissed = false;
  state.form = {};
  state.phase = 'open';
  state.stack = [{ name: 'home' }];
  state.expanded = new Set();
  const first = tree.children.find((c) => c.type === 'folder');
  if (first) state.expanded.add(first.id);
  state.scroll = {};
  state.anim = null;
  state.lastActivity = now();
  state.hiddenAt = null;
  requestPersist();
  if (channel) channel.postMessage({ type: 'opened', from: instanceId });
  state.dailyDay = null;
  queue(async () => {
    const daily = (await readSnapshots()).filter((x) => x.kind === 'daily').pop();
    state.dailyDay = daily ? dateStamp(daily.at) : null;
  });
  if (state.meta.pendingDraft) offerPendingDraft();
}
function offerPendingDraft() {
  const p = state.meta.pendingDraft;
  state.alert = {
    title: '잠기기 전에 편집하던 내용이 있습니다', fresh: true,
    message: `${p.fields.title || '제목 없음'} (${dateFmt.format(p.at)})`,
    buttons: [
      { label: '버리기', danger: true, run: () => setMeta({ pendingDraft: undefined }) },
      { label: '이어서 편집', bold: true, run: () => resumePendingDraft() },
    ],
  };
}
function resumePendingDraft() {
  const p = state.meta.pendingDraft;
  setMeta({ pendingDraft: undefined });
  if (!p) return;
  const e = p.entryId ? findNode(state.tree, p.entryId) : null;
  const base = e ? { title: e.title, url: e.url, username: e.username, password: e.password, memo: e.memo }
    : { title: '', url: '', username: '', password: '', memo: '' };
  state.draft = {
    entryId: e ? e.id : null,
    parentId: e ? findParent(state.tree, e.id).id : (findNode(state.tree, p.parentId) ? p.parentId : 'root'),
    fields: { ...base, ...p.fields }, orig: JSON.stringify(base), showPw: false,
  };
  push({ name: 'edit' });
}
function lockVault(reason, opts = {}) {
  clearClipboard();
  // 자동 잠금·직접 잠금이면 편집 중이던 내용을 암호화된 금고 안에 임시 보관한다 (검토 14)
  if (opts.keepDraft && state.session && isDraftDirty()) {
    const d = state.draft;
    state.meta = { ...state.meta, pendingDraft: { entryId: d.entryId, parentId: d.parentId, fields: { ...d.fields }, at: now() } };
    saveVault(state.tree);
  }
  state.expectExternal = false;
  state.session = null;
  state.tree = null;
  state.meta = {};
  state.importPreview = null;
  state.cleanup = null;
  state.draft = null;
  state.reveal = new Map();
  state.sheet = null;
  state.alert = null;
  state.undo = null;
  state.search = '';
  state.editing = false;
  state.selfTest = null;
  state.storageInfo = null;
  state.stack = [{ name: 'home' }];
  pendingBack = 0;
  state.scroll = {};
  state.form = reason ? { info: reason } : {};
  state.gen = null;
  state.hiddenAt = null;
  state.phase = 'unlock';
  clearTimeout(toastTimer);
  state.toast = null;
  state.focusField = 'form:unlockPw';
  render();
}

// ----- 화면 이동 (안드로이드 뒤로 가기 버튼과 연동) -----
function push(screen) {
  state.stack.push(screen);
  state.anim = 'push';
  if (state.historyOK) {
    try { history.pushState({ vn: state.stack.length }, ''); } catch { state.historyOK = false; }
  }
  render();
}
let pendingBack = 0; // 앱이 직접 요청한 뒤로 가기 수 (사용자의 뒤로 가기 버튼과 구분)
function goBack() {
  if (state.historyOK && state.stack.length > 1) { pendingBack++; history.back(); }
  else popScreen();
}
function popScreen() {
  if (state.stack.length <= 1) return;
  const s = state.stack.pop();
  delete state.scroll[screenKey(s)];
  if (s.name === 'edit') state.draft = null;
  if (s.name === 'import') state.importPreview = null;
  if (s.name === 'cleanup') state.cleanup = null;
  if (s.name === 'export-text' || s.name === 'change-pw') state.form = {};
  if (s.name === 'generator') state.gen = null;
  state.anim = 'pop';
  render();
}
function replaceTop(screen) {
  state.stack[state.stack.length - 1] = screen;
  state.anim = null;
  render();
}
function repushHistory() {
  if (!state.historyOK) return;
  try { history.pushState({ vn: state.stack.length }, ''); } catch { state.historyOK = false; }
}

// ----- 편집 -----
function openEditor(entryId, parentId) {
  const e = entryId ? findNode(state.tree, entryId) : null;
  const fields = {
    title: e ? e.title : '', url: e ? e.url : '', username: e ? e.username : '',
    password: e ? e.password : '', memo: e ? e.memo : '',
  };
  state.draft = {
    entryId: entryId || null,
    parentId: entryId ? findParent(state.tree, entryId).id : (parentId || 'root'),
    fields,
    orig: JSON.stringify(fields),
    showPw: false,
  };
  state.focusField = entryId ? null : 'title';
  push({ name: 'edit' });
}
function isDraftDirty() {
  const d = state.draft;
  return !!d && JSON.stringify(d.fields) !== d.orig;
}
function markDraftClean() {
  if (state.draft) state.draft.orig = JSON.stringify(state.draft.fields);
}
function confirmDiscard() {
  state.alert = {
    title: '변경 사항을 버릴까요?', message: '저장하지 않은 입력 내용이 사라집니다.', fresh: true,
    buttons: [
      { label: '계속 편집', bold: true },
      { label: '버리기', danger: true, run: () => { markDraftClean(); goBack(); } },
    ],
  };
  render();
}
function saveDraft() {
  const d = state.draft;
  if (!d) return;
  const f = { ...d.fields, title: d.fields.title.trim() };
  if (!f.title) { showToast('사이트명을 입력하세요.'); return; }
  if (d.entryId) {
    const id = d.entryId;
    markDraftClean(); // 화면이 닫힐 때까지 입력값은 그대로 보이게 둔다
    commit((t) => { Object.assign(findNode(t, id), f, { updatedAt: now() }); });
    showToast('저장했습니다.');
    goBack();
  } else {
    const entry = makeEntry(f);
    commit((t) => addNode(t, d.parentId, entry));
    state.draft = null;
    if (d.parentId !== 'root') expandTo(d.parentId);
    replaceTop({ name: 'entry', id: entry.id });
    showToast('새 계정을 추가했습니다.');
  }
}

// ----- 삭제 + 5초 실행 취소 -----
function deleteWithUndo(id) {
  const node = findNode(state.tree, id);
  if (!node) return;
  let info = null;
  commit((t) => { info = removeNode(t, id); });
  state.reveal.delete(id);
  state.undo = info;
  showToast(`‘${nameOf(node)}’ 삭제됨`, true);
}
function undoDelete() {
  const u = state.undo;
  if (!u) return;
  state.undo = null;
  clearTimeout(toastTimer);
  state.toast = null;
  commit((t) => insertNode(t, u.parentId, u.node, u.index));
  showToast(`‘${nameOf(u.node)}’ 되돌림`);
}

// ----- 시트·알림창 -----
function openFolderMenu(id) {
  const f = findNode(state.tree, id);
  const canSub = canAddSubfolder(state.tree, id);
  state.sheet = {
    type: 'menu', fresh: true, title: f.name,
    items: [
      { label: '이 폴더에 새 계정', act: 'folder-new-entry', id },
      { label: canSub ? '하위 폴더 만들기' : '하위 폴더 만들기 (최대 5단계)', act: 'folder-new-sub', id, disabled: !canSub },
      { label: '이름 변경', act: 'folder-rename', id },
      { label: '이름순으로 정렬', act: 'folder-sort', id, disabled: f.sort !== 'manual' },
      { label: '다른 폴더로 이동', act: 'folder-move', id },
      { label: '폴더 삭제', act: 'folder-delete', id, danger: true },
    ],
  };
  render();
}
function openPicker(mode, id, current) {
  state.sheet = { type: 'pick', fresh: true, mode, id, current };
  render();
}
function promptName({ title, message, value = '', confirmLabel, run }) {
  state.sheet = null;
  state.alert = {
    title, message, input: true, value, placeholder: '폴더 이름', fresh: true,
    buttons: [{ label: '취소' }, { label: confirmLabel, bold: true, run }],
  };
  state.focusField = 'alertValue';
  render();
}
function pressAlertButton(index) {
  const a = state.alert;
  if (!a) return;
  const b = a.buttons[index];
  if (b.run && a.input) {
    const v = a.inputType === 'password' ? a.value : a.value.trim();
    if (!v) { state.focusField = 'alertValue'; render(); return; }
    state.alert = null;
    b.run(v);
  } else {
    state.alert = null;
    if (b.run) b.run();
  }
  render();
}

async function copyText(text, doneMessage) {
  try {
    await navigator.clipboard.writeText(text);
    state.clipAt = now();
    clearTimeout(clipTimer);
    clipTimer = setTimeout(clearClipboard, CLIP_CLEAR_MS);
    showToast(`${doneMessage} 30초 후 지웁니다. 앱 밖에 있는 동안은 지워지지 않습니다.`);
  } catch {
    showToast('복사하지 못했습니다. 이 화면에서는 클립보드가 막혀 있을 수 있습니다.');
  }
}

// 30초 후, 앱으로 돌아올 때, 잠길 때 시도. 복사 후 3분이 지났으면 다른 앱의 복사 내용일 수 있어 건드리지 않는다
async function clearClipboard() {
  if (!state.clipAt) return;
  if (now() - state.clipAt > CLIP_MAX_MS) { state.clipAt = null; return; }
  if (document.hidden) return;                 // 앱 밖에서는 지울 수 없다 → 돌아올 때 다시 시도
  try {
    await navigator.clipboard.writeText('');
    state.clipAt = null;
  } catch { /* 화면에 포커스가 없으면 실패한다 → 다음 기회에 다시 시도 */ }
}

// ----- 자동 잠금 · 화면 가림 (F-6) -----
function noteActivity() { state.lastActivity = now(); }
function inExternal() {
  if (state.expectExternal && now() - state.externalSince > EXTERNAL_MAX_MS) state.expectExternal = false;
  return state.expectExternal;
}
function checkIdle() {
  if (state.phase !== 'open' || state.busy || inExternal()) return;
  if (now() - state.lastActivity >= autoLockMin() * 60 * 1000) lockVault('한동안 사용하지 않아 잠겼습니다.', { keepDraft: true });
}
function showPrivacyCover() {
  if (document.querySelector('.privacy-cover')) return;
  document.body.appendChild(h('div', { class: 'privacy-cover', 'aria-hidden': 'true' }, h('div', { class: 'app-mark' }, icon('lock'))));
}
function hidePrivacyCover() {
  const c = document.querySelector('.privacy-cover');
  if (c) c.remove();
}
function onLeave() {
  showPrivacyCover();
  if (state.phase !== 'open' || inExternal()) return;
  state.hiddenAt = now();
  if (graceSec() === 0) lockVault('다른 앱으로 전환되어 잠겼습니다.', { keepDraft: true });
}
function onReturn() {
  const wasExternal = state.expectExternal;
  if (state.phase === 'open' && wasExternal && !inExternal()) {
    lockVault('파일 선택 창이 오래 열려 있어 잠겼습니다.', { keepDraft: true });
  } else if (state.phase === 'open' && !wasExternal) {
    const away = state.hiddenAt ? now() - state.hiddenAt : 0;
    state.hiddenAt = null;
    if (away > graceSec() * 1000) lockVault('다른 앱으로 전환되어 잠겼습니다.', { keepDraft: true });
    else checkIdle();
  }
  hidePrivacyCover();
  setTimeout(clearClipboard, 300);              // 포커스가 돌아온 뒤 시도
  checkForUpdate(false);
}
// 파일 선택 창은 잠시 앱을 떠나므로 그동안은 잠그지 않는다
async function withExternal(fn) {
  state.expectExternal = true;
  state.externalSince = now();
  try { return await fn(); } finally {
    state.expectExternal = false;
    state.hiddenAt = null;
    noteActivity();
  }
}

// ----- 비밀번호 생성기 -----
function openGenerator() {
  const opts = { ...GEN_DEFAULTS, ...(state.meta.gen || {}) };
  state.gen = { ...opts, value: generatePassword(opts) };
  push({ name: 'generator' });
}
function regenerate() {
  if (!state.gen) return;
  state.gen.value = generatePassword(state.gen);
  updateGeneratorView();
}
// 슬라이더를 움직이는 동안 화면을 다시 만들면 끌기가 끊기므로 보이는 값만 바꾼다
function updateGeneratorView() {
  const g = state.gen;
  const preview = root.querySelector('.gen-preview');
  const len = root.querySelector('.gen-length');
  if (preview) preview.textContent = g.value;
  if (len) len.textContent = `${g.length}자`;
}
function useGenerated() {
  const g = state.gen;
  if (!g || !state.draft) return;
  state.draft.fields.password = g.value;
  state.draft.showPw = true;
  const { length, upper, lower, digits, symbols } = g;
  state.meta = { ...state.meta, gen: { length, upper, lower, digits, symbols } };
  goBack();
}

// ----- 마스터 비밀번호 변경 (F-1) -----
// 현재·직전 저장본과 저장본 기록을 모두 새 키로 다시 암호화한다 (한 트랜잭션)
async function reencryptAll(oldKey, next) {
  const curRec = await readSlot('current');
  if (curRec && curRec.writeId !== state.writeId) throw new Error('conflict');
  const reencrypt = async (rec) => {
    if (!isValidRecord(rec)) return null;
    try { return await encryptPayload(next, await decryptRecord(oldKey, rec)); } catch { return null; }
  };
  const newCur = await encryptPayload(next, { version: 1, savedAt: now(), root: state.tree, meta: state.meta });
  newCur.writeId = uid();
  const newPrev = await reencrypt(await readSlot('previous'));
  const snaps = [];
  for (const x of await readSnapshots()) {
    const r = await reencrypt(x.rec);
    if (r) snaps.push({ ...x, rec: r });
  }
  await writeSlots({ current: newCur, previous: newPrev, snapshots: snaps });
  state.writeId = newCur.writeId;
  state.session = next;
}
async function newSession(pw) {
  const salt = randomBytes(16);
  return { key: await deriveKey(pw.normalize('NFC'), salt, KDF_ITERATIONS), salt, iterations: KDF_ITERATIONS };
}
// 같은 비밀번호로 새 기준(NFC, 60만 회, 새 salt)에 맞춰 다시 암호화한다
async function rekeyVault(pw) {
  const next = await newSession(pw);
  const oldKey = state.session.key;
  await queue(() => reencryptAll(oldKey, next));
}
// 비밀번호가 이 레코드를 여는지 확인한다 (NFC와 원문 둘 다 시도)
async function tryOpen(pw, rec) {
  for (const variant of passwordVariants(pw)) {
    try {
      const key = await deriveKey(variant, fromB64(rec.salt), rec.iterations);
      return { key, payload: await decryptRecord(key, rec) };
    } catch { /* 다음 방식 시도 */ }
  }
  return null;
}
async function changeMasterPassword() {
  const f = state.form;
  const curPw = f.curPw || '';
  const newPw = f.newPw || '';
  if (!curPw) return formError('지금 마스터 비밀번호를 입력하세요.');
  if (Array.from(newPw).length < MIN_PASSWORD) return formError(`새 비밀번호는 ${MIN_PASSWORD}자 이상이어야 합니다.`);
  if (passwordStrength(newPw).level < 2) return formError(WEAK_MESSAGE);
  if (newPw.normalize('NFC') !== (f.newPw2 || '').normalize('NFC')) return formError('새 비밀번호 확인이 일치하지 않습니다.');
  if (newPw.normalize('NFC') === curPw.normalize('NFC')) return formError('지금 비밀번호와 다른 비밀번호를 입력하세요.');
  state.busy = '비밀번호를 바꾸는 중…';
  render();
  try {
    await saveChain;
    const curRec = await readSlot('current');
    if (!curRec || !(await tryOpen(curPw, curRec))) {
      state.busy = null;
      state.form.curPw = '';
      formError('지금 마스터 비밀번호가 맞지 않습니다.');
      return;
    }
    const next = await newSession(newPw);
    const oldKey = state.session.key;
    const oldMeta = state.meta;
    state.meta = { ...state.meta, pwChangedAt: now() };
    try {
      await queue(() => reencryptAll(oldKey, next));
    } catch (e) {
      state.meta = oldMeta;
      if (e && e.message === 'conflict') { state.busy = null; lockVault('다른 창에서 금고가 바뀌어 이 창을 잠갔습니다. 다시 열고 변경해 주세요.'); return; }
      throw e;
    }
    state.bannerDismissed = false;
    state.form = {};
    state.busy = null;
    goBack();
    state.alert = {
      title: '마스터 비밀번호를 바꿨습니다', fresh: true,
      message: '이전에 만든 백업 파일은 옛 비밀번호로만 열립니다. 지금 새 백업 파일을 만들어 두세요.\n\n비밀번호가 새어 나가서 바꾼 경우: 옛 백업 파일을 모두 지우세요. 기기 저장소에도 덮어쓴 옛 데이터 조각이 한동안 남을 수 있으니, 기기 자체가 위험하다면 계정 비밀번호들도 바꾸는 것이 안전합니다.',
      buttons: [{ label: '나중에' }, { label: '지금 백업', bold: true, run: () => exportBackup() }],
    };
    render();
  } catch {
    state.busy = null;
    formError('비밀번호를 바꾸지 못했습니다. 기존 비밀번호는 그대로입니다.');
  }
}

// ----- 오프라인 · 설치 · 수동 업데이트 (5단계, F-7) -----
let swReg = null;
function isStandalone() {
  return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
}
// 입력 중이면 다시 그리지 않는다 (10-1 예외 규칙). 다음 동작 때 반영된다.
function softRender() {
  const a = document.activeElement;
  if (a && a.dataset && a.dataset.field) return;
  render();
}
function askVersion(worker) {
  return new Promise((resolve) => {
    if (!worker) { resolve(null); return; }
    const ch = new MessageChannel();
    const t = setTimeout(() => resolve(null), 2000);
    ch.port1.onmessage = (e) => { clearTimeout(t); resolve(e.data); };
    worker.postMessage({ type: 'version' }, [ch.port2]);
  });
}
async function noteWaiting(worker) {
  state.sw.waiting = worker;
  state.sw.waitingVersion = await askVersion(worker);
  softRender();
}
async function initServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  state.sw.supported = true;
  try {
    // CSP의 Trusted Types 때문에 서비스 워커 주소도 허가된 값만 쓸 수 있다 (sw.js 하나만 허용)
    let swUrl = 'sw.js';
    if (window.trustedTypes && trustedTypes.createPolicy) {
      const policy = trustedTypes.createPolicy('vaultnote', {
        createScriptURL: (u) => { if (u === 'sw.js') return u; throw new TypeError('허용되지 않은 스크립트 주소'); },
      });
      swUrl = policy.createScriptURL('sw.js');
    }
    swReg = await navigator.serviceWorker.register(swUrl, { scope: './' });
    const ctrl = navigator.serviceWorker.controller;
    state.sw.controlled = !!ctrl;
    state.sw.activeVersion = await askVersion(ctrl || swReg.active);
    if (swReg.waiting && ctrl) noteWaiting(swReg.waiting);
    swReg.addEventListener('updatefound', () => {
      const nw = swReg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', async () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) noteWaiting(nw);
        if (nw.state === 'activated' && !state.sw.controlled) {   // 첫 설치: 이제 오프라인으로 쓸 수 있다
          state.sw.controlled = true;
          state.sw.activeVersion = await askVersion(nw);
          softRender();
        }
      });
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (state.sw.reloading) location.reload();
    });
    softRender();
  } catch {
    state.sw.error = true;
  }
}
async function checkForUpdate(showResult) {
  if (!swReg) { if (showResult) showToast('이 화면에서는 업데이트를 확인할 수 없습니다.'); return; }
  try {
    await swReg.update();
    if (showResult) {
      setTimeout(() => showToast(state.sw.waiting ? `새 버전 ${state.sw.waitingVersion || ''}이 있습니다.` : '지금이 최신 버전입니다. 방금 올렸다면 최대 10분 뒤 다시 확인하세요.'), 1500);
    }
  } catch {
    if (showResult) showToast('업데이트를 확인하지 못했습니다. 인터넷 연결을 확인하세요.');
  }
}
function confirmUpdate() {
  if (!state.sw.waiting) return;
  const last = state.meta.lastBackupAt;
  state.alert = {
    title: `새 버전 ${state.sw.waitingVersion || ''}로 업데이트할까요?`, fresh: true,
    message: `업데이트 전에 백업을 권장합니다. 마지막 확인된 백업: ${last ? dateFmt.format(last) : '없음'}\n\n이 확인 단계는 실수로 바뀌는 것을 막을 뿐, GitHub 계정이 해킹되면 막지 못합니다. 직접 올린 적이 없는데 이 안내가 떴다면 업데이트하지 말고 GitHub 계정을 점검하세요.\n업데이트 후에는 다시 잠금 해제해야 합니다.`,
    buttons: [
      { label: '먼저 백업', bold: true, run: () => exportBackup() },
      { label: '업데이트', run: () => applyUpdate() },
      { label: '취소' },
    ],
  };
  render();
}
async function applyUpdate() {
  const w = state.sw.waiting;
  if (!w) return;
  state.busy = '업데이트 중…';
  render();
  await takeSnapshot('업데이트 전');
  await saveChain;
  state.sw.reloading = true;
  w.postMessage({ type: 'skipWaiting' });
  setTimeout(() => location.reload(), 4000); // controllerchange가 오지 않을 때를 대비
}
async function installApp() {
  const p = state.installPrompt;
  if (!p) return;
  state.installPrompt = null;
  try { await p.prompt(); } catch { /* 사용자가 닫음 */ }
  render();
}

// ----- 설정: 저장 상태 · 자가 테스트 (10-4) -----
async function loadStorageInfo() {
  try {
    await saveChain;
    const cur = await readSlot('current');
    const prev = await readSlot('previous');
    state.storageInfo = {
      where: memoryStore ? '메모리 (미리보기, 닫으면 사라짐)' : '이 기기 (IndexedDB)',
      size: cur ? `${(JSON.stringify(cur).length / 1024).toFixed(1)}KB` : '없음',
      previous: prev ? '있음' : '없음',
      sample: cur ? `${cur.ciphertext.slice(0, 28)}…` : '',
    };
  } catch {
    state.storageInfo = { where: '읽기 실패', size: '-', previous: '-', sample: '' };
  }
  if (state.phase === 'open' && topScreen().name === 'settings') render();
}
async function runSelfTest() {
  if (!state.session) return;
  state.busy = '자가 테스트 중…';
  render();
  const results = [];
  const add = (label, ok, detail = '') => results.push({ label, ok, detail });
  try {
    const s = state.session;
    const marker = { text: `자가테스트-${uid()}` };
    const r1 = await encryptPayload(s, marker);
    const back = await decryptRecord(s.key, r1);
    add('암호화 → 복호화 왕복', back.text === marker.text);

    const r2 = await encryptPayload(s, marker);
    add('저장할 때마다 다른 IV', r1.iv !== r2.iv && r1.ciphertext !== r2.ciphertext);

    await saveChain;
    const cur = await readSlot('current');
    const raw = JSON.stringify(cur || {});
    const secrets = new Set();
    for (const e of allEntries(state.tree)) {
      for (const v of [e.title, e.username, e.password, e.memo]) if (v && v.length >= 6) secrets.add(v);
    }
    const leaked = [...secrets].filter((v) => raw.includes(v)).length;
    add('저장소에 평문 없음', !!cur && leaked === 0, cur ? `검사한 값 ${secrets.size}개` : '저장본 없음');

    const stored = cur ? await decryptRecord(s.key, cur) : null;
    add('저장본과 화면 데이터 일치', !!stored && JSON.stringify(stored.root) === JSON.stringify(state.tree));

    const wrongKey = await deriveKey(`wrong-${uid()}`, s.salt, s.iterations);
    let rejected = false;
    try { await decryptRecord(wrongKey, cur); } catch { rejected = true; }
    add('틀린 비밀번호 거부', rejected);

    const t = sampleTree();
    const before = countEntries(t);
    const entry = allEntries(t)[0];
    const target = t.children[t.children.length - 1];
    moveNode(t, entry.id, target.id);
    const moved = findParent(t, entry.id).id === target.id && countEntries(t) === before;
    removeNode(t, entry.id);
    add('트리 이동·삭제', moved && countEntries(t) === before - 1 && !findNode(t, entry.id));

    const sampleText = treeToText(sampleTree());
    const once = treeToText(parseTreeText(sampleText).root);
    add('텍스트 내보내기 → 가져오기 왕복', once === sampleText && treeToText(parseTreeText(once).root) === once);
    const special = parseTreeText([
      '# 특수', '  - 콜론 #해시', '    id:  앞공백', '    pw: a: b # c - ', '    memo: |',
      '      첫 줄', '      ', '      셋째 줄', '    질문: 답', ''].join('\n'));
    const se = allEntries(special.root)[0];
    add('특수 문자·여러 줄 메모 해석', !!se && se.title === '콜론 #해시' && se.username === ' 앞공백'
      && se.password === 'a: b # c - ' && se.memo === '첫 줄\n\n셋째 줄\n질문: 답' && special.unparsed.length === 0);

    const messy = sanitizeTree({ children: [
      { type: 'entry', title: 5, password: null }, { type: '알수없음' }, null,
      { type: 'folder', name: '', children: 'bad' }, { type: 'entry', id: '<x>', title: '' }] });
    add('손상된 데이터 정리', messy.children.length === 3 && messy.children[0].title === '5' && messy.children[0].password === ''
      && messy.children[1].name === '이름 없는 폴더' && /^[0-9a-f]{16}$/.test(messy.children[2].id)
      && JSON.stringify(sanitizeTree(state.tree)) === JSON.stringify(state.tree));

    const weakOnes = ['password1234', 'qwerty123456', 'aaaaaaaaaaa1', 'Tkfkdgo1234!!', '123456789012', 'abcdefghijkl'];
    const goodOnes = ['파란 자전거 겨울 커피', 'river candle mango switch', 'k7#Qm2$vLp9!xW'];
    add('약한 비밀번호 거부', weakOnes.every((p) => passwordStrength(p).level < 2) && goodOnes.every((p) => passwordStrength(p).level >= 2));
    const nfd = '가나다라마바사아자차카타'.normalize('NFD');
    add('한글 정규화(NFC)', passwordVariants(nfd)[0] === nfd.normalize('NFC') && passwordVariants(nfd).length === 2);
    const snaps = await readSnapshots();
    add('저장본 기록', snaps.length ? true : null, `${snaps.length}개 보관 중`);

    let genOk = true;
    for (let i = 0; i < 200; i++) {
      const p = generatePassword({ length: 20, upper: true, lower: true, digits: true, symbols: true });
      if (p.length !== 20 || !/[A-Z]/.test(p) || !/[a-z]/.test(p) || !/[0-9]/.test(p) || !/[^A-Za-z0-9]/.test(p)) genOk = false;
    }
    add('비밀번호 생성기 (200개 검사)', genOk);

    if (state.sw.controlled) {
      add('오프라인 사용 준비 (설치된 코드 버전 일치)', state.sw.activeVersion === APP_VERSION,
        state.sw.activeVersion === APP_VERSION ? '' : `앱 ${APP_VERSION}, 저장된 코드 ${state.sw.activeVersion || '알 수 없음'} — sw.js VERSION을 확인하세요`);
    } else {
      add('오프라인 사용 준비', null, state.sw.supported ? '처음 접속 후 한 번 새로고침하면 준비됩니다' : '이 화면에서는 확인할 수 없습니다');
    }

    const prev = await readSlot('previous');
    add('직전 저장본 보관', prev ? true : null, prev ? '' : '아직 한 번만 저장되었습니다');
  } catch {
    add('테스트 실행 중 오류', false);
  }
  state.selfTest = { results, at: now() };
  state.busy = null;
  render();
}

// ----- 백업 · 복원 · 가져오기 · 내보내기 (F-5) -----
async function exportBackup() {
  if (!state.session) return;
  state.busy = '백업 파일 만드는 중…';
  render();
  try {
    await saveChain;
    const name = `vault_${dateStamp()}.vault`;
    const rec = await encryptPayload(state.session, { version: 1, savedAt: now(), root: state.tree, meta: state.meta });
    downloadFile(JSON.stringify(rec), name, 'application/octet-stream');
    state.meta = { ...state.meta, lastBackupCreatedAt: now() };
    saveVault(state.tree);
    state.busy = null;
    // 실제로 저장됐는지는 앱이 알 수 없으므로, 파일을 다시 열어 확인해야 "백업됨"으로 기록한다
    state.alert = {
      title: '백업 파일이 저장됐는지 확인하세요', fresh: true,
      message: `다운로드 폴더에 ${name} 파일이 생겼는지 보고, 그 파일을 골라 열어 보면 백업이 확인됩니다. 확인해야 백업 알림이 꺼집니다.`,
      buttons: [{ label: '나중에' }, { label: '지금 확인', bold: true, run: () => chooseBackupFile('verify') }],
    };
    render();
  } catch {
    state.busy = null;
    showToast('백업 파일을 만들지 못했습니다.');
  }
}
// mode: 'replace' = 열린 금고에 덮어쓰기, 'new' = 새 기기에서 금고로 복원
async function chooseBackupFile(mode) {
  const file = await withExternal(() => pickFile(''));
  if (!file) return;
  if (file.size > MAX_FILE_BYTES) { showToast('파일이 너무 큽니다. 5MB 이하만 열 수 있습니다.'); return; }
  let rec = null;
  try { rec = JSON.parse((await readTextFile(file)).text); } catch { rec = null; }
  if (!isValidRecord(rec)) { showToast('VaultNote 백업 파일이 아닙니다.'); return; }
  state.alert = {
    title: '백업 파일 비밀번호', message: `‘${file.name}’을(를) 만들 때 쓴 마스터 비밀번호를 입력하세요.`,
    input: true, inputType: 'password', value: '', placeholder: '백업 파일의 비밀번호', fresh: true,
    buttons: [{ label: '취소' }, { label: '확인', bold: true, run: (pw) => openBackup(rec, pw, mode) }],
  };
  state.focusField = 'alertValue';
  render();
}
async function openBackup(rec, pw, mode) {
  state.busy = mode === 'verify' ? '백업 파일 확인 중…' : '백업 파일 여는 중…';
  render();
  const opened = await tryOpen(pw, rec);
  const payload = opened ? opened.payload : null;
  if (!isValidPayload(payload)) {
    state.busy = null;
    showToast('비밀번호가 맞지 않거나 파일이 손상되었습니다.');
    return;
  }
  payload.root = sanitizeTree(payload.root);
  const n = countEntries(payload.root);
  if (mode === 'verify') {
    state.busy = null;
    setMeta({ lastBackupAt: now() });
    state.bannerDismissed = false;
    state.alert = {
      title: '백업 파일이 확인됐습니다', fresh: true,
      message: `계정 ${n}개, 저장 시각 ${payload.savedAt ? dateFmt.format(payload.savedAt) : '모름'}\n이 파일을 SD카드·PC 등 폰 밖 두 곳에 옮겨 두세요.`,
      buttons: [{ label: '확인', bold: true }],
    };
    render();
    return;
  }
  if (mode === 'new') {
    try {
      if (await readSlot('current')) throw new Error('exists');
      state.writeId = undefined;
      const session = await newSession(pw);   // 새 기기에서는 항상 새 기준(NFC, 60만 회)으로 다시 암호화
      const meta = payload.meta || {};
      const savedAt = now();
      await writeRecord(await encryptPayload(session, { version: 1, savedAt, root: payload.root, meta }));
      state.lastSavedAt = savedAt;
      state.busy = null;
      openVault(session, payload.root, meta);
      showToast(`백업에서 계정 ${n}개를 복원했습니다.`);
    } catch {
      state.busy = null;
      showToast('복원하지 못했습니다.');
    }
    render();
    return;
  }
  state.busy = null;
  state.alert = {
    title: '현재 데이터를 덮어쓸까요?', fresh: true,
    message: `백업 파일: 계정 ${n}개 (${payload.savedAt ? dateFmt.format(payload.savedAt) : '저장 시각 모름'})\n지금 금고: 계정 ${countEntries(state.tree)}개\n\n마스터 비밀번호는 지금 것이 그대로 유지됩니다. 지금 데이터는 설정 > 저장본 기록에 남겨 두므로 되돌릴 수 있습니다.`,
    buttons: [
      { label: '취소', bold: true },
      { label: '덮어쓰기', danger: true, run: () => { takeSnapshot('백업 복원 전'); replaceTree(payload.root); showToast(`계정 ${n}개를 복원했습니다.`); } },
    ],
  };
  render();
}
function replaceTree(tree, meta) {
  state.tree = tree;
  if (meta) state.meta = { ...meta };
  state.expanded = new Set();
  state.reveal = new Map();
  const first = tree.children.find((c) => c.type === 'folder');
  if (first) state.expanded.add(first.id);
  saveVault(state.tree);
  render();
}
function confirmRestorePrevious() {
  state.alert = {
    title: '직전 저장본으로 되돌릴까요?', fresh: true,
    message: '마지막 변경 바로 전 상태로 돌아갑니다. 한 번 더 누르면 지금 상태로 다시 돌아옵니다.',
    buttons: [{ label: '취소', bold: true }, { label: '되돌리기', run: () => restorePrevious() }],
  };
  render();
}
async function restorePrevious() {
  state.busy = '직전 저장본 여는 중…';
  render();
  try {
    await saveChain;
    const prev = await readSlot('previous');
    if (!isValidRecord(prev)) throw new Error('none');
    const p = await decryptRecord(state.session.key, prev);
    if (!isValidPayload(p)) throw new Error('bad');
    state.busy = null;
    takeSnapshot('되돌리기 전');
    replaceTree(sanitizeTree(p.root)); // 설정(자동 잠금 등)은 되돌리지 않고 데이터만 되돌린다
    showToast('직전 저장본으로 되돌렸습니다.');
  } catch (e) {
    state.busy = null;
    showToast(e && e.message === 'none' ? '직전 저장본이 없습니다.' : '직전 저장본을 열지 못했습니다.');
  }
}
async function openSnapshots() {
  state.snapList = null;
  push({ name: 'snapshots' });
  try { await saveChain; state.snapList = (await readSnapshots()).reverse(); } catch { state.snapList = []; }
  if (topScreen().name === 'snapshots') render();
}
function confirmRestoreSnapshot(id) {
  const x = (state.snapList || []).find((v) => v.id === id);
  if (!x) return;
  state.alert = {
    title: '이 저장본으로 되돌릴까요?', fresh: true,
    message: `${x.reason} (${dateFmt.format(x.at)})\n지금 데이터도 기록에 남겨 두므로 다시 되돌릴 수 있습니다.`,
    buttons: [{ label: '취소', bold: true }, { label: '되돌리기', run: () => restoreSnapshot(id) }],
  };
  render();
}
async function restoreSnapshot(id) {
  state.busy = '저장본 여는 중…';
  render();
  try {
    await saveChain;
    const x = (await readSnapshots()).find((v) => v.id === id);
    const p = x ? await decryptRecord(state.session.key, x.rec) : null;
    if (!isValidPayload(p)) throw new Error('bad');
    state.busy = null;
    takeSnapshot('되돌리기 전');
    replaceTree(sanitizeTree(p.root));
    goBack();
    showToast('선택한 저장본으로 되돌렸습니다.');
  } catch {
    state.busy = null;
    showToast('이 저장본을 열지 못했습니다.');
  }
}
async function chooseTextFile() {
  const file = await withExternal(() => pickFile('.txt,text/plain'));
  if (!file) return;
  if (file.size > MAX_FILE_BYTES) { showToast('파일이 너무 큽니다. 5MB 이하만 열 수 있습니다.'); return; }
  let read;
  try { read = await readTextFile(file); } catch { showToast('파일을 읽지 못했습니다.'); return; }
  const result = parseTreeText(read.text);
  if (read.note) result.warnings.unshift(read.note);
  state.importPreview = { fileName: file.name, ...result };
  push({ name: 'import' });
}
function confirmImport() {
  const p = state.importPreview;
  if (!p) return;
  const kids = p.root.children;
  takeSnapshot('가져오기 전');
  commit((t) => { for (const c of kids) t.children.push(c); });
  for (const c of kids) if (c.type === 'folder') state.expanded.add(c.id);
  state.importPreview = null;
  state.cleanup = { fileName: p.fileName, checks: {} };
  replaceTop({ name: 'cleanup' });
  showToast(`계정 ${p.entryCount}개를 가져왔습니다.`);
}
async function exportPlainText() {
  const pw = state.form.exportPw || '';
  if (!pw) { formError('마스터 비밀번호를 입력하세요.'); return; }
  state.busy = '비밀번호 확인 중…';
  render();
  try {
    await saveChain;
    const cur = await readSlot('current');
    if (!cur || !(await tryOpen(pw, cur))) throw new Error('wrong');
  } catch {
    state.busy = null;
    state.form.exportPw = '';
    formError('비밀번호가 맞지 않습니다.');
    return;
  }
  state.busy = null;
  state.form = {};
  downloadFile(treeToText(state.tree), `vault_${dateStamp()}_평문.txt`, 'text/plain;charset=utf-8');
  showToast('평문 파일을 저장했습니다. 사용이 끝나면 바로 삭제하세요.');
  goBack();
}

// ===== [RENDER] 화면 전체를 매번 새로 그린다 =====
const root = document.getElementById('app');

function render() {
  // 1) 현재 스크롤·포커스 기억
  const prevKey = root.dataset.screenKey || '';
  const prevScroll = root.querySelector('.screen:not(.behind) .scroll');
  if (prevScroll && prevKey) state.scroll[prevKey] = prevScroll.scrollTop;
  let focus = null;
  const active = document.activeElement;
  if (active && active.dataset && active.dataset.field) {
    focus = { field: active.dataset.field, start: active.selectionStart, end: active.selectionEnd };
  }
  const s = topScreen();
  const key = screenKey(s);
  if (state.focusField) { focus = { field: state.focusField }; state.focusField = null; }
  else if (prevKey !== key) focus = null;

  // 2) 전체 다시 그리기
  const anim = reducedMotion() || state.phase !== 'open' ? null : state.anim;
  state.anim = null;
  root.replaceChildren();

  if (state.phase !== 'open') {
    root.appendChild(renderPhase());
  } else {
    if (anim === 'push' && state.stack.length > 1) {
      const below = state.stack[state.stack.length - 2];
      const behind = renderScreen(below);
      behind.classList.add('behind');
      behind.setAttribute('aria-hidden', 'true');
      root.appendChild(behind);
      restoreScroll(behind, screenKey(below));
    }
    const screenEl = renderScreen(s);
    if (anim) {
      screenEl.classList.add(anim);
      screenEl.addEventListener('animationend', () => {
        screenEl.classList.remove(anim);
        const behind = root.querySelector('.screen.behind');
        if (behind) behind.remove();
      }, { once: true });
    }
    root.appendChild(screenEl);
  }
  root.dataset.screenKey = key;
  const screenEl = root.querySelector('.screen:not(.behind)');
  if (state.toast) root.appendChild(renderToast(state.phase !== 'open' || s.name !== 'home'));
  if (state.sheet) root.appendChild(renderSheet());
  if (state.alert) root.appendChild(renderAlert());
  if (state.busy) root.appendChild(renderBusy());

  // 3) 스크롤·포커스 복원
  restoreScroll(screenEl, key);
  syncNavbar(screenEl);
  if (focus && !state.busy && !(state.sheet && !state.alert) && !(state.alert && focus.field !== 'alertValue')) {
    const scope = state.alert ? root.querySelector('.alert') : screenEl;
    const el = scope && scope.querySelector(`[data-field="${focus.field}"]`);
    if (el) {
      el.focus({ preventScroll: true });
      if (focus.start != null && el.setSelectionRange) {
        try { el.setSelectionRange(focus.start, focus.end); } catch { /* 일부 입력창은 지원 안 함 */ }
      }
    }
  }
}
function restoreScroll(screenEl, key) {
  const sc = screenEl && screenEl.querySelector('.scroll');
  if (sc && state.scroll[key]) sc.scrollTop = state.scroll[key];
}
function syncNavbar(screenEl) {
  const sc = screenEl && screenEl.querySelector('.scroll');
  const nav = screenEl && screenEl.querySelector('.navbar');
  if (sc && nav && !nav.classList.contains('solid')) nav.classList.toggle('scrolled', sc.scrollTop > 36);
}
function renderScreen(s) {
  if (s.name === 'entry') return renderEntry(s);
  if (s.name === 'edit') return renderEdit();
  if (s.name === 'settings') return renderSettings();
  if (s.name === 'import') return renderImport();
  if (s.name === 'cleanup') return renderCleanup();
  if (s.name === 'export-text') return renderExportText();
  if (s.name === 'generator') return renderGenerator();
  if (s.name === 'change-pw') return renderChangePw();
  if (s.name === 'snapshots') return renderSnapshots();
  return renderHome();
}

// 검색어 입력 중에는 검색창은 그대로 두고 결과 영역만 다시 그린다 (한글 조합 보호, 10-1)
function updateSearchResults() {
  const body = root.querySelector('.screen:not(.behind) .home-body');
  if (!body || state.phase !== 'open') { render(); return; }
  body.replaceChildren(...homeBody());
  const clearBtn = root.querySelector('.screen:not(.behind) .clear-btn');
  if (clearBtn) clearBtn.classList.toggle('hidden', !state.search);
}

// ----- 공통 부품 -----
function navbar({ left, title, right, solid }) {
  return h('header', { class: 'navbar' + (solid ? ' solid' : '') },
    h('div', { class: 'navbar-inner' },
      h('div', { class: 'nav-left' }, left || null),
      h('div', { class: 'nav-title', text: title || '' }),
      h('div', { class: 'nav-right' }, right || null)));
}
function backButton() {
  const below = state.stack[state.stack.length - 2];
  let label = '계정';
  if (below && below.name === 'entry') {
    const e = findNode(state.tree, below.id);
    label = e ? e.title : '뒤로';
  } else if (below && below.name === 'settings') {
    label = '설정';
  } else if (below && below.name === 'edit') {
    label = '편집';
  }
  return h('button', { class: 'nav-btn back', 'data-action': 'back', 'aria-label': `${label}(으)로 돌아가기` },
    icon('back'), h('span', { class: 'back-label', text: label }));
}
function screen(nav, content, toolbar) {
  return h('section', { class: 'screen' }, nav, h('div', { class: 'scroll' }, content), toolbar || null);
}
function passwordInput(name, placeholder, enterkeyhint) {
  return h('input', {
    id: `f-${name}`, type: 'password', 'data-field': `form:${name}`, value: state.form[name] || '',
    placeholder, enterkeyhint, ...INPUT_ATTRS,
  });
}
function memoryNotice() {
  return memoryStore
    ? h('p', { class: 'group-footer warn', text: '이 미리보기 화면에서는 기기 저장소를 쓸 수 없어 메모리에만 보관합니다. 창을 닫으면 사라집니다.' })
    : null;
}

// ----- 시작 단계 화면: 불러오는 중 · 금고 만들기 · 잠금 해제 · 오류 -----
function renderPhase() {
  if (state.phase === 'setup') return renderSetup();
  if (state.phase === 'unlock') return renderUnlock();
  if (state.phase === 'error') {
    return h('section', { class: 'screen' }, h('div', { class: 'scroll' },
      h('div', { class: 'lock-hero' }, h('div', { class: 'app-mark' }, icon('lock')),
        h('div', { class: 'hero-title', text: '앱을 열 수 없습니다' }),
        h('p', { class: 'lock-text', text: state.errorMessage }))));
  }
  return h('section', { class: 'screen' }, h('div', { class: 'scroll center' }, h('div', { class: 'spinner', 'aria-label': '불러오는 중' })));
}
function renderSetup() {
  const f = state.form;
  const st = passwordStrength(f.setupPw || '');
  return h('section', { class: 'screen' }, h('div', { class: 'scroll' },
    h('div', { class: 'lock-hero' },
      h('div', { class: 'app-mark' }, icon('lock')),
      h('div', { class: 'hero-title', text: '금고 만들기' }),
      h('p', { class: 'lock-text', text: '모든 계정 정보는 이 마스터 비밀번호로 암호화되어 이 기기에만 저장됩니다.' })),
    h('div', { class: 'group' },
      h('div', { class: 'field' }, h('label', { for: 'f-setupPw', text: '비밀번호' }), passwordInput('setupPw', `${MIN_PASSWORD}자 이상`, 'next')),
      h('div', { class: 'field' }, h('label', { for: 'f-setupPw2', text: '확인' }), passwordInput('setupPw2', '한 번 더 입력', 'done')),
      h('div', { class: 'strength', 'aria-live': 'polite' },
        h('div', { class: 'strength-bar' }, h('div', { class: `strength-fill lv${st.level}` })),
        h('span', { class: 'strength-label', text: st.label || '강도' }))),
    h('p', { class: 'group-footer', text: '서로 관련 없는 단어 4개 이상을 띄어 쓰면 기억하기 쉽고 강합니다. 예시 문구를 그대로 쓰지는 마세요. 크롬이 비밀번호 저장을 물으면 ‘사용 안함’을 누르세요.' }),
    h('div', { class: 'group', style: { 'margin-top': '24px' } },
      h('label', { class: 'toggle-row' },
        h('span', { class: 'toggle-text', text: '비밀번호를 잊으면 데이터를 절대 복구할 수 없다는 것을 이해했습니다' }),
        h('input', { type: 'checkbox', class: 'switch', 'data-field': 'form:agree', checked: !!f.agree })),
      h('label', { class: 'toggle-row' },
        h('span', { class: 'toggle-text', text: '테스트용 가짜 데이터로 시작' }),
        h('input', { type: 'checkbox', class: 'switch', 'data-field': 'form:sample', checked: !!f.sample }))),
    f.error ? h('p', { class: 'error-text', role: 'alert', text: f.error }) : null,
    h('p', { class: 'disclaimer', text: `${DISCLAIMER} 사용 설명서와 라이선스는 이 앱을 받은 GitHub 저장소의 README를 보세요.` }),
    h('button', { class: 'primary-btn', 'data-action': 'create-vault' }, '금고 만들기'),
    h('button', { class: 'text-btn', 'data-action': 'restore-backup-new' }, '백업 파일로 복원하기'),
    memoryNotice(),
    h('p', { class: 'stage-note', text: `버전 ${APP_VERSION}` })));
}
function renderUnlock() {
  const f = state.form;
  return h('section', { class: 'screen' }, h('div', { class: 'scroll' },
    h('div', { class: 'lock-hero' },
      h('div', { class: 'app-mark' }, icon('lock')),
      h('div', { class: 'hero-title', text: 'VaultNote' }),
      h('p', { class: 'lock-text', text: f.info || '마스터 비밀번호를 입력하세요.' })),
    h('div', { class: 'group' },
      h('div', { class: 'field' }, h('label', { for: 'f-unlockPw', text: '비밀번호' }), passwordInput('unlockPw', '마스터 비밀번호', 'go'))),
    f.error ? h('p', { class: 'error-text', role: 'alert', text: f.error }) : null,
    h('button', { class: 'primary-btn', 'data-action': 'unlock' }, '잠금 해제'),
    memoryNotice(),
    h('p', { class: 'stage-note', text: `버전 ${APP_VERSION}` })));
}
// 강도 표시는 보이는 효과만 직접 바꾼다 (입력창은 다시 만들지 않음)
function updateStrengthMeter(k) {
  const st = passwordStrength(state.form[k] || '');
  const fill = root.querySelector('.strength-fill');
  const label = root.querySelector('.strength-label');
  if (fill) fill.className = `strength-fill lv${st.level}`;
  if (label) label.textContent = st.label || '강도';
}

// ----- 홈: 트리 + 검색 -----
function renderHome() {
  const total = countEntries(state.tree);
  const nav = navbar({
    title: '계정',
    left: h('button', { class: 'icon-btn', 'data-action': 'open-settings', 'aria-label': '설정' }, icon('sliders')),
    right: h('button', { class: 'nav-btn' + (state.editing ? ' bold' : ''), 'data-action': 'toggle-editing' },
      state.editing ? '완료' : '편집'),
  });
  const content = [
    h('h1', { class: 'large-title', text: '계정' }),
    searchBar(),
    h('div', { class: 'home-body' }, homeBody()),
  ];
  const toolbar = h('footer', { class: 'toolbar' },
    h('div', { class: 'toolbar-inner' },
      h('button', { class: 'icon-btn', 'data-action': 'new-folder', 'aria-label': '새 폴더' }, icon('folderPlus')),
      h('span', { class: 'toolbar-text', text: `계정 ${total}개` }),
      h('button', { class: 'icon-btn', 'data-action': 'new-entry', 'aria-label': '새 계정' }, icon('compose'))));
  return screen(nav, content, toolbar);
}
function homeBody() {
  const q = state.search.trim();
  const out = [saveBrokenBanner(), updateBanner(), backupBanner()];
  if (q) {
    out.push(...searchResults(q));
  } else if (!state.tree.children.length) {
    out.push(h('p', { class: 'empty', text: '아직 저장된 계정이 없습니다. 아래 오른쪽 버튼으로 첫 계정을 추가하세요.' }));
  } else {
    const rows = [];
    treeRows(state.tree, 0, rows);
    out.push(h('div', { class: 'spacer' }), h('div', { class: 'group' }, rows));
    out.push(h('p', {
      class: 'group-footer',
      text: state.editing
        ? '화살표로 순서를 바꿉니다. 순서를 바꾼 폴더는 이름순 대신 직접 정한 순서로 보입니다.'
        : '폴더를 누르면 펼치거나 접습니다. 오른쪽 ⋯ 버튼으로 폴더를 관리합니다.',
    }));
  }
  out.push(memoryNotice());
  return out;
}
function saveBrokenBanner() {
  if (!state.saveBroken) return null;
  return h('div', { class: 'banner warn-banner', role: 'alert' },
    h('div', { class: 'banner-title', text: '저장이 되지 않고 있습니다' }),
    h('div', { class: 'banner-text', text: '편집을 막아 두었습니다. 지금 백업 파일을 만든 뒤 앱을 완전히 닫았다가 다시 여세요.' }),
    h('div', { class: 'banner-actions' }, h('button', { class: 'nav-btn bold', 'data-action': 'backup' }, '지금 백업')));
}
function updateBanner() {
  if (!state.sw.waiting) return null;
  return h('div', { class: 'banner', role: 'note' },
    h('div', { class: 'banner-title', text: `새 버전 ${state.sw.waitingVersion || ''}이 있습니다` }),
    h('div', { class: 'banner-text', text: '누를 때만 바뀝니다. 업데이트 전에 백업을 권장합니다.' }),
    h('div', { class: 'banner-actions' },
      h('button', { class: 'nav-btn bold', 'data-action': 'update-app' }, '업데이트')));
}
function backupBanner() {
  if (state.bannerDismissed || state.search.trim() || !countEntries(state.tree)) return null;
  const verified = state.meta.lastBackupAt || 0;
  const created = state.meta.lastBackupCreatedAt || 0;
  const changed = state.meta.pwChangedAt || 0;
  const days = verified ? Math.floor((now() - verified) / 86400000) : null;
  const needAfterChange = changed && verified < changed;
  const unverified = created > verified;
  if (!needAfterChange && !unverified && verified && days < BACKUP_REMIND_DAYS) return null;
  const text = needAfterChange ? '마스터 비밀번호를 바꿨습니다. 새 비밀번호로 백업 파일을 다시 만들고 확인하세요.'
    : unverified ? '백업 파일을 만들었지만 아직 열어서 확인하지 않았습니다.'
      : verified ? `마지막으로 확인한 백업이 ${days}일 전입니다.`
        : '아직 확인된 백업 파일이 없습니다. 폰을 잃어버리면 복구할 수 없습니다.';
  const verifyFirst = unverified && (!changed || created > changed);
  return h('div', { class: 'banner', role: 'note' },
    h('div', { class: 'banner-title', text: '백업 파일을 만들어 두세요' }),
    h('div', { class: 'banner-text', text }),
    h('div', { class: 'banner-actions' },
      h('button', { class: 'nav-btn', 'data-action': 'banner-later' }, '나중에'),
      h('button', { class: 'nav-btn bold', 'data-action': verifyFirst ? 'verify-backup' : 'backup' }, verifyFirst ? '확인하기' : '지금 백업')));
}
function searchBar() {
  return h('div', { class: 'searchbar', role: 'search' },
    icon('search'),
    h('input', {
      type: 'text', 'data-field': 'search', value: state.search, placeholder: '검색',
      'aria-label': '사이트명, 주소, 아이디, 메모 검색', enterkeyhint: 'search', ...INPUT_ATTRS,
    }),
    h('button', { class: 'clear-btn' + (state.search ? '' : ' hidden'), 'data-action': 'clear-search', 'aria-label': '검색어 지우기' }, icon('clear')));
}
function searchResults(q) {
  const results = searchEntries(state.tree, q);
  if (!results.length) return [h('p', { class: 'empty', text: `‘${q}’와 일치하는 계정이 없습니다.` })];
  return [
    h('div', { class: 'group-header', text: `검색 결과 ${results.length}개` }),
    h('div', { class: 'group' }, results.map(({ entry, path }) =>
      h('div', { class: 'row' },
        h('button', { class: 'row-hit', 'data-action': 'open-entry', 'data-id': entry.id },
          tile(entry.title),
          h('span', { class: 'row-main' },
            h('span', { class: 'row-title', text: entry.title }),
            h('span', { class: 'row-sub', text: pathText(path) })),
          icon('chevron', 'chev'))))),
  ];
}

function indentOf(depth) { return `${16 + depth * 22}px`; }

function treeRows(folder, depth, rows) {
  const kids = sortedChildren(folder);
  kids.forEach((node, i) => {
    if (node.type === 'folder') {
      const open = state.expanded.has(node.id);
      rows.push(folderRow(node, depth, open, i, kids.length));
      if (open) {
        if (node.children.length) treeRows(node, depth + 1, rows);
        else rows.push(h('div', { class: 'row', style: { '--indent': indentOf(depth + 1) } },
          h('span', { class: 'row-hit row-sub', text: '비어 있음' })));
      }
    } else {
      rows.push(entryRow(node, depth, i, kids.length));
    }
  });
}
function reorderButtons(node, i, len) {
  return [
    h('button', { class: 'icon-btn', 'data-action': 'move-up', 'data-id': node.id, 'aria-label': `${nameOf(node)} 위로`, disabled: i === 0 }, icon('up')),
    h('button', { class: 'icon-btn', 'data-action': 'move-down', 'data-id': node.id, 'aria-label': `${nameOf(node)} 아래로`, disabled: i === len - 1 }, icon('down')),
  ];
}
function folderRow(f, depth, open, i, len) {
  return h('div', { class: 'row folder-row' + (open ? ' open' : ''), style: { '--indent': indentOf(depth) } },
    h('button', { class: 'row-hit', 'data-action': 'toggle', 'data-id': f.id, 'aria-expanded': String(open) },
      icon('chevron', 'disclosure'),
      icon('folder', 'folder-icon'),
      h('span', { class: 'row-title', text: f.name }),
      h('span', { class: 'badge', text: String(countEntries(f)) })),
    state.editing
      ? reorderButtons(f, i, len)
      : h('button', { class: 'icon-btn', 'data-action': 'folder-menu', 'data-id': f.id, 'aria-label': `${f.name} 폴더 메뉴` }, icon('more')));
}
function entryRow(e, depth, i, len) {
  return h('div', { class: 'row', style: { '--indent': indentOf(depth) } },
    h('button', { class: 'row-hit', 'data-action': 'open-entry', 'data-id': e.id },
      tile(e.title),
      h('span', { class: 'row-main' },
        h('span', { class: 'row-title', text: e.title }),
        e.username ? h('span', { class: 'row-sub', text: e.username }) : null),
      state.editing ? null : icon('chevron', 'chev')),
    state.editing ? reorderButtons(e, i, len) : null);
}

// ----- 계정 상세 -----
function kvRow(label, valueEl, ...buttons) {
  return h('div', { class: 'kv' },
    h('div', { class: 'kv-main' }, h('div', { class: 'kv-label', text: label }), valueEl),
    ...buttons);
}
function renderEntry(s) {
  const found = findWithPath(state.tree, s.id);
  if (!found) {
    return screen(navbar({ left: backButton(), title: '' }),
      [h('p', { class: 'empty', text: '이 계정은 삭제되었습니다.' })]);
  }
  const e = found.node;
  const shown = state.reveal.has(e.id);
  const nav = navbar({
    left: backButton(),
    title: e.title,
    right: h('button', { class: 'nav-btn', 'data-action': 'edit-entry', 'data-id': e.id }, '편집'),
  });
  const pwValue = e.password
    ? h('div', { class: 'kv-value ' + (shown ? 'mono' : 'masked'), text: shown ? e.password : '••••••••' })
    : h('div', { class: 'kv-value empty', text: '없음' });

  const content = [
    h('div', { class: 'hero' },
      tile(e.title),
      h('div', { class: 'hero-title', text: e.title }),
      e.url ? h('div', { class: 'hero-sub', text: hostOf(e.url) }) : null),
    h('div', { class: 'spacer' }),
    h('div', { class: 'group' },
      kvRow('아이디',
        h('div', { class: 'kv-value' + (e.username ? '' : ' empty'), text: e.username || '없음' }),
        h('button', { class: 'icon-btn', 'data-action': 'copy-user', 'data-id': e.id, 'aria-label': '아이디 복사', disabled: !e.username }, icon('copy'))),
      kvRow(shown ? '비밀번호 (10초 후 숨김)' : '비밀번호', pwValue,
        h('button', { class: 'icon-btn', 'data-action': 'toggle-reveal', 'data-id': e.id, 'aria-label': shown ? '비밀번호 숨기기' : '비밀번호 보기', disabled: !e.password }, icon(shown ? 'eyeOff' : 'eye')),
        h('button', { class: 'icon-btn', 'data-action': 'copy-pw', 'data-id': e.id, 'aria-label': '비밀번호 복사', disabled: !e.password }, icon('copy'))),
      kvRow('웹사이트', h('div', { class: 'kv-value' + (e.url ? '' : ' empty'), text: e.url || '없음' }))),
  ];
  if (e.memo) {
    content.push(h('div', { class: 'group-header', text: '메모' }),
      h('div', { class: 'group' }, h('div', { class: 'memo-text', text: e.memo })));
  }
  content.push(
    h('div', { class: 'group-header', text: '위치' }),
    h('div', { class: 'group' },
      h('button', { class: 'row-btn', 'data-action': 'move-entry', 'data-id': e.id },
        icon('folder', 'folder-icon'),
        h('span', { class: 'row-title', text: pathText(found.path) }),
        h('span', { class: 'badge', text: '이동' }),
        icon('chevron', 'chev'))),
    h('div', { class: 'spacer' }),
    h('div', { class: 'group' },
      h('button', { class: 'row-btn center danger', 'data-action': 'delete-entry', 'data-id': e.id }, '계정 삭제')),
    h('p', { class: 'group-footer', text: `마지막 수정 ${dateFmt.format(e.updatedAt)}` }));
  return screen(nav, content);
}

// ----- 새 계정 / 계정 편집 -----
function field(label, name, attrs, trailing) {
  const d = state.draft;
  const inputId = `f-${name}`;
  return h('div', { class: 'field' },
    h('label', { for: inputId, text: label }),
    h('input', { id: inputId, 'data-field': name, value: d ? d.fields[name] : '', ...INPUT_ATTRS, ...attrs }),
    trailing || null);
}
function renderEdit() {
  const d = state.draft || { fields: { title: '', url: '', username: '', password: '', memo: '' }, parentId: 'root', showPw: false };
  const isNew = !d.entryId;
  const nav = navbar({
    solid: true,
    left: h('button', { class: 'nav-btn', 'data-action': 'edit-cancel' }, '취소'),
    title: isNew ? '새 계정' : '계정 편집',
    right: h('button', { class: 'nav-btn bold', 'data-action': 'edit-save' }, '완료'),
  });
  const content = [
    h('div', { class: 'spacer' }),
    h('div', { class: 'group' },
      field('사이트명', 'title', { type: 'text', placeholder: '예: 국민은행', enterkeyhint: 'next', maxlength: '100' }),
      field('주소', 'url', { type: 'url', inputmode: 'url', placeholder: 'https://', enterkeyhint: 'next' })),
    h('div', { class: 'group' },
      field('아이디', 'username', { type: 'text', placeholder: '아이디 또는 이메일', enterkeyhint: 'next' }),
      field('비밀번호', 'password', { type: 'password', placeholder: '비밀번호', enterkeyhint: 'done' },
        [h('button', { class: 'icon-btn', 'data-action': 'draft-toggle-pw', 'aria-label': d.showPw ? '비밀번호 숨기기' : '비밀번호 보기' }, icon(d.showPw ? 'eyeOff' : 'eye')),
          h('button', { class: 'icon-btn', 'data-action': 'open-generator', 'aria-label': '비밀번호 생성' }, icon('dice'))]),
      // 입력칸은 항상 가린 상태로 두고(키보드 학습 방지), 보기는 읽기 전용 글자로만 보여준다
      d.showPw ? h('div', { class: 'pw-peek', 'aria-live': 'polite', text: d.fields.password || ' ' }) : null),
    h('div', { class: 'group-header', text: '메모' }),
    h('div', { class: 'group' },
      h('textarea', { class: 'memo-input', 'data-field': 'memo', value: d.fields.memo, placeholder: '추가 정보', 'aria-label': '메모', ...INPUT_ATTRS })),
  ];
  if (isNew) {
    const r = findWithPath(state.tree, d.parentId);
    const text = r ? pathText([...r.path, r.node]) : '최상위';
    content.push(
      h('div', { class: 'group-header', text: '저장할 폴더' }),
      h('div', { class: 'group' },
        h('button', { class: 'row-btn', 'data-action': 'pick-draft-folder' },
          icon('folder', 'folder-icon'),
          h('span', { class: 'row-title', text }),
          icon('chevron', 'chev'))));
  }
  return screen(nav, content);
}

// ----- 설정 -----
function renderSettings() {
  const info = state.storageInfo;
  const nav = navbar({ left: backButton(), title: '설정' });
  const content = [
    h('h1', { class: 'large-title', text: '설정' }),
    h('div', { class: 'spacer' }),
    h('div', { class: 'group' },
      h('button', { class: 'row-btn', 'data-action': 'lock' },
        icon('lock', 'folder-icon'), h('span', { class: 'row-title', text: '지금 잠그기' }))),
    h('div', { class: 'group-header', text: '보안' }),
    h('div', { class: 'group' },
      settingsValueRow('choose-autolock', '자동 잠금', `${autoLockMin()}분 미사용 시`),
      settingsValueRow('choose-grace', '다른 앱으로 전환하면', graceSec() === 0 ? '즉시 잠금' : `${graceSec() / 60}분 후 잠금`),
      settingsRow('change-pw', '마스터 비밀번호 변경')),
    h('p', { class: 'group-footer', text: `${graceSec() ? `다른 앱에 다녀와도 ${graceSec() / 60}분 안이면 잠기지 않습니다. ` : ''}최근 앱 목록에서는 항상 화면이 가려집니다. 복사한 내용은 30초 후, 또는 앱으로 돌아올 때 지웁니다. 키보드 앱(Gboard·삼성 키보드)의 클립보드 기록은 앱이 지울 수 없으니 키보드 설정에서 꺼 두세요.` }),
    h('div', { class: 'group-header', text: '저장 상태' }),
    h('div', { class: 'group' },
      kvRow('저장 위치', h('div', { class: 'kv-value', text: info ? info.where : '확인 중…' })),
      kvRow('마지막 저장', h('div', { class: 'kv-value', text: state.lastSavedAt ? dateFmt.format(state.lastSavedAt) : '-' })),
      kvRow('암호문 크기', h('div', { class: 'kv-value', text: info ? info.size : '-' })),
      kvRow('직전 저장본', h('div', { class: 'kv-value', text: info ? info.previous : '-' })),
      kvRow('브라우저 영구 보관', h('div', { class: 'kv-value', text: state.persisted === true ? '허용됨' : state.persisted === false ? '허용 안 됨 (홈 화면에 설치하면 허용될 수 있음)' : '확인 불가' })),
      kvRow('저장된 내용 (앞부분)', h('div', { class: 'kv-value mono small', text: info && info.sample ? info.sample : '-' })),
      kvRow('잠금 해제에 걸린 시간', h('div', { class: 'kv-value', text: state.unlockMs != null ? `${seconds(state.unlockMs)} (목표 3초 이내)` : '-' }))),
    h('p', { class: 'group-footer', text: '저장된 내용은 암호문이라 알아볼 수 없는 글자로 보여야 정상입니다.' }),
    h('div', { class: 'group-header', text: '백업과 복원' }),
    h('div', { class: 'group' },
      settingsRow('backup', '암호화 백업 파일 만들기'),
      settingsRow('restore-backup', '백업 파일로 복원'),
      settingsRow('import-text', '텍스트 파일 가져오기'),
      settingsRow('verify-backup', '백업 파일 확인'),
      settingsRow('open-snapshots', '저장본 기록에서 되돌리기'),
      settingsRow('restore-previous', '직전 저장본으로 되돌리기'),
      settingsRow('export-text', '평문 텍스트로 내보내기', true)),
    h('p', { class: 'group-footer', text: `마지막 확인된 백업: ${state.meta.lastBackupAt ? dateFmt.format(state.meta.lastBackupAt) : '없음'}. 백업 파일은 다운로드 폴더에 저장됩니다. 만든 뒤 ‘백업 파일 확인’으로 열어 보고, SD카드·PC 등 폰 밖 2곳에 옮겨 보관하세요.` }),
    h('div', { class: 'group-header', text: '앱' }),
    h('div', { class: 'group' },
      kvRow('오프라인 사용', h('div', { class: 'kv-value', text: state.sw.controlled ? '준비됨' : state.sw.supported ? '준비 중 (한 번 새로고침하면 준비됩니다)' : '이 화면에서는 쓸 수 없음' })),
      kvRow('설치 방식', h('div', { class: 'kv-value', text: isStandalone() ? '홈 화면 앱' : '브라우저 탭' })),
      kvRow('저장된 코드 버전', h('div', { class: 'kv-value', text: state.sw.activeVersion || '-' })),
      state.sw.waiting
        ? settingsValueRow('update-app', '새 버전으로 업데이트', state.sw.waitingVersion || '')
        : settingsRow('check-update', '업데이트 확인'),
      state.installPrompt ? settingsRow('install-app', '홈 화면에 설치') : null),
    h('p', { class: 'group-footer', text: isStandalone()
      ? '새 버전은 승인할 때만 적용됩니다. 이는 실수를 막는 장치이며, GitHub 계정이 해킹되면 막지 못합니다. GitHub 계정 보안(2단계 인증)이 실제 방어선입니다.'
      : '크롬 메뉴(⋮) → ‘홈 화면에 추가’ 또는 ‘앱 설치’로 설치하면 전체 화면 앱처럼 쓸 수 있습니다.' }),
    h('div', { class: 'group-header', text: '점검' }),
    h('div', { class: 'group' },
      h('button', { class: 'row-btn center', 'data-action': 'self-test' }, '자가 테스트 실행')),
  ];
  if (state.selfTest) {
    const r = state.selfTest.results;
    const passed = r.filter((x) => x.ok === true).length;
    const failed = r.filter((x) => x.ok === false).length;
    content.push(
      h('div', { class: 'group-header', text: failed ? `통과 ${passed}개, 실패 ${failed}개` : `모두 통과 (${passed}개)` }),
      h('div', { class: 'group' }, r.map((x) =>
        h('div', { class: 'kv' },
          h('span', { class: 'result ' + (x.ok === true ? 'ok' : x.ok === false ? 'fail' : 'info') },
            icon(x.ok === true ? 'check' : x.ok === false ? 'cross' : 'dash')),
          h('div', { class: 'kv-main' },
            h('div', { class: 'kv-value', text: x.label }),
            x.detail ? h('div', { class: 'kv-label', text: x.detail }) : null)))));
  }
  content.push(
    h('div', { class: 'group-header', text: '정보' }),
    h('div', { class: 'group' }, kvRow('버전', h('div', { class: 'kv-value', text: APP_VERSION })), kvRow('라이선스', h('div', { class: 'kv-value', text: 'MIT (저장소의 LICENSE 파일)' }))),
    h('p', { class: 'group-footer', text: DISCLAIMER }),
    h('p', { class: 'stage-note', text: `VaultNote ${APP_VERSION}. 서버 없이 이 기기에만 암호화해 저장합니다.` }));
  return screen(nav, content);
}

function renderSnapshots() {
  const list = state.snapList;
  const content = [h('h1', { class: 'large-title', text: '저장본 기록' })];
  if (!list) content.push(h('div', { class: 'scroll center' }, h('div', { class: 'spinner' })));
  else if (!list.length) content.push(h('p', { class: 'empty', text: '아직 기록이 없습니다. 내일 첫 변경 때부터 하루 기록이 쌓입니다.' }));
  else {
    content.push(h('div', { class: 'spacer' }), h('div', { class: 'group' }, list.map((x) =>
      h('button', { class: 'row-btn', 'data-action': 'snapshot-restore', 'data-id': x.id },
        h('span', { class: 'row-main' },
          h('span', { class: 'row-title', text: x.reason }),
          h('span', { class: 'row-sub', text: dateFmt.format(x.at) })),
        h('span', { class: 'badge', text: '되돌리기' }), icon('chevron', 'chev')))));
  }
  content.push(h('p', { class: 'group-footer', text: `하루 첫 변경 전 기록 ${SNAP_KEEP.daily}개와, 백업 복원·가져오기·폴더 삭제·되돌리기·업데이트 직전 기록 ${SNAP_KEEP.protected}개를 암호화해 보관합니다.` }));
  return screen(navbar({ left: backButton(), title: '저장본 기록' }), content);
}
function settingsValueRow(action, label, value) {
  return h('button', { class: 'row-btn', 'data-action': action },
    h('span', { class: 'row-title', text: label }), h('span', { class: 'badge', text: value }), icon('chevron', 'chev'));
}

// ----- 비밀번호 생성기 화면 -----
function renderGenerator() {
  const g = state.gen || { ...GEN_DEFAULTS, value: '' };
  const toggle = (k, label) => h('label', { class: 'toggle-row' },
    h('span', { class: 'toggle-text', text: label }),
    h('input', { type: 'checkbox', class: 'switch', 'data-field': `gen:${k}`, checked: !!g[k] }));
  const content = [
    h('h1', { class: 'large-title', text: '비밀번호 생성' }),
    h('div', { class: 'group' },
      h('div', { class: 'gen-box' },
        h('div', { class: 'gen-preview', 'aria-live': 'polite', text: g.value }),
        h('button', { class: 'icon-btn', 'data-action': 'gen-refresh', 'aria-label': '다시 만들기' }, icon('refresh')))),
    h('div', { class: 'group-header', text: '설정' }),
    h('div', { class: 'group' },
      h('div', { class: 'gen-slider' },
        h('div', { class: 'gen-slider-top' }, h('span', { text: '길이' }), h('span', { class: 'gen-length badge', text: `${g.length}자` })),
        h('input', { type: 'range', min: '8', max: '32', step: '1', value: String(g.length), 'data-field': 'gen:length', 'aria-label': '비밀번호 길이' })),
      toggle('upper', '대문자 (A–Z)'),
      toggle('lower', '소문자 (a–z)'),
      toggle('digits', '숫자 (0–9)'),
      toggle('symbols', '특수문자 (!@#$ 등)')),
    h('p', { class: 'group-footer', text: '기기의 암호용 난수로 만듭니다. 특수문자를 받지 않는 사이트라면 특수문자를 끄세요.' }),
    h('button', { class: 'primary-btn', 'data-action': 'gen-use' }, '이 비밀번호 사용'),
  ];
  return screen(navbar({ left: backButton(), title: '비밀번호 생성' }), content);
}

// ----- 마스터 비밀번호 변경 화면 -----
function renderChangePw() {
  const f = state.form;
  const st = passwordStrength(f.newPw || '');
  const content = [
    h('h1', { class: 'large-title', text: '비밀번호 변경' }),
    h('div', { class: 'group' },
      h('div', { class: 'field' }, h('label', { for: 'f-curPw', text: '지금' }), passwordInput('curPw', '지금 마스터 비밀번호', 'next'))),
    h('div', { class: 'group', style: { 'margin-top': '24px' } },
      h('div', { class: 'field' }, h('label', { for: 'f-newPw', text: '새 비밀번호' }), passwordInput('newPw', `${MIN_PASSWORD}자 이상`, 'next')),
      h('div', { class: 'field' }, h('label', { for: 'f-newPw2', text: '확인' }), passwordInput('newPw2', '한 번 더 입력', 'done')),
      h('div', { class: 'strength', 'aria-live': 'polite' },
        h('div', { class: 'strength-bar' }, h('div', { class: `strength-fill lv${st.level}` })),
        h('span', { class: 'strength-label', text: st.label || '강도' }))),
    h('p', { class: 'group-footer', text: '바꾼 뒤에는 이전 백업 파일이 옛 비밀번호로만 열립니다. 바꾼 다음 새 백업 파일을 만드세요.' }),
    f.error ? h('p', { class: 'error-text', role: 'alert', text: f.error }) : null,
    h('button', { class: 'primary-btn', 'data-action': 'change-pw-confirm' }, '비밀번호 변경'),
  ];
  return screen(navbar({ left: backButton(), title: '비밀번호 변경' }), content);
}

function settingsRow(action, label, danger) {
  return h('button', { class: 'row-btn' + (danger ? ' danger' : ''), 'data-action': action },
    h('span', { class: 'row-title', text: label }), icon('chevron', 'chev'));
}

// ----- 텍스트 가져오기 미리보기 -----
function renderImport() {
  const p = state.importPreview;
  const nav = navbar({
    solid: true,
    left: h('button', { class: 'nav-btn', 'data-action': 'import-cancel' }, '취소'),
    title: '가져오기',
    right: h('button', { class: 'nav-btn bold', 'data-action': 'import-confirm', disabled: !p || !p.entryCount }, '가져오기'),
  });
  if (!p) return screen(nav, [h('p', { class: 'empty', text: '가져올 내용이 없습니다.' })]);
  const top = sortedChildren(p.root);
  const looseEntries = top.filter((c) => c.type === 'entry').length;
  const content = [
    h('div', { class: 'spacer' }),
    h('div', { class: 'group' },
      kvRow('파일', h('div', { class: 'kv-value', text: p.fileName })),
      kvRow('읽은 내용', h('div', { class: 'kv-value', text: `폴더 ${p.folderCount}개, 계정 ${p.entryCount}개` }))),
    h('p', { class: 'group-footer', text: '최상위에 추가됩니다. 지금 있는 계정은 그대로 남습니다.' }),
  ];
  if (top.length) {
    content.push(h('div', { class: 'group-header', text: '미리보기' }),
      h('div', { class: 'group' },
        top.filter((c) => c.type === 'folder').map((f) =>
          h('div', { class: 'row-btn' }, icon('folder', 'folder-icon'),
            h('span', { class: 'row-title', text: f.name }), h('span', { class: 'badge', text: `${countEntries(f)}개` }))),
        looseEntries ? h('div', { class: 'row-btn' }, h('span', { class: 'row-title', text: '폴더 밖 계정' }), h('span', { class: 'badge', text: `${looseEntries}개` })) : null));
  }
  if (p.warnings.length) {
    content.push(h('div', { class: 'group-header', text: '확인할 점' }),
      h('div', { class: 'group' }, p.warnings.map((w) => h('div', { class: 'memo-text', text: w }))));
  }
  if (p.unparsed.length) {
    const shown = p.unparsed.slice(0, 30);
    content.push(h('div', { class: 'group-header', text: `해석하지 못한 줄 ${p.unparsed.length}개 (가져오지 않음)` }),
      h('div', { class: 'group' }, shown.map((u) =>
        kvRow(`${u.line}번째 줄`, h('div', { class: 'kv-value mono small', text: u.text })))),
      h('p', { class: 'group-footer', text: (p.unparsed.length > shown.length ? `외 ${p.unparsed.length - shown.length}줄. ` : '')
        + '원본 파일을 PRD 2장 형식에 맞게 고친 뒤 다시 가져오거나, 직접 입력하세요.' }));
  }
  return screen(nav, content);
}

// ----- 가져오기 후 원본 정리 -----
const CLEANUP_ITEMS = [
  ['original', (name) => `원본 파일 ‘${name}’ 삭제`],
  ['copies', () => 'SD카드·다운로드 폴더의 다른 사본 삭제'],
  ['cloud', () => '구글 드라이브 등 클라우드의 사본 삭제'],
  ['messenger', () => '카카오톡 ‘나와의 채팅’ 등 메신저로 보낸 사본 삭제'],
  ['trash', () => '내 파일 앱의 휴지통 비우기'],
];
function renderCleanup() {
  const c = state.cleanup || { fileName: '', checks: {} };
  const nav = navbar({
    solid: true, title: '원본 파일 정리',
    right: h('button', { class: 'nav-btn bold', 'data-action': 'cleanup-done' }, '완료'),
  });
  const content = [
    h('div', { class: 'lock-hero' },
      h('div', { class: 'app-mark warn-mark' }, icon('lock')),
      h('div', { class: 'hero-title', text: '가져오기가 끝났습니다' }),
      h('p', { class: 'lock-text', text: '원본 텍스트 파일에는 비밀번호가 평문으로 남아 있습니다. 지금 아래 사본들을 직접 지워 주세요.' })),
    h('div', { class: 'group' }, CLEANUP_ITEMS.map(([k, label]) =>
      h('label', { class: 'toggle-row' },
        h('span', { class: 'toggle-text', text: label(c.fileName) }),
        h('input', { type: 'checkbox', class: 'switch', 'data-field': `cleanup:${k}`, checked: !!c.checks[k] })))),
    h('p', { class: 'group-footer', text: '이 앱은 다른 앱의 파일을 지울 수 없어 직접 지워야 합니다. 체크 표시는 확인용이며 저장되지 않습니다.' }),
  ];
  return screen(nav, content);
}

// ----- 평문 내보내기 -----
function renderExportText() {
  const f = state.form;
  const nav = navbar({ left: backButton(), title: '평문 내보내기' });
  const content = [
    h('h1', { class: 'large-title', text: '평문 내보내기' }),
    h('div', { class: 'group warn-box' },
      h('div', { class: 'memo-text' },
        h('strong', { text: '이 파일에는 모든 비밀번호가 암호화되지 않은 상태로 들어갑니다.' }),
        '\n파일을 가진 사람은 누구나 모든 계정을 볼 수 있습니다. 클라우드나 메신저로 보내지 말고, 사용이 끝나면 바로 삭제하세요. 기기를 옮길 때는 암호화 백업 파일을 쓰세요.')),
    h('div', { class: 'group-header', text: '본인 확인' }),
    h('div', { class: 'group' },
      h('div', { class: 'field' }, h('label', { for: 'f-exportPw', text: '비밀번호' }), passwordInput('exportPw', '마스터 비밀번호', 'go'))),
    f.error ? h('p', { class: 'error-text', role: 'alert', text: f.error }) : null,
    h('button', { class: 'primary-btn destructive', 'data-action': 'export-text-confirm' }, '평문 파일 내보내기'),
  ];
  return screen(nav, content);
}

// ----- 오버레이 -----
function renderToast(low) {
  const t = state.toast;
  const el = h('div', { class: 'toast' + (low ? ' low' : '') + (t.fresh ? ' enter' : ''), role: 'status' },
    h('span', { text: t.message }),
    t.undoable ? h('button', { 'data-action': 'undo' }, '실행 취소') : null);
  t.fresh = false;
  return el;
}
function renderBusy() {
  return h('div', { class: 'busy', role: 'alert', 'aria-busy': 'true' },
    h('div', { class: 'busy-box' }, h('div', { class: 'spinner' }), h('span', { text: state.busy })));
}
function renderSheet() {
  const s = state.sheet;
  const panel = s.type === 'pick' ? pickSheet(s) : menuSheet(s);
  const backdrop = h('div', { class: 'backdrop' + (s.fresh ? ' enter' : ''), 'data-action': 'close-overlay' });
  if (s.fresh) panel.classList.add('enter');
  s.fresh = false;
  return h('div', { class: 'overlay' }, backdrop, panel);
}
function menuSheet(s) {
  return h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': s.title },
    h('div', { class: 'sheet-group' },
      s.title ? h('div', { class: 'sheet-title', text: s.title }) : null,
      s.items.map((it) => h('button', {
        class: 'sheet-btn' + (it.danger ? ' danger' : ''), 'data-action': it.act, 'data-id': it.id, disabled: !!it.disabled,
      }, it.label))),
    h('div', { class: 'sheet-group' },
      h('button', { class: 'sheet-btn cancel', 'data-action': 'close-overlay' }, '취소')));
}
function pickSheet(s) {
  const moving = s.mode === 'move' ? findNode(state.tree, s.id) : null;
  const title = moving ? `‘${nameOf(moving)}’을(를) 옮길 폴더` : '저장할 폴더';
  const rows = [];
  walkFolders(state.tree, (f, depth) => {
    const ok = s.mode === 'draft' ? true : canMoveTo(state.tree, s.id, f.id);
    const isCurrent = f.id === s.current;
    rows.push(h('button', {
      class: 'pick-row', style: { '--indent': indentOf(depth) },
      'data-action': 'pick-folder', 'data-id': f.id, disabled: !ok && !isCurrent,
    },
    icon('folder', 'folder-icon'),
    h('span', { class: 'row-title', text: f.id === 'root' ? '최상위' : f.name }),
    isCurrent ? icon('check', 'check') : null));
  });
  return h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'sheet-group' },
      h('div', { class: 'sheet-title', text: title }),
      h('div', { class: 'sheet-list' }, rows)),
    h('div', { class: 'sheet-group' },
      h('button', { class: 'sheet-btn cancel', 'data-action': 'close-overlay' }, '취소')));
}
function renderAlert() {
  const a = state.alert;
  const box = h('div', { class: 'alert' + (a.fresh ? ' enter' : ''), role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'alert-title' },
    h('div', { class: 'alert-body' },
      h('div', { class: 'alert-title', id: 'alert-title', text: a.title }),
      a.message ? h('div', { class: 'alert-msg', text: a.message }) : null,
      a.input ? h('input', {
        class: 'alert-input', type: a.inputType || 'text', 'data-field': 'alertValue', value: a.value,
        placeholder: a.placeholder || '', enterkeyhint: 'done', maxlength: '60', 'aria-label': a.placeholder || a.title, ...INPUT_ATTRS,
      }) : null),
    h('div', { class: 'alert-actions' + (a.buttons.length > 2 ? ' stack' : '') },
      a.buttons.map((b, i) => h('button', {
        class: 'alert-btn' + (b.bold ? ' bold' : '') + (b.danger ? ' danger' : ''), 'data-action': 'alert-btn', 'data-index': String(i),
      }, b.label))));
  const backdrop = h('div', { class: 'backdrop' + (a.fresh ? ' enter' : '') });
  a.fresh = false;
  return h('div', { class: 'overlay' }, backdrop, box);
}

// ===== [EVENTS] 앱 전체에 리스너 하나씩 (이벤트 위임) =====
const actions = {
  'create-vault': () => createVault(),
  'unlock': () => unlockVault(),
  'lock': () => lockVault('', { keepDraft: true }),
  'open-settings': () => { state.storageInfo = null; push({ name: 'settings' }); loadStorageInfo(); },
  'self-test': () => runSelfTest(),
  'choose-autolock': () => {
    state.sheet = { type: 'menu', fresh: true, title: '사용하지 않으면 자동으로 잠글 시간',
      items: AUTOLOCK_CHOICES.map((m) => ({ label: `${m}분${m === 3 ? ' (기본)' : ''}${m === autoLockMin() ? '  ✓' : ''}`, act: 'set-autolock', id: String(m) })) };
    render();
  },
  'set-autolock': (v) => { state.sheet = null; setMeta({ autoLockMin: Number(v) }); },
  'choose-grace': () => {
    state.sheet = { type: 'menu', fresh: true, title: '다른 앱으로 전환했을 때 잠글 시점',
      items: GRACE_CHOICES.map((sec) => ({ label: `${graceLabel(sec)}${sec === 60 ? ' (기본)' : ''}${sec === graceSec() ? '  ✓' : ''}`, act: 'set-grace', id: String(sec) })) };
    render();
  },
  'set-grace': (v) => { state.sheet = null; setMeta({ graceSec: Number(v) }); },
  'change-pw': () => { state.form = {}; state.focusField = 'form:curPw'; push({ name: 'change-pw' }); },
  'change-pw-confirm': () => changeMasterPassword(),
  'open-generator': () => openGenerator(),
  'update-app': () => confirmUpdate(),
  'check-update': () => checkForUpdate(true),
  'install-app': () => installApp(),
  'gen-refresh': () => regenerate(),
  'gen-use': () => useGenerated(),
  'backup': () => exportBackup(),
  'banner-later': () => { state.bannerDismissed = true; render(); },
  'restore-backup': () => chooseBackupFile('replace'),
  'restore-backup-new': () => chooseBackupFile('new'),
  'import-text': () => chooseTextFile(),
  'import-cancel': () => goBack(),
  'import-confirm': () => confirmImport(),
  'cleanup-done': () => goBack(),
  'restore-previous': () => confirmRestorePrevious(),
  'open-snapshots': () => openSnapshots(),
  'snapshot-restore': (id) => confirmRestoreSnapshot(id),
  'verify-backup': () => chooseBackupFile('verify'),
  'export-text': () => { state.form = {}; push({ name: 'export-text' }); },
  'export-text-confirm': () => exportPlainText(),

  'back': () => goBack(),
  'toggle-editing': () => { state.editing = !state.editing; render(); },
  'toggle': (id) => {
    if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
    render();
  },
  'folder-menu': (id) => openFolderMenu(id),
  'open-entry': (id) => push({ name: 'entry', id }),
  'new-entry': () => openEditor(null, 'root'),
  'new-folder': () => promptName({
    title: '새 폴더', message: '최상위에 만들 폴더 이름을 입력하세요.', confirmLabel: '만들기',
    run: (name) => commit((t) => addNode(t, 'root', makeFolder(name))),
  }),
  'clear-search': () => { state.search = ''; state.focusField = 'search'; render(); },
  'move-up': (id) => commit((t) => reorderNode(t, id, -1)),
  'move-down': (id) => commit((t) => reorderNode(t, id, 1)),

  'edit-entry': (id) => openEditor(id),
  'copy-user': (id) => { const e = findNode(state.tree, id); if (e) copyText(e.username, '아이디를 복사했습니다.'); },
  'copy-pw': (id) => { const e = findNode(state.tree, id); if (e) copyText(e.password, '비밀번호를 복사했습니다.'); },
  'toggle-reveal': (id) => {
    if (state.reveal.has(id)) { state.reveal.delete(id); render(); return; }
    const until = now() + REVEAL_MS;
    state.reveal.set(id, until);
    setTimeout(() => {
      if (state.reveal.get(id) !== until) return;   // 그사이 다시 누른 경우
      state.reveal.delete(id);
      const t = topScreen();
      if (state.phase === 'open' && t.name === 'entry' && t.id === id) render();
    }, REVEAL_MS);
    render();
  },
  'move-entry': (id) => openPicker('move', id, findParent(state.tree, id).id),
  'delete-entry': (id) => {
    state.sheet = {
      type: 'menu', fresh: true, title: '이 계정을 삭제할까요? 삭제 후 5초 안에 되돌릴 수 있습니다.',
      items: [{ label: '계정 삭제', act: 'confirm-delete-entry', id, danger: true }],
    };
    render();
  },
  'confirm-delete-entry': (id) => { state.sheet = null; goBack(); deleteWithUndo(id); },

  'edit-cancel': () => { if (isDraftDirty()) confirmDiscard(); else goBack(); },
  'edit-save': () => saveDraft(),
  'draft-toggle-pw': () => { if (state.draft) { state.draft.showPw = !state.draft.showPw; state.focusField = 'password'; render(); } },
  'pick-draft-folder': () => { if (state.draft) openPicker('draft', null, state.draft.parentId); },
  'pick-folder': (targetId) => {
    const s = state.sheet;
    state.sheet = null;
    if (!s) return;
    if (s.mode === 'draft') {
      if (state.draft) state.draft.parentId = targetId;
      render();
      return;
    }
    if (targetId === s.current) { render(); return; }
    const node = findNode(state.tree, s.id);
    commit((t) => moveNode(t, s.id, targetId));
    if (targetId !== 'root') expandTo(targetId);
    const target = findNode(state.tree, targetId);
    showToast(`‘${nameOf(node)}’ → ${targetId === 'root' ? '최상위' : target.name}`);
  },

  'folder-new-entry': (id) => { state.sheet = null; expandTo(id); openEditor(null, id); },
  'folder-new-sub': (id) => promptName({
    title: '하위 폴더', message: `‘${findNode(state.tree, id).name}’ 안에 만들 폴더 이름을 입력하세요.`, confirmLabel: '만들기',
    run: (name) => { expandTo(id); commit((t) => addNode(t, id, makeFolder(name))); },
  }),
  'folder-rename': (id) => {
    const f = findNode(state.tree, id);
    promptName({
      title: '이름 변경', value: f.name, confirmLabel: '저장',
      run: (name) => commit((t) => { const n = findNode(t, id); n.name = name; n.updatedAt = now(); }),
    });
  },
  'folder-sort': (id) => { state.sheet = null; commit((t) => { findNode(t, id).sort = 'name'; }); },
  'folder-move': (id) => openPicker('move', id, findParent(state.tree, id).id),
  'folder-delete': (id) => {
    state.sheet = null;
    const f = findNode(state.tree, id);
    if (!f.children.length) { deleteWithUndo(id); return; }
    const n = countEntries(f);
    state.alert = {
      title: `‘${f.name}’ 폴더를 삭제할까요?`,
      message: `안에 있는 계정 ${n}개와 하위 폴더도 함께 삭제됩니다. 삭제 후 5초 안에 되돌릴 수 있습니다.`,
      fresh: true,
      buttons: [{ label: '취소', bold: true }, { label: '삭제', danger: true, run: () => { takeSnapshot('폴더 삭제 전'); deleteWithUndo(id); } }],
    };
    render();
  },

  'close-overlay': () => { state.sheet = null; render(); },
  'alert-btn': (_id, el) => pressAlertButton(Number(el.dataset.index)),
  'undo': () => undoDelete(),
};

root.addEventListener('click', (ev) => {
  if (state.busy) return;
  const el = ev.target.closest('[data-action]');
  if (!el || !root.contains(el) || el.disabled) return;
  const fn = actions[el.dataset.action];
  if (fn) fn(el.dataset.id, el);
});

root.addEventListener('input', (ev) => {
  const f = ev.target.dataset && ev.target.dataset.field;
  if (!f) return;
  if (f === 'search') {
    state.search = ev.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(updateSearchResults, SEARCH_DELAY_MS);
  } else if (f === 'alertValue') {
    if (state.alert) state.alert.value = ev.target.value;
  } else if (f === 'gen:length') {
    if (state.gen) { state.gen.length = Number(ev.target.value); regenerate(); }
  } else if (f.startsWith('form:')) {
    const k = f.slice(5);
    if (ev.target.type === 'checkbox') return; // change 이벤트에서 처리
    state.form[k] = ev.target.value;
    if (k === 'setupPw' || k === 'newPw') updateStrengthMeter(k);
  } else if (state.draft && f in state.draft.fields) {
    state.draft.fields[f] = ev.target.value; // 입력 중에는 다시 그리지 않는다
    if (f === 'password') { const peek = root.querySelector('.pw-peek'); if (peek) peek.textContent = ev.target.value || ' '; }
  }
});
root.addEventListener('change', (ev) => {
  const f = ev.target.dataset && ev.target.dataset.field;
  if (!f || ev.target.type !== 'checkbox') return;
  if (f.startsWith('form:')) state.form[f.slice(5)] = ev.target.checked;
  else if (f.startsWith('cleanup:') && state.cleanup) state.cleanup.checks[f.slice(8)] = ev.target.checked;
  else if (f.startsWith('gen:') && state.gen) {
    const k = f.slice(4);
    const others = ['upper', 'lower', 'digits', 'symbols'].filter((x) => x !== k && state.gen[x]);
    if (!ev.target.checked && !others.length) { ev.target.checked = true; return; } // 최소 한 종류는 켜 둔다
    state.gen[k] = ev.target.checked;
    regenerate();
  }
});

root.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter' || ev.isComposing || state.busy) return;
  const f = ev.target.dataset && ev.target.dataset.field;
  if (f === 'alertValue' && state.alert) {
    ev.preventDefault();
    const i = state.alert.buttons.findIndex((b) => b.run);
    if (i >= 0) pressAlertButton(i);
  } else if (f === 'search') {
    ev.preventDefault();
    ev.target.blur();
  } else if (f === 'form:curPw' || f === 'form:newPw') {
    ev.preventDefault();
    const next = root.querySelector(`[data-field="form:${f === 'form:curPw' ? 'newPw' : 'newPw2'}"]`);
    if (next) next.focus();
  } else if (f === 'form:newPw2') {
    ev.preventDefault();
    changeMasterPassword();
  } else if (f === 'form:exportPw') {
    ev.preventDefault();
    exportPlainText();
  } else if (f === 'form:unlockPw') {
    ev.preventDefault();
    unlockVault();
  } else if (f === 'form:setupPw') {
    ev.preventDefault();
    const next = root.querySelector('[data-field="form:setupPw2"]');
    if (next) next.focus();
  } else if (f === 'form:setupPw2') {
    ev.preventDefault();
    ev.target.blur();
  }
});

// 스크롤하면 큰 제목이 작은 제목 막대로 바뀐다 (보이는 효과만 바꾸고 데이터는 건드리지 않음)
root.addEventListener('scroll', (ev) => {
  const sc = ev.target;
  if (!sc.classList || !sc.classList.contains('scroll')) return;
  const nav = sc.parentElement.querySelector('.navbar');
  if (nav && !nav.classList.contains('solid')) nav.classList.toggle('scrolled', sc.scrollTop > 36);
}, { capture: true, passive: true });

// 사용 기록 (자동 잠금 계산용, 시각만 저장)
for (const type of ['pointerdown', 'keydown', 'input']) root.addEventListener(type, noteActivity, { passive: true, capture: true });
root.addEventListener('scroll', noteActivity, { passive: true, capture: true });
setInterval(checkIdle, IDLE_CHECK_MS);
// 다른 앱 전환: 화면 가림 + 유예 시간 계산 (시각 비교, 10-1)
document.addEventListener('visibilitychange', () => { if (document.hidden) onLeave(); else onReturn(); });
window.addEventListener('blur', () => { if (!inExternal()) showPrivacyCover(); });
window.addEventListener('focus', () => { hidePrivacyCover(); clearClipboard(); });
window.addEventListener('pageshow', () => { if (!document.hidden) onReturn(); });

// 크롬의 '앱 설치' 요청을 받아 두었다가 설정 화면에서 보여준다
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); state.installPrompt = e; softRender(); });
window.addEventListener('appinstalled', () => { state.installPrompt = null; softRender(); });

// 안드로이드 뒤로 가기 버튼
window.addEventListener('popstate', () => {
  if (pendingBack > 0) { pendingBack--; if (state.phase === 'open') popScreen(); return; }
  if (state.phase !== 'open') return;
  if (state.sheet || state.alert) {
    state.sheet = null;
    state.alert = null;
    repushHistory();
    render();
    return;
  }
  if (topScreen().name === 'edit' && isDraftDirty()) {
    repushHistory();
    confirmDiscard();
    return;
  }
  popScreen();
});

// ===== [INIT] =====
async function init() {
  if (window.top !== window.self) {               // 다른 사이트 안에 끼워 넣어 쓰는 것 방지
    state.phase = 'error';
    state.errorMessage = '다른 사이트 안에서는 열 수 없습니다. 주소창에 앱 주소를 직접 입력해 열어 주세요.';
    render();
    return;
  }
  try {
    history.replaceState({ vn: 1 }, '');
    state.historyOK = true;
  } catch {
    state.historyOK = false;
  }
  if (!window.crypto || !crypto.subtle || window.isSecureContext === false) {
    state.phase = 'error';
    state.errorMessage = '암호화 기능을 쓸 수 없는 환경입니다. https:// 주소에서 크롬이나 삼성인터넷으로 열어 주세요.';
    render();
    return;
  }
  render();
  if (!(await initStorage())) {
    // 저장소를 열지 못하면 새 금고를 만들지 않는다 (기존 금고를 사라진 것처럼 보이게 하지 않기, 검토 6)
    state.phase = 'error';
    state.errorMessage = '기기 저장소를 열지 못했습니다. 저장 공간이 부족하거나 사생활 보호(시크릿) 모드일 수 있습니다. 앱을 완전히 닫았다가 다시 열어 보세요. 금고 데이터는 지워지지 않았습니다.';
    render();
    return;
  }
  try {
    const cur = await readSlot('current');
    state.phase = cur ? 'unlock' : 'setup';
    state.focusField = cur ? 'form:unlockPw' : null;
  } catch {
    // 저장소를 읽지 못하면 새 금고를 만들지 않는다 (기존 금고 덮어쓰기 방지)
    state.phase = 'error';
    state.errorMessage = '저장된 데이터를 읽지 못했습니다. 앱을 다시 열어 보세요.';
  }
  render();
  initServiceWorker();
}
init();
