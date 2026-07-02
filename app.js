/* =====================================================================
   다우세라믹앤석재 통합관리 — 앱 로직
   - Firebase 설정이 있으면: 클라우드 실시간 동기화(모든 기기 공유)
   - 설정이 비어있으면: 이 기기에서만 저장(미리보기 모드)
   ===================================================================== */

/* ---------- 0. 저장소(Store) : 클라우드/로컬 공통 인터페이스 ----------
   - firebase-config.js 가 있으면 window.FIREBASE_CONFIG 사용 → 클라우드 실시간 공유
   - 없으면 이 기기에만 저장(미리보기)
   - 데이터는 teams/{TEAM} 아래에 저장 (기존 Firestore 보안규칙과 호환) */
const FBCONF = (typeof window !== 'undefined' && window.FIREBASE_CONFIG) ? window.FIREBASE_CONFIG
  : (typeof FIREBASE_CONFIG !== 'undefined' ? FIREBASE_CONFIG : { apiKey: "" });
const CLOUD = !!(FBCONF && FBCONF.apiKey);
const TEAM = 'dawoo';
let db = null, auth = null;
if (CLOUD) {
  firebase.initializeApp(FBCONF);
  db = firebase.firestore();
  auth = firebase.auth();
  // 같은 기기에서 자동 로그인 유지(LOCAL): 로그아웃 전까지 세션 보관
  try { auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL); } catch (e) { }
}
/* 저장해 둔 이메일을 로그인칸에 미리 채우기 */
function prefillEmail() {
  const saved = (() => { try { return localStorage.getItem('dws_email') || ''; } catch (e) { return ''; } })();
  const ei = el('lg-email'), ck = el('lg-remember');
  if (ei && saved) ei.value = saved;
  if (ck) ck.checked = !!saved;
}
function cref(name) { return db.collection('teams').doc(TEAM).collection(name); }

const COLLS = ['members', 'sites', 'inventory', 'holdings', 'transactions', 'specs', 'factories', 'teams', 'suppliers', 'clients', 'issues'];

// 로컬(미리보기) 모드용 - 같은 기기의 다른 탭끼리 실시간 반영
const bc = ('BroadcastChannel' in window) ? new BroadcastChannel('dws') : null;

const Store = {
  _watchers: {},
  read(coll) {
    try { return JSON.parse(localStorage.getItem('dws_' + coll) || '[]'); }
    catch (e) { return []; }
  },
  _writeLocal(coll, arr) {
    localStorage.setItem('dws_' + coll, JSON.stringify(arr));
    if (bc) bc.postMessage(coll);
  },
  watch(coll, cb) {
    if (CLOUD) {
      cref(coll).onSnapshot(snap => {
        cb(snap.docs.map(d => Object.assign({ id: d.id }, d.data())));
      }, err => console.warn('snapshot', coll, err));
    } else {
      this._watchers[coll] = cb;
      cb(this.read(coll));
    }
  },
  async add(coll, obj) {
    obj.createdAt = Date.now();
    if (CLOUD) { await cref(coll).add(obj); }
    else {
      const arr = this.read(coll);
      obj.id = 'L' + Date.now() + Math.floor(Math.random() * 1000);
      arr.push(obj); this._writeLocal(coll, arr);
      if (this._watchers[coll]) this._watchers[coll](arr);
    }
  },
  async update(coll, id, obj) {
    if (CLOUD) { await cref(coll).doc(id).update(obj); }
    else {
      const arr = this.read(coll);
      const i = arr.findIndex(x => x.id === id);
      if (i >= 0) { Object.assign(arr[i], obj); this._writeLocal(coll, arr); if (this._watchers[coll]) this._watchers[coll](arr); }
    }
  },
  async remove(coll, id) {
    if (CLOUD) { await cref(coll).doc(id).delete(); }
    else {
      let arr = this.read(coll).filter(x => x.id !== id);
      this._writeLocal(coll, arr); if (this._watchers[coll]) this._watchers[coll](arr);
    }
  }
};
if (bc) bc.onmessage = (e) => { const c = e.data; if (Store._watchers[c]) Store._watchers[c](Store.read(c)); };

/* ---------- 1. 전역 상태 ---------- */
const state = { members: [], sites: [], inventory: [], holdings: [], transactions: [], specs: [], factories: [], teams: [], suppliers: [], clients: [], issues: [] };
let me = null;          // 로그인한 사용자
let tab = 'home';
let filters = { sites: 'all', stock: 'all', stockSearch: '', siteSearch: '', siteSearchField: 'all', holdArchive: false, holdSearch: '', holdGroup: 'none' };
let _holdLinkSite = null;   // 현장 저장 시 이 홀딩을 현장에 '연결'(소진 아님)
let _holdConfirm = null;    // 출고 저장 시 이 홀딩을 '확정' 처리
let _busy = false;          // 등록 버튼 연속 클릭(중복 저장) 방지
function openStockTab(filter) { filters.stock = filter || 'all'; filters.stockSearch = ''; go('stock'); }

/* ---------- 2. 유틸 ---------- */
const $ = (s, r = document) => r.querySelector(s);
const el = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const won = n => (n || 0).toLocaleString('ko-KR');
const todayStr = () => new Date().toISOString().slice(0, 10);
function daysFromNow(d) { if (!d) return null; return Math.ceil((new Date(d + 'T00:00') - new Date(todayStr() + 'T00:00')) / 86400000); }
function initial(n) { return (n || '?').trim().slice(-2); }
function toast(msg) { const t = el('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 2200); }
function isAdmin() { return me && me.role === 'admin'; }

const STATUS = {
  접수: 'p-gray', 견적전달: 'p-wait', 결제완료: 'p-prog', 확정: 'p-prog',
  실측대기: 'p-wait', 발주완료: 'p-prog', 가공중: 'p-prog', 시공대기: 'p-wait',
  시공중: 'p-prog', 완료: 'p-done', 보류: 'p-issue', 이슈: 'p-issue'
};
function pill(s) { return `<span class="pill ${STATUS[s] || 'p-gray'}">${esc(s || '-')}</span>`; }

/* ---------- 3. 매뉴얼 기반 자동추천 ---------- */
// 시공·발주 시스템 매뉴얼 v3.0 규칙
const METRO = ['서울', '경기', '인천'];           // 수도권 판별(주소 앞부분)
const TOMAS_STOCK = ['로마 팬텀 아이보리', '카무스 화이트', '트라버티노 아이보리'];

function recommendTeam(o) {
  // o: { region, address, constructionDate, jang, volume, workType }
  const addr = (o.address || '') + (o.region || '');
  const metro = METRO.some(m => addr.includes(m));
  if (!metro) {
    if (addr.includes('대전')) return { team: '록스타일', why: '대전 지역 담당' };
    if (addr.includes('부산')) return { team: '프로세라믹', why: '부산 지역 담당' };
    if (addr.includes('광주') || addr.includes('전남')) return { team: '현대코리안', why: '광주·전남 지역 담당' };
    if (addr.includes('시흥') || addr.includes('인천')) return { team: '아트라인', why: '시흥·인천 지역 담당' };
    return { team: '지역팀 확인 필요', why: '비수도권 — 해당 지역 협력팀 확인' };
  }
  const dleft = daysFromNow(o.constructionDate);
  if (dleft != null && dleft <= 3) return { team: 'JS테크', why: '긴급 일정(시공까지 3일 이하)' };
  if (o.workType === '세면대단독') return { team: 'JS테크', why: '세면대 단독 시공' };
  if (o.workType === '현장가공많음') return { team: '모든대리석', why: '현장 재단·타공 등 작업량 많음' };
  if (o.jang > 2700) {
    if (o.volume === '대형') return { team: '모든대리석', why: '기장 2700 초과 · 대형 물량(3~4인 이상)' };
    return { team: 'JS테크', why: '기장 2700 초과 · 소형 물량' };
  }
  return { team: 'JS테크', why: '기본 배정(B/D 조건)' };
}
function recommendFactory(o) {
  // o: { dueDate, materialName, complex(졸리컷많음/유광), simpleTop }
  const dleft = daysFromNow(o.dueDate);
  if (dleft != null && dleft <= 2) {
    if (o.complex) return { factory: '거봉석재', why: '긴급 납기(2일 이하) — 단, 졸리컷 많음/유광이면 동호엠엔지 일정 먼저 확인' };
    return { factory: '거봉석재', why: '긴급 납기(2일 이하)' };
  }
  if (o.simpleTop) return { factory: '영진석재', why: '단순 상판(졸리컷 없는 식탁·주방 상판)' };
  if (TOMAS_STOCK.some(t => (o.materialName || '').includes(t))) return { factory: '토마스 마블', why: '토마스 재고 운영 자재' };
  if (o.materialName) return { factory: '동호엠엔지', why: '토마스 미운영 자재(3일 이상 납기)' };
  return { factory: '동호엠엔지', why: '기본 배정' };
}
// 견적 도우미 (일반소비자·도면 있음 기준)
function estimateQuote(o) {
  // o:{ hebe, jang, region, allMarble }
  const hebe = +o.hebe || 0, jang = +o.jang || 0;
  const gagong = jang * 500000;                 // 가공비 장당 50만
  const measure = 250000;                        // 실측 25만
  let construct = o.allMarble ? (jang * 400000 + 100000) : (hebe * 100000 + 250000); // 시공: 모든대리석=품당40만+10만 / 기본 헤베10만 + 여유25만
  const local = METRO.some(m => (o.region || '').includes(m)) ? 0 : 200000; // 지방 출장비(예시)
  const total = gagong + measure + construct + local;
  return { gagong, measure, construct, local, total };
}

/* ---------- 4. 초기 구동 ---------- */
window.addEventListener('DOMContentLoaded', init);
let _subscribed = false;
function startSubscriptions() {
  if (_subscribed) return; _subscribed = true;
  COLLS.forEach(c => Store.watch(c, data => { state[c] = data; onData(c); }));
}
function init() {
  if (!CLOUD) {
    // 미리보기(로컬) 모드: 인증 없이 이 기기에서만 동작
    el('sync').classList.add('local'); el('sync-t').textContent = '미리보기';
    startSubscriptions();
    seedIfEmpty();
    prefillEmail();
    return;
  }
  // 클라우드 모드: Firebase 인증으로 보호 — 로그인해야만 데이터에 접근 가능
  auth.onAuthStateChanged(async (user) => {
    if (user) {
      startSubscriptions();
      await afterAuth(user);
    } else {
      me = null;
      el('app').style.display = 'none';
      el('login').style.display = 'flex';
      const e = el('login-err'); if (e) { e.style.color = ''; e.textContent = ''; }
      prefillEmail();
    }
  });
}
/* 로그인 성공 후: 직원 디렉터리에서 본인(이메일) 찾기 → 앱 진입 */
async function afterAuth(user) {
  seedIfEmpty();                 // 규격/공장/팀 등 기본값(백그라운드)
  await whenMembersReady();       // 직원 목록 첫 로딩 대기
  let member = findMemberByEmail(user.email);
  if (!member) {
    // 이메일이 연결된 직원이 한 명도 없으면, 첫 로그인자를 관리자로 부트스트랩
    const anyLinked = state.members.some(m => m.email);
    const role = anyLinked ? 'staff' : 'admin';
    const name = (user.email || '사용자').split('@')[0];
    member = { name, email: (user.email || '').toLowerCase(), role };
    await Store.add('members', member);
  }
  me = member;
  el('login').style.display = 'none';
  el('app').style.display = 'block';
  el('me-av').textContent = initial(me.name);
  el('me-nm').textContent = me.name;
  render();
  refreshPushToken();
}
function findMemberByEmail(email) {
  if (!email) return null;
  const e = email.toLowerCase();
  return state.members.find(m => (m.email || '').toLowerCase() === e) || null;
}
let _membersLoaded = false, _membersWaiters = [];
function whenMembersReady() {
  return new Promise(res => { if (_membersLoaded) res(); else _membersWaiters.push(res); });
}
let _seeded = false;
async function seedIfEmpty() {
  setTimeout(async () => {
    if (_seeded) return; _seeded = true;
    // 미리보기(로컬) 모드에서만 기본 관리자 생성. 클라우드는 첫 로그인 시 자동 부트스트랩.
    if (!CLOUD && state.members.length === 0) {
      await Store.add('members', { name: '관리자', role: 'admin', email: 'admin@local' });
    }
    // 규격(언더바 선택용) 기본값 — 비어있으면 한 번만 추가
    if (state.specs.length === 0) {
      for (const val of ['1600*3200*12', '1600*3200*20', '1200*2700*6', '1200*2700*9', '600*1200*9']) {
        await Store.add('specs', { value: val });
      }
    }
    // 가공 공장 기본값 (시공·발주 매뉴얼 기준)
    if (state.factories.length === 0) {
      for (const val of ['거봉석재', '동호엠엔지', '토마스마블', '영진석재']) await Store.add('factories', { value: val });
    }
    // 시공팀 기본값
    if (state.teams.length === 0) {
      for (const val of ['JS테크', '모든대리석', '록스타일', '프로세라믹', '현대코리안', '아트라인']) await Store.add('teams', { value: val });
    }
    // 입고 발주처(매입처) 기본값 — 다우세라믹앤석재(중국 직발주)가 기본
    if (state.suppliers.length === 0) {
      for (const val of ['다우세라믹앤석재', '거봉석재', '토마스마블', '동호엠엔지', '영진석재']) await Store.add('suppliers', { value: val });
    }
    // 미리보기(로컬) 모드에서 비어있으면 샘플 데이터로 채워 '살아있는' 화면 제공
    if (!CLOUD && state.inventory.length === 0) await seedSample();
  }, CLOUD ? 1200 : 250);
}
async function seedSample() {
  if (state.members.length <= 1) {
    await Store.add('members', { name: '김민준', role: 'staff', pin: '1234' });
    await Store.add('members', { name: '이수진', role: 'staff', pin: '1234' });
  }
  // 품목: 규격(가로*세로*두께) → 장당 헤베 자동
  const items = [
    { name: '로마 팬텀 아이보리', spec: '1600*3200*20', vendor: '토마스마블', jang: 86, safeJang: 20, depot: '본사' },
    { name: '카무스 화이트', spec: '1600*3200*20', vendor: '토마스마블', jang: 4, safeJang: 12, depot: '본사' },
    { name: '트라버티노 아이보리', spec: '1600*3200*12', vendor: '토마스마블', jang: 33, safeJang: 15, depot: '본사' },
    { name: '비앙코 카라라', spec: '1200*2700*9', vendor: '동호엠엔지', jang: 2, safeJang: 8, depot: '제2창고' },
    { name: '포세린 그레이', spec: '600*1200*9', vendor: '거봉석재', jang: 140, safeJang: 40, depot: '본사' }
  ];
  for (const it of items) { it.hebePerJang = parseSpec(it.spec).hebePerJang; await Store.add('inventory', it); }
  // 현장
  await Store.add('sites', { name: '반포 자이 49평', client: '한샘인테리어', region: '서울 서초구', address: '반포동 18-1', manager: '김민준', orderType: '실측', stage: '발주', materialName: '카무스 화이트', qty: '14', unit: '장', measureDate: '2026-05-20', constructDate: '2026-06-02', factory: '거봉석재', team: 'JS테크', quoteAmount: '8200000', paid: true, confirmed: true, note: '주방+현관 상판', history: { '접수': '2026-05-12', '가견적': '2026-05-13', '실측': '2026-05-20', '견적': '2026-05-22', '결제': '2026-05-24', '발주': '2026-05-28' } });
  await Store.add('sites', { name: '대전 둔산 상가', client: '대전리모델링', region: '대전 서구', address: '둔산동 992', manager: '이수진', orderType: '도면', stage: '견적', materialName: '포세린 그레이', qty: '10', unit: '장', constructDate: '2026-06-09', factory: '영진석재', team: '록스타일', preQuote: '약 320만', note: '도면 발주(실측 없음)', history: { '접수': '2026-05-25', '가견적': '2026-05-26', '견적': '2026-05-29' } });
  await Store.add('sites', { name: '판교 카페', client: '미드센추리', region: '경기 성남 분당구', address: '판교로 234', manager: '김민준', orderType: '실측', stage: '실측', materialName: '비앙코 카라라', qty: '6', unit: '장', measureDate: '2026-05-27', constructDate: '2026-06-15', factory: '동호엠엔지', team: '모든대리석', note: '치수 재확인 필요', history: { '접수': '2026-05-23', '가견적': '2026-05-24', '실측': '2026-05-27' } });
  // 홀딩
  await Store.add('holdings', { vendor: '모든대리석', materialName: '카무스 화이트', jang: 12, hebe: 61.44, useDate: '2026-06-02', status: '홀딩', note: '반포 현장 예정' });
  await Store.add('holdings', { vendor: '거봉석재', materialName: '로마 팬텀 아이보리', jang: 8, hebe: 40.96, useDate: '2026-06-10', status: '홀딩' });
  // 출고 내역(월별/분석용)
  const outs = [
    { itemName: '로마 팬텀 아이보리', jang: 6, target: '현장', targetName: '강남 주택', date: '2026-03-12' },
    { itemName: '카무스 화이트', jang: 4, target: '현장', targetName: '반포 자이', date: '2026-04-18' },
    { itemName: '포세린 그레이', jang: 10, target: '공장', targetName: '영진석재', date: '2026-04-25' },
    { itemName: '트라버티노 아이보리', jang: 5, target: '거래처', targetName: '○○석재', date: '2026-05-08' },
    { itemName: '로마 팬텀 아이보리', jang: 8, target: '현장', targetName: '용인 상가', date: '2026-05-20' },
    { itemName: '카무스 화이트', jang: 3, target: '현장', targetName: '반포 자이', date: '2026-05-28' }
  ];
  for (const o of outs) { o.type = 'out'; o.hebe = +(o.jang * 5.12).toFixed(2); o.by = '김민준'; await Store.add('transactions', o); }
}
function onData(coll) {
  if (coll === 'members' && !_membersLoaded) {
    _membersLoaded = true;
    _membersWaiters.splice(0).forEach(fn => fn());
  }
  if (coll === 'sites' && me) autoAdvanceStages();
  if (coll === 'holdings' && me) autoReleaseHolds();
  if (me) render();
}

/* ---------- 5. 로그인 (이메일 + 비밀번호 / Firebase 인증) ---------- */
async function doLogin() {
  const email = (el('lg-email').value || '').trim();
  const pw = el('lg-pw').value || '';
  const err = el('login-err'); err.style.color = '';
  if (!email || !pw) { err.textContent = '이메일과 비밀번호를 입력하세요.'; return; }
  err.textContent = '';
  // 이메일 저장 옵션 처리
  try {
    if (el('lg-remember') && el('lg-remember').checked) localStorage.setItem('dws_email', email);
    else localStorage.removeItem('dws_email');
  } catch (e) { }
  if (!CLOUD) {
    // 미리보기 모드: 인증 없이 로컬 관리자
    me = state.members.find(m => m.role === 'admin') || state.members[0] || { name: '관리자', role: 'admin' };
    el('login').style.display = 'none'; el('app').style.display = 'block';
    el('me-av').textContent = initial(me.name); el('me-nm').textContent = me.name; render();
    return;
  }
  try {
    await auth.signInWithEmailAndPassword(email, pw);
    // 성공 시 onAuthStateChanged → afterAuth 에서 화면 전환
  } catch (e) {
    err.textContent = authErrMsg(e);
  }
}
function authErrMsg(e) {
  const c = (e && e.code) || '';
  if (c === 'auth/invalid-email') return '이메일 형식이 올바르지 않습니다.';
  if (c === 'auth/user-disabled') return '정지된 계정입니다. 관리자에게 문의하세요.';
  if (c === 'auth/user-not-found' || c === 'auth/wrong-password' || c === 'auth/invalid-credential' || c === 'auth/invalid-login-credentials')
    return '이메일 또는 비밀번호가 올바르지 않습니다.';
  if (c === 'auth/too-many-requests') return '시도가 너무 많습니다. 잠시 후 다시 시도하세요.';
  if (c === 'auth/network-request-failed') return '네트워크 연결을 확인하세요.';
  return '로그인 실패: ' + ((e && e.message) || c);
}
async function resetPw() {
  const email = (el('lg-email').value || '').trim();
  const err = el('login-err'); err.style.color = '';
  if (!email) { err.textContent = '재설정할 이메일을 위 칸에 입력한 뒤 눌러주세요.'; return; }
  if (!CLOUD) { err.textContent = '미리보기 모드에서는 사용할 수 없습니다.'; return; }
  try {
    await auth.sendPasswordResetEmail(email);
    err.style.color = 'var(--gd)';
    err.textContent = '재설정 메일을 보냈습니다. 메일함을 확인하세요.';
  } catch (e) { err.style.color = ''; err.textContent = authErrMsg(e); }
}
function logout() {
  if (CLOUD && auth) { auth.signOut().then(() => location.reload()).catch(() => location.reload()); }
  else { me = null; location.reload(); }
}

/* ---------- 푸시 알림 (FCM) ---------- */
const VAPID_KEY = 'BCr1tMNMANE8G8njYgfcoSzJqaRoSE-aG1pesn7mGb2SwBhxpZFWcI4cxwR06GjurPitv2JSNTXpeQfSFm8yEYM';
const PUSH_FN = 'https://dawoopushfn-297532467454.europe-west1.run.app';
/* 재고 0 → 전 직원 즉시 푸시 (Cloud Function 호출) */
async function notifyStockOut(name) {
  try {
    if (!CLOUD || !auth || !auth.currentUser || !name) return;
    const token = await auth.currentUser.getIdToken();
    await fetch(PUSH_FN + '?action=stockout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ name: name })
    });
  } catch (e) { }
}
let _pushReg = null, _pushMsg = null, _onMsgBound = false;
function pushSupported() {
  return CLOUD && ('serviceWorker' in navigator) && ('Notification' in window) && typeof firebase !== 'undefined' && !!firebase.messaging;
}
function pushStatus() {
  if (!('Notification' in window) || !pushSupported()) return 'unsupported';
  return Notification.permission; // default | granted | denied
}
async function _saveToken(token) {
  const id = token.replace(/[\/#?]/g, '_').slice(0, 1400);
  await cref('pushTokens').doc(id).set({ token, name: me ? me.name : '', email: me ? me.email : '', ua: navigator.userAgent, updatedAt: Date.now() });
}
function bindForegroundPush() {
  if (_onMsgBound || !_pushMsg) return; _onMsgBound = true;
  _pushMsg.onMessage(payload => {
    const d = (payload && payload.data) || (payload && payload.notification) || {};
    toast('🔔 ' + (d.title || '알림') + (d.body ? ' · ' + d.body : ''));
    try { if (Notification.permission === 'granted' && _pushReg) _pushReg.showNotification(d.title || '다우세라믹앤석재', { body: d.body || '', icon: 'icon-192.png' }); } catch (e) { }
  });
}
async function enablePush() {
  if (!pushSupported()) { toast('이 기기/브라우저는 알림을 지원하지 않습니다 (아이폰은 홈 화면에 추가 후 사용)'); return; }
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('알림 권한이 허용되지 않았습니다'); return; }
    const reg = await navigator.serviceWorker.register('firebase-messaging-sw.js');
    _pushReg = reg; await navigator.serviceWorker.ready;
    _pushMsg = firebase.messaging();
    const token = await _pushMsg.getToken({ vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
    if (!token) { toast('알림 토큰 발급 실패 — 다시 시도'); return; }
    await _saveToken(token);
    bindForegroundPush();
    toast('이 기기에서 알림을 받습니다 ✓');
    if (tab === 'settings') renderSettings();
  } catch (e) { toast('알림 설정 실패: ' + (e && (e.message || e.code) || '')); }
}
/* 이미 허용된 기기는 로그인 후 토큰 자동 갱신·저장 */
async function refreshPushToken() {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.register('firebase-messaging-sw.js');
    _pushReg = reg; await navigator.serviceWorker.ready;
    _pushMsg = firebase.messaging();
    const token = await _pushMsg.getToken({ vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
    if (token) await _saveToken(token);
    bindForegroundPush();
  } catch (e) { }
}

/* ---------- 6. 네비게이션 ---------- */
/* ---------- 햄버거 드로어 ---------- */
function toggleDrawer() {
  const d = el('drawer');
  if (d.classList.contains('open')) closeDrawer();
  else {
    if (me) { el('dw-name').textContent = me.name; el('dw-role').textContent = isAdmin() ? '관리자' : '직원'; }
    document.querySelectorAll('.drawer-i[data-tab]').forEach(n => n.classList.toggle('active', n.dataset.tab === tab));
    d.classList.add('open'); el('drawer-ov').classList.add('open');
  }
}
function closeDrawer() { el('drawer').classList.remove('open'); el('drawer-ov').classList.remove('open'); }
function goD(t) { closeDrawer(); go(t); }

function go(t) {
  tab = t;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-i').forEach(n => n.classList.toggle('active', n.dataset.tab === t));
  document.querySelectorAll('.drawer-i[data-tab]').forEach(n => n.classList.toggle('active', n.dataset.tab === t));
  el('pg-' + t).classList.add('active');
  el('fab').style.display = (t === 'sites' || t === 'stock' || t === 'hold') ? 'flex' : 'none';
  render();
  window.scrollTo(0, 0);
}
function fabAction() {
  if (tab === 'sites') openSiteForm();
  else if (tab === 'stock') openStockForm();
  else if (tab === 'ship') openShipForm();
  else if (tab === 'hold') openHoldForm();
}
function render() {
  if (!me) return;
  if (tab === 'home') renderHome();
  else if (tab === 'sites') renderSites();
  else if (tab === 'stock') renderStock();
  else if (tab === 'ship') renderShip();
  else if (tab === 'hold') renderHold();
  else if (tab === 'settings') renderSettings();
}

/* ===================================================================
   화면 렌더링
   =================================================================== */

/* 현장 진행 단계 정의 (날짜 타임라인) */
const SITE_STAGES = ['접수', '가견적', '실측', '견적', '결제', '발주', '시공', '완료'];
function siteStageIndex(s) { return Math.max(0, SITE_STAGES.indexOf(s.stage || '접수')); }

/* 규격 파싱: "1600*3200*12" → {w,h,t,hebePerJang}.  장당 헤베 = 가로(m)×세로(m) */
function parseSpec(s) {
  if (!s) return { w: 0, h: 0, t: 0, hebePerJang: 0 };
  const n = String(s).split(/[*xX×]/).map(x => parseFloat(x) || 0);
  const w = n[0] || 0, h = n[1] || 0, t = n[2] || 0;
  return { w, h, t, hebePerJang: +((w * h) / 1e6).toFixed(3) };
}
/* 장당 헤베(㎡/장) 자동환산: 장수 × 장당헤베 = 헤베 */
function itemHebe(it) { return +(((+it.jang || 0) * (+it.hebePerJang || 0)).toFixed(2)); }
function jangToHebe(jang, it) { return +(((+jang || 0) * (+(it && it.hebePerJang) || 0)).toFixed(2)); }
/* 규격 select 옵션 (언더바) */
function specOptions(sel) {
  return '<option value="">규격 선택…</option>' +
    state.specs.slice().sort((a, b) => (a.value || '').localeCompare(b.value || '')).map(sp =>
      `<option value="${esc(sp.value)}" ${sel === sp.value ? 'selected' : ''}>${esc(sp.value)}</option>`).join('') +
    '<option value="__add">+ 새 규격 추가…</option>';
}
async function addSpecValue(val) {
  val = (val || '').trim().replace(/\s+/g, '');
  if (!/^\d+[*xX×]\d+([*xX×]\d+)?$/.test(val)) { toast('형식: 가로*세로*두께 (예 1600*3200*12)'); return null; }
  val = val.replace(/[xX×]/g, '*');
  if (!state.specs.some(s => s.value === val)) await Store.add('specs', { value: val });
  return val;
}
/* 공장/시공팀 등 마스터 select 옵션 (언더바 + 새 항목 추가) */
function masterOptions(coll, sel) {
  return '<option value="">선택…</option>' +
    state[coll].slice().sort((a, b) => (a.value || '').localeCompare(b.value || '')).map(m =>
      `<option value="${esc(m.value)}" ${sel === m.value ? 'selected' : ''}>${esc(m.value)}</option>`).join('') +
    '<option value="__add">+ 새 항목 추가…</option>';
}
function onMasterChange(selId, coll) {
  const sel = el(selId), box = el(selId + '-add');
  if (sel.value === '__add') { if (box) box.classList.remove('hidden'); setTimeout(() => el(selId + '-new') && el(selId + '-new').focus(), 50); }
  else if (box) box.classList.add('hidden');
}
async function commitMaster(selId, coll) {
  const val = (el(selId + '-new').value || '').trim();
  if (!val) { toast('이름을 입력하세요'); return; }
  if (!state[coll].some(m => m.value === val)) await Store.add(coll, { value: val });
  el(selId).innerHTML = masterOptions(coll, val);
  el(selId + '-add').classList.add('hidden');
  toast('추가됨: ' + val);
}
/* select에 값 세팅(없으면 옵션 추가) — 자동추천 적용용 */
function setSelectValue(selId, coll, val) {
  if (!val) return;
  const sel = el(selId); if (!sel) return;
  if (![...sel.options].some(o => o.value === val)) {
    const o = document.createElement('option'); o.value = val; o.textContent = val;
    sel.insertBefore(o, sel.options[sel.options.length - 1]);
  }
  sel.value = val;
}
/* 홀딩의 자재 목록 (다자재 지원, 구버전 단일자재 호환) */
function holdItems(h) {
  if (h && h.items && h.items.length) return h.items.map(x => ({ materialName: x.materialName || x.name || '', jang: +x.jang || +x.qty || 0, hebe: +x.hebe || 0, lot: x.lot || '', pattern: x.pattern || '' }));
  return [{ materialName: (h && h.materialName) || '', jang: +(h && h.jang) || 0, hebe: +(h && h.hebe) || 0, lot: (h && h.lot) || '', pattern: (h && h.pattern) || '' }];
}
/* 현장의 자재 목록 (다자재 지원, 구버전 호환) */
function siteItems(s) {
  if (s && s.items && s.items.length) return s.items.map(x => ({ name: x.name || x.materialName || '', qty: x.qty != null ? x.qty : (x.jang || ''), lot: x.lot || '' }));
  return (s && s.materialName) ? [{ name: s.materialName, qty: s.qty || '', lot: s.lot || '' }] : [];
}
/* 활성 홀딩(예약 중 '홀딩')으로 잡힌 장수 합계 — 자재명 기준(다자재 합산) */
function heldJangFor(name) {
  if (!name) return 0; const key = _normName(name); let s = 0;
  state.holdings.forEach(h => { if ((h.status || '홀딩') !== '홀딩') return; holdItems(h).forEach(it => { if (_normName(it.materialName) === key) s += (+it.jang || 0); }); });
  return s;
}
/* 가용재고 = 실재고 − 활성홀딩 */
function availJang(it) { return (+it.jang || 0) - heldJangFor(it.name); }
/* 롯트별 재고: 입고(+) − 출고(−). 자재명 기준(띄어쓰기 무시). 롯트 미입력은 '(미지정)' */
function lotStock(name) {
  if (!name) return [];
  const key = _normName(name); const m = {};
  state.transactions.forEach(t => {
    if (_normName(t.itemName) !== key) return;
    const lot = (t.lot || '').trim() || '(미지정)';
    if (!m[lot]) m[lot] = { lot, inQty: 0, outQty: 0 };
    if (t.type === 'in') m[lot].inQty += (+t.jang || 0);
    else if (t.type === 'out') m[lot].outQty += (+t.jang || 0);
  });
  return Object.values(m).map(x => ({ lot: x.lot, inQty: x.inQty, outQty: x.outQty, remain: x.inQty - x.outQty }))
    .filter(x => x.inQty > 0 || x.remain !== 0)
    .sort((a, b) => b.remain - a.remain);
}
/* 폼용 롯트 select 옵션(잔여 있는 실제 롯트만) */
function lotSelectHtml(name, current) {
  const lots = lotStock(name).filter(l => l.lot !== '(미지정)' && l.remain > 0);
  let html = '<option value="">롯트 선택 (선택사항)</option>';
  lots.forEach(l => { html += `<option value="${esc(l.lot)}" ${current === l.lot ? 'selected' : ''}>${esc(l.lot)} · 잔여 ${l.remain}장</option>`; });
  if (current && !lots.some(l => l.lot === current)) html += `<option value="${esc(current)}" selected>${esc(current)}</option>`;
  return html;
}
function lotBreakdownText(name) {
  const lots = lotStock(name);
  if (!lots.length) return '';
  return '롯트별 잔여: ' + lots.map(l => `${esc(l.lot)} <b style="color:${l.remain <= 0 ? 'var(--t3)' : 'var(--gd)'}">${l.remain}장</b>`).join(' · ');
}
/* 자재별 패턴 목록: 입고 기록의 patterns 에서 수집 */
function patternList(name) {
  if (!name) return []; const key = _normName(name); const m = {};
  state.transactions.forEach(t => {
    if (t.type !== 'in' || _normName(t.itemName) !== key) return;
    (t.patterns || []).forEach(p => { const nm = (p.pattern || '').trim(); if (!nm || nm === '-') return; m[nm] = (m[nm] || 0) + (+p.jang || 0); });
  });
  return Object.keys(m).map(k => ({ pattern: k, qty: m[k] })).sort((a, b) => b.qty - a.qty);
}
function patternSelectHtml(name, current) {
  const ps = patternList(name);
  let html = '<option value="">패턴 선택 (선택)</option>';
  ps.forEach(p => { html += `<option value="${esc(p.pattern)}" ${current === p.pattern ? 'selected' : ''}>${esc(p.pattern)} · ${p.qty}장</option>`; });
  if (current && !ps.some(p => p.pattern === current)) html += `<option value="${esc(current)}" selected>${esc(current)}</option>`;
  return html;
}
/* 재고 부족 판정 (가용재고 기준 안전재고) */
function stockState(it) {
  const avail = availJang(it), safe = +it.safeJang || 0;
  if (avail <= 0) return { k: '없음', cls: 'p-issue' };
  if (safe > 0 && avail < safe) return { k: '부족', cls: 'p-issue' };
  if (safe > 0 && avail < safe * 1.5) return { k: '임박', cls: 'p-wait' };
  return { k: '정상', cls: 'p-prog' };
}
/* 입고 후: 예정홀딩을 검사해 '자재가 전부 가용 범위에 들면' 오래된 순으로 자동 활성화(다자재) */
async function activatePlannedHolds(name, physJang) {
  const planned = state.holdings.filter(h => h.status === '예정')
    .sort((a, b) => (a.useDate || '9999').localeCompare(b.useDate || '9999') || (a.createdAt || 0) - (b.createdAt || 0));
  if (!planned.length) return 0;
  const extra = {};
  function physOf(mat) {
    if (name && _normName(mat) === _normName(name) && physJang != null) return physJang;
    const it = state.inventory.find(i => _normName(i.name) === _normName(mat)); return it ? +it.jang || 0 : 0;
  }
  function availOf(mat) { return physOf(mat) - heldJangFor(mat) - (extra[_normName(mat)] || 0); }
  let count = 0;
  for (const h of planned) {
    const items = holdItems(h);
    const fits = items.length && items.every(it => availOf(it.materialName) >= (+it.jang || 0));
    if (fits) {
      await Store.update('holdings', h.id, { status: '홀딩' });
      items.forEach(it => { const k = _normName(it.materialName); extra[k] = (extra[k] || 0) + (+it.jang || 0); });
      count++;
    }
  }
  return count;
}
/* ===== 자재 여러 줄 입력 컴포넌트 (현장/홀딩 공용) ===== */
let _mrowN = 0, _mrowPattern = false;   // _mrowPattern: 홀딩 폼에서 true → 패턴 선택칸 표시
function matRowHtml(d, qtyPh) {
  d = d || {}; const i = _mrowN++; const nm = d.name || d.materialName || '';
  const selStyle = 'width:100%;margin-top:6px;font-size:14px;padding:8px;border:1.5px solid var(--bd2);border-radius:9px';
  return `<div class="mrow" style="margin-bottom:8px;border:1px solid var(--bd2);border-radius:10px;padding:8px 9px">
    <div style="display:flex;gap:6px;align-items:center">
      <div style="flex:2.2">${searchBox('mrow-' + i, '자재명 검색·입력', nm, 'matNames', 'mrowLotRefresh')}</div>
      <input class="m-qty" style="flex:1;min-width:54px;font-size:16px;padding:9px 8px;border:1.5px solid var(--bd2);border-radius:9px" inputmode="decimal" placeholder="${qtyPh || '수량'}" value="${esc(d.qty || d.jang || '')}" oninput="mrowLotRefresh()">
      <button type="button" class="btn btn-ghost btn-sm" onclick="this.closest('.mrow').remove()" aria-label="삭제"><i class="ti ti-x"></i></button>
    </div>
    <select class="m-lot" style="${selStyle}">${lotSelectHtml(nm, d.lot || '')}</select>
    ${_mrowPattern ? `<select class="m-pattern" style="${selStyle}">${patternSelectHtml(nm, d.pattern || '')}</select>` : ''}
    <div class="m-info" style="font-size:11px;color:var(--t3);margin-top:4px"></div>
  </div>`;
}
function matRowsHtml(items, qtyPh) {
  const arr = (items && items.length) ? items : [{}];
  return `<div id="mat-rows">${arr.map(it => matRowHtml(it, qtyPh)).join('')}</div>
    <button type="button" class="btn btn-ghost btn-sm" style="margin-bottom:4px" onclick="addMaterialRow({}, '${qtyPh || '수량'}')"><i class="ti ti-plus"></i>자재 추가</button>`;
}
function addMaterialRow(d, qtyPh) {
  const box = el('mat-rows'); if (!box) return;
  box.insertAdjacentHTML('beforeend', matRowHtml(d, qtyPh)); mrowLotRefresh();
}
function mrowLotRefresh() {
  document.querySelectorAll('#mat-rows .mrow').forEach(row => {
    const inp = row.querySelector('input.sb-in'); if (!inp) return;
    const mat = (inp.value || '').trim();
    const lotSel = row.querySelector('select.m-lot');
    if (lotSel) { const cur = lotSel.value; lotSel.innerHTML = lotSelectHtml(mat, cur); }
    const patSel = row.querySelector('select.m-pattern');
    if (patSel) { const cur = patSel.value; patSel.innerHTML = patternSelectHtml(mat, cur); }
    const info = row.querySelector('.m-info');
    if (info) {
      const it = state.inventory.find(x => x.name === mat); const q = parseFloat(row.querySelector('.m-qty').value) || 0;
      info.innerHTML = it ? ('가용 <b style="color:' + (availJang(it) <= 0 ? 'var(--red-t)' : 'var(--gd)') + '">' + availJang(it) + '장</b> / 실재고 ' + (+it.jang || 0) + '장' + (q > 0 ? ' · 헤베 ' + (q * (+it.hebePerJang || 0)).toFixed(2) + '㎡' : '')) : (mat ? '<span style="color:var(--amber-t)">재고에 없는 자재 (입고 시 자동 전환)</span>' : '');
    }
  });
}
function collectMaterialRows() {
  const rows = [];
  document.querySelectorAll('#mat-rows .mrow').forEach(row => {
    const inp = row.querySelector('input.sb-in'); const name = inp ? (inp.value || '').trim() : '';
    const qty = parseFloat(row.querySelector('.m-qty').value) || 0;
    const lot = (row.querySelector('select.m-lot').value || '').trim();
    const patSel = row.querySelector('select.m-pattern');
    const pattern = patSel ? (patSel.value || '').trim() : '';
    if (name && qty > 0) rows.push({ name: name, qty: qty, lot: lot, pattern: pattern });
  });
  return rows;
}
/* 발주 + 시공일 도래 → 자동 '시공' 전환 */
let _autoStageRun = false;
async function autoAdvanceStages() {
  if (_autoStageRun) return;
  const due = state.sites.filter(s => s.stage === '발주' && s.constructDate && daysFromNow(s.constructDate) <= 0);
  if (!due.length) return;
  _autoStageRun = true;
  for (const s of due) {
    const hist = Object.assign({}, s.history || {}); if (!hist['시공']) hist['시공'] = todayStr();
    try { await Store.update('sites', s.id, { stage: '시공', history: hist }); } catch (e) { }
  }
  setTimeout(() => { _autoStageRun = false; }, 5000);
}
/* 사용예정일 지난 홀딩 → 자동 '해제'(삭제 아님, 지난·해제 내역으로 이동) */
let _autoRelRun = false;
async function autoReleaseHolds() {
  if (_autoRelRun) return;
  const due = state.holdings.filter(h => (h.status === '홀딩' || h.status === '예정') && h.useDate && daysFromNow(h.useDate) < 0);
  if (!due.length) return;
  _autoRelRun = true;
  for (const h of due) {
    try { await Store.update('holdings', h.id, { status: '해제', releasedAuto: true, releasedDate: todayStr() }); } catch (e) { }
  }
  setTimeout(() => { _autoRelRun = false; }, 5000);
}
/* 활성 홀딩 목록 (현장/출고에서 골라쓰기용) */
function activeHoldings() { return state.holdings.filter(h => (h.status || '홀딩') === '홀딩'); }
function holdingOptions() {
  const list = activeHoldings();
  if (!list.length) return '';
  return list.sort((a, b) => (a.useDate || '').localeCompare(b.useDate || '')).map(h =>
    `<option value="${esc(h.id)}">${esc(h.vendor || '')} · ${esc(h.materialName || '')} · ${+h.jang || 0}장${h.useDate ? ' · ' + esc(h.useDate) : ''}</option>`).join('');
}
/* 현장 목록 옵션 (홀딩에서 골라쓰기용) */
function siteOptions(sel) {
  return state.sites.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map(s =>
    `<option value="${esc(s.id)}" ${sel === s.id ? 'selected' : ''}>${esc(s.name || '(이름없음)')}${s.client ? ' · ' + esc(s.client) : ''}${s.materialName ? ' · ' + esc(s.materialName) : ''}${s.constructDate ? ' · 시공 ' + esc(s.constructDate) : ''}</option>`).join('');
}
/* 등록된 품목 select 옵션 */
function itemOptions(sel) {
  return '<option value="">자재 선택…</option>' + state.inventory.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    .map(i => `<option value="${esc(i.id)}" ${sel === i.id ? 'selected' : ''}>${esc(i.name)} (${esc(i.spec || '')} · 재고 ${+i.jang || 0}장)</option>`).join('');
}

/* ---------- 홈 ---------- */
function renderHome() {
  const lowItems = state.inventory.filter(i => { const s = stockState(i).k; return s === '부족' || s === '없음'; });
  const activeSites = state.sites.filter(s => s.stage !== '완료');
  const soonConstruct = state.sites.filter(s => { const d = daysFromNow(s.constructDate); return s.stage !== '완료' && d != null && d >= 0 && d <= 3; });
  const soonHold = state.holdings.filter(h => { const d = daysFromNow(h.useDate); return (h.status || '홀딩') === '홀딩' && d != null && d >= 0 && d <= 3; });
  const plannedHolds = state.holdings.filter(h => h.status === '예정');
  const waitQuote = state.sites.filter(s => ['접수', '가견적', '견적'].includes(s.stage));

  const openIssues = state.issues.filter(i => i.status !== '처리완료');
  const alerts = [];
  lowItems.forEach(i => alerts.push({ c: 'r', ic: 'ti-alert-triangle', t: `${i.name} 입고 필요`, s: `가용 ${availJang(i)}장 · 안전재고 ${(+i.safeJang || 0)}장 미만`, tag: '재고부족' }));
  openIssues.forEach(i => alerts.push({ c: 'r', ic: 'ti-alert-triangle', t: `${i.siteName || '현장'} 이슈 미해결`, s: (i.reason || '').slice(0, 40), tag: '이슈' }));
  plannedHolds.forEach(h => alerts.push({ c: 'a', ic: 'ti-clock-pause', t: `${h.materialName || '-'} 입고 대기`, s: `${h.vendor || ''} · ${(+h.jang || 0)}장 예약(예정홀딩) · 입고 시 자동 전환`, tag: '예정홀딩' }));
  soonConstruct.forEach(s => alerts.push({ c: 'a', ic: 'ti-tools', t: `${s.name} 시공 임박`, s: `${s.constructDate} 시공 예정 · ${s.team || '시공팀 미정'}`, tag: 'D-' + daysFromNow(s.constructDate) }));
  soonHold.forEach(h => alerts.push({ c: 'b', ic: 'ti-lock', t: `${h.vendor} 홀딩 사용 임박`, s: `${h.materialName} ${(+h.hebe || 0).toFixed(1)}㎡ · ${h.useDate} 사용`, tag: '홀딩' }));
  waitQuote.forEach(s => alerts.push({ c: 'a', ic: 'ti-file-invoice', t: `${s.name} 견적 진행 필요`, s: `현재 단계: ${s.stage} · ${s.client || ''}`, tag: s.stage }));

  el('pg-home').innerHTML = `
    <div class="ph"><div><h2><i class="ti ti-layout-dashboard"></i>주요 현황</h2><p>${new Date().toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' })} 기준 · 실시간 공유</p></div></div>
    <div class="stat-grid">
      <button class="stat tap" onclick="openStockTab('all')"><div class="ic g"><i class="ti ti-packages"></i></div><div class="v">${state.inventory.length}</div><div class="l">재고 품종 <i class="ti ti-chevron-right tap-arrow"></i></div><div class="s">실재고 ${state.inventory.reduce((a, b) => a + (+b.jang || 0), 0)}장 · 가용 ${state.inventory.reduce((a, b) => a + availJang(b), 0)}장</div></button>
      <button class="stat tap" onclick="openStockTab('low')"><div class="ic r"><i class="ti ti-alert-triangle"></i></div><div class="v" style="color:${lowItems.length ? 'var(--red-t)' : 'inherit'}">${lowItems.length}</div><div class="l">재고 부족 <i class="ti ti-chevron-right tap-arrow"></i></div><div class="s">${lowItems.length ? '입고 필요' : '정상 운영'}</div></button>
      <button class="stat tap" onclick="filters.sites='all';go('sites')"><div class="ic b"><i class="ti ti-building-community"></i></div><div class="v">${activeSites.length}</div><div class="l">진행 현장 <i class="ti ti-chevron-right tap-arrow"></i></div><div class="s">시공임박 ${soonConstruct.length}</div></button>
      <button class="stat tap" onclick="go('hold')"><div class="ic a"><i class="ti ti-lock"></i></div><div class="v">${state.holdings.filter(h => (h.status || '홀딩') === '홀딩').length}</div><div class="l">홀딩 건수 <i class="ti ti-chevron-right tap-arrow"></i></div><div class="s">임박 ${soonHold.length} · 예정 ${plannedHolds.length}</div></button>
    </div>

    <div class="card">
      <div class="card-h"><h3><i class="ti ti-bell-ringing"></i>긴급 알림</h3><span class="more">${alerts.length}건</span></div>
      ${alerts.length ? alerts.slice(0, 8).map(a => `
        <div class="alert-i ${a.c}">
          <div class="ai"><i class="ti ${a.ic}"></i></div>
          <div class="at"><b>${esc(a.t)}</b><span>${esc(a.s)}</span></div>
          <span class="tag">${esc(a.tag)}</span>
        </div>`).join('') : `<div class="empty"><i class="ti ti-circle-check"></i>처리할 긴급 항목이 없습니다</div>`}
    </div>

    <div class="card">
      <div class="card-h"><h3><i class="ti ti-bolt"></i>빠른 작업</h3></div>
      <div class="qa-grid">
        <button class="qa" onclick="go('stock');setTimeout(openStockForm,50)"><span class="qi ic g"><i class="ti ti-login"></i></span><span><b>입고 등록</b><small>자재 입고</small></span></button>
        <button class="qa" onclick="go('ship');setTimeout(openShipForm,50)"><span class="qi ic b"><i class="ti ti-logout"></i></span><span><b>출고 등록</b><small>현장·공장</small></span></button>
        <button class="qa" onclick="go('sites');setTimeout(openSiteForm,50)"><span class="qi ic a"><i class="ti ti-building-community"></i></span><span><b>현장 등록</b><small>신규 현장</small></span></button>
        <button class="qa" onclick="go('hold');setTimeout(openHoldForm,50)"><span class="qi ic r"><i class="ti ti-lock-plus"></i></span><span><b>홀딩 등록</b><small>자재 홀딩</small></span></button>
      </div>
    </div>`;
}

/* ===================================================================
   모달 헬퍼
   =================================================================== */
function openModal(html) { el('sheet').innerHTML = html; el('modal').classList.add('open'); document.body.style.overflow = 'hidden'; }
function closeModal() { el('modal').classList.remove('open'); document.body.style.overflow = ''; _holdLinkSite = null; _holdConfirm = null; }
el('modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });

/* 자재명 datalist (입고/출고/홀딩 공통) */
function itemDatalist(id) {
  return `<datalist id="${id}">${state.inventory.map(i => `<option value="${esc(i.name)}">`).join('')}</datalist>`;
}
/* 자재명 추천: 재고 + 홀딩 자재명 합쳐서 (없는 자재도 자유 입력 가능) */
function matDatalistCombined(id) {
  const names = new Set();
  state.inventory.forEach(i => i.name && names.add(i.name));
  state.holdings.forEach(h => h.materialName && names.add(h.materialName));
  return `<datalist id="${id}">${[...names].map(n => `<option value="${esc(n)}">`).join('')}</datalist>`;
}
/* ===== 검색형 자동완성 (부분검색) ===== */
function matNames() {
  const s = new Set();
  state.inventory.forEach(i => i.name && s.add(i.name));
  state.holdings.forEach(h => h.materialName && s.add(h.materialName));
  state.sites.forEach(x => x.materialName && s.add(x.materialName));
  return [...s].sort((a, b) => a.localeCompare(b));
}
function companyNames() {
  // 업체/거래처 검색은 '거래처 관리'에 등록된 거래처만 표시
  const s = new Set();
  (state.clients || []).forEach(c => c.value && s.add(c.value));
  return [...s].sort((a, b) => a.localeCompare(b));
}
/* searchBox: 입력하면 부분일치 후보가 아래에 뜨고 클릭 선택. id는 그대로 유지(폼 제출 시 사용). */
function searchBox(id, placeholder, value, listFn, pickFn) {
  return `<input id="${id}" class="sb-in" autocomplete="off" placeholder="${esc(placeholder)}" value="${esc(value || '')}" oninput="sbFilter('${id}','${listFn}','${pickFn || ''}')" onfocus="sbFilter('${id}','${listFn}','${pickFn || ''}')" onblur="setTimeout(sbHide,180)">`;
}
function sbEnsurePop() { let p = el('sb-pop'); if (!p) { p = document.createElement('div'); p.id = 'sb-pop'; p.className = 'sb-pop'; document.body.appendChild(p); } return p; }
function sbFilter(id, listFn, pickFn) {
  const inp = el(id); if (!inp) return;
  const q = (inp.value || '').trim().toLowerCase();
  const all = (typeof window[listFn] === 'function') ? window[listFn]() : [];
  const uniq = [...new Set(all.filter(Boolean).map(String))];
  let m = q ? uniq.filter(n => n.toLowerCase().includes(q)) : uniq;
  m = m.slice(0, 14);
  const p = sbEnsurePop();
  if (!m.length) { p.style.display = 'none'; if (pickFn && window[pickFn]) window[pickFn](); return; }
  const r = inp.getBoundingClientRect();
  p.style.left = r.left + 'px'; p.style.top = (r.bottom + 3) + 'px'; p.style.width = r.width + 'px';
  p.innerHTML = m.map(n => `<div class="sb-item" data-v="${esc(n)}">${esc(n)}</div>`).join('');
  p.style.display = 'block';
  [...p.children].forEach(c => { c.onmousedown = (e) => { e.preventDefault(); inp.value = c.dataset.v; p.style.display = 'none'; if (pickFn && window[pickFn]) window[pickFn](); }; });
  if (pickFn && window[pickFn]) window[pickFn]();
}
function sbHide() { const p = el('sb-pop'); if (p) p.style.display = 'none'; }

/* 업체명 추천: 과거 출고처 + 거래처(현장) + 공장/공급처 */
function companyDatalist(id) {
  const names = new Set();
  state.transactions.forEach(t => t.targetName && names.add(t.targetName));
  state.sites.forEach(s => s.client && names.add(s.client));
  state.holdings.forEach(h => h.vendor && names.add(h.vendor));
  state.inventory.forEach(i => i.vendor && names.add(i.vendor));
  state.factories.forEach(f => f.value && names.add(f.value));
  return `<datalist id="${id}">${[...names].map(n => `<option value="${esc(n)}">`).join('')}</datalist>`;
}

/* ===================================================================
   현장 관리
   =================================================================== */
/* ---------- 이슈(현장별 문제) ---------- */
function siteIssues(id) { return state.issues.filter(i => i.siteId === id); }
function siteOpenIssues(id) { return state.issues.filter(i => i.siteId === id && i.status !== '처리완료'); }
function issuesSorted() {
  return state.issues.slice().sort((a, b) => {
    const ua = a.status !== '처리완료' ? 0 : 1, ub = b.status !== '처리완료' ? 0 : 1;
    if (ua !== ub) return ua - ub;                 // 미해결 먼저
    return (b.createdAt || 0) - (a.createdAt || 0); // 그다음 최신순
  });
}
function renderIssues() {
  const f = 'issue';
  const list = issuesSorted();
  const open = list.filter(i => i.status !== '처리완료').length;
  el('pg-sites').innerHTML = `
    <div class="ph"><div><h2><i class="ti ti-alert-triangle"></i>현장 이슈</h2><p>미해결 <b style="color:#f04438">${open}건</b> · 이슈를 처리 완료해야 현장을 완료할 수 있어요</p></div>
      <button class="btn btn-pri btn-sm" onclick="openIssueForm()"><i class="ti ti-plus"></i>이슈 등록</button></div>
    <div class="chips">
      ${chip('all', '전체', f)}${chip('wait', '견적·결제', f)}${chip('construct', '발주·시공', f)}${chip('done', '완료', f)}${chip('issue', '이슈', f)}
    </div>
    <div class="site-grid">${list.length ? list.map(issueCard).join('') : `<div class="empty" style="grid-column:1/-1"><i class="ti ti-shield-check"></i>등록된 이슈가 없습니다<br><button class="btn btn-pri btn-sm" style="margin-top:12px" onclick="openIssueForm()"><i class="ti ti-plus"></i>이슈 등록하기</button></div>`}</div>`;
}
function issueCard(i) {
  const done = i.status === '처리완료';
  const site = state.sites.find(x => x.id === i.siteId);
  const stageTxt = site ? (site.stage || '') : '삭제된 현장';
  return `<div class="site" style="border-left:4px solid ${done ? '#12b76a' : '#f04438'}">
    <div class="site-top">
      <div><div class="nm">${esc(i.siteName || '현장')}</div><div class="ad"><i class="ti ti-calendar-event" style="font-size:13px"></i>${i.createdAt ? new Date(i.createdAt).toLocaleDateString('ko-KR') : ''} · ${esc(i.by || '')} 등록${stageTxt ? ' · 현재 ' + esc(stageTxt) : ''}</div></div>
      <span class="pill ${done ? 'p-done' : 'p-issue'}">${done ? '처리완료' : '미해결'}</span>
    </div>
    <div style="margin-top:9px;font-size:13.5px;color:var(--t1);white-space:pre-wrap;line-height:1.6">${esc(i.reason || '')}</div>
    ${done
      ? `<div style="margin-top:9px;font-size:12px;color:var(--t3)"><i class="ti ti-check"></i> ${esc(i.resolvedDate || '')} ${esc(i.resolvedBy || '')} 처리 완료</div>`
      : `<button class="btn btn-pri btn-block" style="margin-top:10px" onclick="resolveIssue('${i.id}')"><i class="ti ti-circle-check"></i>처리 완료</button>`}
    <div class="frm-foot" style="margin-top:8px">
      ${site ? `<button class="btn btn-sm" style="flex:1" onclick="openSiteDetail('${i.siteId}')"><i class="ti ti-building-community"></i>현장 보기</button>` : ''}
      ${isAdmin() ? `<button class="btn btn-danger btn-sm" onclick="delIssue('${i.id}')"><i class="ti ti-trash"></i></button>` : ''}
    </div>
  </div>`;
}
function openIssueForm(preSiteId) {
  const sites = state.sites.filter(s => s.stage !== '완료')
    .sort((a, b) => (a.constructDate || '9999-99-99').localeCompare(b.constructDate || '9999-99-99'));
  if (!sites.length) { toast('진행중인 현장이 없습니다'); return; }
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-alert-triangle"></i>이슈 등록</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="frm">
      <div class="fld full"><label>현장 선택 <span class="req">*</span> <span style="color:var(--t3);font-weight:500">(진행중 현장)</span></label>
        <select id="i-site"><option value="">— 현장을 선택하세요 —</option>${sites.map(s => `<option value="${s.id}" ${preSiteId === s.id ? 'selected' : ''}>${esc(s.name)} · ${esc(s.client || '')}${s.constructDate ? ' · 시공 ' + s.constructDate : ''}</option>`).join('')}</select></div>
      <div class="fld full"><label>이슈가 생긴 이유 <span class="req">*</span></label>
        <textarea id="i-reason" placeholder="현장에 생긴 문제를 자세히 적어주세요" style="min-height:130px"></textarea></div>
    </div>
    <div class="frm-foot">
      <button class="btn" style="flex:1" onclick="closeModal()">취소</button>
      <button class="btn btn-pri" style="flex:2" onclick="submitIssue()"><i class="ti ti-check"></i>이슈 등록</button>
    </div>`);
}
async function submitIssue() {
  if (_busy) return;
  const siteId = el('i-site').value;
  const reason = el('i-reason').value.trim();
  if (!siteId) { toast('현장을 선택하세요'); return; }
  if (!reason) { toast('이슈 이유를 입력하세요'); return; }
  const s = state.sites.find(x => x.id === siteId);
  _busy = true;
  try {
    await Store.add('issues', { siteId, siteName: s ? s.name : '', reason, status: '미해결', by: me.name });
    toast('이슈 등록됨'); closeModal();
  } finally { setTimeout(() => { _busy = false; }, 800); }
}
async function resolveIssue(id) {
  if (!confirm('이 이슈를 처리 완료로 표시할까요?')) return;
  await Store.update('issues', id, { status: '처리완료', resolvedBy: me.name, resolvedDate: todayStr() });
  toast('처리 완료');
}
async function delIssue(id) {
  if (!confirm('이 이슈 기록을 삭제할까요?')) return;
  await Store.remove('issues', id); toast('삭제됨');
}
function sitesFilteredList() {
  const f = filters.sites;
  let list = state.sites.slice();
  if (f === 'wait') list = list.filter(s => ['접수', '가견적', '견적', '결제'].includes(s.stage));
  else if (f === 'construct') list = list.filter(s => ['발주', '시공'].includes(s.stage));
  else if (f === 'done') list = list.filter(s => s.stage === '완료');
  else if (f === 'issue') list = []; // 이슈는 renderIssues() 전용 화면에서 처리
  else list = list.filter(s => s.stage !== '완료'); // 전체(기본): 완료 현장 숨김
  // 시공일 임박순 정렬 (시공일 없는 건 맨 뒤). 이슈 보기는 그대로 임박순.
  list.sort((a, b) => (a.constructDate || '9999-99-99').localeCompare(b.constructDate || '9999-99-99'));
  const q = (filters.siteSearch || '').trim().toLowerCase();
  if (q) {
    const fld = filters.siteSearchField || 'all';
    list = list.filter(s => {
      const team = (s.team || '').toLowerCase();
      const client = (s.client || '').toLowerCase();
      const mat = (s.materialName || '').toLowerCase();
      const dates = [s.measureDate, s.constructDate].filter(Boolean).join(' ').toLowerCase();
      const name = (s.name || '').toLowerCase();
      if (fld === 'team') return team.includes(q);
      if (fld === 'client') return client.includes(q);
      if (fld === 'material') return mat.includes(q);
      if (fld === 'date') return dates.includes(q);
      return team.includes(q) || client.includes(q) || mat.includes(q) || dates.includes(q) || name.includes(q);
    });
  }
  return list;
}
function siteGridHtml(list) {
  return list.length ? list.map(siteCard).join('') : `<div class="empty" style="grid-column:1/-1"><i class="ti ti-building"></i>해당하는 현장이 없습니다<br><button class="btn btn-pri btn-sm" style="margin-top:12px" onclick="openSiteForm()"><i class="ti ti-building-community"></i>현장 등록하기</button></div>`;
}
function chipSF(v, label) { return `<button class="chip ${(filters.siteSearchField || 'all') === v ? 'active' : ''}" onclick="setSiteSearchField('${v}')">${label}</button>`; }
function setSiteSearchField(fld) { filters.siteSearchField = fld; renderSites(); setTimeout(() => { const i = el('site-search'); if (i) i.focus(); }, 30); }
function filterSites() {
  filters.siteSearch = el('site-search') ? el('site-search').value : '';
  const list = sitesFilteredList();
  if (el('sites-grid')) el('sites-grid').innerHTML = siteGridHtml(list);
  if (el('sites-count')) el('sites-count').textContent = list.length + '건';
}
function renderSites() {
  const f = filters.sites;
  if (f === 'issue') { renderIssues(); return; } // 이슈는 전용 화면
  const list = sitesFilteredList();
  el('pg-sites').innerHTML = `
    <div class="ph"><div><h2><i class="ti ti-building-community"></i>시공 현장</h2><p>진행 단계를 한눈에 · 탭하면 상세</p></div>
      <button class="btn btn-pri btn-sm" onclick="openSiteForm()"><i class="ti ti-plus"></i>현장 등록</button></div>
    <div class="chips">
      ${chip('all', '전체', f)}${chip('wait', '견적·결제', f)}${chip('construct', '발주·시공', f)}${chip('done', '완료', f)}${chip('issue', '이슈', f)}
    </div>
    <div class="search-box">
      <i class="ti ti-search"></i>
      <input id="site-search" placeholder="현장·시공팀·업체·자재·날짜 검색" value="${esc(filters.siteSearch || '')}" oninput="filterSites()" autocomplete="off">
      ${filters.siteSearch ? `<button class="search-x" onclick="el('site-search').value='';filterSites()"><i class="ti ti-x"></i></button>` : ''}
    </div>
    <div style="font-size:12px;color:var(--t3);margin:2px 0 8px">검색 결과 <b id="sites-count" style="color:var(--t1)">${list.length}건</b></div>
    <div class="site-grid" id="sites-grid">${siteGridHtml(list)}</div>`;
}
function chip(v, label, cur) { return `<button class="chip ${cur === v ? 'active' : ''}" onclick="filters.sites='${v}';renderSites()">${label}</button>`; }

function siteCard(s) {
  const idx = siteStageIndex(s);
  const skip = s.orderType === '도면';
  const tnodes = SITE_STAGES.map((st, i) => {
    let cls = i < idx ? 'done' : (i === idx ? 'cur' : '');
    if (skip && st === '실측') cls = 'skip';
    const date = (s.history || {})[st] ? (s.history[st]).slice(5) : '';
    return `<div class="tnode ${cls}"><span class="c">${i < idx ? '<i class=\'ti ti-check\'></i>' : ''}</span><span class="lb">${st}</span><span class="dt">${date}</span></div>`;
  }).join('');
  const dM = daysFromNow(s.measureDate), dC = daysFromNow(s.constructDate);
  const openIss = siteOpenIssues(s.id);
  return `<div class="site" onclick="openSiteDetail('${s.id}')">
    <div class="site-top">
      <div><div class="nm">${esc(s.name)}</div><div class="ad"><i class="ti ti-map-pin" style="font-size:13px"></i>${esc(s.region || '')} ${esc(s.address || '')}</div></div>
      <div style="text-align:right;flex:none">${pill(s.stage || '접수')}${openIss.length ? `<div style="margin-top:5px"><span class="pill p-issue"><i class="ti ti-alert-triangle"></i> 이슈 ${openIss.length}</span></div>` : ''}</div>
    </div>
    <div class="site-meta">
      <div class="mi"><i class="ti ti-user-circle"></i><span class="k">담당</span><b>${esc(s.manager || '-')}</b></div>
      <div class="mi"><i class="ti ti-briefcase"></i><span class="k">업체</span><b>${esc(s.client || '-')}</b></div>
      <div class="mi"><i class="ti ti-building-factory-2"></i><span class="k">공장</span><b>${esc(s.factory || '-')}</b></div>
      <div class="mi"><i class="ti ti-users"></i><span class="k">시공팀</span><b>${esc(s.team || '-')}</b></div>
    </div>
    <div class="date-row">
      <div class="db ${skip ? '' : (dM != null && dM >= 0 && dM <= 3 ? 'soon' : '')}"><div class="k">실측일</div><div class="v">${skip ? '도면발주' : (s.measureDate || '미정')}</div></div>
      <div class="db ${dC != null && dC >= 0 && dC <= 3 ? 'soon' : ''}"><div class="k">시공일</div><div class="v">${s.constructDate || '미정'}${dC != null && dC >= 0 && dC <= 7 && s.stage !== '완료' ? ` <small style="font-weight:600;color:var(--amber-t)">D-${dC}</small>` : ''}</div></div>
    </div>
    <div class="tline">${tnodes}</div>
    ${openIss.length ? `<div style="margin-top:9px;font-size:12.5px;color:#b42318;background:#fef3f2;border:1px solid #fecdca;border-radius:9px;padding:8px 10px;line-height:1.5"><b><i class="ti ti-alert-triangle"></i> 미해결 이슈</b> · ${esc(openIss[0].reason)}${openIss.length > 1 ? ` <span style="color:var(--t3)">외 ${openIss.length - 1}건</span>` : ''}</div>` : ''}
  </div>`;
}

function openSiteDetail(id) {
  const s = state.sites.find(x => x.id === id); if (!s) return;
  const skip = s.orderType === '도면';
  const linkedHold = state.holdings.find(h => h.status !== '해제' && (h.forSiteId === s.id || (s.name && h.forSiteName === s.name)));
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-building-community"></i>${esc(s.name)}</h3><button class="x" onclick="closeModal()">×</button></div>
    <div style="margin-bottom:12px">${pill(s.stage || '접수')}${s.confirmed ? ' <span class="pill p-done">확정</span>' : ''}</div>
    <div class="dl">
      <div class="df"><div class="k">현장 담당자</div><div class="v">${esc(s.manager || '-')}</div></div>
      <div class="df"><div class="k">업체(거래처)</div><div class="v">${esc(s.client || '-')}</div></div>
      <div class="df full"><div class="k">현장 주소</div><div class="v">${esc(s.region || '')} ${esc(s.address || '-')}</div></div>
      <div class="df"><div class="k">발주 유형</div><div class="v">${esc(s.orderType || '-')}${skip ? ' (실측없음)' : ''}</div></div>
      <div class="df full"><div class="k">자재 / 수량</div><div class="v">${siteItems(s).length ? siteItems(s).map(it => esc(it.name) + ' · ' + esc(it.qty) + '장' + (it.lot ? ' <span style="color:var(--t3)">(롯트 ' + esc(it.lot) + ')</span>' : '')).join('<br>') : '-'}</div></div>
      <div class="df"><div class="k">가공 공장</div><div class="v">${esc(s.factory || '-')}</div></div>
      <div class="df"><div class="k">시공팀</div><div class="v">${esc(s.team || '-')}</div></div>
      <div class="df"><div class="k">실측일</div><div class="v">${skip ? '도면발주' : (s.measureDate || '미정')}</div></div>
      <div class="df"><div class="k">시공일</div><div class="v">${s.constructDate || '미정'}</div></div>
      ${s.preQuote ? `<div class="df"><div class="k">가견적</div><div class="v">${esc(s.preQuote)}</div></div>` : ''}
      ${s.quoteAmount ? `<div class="df"><div class="k">견적 금액</div><div class="v">${won(+s.quoteAmount)}원</div></div>` : ''}
      ${s.note ? `<div class="df full"><div class="k">특이사항</div><div class="v" style="font-weight:500">${esc(s.note)}</div></div>` : ''}
    </div>
    ${(() => { const iss = siteIssues(s.id); return `
    <div class="sec-label" style="display:flex;justify-content:space-between;align-items:center"><span><i class="ti ti-alert-triangle" style="color:#f04438"></i> 현장 이슈 ${iss.length ? `(${siteOpenIssues(s.id).length}건 미해결)` : ''}</span><button class="btn btn-ghost btn-sm" onclick="openIssueForm('${s.id}')"><i class="ti ti-plus"></i>이슈</button></div>
    ${iss.length ? iss.slice().sort((a, b) => { const ua = a.status !== '처리완료' ? 0 : 1, ub = b.status !== '처리완료' ? 0 : 1; return ua !== ub ? ua - ub : (b.createdAt || 0) - (a.createdAt || 0); }).map(i => {
      const done = i.status === '처리완료';
      return `<div style="border:1px solid ${done ? '#d0e8dc' : '#fecdca'};background:${done ? '#f3faf6' : '#fef3f2'};border-radius:10px;padding:9px 11px;margin-bottom:7px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><span class="pill ${done ? 'p-done' : 'p-issue'}" style="flex:none">${done ? '처리완료' : '미해결'}</span><span style="font-size:11px;color:var(--t3)">${i.createdAt ? new Date(i.createdAt).toLocaleDateString('ko-KR') : ''} · ${esc(i.by || '')}</span></div>
        <div style="margin-top:6px;font-size:13px;white-space:pre-wrap;line-height:1.55">${esc(i.reason || '')}</div>
        ${done ? `<div style="margin-top:5px;font-size:11.5px;color:var(--t3)"><i class="ti ti-check"></i> ${esc(i.resolvedDate || '')} ${esc(i.resolvedBy || '')} 처리</div>` : `<button class="btn btn-pri btn-sm btn-block" style="margin-top:7px" onclick="resolveIssue('${i.id}')"><i class="ti ti-circle-check"></i>처리 완료</button>`}
      </div>`; }).join('') : `<div style="font-size:12.5px;color:var(--t3);padding:4px 2px 10px">등록된 이슈가 없습니다.</div>`}`; })()}
    <div class="sec-label"><i class="ti ti-arrow-bar-to-right"></i>진행 단계 변경</div>
    <div class="seg" style="flex-wrap:wrap">
      ${SITE_STAGES.filter(st => !(skip && st === '실측')).map(st => `<button class="${(s.stage || '접수') === st ? 'on' : ''}" onclick="advanceStage('${s.id}','${st}')">${st}</button>`).join('')}
    </div>
    ${linkedHold ? `<div class="banner info" style="margin-top:6px"><i class="ti ti-lock"></i>이미 홀딩이 연결된 현장입니다 (${esc(linkedHold.status || '홀딩')}) — ${esc(linkedHold.vendor || '')} · ${+linkedHold.jang || 0}장${linkedHold.materialName ? ' · ' + esc(linkedHold.materialName) : ''}. 진행 단계가 넘어가도 중복 홀딩은 막습니다.</div>` : `<button class="btn btn-ghost btn-block" style="margin-top:6px" onclick="holdFromSite('${s.id}')"><i class="ti ti-lock-plus"></i>이 현장 자재 홀딩 잡기</button>`}
    <div class="frm-foot">
      <button class="btn" style="flex:1" onclick="openSiteForm('${s.id}')"><i class="ti ti-edit"></i>수정</button>
      ${isAdmin() ? `<button class="btn btn-danger" onclick="delSite('${s.id}')"><i class="ti ti-trash"></i></button>` : ''}
    </div>`);
}
/* 현장 → 홀딩 생성 (현장 정보로 홀딩 폼 프리필) */
function holdFromSite(id) {
  const s = state.sites.find(x => x.id === id); if (!s) return;
  const existing = state.holdings.find(h => h.status !== '해제' && (h.forSiteId === id || (s.name && h.forSiteName === s.name)));
  if (existing) { toast(`이미 홀딩이 연결된 현장입니다 (${existing.status || '홀딩'}) — 중복 방지`); return; }
  openHoldForm(null, { forSiteId: id, items: siteItems(s).map(it => ({ materialName: it.name, jang: it.qty, lot: it.lot })), useDate: s.constructDate });
}
async function advanceStage(id, stage) {
  const s = state.sites.find(x => x.id === id); if (!s) return;
  if (stage === '완료') {
    const openIss = siteOpenIssues(id);
    if (openIss.length) { toast(`미해결 이슈 ${openIss.length}건 — 이슈를 처리 완료해야 현장을 완료할 수 있어요`); return; }
  }
  const hist = Object.assign({}, s.history || {}); if (!hist[stage]) hist[stage] = todayStr();
  await Store.update('sites', id, { stage, history: hist, updatedBy: me.name });
  toast(`단계 → ${stage}`); closeModal();
}
async function delSite(id) { if (!confirm('이 현장을 삭제할까요?')) return; await Store.remove('sites', id); toast('삭제됨'); closeModal(); }

/* 현장 등록/수정 폼 */
function openSiteForm(id, pre) {
  const s = id ? state.sites.find(x => x.id === id) : null;
  const v = s || Object.assign({ manager: me.name, orderType: '실측', stage: '접수', measureNeeded: true }, pre || {});
  _mrowPattern = false;
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-building-community"></i>${s ? '현장 수정' : '현장 등록'}</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="frm">
      <div class="fld"><label>현장명 <span style="color:var(--t3);font-weight:500">(미입력 시 업체명)</span></label><input id="s-name" value="${esc(v.name || '')}" placeholder="현장명"></div>
      <div class="fld"><label>업체(거래처)<span class="req">*</span></label>${searchBox('s-client', '업체명 검색·입력', v.client, 'companyNames', '')}</div>
      <div class="fld"><label>지역</label><input id="s-region" value="${esc(v.region || '')}" placeholder="지역"></div>
      <div class="fld"><label>현장 담당자</label><input id="s-manager" value="${esc(v.manager || me.name)}"></div>
      <div class="fld full"><label>현장 주소</label><input id="s-address" value="${esc(v.address || '')}" placeholder="상세 주소"></div>
      <div class="fld"><label>발주 유형</label>
        <div class="seg" id="s-ordertype">
          <button type="button" class="${v.orderType === '실측' ? 'on' : ''}" onclick="pickOrderType('실측')">실측 발주</button>
          <button type="button" class="${v.orderType === '도면' ? 'on' : ''}" onclick="pickOrderType('도면')">도면 발주</button>
        </div>
      </div>
      <div class="fld"><label>진행 단계</label><select id="s-stage">${SITE_STAGES.map(st => `<option ${(v.stage || '접수') === st ? 'selected' : ''}>${st}</option>`).join('')}</select></div>
      ${activeHoldings().length ? `<div class="fld full"><label><i class="ti ti-lock" style="font-size:13px;color:var(--blue)"></i> 홀딩에서 불러오기 <span style="color:var(--t3);font-weight:500">(선택 — 없으면 아래에 직접 입력)</span></label><select id="s-hold" onchange="pickSiteHolding()"><option value="">— 직접 입력 —</option>${holdingOptions()}</select></div>` : ''}
      <div class="fld full"><label>자재 / 수량 / 롯트<span class="req">*</span> <span style="color:var(--t3);font-weight:500">(여러 종류면 '자재 추가')</span></label>${matRowsHtml(siteItems(v), '수량')}</div>
      <div class="fld"><label>실측일 <span id="s-measure-lbl" style="color:var(--t3)">${v.orderType === '도면' ? '(도면발주·생략)' : ''}</span></label><input type="date" id="s-measureDate" value="${esc(v.measureDate || '')}" ${v.orderType === '도면' ? 'disabled' : ''}></div>
      <div class="fld"><label>시공일<span class="req">*</span></label><input type="date" id="s-constructDate" value="${esc(v.constructDate || '')}"></div>
      <div class="fld"><label>가공 공장<span class="req">*</span></label><select id="s-factory" onchange="onMasterChange('s-factory','factories')">${masterOptions('factories', v.factory || '')}</select></div>
      <div class="fld full hidden" id="s-factory-add"><label>새 공장 입력 후 추가</label><div style="display:flex;gap:8px"><input id="s-factory-new" placeholder="이름 입력" style="flex:1"><button class="btn btn-pri btn-sm" type="button" onclick="commitMaster('s-factory','factories')"><i class="ti ti-plus"></i>추가</button></div></div>
      <div class="fld"><label>시공팀<span class="req">*</span></label><select id="s-team" onchange="onMasterChange('s-team','teams')">${masterOptions('teams', v.team || '')}</select></div>
      <div class="fld full hidden" id="s-team-add"><label>새 시공팀 입력 후 추가</label><div style="display:flex;gap:8px"><input id="s-team-new" placeholder="이름 입력" style="flex:1"><button class="btn btn-pri btn-sm" type="button" onclick="commitMaster('s-team','teams')"><i class="ti ti-plus"></i>추가</button></div></div>
      <label class="chk full ${v.paid ? 'on' : ''}" id="s-paid-w"><input type="checkbox" id="s-paid" ${v.paid ? 'checked' : ''} onchange="this.closest('.chk').classList.toggle('on',this.checked)"> 결제 완료</label>
      <label class="chk full ${v.confirmed ? 'on' : ''}" id="s-confirmed-w"><input type="checkbox" id="s-confirmed" ${v.confirmed ? 'checked' : ''} onchange="this.closest('.chk').classList.toggle('on',this.checked)"> 시공 확정</label>
      <div class="fld full"><label>특이사항</label><textarea id="s-note" placeholder="현장 메모">${esc(v.note || '')}</textarea></div>
    </div>
    <button class="btn btn-ghost btn-block" style="margin-top:12px" onclick="runRecommend()"><i class="ti ti-wand"></i>매뉴얼 기반 시공팀·공장 자동추천</button>
    <div id="reco-out"></div>
    <div class="frm-foot">
      <button class="btn" style="flex:1" onclick="closeModal()">취소</button>
      <button class="btn btn-pri" style="flex:2" onclick="submitSite('${id || ''}')"><i class="ti ti-check"></i>${s ? '저장' : '등록'}</button>
    </div>`);
  mrowLotRefresh();
}
let _orderType = null;
function pickOrderType(t) {
  _orderType = t;
  document.querySelectorAll('#s-ordertype button').forEach(b => b.classList.toggle('on', b.textContent.includes(t === '실측' ? '실측' : '도면')));
  const md = el('s-measureDate'), lbl = el('s-measure-lbl');
  if (t === '도면') { md.value = ''; md.disabled = true; lbl.textContent = '(도면발주·생략)'; }
  else { md.disabled = false; lbl.textContent = ''; }
}
function curOrderType() { return _orderType || (el('s-measureDate').disabled ? '도면' : '실측'); }

function runRecommend() {
  const first = collectMaterialRows()[0] || {}; const fq = +first.qty || 0;
  const o = {
    region: el('s-region').value, address: el('s-address').value,
    constructionDate: el('s-constructDate').value, dueDate: el('s-constructDate').value,
    jang: fq,
    volume: fq >= 25 ? '대형' : '소형',
    materialName: first.name || '',
    workType: '', complex: false, simpleTop: false
  };
  const t = recommendTeam(o), f = recommendFactory(o);
  el('reco-out').innerHTML = `
    <div class="reco">
      <div class="reco-h"><i class="ti ti-wand"></i>매뉴얼 자동추천 (참고용)</div>
      <div class="row"><span class="rl">시공팀</span><span class="rv"><b>${esc(t.team)}</b><small>${esc(t.why)}</small></span></div>
      <div class="row"><span class="rl">가공 공장</span><span class="rv"><b>${esc(f.factory)}</b><small>${esc(f.why)}</small></span></div>
      <div class="row"><span class="rl" style="align-self:center">적용</span><span class="rv"><button class="btn btn-pri btn-sm" onclick="applyReco('${esc(t.team)}','${esc(f.factory)}')">입력란에 채우기</button></span></div>
    </div>`;
}
function applyReco(team, factory) { setSelectValue('s-team', 'teams', team); setSelectValue('s-factory', 'factories', factory); toast('추천값을 입력했습니다'); }
/* 현장 폼에서 홀딩 선택 → 자재·수량·업체 자동 입력 + 등록 시 그 홀딩을 현장에 연결(유지) */
function pickSiteHolding() {
  const id = el('s-hold').value;
  if (!id) { _holdLinkSite = null; return; }
  const h = state.holdings.find(x => x.id === id); if (!h) return;
  const box = el('mat-rows');
  if (box) { box.innerHTML = ''; holdItems(h).forEach(it => addMaterialRow({ name: it.materialName, qty: it.jang, lot: it.lot }, '수량')); }
  if (!el('s-client').value) el('s-client').value = h.vendor || '';
  _holdLinkSite = id;
  toast('홀딩 자재를 불러왔습니다 (등록 시 현장에 연결)');
}

async function submitSite(id) {
  const name = el('s-name').value.trim();
  const client = el('s-client').value.trim();
  const items = collectMaterialRows();
  const constructDate = el('s-constructDate').value;
  const factory = el('s-factory').value === '__add' ? '' : el('s-factory').value;
  const team = el('s-team').value === '__add' ? '' : el('s-team').value;
  if (!client) { toast('업체명을 입력하세요'); return; }
  if (!items.length) { toast('자재명과 수량을 입력하세요'); return; }
  if (!constructDate) { toast('시공일을 선택하세요'); return; }
  if (!factory) { toast('가공 공장을 선택하세요'); return; }
  if (!team) { toast('시공팀을 선택하세요'); return; }
  const stage = el('s-stage').value || '접수';
  if (id && stage === '완료' && siteOpenIssues(id).length) { toast(`미해결 이슈 ${siteOpenIssues(id).length}건 — 이슈를 처리 완료해야 현장을 완료할 수 있어요`); return; }
  const obj = {
    name: name || (client + ' 현장'), client, region: el('s-region').value.trim(),
    address: el('s-address').value.trim(), manager: el('s-manager').value.trim() || me.name,
    orderType: curOrderType(), stage,
    items, materialName: items[0].name, qty: String(items[0].qty), unit: '',
    measureDate: el('s-measureDate').value, constructDate,
    factory, team,
    paid: el('s-paid').checked, confirmed: el('s-confirmed').checked,
    note: el('s-note').value.trim(), updatedBy: me.name
  };
  if (id) {
    const s = state.sites.find(x => x.id === id);
    const hist = Object.assign({}, s.history || {}); if (!hist[obj.stage]) hist[obj.stage] = todayStr();
    obj.history = hist;
    await Store.update('sites', id, obj); toast('현장 정보 저장됨');
  } else {
    obj.history = { '접수': todayStr() }; if (obj.stage !== '접수') obj.history[obj.stage] = todayStr();
    await Store.add('sites', obj); toast('현장 등록 완료');
  }
  // 선택한 홀딩을 이 현장에 '연결'(소진 아님 — 홀딩은 그대로 살아있음)
  if (_holdLinkSite) { await Store.update('holdings', _holdLinkSite, { forSiteName: obj.name }); _holdLinkSite = null; }
  closeModal();
}

/* ===================================================================
   재고 · 입고
   =================================================================== */
function stockBaseList() {
  const f = filters.stock;
  let list = state.inventory.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  if (f === 'low') list = list.filter(i => ['부족', '없음'].includes(stockState(i).k));
  else if (f === 'ok') list = list.filter(i => stockState(i).k === '정상');
  const q = (filters.stockSearch || '').trim().toLowerCase();
  if (q) list = list.filter(i => (i.name || '').toLowerCase().includes(q) || (i.spec || '').toLowerCase().includes(q) || (i.vendor || '').toLowerCase().includes(q));
  return list;
}
function stockRowsHtml(list) {
  if (!list.length) return `<tr><td colspan="7"><div class="empty"><i class="ti ti-package-off"></i>해당하는 자재가 없습니다</div></td></tr>`;
  return list.map(i => {
    const s = stockState(i);
    const held = heldJangFor(i.name), avail = (+i.jang || 0) - held;
    return `<tr onclick="openItemForm('${i.id}')">
      <td><b>${esc(i.name)}</b><div style="font-size:11px;color:var(--t3)">${esc(i.vendor || '')}</div></td>
      <td>${esc(i.spec || '-')}</td>
      <td><b>${(+i.jang || 0)}</b>장${i.safeJang ? `<div style="font-size:10px;color:var(--t3)">안전 ${i.safeJang}</div>` : ''}</td>
      <td><b style="color:${avail <= 0 ? 'var(--red-t)' : 'var(--gd)'}">${avail}</b>장${held > 0 ? `<div style="font-size:10px;color:var(--t3)">홀딩 ${held}</div>` : ''}</td>
      <td>${itemHebe(i).toFixed(1)}㎡</td>
      <td><span class="pill ${s.cls}">${s.k}</span></td>
      <td>${esc(i.depot || '본사')}</td>
    </tr>`;
  }).join('');
}
function filterStockTable() {
  filters.stockSearch = el('stock-search') ? el('stock-search').value : '';
  const list = stockBaseList();
  if (el('stock-tbody')) el('stock-tbody').innerHTML = stockRowsHtml(list);
  if (el('stock-count')) el('stock-count').textContent = list.length + '종';
}
function renderStock() {
  const f = filters.stock;
  const list = stockBaseList();
  const ins = state.transactions.filter(t => t.type === 'in').sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 8);

  el('pg-stock').innerHTML = `
    <div class="ph"><div><h2><i class="ti ti-packages"></i>재고 · 입고</h2><p>장수·헤베(㎡) 기준 · 안전재고 자동 표시</p></div></div>
    <div style="display:flex;gap:9px;margin-bottom:9px">
      <button class="btn btn-pri" style="flex:1" onclick="openStockForm()"><i class="ti ti-login"></i>입고 등록</button>
      <button class="btn" style="flex:1" onclick="openItemForm()"><i class="ti ti-plus"></i>품목 추가</button>
    </div>
    <button class="btn btn-block" style="margin-bottom:12px" onclick="bulkInOpen()"><i class="ti ti-file-spreadsheet"></i>엑셀로 여러 건 한꺼번에 입고</button>
    <div class="search-box">
      <i class="ti ti-search"></i>
      <input id="stock-search" placeholder="품명·규격·공급처 검색" value="${esc(filters.stockSearch || '')}" oninput="filterStockTable()" autocomplete="off">
      ${filters.stockSearch ? `<button class="search-x" onclick="el('stock-search').value='';filterStockTable()"><i class="ti ti-x"></i></button>` : ''}
    </div>
    <div class="chips">${chipS('all', '전체', f)}${chipS('low', '부족·없음', f)}${chipS('ok', '정상', f)}</div>
    ${f === 'low' ? `<div class="banner warn"><i class="ti ti-alert-triangle"></i><span><b>입고가 필요한 자재</b>만 모았습니다. 자재명과 현재 장수를 확인하세요.</span></div>` : ''}
    <div style="font-size:12px;color:var(--t3);margin-bottom:8px">검색 결과 <b id="stock-count" style="color:var(--t1)">${list.length}종</b></div>
    <div class="tbl-wrap">
      <table class="tbl">
        <thead><tr><th>자재명</th><th>규격</th><th>실재고</th><th>가용</th><th>헤베(㎡)</th><th>상태</th><th>창고</th></tr></thead>
        <tbody id="stock-tbody">${stockRowsHtml(list)}</tbody>
      </table>
    </div>
    <div class="card" style="margin-top:14px">
      <div class="card-h"><h3><i class="ti ti-login"></i>최근 입고</h3></div>
      ${ins.length ? ins.map(t => `<div class="alert-i b" style="background:var(--gl2);border-color:var(--gbd)"><div class="ai" style="color:var(--gd)"><i class="ti ti-login"></i></div><div class="at"><b>${esc(t.itemName)} +${(+t.hebe || 0).toFixed(1)}㎡ (${+t.jang || 0}장)</b><span>${esc(t.date)} · 롯트 ${esc(t.lot || '-')} · ${esc(t.vendor || '')} · ${esc(t.by || '')}</span></div>${isAdmin() ? `<button class="x" onclick="delIn('${t.id}')" aria-label="삭제"><i class="ti ti-trash" style="font-size:16px;color:var(--red-t)"></i></button>` : ''}</div>`).join('') : `<div class="empty"><i class="ti ti-inbox"></i>입고 내역 없음</div>`}
    </div>`;
}
function chipS(v, l, c) { return `<button class="chip ${c === v ? 'active' : ''}" onclick="filters.stock='${v}';renderStock()">${l}</button>`; }

/* 품목 추가/수정 */
/* 내역 리스트: 10건만 보이고 나머지는 "더 보기"로 펼침 */
function txnRowsWithMore(arr, moreId, rowFn, emptyMsg) {
  if (!arr.length) return `<div class="empty" style="padding:16px"><i class="ti ti-inbox"></i>${emptyMsg}</div>`;
  const first = arr.slice(0, 10).map(rowFn).join('');
  if (arr.length <= 10) return first;
  const rest = arr.slice(10).map(rowFn).join('');
  return first + `<div id="${moreId}" class="hidden">${rest}</div>` +
    `<button class="btn btn-ghost btn-sm btn-block" style="margin-top:6px" onclick="el('${moreId}').classList.remove('hidden');this.remove()"><i class="ti ti-chevron-down"></i>더 보기 (${arr.length - 10}건)</button>`;
}
function openItemForm(id) {
  const it = id ? state.inventory.find(x => x.id === id) : null;
  const v = it || {};
  const txns = it ? state.transactions.filter(t => (t.itemId && t.itemId === id) || t.itemName === it.name) : [];
  const outs = txns.filter(t => t.type === 'out').sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const ins = txns.filter(t => t.type === 'in').sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const totalOut = outs.reduce((a, b) => a + (+b.jang || 0), 0);
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-box"></i>${it ? '품목 수정' : '품목 추가'}</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="frm">
      <div class="fld"><label>자재명<span class="req">*</span></label><input id="i-name" value="${esc(v.name || '')}" placeholder="자재명"></div>
      <div class="fld"><label>규격 (가로*세로*두께)</label>
        <select id="i-spec" onchange="onSpecChange('i')">${specOptions(v.spec || '')}</select>
      </div>
      <div class="fld full hidden" id="i-spec-add">
        <label>새 규격 입력 후 추가</label>
        <div style="display:flex;gap:8px">
          <input id="i-spec-new" placeholder="가로*세로*두께" inputmode="text" style="flex:1">
          <button class="btn btn-pri btn-sm" type="button" onclick="commitSpec('i')"><i class="ti ti-plus"></i>추가</button>
        </div>
      </div>
      <div class="fld"><label>공급처/발주처</label><select id="i-vendor" onchange="onMasterChange('i-vendor','suppliers')">${masterOptions('suppliers', v.vendor || '')}</select></div>
      <div class="fld full hidden" id="i-vendor-add"><label>새 공급처 입력 후 추가</label><div style="display:flex;gap:8px"><input id="i-vendor-new" placeholder="이름 입력" style="flex:1"><button class="btn btn-pri btn-sm" type="button" onclick="commitMaster('i-vendor','suppliers')"><i class="ti ti-plus"></i>추가</button></div></div>
      <div class="fld"><label>창고</label><input id="i-depot" value="${esc(v.depot || '본사')}"></div>
      <div class="fld"><label>현재 장수</label><input id="i-jang" value="${esc(v.jang || 0)}" inputmode="numeric" oninput="updateItemHebe()"></div>
      <div class="fld"><label>안전재고(장) — 미만이면 '부족'</label><input id="i-safe" value="${esc(v.safeJang || 0)}" inputmode="numeric" placeholder="안전재고 장수"></div>
      <div class="fld full"><div class="reco" id="i-hebe-info" style="margin-top:0"><div class="reco-h"><i class="ti ti-ruler-2"></i>자동 환산</div><div class="row"><span class="rl">장당 헤베</span><span class="rv"><b id="i-perjang">${(parseSpec(v.spec).hebePerJang || 0).toFixed(3)}</b> ㎡/장</span></div><div class="row"><span class="rl">현재 재고 헤베</span><span class="rv"><b id="i-tothebe">${itemHebe(v).toFixed(2)}</b> ㎡</span></div></div></div>
    </div>
    ${it ? `
    <div class="sec-label"><i class="ti ti-list-details"></i>롯트별 재고</div>
    ${(() => { const ls = lotStock(it.name); return ls.length ? `<div class="tbl-wrap" style="margin-bottom:6px"><table class="tbl"><thead><tr><th>롯트</th><th>입고</th><th>출고</th><th>잔여</th></tr></thead><tbody>${ls.map(l => `<tr><td><b>${esc(l.lot)}</b></td><td>${l.inQty}장</td><td>${l.outQty}장</td><td><b style="color:${l.remain <= 0 ? 'var(--t3)' : 'var(--gd)'}">${l.remain}장</b></td></tr>`).join('')}</tbody></table></div>` : `<div style="font-size:12.5px;color:var(--t3);padding:2px 0 8px">롯트 정보가 없습니다 (입고 시 롯트를 입력하면 표시됩니다)</div>`; })()}
    <div class="sec-label"><i class="ti ti-logout"></i>출고 내역 <span style="font-weight:500;color:var(--t3)">· 누적 ${totalOut}장</span></div>
    ${txnRowsWithMore(outs, 'out-more', t => `<div class="alert-i b" style="margin-bottom:6px"><div class="ai"><i class="ti ti-logout"></i></div><div class="at"><b>${+t.jang || 0}장${t.hebe ? ` (${(+t.hebe).toFixed(1)}㎡)` : ''}</b><span>${esc(t.date || '')} · ${esc(t.targetName || '-')} · ${esc(t.by || '')}</span></div></div>`, '출고 내역 없음')}
    <div class="sec-label" style="margin-top:14px"><i class="ti ti-login"></i>입고 내역</div>
    ${txnRowsWithMore(ins, 'in-more', t => `<div class="alert-i b" style="background:var(--gl2);border-color:var(--gbd);margin-bottom:6px"><div class="ai" style="color:var(--gd)"><i class="ti ti-login"></i></div><div class="at"><b>+${+t.jang || 0}장${t.hebe ? ` (${(+t.hebe).toFixed(1)}㎡)` : ''}</b><span>${esc(t.date || '')} · 롯트 ${esc(t.lot || '-')} · ${esc(t.by || '')}</span></div></div>`, '입고 내역 없음')}
    ` : ''}
    <div class="frm-foot">
      ${it && isAdmin() ? `<button class="btn btn-danger" onclick="delItem('${id}')"><i class="ti ti-trash"></i></button>` : ''}
      <button class="btn btn-pri" style="flex:1" onclick="submitItem('${id || ''}')"><i class="ti ti-check"></i>저장</button>
    </div>`);
  setSelectValue('i-vendor', 'suppliers', v.vendor);
}
/* 규격 select에서 "새 규격 추가" 선택 시 입력란 표시 */
function onSpecChange(prefix) {
  const sel = el(prefix + '-spec');
  const addBox = el(prefix + '-spec-add');
  if (sel.value === '__add') { if (addBox) addBox.classList.remove('hidden'); setTimeout(() => el(prefix + '-spec-new') && el(prefix + '-spec-new').focus(), 50); }
  else { if (addBox) addBox.classList.add('hidden'); if (prefix === 'i') updateItemHebe(); }
}
async function commitSpec(prefix) {
  const val = await addSpecValue(el(prefix + '-spec-new').value);
  if (!val) return;
  // 추가된 규격을 select에 반영하고 선택
  const sel = el(prefix + '-spec');
  sel.innerHTML = specOptions(val);
  el(prefix + '-spec-add').classList.add('hidden');
  if (prefix === 'i') updateItemHebe();
  toast('규격 추가됨: ' + val);
}
function updateItemHebe() {
  const ps = parseSpec(el('i-spec').value === '__add' ? '' : el('i-spec').value);
  const jang = parseFloat(el('i-jang').value) || 0;
  if (el('i-perjang')) el('i-perjang').textContent = ps.hebePerJang.toFixed(3);
  if (el('i-tothebe')) el('i-tothebe').textContent = (jang * ps.hebePerJang).toFixed(2);
}
async function submitItem(id) {
  const name = el('i-name').value.trim(); if (!name) { toast('자재명을 입력하세요'); return; }
  let spec = el('i-spec').value; if (spec === '__add') spec = '';
  const ps = parseSpec(spec);
  const jang = parseFloat(el('i-jang').value) || 0;
  let vendor = el('i-vendor').value; if (vendor === '__add') vendor = ''; vendor = vendor.trim();
  const obj = { name, spec, vendor, depot: el('i-depot').value.trim() || '본사', jang, hebePerJang: ps.hebePerJang, safeJang: parseFloat(el('i-safe').value) || 0 };
  if (id) { await Store.update('inventory', id, obj); toast('저장됨'); }
  else { obj.lastInDate = todayStr(); await Store.add('inventory', obj); toast('품목 추가됨'); }
  closeModal();
}
async function delItem(id) { if (!confirm('이 품목을 삭제할까요?')) return; await Store.remove('inventory', id); toast('삭제됨'); closeModal(); }

/* 입고 등록 → 자재 선택(언더바) + 롯트 + 패턴별 장수 → 헤베 자동환산 */
function openStockForm() {
  if (!state.inventory.length) { toast('먼저 품목을 추가하세요'); openItemForm(); return; }
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-login"></i>입고 등록</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="frm">
      <div class="fld full"><label>자재 선택<span class="req">*</span></label>
        <select id="in-item" onchange="onInItemChange()">${itemOptions('')}</select>
      </div>
      <div class="fld"><label>규격</label><input id="in-spec" readonly placeholder="자재 선택 시 자동" style="background:var(--soft)"></div>
      <div class="fld"><label>롯트 넘버<span class="req">*</span></label><input id="in-lot" placeholder="롯트 넘버 입력"></div>
    </div>
    <div class="sec-label"><i class="ti ti-layout-grid"></i>패턴별 장수 <span style="font-weight:500;color:var(--t3)">(패턴이 없으면 장수만 입력)</span></div>
    <div id="in-patterns"></div>
    <button class="btn btn-ghost btn-sm" type="button" onclick="addPatternRow()" style="margin-top:4px"><i class="ti ti-plus"></i>패턴 추가</button>
    <div class="frm" style="margin-top:14px">
      <div class="fld"><label>입고일</label><input type="date" id="in-date" value="${todayStr()}"></div>
      <div class="fld"><label>발주처/매입처 <span style="color:var(--t3);font-weight:500">(기본: 직발주)</span></label><select id="in-vendor" onchange="onMasterChange('in-vendor','suppliers')">${masterOptions('suppliers', '다우세라믹앤석재')}</select></div>
      <div class="fld full hidden" id="in-vendor-add"><label>기타 발주처 입력 후 추가</label><div style="display:flex;gap:8px"><input id="in-vendor-new" placeholder="이름 입력" style="flex:1"><button class="btn btn-pri btn-sm" type="button" onclick="commitMaster('in-vendor','suppliers')"><i class="ti ti-plus"></i>추가</button></div></div>
      <div class="fld full"><label>메모</label><input id="in-note" placeholder="선택"></div>
    </div>
    <div class="reco" id="in-summary" style="margin-top:14px"><div class="reco-h"><i class="ti ti-calculator"></i>자동 환산</div>
      <div class="row"><span class="rl">총 입고 장수</span><span class="rv"><b id="in-tot-jang">0</b> 장</span></div>
      <div class="row"><span class="rl">환산 헤베</span><span class="rv"><b id="in-tot-hebe">0</b> ㎡</span></div>
    </div>
    <div class="frm-foot"><button class="btn" style="flex:1" onclick="closeModal()">취소</button><button class="btn btn-pri" style="flex:2" onclick="submitStock()"><i class="ti ti-check"></i>입고 등록</button></div>`);
  addPatternRow();
  onInItemChange();
}
function onInItemChange() {
  const it = state.inventory.find(i => i.id === el('in-item').value);
  el('in-spec').value = it ? (it.spec || '-') : '';
  computeInTotal();
}
function addPatternRow() {
  const box = el('in-patterns'); if (!box) return;
  const row = document.createElement('div');
  row.className = 'pat-row';
  row.style.cssText = 'display:flex;gap:8px;margin-bottom:8px';
  row.innerHTML = `<input class="in-pat-name" placeholder="패턴(선택)" style="flex:1.2;font-size:14px;padding:9px 11px;border:1.5px solid var(--bd2);border-radius:10px">
    <input class="in-pat-jang" inputmode="numeric" placeholder="장수" oninput="computeInTotal()" style="flex:1;font-size:14px;padding:9px 11px;border:1.5px solid var(--bd2);border-radius:10px">
    <button class="btn btn-ghost btn-sm" type="button" onclick="this.parentElement.remove();computeInTotal()"><i class="ti ti-x"></i></button>`;
  box.appendChild(row);
}
function computeInTotal() {
  let tot = 0;
  document.querySelectorAll('#in-patterns .in-pat-jang').forEach(i => tot += parseFloat(i.value) || 0);
  const it = state.inventory.find(i => i.id === (el('in-item') && el('in-item').value));
  const per = it ? (+it.hebePerJang || 0) : 0;
  if (el('in-tot-jang')) el('in-tot-jang').textContent = tot;
  if (el('in-tot-hebe')) el('in-tot-hebe').textContent = (tot * per).toFixed(2);
}
async function submitStock() {
  const it = state.inventory.find(i => i.id === el('in-item').value);
  if (!it) { toast('자재를 선택하세요'); return; }
  const lot = el('in-lot').value.trim();
  if (!lot) { toast('롯트 넘버를 입력하세요 (세라믹 필수)'); return; }
  const patterns = []; let jang = 0;
  document.querySelectorAll('#in-patterns .pat-row').forEach(r => {
    const nm = r.querySelector('.in-pat-name').value.trim();
    const q = parseFloat(r.querySelector('.in-pat-jang').value) || 0;
    if (q > 0) { patterns.push({ pattern: nm || '-', jang: q }); jang += q; }
  });
  if (jang <= 0) { toast('입고 장수를 입력하세요'); return; }
  const hebe = +(jang * (+it.hebePerJang || 0)).toFixed(2);
  let vendor = el('in-vendor').value; if (vendor === '__add') vendor = ''; vendor = (vendor || '다우세라믹앤석재').trim();
  const date = el('in-date').value, note = el('in-note').value.trim();
  const newJang = (+it.jang || 0) + jang;
  await Store.update('inventory', it.id, { jang: newJang, lastInDate: date });
  await Store.add('transactions', { type: 'in', itemId: it.id, itemName: it.name, spec: it.spec, lot, patterns, jang, hebe, vendor, date, note, by: me.name });
  const conv = await activatePlannedHolds(it.name, newJang);
  toast(`입고 완료 · ${jang}장 (${hebe}㎡)` + (conv ? ` · 예정홀딩 ${conv}건 활성화` : '')); closeModal();
}

/* ===================================================================
   엑셀 일괄 입고
   =================================================================== */
let _bulkRows = [];
function bulkInOpen() {
  _bulkRows = [];
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-file-spreadsheet"></i>엑셀 일괄 입고</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="banner info"><i class="ti ti-info-circle"></i><span>엑셀(.xlsx)·CSV로 여러 자재를 한 번에 입고합니다. <b>① 양식 다운로드 → ② 채우기 → ③ 파일 선택 → ④ 미리보기 확인 후 등록.</b><br>열 순서: <b>자재명 · 규격 · 패턴 · 장수 · 롯트 · 입고일 · 발주처 · 메모</b><br><b style="color:var(--gd)">자재명이 같으면 새로 안 만들고 기존 재고에 합산</b>됩니다. <b>장수를 비우면 재고 0인 품목으로만 등록</b>(제품정보만)됩니다. 패턴이 여러 개면 행을 나눠 적으세요.</span></div>
    <div style="display:flex;gap:8px;margin:10px 0">
      <button class="btn" style="flex:1" onclick="bulkInTemplate()"><i class="ti ti-download"></i>빈 양식</button>
      <button class="btn" style="flex:1" onclick="bulkInTemplateStock()"><i class="ti ti-clipboard-list"></i>현재 품목 양식</button>
    </div>
    <label class="btn btn-pri btn-block" style="cursor:pointer;margin-bottom:4px"><i class="ti ti-upload"></i>채운 파일 선택<input type="file" accept=".xlsx,.xls,.csv" onchange="bulkInParse(this)" style="display:none"></label>
    <div id="bulk-preview"></div>`);
}
function bulkInTemplate() {
  if (typeof XLSX === 'undefined') { toast('엑셀 모듈 로딩 중 — 잠시 후 다시'); return; }
  const aoa = [
    ['자재명', '규격', '패턴', '장수', '롯트', '입고일', '발주처', '메모'],
    ['카무스 화이트', '1600*3200*20', 'A패턴', 6, 'LOT-26-0601', todayStr(), '다우세라믹앤석재', ''],
    ['카무스 화이트', '1600*3200*20', 'B패턴', 4, 'LOT-26-0601', todayStr(), '다우세라믹앤석재', '패턴별로 행을 나눠 적으세요']
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 18 }, { wch: 16 }, { wch: 10 }, { wch: 8 }, { wch: 14 }, { wch: 12 }, { wch: 18 }, { wch: 22 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '입고');
  XLSX.writeFile(wb, '입고양식.xlsx');
  toast('양식 다운로드 (.xlsx)');
}
/* 현재 등록된 품목을 미리 채운 양식 — 패턴·장수만 적어서 올리면 됨(중복 생성 방지) */
function bulkInTemplateStock() {
  if (typeof XLSX === 'undefined') { toast('엑셀 모듈 로딩 중 — 잠시 후 다시'); return; }
  const header = ['자재명', '규격', '패턴', '장수', '롯트', '입고일', '발주처', '메모'];
  const items = state.inventory.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  if (!items.length) { toast('등록된 품목이 없습니다 — 빈 양식을 사용하세요'); return; }
  const rows = items.map(i => [i.name || '', i.spec || '', '', '', '', todayStr(), i.vendor || '다우세라믹앤석재', '']);
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  ws['!cols'] = [{ wch: 18 }, { wch: 16 }, { wch: 10 }, { wch: 8 }, { wch: 14 }, { wch: 12 }, { wch: 18 }, { wch: 22 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '입고');
  XLSX.writeFile(wb, '입고양식_현재품목.xlsx');
  toast(`현재 품목 ${items.length}종 양식 다운로드`);
}
function bulkInParse(input) {
  const f = input.files && input.files[0]; if (!f) return;
  if (typeof XLSX === 'undefined') { toast('엑셀 모듈 로딩 중 — 잠시 후 다시'); return; }
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const wb = XLSX.read(e.target.result, { type: 'array', cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
      bulkInBuild(rows);
    } catch (err) { toast('파일을 읽지 못했습니다'); }
  };
  reader.readAsArrayBuffer(f);
}
function _bulkPick(r, keys) { for (const k of Object.keys(r)) { if (keys.includes(String(k).trim())) return r[k]; } return ''; }
function _normName(s) { return String(s == null ? '' : s).trim().replace(/\s+/g, ' '); }
function _bulkDate(v) {
  if (!v) return todayStr();
  if (v instanceof Date) return new Date(v.getTime() - v.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const s = String(v).trim().replace(/[.\/]/g, '-').replace(/-+/g, '-');
  const m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  return todayStr();
}
function bulkInBuild(rows) {
  _bulkRows = rows.map(r => {
    const name = String(_bulkPick(r, ['자재명', '자재', '품명', 'name'])).trim();
    const spec = String(_bulkPick(r, ['규격', 'spec'])).trim();
    const pattern = String(_bulkPick(r, ['패턴', '패턴명', '패턴 명', 'pattern'])).trim();
    const jang = parseFloat(_bulkPick(r, ['장수', '수량', '입고장수', '입고 장수', 'qty'])) || 0;
    const lot = String(_bulkPick(r, ['롯트', '롯트번호', '롯트 번호', 'lot'])).trim();
    const date = _bulkDate(_bulkPick(r, ['입고일', '날짜', 'date']));
    const vendor = String(_bulkPick(r, ['발주처', '매입처', 'vendor'])).trim() || '다우세라믹앤석재';
    const note = String(_bulkPick(r, ['메모', '비고', 'note'])).trim();
    const valid = !!name;
    const exists = !!name && state.inventory.some(i => _normName(i.name) === _normName(name));
    return { name, spec, pattern, jang, lot, date, vendor, note, valid, exists };
  }).filter(r => r.name || r.jang);
  const okCnt = _bulkRows.filter(r => r.valid).length;
  const inCnt = _bulkRows.filter(r => r.valid && r.jang > 0).length;
  const catCnt = okCnt - inCnt;
  el('bulk-preview').innerHTML = `
    <div style="font-size:13px;color:var(--t2);margin:6px 0 8px">총 ${_bulkRows.length}행 · 정상 <b style="color:var(--gd)">${okCnt}</b>건 <span style="color:var(--t3)">(입고 ${inCnt} · 품목등록 ${catCnt})</span>${_bulkRows.length - okCnt ? ` · 오류 <b style="color:var(--red-t)">${_bulkRows.length - okCnt}</b>건` : ''}</div>
    <div class="tbl-wrap" style="max-height:300px;overflow:auto"><table class="tbl"><thead><tr><th>상태</th><th>처리</th><th>자재명</th><th>규격</th><th>패턴</th><th>장수</th><th>롯트</th><th>입고일</th><th>발주처</th></tr></thead><tbody>
    ${_bulkRows.map(r => `<tr><td>${r.valid ? '<span class="pill p-prog">정상</span>' : '<span class="pill p-issue">오류</span>'}</td><td>${!r.valid ? '-' : (r.exists ? (r.jang > 0 ? '<span class="pill p-prog">재고추가</span>' : '<span class="pill p-gray">등록됨</span>') : (r.jang > 0 ? '<span class="pill p-prog">신규+입고</span>' : '<span class="pill p-gray">신규(재고0)</span>'))}</td><td><b>${esc(r.name || '-')}</b></td><td>${esc(r.spec || '-')}</td><td>${esc(r.pattern || '-')}</td><td>${r.jang || 0}장</td><td>${esc(r.lot || '-')}</td><td>${esc(r.date)}</td><td>${esc(r.vendor)}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="frm-foot"><button class="btn" style="flex:1" onclick="closeModal()">취소</button><button class="btn btn-pri" style="flex:2" onclick="bulkInSubmit()"><i class="ti ti-check"></i>${okCnt}건 등록</button></div>`;
}
async function bulkInSubmit() {
  const ok = _bulkRows.filter(r => r.valid);
  if (!ok.length) { toast('등록할 행이 없습니다 (자재명 필요)'); return; }
  if (_busy) return; _busy = true;
  try {
    const existById = {}, newByName = {};
    ok.forEach(r => {
      const it = state.inventory.find(i => _normName(i.name) === _normName(r.name));
      if (it) {
        // 기존 품목: 장수>0 일 때만 재고 추가. 장수 없으면 '이미 등록됨'이라 변경 없음.
        if (r.jang > 0) { (existById[it.id] = existById[it.id] || { it, add: 0, date: r.date }).add += r.jang; existById[it.id].date = r.date; }
      } else {
        // 신규 품목: 장수가 없어도 재고 0으로 등록(카탈로그). 장수 있으면 그만큼 초기 재고.
        const key = _normName(r.name);
        const g = (newByName[key] = newByName[key] || { name: r.name, spec: '', add: 0, vendor: r.vendor, date: r.date });
        if (r.spec && !g.spec) g.spec = r.spec;
        g.add += r.jang; g.date = r.date;
      }
    });
    for (const id in existById) { const g = existById[id]; if (g.add > 0) await Store.update('inventory', id, { jang: (+g.it.jang || 0) + g.add, lastInDate: g.date }); }
    for (const nm in newByName) { const g = newByName[nm]; const ps = parseSpec(g.spec); await Store.add('inventory', { name: g.name, spec: g.spec, vendor: g.vendor, depot: '본사', jang: g.add, hebePerJang: ps.hebePerJang, safeJang: 0, lastInDate: g.add > 0 ? g.date : '' }); }
    // 입고 기록은 장수>0 행만
    for (const r of ok) {
      if (!(r.jang > 0)) continue;
      const it = state.inventory.find(i => _normName(i.name) === _normName(r.name));
      const per = it ? (+it.hebePerJang || 0) : (newByName[_normName(r.name)] ? parseSpec(newByName[_normName(r.name)].spec).hebePerJang : 0);
      const hebe = +(r.jang * per).toFixed(2);
      await Store.add('transactions', { type: 'in', itemName: r.name, itemId: it ? it.id : '', spec: r.spec || (it && it.spec) || '', lot: r.lot, patterns: r.pattern ? [{ pattern: r.pattern, jang: r.jang }] : [], jang: r.jang, hebe, vendor: r.vendor, date: r.date, note: r.note, by: me.name });
    }
    // 예정홀딩 자동 전환 (입고분 있는 자재만)
    const affected = {};
    for (const id in existById) { const g = existById[id]; if (g.add > 0) affected[g.it.name] = (+g.it.jang || 0) + g.add; }
    for (const nm in newByName) { const g = newByName[nm]; if (g.add > 0) affected[g.name] = g.add; }
    let convN = 0;
    for (const nm in affected) { convN += await activatePlannedHolds(nm, affected[nm]); }
    const newCnt = Object.keys(newByName).length, inCnt = ok.filter(r => r.jang > 0).length;
    toast(`완료 · 신규품목 ${newCnt}종 · 입고 ${inCnt}건` + (convN ? ` · 예정홀딩 ${convN}건 활성화` : '')); closeModal();
  } finally { _busy = false; }
}

/* ===================================================================
   출고 (현장/공장·거래처) + 월별/분석
   =================================================================== */
function renderShip() {
  const outs = state.transactions.filter(t => t.type === 'out').sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const now = new Date(); const ym = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  const monthOut = outs.filter(t => (t.date || '').startsWith(ym));
  const monthHebe = monthOut.reduce((a, b) => a + (+b.hebe || 0), 0);
  const year = now.getFullYear();
  const monthly = Array.from({ length: 12 }, (_, m) => outs.filter(t => (t.date || '').startsWith(year + '-' + String(m + 1).padStart(2, '0'))).reduce((a, b) => a + (+b.hebe || 0), 0));
  const maxM = Math.max(1, ...monthly);
  // 상위 제품
  const byItem = {}; outs.forEach(t => { byItem[t.itemName] = (byItem[t.itemName] || 0) + (+t.hebe || 0); });
  const top = Object.entries(byItem).sort((a, b) => b[1] - a[1]).slice(0, 6); const maxT = Math.max(1, ...top.map(t => t[1]));
  const outClients = [...new Set(outs.map(t => t.targetName).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const outMats = [...new Set(outs.map(t => t.itemName).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  el('pg-ship').innerHTML = `
    <div class="ph"><div><h2><i class="ti ti-truck-delivery"></i>출고 현황</h2><p>현장·공장·거래처 출고 + 월별 분석</p></div>
      <button class="btn btn-pri btn-sm" onclick="openShipForm()"><i class="ti ti-plus"></i>출고 등록</button></div>
    <div class="stat-grid" style="grid-template-columns:repeat(2,1fr)">
      <div class="stat"><div class="ic b"><i class="ti ti-calendar-stats"></i></div><div class="v">${monthHebe.toFixed(0)}<span style="font-size:14px">㎡</span></div><div class="l">이번 달 출고</div><div class="s">${monthOut.length}건</div></div>
      <div class="stat"><div class="ic g"><i class="ti ti-package-export"></i></div><div class="v">${outs.length}</div><div class="l">총 출고 건수</div><div class="s">전체 누적</div></div>
    </div>
    <div class="card">
      <div class="card-h"><h3><i class="ti ti-list-details"></i>최근 출고</h3></div>
      ${(() => {
        const gmap = {}, groups = [];
        outs.forEach(t => { const k = t.shipId || t.id; if (!gmap[k]) { gmap[k] = { key: k, date: t.date, dest: t.dest || t.factory, targetName: t.targetName, by: t.by, items: [] }; groups.push(gmap[k]); } gmap[k].items.push(t); });
        const top = groups.slice(0, 10);
        return top.length ? top.map(g => {
          const totJang = g.items.reduce((a, b) => a + (+b.jang || 0), 0), totHebe = g.items.reduce((a, b) => a + (+b.hebe || 0), 0);
          return `<div class="card" style="margin-bottom:10px;padding:11px 13px">
            <div style="display:flex;justify-content:space-between;align-items:flex-start">
              <div><div style="font-weight:700;font-size:14px"><i class="ti ti-briefcase" style="color:var(--blue);font-size:14px"></i> ${esc(g.targetName || '-')}</div>
                <div style="font-size:12px;color:var(--t3);margin-top:2px">${esc(g.date)}${g.dest ? ' · → ' + esc(g.dest) : ''} · ${esc(g.by || '')}</div></div>
              ${isAdmin() ? `<button class="x" onclick="delShipGroup('${g.key}')" aria-label="삭제"><i class="ti ti-trash" style="font-size:16px;color:var(--red-t)"></i></button>` : ''}
            </div>
            <div style="margin-top:7px;font-size:13px">${g.items.map(t => `<div style="color:var(--t2)">· ${esc(t.itemName)} <b style="color:var(--t1)">${+t.jang || 0}장</b>${t.hebe ? ` (${(+t.hebe).toFixed(1)}㎡)` : ''}${t.lot ? ` · 롯트 ${esc(t.lot)}` : ''}${t.pattern ? ` · 패턴 ${esc(t.pattern)}` : ''}</div>`).join('')}</div>
            ${g.items.length > 1 ? `<div style="font-size:11.5px;color:var(--t3);margin-top:6px;text-align:right">합계 ${totJang}장 · ${totHebe.toFixed(1)}㎡</div>` : ''}
            <div style="margin-top:9px;text-align:right"><button class="btn btn-sm" onclick="printShipSlip('${g.key}')"><i class="ti ti-printer"></i>출고증 인쇄</button></div>
          </div>`;
        }).join('') : `<div class="empty"><i class="ti ti-inbox"></i>출고 내역 없음</div>`;
      })()}
    </div>
    <div class="card">
      <div class="card-h"><h3><i class="ti ti-table"></i>출고 내역 조회·추출</h3></div>
      <div class="frm">
        <div class="fld"><label>시작일</label><input type="date" id="r-from" oninput="shipReport()"></div>
        <div class="fld"><label>종료일</label><input type="date" id="r-to" oninput="shipReport()"></div>
        <div class="fld"><label>거래처</label><select id="r-client" onchange="shipReport()"><option value="">전체</option>${outClients.map(c => `<option>${esc(c)}</option>`).join('')}</select></div>
        <div class="fld"><label>자재</label><select id="r-mat" onchange="shipReport()"><option value="">전체</option>${outMats.map(c => `<option>${esc(c)}</option>`).join('')}</select></div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin:4px 0 8px;gap:8px;flex-wrap:wrap">
        <div style="font-size:13px;color:var(--t2)" id="r-sum">전체 기간</div>
        <button class="btn btn-sm btn-pri" onclick="downloadShipXls()"><i class="ti ti-file-spreadsheet"></i>엑셀 다운로드</button>
      </div>
      <div class="tbl-wrap" style="max-height:340px;overflow:auto">
        <table class="tbl"><thead><tr><th>날짜</th><th>거래처</th><th>자재</th><th>장수</th><th>헤베</th><th>출고지</th></tr></thead><tbody id="r-body"></tbody></table>
      </div>
    </div>
    <div class="card">
      <div class="card-h"><h3><i class="ti ti-chart-bar"></i>월별 출고 현황</h3><span class="more">${year}년</span></div>
      <div class="mchart">${monthly.map((v, i) => `<div class="mcol"><div class="val">${v ? v.toFixed(0) : ''}</div><div class="bb ${i === now.getMonth() ? 'cur' : ''}" style="height:${Math.max(2, v / maxM * 100)}%"></div><div class="lb">${i + 1}월</div></div>`).join('')}</div>
    </div>
    <div class="card">
      <div class="card-h"><h3><i class="ti ti-trophy"></i>출고 상위 제품</h3></div>
      ${top.length ? top.map(([nm, v], i) => `<div class="abar"><span class="rk">${i + 1}</span><span class="nm">${esc(nm)}</span><span class="tr"><i style="width:${v / maxT * 100}%"></i></span><span class="vv">${v.toFixed(0)}㎡</span></div>`).join('') : `<div class="empty"><i class="ti ti-chart-dots"></i>출고 데이터가 쌓이면 표시됩니다</div>`}
    </div>
    `;
  shipReport();
}
/* 출고 내역 조회·추출 (거래처/자재/기간별) */
function shipReportList() {
  const from = el('r-from') && el('r-from').value, to = el('r-to') && el('r-to').value;
  const cl = el('r-client') && el('r-client').value, mt = el('r-mat') && el('r-mat').value;
  return state.transactions.filter(t => t.type === 'out')
    .filter(t => (!from || (t.date || '') >= from) && (!to || (t.date || '') <= to) && (!cl || t.targetName === cl) && (!mt || t.itemName === mt))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}
function shipReport() {
  const list = shipReportList();
  const tj = list.reduce((a, b) => a + (+b.jang || 0), 0), th = list.reduce((a, b) => a + (+b.hebe || 0), 0);
  if (el('r-body')) el('r-body').innerHTML = list.length ? list.map(t => `<tr><td>${esc(t.date || '')}</td><td><b>${esc(t.targetName || '')}</b></td><td>${esc(t.itemName || '')}</td><td>${+t.jang || 0}장</td><td>${(+t.hebe || 0).toFixed(1)}㎡</td><td>${esc(t.dest || t.factory || '')}</td></tr>`).join('') : `<tr><td colspan="6"><div class="empty" style="padding:18px"><i class="ti ti-search-off"></i>해당 출고 내역이 없습니다</div></td></tr>`;
  if (el('r-sum')) el('r-sum').innerHTML = `${list.length}건 · 합계 <b style="color:var(--t1)">${tj}장 · ${th.toFixed(1)}㎡</b>`;
}
function downloadShipXls() {
  const list = shipReportList();
  if (!list.length) { toast('내보낼 내역이 없습니다'); return; }
  const from = el('r-from') && el('r-from').value, to = el('r-to') && el('r-to').value;
  const cl = el('r-client') && el('r-client').value, mt = el('r-mat') && el('r-mat').value;
  const period = (from || to) ? `${from || '처음'} ~ ${to || todayStr()}` : '전체 기간';
  const tj = list.reduce((a, b) => a + (+b.jang || 0), 0), th = list.reduce((a, b) => a + (+b.hebe || 0), 0);
  const TH = (t, w) => `<th style="background:#0F6E56;color:#ffffff;font-weight:bold;border:0.5pt solid #0a4f3e;padding:7px 10px;text-align:center" ${w ? 'width="' + w + '"' : ''}>${t}</th>`;
  const TD = (t, st) => `<td style="border:0.5pt solid #cfd8d4;padding:5px 10px;${st || ''}">${t}</td>`;
  const body = list.map((t, i) => {
    const bg = i % 2 ? 'background:#f3f6f4;' : '';
    return `<tr>${TD(esc(t.date || ''), bg)}${TD('<b>' + esc(t.itemName || '') + '</b>', bg)}${TD(esc(t.spec || ''), bg)}${TD((+t.jang || 0), bg + 'mso-number-format:\\#\\,\\#\\#0;text-align:right')}${TD((+t.hebe || 0).toFixed(2), bg + 'text-align:right')}${TD(esc(t.dest || t.factory || ''), bg)}${TD(esc(t.targetName || ''), bg)}${TD(esc(t.lot || ''), bg)}${TD(esc(t.by || ''), bg)}</tr>`;
  }).join('');
  const sumStyle = 'border:0.5pt solid #cfd8d4;background:#e1f5ee;color:#0a4f3e;font-weight:bold;padding:7px 10px';
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>출고내역</x:Name><x:WorksheetOptions><x:FreezePanes/><x:SplitHorizontal>3</x:SplitHorizontal><x:TopRowBottomPane>3</x:TopRowBottomPane></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]--></head><body>
<table style="border-collapse:collapse;font-family:'맑은 고딕','Malgun Gothic',sans-serif;font-size:10.5pt">
<tr><td colspan="9" style="font-size:16pt;font-weight:bold;color:#0F6E56;padding:8px 4px 2px">다우세라믹앤석재 · 출고 내역</td></tr>
<tr><td colspan="9" style="font-size:9pt;color:#777;padding:0 4px 10px">기간 ${period}  ·  거래처 ${cl || '전체'}  ·  자재 ${mt || '전체'}  ·  생성일 ${todayStr()}  ·  총 ${list.length}건</td></tr>
<tr>${TH('출고일', 90)}${TH('자재명', 150)}${TH('규격', 110)}${TH('장수', 60)}${TH('헤베(㎡)', 80)}${TH('출고지', 120)}${TH('거래처', 120)}${TH('롯트', 110)}${TH('담당', 80)}</tr>
${body}
<tr><td colspan="3" style="${sumStyle};text-align:right">합계</td><td style="${sumStyle};text-align:right">${tj}</td><td style="${sumStyle};text-align:right">${th.toFixed(2)}</td><td colspan="4" style="${sumStyle}"></td></tr>
</table></body></html>`;
  const blob = new Blob(['﻿' + html], { type: 'application/vnd.ms-excel;charset=utf-8;' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = '출고내역_' + todayStr() + '.xls'; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
  toast('엑셀 다운로드 (' + list.length + '건)');
}
/* 출고표(출고증) 인쇄 — 회사 양식 기준. 출고 묶음(shipId) 단위로 발행 */
const DAWOO_CO = {
  name: '주식회사 다우세라믹 &amp; 석재',
  addr: '경기도 용인시 처인구 모현읍 곡현로 425, 2동',
  tel: 'Tel ) 070-8211-0144　Fax ) 0503-8379-3628',
  biztype: '건설업 도소매',
  ceo: 'LIN CHANGJIE',
  bizno: '711-86-03547',
  email: 'dawoost@naver.com',
  web: 'www.dawoostone.kr'
};
function printShipSlip(key) {
  const items = state.transactions.filter(t => t.type === 'out' && (t.shipId || t.id) === key)
    .sort((a, b) => (a.itemName || '').localeCompare(b.itemName || ''));
  if (!items.length) { toast('출고 내역을 찾을 수 없습니다'); return; }
  const g = items[0];
  const e = s => esc(s == null ? '' : String(s));
  const totJang = items.reduce((a, b) => a + (+b.jang || 0), 0);
  const totHebe = items.reduce((a, b) => a + (+b.hebe || 0), 0);
  // 문서번호: 출고일(YYYYMMDD) + 당일 출고 순번
  const dayKeys = [...new Set(state.transactions.filter(t => t.type === 'out' && (t.date || '') === (g.date || '')).map(t => t.shipId || t.id))].sort();
  const seq = Math.max(1, dayKeys.indexOf(key) + 1);
  const docNo = (g.date || '').replace(/-/g, '') + '-' + seq;
  const route = (g.note && g.note.trim()) ? e(g.note) : ((g.dest || '') ? e(g.dest) + ' 상차 → ' + e(g.targetName || '') + ' 하차' : '');
  const MINROWS = 8;
  let rows = items.map((t, i) => `<tr>
      <td class="c">${i + 1}</td>
      <td class="l">${e(t.itemName)}</td>
      <td class="c">${e(t.unit || '㎡')}</td>
      <td class="c">${e(t.spec)}</td>
      <td class="r">${t.hebe ? (+t.hebe).toFixed(2) : ''}</td>
      <td class="r">${+t.jang || 0}</td>
      <td class="l">${e([t.pattern, t.lot ? '롯트 ' + t.lot : ''].filter(Boolean).join(' · '))}</td>
    </tr>`).join('');
  for (let i = items.length; i < MINROWS; i++) rows += `<tr><td class="c">${i + 1}</td><td></td><td></td><td></td><td></td><td></td><td></td></tr>`;
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>출고표 ${e(g.targetName)} ${e(g.date)}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:'맑은 고딕','Malgun Gothic','Apple SD Gothic Neo',sans-serif;color:#111;margin:0;padding:22px 26px}
  table{border-collapse:collapse;width:100%}
  .top{table-layout:fixed}
  .top td{border:1px solid #444;padding:8px 10px;vertical-align:middle}
  .doc{padding:0!important;text-align:center}
  .doc .dl{border-bottom:1px solid #444;padding:9px 6px;letter-spacing:4px;font-size:13px;font-weight:600}
  .doc .dv{padding:9px 6px;font-size:13.5px}
  .title{text-align:center;font-size:30px;font-weight:800;letter-spacing:16px}
  .issue{text-align:center;font-size:14px}
  .issue .ik{letter-spacing:4px;font-weight:600;margin-right:20px}
  .conm{text-align:center;font-size:18px;font-weight:800}
  .recip{text-align:center;vertical-align:middle}
  .recip .rn{font-size:24px;font-weight:800}
  .recip .rt{font-size:16px;font-weight:600;margin-top:30px}
  .ck{text-align:center;font-weight:700;background:#f4f4f4;white-space:nowrap}
  .cv{font-size:13.5px}
  .cv .tel{font-size:12px;color:#333}
  .web{text-align:center;font-weight:800;text-decoration:underline;letter-spacing:1px}
  .items{table-layout:fixed;margin-top:14px}
  .items th{border:1px solid #444;background:#eee;padding:8px 6px;font-size:13.5px;font-weight:700}
  .items td{border:1px solid #444;padding:7px 6px;font-size:13px;height:31px}
  .items td.c{text-align:center}.items td.r{text-align:right;padding-right:9px}.items td.l{text-align:left;padding-left:9px}
  .items tfoot td{font-weight:800;background:#faf7ee}
  .who{table-layout:fixed;margin-top:12px}
  .who td{border:1px solid #444;padding:8px 10px;font-size:13px}
  .who .wk{text-align:center;font-weight:700;background:#f4f4f4;width:16%}
  @media print{body{padding:8px 10px}}
</style></head><body>
  <table class="top">
    <colgroup><col style="width:27%"><col style="width:14%"><col style="width:59%"></colgroup>
    <tr>
      <td class="doc"><div class="dl">문 서 번 호</div><div class="dv">${docNo}</div></td>
      <td class="title" colspan="2">출 고 표</td>
    </tr>
    <tr>
      <td class="issue"><span class="ik">발 행 일 자</span>${e(g.date)}</td>
      <td class="conm" colspan="2">${DAWOO_CO.name}</td>
    </tr>
    <tr>
      <td class="recip" rowspan="6"><div class="rn">${e(g.targetName)}</div><div class="rt">${route}</div></td>
      <td class="ck">주 소</td><td class="cv">${DAWOO_CO.addr}<br><span class="tel">${DAWOO_CO.tel}</span></td>
    </tr>
    <tr><td class="ck">업 태</td><td class="cv">${DAWOO_CO.biztype}</td></tr>
    <tr><td class="ck">대표이사</td><td class="cv">${DAWOO_CO.ceo}</td></tr>
    <tr><td class="ck">등록번호</td><td class="cv">${DAWOO_CO.bizno}</td></tr>
    <tr><td class="ck">E-mail</td><td class="cv">${DAWOO_CO.email}</td></tr>
    <tr><td class="web" colspan="2">${DAWOO_CO.web}</td></tr>
  </table>
  <table class="items">
    <colgroup><col style="width:6%"><col style="width:30%"><col style="width:8%"><col style="width:16%"><col style="width:12%"><col style="width:10%"><col style="width:18%"></colgroup>
    <thead><tr><th>NO</th><th>품명</th><th>단위</th><th>규격</th><th>면적</th><th>수량</th><th>비고</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td class="c" colspan="4">합 계</td><td class="r">${totHebe.toFixed(2)}</td><td class="r">${totJang}</td><td></td></tr></tfoot>
  </table>
  <table class="who">
    <tr><td class="wk">담당자</td><td>${e(g.manager)}</td><td class="wk">출고 담당자</td><td>${e(g.by)}</td></tr>
  </table>
</body></html>`;
  const w = window.open('', '_blank');
  if (!w) { toast('팝업이 차단되었습니다. 팝업 허용 후 다시 시도하세요'); return; }
  w.document.write(html); w.document.close(); w.focus();
  setTimeout(() => { try { w.print(); } catch (e) { } }, 350);
}
function openShipForm(pre) {
  _mrowPattern = true;
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-logout"></i>출고 등록</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="frm">
      <div class="fld full"><label>업체명<span class="req">*</span></label>${searchBox('o-targetName', '업체명 검색·입력', '', 'companyNames', '')}</div>
      <div class="fld full"><label>출고 자재 / 장수 / 롯트 / 패턴<span class="req">*</span> <span style="color:var(--t3);font-weight:500">(여러 자재는 '자재 추가')</span></label>${matRowsHtml(pre && pre.items && pre.items.length ? pre.items : (pre && pre.material ? [{ name: pre.material, qty: pre.jang, lot: pre.lot, pattern: pre.pattern }] : [{}]), '장수')}</div>
      <div class="fld"><label>출고일<span class="req">*</span></label><input type="date" id="o-date" value="${todayStr()}"></div>
      <div class="fld"><label>담당자 <span style="color:var(--t3);font-weight:500">(현장/거래)</span></label><input id="o-manager" value="${esc((pre && pre.manager) || '')}" placeholder="담당자" autocomplete="off"></div>
      <div class="fld full"><label>출고지(공장/현장)<span class="req">*</span></label>
        <select id="o-dest" onchange="onShipDest()">
          <option value="">선택…</option>
          ${state.factories.slice().sort((a, b) => (a.value || '').localeCompare(b.value || '')).map(f => `<option value="${esc(f.value)}">${esc(f.value)} (공장)</option>`).join('')}
          <option value="__manual">직접 입력 (현장·기타)</option>
        </select>
      </div>
      <div class="fld full hidden" id="o-dest-manual"><label>출고지 직접 입력</label><input id="o-dest-text" placeholder="현장명/출고지 입력" autocomplete="off"></div>
      <div class="fld full"><label>메모</label><input id="o-note" placeholder="선택"></div>
    </div>
    <div class="frm-foot"><button class="btn" style="flex:1" onclick="closeModal()">취소</button><button class="btn btn-pri" style="flex:2" onclick="submitShip()"><i class="ti ti-check"></i>출고 등록</button></div>`);
  if (pre && pre.targetName && el('o-targetName')) el('o-targetName').value = pre.targetName;
  mrowLotRefresh();
}
function pickOutItem() {
  const id = el('o-pick') && el('o-pick').value; if (!id) return;
  const it = state.inventory.find(i => i.id === id); if (!it) return;
  el('o-material').value = it.name; computeOutHebe();
}
function onShipDest() {
  const sel = el('o-dest'), box = el('o-dest-manual');
  if (!sel || !box) return;
  if (sel.value === '__manual') { box.classList.remove('hidden'); setTimeout(() => el('o-dest-text') && el('o-dest-text').focus(), 50); }
  else box.classList.add('hidden');
}
function shipDestValue() {
  const sel = el('o-dest'); if (!sel) return '';
  if (sel.value === '__manual') return (el('o-dest-text') && el('o-dest-text').value || '').trim();
  return sel.value;
}
function shipMatchedItem() { const nm = (el('o-material') && el('o-material').value || '').trim(); return nm ? state.inventory.find(i => i.name === nm) : null; }
function computeOutHebe() {
  const info = el('o-hebe-info');
  const nm = (el('o-material') && el('o-material').value || '').trim();
  // 롯트별 재고 표시 + 선택
  const wrap = el('o-lot-wrap');
  if (wrap) {
    const lots = lotStock(nm).filter(l => l.lot !== '(미지정)');
    if (lots.length) {
      const sel = el('o-lot'); const cur = sel ? sel.value : '';
      if (sel) sel.innerHTML = lotSelectHtml(nm, cur);
      if (el('o-lot-bd')) el('o-lot-bd').innerHTML = lotBreakdownText(nm);
      wrap.style.display = '';
    } else { wrap.style.display = 'none'; }
  }
  const pwrap = el('o-pattern-wrap');
  if (pwrap) {
    const pats = patternList(nm);
    if (pats.length) { const psel = el('o-pattern'); const pcur = psel ? psel.value : ''; if (psel) psel.innerHTML = patternSelectHtml(nm, pcur); pwrap.style.display = ''; }
    else { pwrap.style.display = 'none'; }
  }
  if (!info) return;
  const it = shipMatchedItem(); const jang = parseFloat(el('o-jang').value) || 0;
  if (it) info.innerHTML = `<span class="rl">재고 연동</span><span class="rv"><b>${(jang * (+it.hebePerJang || 0)).toFixed(2)}㎡</b><small>${esc(it.name)} · 출고 시 ${jang}장 차감</small></span>`;
  else info.innerHTML = `<span class="rl">재고 미연동</span><span class="rv" style="color:var(--t3)">출고 기록만 남김 (재고 차감 없음)</span>`;
}
async function submitShip() {
  const targetName = el('o-targetName').value.trim();
  const rows = collectMaterialRows();
  const date = el('o-date').value;
  if (!targetName) { toast('업체명을 입력하세요'); return; }
  if (!rows.length) { toast('출고 자재와 장수를 입력하세요'); return; }
  if (!date) { toast('출고일을 선택하세요'); return; }
  const dest = shipDestValue();
  if (!dest) { toast('출고지(공장/현장)를 입력하세요'); return; }
  if (_busy) return; _busy = true;
  try {
    const shipId = 'S' + Date.now();
    const note = el('o-note').value.trim();
    const manager = el('o-manager') ? el('o-manager').value.trim() : '';
    let totalJang = 0; const zeroed = [];
    for (const r of rows) {
      const material = r.name, jang = r.qty;
      const it = state.inventory.find(i => i.name === material);
      const oldJang = it ? (+it.jang || 0) : 0;
      const newJang = Math.max(0, oldJang - jang);
      const hebe = it ? +(jang * (+it.hebePerJang || 0)).toFixed(2) : 0;
      if (it) await Store.update('inventory', it.id, { jang: newJang });
      await Store.add('transactions', { type: 'out', shipId, itemId: it ? it.id : '', itemName: material, spec: it ? it.spec : '', hebe, jang, lot: r.lot, pattern: r.pattern, dest, factory: dest, target: '', targetName, date, note, manager, by: me.name });
      totalJang += jang;
      if (it && oldJang > 0 && newJang <= 0) zeroed.push(material);
    }
    if (_holdConfirm) { await Store.update('holdings', _holdConfirm, { status: '확정', shippedDate: date, shippedJang: totalJang }); _holdConfirm = null; }
    for (const nm of zeroed) notifyStockOut(nm);   // 재고 소진 → 즉시 푸시
    toast(`출고 완료 · ${rows.length}개 자재 · ${totalJang}장`); closeModal();
  } finally { _busy = false; }
}
/* 출고 삭제 (관리자) — 재고 연동분 자동 복구(+장수) */
async function delShip(id) {
  if (!isAdmin()) { toast('관리자만 삭제할 수 있습니다'); return; }
  const t = state.transactions.find(x => x.id === id); if (!t) return;
  if (!confirm(`이 출고를 삭제할까요?\n${t.itemName} ${t.jang}장 · ${t.date}\n재고 연동분은 자동 복구됩니다.`)) return;
  if (t.itemId) { const it = state.inventory.find(i => i.id === t.itemId); if (it) await Store.update('inventory', it.id, { jang: (+it.jang || 0) + (+t.jang || 0) }); }
  await Store.remove('transactions', id);
  toast('출고 삭제됨 (재고 복구)');
}
/* 출고 묶음 삭제 (관리자) — 같은 shipId 전체 복구 */
async function delShipGroup(key) {
  if (!isAdmin()) { toast('관리자만 삭제할 수 있습니다'); return; }
  const list = state.transactions.filter(t => t.type === 'out' && (t.shipId || t.id) === key);
  if (!list.length) return;
  if (!confirm(`이 출고(${list.length}건)를 삭제할까요?\n${list.map(t => `${t.itemName} ${t.jang}장`).join(', ')}\n재고 연동분은 자동 복구됩니다.`)) return;
  for (const t of list) {
    if (t.itemId) { const it = state.inventory.find(i => i.id === t.itemId); if (it) await Store.update('inventory', it.id, { jang: (+it.jang || 0) + (+t.jang || 0) }); }
    await Store.remove('transactions', t.id);
  }
  toast(`출고 ${list.length}건 삭제됨 (재고 복구)`);
}
/* 입고 삭제 (관리자) — 오입고 정정: 재고에서 그만큼 차감(되돌림) */
async function delIn(id) {
  if (!isAdmin()) { toast('관리자만 삭제할 수 있습니다'); return; }
  const t = state.transactions.find(x => x.id === id); if (!t) return;
  if (!confirm(`이 입고를 삭제할까요?\n${t.itemName} ${t.jang}장 · 롯트 ${t.lot || '-'} · ${t.date}\n재고에서 그만큼 되돌립니다. (수정하려면 삭제 후 다시 입고)`)) return;
  if (t.itemId) { const it = state.inventory.find(i => i.id === t.itemId); if (it) await Store.update('inventory', it.id, { jang: Math.max(0, (+it.jang || 0) - (+t.jang || 0)) }); }
  await Store.remove('transactions', id);
  toast('입고 삭제됨 (재고 되돌림)');
}

/* ===================================================================
   홀딩 (업체 · 장수/헤베 · 사용일정)
   =================================================================== */
function holdMatchesSearch(h) {
  const q = (filters.holdSearch || '').trim().toLowerCase();
  if (!q) return true;
  if ((h.vendor || '').toLowerCase().includes(q)) return true;
  if ((h.forSiteName || '').toLowerCase().includes(q)) return true;
  return holdItems(h).some(it => (it.materialName || '').toLowerCase().includes(q));
}
function holdCardHtml(h) {
  const d = daysFromNow(h.useDate);
  const conf = h.status === '확정';
  const plan = h.status === '예정';
  const rel = h.status === '해제';
  const cls = conf ? 'p-done' : (d != null && d >= 0 && d <= 3 ? 'p-wait' : 'p-hold');
  return `<div class="card" style="margin-bottom:11px;${conf ? 'opacity:.92' : ''}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
          <div><div style="font-size:15px;font-weight:700">${esc(h.vendor || '-')}</div><div style="font-size:12.5px;color:var(--t2);margin-top:2px">${holdItems(h).map(it => esc(it.materialName)).filter(Boolean).join(', ')}</div>${h.forSiteName ? `<div style="margin-top:5px"><span class="pill p-hold"><i class="ti ti-building-community"></i>${esc(h.forSiteName)}</span></div>` : ''}</div>
          ${rel ? `<span class="pill p-gray"><i class="ti ti-lock-open"></i>해제됨</span>` : (conf ? `<span class="pill p-done"><i class="ti ti-circle-check"></i>확정</span>` : (plan ? `<span class="pill p-wait"><i class="ti ti-clock-pause"></i>예정 · 입고대기</span>` : `<span class="pill ${cls}"><i class="ti ti-calendar"></i>${h.useDate || '미정'}${d != null && d >= 0 && d <= 7 ? ' · D-' + d : ''}</span>`))}
        </div>
        <div style="font-size:13px;margin-bottom:4px">
          ${holdItems(h).map(it => `<div style="color:var(--t2)">${esc(it.materialName || '-')} · <b style="color:var(--t1)">${+it.jang || 0}장</b>${it.hebe ? ` (${(+it.hebe).toFixed(1)}㎡)` : ''}${it.lot ? ` · 롯트 ${esc(it.lot)}` : ''}${it.pattern ? ` · 패턴 ${esc(it.pattern)}` : ''}</div>`).join('')}
        </div>
        ${conf ? `<div style="font-size:12px;color:var(--lime-t);margin-top:4px"><i class="ti ti-truck-delivery"></i> 출고 완료 ${esc(h.shippedDate || '')} · ${+h.shippedJang || 0}장</div>` : ''}
        ${plan ? `<div style="font-size:12px;color:var(--amber-t);margin-top:4px"><i class="ti ti-clock-pause"></i> 입고되면 자동으로 홀딩으로 전환됩니다</div>` : ''}
        ${rel && h.releasedAuto ? `<div style="font-size:12px;color:var(--t3);margin-top:4px"><i class="ti ti-history"></i> 사용예정일 경과로 자동 해제됨 (${esc(h.releasedDate || '')})</div>` : ''}
        ${h.note ? `<div style="font-size:12px;color:var(--t3);margin-top:6px">${esc(h.note)}</div>` : ''}
        ${rel ? `<div style="display:flex;gap:8px;margin-top:10px"><button class="btn btn-sm" style="flex:1" onclick="restoreHold('${h.id}')"><i class="ti ti-refresh"></i>복원</button>${isAdmin() ? `<button class="btn btn-sm btn-danger" onclick="delHold('${h.id}')"><i class="ti ti-trash"></i>영구삭제</button>` : ''}</div>` : (conf ? `<div style="display:flex;gap:8px;margin-top:10px"><button class="btn btn-sm" style="flex:1" onclick="openHoldForm('${h.id}')"><i class="ti ti-edit"></i>수정</button>${isAdmin() ? `<button class="btn btn-sm btn-danger" onclick="delHold('${h.id}')"><i class="ti ti-trash"></i>삭제</button>` : ''}</div>` : (plan ? `
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="btn btn-sm" style="flex:1" onclick="openHoldForm('${h.id}')"><i class="ti ti-edit"></i>수정</button>
          <button class="btn btn-sm" style="flex:1" onclick="releaseHold('${h.id}')"><i class="ti ti-lock-open"></i>해제</button>
          ${isAdmin() ? `<button class="btn btn-sm btn-danger" onclick="delHold('${h.id}')"><i class="ti ti-trash"></i>삭제</button>` : ''}
        </div>` : `
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="btn btn-pri btn-sm" style="flex:1" onclick="holdToSite('${h.id}')"><i class="ti ti-building-community"></i>현장으로</button>
          <button class="btn btn-pri btn-sm" style="flex:1;background:var(--blue);border-color:var(--blue)" onclick="holdToShip('${h.id}')"><i class="ti ti-truck-delivery"></i>출고로</button>
        </div>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="btn btn-sm" style="flex:1" onclick="openHoldForm('${h.id}')"><i class="ti ti-edit"></i>수정</button>
          <button class="btn btn-sm" style="flex:1" onclick="releaseHold('${h.id}')"><i class="ti ti-lock-open"></i>해제</button>
          ${isAdmin() ? `<button class="btn btn-sm btn-danger" onclick="delHold('${h.id}')"><i class="ti ti-trash"></i>삭제</button>` : ''}
        </div>`))}
      </div>`;
}
function holdGroupedHtml(list, keyFn, icon) {
  const map = new Map();
  list.forEach(h => keyFn(h).forEach(k => {
    if (!map.has(k)) map.set(k, []);
    const arr = map.get(k); if (!arr.some(x => x.id === h.id)) arr.push(h);
  }));
  const keys = [...map.keys()].sort((a, b) => a.localeCompare(b));
  if (!keys.length) return `<div class="empty"><i class="ti ti-lock-off"></i>해당하는 홀딩이 없습니다</div>`;
  return keys.map(k => `<div class="sec-label" style="margin-top:8px"><i class="ti ${icon}"></i> ${esc(k)} <span style="color:var(--t3);font-weight:500">· ${map.get(k).length}건</span></div>${map.get(k).map(holdCardHtml).join('')}`).join('');
}
function renderHold() {
  const isResv = h => (h.status || '홀딩') === '홀딩';
  const released = state.holdings.filter(h => h.status === '해제');
  const list = state.holdings.filter(h => (filters.holdArchive ? true : h.status !== '해제') && holdMatchesSearch(h)).sort((a, b) => {
    const ra = isResv(a) ? 0 : 1, rb = isResv(b) ? 0 : 1;
    if (ra !== rb) return ra - rb;
    return (a.useDate || '9999-99-99').localeCompare(b.useDate || '9999-99-99'); // 기한 임박순
  });
  const reserved = list.filter(isResv);
  const planned = list.filter(h => h.status === '예정');
  const confirmed = list.filter(h => h.status === '확정');
  const soon = reserved.filter(h => { const d = daysFromNow(h.useDate); return d != null && d >= 0 && d <= 3; });
  const g = filters.holdGroup || 'none';
  const gchip = (v, label, ic) => `<button class="chip ${g === v ? 'active' : ''}" onclick="filters.holdGroup='${v}';renderHold()"><i class="ti ${ic}"></i> ${label}</button>`;
  let body;
  if (!list.length) body = `<div class="empty"><i class="ti ti-lock-off"></i>${(filters.holdSearch || '').trim() ? '검색 결과가 없습니다' : '홀딩이 없습니다'}</div>`;
  else if (g === 'material') body = holdGroupedHtml(list, h => { const ms = holdItems(h).map(it => it.materialName || '(자재 미지정)'); return ms.length ? [...new Set(ms)] : ['(자재 미지정)']; }, 'ti-box');
  else if (g === 'vendor') body = holdGroupedHtml(list, h => [h.vendor || '(업체 미지정)'], 'ti-briefcase');
  else body = list.map(holdCardHtml).join('');
  el('pg-hold').innerHTML = `
    <div class="ph"><div><h2><i class="ti ti-lock"></i>자재 홀딩</h2><p>예약 → 출고 시 '확정' · 재고 부족 시 예정홀딩</p></div>
      <button class="btn btn-pri btn-sm" onclick="openHoldForm()"><i class="ti ti-plus"></i>홀딩 등록</button></div>
    <div class="stat-grid" style="grid-template-columns:repeat(3,1fr)">
      <div class="stat"><div class="ic b"><i class="ti ti-lock"></i></div><div class="v">${reserved.length}</div><div class="l">홀딩 중</div><div class="s">임박 ${soon.length}</div></div>
      <div class="stat"><div class="ic a"><i class="ti ti-clock-pause"></i></div><div class="v" style="color:${planned.length ? 'var(--amber-t)' : 'inherit'}">${planned.length}</div><div class="l">예정홀딩</div><div class="s">입고 대기</div></div>
      <div class="stat"><div class="ic g"><i class="ti ti-circle-check"></i></div><div class="v">${confirmed.length}</div><div class="l">확정</div><div class="s">출고완료</div></div>
    </div>
    <div class="search-box">
      <i class="ti ti-search"></i>
      <input id="hold-search" placeholder="업체명·자재명 검색" value="${esc(filters.holdSearch || '')}" oninput="filters.holdSearch=this.value;renderHold();setTimeout(()=>{const i=el('hold-search');if(i){i.focus();i.setSelectionRange(i.value.length,i.value.length);}},20)" autocomplete="off">
      ${(filters.holdSearch || '').trim() ? `<button class="search-x" onclick="filters.holdSearch='';renderHold()"><i class="ti ti-x"></i></button>` : ''}
    </div>
    <div class="chips">${gchip('none', '전체', 'ti-list')}${gchip('material', '자재별', 'ti-box')}${gchip('vendor', '업체별', 'ti-briefcase')}</div>
    <button class="btn btn-block" style="margin-bottom:10px" onclick="filters.holdArchive=!filters.holdArchive;renderHold()"><i class="ti ti-history"></i>${filters.holdArchive ? '지난·해제 내역 숨기기' : '지난·해제 내역 보기'}${released.length ? ' (' + released.length + '건)' : ''}</button>
    ${body}`;
}
function openHoldForm(id, pre) {
  const h = id ? state.holdings.find(x => x.id === id) : null; const v = h || Object.assign({}, pre || {});
  _mrowPattern = true;
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-lock-plus"></i>${h ? '홀딩 수정' : '홀딩 등록'}</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="frm">
      ${state.sites.length ? `<div class="fld full"><label><i class="ti ti-building-community" style="font-size:13px;color:var(--blue)"></i> 현장에서 선택 <span style="color:var(--t3);font-weight:500">— 고르면 자재·수량·시공일 자동 입력</span></label><select id="h-site" onchange="pickHoldSite()"><option value="">— 직접 입력 —</option>${siteOptions(v.forSiteId || '')}</select></div>` : ''}
      <div class="fld"><label>업체/거래처<span class="req">*</span></label>${searchBox('h-vendor', '업체명 검색·입력', v.vendor, 'companyNames', '')}</div>
      <div class="fld"><label>사용 예정일</label><input type="date" id="h-useDate" value="${esc(v.useDate || '')}"></div>
      <div class="fld full"><label>자재 / 장수 / 롯트 <span style="color:var(--t3);font-weight:500">(여러 종류면 '자재 추가')</span></label>${matRowsHtml(holdItems(v).map(it => ({ name: it.materialName, qty: it.jang || '', lot: it.lot })), '장수')}</div>
      <div class="fld full"><label>메모</label><input id="h-note" value="${esc(v.note || '')}" placeholder="선택"></div>
    </div>
    <div class="frm-foot">
      <button class="btn" style="flex:1" onclick="closeModal()">취소</button>
      <button class="btn btn-pri" style="flex:2" onclick="submitHold('${id || ''}')"><i class="ti ti-check"></i>${h ? '저장' : '등록'}</button>
    </div>`);
  mrowLotRefresh();
}
/* 홀딩 자재명 옆에 잔여 재고 표시 + 헤베 자동환산 */
function onHoldMaterial() {
  const nm = (el('h-material') && el('h-material').value || '').trim();
  const box = el('h-stock');
  const it = state.inventory.find(i => i.name === nm);
  if (box) {
    if (it) { const av = availJang(it); box.innerHTML = `· 가용 <b style="color:${av <= 0 ? 'var(--red-t)' : 'var(--gd)'}">${av}장</b> / 실재고 ${+it.jang || 0}장`; }
    else if (nm) box.innerHTML = `· <span style="color:var(--amber-t)">재고에 없는 자재 (입고 시 자동 전환)</span>`;
    else box.textContent = '';
  }
  const wrap = el('h-lot-wrap');
  if (wrap) {
    const lots = lotStock(nm).filter(l => l.lot !== '(미지정)');
    if (lots.length) {
      const sel = el('h-lot'); const cur = sel ? sel.value : '';
      if (sel) sel.innerHTML = lotSelectHtml(nm, cur);
      if (el('h-lot-bd')) el('h-lot-bd').innerHTML = lotBreakdownText(nm);
      wrap.style.display = '';
    } else { wrap.style.display = 'none'; }
  }
  onHoldQty();
}
/* 홀딩 장수 → 헤베 자동환산 (자재가 재고에 있을 때, 장당 헤베 사용) */
function onHoldQty() {
  const nm = (el('h-material') && el('h-material').value || '').trim();
  const it = state.inventory.find(i => i.name === nm);
  const jang = parseFloat(el('h-jang') && el('h-jang').value) || 0;
  if (it && el('h-hebe')) el('h-hebe').value = (jang * (+it.hebePerJang || 0)).toFixed(2);
}
function pickHoldSite() {
  const id = el('h-site').value; if (!id) return;
  const s = state.sites.find(x => x.id === id); if (!s) return;
  const box = el('mat-rows');
  if (box) { box.innerHTML = ''; const its = siteItems(s); (its.length ? its : [{}]).forEach(it => addMaterialRow({ name: it.name, qty: it.qty, lot: it.lot }, '장수')); }
  if (s.constructDate && !el('h-useDate').value) el('h-useDate').value = s.constructDate;
  toast('현장 정보를 불러왔습니다');
}
async function submitHold(id) {
  const vendor = el('h-vendor').value.trim(); if (!vendor) { toast('업체를 입력하세요'); return; }
  const siteId = el('h-site') ? el('h-site').value : '';
  const siteName = siteId ? ((state.sites.find(s => s.id === siteId) || {}).name || '') : '';
  const rows = collectMaterialRows();
  if (!rows.length) { toast('자재명과 장수를 입력하세요'); return; }
  const items = rows.map(r => { const it = state.inventory.find(i => i.name === r.name); return { materialName: r.name, jang: r.qty, hebe: it ? +(r.qty * (+it.hebePerJang || 0)).toFixed(2) : 0, lot: r.lot, pattern: r.pattern || '' }; });
  // 모든 자재가 가용 범위(편집 중인 자신 제외)에 들면 '홀딩', 하나라도 부족하면 '예정'
  function availExcl(mat) {
    const it = state.inventory.find(i => _normName(i.name) === _normName(mat)); const phys = it ? +it.jang || 0 : 0;
    let held = 0; state.holdings.forEach(h => { if (h.id === id) return; if ((h.status || '홀딩') !== '홀딩') return; holdItems(h).forEach(x => { if (_normName(x.materialName) === _normName(mat)) held += (+x.jang || 0); }); });
    return phys - held;
  }
  const fits = items.every(it => availExcl(it.materialName) >= it.jang);
  const status = fits ? '홀딩' : '예정';
  const obj = { vendor, items, materialName: items[0].materialName, jang: items[0].jang, hebe: items[0].hebe, lot: items[0].lot, useDate: el('h-useDate').value, note: el('h-note').value.trim(), status, forSiteId: siteId, forSiteName: siteName, by: me.name };
  if (id) await Store.update('holdings', id, obj); else await Store.add('holdings', obj);
  toast(status === '예정' ? '예정홀딩으로 등록 — 입고되면 자동 전환' : (id ? '저장됨' : '홀딩 등록 완료')); closeModal();
}
async function releaseHold(id) { if (!confirm('홀딩을 해제할까요? (기록은 남고 목록에서만 빠집니다 — 지난·해제 내역 보기에서 다시 볼 수 있음)')) return; await Store.update('holdings', id, { status: '해제' }); toast('홀딩 해제됨'); }
async function restoreHold(id) { await Store.update('holdings', id, { status: '홀딩' }); toast('홀딩으로 복원됨'); }
async function delHold(id) {
  if (!isAdmin()) { toast('관리자만 삭제할 수 있습니다'); return; }
  const h = state.holdings.find(x => x.id === id); if (!h) return;
  if (!confirm(`이 홀딩을 완전히 삭제할까요?\n${h.vendor || ''} · ${h.materialName || ''} ${h.jang || 0}장`)) return;
  await Store.remove('holdings', id); toast('홀딩 삭제됨');
}

/* 홀딩 → 현장 연결 (홀딩은 그대로 살아있고, 현장에 연결만) */
function holdToSite(id) {
  const h = state.holdings.find(x => x.id === id); if (!h) return;
  _holdLinkSite = id;
  openSiteForm(null, { items: holdItems(h).map(it => ({ name: it.materialName, qty: it.jang, lot: it.lot })), client: h.vendor, note: '홀딩 연결' });
}
/* 홀딩 → 출고 (출고가 찍히면 그 홀딩이 '확정'으로). 다자재면 첫 자재부터 — 나머지는 따로 출고 */
function holdToShip(id) {
  const h = state.holdings.find(x => x.id === id); if (!h) return;
  _holdConfirm = id;
  openShipForm({ items: holdItems(h).map(it => ({ name: it.materialName, qty: it.jang, lot: it.lot, pattern: it.pattern })), targetName: h.forSiteName || h.vendor || '' });
}

/* ===================================================================
   설정
   =================================================================== */
function renderSettings() {
  el('pg-settings').innerHTML = `
    <div class="ph"><div><h2><i class="ti ti-settings"></i>설정</h2><p>${esc(me.name)} 님${isAdmin() ? ' · 관리자' : ''}</p></div></div>
    <div class="card">
      <div class="card-h"><h3><i class="ti ti-users"></i>직원 관리</h3>${isAdmin() ? `<button class="more" onclick="openMemberForm()"><i class="ti ti-plus"></i>추가</button>` : ''}</div>
      ${state.members.map(m => `<div class="mem"><div class="av">${esc(initial(m.name))}</div><div class="info"><div class="nm">${esc(m.name)}</div>${isAdmin() ? `<div class="rl">${esc(m.email || '이메일 미설정')}</div>` : ''}</div>${isAdmin() ? `<span class="pill ${m.role === 'admin' ? 'p-prog' : 'p-gray'}">${m.role === 'admin' ? '관리자' : '직원'}</span><button class="x" onclick="openMemberForm('${m.id}')"><i class="ti ti-edit" style="font-size:17px"></i></button>` : ''}</div>`).join('')}
    </div>
    <div class="card">
      <div class="card-h"><h3><i class="ti ti-briefcase"></i>거래처 관리</h3>${isAdmin() && (state.clients || []).length ? `<button class="more" style="color:var(--red-t)" onclick="delAllClients()"><i class="ti ti-trash" style="font-size:14px"></i>전체 삭제</button>` : ''}</div>
      <div style="display:flex;gap:8px;margin-bottom:10px"><input id="client-new" placeholder="거래처명 입력" autocomplete="off" style="flex:1;font-size:16px;padding:11px 12px;border:1.5px solid var(--bd2);border-radius:10px"><button class="btn btn-pri btn-sm" onclick="addClient()"><i class="ti ti-plus"></i>등록</button></div>
      ${(state.clients || []).length ? state.clients.slice().sort((a, b) => (a.value || '').localeCompare(b.value || '')).map(c => `<div class="mem"><div class="info"><div class="nm">${esc(c.value)}</div></div>${isAdmin() ? `<button class="x" onclick="delClient('${c.id}')" aria-label="삭제"><i class="ti ti-trash" style="font-size:16px;color:var(--red-t)"></i></button>` : ''}</div>`).join('') : `<div style="font-size:12.5px;color:var(--t3);padding:4px 0">등록된 거래처가 없습니다. 등록하면 현장·출고·홀딩의 업체명 검색에 나옵니다.</div>`}
      ${!isAdmin() ? `<div class="banner info" style="margin-top:10px"><i class="ti ti-info-circle"></i>거래처 삭제는 관리자만 가능합니다.</div>` : ''}
    </div>
    <div class="card">
      <div class="card-h"><h3><i class="ti ti-bell"></i>푸시 알림</h3></div>
      <div style="font-size:12.5px;color:var(--t2);margin-bottom:8px">재고 0·시공 전날(오후 2시) 알림을 이 기기로 받습니다.</div>
      ${(() => {
        const st = pushStatus();
        if (st === 'granted') return `<div class="banner b" style="background:var(--gl2);border-color:var(--gbd)"><i class="ti ti-bell" style="color:var(--gd)"></i><span>이 기기는 <b>알림 받는 중</b>입니다.</span></div><button class="btn btn-block" style="margin-top:8px" onclick="enablePush()"><i class="ti ti-refresh"></i>알림 다시 등록</button>`;
        if (st === 'denied') return `<div class="banner warn"><i class="ti ti-bell"></i><span>알림이 <b>차단</b>되어 있습니다. 브라우저 사이트 설정에서 알림을 '허용'으로 바꾼 뒤 다시 시도하세요.</span></div>`;
        if (st === 'unsupported') return `<div class="banner warn"><i class="ti ti-bell"></i><span>이 브라우저는 알림 미지원입니다. <b>아이폰은 홈 화면에 추가</b> 후 그 아이콘으로 열어 사용하세요.</span></div>`;
        return `<button class="btn btn-pri btn-block" onclick="enablePush()"><i class="ti ti-bell"></i>이 기기에서 알림 받기</button>`;
      })()}
      <div style="font-size:11.5px;color:var(--t3);margin-top:8px"><i class="ti ti-device-mobile"></i> 아이폰: 사파리로 열고 <b>공유 → 홈 화면에 추가</b> → 홈 화면 아이콘으로 열어 등록해야 알림이 옵니다.</div>
    </div>
    <div class="card">
      <div class="card-h"><h3><i class="ti ti-cloud"></i>연결 상태</h3></div>
      <div class="alert-i ${CLOUD ? 'b' : 'a'}" style="${CLOUD ? 'background:var(--gl2);border-color:var(--gbd)' : ''}">
        <div class="ai" style="${CLOUD ? 'color:var(--gd)' : ''}"><i class="ti ti-${CLOUD ? 'cloud-check' : 'device-mobile'}"></i></div>
        <div class="at"><b>${CLOUD ? '실시간 클라우드 동기화 ON' : '미리보기 모드 (이 기기에만 저장)'}</b><span>${CLOUD ? '모든 기기(iOS·안드로이드·크롬·사파리)에서 같은 데이터 공유' : 'Firebase를 연결하면 모든 기기에서 실시간 공유됩니다'}</span></div>
      </div>
      ${!CLOUD ? `<button class="btn btn-block" style="margin-top:10px" onclick="openHelp()"><i class="ti ti-help-circle"></i>실시간 공유 연결 방법 보기</button>` : ''}
    </div>
    <div class="card">
      <div class="card-h"><h3><i class="ti ti-book"></i>업무 참고</h3></div>
      <button class="btn btn-block" style="margin-bottom:8px" onclick="openQuoteHelper()"><i class="ti ti-calculator"></i>견적 비용 도우미</button>
      <button class="btn btn-block" onclick="openHelp()"><i class="ti ti-help-circle"></i>설치·연결 도움말</button>
    </div>
    <button class="btn btn-block" style="color:var(--red-t);margin-top:4px" onclick="logout()"><i class="ti ti-logout"></i>로그아웃</button>
    <div style="text-align:center;font-size:11px;color:var(--t3);margin:16px 0 8px">다우세라믹앤석재 통합관리 · v1.0</div>`;
}
function openMemberForm(id) {
  if (!isAdmin()) return;
  const m = id ? state.members.find(x => x.id === id) : null; const v = m || { role: 'staff', email: '' };
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-user-plus"></i>${m ? '직원 수정' : '직원 추가'}</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="frm">
      <div class="fld full"><label>이름<span class="req">*</span></label><input id="m-name" value="${esc(v.name || '')}" placeholder="이름"></div>
      <div class="fld"><label>권한</label><select id="m-role"><option value="staff" ${v.role === 'staff' ? 'selected' : ''}>직원</option><option value="admin" ${v.role === 'admin' ? 'selected' : ''}>관리자</option></select></div>
      <div class="fld full"><label>로그인 이메일<span class="req">*</span></label><input id="m-email" type="email" value="${esc(v.email || '')}" autocapitalize="none" spellcheck="false" placeholder="예) hong@dawoo.com"></div>
    </div>
    <div class="banner info" style="margin:0 0 12px"><i class="ti ti-info-circle"></i>이 이메일로 Firebase 콘솔에서 계정(비밀번호)을 만들어야 로그인됩니다. 비밀번호는 콘솔에서 관리합니다.</div>
    <div class="frm-foot">
      ${m && state.members.length > 1 ? `<button class="btn btn-danger" onclick="delMember('${id}')"><i class="ti ti-trash"></i></button>` : ''}
      <button class="btn btn-pri" style="flex:1" onclick="submitMember('${id || ''}')"><i class="ti ti-check"></i>저장</button>
    </div>`);
}
async function submitMember(id) {
  const name = el('m-name').value.trim();
  const email = (el('m-email').value || '').trim().toLowerCase();
  if (!name || !email) { toast('이름과 로그인 이메일을 입력하세요'); return; }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast('이메일 형식을 확인하세요'); return; }
  if (state.members.some(m => m.id !== id && (m.email || '').toLowerCase() === email)) { toast('이미 등록된 이메일입니다'); return; }
  const obj = { name, role: el('m-role').value, email };
  if (id) await Store.update('members', id, obj); else await Store.add('members', obj);
  toast('저장됨'); closeModal();
}
async function delMember(id) { if (!confirm('이 직원을 삭제할까요?')) return; await Store.remove('members', id); toast('삭제됨'); closeModal(); }
async function addClient() {
  const v = (el('client-new') && el('client-new').value || '').trim();
  if (!v) { toast('거래처명을 입력하세요'); return; }
  if ((state.clients || []).some(c => c.value === v)) { toast('이미 등록된 거래처입니다'); el('client-new').value = ''; return; }
  await Store.add('clients', { value: v }); el('client-new').value = ''; toast('거래처 등록됨');
}
async function delClient(id) { if (!isAdmin()) return; if (!confirm('이 거래처를 삭제할까요?')) return; await Store.remove('clients', id); toast('삭제됨'); }
async function delAllClients() {
  if (!isAdmin()) return;
  if (!confirm('등록된 거래처를 전부 삭제할까요? 되돌릴 수 없습니다.')) return;
  for (const c of (state.clients || []).slice()) { await Store.remove('clients', c.id); }
  toast('거래처 전체 삭제됨');
}

function openHelp() {
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-help-circle"></i>실시간 공유 연결 방법</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="banner info"><i class="ti ti-info-circle"></i><span>아래는 모든 기기에서 실시간으로 데이터를 공유하기 위한 <b>1회 설정</b>입니다. 동봉된 <b>설치가이드</b> 파일에 그림과 함께 더 자세히 있습니다.</span></div>
    <div class="help-step"><div class="n">1</div><div><b>Firebase 프로젝트 만들기</b><p><code>console.firebase.google.com</code> 접속 → 프로젝트 추가(무료)</p></div></div>
    <div class="help-step"><div class="n">2</div><div><b>Firestore 데이터베이스 생성</b><p>좌측 메뉴 Firestore Database → 데이터베이스 만들기 → '테스트 모드'로 시작</p></div></div>
    <div class="help-step"><div class="n">3</div><div><b>웹 앱 추가 후 설정값 복사</b><p>프로젝트 설정 → 웹 앱 추가(&lt;/&gt;) → 표시되는 <code>firebaseConfig</code> 값 복사</p></div></div>
    <div class="help-step"><div class="n">4</div><div><b>index.html에 붙여넣기</b><p><code>index.html</code> 파일의 <code>FIREBASE_CONFIG</code> 따옴표 안에 값 입력 후 저장</p></div></div>
    <div class="help-step"><div class="n">5</div><div><b>인터넷에 올리기</b><p>GitHub Pages 등에 업로드하면 주소 하나로 모든 직원이 접속·실시간 공유</p></div></div>
    <div class="frm-foot"><button class="btn btn-pri btn-block" onclick="closeModal()">확인</button></div>`);
}

/* 견적 비용 도우미 */
function openQuoteHelper() {
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-calculator"></i>견적 비용 도우미</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="banner warn"><i class="ti ti-alert-triangle"></i><span>고객응대 매뉴얼 기준 <b>참고 견적</b>입니다. 실제 견적은 현장 조건에 따라 조정하세요.</span></div>
    <div class="frm">
      <div class="fld"><label>헤베(㎡)</label><input id="q-hebe" inputmode="decimal" placeholder="헤베" oninput="calcQuote()"></div>
      <div class="fld"><label>가공 장수</label><input id="q-jang" inputmode="numeric" placeholder="장수" oninput="calcQuote()"></div>
      <div class="fld"><label>지역</label><input id="q-region" placeholder="지역" oninput="calcQuote()"></div>
      <label class="chk" id="q-am-w"><input type="checkbox" id="q-allmarble" onchange="this.closest('.chk').classList.toggle('on',this.checked);calcQuote()"> 모든대리석 시공</label>
    </div>
    <div id="q-out"></div>`);
  calcQuote();
}
function calcQuote() {
  const r = estimateQuote({ hebe: el('q-hebe').value, jang: el('q-jang').value, region: el('q-region').value, allMarble: el('q-allmarble').checked });
  el('q-out').innerHTML = `<div class="reco" style="margin-top:14px">
    <div class="reco-h"><i class="ti ti-receipt"></i>참고 견적</div>
    <div class="row"><span class="rl">가공비 (장당 50만)</span><span class="rv"><b>${won(r.gagong)}원</b></span></div>
    <div class="row"><span class="rl">실측비</span><span class="rv"><b>${won(r.measure)}원</b></span></div>
    <div class="row"><span class="rl">시공비${''}</span><span class="rv"><b>${won(r.construct)}원</b></span></div>
    ${r.local ? `<div class="row"><span class="rl">지방 출장비</span><span class="rv"><b>${won(r.local)}원</b></span></div>` : ''}
    <div class="row"><span class="rl" style="font-size:14px">합계 (운송비 별도)</span><span class="rv"><b style="font-size:16px">${won(r.total)}원</b></span></div>
  </div>`;
}
/* 다우세라믹앤석재 통합관리 v1.1 */
