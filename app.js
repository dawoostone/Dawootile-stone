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
let db = null;
if (CLOUD) {
  firebase.initializeApp(FBCONF);
  db = firebase.firestore();
}
function cref(name) { return db.collection('teams').doc(TEAM).collection(name); }

const COLLS = ['members', 'sites', 'inventory', 'holdings', 'transactions', 'specs', 'factories', 'teams'];

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
const state = { members: [], sites: [], inventory: [], holdings: [], transactions: [], specs: [], factories: [], teams: [] };
let me = null;          // 로그인한 사용자
let tab = 'home';
let filters = { sites: 'all', stock: 'all', stockSearch: '' };
let _holdLinkSite = null;   // 현장 저장 시 이 홀딩을 현장에 '연결'(소진 아님)
let _holdConfirm = null;    // 출고 저장 시 이 홀딩을 '확정' 처리
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
function init() {
  // 동기화 표시
  if (!CLOUD) { el('sync').classList.add('local'); el('sync-t').textContent = '미리보기'; }
  // 컬렉션 구독
  COLLS.forEach(c => Store.watch(c, data => { state[c] = data; onData(c); }));
  seedIfEmpty();
}
let _seeded = false;
async function seedIfEmpty() {
  setTimeout(async () => {
    if (_seeded) return; _seeded = true;
    // 멤버가 없으면 기본 관리자 생성 (클라우드/로컬 공통, 최초 1회)
    if (state.members.length === 0) {
      await Store.add('members', { name: '관리자', role: 'admin', pin: '0000' });
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
  await Store.add('sites', { name: '판교 카페', client: '미드센추리', region: '경기 성남 분당구', address: '판교로 234', manager: '김민준', orderType: '실측', stage: '보류', materialName: '비앙코 카라라', qty: '6', unit: '장', measureDate: '2026-05-27', constructDate: '2026-06-15', factory: '동호엠엔지', team: '모든대리석', note: '치수 재확인 필요', history: { '접수': '2026-05-23', '가견적': '2026-05-24', '실측': '2026-05-27' } });
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
  if (coll === 'members') renderLoginMembers();
  if (me) render();
}

/* ---------- 5. 로그인 ---------- */
let pinBuf = '', pinTarget = null;
function renderLoginMembers() {
  if (me) return;
  const box = el('login-members');
  if (!state.members.length) { box.innerHTML = '<div class="empty" style="padding:20px">사용자 준비 중...</div>'; return; }
  box.innerHTML = '<div class="member-list">' + state.members.map(m =>
    `<button class="member-btn" onclick="pickMember('${m.id}')">
       <span class="av">${esc(initial(m.name))}</span>
       <span>${esc(m.name)}</span>
       <span class="role">${m.role === 'admin' ? '관리자' : '직원'}</span>
     </button>`).join('') + '</div>';
}
function pickMember(id) {
  pinTarget = state.members.find(m => m.id === id); if (!pinTarget) return;
  pinBuf = '';
  el('login-members').classList.add('hidden');
  el('login-pin').classList.remove('hidden');
  el('pin-name').textContent = pinTarget.name + ' 님 · PIN 입력';
  el('login-err').textContent = '';
  buildKeypad(); drawPinDots();
}
function backToMembers() {
  pinTarget = null; pinBuf = '';
  el('login-pin').classList.add('hidden');
  el('login-members').classList.remove('hidden');
}
function buildKeypad() {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok'];
  el('keypad').innerHTML = keys.map(k => {
    if (k === 'del') return `<button class="key fn" onclick="pinKey('del')">←</button>`;
    if (k === 'ok') return `<button class="key fn" onclick="pinKey('ok')">확인</button>`;
    return `<button class="key" onclick="pinKey('${k}')">${k}</button>`;
  }).join('');
}
function drawPinDots() {
  el('pin-dots').innerHTML = [0, 1, 2, 3].map(i => `<span class="pin-dot ${i < pinBuf.length ? 'on' : ''}"></span>`).join('');
}
function pinKey(k) {
  if (k === 'del') { pinBuf = pinBuf.slice(0, -1); }
  else if (k === 'ok') { return tryLogin(); }
  else if (pinBuf.length < 4) { pinBuf += k; }
  drawPinDots();
  if (pinBuf.length === 4) setTimeout(tryLogin, 150);
}
function tryLogin() {
  if (!pinTarget) return;
  if (pinBuf === (pinTarget.pin || '0000')) {
    me = pinTarget;
    sessionStorage.setItem('dws_me', me.id);
    el('login').style.display = 'none';
    el('app').style.display = 'block';
    el('me-av').textContent = initial(me.name);
    el('me-nm').textContent = me.name;
    render();
  } else {
    el('login-err').textContent = 'PIN이 일치하지 않습니다.';
    pinBuf = ''; drawPinDots();
  }
}
function logout() { me = null; sessionStorage.removeItem('dws_me'); location.reload(); }

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
/* 재고 부족 판정 (장수 기준 안전재고) */
function stockState(it) {
  const jang = +it.jang || 0, safe = +it.safeJang || 0;
  if (jang <= 0) return { k: '없음', cls: 'p-issue' };
  if (safe > 0 && jang < safe) return { k: '부족', cls: 'p-issue' };
  if (safe > 0 && jang < safe * 1.5) return { k: '임박', cls: 'p-wait' };
  return { k: '정상', cls: 'p-prog' };
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
  const waitQuote = state.sites.filter(s => ['접수', '가견적', '견적'].includes(s.stage));

  const alerts = [];
  lowItems.forEach(i => alerts.push({ c: 'r', ic: 'ti-alert-triangle', t: `${i.name} 입고 필요`, s: `현재 ${(+i.jang || 0)}장 · 안전재고 ${(+i.safeJang || 0)}장 미만`, tag: '재고부족' }));
  soonConstruct.forEach(s => alerts.push({ c: 'a', ic: 'ti-tools', t: `${s.name} 시공 임박`, s: `${s.constructDate} 시공 예정 · ${s.team || '시공팀 미정'}`, tag: 'D-' + daysFromNow(s.constructDate) }));
  soonHold.forEach(h => alerts.push({ c: 'b', ic: 'ti-lock', t: `${h.vendor} 홀딩 사용 임박`, s: `${h.materialName} ${(+h.hebe || 0).toFixed(1)}㎡ · ${h.useDate} 사용`, tag: '홀딩' }));
  waitQuote.forEach(s => alerts.push({ c: 'a', ic: 'ti-file-invoice', t: `${s.name} 견적 진행 필요`, s: `현재 단계: ${s.stage} · ${s.client || ''}`, tag: s.stage }));

  el('pg-home').innerHTML = `
    <div class="ph"><div><h2><i class="ti ti-layout-dashboard"></i>주요 현황</h2><p>${new Date().toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' })} 기준 · 실시간 공유</p></div></div>
    <div class="stat-grid">
      <button class="stat tap" onclick="openStockTab('all')"><div class="ic g"><i class="ti ti-packages"></i></div><div class="v">${state.inventory.length}</div><div class="l">재고 품종 <i class="ti ti-chevron-right tap-arrow"></i></div><div class="s">총 ${state.inventory.reduce((a, b) => a + (+b.jang || 0), 0)}장 · ${state.inventory.reduce((a, b) => a + itemHebe(b), 0).toFixed(0)}㎡</div></button>
      <button class="stat tap" onclick="openStockTab('low')"><div class="ic r"><i class="ti ti-alert-triangle"></i></div><div class="v" style="color:${lowItems.length ? 'var(--red-t)' : 'inherit'}">${lowItems.length}</div><div class="l">재고 부족 <i class="ti ti-chevron-right tap-arrow"></i></div><div class="s">${lowItems.length ? '입고 필요' : '정상 운영'}</div></button>
      <button class="stat tap" onclick="filters.sites='prog';go('sites')"><div class="ic b"><i class="ti ti-building-community"></i></div><div class="v">${activeSites.length}</div><div class="l">진행 현장 <i class="ti ti-chevron-right tap-arrow"></i></div><div class="s">시공임박 ${soonConstruct.length}</div></button>
      <button class="stat tap" onclick="go('hold')"><div class="ic a"><i class="ti ti-lock"></i></div><div class="v">${state.holdings.filter(h => (h.status || '홀딩') === '홀딩').length}</div><div class="l">홀딩 건수 <i class="ti ti-chevron-right tap-arrow"></i></div><div class="s">사용임박 ${soonHold.length}</div></button>
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
        <button class="qa" onclick="go('sites');setTimeout(openSiteForm,50)"><span class="qi ic a"><i class="ti ti-building-plus"></i></span><span><b>현장 등록</b><small>신규 현장</small></span></button>
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
function renderSites() {
  const f = filters.sites;
  let list = state.sites.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  if (f === 'prog') list = list.filter(s => !['완료', '보류'].includes(s.stage));
  else if (f === 'wait') list = list.filter(s => ['접수', '가견적', '견적', '결제'].includes(s.stage));
  else if (f === 'construct') list = list.filter(s => ['발주', '시공'].includes(s.stage));
  else if (f === 'done') list = list.filter(s => s.stage === '완료');
  else if (f === 'issue') list = list.filter(s => s.stage === '보류');

  el('pg-sites').innerHTML = `
    <div class="ph"><div><h2><i class="ti ti-building-community"></i>시공 현장</h2><p>진행 단계를 한눈에 · 탭하면 상세</p></div>
      <button class="btn btn-pri btn-sm" onclick="openSiteForm()"><i class="ti ti-plus"></i>현장 등록</button></div>
    <div class="chips">
      ${chip('all', '전체', f)}${chip('prog', '진행중', f)}${chip('wait', '견적·결제', f)}${chip('construct', '발주·시공', f)}${chip('done', '완료', f)}${chip('issue', '보류', f)}
    </div>
    <div class="site-grid">${list.length ? list.map(siteCard).join('') : `<div class="empty" style="grid-column:1/-1"><i class="ti ti-building"></i>등록된 현장이 없습니다<br><button class="btn btn-pri btn-sm" style="margin-top:12px" onclick="openSiteForm()">첫 현장 등록하기</button></div>`}</div>`;
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
  return `<div class="site" onclick="openSiteDetail('${s.id}')">
    <div class="site-top">
      <div><div class="nm">${esc(s.name)}</div><div class="ad"><i class="ti ti-map-pin" style="font-size:13px"></i>${esc(s.region || '')} ${esc(s.address || '')}</div></div>
      ${pill(s.stage || '접수')}
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
  </div>`;
}

function openSiteDetail(id) {
  const s = state.sites.find(x => x.id === id); if (!s) return;
  const skip = s.orderType === '도면';
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-building-community"></i>${esc(s.name)}</h3><button class="x" onclick="closeModal()">×</button></div>
    <div style="margin-bottom:12px">${pill(s.stage || '접수')}${s.confirmed ? ' <span class="pill p-done">확정</span>' : ''}</div>
    <div class="dl">
      <div class="df"><div class="k">현장 담당자</div><div class="v">${esc(s.manager || '-')}</div></div>
      <div class="df"><div class="k">업체(거래처)</div><div class="v">${esc(s.client || '-')}</div></div>
      <div class="df full"><div class="k">현장 주소</div><div class="v">${esc(s.region || '')} ${esc(s.address || '-')}</div></div>
      <div class="df"><div class="k">발주 유형</div><div class="v">${esc(s.orderType || '-')}${skip ? ' (실측없음)' : ''}</div></div>
      <div class="df"><div class="k">자재 / 수량</div><div class="v">${esc(s.materialName || '-')}${s.qty ? ' · ' + esc(s.qty) + esc(s.unit || '') : ''}</div></div>
      <div class="df"><div class="k">가공 공장</div><div class="v">${esc(s.factory || '-')}</div></div>
      <div class="df"><div class="k">시공팀</div><div class="v">${esc(s.team || '-')}</div></div>
      <div class="df"><div class="k">실측일</div><div class="v">${skip ? '도면발주' : (s.measureDate || '미정')}</div></div>
      <div class="df"><div class="k">시공일</div><div class="v">${s.constructDate || '미정'}</div></div>
      ${s.preQuote ? `<div class="df"><div class="k">가견적</div><div class="v">${esc(s.preQuote)}</div></div>` : ''}
      ${s.quoteAmount ? `<div class="df"><div class="k">견적 금액</div><div class="v">${won(+s.quoteAmount)}원</div></div>` : ''}
      ${s.note ? `<div class="df full"><div class="k">특이사항</div><div class="v" style="font-weight:500">${esc(s.note)}</div></div>` : ''}
    </div>
    <div class="sec-label"><i class="ti ti-arrow-bar-to-right"></i>진행 단계 변경</div>
    <div class="seg" style="flex-wrap:wrap">
      ${SITE_STAGES.filter(st => !(skip && st === '실측')).map(st => `<button class="${(s.stage || '접수') === st ? 'on' : ''}" onclick="advanceStage('${s.id}','${st}')">${st}</button>`).join('')}
    </div>
    <button class="btn btn-ghost btn-block" style="margin-top:6px" onclick="holdFromSite('${s.id}')"><i class="ti ti-lock-plus"></i>이 현장 자재 홀딩 잡기</button>
    <div class="frm-foot">
      <button class="btn" style="flex:1" onclick="openSiteForm('${s.id}')"><i class="ti ti-edit"></i>수정</button>
      ${isAdmin() ? `<button class="btn btn-danger" onclick="delSite('${s.id}')"><i class="ti ti-trash"></i></button>` : ''}
    </div>`);
}
/* 현장 → 홀딩 생성 (현장 정보로 홀딩 폼 프리필) */
function holdFromSite(id) {
  const s = state.sites.find(x => x.id === id); if (!s) return;
  openHoldForm(null, { forSiteId: id, materialName: s.materialName, jang: s.qty, useDate: s.constructDate });
}
async function advanceStage(id, stage) {
  const s = state.sites.find(x => x.id === id); if (!s) return;
  const hist = Object.assign({}, s.history || {}); if (!hist[stage]) hist[stage] = todayStr();
  await Store.update('sites', id, { stage, history: hist, updatedBy: me.name });
  toast(`단계 → ${stage}`); closeModal();
}
async function delSite(id) { if (!confirm('이 현장을 삭제할까요?')) return; await Store.remove('sites', id); toast('삭제됨'); closeModal(); }

/* 현장 등록/수정 폼 */
function openSiteForm(id, pre) {
  const s = id ? state.sites.find(x => x.id === id) : null;
  const v = s || Object.assign({ manager: me.name, orderType: '실측', stage: '접수', measureNeeded: true }, pre || {});
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-building-plus"></i>${s ? '현장 수정' : '현장 등록'}</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="frm">
      <div class="fld"><label>현장명 <span style="color:var(--t3);font-weight:500">(미입력 시 업체명)</span></label><input id="s-name" value="${esc(v.name || '')}" placeholder="예) 반포 자이 49평"></div>
      <div class="fld"><label>업체(거래처)<span class="req">*</span></label><input id="s-client" value="${esc(v.client || '')}" placeholder="예) ○○인테리어"></div>
      <div class="fld"><label>지역</label><input id="s-region" value="${esc(v.region || '')}" placeholder="예) 서울 서초구"></div>
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
      <div class="fld"><label>자재명<span class="req">*</span> <span style="color:var(--t3);font-weight:500">(홀딩에 없어도 직접 입력)</span></label><input id="s-material" list="dl-mat" value="${esc(v.materialName || '')}" placeholder="자재명 직접 입력 또는 목록 선택">${matDatalistCombined('dl-mat')}</div>
      <div class="fld"><label>수량<span class="req">*</span></label><input id="s-qty" value="${esc(v.qty || '')}" placeholder="예) 28" inputmode="decimal"></div>
      <div class="fld"><label>실측일 <span id="s-measure-lbl" style="color:var(--t3)">${v.orderType === '도면' ? '(도면발주·생략)' : ''}</span></label><input type="date" id="s-measureDate" value="${esc(v.measureDate || '')}" ${v.orderType === '도면' ? 'disabled' : ''}></div>
      <div class="fld"><label>시공일<span class="req">*</span></label><input type="date" id="s-constructDate" value="${esc(v.constructDate || '')}"></div>
      <div class="fld"><label>가공 공장<span class="req">*</span></label><select id="s-factory" onchange="onMasterChange('s-factory','factories')">${masterOptions('factories', v.factory || '')}</select></div>
      <div class="fld full hidden" id="s-factory-add"><label>새 공장 입력 후 추가</label><div style="display:flex;gap:8px"><input id="s-factory-new" placeholder="예) ○○석재" style="flex:1"><button class="btn btn-pri btn-sm" type="button" onclick="commitMaster('s-factory','factories')"><i class="ti ti-plus"></i>추가</button></div></div>
      <div class="fld"><label>시공팀<span class="req">*</span></label><select id="s-team" onchange="onMasterChange('s-team','teams')">${masterOptions('teams', v.team || '')}</select></div>
      <div class="fld full hidden" id="s-team-add"><label>새 시공팀 입력 후 추가</label><div style="display:flex;gap:8px"><input id="s-team-new" placeholder="예) ○○팀" style="flex:1"><button class="btn btn-pri btn-sm" type="button" onclick="commitMaster('s-team','teams')"><i class="ti ti-plus"></i>추가</button></div></div>
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
  const o = {
    region: el('s-region').value, address: el('s-address').value,
    constructionDate: el('s-constructDate').value, dueDate: el('s-constructDate').value,
    jang: parseFloat(el('s-qty').value) || 0,
    volume: (parseFloat(el('s-qty').value) || 0) >= 25 ? '대형' : '소형',
    materialName: el('s-material').value,
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
  el('s-material').value = h.materialName || '';
  el('s-qty').value = h.jang || '';
  if (!el('s-client').value) el('s-client').value = h.vendor || '';
  _holdLinkSite = id;
  toast('홀딩 자재를 불러왔습니다 (등록 시 현장에 연결)');
}

async function submitSite(id) {
  const name = el('s-name').value.trim();
  const client = el('s-client').value.trim();
  const material = el('s-material').value.trim();
  const qty = el('s-qty').value.trim();
  const constructDate = el('s-constructDate').value;
  const factory = el('s-factory').value === '__add' ? '' : el('s-factory').value;
  const team = el('s-team').value === '__add' ? '' : el('s-team').value;
  if (!client) { toast('업체명을 입력하세요'); return; }
  if (!material) { toast('자재명을 입력하세요'); return; }
  if (!qty) { toast('수량을 입력하세요'); return; }
  if (!constructDate) { toast('시공일을 선택하세요'); return; }
  if (!factory) { toast('가공 공장을 선택하세요'); return; }
  if (!team) { toast('시공팀을 선택하세요'); return; }
  const obj = {
    name: name || (client + ' 현장'), client, region: el('s-region').value.trim(),
    address: el('s-address').value.trim(), manager: el('s-manager').value.trim() || me.name,
    orderType: curOrderType(), stage: el('s-stage').value || '접수',
    materialName: material, qty, unit: '',
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
  if (!list.length) return `<tr><td colspan="6"><div class="empty"><i class="ti ti-package-off"></i>해당하는 자재가 없습니다</div></td></tr>`;
  return list.map(i => {
    const s = stockState(i);
    return `<tr onclick="openItemForm('${i.id}')">
      <td><b>${esc(i.name)}</b><div style="font-size:11px;color:var(--t3)">${esc(i.vendor || '')}</div></td>
      <td>${esc(i.spec || '-')}</td>
      <td><b>${(+i.jang || 0)}</b>장${i.safeJang ? `<div style="font-size:10px;color:var(--t3)">안전 ${i.safeJang}</div>` : ''}</td>
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
    <div style="display:flex;gap:9px;margin-bottom:12px">
      <button class="btn btn-pri" style="flex:1" onclick="openStockForm()"><i class="ti ti-login"></i>입고 등록</button>
      <button class="btn" style="flex:1" onclick="openItemForm()"><i class="ti ti-plus"></i>품목 추가</button>
    </div>
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
        <thead><tr><th>자재명</th><th>규격</th><th>장수</th><th>헤베(㎡)</th><th>상태</th><th>창고</th></tr></thead>
        <tbody id="stock-tbody">${stockRowsHtml(list)}</tbody>
      </table>
    </div>
    <div class="card" style="margin-top:14px">
      <div class="card-h"><h3><i class="ti ti-login"></i>최근 입고</h3></div>
      ${ins.length ? ins.map(t => `<div class="alert-i b" style="background:var(--gl2);border-color:var(--gbd)"><div class="ai" style="color:var(--gd)"><i class="ti ti-login"></i></div><div class="at"><b>${esc(t.itemName)} +${(+t.hebe || 0).toFixed(1)}㎡ (${+t.jang || 0}장)</b><span>${esc(t.date)} · 롯트 ${esc(t.lot || '-')} · ${esc(t.by || '')}</span></div></div>`).join('') : `<div class="empty"><i class="ti ti-inbox"></i>입고 내역 없음</div>`}
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
      <div class="fld"><label>자재명<span class="req">*</span></label><input id="i-name" value="${esc(v.name || '')}" placeholder="예) 카무스 화이트"></div>
      <div class="fld"><label>규격 (가로*세로*두께)</label>
        <select id="i-spec" onchange="onSpecChange('i')">${specOptions(v.spec || '')}</select>
      </div>
      <div class="fld full hidden" id="i-spec-add">
        <label>새 규격 입력 후 추가</label>
        <div style="display:flex;gap:8px">
          <input id="i-spec-new" placeholder="예) 1600*3200*12" inputmode="text" style="flex:1">
          <button class="btn btn-pri btn-sm" type="button" onclick="commitSpec('i')"><i class="ti ti-plus"></i>추가</button>
        </div>
      </div>
      <div class="fld"><label>공급처</label><input id="i-vendor" value="${esc(v.vendor || '')}" placeholder="예) 토마스마블"></div>
      <div class="fld"><label>창고</label><input id="i-depot" value="${esc(v.depot || '본사')}"></div>
      <div class="fld"><label>현재 장수</label><input id="i-jang" value="${esc(v.jang || 0)}" inputmode="numeric" oninput="updateItemHebe()"></div>
      <div class="fld"><label>안전재고(장) — 미만이면 '부족'</label><input id="i-safe" value="${esc(v.safeJang || 0)}" inputmode="numeric" placeholder="예) 12"></div>
      <div class="fld full"><div class="reco" id="i-hebe-info" style="margin-top:0"><div class="reco-h"><i class="ti ti-ruler-2"></i>자동 환산</div><div class="row"><span class="rl">장당 헤베</span><span class="rv"><b id="i-perjang">${(parseSpec(v.spec).hebePerJang || 0).toFixed(3)}</b> ㎡/장</span></div><div class="row"><span class="rl">현재 재고 헤베</span><span class="rv"><b id="i-tothebe">${itemHebe(v).toFixed(2)}</b> ㎡</span></div></div></div>
    </div>
    ${it ? `
    <div class="sec-label"><i class="ti ti-logout"></i>출고 내역 <span style="font-weight:500;color:var(--t3)">· 누적 ${totalOut}장</span></div>
    ${txnRowsWithMore(outs, 'out-more', t => `<div class="alert-i b" style="margin-bottom:6px"><div class="ai"><i class="ti ti-logout"></i></div><div class="at"><b>${+t.jang || 0}장${t.hebe ? ` (${(+t.hebe).toFixed(1)}㎡)` : ''}</b><span>${esc(t.date || '')} · ${esc(t.targetName || '-')} · ${esc(t.by || '')}</span></div></div>`, '출고 내역 없음')}
    <div class="sec-label" style="margin-top:14px"><i class="ti ti-login"></i>입고 내역</div>
    ${txnRowsWithMore(ins, 'in-more', t => `<div class="alert-i b" style="background:var(--gl2);border-color:var(--gbd);margin-bottom:6px"><div class="ai" style="color:var(--gd)"><i class="ti ti-login"></i></div><div class="at"><b>+${+t.jang || 0}장${t.hebe ? ` (${(+t.hebe).toFixed(1)}㎡)` : ''}</b><span>${esc(t.date || '')} · 롯트 ${esc(t.lot || '-')} · ${esc(t.by || '')}</span></div></div>`, '입고 내역 없음')}
    ` : ''}
    <div class="frm-foot">
      ${it && isAdmin() ? `<button class="btn btn-danger" onclick="delItem('${id}')"><i class="ti ti-trash"></i></button>` : ''}
      <button class="btn btn-pri" style="flex:1" onclick="submitItem('${id || ''}')"><i class="ti ti-check"></i>저장</button>
    </div>`);
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
  const obj = { name, spec, vendor: el('i-vendor').value.trim(), depot: el('i-depot').value.trim() || '본사', jang, hebePerJang: ps.hebePerJang, safeJang: parseFloat(el('i-safe').value) || 0 };
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
      <div class="fld"><label>롯트 넘버<span class="req">*</span></label><input id="in-lot" placeholder="예) LOT-26-0531"></div>
    </div>
    <div class="sec-label"><i class="ti ti-layout-grid"></i>패턴별 장수 <span style="font-weight:500;color:var(--t3)">(패턴이 없으면 장수만 입력)</span></div>
    <div id="in-patterns"></div>
    <button class="btn btn-ghost btn-sm" type="button" onclick="addPatternRow()" style="margin-top:4px"><i class="ti ti-plus"></i>패턴 추가</button>
    <div class="frm" style="margin-top:14px">
      <div class="fld"><label>입고일</label><input type="date" id="in-date" value="${todayStr()}"></div>
      <div class="fld"><label>발주처(공장)</label><input id="in-vendor" placeholder="예) 토마스마블"></div>
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
  if (it && !el('in-vendor').value) el('in-vendor').value = it.vendor || '';
  computeInTotal();
}
function addPatternRow() {
  const box = el('in-patterns'); if (!box) return;
  const row = document.createElement('div');
  row.className = 'pat-row';
  row.style.cssText = 'display:flex;gap:8px;margin-bottom:8px';
  row.innerHTML = `<input class="in-pat-name" placeholder="패턴(선택) 예) A형" style="flex:1.2;font-size:14px;padding:9px 11px;border:1.5px solid var(--bd2);border-radius:10px">
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
  const vendor = el('in-vendor').value.trim(), date = el('in-date').value, note = el('in-note').value.trim();
  await Store.update('inventory', it.id, { jang: (+it.jang || 0) + jang, lastInDate: date, vendor: vendor || it.vendor });
  await Store.add('transactions', { type: 'in', itemId: it.id, itemName: it.name, spec: it.spec, lot, patterns, jang, hebe, vendor, date, note, by: me.name });
  toast(`입고 완료 · ${jang}장 (${hebe}㎡)`); closeModal();
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

  el('pg-ship').innerHTML = `
    <div class="ph"><div><h2><i class="ti ti-truck-delivery"></i>출고 현황</h2><p>현장·공장·거래처 출고 + 월별 분석</p></div>
      <button class="btn btn-pri btn-sm" onclick="openShipForm()"><i class="ti ti-plus"></i>출고 등록</button></div>
    <div class="stat-grid" style="grid-template-columns:repeat(2,1fr)">
      <div class="stat"><div class="ic b"><i class="ti ti-calendar-stats"></i></div><div class="v">${monthHebe.toFixed(0)}<span style="font-size:14px">㎡</span></div><div class="l">이번 달 출고</div><div class="s">${monthOut.length}건</div></div>
      <div class="stat"><div class="ic g"><i class="ti ti-sum"></i></div><div class="v">${outs.length}</div><div class="l">총 출고 건수</div><div class="s">전체 누적</div></div>
    </div>
    <div class="card">
      <div class="card-h"><h3><i class="ti ti-chart-bar"></i>월별 출고 현황</h3><span class="more">${year}년</span></div>
      <div class="mchart">${monthly.map((v, i) => `<div class="mcol"><div class="val">${v ? v.toFixed(0) : ''}</div><div class="bb ${i === now.getMonth() ? 'cur' : ''}" style="height:${Math.max(2, v / maxM * 100)}%"></div><div class="lb">${i + 1}월</div></div>`).join('')}</div>
    </div>
    <div class="card">
      <div class="card-h"><h3><i class="ti ti-trophy"></i>출고 상위 제품</h3></div>
      ${top.length ? top.map(([nm, v], i) => `<div class="abar"><span class="rk">${i + 1}</span><span class="nm">${esc(nm)}</span><span class="tr"><i style="width:${v / maxT * 100}%"></i></span><span class="vv">${v.toFixed(0)}㎡</span></div>`).join('') : `<div class="empty"><i class="ti ti-chart-dots"></i>출고 데이터가 쌓이면 표시됩니다</div>`}
    </div>
    <div class="card">
      <div class="card-h"><h3><i class="ti ti-list-details"></i>최근 출고</h3></div>
      ${outs.length ? outs.slice(0, 10).map(t => `<div class="alert-i b"><div class="ai"><i class="ti ti-logout"></i></div><div class="at"><b>${esc(t.itemName)} ${(+t.hebe || 0).toFixed(1)}㎡ (${+t.jang || 0}장)</b><span>${esc(t.date)} · ${esc(t.targetName || '')}${t.factory ? ' · 공장 ' + esc(t.factory) : ''} · ${esc(t.by || '')}</span></div></div>`).join('') : `<div class="empty"><i class="ti ti-inbox"></i>출고 내역 없음</div>`}
    </div>`;
}
function openShipForm(pre) {
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-logout"></i>출고 등록</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="frm">
      <div class="fld full"><label>업체명<span class="req">*</span></label><input id="o-targetName" list="dl-company" placeholder="업체명 입력">${companyDatalist('dl-company')}</div>
      ${state.inventory.length ? `<div class="fld full"><label>재고에서 선택 <span style="color:var(--t3);font-weight:500">(또는 아래에 직접 입력)</span></label><select id="o-pick" onchange="pickOutItem()"><option value="">— 직접 입력 —</option>${state.inventory.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map(i => `<option value="${esc(i.id)}">${esc(i.name)} · 재고 ${+i.jang || 0}장</option>`).join('')}</select></div>` : ''}
      <div class="fld full"><label>출고 자재<span class="req">*</span> <span style="color:var(--t3);font-weight:500">(자동완성 · 재고에 없어도 직접 입력)</span></label><input id="o-material" list="dl-out" placeholder="자재명 직접 입력 또는 위 목록에서 선택" oninput="computeOutHebe()">${matDatalistCombined('dl-out')}</div>
      <div class="fld"><label>출고 장수<span class="req">*</span></label><input id="o-jang" inputmode="numeric" placeholder="예) 4" oninput="computeOutHebe()"></div>
      <div class="fld"><label>출고일<span class="req">*</span></label><input type="date" id="o-date" value="${todayStr()}"></div>
      <div class="fld"><label>발주/출고 공장</label><select id="o-factory" onchange="onMasterChange('o-factory','factories')">${masterOptions('factories', '')}</select></div>
      <div class="fld full hidden" id="o-factory-add"><label>새 공장 입력 후 추가</label><div style="display:flex;gap:8px"><input id="o-factory-new" placeholder="예) ○○석재" style="flex:1"><button class="btn btn-pri btn-sm" type="button" onclick="commitMaster('o-factory','factories')"><i class="ti ti-plus"></i>추가</button></div></div>
      <div class="fld full"><label>메모</label><input id="o-note" placeholder="선택"></div>
    </div>
    <div class="reco" id="o-summary" style="margin-top:6px"><div class="row" id="o-hebe-info" style="border:none"><span class="rl">재고 연동</span><span class="rv">자재·장수 입력 시 표시</span></div></div>
    <div class="frm-foot"><button class="btn" style="flex:1" onclick="closeModal()">취소</button><button class="btn btn-pri" style="flex:2" onclick="submitShip()"><i class="ti ti-check"></i>출고 등록</button></div>`);
  if (pre) {
    if (pre.material && el('o-material')) el('o-material').value = pre.material;
    if (pre.jang && el('o-jang')) el('o-jang').value = pre.jang;
    if (pre.targetName && el('o-targetName')) el('o-targetName').value = pre.targetName;
  }
  computeOutHebe();
}
function pickOutItem() {
  const id = el('o-pick') && el('o-pick').value; if (!id) return;
  const it = state.inventory.find(i => i.id === id); if (!it) return;
  el('o-material').value = it.name; computeOutHebe();
}
function shipMatchedItem() { const nm = (el('o-material') && el('o-material').value || '').trim(); return nm ? state.inventory.find(i => i.name === nm) : null; }
function computeOutHebe() {
  const info = el('o-hebe-info'); if (!info) return;
  const it = shipMatchedItem(); const jang = parseFloat(el('o-jang').value) || 0;
  if (it) info.innerHTML = `<span class="rl">재고 연동</span><span class="rv"><b>${(jang * (+it.hebePerJang || 0)).toFixed(2)}㎡</b><small>${esc(it.name)} · 출고 시 ${jang}장 차감</small></span>`;
  else info.innerHTML = `<span class="rl">재고 미연동</span><span class="rv" style="color:var(--t3)">출고 기록만 남김 (재고 차감 없음)</span>`;
}
async function submitShip() {
  const targetName = el('o-targetName').value.trim();
  const material = el('o-material').value.trim();
  const jang = parseFloat(el('o-jang').value) || 0;
  const date = el('o-date').value;
  if (!targetName) { toast('업체명을 입력하세요'); return; }
  if (!material) { toast('출고 자재를 입력하세요'); return; }
  if (jang <= 0) { toast('출고 장수를 입력하세요'); return; }
  if (!date) { toast('출고일을 선택하세요'); return; }
  const it = state.inventory.find(i => i.name === material);
  const hebe = it ? +(jang * (+it.hebePerJang || 0)).toFixed(2) : 0;
  if (it) await Store.update('inventory', it.id, { jang: Math.max(0, (+it.jang || 0) - jang) });
  const factory = (el('o-factory') && el('o-factory').value !== '__add') ? el('o-factory').value : '';
  await Store.add('transactions', { type: 'out', itemId: it ? it.id : '', itemName: material, spec: it ? it.spec : '', hebe, jang, factory, target: '', targetName, date, note: el('o-note').value.trim(), by: me.name });
  // 홀딩에서 넘어온 출고면 → 그 홀딩을 '확정'(출고 완료)으로
  if (_holdConfirm) { await Store.update('holdings', _holdConfirm, { status: '확정', shippedDate: date, shippedJang: jang }); _holdConfirm = null; toast('홀딩 확정 (출고 완료)'); }
  toast(`출고 완료 · ${jang}장${it ? ` (${hebe}㎡)` : ''}`); closeModal();
}

/* ===================================================================
   홀딩 (업체 · 장수/헤베 · 사용일정)
   =================================================================== */
function renderHold() {
  const isResv = h => (h.status || '홀딩') === '홀딩';
  const list = state.holdings.filter(h => h.status !== '해제').sort((a, b) => {
    const ra = isResv(a) ? 0 : 1, rb = isResv(b) ? 0 : 1;
    if (ra !== rb) return ra - rb;
    return (a.useDate || '').localeCompare(b.useDate || '');
  });
  const reserved = list.filter(isResv);
  const confirmed = list.filter(h => h.status === '확정');
  const soon = reserved.filter(h => { const d = daysFromNow(h.useDate); return d != null && d >= 0 && d <= 3; });
  el('pg-hold').innerHTML = `
    <div class="ph"><div><h2><i class="ti ti-lock"></i>자재 홀딩</h2><p>예약 → 출고 시 '확정' · 현장과 연결</p></div>
      <button class="btn btn-pri btn-sm" onclick="openHoldForm()"><i class="ti ti-plus"></i>홀딩 등록</button></div>
    <div class="stat-grid" style="grid-template-columns:repeat(3,1fr)">
      <div class="stat"><div class="ic b"><i class="ti ti-lock"></i></div><div class="v">${reserved.length}</div><div class="l">홀딩 중</div><div class="s">예약</div></div>
      <div class="stat"><div class="ic a"><i class="ti ti-clock-exclamation"></i></div><div class="v" style="color:${soon.length ? 'var(--amber-t)' : 'inherit'}">${soon.length}</div><div class="l">사용 임박</div><div class="s">3일 이내</div></div>
      <div class="stat"><div class="ic g"><i class="ti ti-circle-check"></i></div><div class="v">${confirmed.length}</div><div class="l">확정</div><div class="s">출고완료</div></div>
    </div>
    <div class="banner info"><i class="ti ti-info-circle"></i><span>홀딩 → <b>현장으로</b>는 연결만 되고 홀딩은 유지됩니다. <b>출고</b>를 입력해야 '확정'으로 넘어갑니다.</span></div>
    ${list.length ? list.map(h => {
      const d = daysFromNow(h.useDate);
      const conf = h.status === '확정';
      const cls = conf ? 'p-done' : (d != null && d >= 0 && d <= 3 ? 'p-wait' : 'p-hold');
      return `<div class="card" style="margin-bottom:11px;${conf ? 'opacity:.92' : ''}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
          <div><div style="font-size:15px;font-weight:700">${esc(h.vendor || '-')}</div><div style="font-size:12.5px;color:var(--t2);margin-top:2px">${esc(h.materialName || '')}</div>${h.forSiteName ? `<div style="margin-top:5px"><span class="pill p-hold"><i class="ti ti-building-community"></i>${esc(h.forSiteName)}</span></div>` : ''}</div>
          ${conf ? `<span class="pill p-done"><i class="ti ti-circle-check"></i>확정</span>` : `<span class="pill ${cls}"><i class="ti ti-calendar"></i>${h.useDate || '미정'}${d != null && d >= 0 && d <= 7 ? ' · D-' + d : ''}</span>`}
        </div>
        <div style="display:flex;gap:18px;font-size:13px;margin-bottom:4px">
          <span style="color:var(--t2)">장수 <b style="color:var(--t1)">${+h.jang || 0}장</b></span>
          <span style="color:var(--t2)">헤베 <b style="color:var(--t1)">${(+h.hebe || 0).toFixed(1)}㎡</b></span>
        </div>
        ${conf ? `<div style="font-size:12px;color:var(--lime-t);margin-top:4px"><i class="ti ti-truck-delivery"></i> 출고 완료 ${esc(h.shippedDate || '')} · ${+h.shippedJang || 0}장</div>` : ''}
        ${h.note ? `<div style="font-size:12px;color:var(--t3);margin-top:6px">${esc(h.note)}</div>` : ''}
        ${conf ? `<div style="display:flex;gap:8px;margin-top:10px"><button class="btn btn-sm" style="flex:1" onclick="openHoldForm('${h.id}')"><i class="ti ti-edit"></i>수정</button></div>` : `
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="btn btn-pri btn-sm" style="flex:1" onclick="holdToSite('${h.id}')"><i class="ti ti-building-plus"></i>현장으로</button>
          <button class="btn btn-pri btn-sm" style="flex:1;background:var(--blue);border-color:var(--blue)" onclick="holdToShip('${h.id}')"><i class="ti ti-truck-delivery"></i>출고로</button>
        </div>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="btn btn-sm" style="flex:1" onclick="openHoldForm('${h.id}')"><i class="ti ti-edit"></i>수정</button>
          <button class="btn btn-sm" style="flex:1" onclick="releaseHold('${h.id}')"><i class="ti ti-lock-open"></i>해제</button>
        </div>`}
      </div>`;
    }).join('') : `<div class="empty"><i class="ti ti-lock-off"></i>홀딩이 없습니다</div>`}`;
}
function openHoldForm(id, pre) {
  const h = id ? state.holdings.find(x => x.id === id) : null; const v = h || Object.assign({}, pre || {});
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-lock-plus"></i>${h ? '홀딩 수정' : '홀딩 등록'}</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="frm">
      ${state.sites.length ? `<div class="fld full"><label><i class="ti ti-building-community" style="font-size:13px;color:var(--blue)"></i> 현장에서 선택 <span style="color:var(--t3);font-weight:500">— 고르면 자재·수량·시공일 자동 입력</span></label><select id="h-site" onchange="pickHoldSite()"><option value="">— 직접 입력 —</option>${siteOptions(v.forSiteId || '')}</select></div>` : ''}
      <div class="fld"><label>업체<span class="req">*</span></label><input id="h-vendor" value="${esc(v.vendor || '')}" placeholder="예) 모든대리석"></div>
      <div class="fld"><label>사용 예정일</label><input type="date" id="h-useDate" value="${esc(v.useDate || '')}"></div>
      <div class="fld full"><label>자재명</label><input id="h-material" list="dl-h" value="${esc(v.materialName || '')}" placeholder="예) 카무스 화이트">${itemDatalist('dl-h')}</div>
      <div class="fld"><label>장수</label><input id="h-jang" value="${esc(v.jang || '')}" inputmode="numeric"></div>
      <div class="fld"><label>헤베(㎡)</label><input id="h-hebe" value="${esc(v.hebe || '')}" inputmode="decimal"></div>
      <div class="fld full"><label>메모</label><input id="h-note" value="${esc(v.note || '')}" placeholder="선택"></div>
    </div>
    <div class="frm-foot">
      <button class="btn" style="flex:1" onclick="closeModal()">취소</button>
      <button class="btn btn-pri" style="flex:2" onclick="submitHold('${id || ''}')"><i class="ti ti-check"></i>${h ? '저장' : '등록'}</button>
    </div>`);
}
function pickHoldSite() {
  const id = el('h-site').value; if (!id) return;
  const s = state.sites.find(x => x.id === id); if (!s) return;
  if (s.materialName) el('h-material').value = s.materialName;
  if (s.qty) el('h-jang').value = s.qty;
  if (s.constructDate && !el('h-useDate').value) el('h-useDate').value = s.constructDate;
  toast('현장 정보를 불러왔습니다');
}
async function submitHold(id) {
  const vendor = el('h-vendor').value.trim(); if (!vendor) { toast('업체를 입력하세요'); return; }
  const siteId = el('h-site') ? el('h-site').value : '';
  const siteName = siteId ? ((state.sites.find(s => s.id === siteId) || {}).name || '') : '';
  const obj = { vendor, materialName: el('h-material').value.trim(), jang: parseFloat(el('h-jang').value) || 0, hebe: parseFloat(el('h-hebe').value) || 0, useDate: el('h-useDate').value, note: el('h-note').value.trim(), status: '홀딩', forSiteId: siteId, forSiteName: siteName, by: me.name };
  if (id) await Store.update('holdings', id, obj); else await Store.add('holdings', obj);
  toast(id ? '저장됨' : '홀딩 등록 완료'); closeModal();
}
async function releaseHold(id) { if (!confirm('홀딩을 해제할까요?')) return; await Store.update('holdings', id, { status: '해제' }); toast('홀딩 해제됨'); }

/* 홀딩 → 현장 연결 (홀딩은 그대로 살아있고, 현장에 연결만) */
function holdToSite(id) {
  const h = state.holdings.find(x => x.id === id); if (!h) return;
  _holdLinkSite = id;
  openSiteForm(null, { materialName: h.materialName, client: h.vendor, qty: String(h.jang || ''), note: '홀딩 연결' });
}
/* 홀딩 → 출고 (출고가 찍히면 그 홀딩이 '확정'으로) */
function holdToShip(id) {
  const h = state.holdings.find(x => x.id === id); if (!h) return;
  _holdConfirm = id;
  openShipForm({ material: h.materialName || '', jang: h.jang || '', targetName: h.forSiteName || h.vendor || '' });
}

/* ===================================================================
   설정
   =================================================================== */
function renderSettings() {
  el('pg-settings').innerHTML = `
    <div class="ph"><div><h2><i class="ti ti-settings"></i>설정</h2><p>${esc(me.name)} 님 · ${isAdmin() ? '관리자' : '직원'}</p></div></div>
    <div class="card">
      <div class="card-h"><h3><i class="ti ti-users"></i>직원 관리</h3>${isAdmin() ? `<button class="more" onclick="openMemberForm()"><i class="ti ti-plus"></i>추가</button>` : ''}</div>
      ${state.members.map(m => `<div class="mem"><div class="av">${esc(initial(m.name))}</div><div class="info"><div class="nm">${esc(m.name)}</div><div class="rl">${m.role === 'admin' ? '전체 조회·수정·삭제' : '현장·재고 입력'}</div></div><span class="pill ${m.role === 'admin' ? 'p-prog' : 'p-gray'}">${m.role === 'admin' ? '관리자' : '직원'}</span>${isAdmin() ? `<button class="x" onclick="openMemberForm('${m.id}')"><i class="ti ti-edit" style="font-size:17px"></i></button>` : ''}</div>`).join('')}
      ${!isAdmin() ? `<div class="banner info" style="margin-top:12px"><i class="ti ti-info-circle"></i>직원 추가·삭제는 관리자만 가능합니다.</div>` : ''}
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
  const m = id ? state.members.find(x => x.id === id) : null; const v = m || { role: 'staff', pin: '' };
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-user-plus"></i>${m ? '직원 수정' : '직원 추가'}</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="frm">
      <div class="fld full"><label>이름<span class="req">*</span></label><input id="m-name" value="${esc(v.name || '')}" placeholder="예) 김민준"></div>
      <div class="fld"><label>권한</label><select id="m-role"><option value="staff" ${v.role === 'staff' ? 'selected' : ''}>직원</option><option value="admin" ${v.role === 'admin' ? 'selected' : ''}>관리자</option></select></div>
      <div class="fld"><label>PIN(4자리)<span class="req">*</span></label><input id="m-pin" value="${esc(v.pin || '')}" inputmode="numeric" maxlength="4" placeholder="예) 1234"></div>
    </div>
    <div class="frm-foot">
      ${m && state.members.length > 1 ? `<button class="btn btn-danger" onclick="delMember('${id}')"><i class="ti ti-trash"></i></button>` : ''}
      <button class="btn btn-pri" style="flex:1" onclick="submitMember('${id || ''}')"><i class="ti ti-check"></i>저장</button>
    </div>`);
}
async function submitMember(id) {
  const name = el('m-name').value.trim(); const pin = el('m-pin').value.trim();
  if (!name || pin.length !== 4) { toast('이름과 4자리 PIN을 입력하세요'); return; }
  const obj = { name, role: el('m-role').value, pin };
  if (id) await Store.update('members', id, obj); else await Store.add('members', obj);
  toast('저장됨'); closeModal();
}
async function delMember(id) { if (!confirm('이 직원을 삭제할까요?')) return; await Store.remove('members', id); toast('삭제됨'); closeModal(); }

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
      <div class="fld"><label>헤베(㎡)</label><input id="q-hebe" inputmode="decimal" placeholder="예) 28" oninput="calcQuote()"></div>
      <div class="fld"><label>가공 장수</label><input id="q-jang" inputmode="numeric" placeholder="예) 2" oninput="calcQuote()"></div>
      <div class="fld"><label>지역</label><input id="q-region" placeholder="예) 서울 / 대전" oninput="calcQuote()"></div>
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
