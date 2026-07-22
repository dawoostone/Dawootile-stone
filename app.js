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

const COLLS = ['members', 'sites', 'inventory', 'holdings', 'transactions', 'specs', 'factories', 'teams', 'suppliers', 'clients', 'issues', 'restocks', 'basins', 'holdRequests', 'shipments', 'chulgoReqs'];

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
  },
  /* 지정 문서 id로 병합 업서트(다른 앱이 써넣은 필드는 보존) — 연동 브릿지용 */
  async setMerge(coll, id, obj) {
    if (CLOUD) { await cref(coll).doc(id).set(obj, { merge: true }); }
    else {
      const arr = this.read(coll); const i = arr.findIndex(x => x.id === id);
      if (i >= 0) Object.assign(arr[i], obj); else arr.push(Object.assign({ id }, obj));
      this._writeLocal(coll, arr); if (this._watchers[coll]) this._watchers[coll](arr);
    }
  }
};
if (bc) bc.onmessage = (e) => { const c = e.data; if (Store._watchers[c]) Store._watchers[c](Store.read(c)); };

/* ---------- 1. 전역 상태 ---------- */
const state = { members: [], sites: [], inventory: [], holdings: [], transactions: [], specs: [], factories: [], teams: [], suppliers: [], clients: [], issues: [], restocks: [], basins: [], holdRequests: [], shipments: [], chulgoReqs: [] };
let me = null;          // 로그인한 사용자
let tab = 'home';
let filters = { sites: 'all', stock: 'all', stockSearch: '', siteSearch: '', siteSearchField: 'all', holdArchive: false, holdDone: false, holdSearch: '', holdGroup: 'none', custSearch: '', shipSearch: '', basinSearch: '' };
let _holdLinkSite = null;   // 현장 저장 시 이 홀딩을 현장에 '연결'(소진 아님)
let _holdConfirm = null;    // 출고 저장 시 이 홀딩을 '확정' 처리
let _busy = false;          // 등록 버튼 연속 클릭(중복 저장) 방지
function openStockTab(filter) { filters.stock = filter || 'all'; filters.stockSearch = ''; go('stock'); }

/* ---------- 2. 유틸 ---------- */
const $ = (s, r = document) => r.querySelector(s);
const el = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const won = n => (n || 0).toLocaleString('ko-KR');
const todayStr = () => new Date().toISOString().slice(0, 10);
function daysFromNow(d) { if (!d) return null; return Math.ceil((new Date(d + 'T00:00') - new Date(todayStr() + 'T00:00')) / 86400000); }
function initial(n) { return (n || '?').trim().slice(-2); }
function toast(msg) { const t = el('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 2200); }
function isAdmin() { return me && me.role === 'admin'; }
function isCustomerRole() { return me && me.role === 'customer'; }  // 고객(거래처) — 재고 조회 전용
function isCrewRole() { return me && me.role === 'crew'; }  // 시공팀 — 자기 시공 스케줄만
function isRestrictedRole() { return isCustomerRole() || isCrewRole(); }
/* 공장명 통일 규칙: 포함하면 대표명으로 정규화 */
const FACTORY_RULES = [['토마스', '동양'], ['동호', '동호엠엔지'], ['거봉', '거봉석재'], ['영진', '영진석재']];
function normFactory(name) { const n = String(name == null ? '' : name).trim(); if (!n) return n; for (const r of FACTORY_RULES) { if (n.includes(r[0])) return r[1]; } return n; }
/* 대한민국 법정공휴일(대체공휴일·명절 포함) — 인사혁신처 고시 기준(2026~2027) */
const HOLIDAYS = {
  '2026-01-01': '신정', '2026-02-16': '설날', '2026-02-17': '설날', '2026-02-18': '설날', '2026-03-01': '삼일절', '2026-03-02': '대체휴일', '2026-05-01': '근로자의날', '2026-05-05': '어린이날', '2026-05-24': '부처님오신날', '2026-05-25': '대체휴일', '2026-06-06': '현충일', '2026-07-17': '제헌절', '2026-08-15': '광복절', '2026-08-17': '대체휴일', '2026-09-24': '추석', '2026-09-25': '추석', '2026-09-26': '추석', '2026-10-03': '개천절', '2026-10-05': '대체휴일', '2026-10-09': '한글날', '2026-12-25': '성탄절',
  '2027-01-01': '신정', '2027-02-06': '설날', '2027-02-07': '설날', '2027-02-08': '설날', '2027-02-09': '대체휴일', '2027-03-01': '삼일절', '2027-05-01': '근로자의날', '2027-05-05': '어린이날', '2027-05-13': '부처님오신날', '2027-06-06': '현충일', '2027-07-17': '제헌절', '2027-08-15': '광복절', '2027-08-16': '대체휴일', '2027-09-14': '추석', '2027-09-15': '추석', '2027-09-16': '추석', '2027-10-03': '개천절', '2027-10-04': '대체휴일', '2027-10-09': '한글날', '2027-10-11': '대체휴일', '2027-12-25': '성탄절', '2027-12-27': '대체휴일'
};

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
  loadAppConfig();   // 출고관리 연동 수신 주소 로드
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
      await afterAuth(user);   // 역할 판별 후 역할별로 구독(고객은 재고+본인홀딩만)
    } else {
      me = null;
      document.body.classList.remove('cust-mode');
      el('app').style.display = 'none';
      el('login').style.display = 'flex';
      const e = el('login-err'); if (e) { e.style.color = ''; e.textContent = ''; }
      prefillEmail();
    }
  });
}
/* 로그인 성공 후: 직원 디렉터리에서 본인(이메일) 찾기 → 앱 진입 */
async function afterAuth(user) {
  const _email = (user.email || '').toLowerCase();
  // 고객(거래처) 우선 확인 — 직원 목록을 읽지 않고 '본인 역할 문서(roles/이메일)'만 확인
  if (CLOUD) {
    try {
      const rd = await cref('roles').doc(_email).get();
      const _r = rd.exists ? ((rd.data() || {}).role) : '';
      if (_r === 'customer' || _r === 'crew') {
        me = { name: (rd.data().name || _email.split('@')[0]), email: _email, role: _r };
        el('login').style.display = 'none';
        el('app').style.display = 'block';
        el('me-av').textContent = initial(me.name);
        el('me-nm').textContent = me.name;
        document.body.classList.add('cust-mode');
        if (_r === 'customer') startCustomerSubs(); else startCrewSites();
        go('stock');
        return;
      }
    } catch (e) { /* 역할 문서 읽기 실패 → 일반(직원) 흐름으로 진행 */ }
  }
  startSubscriptions();          // 직원/관리자: 전체 컬렉션 구독
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
  document.body.classList.toggle('cust-mode', isRestrictedRole());  // 고객·시공팀: 전용 UI
  if (isRestrictedRole()) { go('stock'); }
  else { ensureStaffRoles(); render(); refreshPushToken(); }
}
/* 직원/관리자 권한 문서(roles/{이메일}) 자동 생성·동기화 — '승인된 직원만' 보안규칙용.
   관리자가 로그인하면 전 직원 roles 문서를 한 번에 생성(마이그레이션). */
async function ensureStaffRoles() {
  if (!CLOUD || !me || !me.email || me.role === 'customer') return;
  try {
    await cref('roles').doc(me.email.toLowerCase()).set({ role: me.role || 'staff', name: me.name || '' }, { merge: true });
    if (me.role === 'admin') {
      for (const m of state.members) {
        if (!m.email) continue;
        try { await cref('roles').doc(m.email.toLowerCase()).set({ role: m.role || 'staff', name: m.name || '' }, { merge: true }); } catch (e) { }
      }
    }
  } catch (e) { console.warn('ensureStaffRoles', e); }
}
/* 관리자용: members 전체를 roles 문서로 확실히 동기화(보안규칙 적용 전 1회 실행) */
async function syncAllRolesNow() {
  if (!CLOUD) { toast('클라우드 모드에서만 가능합니다'); return; }
  if (!isAdmin()) { toast('관리자만 가능합니다'); return; }
  let n = 0, skip = 0;
  for (const m of state.members) {
    if (!m.email) { skip++; continue; }
    try { await cref('roles').doc((m.email || '').toLowerCase()).set({ role: m.role || 'staff', name: m.name || '' }, { merge: true }); n++; } catch (e) { console.warn('syncRoles', e); }
  }
  toast('직원 권한 문서 ' + n + '개 동기화 완료' + (skip ? ' (이메일 없는 ' + skip + '명 제외)' : ''));
}
/* 마스터 컬렉션에서 똑같은 값(앞뒤 공백 정규화)이 여러 개면 하나만 남기고 삭제 */
async function dedupMasterExact(coll) {
  const seen = {}; let del = 0;
  for (const d of (state[coll] || [])) {
    const v = (d.value || '').trim();
    if (!v) { try { await Store.remove(coll, d.id); del++; } catch (e) { } continue; }
    if (seen[v]) { try { await Store.remove(coll, d.id); del++; } catch (e) { } }
    else seen[v] = true;
  }
  return del;
}
/* 관리자용: 공장명 대표명 통일 + 시공팀·발주처·규격 중복 정리 */
async function unifyFactories() {
  if (!isAdmin()) { toast('관리자만 가능합니다'); return; }
  if (!confirm('공장명 통일 + 중복 정리를 실행할까요?\n· 공장명: 토마스→동양, 동호→동호엠엔지, 거봉→거봉석재, 영진→영진석재\n· 시공팀·발주처·규격의 똑같은 이름 중복도 하나로 정리됩니다')) return;
  let sN = 0;
  for (const s of state.sites) { const nf = normFactory(s.factory); if (s.factory && nf !== s.factory) { try { await Store.update('sites', s.id, { factory: nf }); sN++; } catch (e) { } } }
  // 공장 마스터: 대표명 기준으로 묶어서 그룹당 1개만 남기고 중복 삭제
  const groups = {};
  for (const f of (state.factories || [])) {
    const v = (f.value || '').trim();
    if (!v) { try { await Store.remove('factories', f.id); } catch (e) { } continue; }
    const canon = normFactory(v);
    (groups[canon] = groups[canon] || []).push(f);
  }
  let mDel = 0;
  for (const canon in groups) {
    const arr = groups[canon];
    // 값이 이미 대표명과 같은 문서를 우선 유지, 없으면 첫 번째를 대표로 승격
    const keep = arr.find(f => (f.value || '').trim() === canon) || arr[0];
    if ((keep.value || '').trim() !== canon) { try { await Store.update('factories', keep.id, { value: canon }); } catch (e) { } }
    for (const f of arr) { if (f.id !== keep.id) { try { await Store.remove('factories', f.id); mDel++; } catch (e) { } } }
  }
  // 대표명이 아예 없으면 추가
  for (const c of ['동양', '동호엠엔지', '거봉석재', '영진석재']) { if (!groups[c]) { try { await Store.add('factories', { value: c }); } catch (e) { } } }
  // 시공팀·발주처·규격 마스터의 똑같은 값 중복 정리
  const tDel = await dedupMasterExact('teams');
  const supDel = await dedupMasterExact('suppliers');
  const spDel = await dedupMasterExact('specs');
  toast('마스터 정리 완료 · 현장 ' + sN + '건 · 중복삭제 공장 ' + mDel + ' / 시공팀 ' + tDel + ' / 발주처 ' + supDel + ' / 규격 ' + spDel);
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
    // ⚠️ 클라우드에서는 시드 금지: 서버 데이터가 늦게 로드되면 '비었다'고 오인해
    //    기본값을 매번 다시 추가 → 중복 누적됨. 로컬 미리보기(!CLOUD)에서만 시드.
    if (!CLOUD && state.specs.length === 0) {
      for (const val of ['1600*3200*12', '1600*3200*20', '1200*2700*6', '1200*2700*9', '600*1200*9']) {
        await Store.add('specs', { value: val });
      }
    }
    // 가공 공장 기본값 (시공·발주 매뉴얼 기준)
    if (!CLOUD && state.factories.length === 0) {
      for (const val of ['거봉석재', '동호엠엔지', '토마스마블', '영진석재']) await Store.add('factories', { value: val });
    }
    // 시공팀 기본값
    if (!CLOUD && state.teams.length === 0) {
      for (const val of ['JS테크', '모든대리석', '록스타일', '프로세라믹', '현대코리안', '아트라인']) await Store.add('teams', { value: val });
    }
    // 입고 발주처(매입처) 기본값 — 다우세라믹앤석재(중국 직발주)가 기본
    if (!CLOUD && state.suppliers.length === 0) {
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
const _loadedColls = {};
function onData(coll) {
  _loadedColls[coll] = true;
  if (coll === 'members' && !_membersLoaded) {
    _membersLoaded = true;
    _membersWaiters.splice(0).forEach(fn => fn());
  }
  if (coll === 'sites' && me && !isCustomerRole()) autoAdvanceStages();
  if (coll === 'holdings' && me && !isCustomerRole()) { autoReleaseHolds(); maybeActivatePlanned(); }
  if (coll === 'inventory' && me && !isCustomerRole()) maybeActivatePlanned();   // 재고 변동(해제·입고·조정 등)으로 여유 생기면 예정홀딩 확보
  if (['holdings', 'inventory', 'transactions'].includes(coll) && me && !isCustomerRole()) scheduleAvailMirror();   // 고객 노출용 가용수량 미러 갱신(디바운스)
  if (coll === 'chulgoReqs') refreshChulgoChatIfOpen();   // 채팅 모달 열려있으면 실시간 갱신
  if (me) render();
}
/* 예정홀딩(및 일부 예정 품목)을 재고 여유가 생길 때 일정 빠른 순으로 자동 확보 — 재진입 방지 */
let _actPlanRun = false;
async function maybeActivatePlanned() {
  if (_actPlanRun || !me || isCustomerRole()) return;
  if (!_loadedColls.holdings || !_loadedColls.inventory) return;   // 로드 전 계산 금지(오배치 방지)
  const hasPlanned = (state.holdings || []).some(h => !['확정', '해제'].includes(h.status || '홀딩') && holdItems(h).some(it => it.planned));
  if (!hasPlanned) return;
  _actPlanRun = true;
  try {
    await activatePlannedHolds();     // ① 빈 재고를 일정 빠른 순으로 예정→활성
    await preemptForUrgent();          // ② 임박(3일 이내) 미충족 건이 3주+ 남은 홀딩 수량을 가져오고, 밀린 건은 예정으로
  } catch (e) { console.warn('reconcileHolds', e); }
  finally { setTimeout(() => { _actPlanRun = false; }, 500); }
}
/* 가용수량 미러: 고객은 자기 홀딩만 보이므로 전체 홀딩을 뺀 '가용'을 계산할 수 없음.
   직원 클라이언트가 inventory 문서에 availJang(=실재고−활성홀딩−파손)을 기록해 고객 화면에 노출.
   ★ 홀딩/재고 스냅샷 도착 순서에 따른 오계산(홀딩 로드 전 전체수량을 가용으로 기록)을 막기 위해
     디바운스로 마지막 상태에서 한 번만 계산하고, 홀딩·재고가 모두 로드된 뒤에만 기록. */
let _availTimer = null, _availBusy = false;
function scheduleAvailMirror() {
  if (!me || isCustomerRole() || !CLOUD) return;
  clearTimeout(_availTimer);
  _availTimer = setTimeout(runAvailMirror, 700);
}
async function runAvailMirror() {
  if (!me || isCustomerRole() || !CLOUD) return;
  if (_availBusy) { scheduleAvailMirror(); return; }               // 진행 중이면 뒤로 미룸(마지막 상태 반영)
  if (!_loadedColls.holdings || !_loadedColls.inventory) { scheduleAvailMirror(); return; }  // 로드 전 계산 금지
  _availBusy = true;
  try {
    for (const it of state.inventory) {
      const av = Math.max(0, availJang(it));
      const cur = (it.availJang == null) ? null : +it.availJang;
      if (cur !== av) { try { await Store.update('inventory', it.id, { availJang: av }); } catch (e) { } }
    }
  } finally { _availBusy = false; }
}

/* ===== 쉽먼트 확인(Material Shipment Confirmation) 연동 브릿지 =====
   같은 Firebase의 공용 컬렉션 teams/dawoo/shipments 를 두 앱이 공유.
   · 이 앱(재고): 세면대 수입발주 + 일반 출고를 shipments 문서로 '올림'(우리 소유 필드만 병합).
   · 확인 앱: 같은 문서에 confirmed/confirmedAt/confirmedBy/confirmNote 를 '써넣음'(우리는 읽기만).
   문서 id 규칙: 세면대 = 'B_'+basinId, 출고묶음 = 'S_'+shipId(없으면 txnId).
   스키마(우리가 쓰는 필드): { source:'dawoo-inventory', kind:'basin'|'out', refId, ref, vendor, items:[{name,qty,spec,orderNo}], date, dest, status, updatedAt } */
let _shipBridgeTimer = null, _shipBridgeBusy = false;
function scheduleShipmentBridge() {
  if (!me || isCustomerRole() || !CLOUD) return;
  clearTimeout(_shipBridgeTimer);
  _shipBridgeTimer = setTimeout(runShipmentBridge, 900);
}
function shipmentDocFor(rec) { return (state.shipments || []).find(s => s.id === rec); }
async function runShipmentBridge() {
  if (!me || isCustomerRole() || !CLOUD) return;
  if (_shipBridgeBusy) { scheduleShipmentBridge(); return; }
  if (!_loadedColls.basins || !_loadedColls.transactions || !_loadedColls.shipments) { scheduleShipmentBridge(); return; }
  _shipBridgeBusy = true;
  try {
    const want = {};   // 올려야 할 문서(우리 소유 필드)
    // 1) 세면대 수입 발주
    (state.basins || []).forEach(b => {
      const its = basinItems(b);
      want['B_' + b.id] = {
        source: 'dawoo-inventory', kind: 'basin', refId: b.id,
        ref: (b.vendor || '') + ' · ' + (its.map(x => x.stone).filter(Boolean).join('/') || '세면대'),
        vendor: b.vendor || '', orderDate: b.orderDate || '', date: b.shipDate || b.orderDate || '',
        address: b.address || '', status: b.stage || '견적',
        items: its.map(x => ({ name: x.stone || '', qty: +x.qty || 0, spec: x.spec || '', orderNo: x.orderNo || '', quoteNo: x.quoteNo || '' })),
        updatedAt: Date.now()
      };
    });
    // 2) 일반 출고(묶음)
    const outs = (state.transactions || []).filter(t => t.type === 'out');
    const gmap = {};
    outs.forEach(t => { const k = 'S_' + (t.shipId || t.id); (gmap[k] = gmap[k] || { key: k, t0: t, items: [] }).items.push(t); });
    Object.values(gmap).forEach(g => {
      const t = g.t0;
      want[g.key] = {
        source: 'dawoo-inventory', kind: 'out', refId: t.shipId || t.id,
        ref: (t.targetName || '') + ' · ' + g.items.map(x => x.itemName).filter(Boolean).join(', '),
        vendor: t.targetName || '', date: t.date || '', dest: t.dest || t.factory || '', status: '출고',
        items: g.items.map(x => ({ name: x.itemName || '', qty: +x.jang || 0, spec: x.spec || '', lot: x.lot || '' })),
        updatedAt: Date.now()
      };
    });
    // 변경분만 업서트(우리 필드 해시 비교 — 확인앱이 쓴 필드는 병합 보존)
    for (const id in want) {
      const cur = shipmentDocFor(id);
      const w = want[id];
      const sig = JSON.stringify([w.ref, w.status, w.date, w.dest, w.items]);
      const curSig = cur ? JSON.stringify([cur.ref, cur.status, cur.date, cur.dest, cur.items]) : null;
      if (sig !== curSig) { try { await Store.setMerge('shipments', id, w); } catch (e) { } }
    }
  } finally { _shipBridgeBusy = false; }
}
/* 특정 발주/출고의 확인 상태 조회 — 배지 표시용 */
function shipConfirm(kind, refId) { return (state.shipments || []).find(s => s.id === (kind === 'basin' ? 'B_' : 'S_') + refId) || null; }

/* ===== 출고관리 앱(dawoo-chulgo, 별도 Firebase) 연동 — 수신 창구(CF)로 전송 =====
   두 앱이 다른 Firebase라 직접 쓰기가 막혀 있어, 출고관리 앱에 만든 '수신 엔드포인트'로 POST 전송.
   전송 규격(payload): { source:'dawoo-tile-stone', kind:'outbound'|'basin', company, client, content, qty, sender, memo, dest, refId, refDate, status:'requested' } */
let _chulgoEndpoint = '';
async function loadAppConfig() {
  if (!CLOUD || !me || isCustomerRole()) return;
  try { const d = await cref('config').doc('app').get(); if (d.exists) _chulgoEndpoint = (d.data().chulgoEndpoint || '').trim(); } catch (e) { }
}
async function saveChulgoEndpoint() {
  const v = (el('chulgo-ep') && el('chulgo-ep').value || '').trim();
  try { await cref('config').doc('app').set({ chulgoEndpoint: v }, { merge: true }); _chulgoEndpoint = v; toast('수신 주소 저장됨'); }
  catch (e) { toast('저장 실패: ' + (e.message || e)); }
}
async function sendToChulgo(kind, refId) {
  if (!_chulgoEndpoint) { toast('출고관리 수신 주소가 아직 없습니다 (설정 → 출고관리 연동에서 입력)'); return; }
  let p;
  if (kind === 'basin') {
    const b = (state.basins || []).find(x => x.id === refId); if (!b) return;
    const its = basinItems(b);
    p = { kind: 'basin', client: b.vendor || '', content: its.map(x => `${x.stone || ''} ${x.spec || ''} ${x.qty || 0}개`).join(', '), qty: basinTotalQty(b), memo: b.note || '', dest: b.address || '', refDate: b.orderDate || '' };
  } else {
    const outs = (state.transactions || []).filter(t => t.type === 'out' && (t.shipId || t.id) === refId); if (!outs.length) return;
    const t0 = outs[0];
    p = { kind: 'outbound', client: t0.targetName || '', content: outs.map(x => `${x.itemName || ''} ${+x.jang || 0}장${x.lot ? ' 롯' + x.lot : ''}`).join(', '), qty: outs.reduce((a, b) => a + (+b.jang || 0), 0), memo: t0.note || '', dest: t0.dest || t0.factory || '', refDate: t0.date || '' };
  }
  const payload = Object.assign({ source: 'dawoo-tile-stone', company: '다우세라믹앤석재', sender: (me && me.name) || '', refId, sentAt: Date.now(), status: 'requested' }, p);
  try {
    const r = await fetch(_chulgoEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    if (kind === 'basin') { await Store.update('basins', refId, { sentChulgo: true, sentChulgoAt: Date.now() }); }
    else { for (const t of (state.transactions || []).filter(t => t.type === 'out' && (t.shipId || t.id) === refId)) { try { await Store.update('transactions', t.id, { sentChulgo: true }); } catch (e) { } } }
    toast('출고관리로 전송했습니다 ✓');
  } catch (e) { toast('전송 실패: ' + (e.message || e) + ' (수신 주소·CORS 확인)'); }
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
/* 고객 홀딩 요청 → 전 직원 즉시 푸시 (Cloud Function 'holdreq' 액션) */
async function notifyHoldReq(summary) {
  try {
    if (!CLOUD || !auth || !auth.currentUser) return;
    const token = await auth.currentUser.getIdToken();
    await fetch(PUSH_FN + '?action=holdreq', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ vendor: (me && me.name) || '', summary: summary || '' })
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
  if (isRestrictedRole()) t = 'stock';   // 고객·시공팀은 전용 화면만
  tab = t;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-i').forEach(n => n.classList.toggle('active', n.dataset.tab === t));
  document.querySelectorAll('.drawer-i[data-tab]').forEach(n => n.classList.toggle('active', n.dataset.tab === t));
  el('pg-' + t).classList.add('active');
  el('fab').style.display = (!isRestrictedRole() && (t === 'sites' || t === 'stock' || t === 'hold' || t === 'basin')) ? 'flex' : 'none';
  render();
  window.scrollTo(0, 0);
}
function fabAction() {
  if (tab === 'sites') openSiteForm();
  else if (tab === 'stock') openStockForm();
  else if (tab === 'ship') openShipForm();
  else if (tab === 'hold') openHoldForm();
  else if (tab === 'basin') openBasinForm();
}
let _renderTimer = null;
function render() {
  if (!me) return;
  // 입력 중(검색창·폼 포커스)에는 전체 재렌더를 미뤄 한글 입력·검색 끊김 방지
  const _ae = document.activeElement;
  if (_ae && (_ae.tagName === 'INPUT' || _ae.tagName === 'TEXTAREA' || _ae.isContentEditable)) {
    if (!_renderTimer) _renderTimer = setTimeout(() => { _renderTimer = null; render(); }, 600);
    return;
  }
  if (_renderTimer) { clearTimeout(_renderTimer); _renderTimer = null; }
  // 스크롤 위치 보존(재렌더로 스크롤이 위로 튕기는 것 방지) — data-keepscroll + id 붙은 요소
  const _keep = {};
  document.querySelectorAll('[data-keepscroll]').forEach(e => { if (e.id && e.scrollTop > 0) _keep[e.id] = e.scrollTop; });
  if (Object.keys(_keep).length) requestAnimationFrame(() => { for (const id in _keep) { const e = el(id); if (e) e.scrollTop = _keep[id]; } });
  if (isCustomerRole()) { renderCustomerStock(); return; }   // 고객: 재고 조회 전용
  if (isCrewRole()) { renderCrewSchedule(); return; }        // 시공팀: 시공 스케줄 전용
  if (tab === 'home') renderHome();
  else if (tab === 'sites') renderSites();
  else if (tab === 'stock') renderStock();
  else if (tab === 'ship') renderShip();
  else if (tab === 'hold') renderHold();
  else if (tab === 'basin') renderBasin();
  else if (tab === 'chulgo') renderChulgo();
  else if (tab === 'settings') renderSettings();
}
/* ---------- 고객(거래처) 재고 조회 전용 화면 (읽기 전용) ---------- */
function custStockList() {
  const q = (filters.custSearch || '').trim().toLowerCase();
  let l = state.inventory.filter(i => catIsCeramicLike(itemCat(i))).sort((a, b) => (a.name || '').localeCompare(b.name || ''));   // 부자재는 직원용 — 고객엔 세라믹·석재만
  if (q) l = l.filter(i => (i.name || '').toLowerCase().includes(q) || (i.spec || '').toLowerCase().includes(q));
  return l;
}
/* 고객에게 보이는 수량 = 가용수량(전체 홀딩 제외). 미러 필드 availJang 사용, 없으면 실재고로 대체 */
function custAvail(i) { return (i.availJang == null) ? Math.max(0, +i.jang || 0) : Math.max(0, +i.availJang || 0); }
function custStockBody(list) {
  if (!list.length) return `<div class="empty"><i class="ti ti-search-off"></i>해당하는 자재가 없습니다</div>`;
  const rows = list.map(i => {
    const jang = custAvail(i);
    const inStock = jang > 0;
    const dot = inStock ? 'background:#1D9E75;--pc:rgba(29,158,117,.6)' : 'background:#E23B3B;--pc:rgba(226,59,59,.75)';
    const lbl = inStock ? '<span style="font-size:11.5px;font-weight:600;color:#0F6E56">있음</span>' : '<span style="font-size:11.5px;font-weight:600;color:#A32D2D">품절</span>';
    let restock = '';
    if (i.restockDate) { const p = String(i.restockDate).split('-'); if (p.length === 3) { const rcol = inStock ? '#2f6fed' : 'var(--amber-t)'; restock = `<div style="font-size:11px;color:${rcol};margin-top:3px;font-weight:600"><i class="ti ti-truck-delivery" style="font-size:12px;vertical-align:-1px"></i> 재입고 예정 ${+p[1]}/${+p[2]}</div>`; } }
    return `<tr>
      <td><div style="font-weight:600;color:var(--t1);word-break:keep-all">${esc(i.name)}</div>${i.spec ? `<div style="color:var(--t3);font-size:11px;margin-top:2px">${esc(i.spec)}</div>` : ''}${restock}</td>
      <td style="text-align:right;white-space:nowrap"><div style="font-weight:700;color:${inStock ? 'var(--t1)' : 'var(--t3)'}">${jang}장</div></td>
      <td><span style="display:inline-flex;align-items:center;gap:6px"><span class="live-dot" style="${dot}"></span>${lbl}</span></td>
    </tr>`;
  }).join('');
  return `<div style="border:0.5px solid var(--bd);border-radius:12px;overflow:hidden;margin-top:2px">
    <div id="cust-stock-wrap" data-keepscroll style="max-height:calc(100vh - 250px);min-height:200px;overflow-y:auto;-webkit-overflow-scrolling:touch">
      <table class="cust-tbl"><thead><tr><th>자재명 · 규격</th><th style="text-align:right;width:70px">가용재고</th><th style="width:62px">상태</th></tr></thead><tbody>${rows}</tbody></table>
    </div></div>`;
}
function filterCustStock() {
  filters.custSearch = el('cust-search') ? el('cust-search').value : '';
  if (el('cust-body')) el('cust-body').innerHTML = custStockBody(custStockList());
  const x = el('cust-search-x'); if (x) x.style.display = (filters.custSearch || '').trim() ? '' : 'none';
}
function clearCustStock() { filters.custSearch = ''; if (el('cust-search')) el('cust-search').value = ''; filterCustStock(); const i = el('cust-search'); if (i) i.focus(); }
/* 고객 본인(업체) 홀딩 — vendor 가 계정명과 같은 것만. 서버 규칙으로도 제한됨 */
function custMyHolds() {
  return (state.holdings || []).filter(h => h.status !== '해제' && _normName(h.vendor) === _normName(me.name))
    .sort((a, b) => (a.useDate || '9999-99-99').localeCompare(b.useDate || '9999-99-99'));
}
/* 고객 지난 홀딩 — 기간 경과 등으로 해제된 것 */
function custMyPastHolds() {
  return (state.holdings || []).filter(h => h.status === '해제' && _normName(h.vendor) === _normName(me.name))
    .sort((a, b) => (b.useDate || '0000-00-00').localeCompare(a.useDate || '0000-00-00'));
}
function custHoldCard(h, isPast) {
  const st = isPast ? '지난 · 해제' : holdStatusText(h);
  const cls = holdStatusText(h) === '출고완료' ? 'p-done' : (holdStatusText(h) === '예정' ? 'p-wait' : 'p-hold');
  const items = holdItems(h).map(it => `<div style="color:var(--t2);font-size:12.5px;margin-top:2px;word-break:keep-all">· <b style="color:${isPast ? 'var(--t2)' : 'var(--t1)'}">${esc(it.materialName || '-')}</b> ${+it.jang || 0}장${it.hebe ? ` (${(+it.hebe).toFixed(1)}㎡)` : ''}${it.lot ? ` · 롯트 ${esc(it.lot)}` : ''}</div>`).join('');
  return `<div class="card" style="margin-bottom:9px;padding:12px 14px${isPast ? ';opacity:.85;background:var(--soft)' : ''}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
        <div style="font-size:12.5px;color:var(--t3)"><i class="ti ti-calendar" style="font-size:12px"></i> ${h.useDate ? '사용예정 ' + esc(h.useDate) : '예정일 미정'}</div>
        ${isPast ? `<span class="pill" style="flex:none;background:var(--bd2);color:var(--t3)">${esc(st)}</span>` : `<span class="pill ${cls}" style="flex:none">${esc(st)}</span>`}</div>
      <div style="margin-top:6px">${items}</div>
      ${h.note ? `<div style="margin-top:7px;padding-top:7px;border-top:1px dashed var(--bd2);font-size:12.5px;color:var(--t2);word-break:break-all"><i class="ti ti-note" style="font-size:12px;color:var(--t3)"></i> ${esc(h.note)}</div>` : ''}
    </div>`;
}
/* 고객 홀딩을 상태별 3그룹으로 분리: 진행중(홀딩·예정) / 출고완료(확정) / 해제 */
function custHoldGroups() {
  const mine = (state.holdings || []).filter(h => _normName(h.vendor) === _normName(me.name));
  const active = mine.filter(h => !['확정', '해제'].includes(h.status || '홀딩')).sort((a, b) => (a.useDate || '9999-99-99').localeCompare(b.useDate || '9999-99-99'));
  const done = mine.filter(h => (h.status || '') === '확정').sort((a, b) => (b.useDate || '0000-00-00').localeCompare(a.useDate || '0000-00-00'));
  const released = mine.filter(h => (h.status || '') === '해제').sort((a, b) => (b.useDate || '0000-00-00').localeCompare(a.useDate || '0000-00-00'));
  return { active, done, released };
}
/* 검색어 매칭: 자재명·롯트·비고 */
function custHoldMatch(h, q) {
  if (!q) return true;
  const inItems = holdItems(h).some(it => (it.materialName || '').toLowerCase().includes(q) || (it.lot || '').toLowerCase().includes(q));
  return inItems || (h.note || '').toLowerCase().includes(q);
}
/* 현재 선택된 뷰의 카드 목록 HTML (검색 반영) */
function custHoldListHtml() {
  const g = custHoldGroups();
  const view = filters.custHoldView || 'active';
  const q = (filters.custHoldSearch || '').trim().toLowerCase();
  const cur = view === 'done' ? g.done : (view === 'released' ? g.released : g.active);
  const filtered = cur.filter(h => custHoldMatch(h, q));
  if (!filtered.length) return `<div style="font-size:12.5px;color:var(--t3);padding:16px 6px;text-align:center">${q ? '검색 결과가 없습니다' : '해당 내역이 없습니다'}</div>`;
  return filtered.map(h => custHoldCard(h, view === 'released')).join('');
}
function custHoldsBody() {
  const g = custHoldGroups();
  const view = filters.custHoldView || 'active';
  const q = filters.custHoldSearch || '';
  const note = `<div style="font-size:12px;color:var(--t2);margin-top:12px;line-height:1.55;background:var(--soft);border-radius:10px;padding:11px 13px"><i class="ti ti-info-circle" style="font-size:13px;color:var(--blue)"></i> 지난(해제) 홀딩의 <b>활성화(재홀딩)·기간 연장</b>이 필요하시면 담당자에게 <b>직접 문의</b>해 주세요.</div>`;
  if (!g.active.length && !g.done.length && !g.released.length) return `<div class="empty"><i class="ti ti-lock-off"></i>등록된 홀딩이 없습니다</div>${note}`;
  const chip = (v, label, ic, n) => `<button class="chip ${view === v ? 'active' : ''}" onclick="goCustHoldView('${v}')"><i class="ti ${ic}"></i> ${label}${n ? ` (${n})` : ''}</button>`;
  let html = `<div class="chips" style="margin:2px 0 9px">${chip('active', '진행중', 'ti-lock', g.active.length)}${chip('done', '출고완료', 'ti-circle-check', g.done.length)}${chip('released', '해제', 'ti-history', g.released.length)}</div>`;
  html += `<div class="search-box" style="margin-bottom:9px">
      <i class="ti ti-search"></i>
      <input id="custhold-search" placeholder="자재명·롯트·비고 검색" value="${esc(q)}" oninput="filterCustHold()" autocomplete="off" lang="ko">
      <button class="search-x" id="custhold-search-x" style="${q.trim() ? '' : 'display:none'}" onclick="clearCustHold()"><i class="ti ti-x"></i></button>
    </div>`;
  html += `<div id="custhold-list" data-keepscroll style="max-height:58vh;min-height:160px;overflow-y:auto;-webkit-overflow-scrolling:touch;border:0.5px solid var(--bd);border-radius:12px;padding:9px 9px 1px;background:#fff">${custHoldListHtml()}</div>`;
  html += note;
  return html;
}
function goCustHoldView(v) { filters.custHoldView = v; filters.custHoldSearch = ''; renderCustomerStock(); }
function filterCustHold() {
  filters.custHoldSearch = el('custhold-search') ? el('custhold-search').value : '';
  const box = el('custhold-list'); if (box) box.innerHTML = custHoldListHtml();
  const x = el('custhold-search-x'); if (x) x.style.display = (filters.custHoldSearch || '').trim() ? '' : 'none';
}
function clearCustHold() { filters.custHoldSearch = ''; if (el('custhold-search')) el('custhold-search').value = ''; filterCustHold(); const i = el('custhold-search'); if (i) i.focus(); }
function goCustTab(v) { filters.custTab = v; renderCustomerStock(); }
/* 고객 로그인 시: 재고(읽기 허용) + 본인 업체 홀딩만 구독. 나머지 컬렉션은 구독하지 않음(권한 없음·충돌 방지) */
function startCustomerSubs() {
  if (!CLOUD || !me || me.role !== 'customer') return;
  try {
    cref('inventory').onSnapshot(snap => {
      state.inventory = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
      if (me && me.role === 'customer' && (filters.custTab || 'stock') === 'stock') renderCustomerStock();
    }, err => console.warn('cust inv', err));
  } catch (e) { console.warn(e); }
  startCustomerHoldings();
  startCustomerHoldReqs();
}
function startCustomerHoldReqs() {
  if (!CLOUD || !me || me.role !== 'customer' || !me.name) return;
  try {
    cref('holdRequests').where('vendor', '==', me.name).onSnapshot(snap => {
      state.holdRequests = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
      if (me && me.role === 'customer' && (filters.custTab || 'stock') === 'req') renderCustomerStock();
    }, err => console.warn('cust holdreq', err));
  } catch (e) { console.warn(e); }
}
function startCustomerHoldings() {
  if (!CLOUD || !me || me.role !== 'customer' || !me.name) return;
  try {
    cref('holdings').where('vendor', '==', me.name).onSnapshot(snap => {
      state.holdings = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
      if (me && me.role === 'customer') renderCustomerStock();   // 홀딩 로드되면 탭 상관없이 갱신(배지 반영)
    }, err => console.warn('cust holds', err));
  } catch (e) { console.warn(e); }
}
function renderCustomerStock() {
  const tab = filters.custTab || 'stock';
  const list = custStockList();
  const custInv = state.inventory.filter(i => catIsCeramicLike(itemCat(i)));
  const inN = custInv.filter(i => custAvail(i) > 0).length;
  const outN = custInv.length - inN;
  const myHolds = custMyHolds();
  const stockSec = `
    <div style="font-size:12px;color:var(--t3);margin:2px 0 8px"><span class="live-dot" style="background:#1D9E75;--pc:rgba(29,158,117,.6);width:7px;height:7px;display:inline-block;vertical-align:middle;margin-right:5px"></span>실시간 · 재고있음 ${inN} · 품절 ${outN}</div>
    <div class="search-box">
      <i class="ti ti-search"></i>
      <input id="cust-search" placeholder="자재명·규격 검색" value="${esc(filters.custSearch || '')}" oninput="filterCustStock()" autocomplete="off" lang="ko">
      <button class="search-x" id="cust-search-x" style="${(filters.custSearch || '').trim() ? '' : 'display:none'}" onclick="clearCustStock()"><i class="ti ti-x"></i></button>
    </div>
    <div id="cust-body">${custStockBody(list)}</div>
    ${state.inventory.some(i => i.restockDate) ? `<div style="font-size:11px;color:var(--t3);margin-top:8px;line-height:1.5;background:var(--soft);border-radius:9px;padding:9px 11px"><i class="ti ti-info-circle" style="font-size:12px;vertical-align:-1px"></i> 재입고 일정은 통관사·선사 스케줄에 따라 변동될 수 있습니다.</div>` : ''}`;
  const holdsSec = `<div style="font-size:12px;color:var(--t3);margin:2px 0 8px">우리 업체 홀딩 내역 · 상태별로 확인하세요</div>${custHoldsBody()}`;
  const myReqs = (state.holdRequests || []).slice().sort((a, b) => (+b.createdAt || 0) - (+a.createdAt || 0));
  const reqPending = myReqs.filter(r => (r.status || '대기') === '대기').length;
  const reqSec = `
    <div class="card" style="padding:13px 15px;margin-bottom:12px">
      <div style="font-weight:600;font-size:14px;margin-bottom:10px"><i class="ti ti-lock-plus" style="color:var(--blue)"></i> 홀딩 요청 보내기</div>
      <div class="fld" style="margin-bottom:8px"><label style="font-size:12px;color:var(--t2)">자재명 <span style="color:var(--red-t)">*</span></label>${searchBox('creq-mat', '자재명 검색·선택', '', 'invNames', '')}</div>
      <div style="display:flex;gap:8px;margin-bottom:8px">
        <div class="fld" style="flex:1"><label style="font-size:12px;color:var(--t2)">장수 <span style="color:var(--red-t)">*</span></label><input id="creq-jang" inputmode="numeric" placeholder="장수" style="width:100%;font-size:15px;padding:9px 11px;border:1.5px solid var(--bd2);border-radius:10px"></div>
        <div class="fld" style="flex:1.2"><label style="font-size:12px;color:var(--t2)">사용 예정일 <span style="color:var(--red-t)">*</span></label><input type="date" id="creq-usedate" style="width:100%;font-size:14px;padding:8px 10px;border:1.5px solid var(--bd2);border-radius:10px"></div>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:10px">
        <div class="fld" style="flex:1"><label style="font-size:12px;color:var(--t2)">현장명 <span style="color:var(--red-t)">*</span></label><input id="creq-site" lang="ko" placeholder="예: ○○현장" style="width:100%;font-size:15px;padding:9px 11px;border:1.5px solid var(--bd2);border-radius:10px"></div>
        <div class="fld" style="flex:1"><label style="font-size:12px;color:var(--t2)">담당자명 <span style="color:var(--red-t)">*</span></label><input id="creq-manager" lang="ko" placeholder="예: 김과장" style="width:100%;font-size:15px;padding:9px 11px;border:1.5px solid var(--bd2);border-radius:10px"></div>
      </div>
      <button class="btn btn-pri btn-block" onclick="submitHoldReq()"><i class="ti ti-send"></i> 요청 보내기</button>
      <div style="font-size:11px;color:var(--t3);margin-top:8px;line-height:1.5"><i class="ti ti-info-circle" style="font-size:12px"></i> 모든 항목은 필수입니다. 요청을 보내면 담당자에게 알림이 가고, 확인 후 확정됩니다.</div>
    </div>
    <div style="font-size:12px;color:var(--t3);margin:2px 0 8px">내 요청 내역 · 총 ${myReqs.length}건${reqPending ? ` · 대기 ${reqPending}` : ''}</div>
    ${custReqBody(myReqs)}`;
  el('pg-stock').innerHTML = `
    <div style="max-width:680px;margin:0 auto">
    <div class="ph"><div><h2><i class="ti ti-packages"></i>${esc(me.name)}</h2><p><span class="live-dot" style="background:#1D9E75;--pc:rgba(29,158,117,.6);width:7px;height:7px;display:inline-block;vertical-align:middle;margin-right:5px"></span>실시간 조회</p></div>
      <button class="btn btn-sm" onclick="logout()"><i class="ti ti-logout"></i>로그아웃</button></div>
    <div class="chips" style="margin-bottom:10px">
      <button class="chip ${tab === 'stock' ? 'active' : ''}" onclick="goCustTab('stock')"><i class="ti ti-packages"></i> 재고 조회</button>
      <button class="chip ${tab === 'holds' ? 'active' : ''}" onclick="goCustTab('holds')"><i class="ti ti-lock"></i> 내 홀딩${myHolds.length ? ` (${myHolds.length})` : ''}</button>
      <button class="chip ${tab === 'req' ? 'active' : ''}" onclick="goCustTab('req')"><i class="ti ti-lock-plus"></i> 홀딩 요청${reqPending ? ` (${reqPending})` : ''}</button>
    </div>
    ${tab === 'stock' ? stockSec : (tab === 'req' ? reqSec : holdsSec)}
    </div>`;
}
/* 고객 본인 홀딩 요청 내역 카드 */
function custReqBody(list) {
  if (!list.length) return `<div class="empty"><i class="ti ti-inbox"></i>보낸 요청이 없습니다</div>`;
  return list.map(r => {
    const st = r.status || '대기';
    const col = st === '승인' ? { bg: 'var(--gl2,#e8f7f0)', c: '#0F6E56' } : (st === '취소' ? { bg: 'var(--soft)', c: 'var(--t3)' } : { bg: '#fef3e2', c: '#9a6a12' });
    const items = (r.items || []).map(it => `<b style="color:var(--t1)">${esc(it.materialName || '-')}</b> ${+it.jang || 0}장${it.hebe ? ` (${(+it.hebe).toFixed(1)}㎡)` : ''}`).join(', ');
    const when = r.createdAt ? new Date(+r.createdAt).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' }) : '';
    return `<div class="card" style="margin-bottom:8px;padding:11px 13px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
        <div style="font-size:13.5px;word-break:keep-all">${items}</div>
        <span style="flex:none;font-size:11px;font-weight:700;background:${col.bg};color:${col.c};border-radius:999px;padding:3px 10px">${esc(st)}</span>
      </div>
      <div style="font-size:11.5px;color:var(--t3);margin-top:5px">${r.useDate ? '사용예정 ' + esc(r.useDate) + ' · ' : ''}요청 ${when}${r.note ? ' · ' + esc(r.note) : ''}</div>
      ${st === '취소' && r.rejectReason ? `<div style="font-size:12px;color:var(--red-t);margin-top:6px;background:#fff2f0;border-radius:8px;padding:7px 10px"><i class="ti ti-message-2" style="font-size:13px"></i> 취소 사유: ${esc(r.rejectReason)}</div>` : ''}
    </div>`;
  }).join('');
}
async function submitHoldReq() {
  const mat = (el('creq-mat') && el('creq-mat').value || '').trim();
  const jang = parseFloat(el('creq-jang') && el('creq-jang').value) || 0;
  const useDate = el('creq-usedate') ? el('creq-usedate').value : '';
  const site = (el('creq-site') && el('creq-site').value || '').trim();
  const manager = (el('creq-manager') && el('creq-manager').value || '').trim();
  if (!mat) { toast('자재를 선택하세요'); return; }
  if (jang <= 0) { toast('장수를 입력하세요'); return; }
  if (!useDate) { toast('사용 예정일을 선택하세요'); return; }
  if (!site) { toast('현장명을 입력하세요'); return; }
  if (!manager) { toast('담당자명을 입력하세요'); return; }
  const note = '현장 ' + site + ' · 담당 ' + manager;
  if (_busy) return; _busy = true;
  try {
    const it = state.inventory.find(i => _normName(i.name) === _normName(mat));
    const hebe = it ? +(jang * (+it.hebePerJang || 0)).toFixed(2) : 0;
    await Store.add('holdRequests', { vendor: me.name, items: [{ materialName: mat, jang: jang, hebe: hebe }], useDate: useDate, site: site, manager: manager, note: note, status: '대기', createdAt: Date.now(), by: me.name });
    notifyHoldReq(mat + ' ' + jang + '장 · ' + site);
    toast('홀딩 요청을 보냈습니다 ✓');
    if (el('creq-mat')) el('creq-mat').value = '';
    if (el('creq-jang')) el('creq-jang').value = '';
    if (el('creq-usedate')) el('creq-usedate').value = '';
    if (el('creq-site')) el('creq-site').value = '';
    if (el('creq-manager')) el('creq-manager').value = '';
  } catch (e) { toast('요청 전송 실패 — 잠시 후 다시 시도하세요'); } finally { _busy = false; }
}

/* ---------- 시공팀(crew) 시공 스케줄 전용 화면 (읽기 전용 · 자기 팀 현장만) ---------- */
function crewSites() {
  return (state.sites || []).filter(s => _normName(s.team) === _normName(me.name))
    .sort((a, b) => (a.constructDate || '9999-99-99').localeCompare(b.constructDate || '9999-99-99'));
}
function startCrewSites() {
  if (!CLOUD || !me || me.role !== 'crew' || !me.name) return;
  try {
    cref('sites').where('team', '==', me.name).onSnapshot(snap => {
      state.sites = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
      if (me && me.role === 'crew') render();
    }, err => console.warn('crew sites', err));
  } catch (e) { console.warn(e); }
}
function crewSiteCard(s) {
  const d = daysFromNow(s.constructDate);
  const dtag = d != null ? (d < 0 ? '지남' : (d === 0 ? '오늘' : 'D-' + d)) : '';
  const dcol = d != null && d >= 0 && d <= 3 ? 'var(--red-t)' : 'var(--gd)';
  const items = s.matPending ? `<span style="display:inline-block;background:#fdf3d6;border:0.5px solid #f0d38a;color:#8a5a00;border-radius:8px;padding:2px 8px;margin-top:3px;font-size:11.5px;font-weight:600"><i class="ti ti-help-circle" style="font-size:12px"></i> 자재 미정</span>` : siteItems(s).map(it => `<span style="display:inline-block;background:var(--soft,#f6f8f7);border:0.5px solid var(--bd);border-radius:8px;padding:2px 7px;margin:3px 3px 0 0;font-size:11.5px;word-break:keep-all">${esc(it.name)}${it.qty ? ' ' + it.qty : ''}</span>`).join('');
  return `<div class="card" style="margin-bottom:9px;padding:12px 14px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
      <div style="min-width:0"><div style="font-size:15px;font-weight:700;word-break:keep-all">${esc(s.name || s.client || '-')}</div>${s.client && s.name ? `<div style="font-size:11.5px;color:var(--t3);margin-top:1px">${esc(s.client)}</div>` : ''}</div>
      <span class="pill p-prog" style="flex:none">${esc(s.stage || '접수')}</span>
    </div>
    ${(s.address || s.region) ? `<div style="font-size:12.5px;color:var(--t2);margin-top:6px;word-break:keep-all"><i class="ti ti-map-pin" style="font-size:12px"></i> ${esc(s.address || s.region)}</div>` : ''}
    <div style="display:flex;gap:14px;margin-top:8px;font-size:12.5px;flex-wrap:wrap">
      <div><span style="color:var(--t3)">시공</span> <b style="color:${dcol}">${esc(s.constructDate || '미정')}${dtag ? ' · ' + dtag : ''}</b></div>
      ${s.measureDate ? `<div><span style="color:var(--t3)">실측</span> <b>${esc(s.measureDate)}</b></div>` : ''}
      ${s.factory ? `<div><span style="color:var(--t3)">공장</span> <b>${esc(s.factory)}</b></div>` : ''}
      ${s.manager ? `<div><span style="color:var(--t3)">담당</span> <b>${esc(s.manager)}</b></div>` : ''}
    </div>
    ${items ? `<div style="margin-top:6px">${items}</div>` : ''}
    ${s.crewNote ? `<div style="margin-top:9px;background:var(--gl2,#e8f7f0);border:0.5px solid var(--gbd,#b8e6d3);border-radius:9px;padding:8px 10px;color:#0F6E56;word-break:keep-all"><b style="font-size:11px;display:block;margin-bottom:2px"><i class="ti ti-message-2" style="font-size:12px"></i> 전달사항</b><span style="font-size:12.5px">${esc(s.crewNote)}</span></div>` : ''}
  </div>`;
}
function crewListBody(list) {
  if (!list.length) return `<div class="empty"><i class="ti ti-calendar-off"></i>예정된 시공이 없습니다</div>`;
  return list.map(crewSiteCard).join('');
}
function crewCalendarHtml() {
  const ym = filters.crewMonth || todayStr().slice(0, 7);
  const [Y, M] = ym.split('-').map(Number);
  const startDow = new Date(Y, M - 1, 1).getDay();
  const daysInMonth = new Date(Y, M, 0).getDate();
  const byDay = {};
  const monthSites = crewSites().filter(s => (s.constructDate || '').startsWith(ym)).sort((a, b) => (a.constructDate || '').localeCompare(b.constructDate || ''));
  monthSites.forEach(s => { const dd = +s.constructDate.slice(8, 10); (byDay[dd] = byDay[dd] || []).push(s); });
  const today = todayStr(), sel = filters.crewDay || '';
  const dow = ['일', '월', '화', '수', '목', '금', '토'];
  let cells = '';
  for (let i = 0; i < startDow; i++) cells += `<div></div>`;
  for (let dd = 1; dd <= daysInMonth; dd++) {
    const ds = `${ym}-${String(dd).padStart(2, '0')}`;
    const has = byDay[dd], isToday = ds === today, isSel = ds === sel;
    const dowIdx = (startDow + dd - 1) % 7;
    const hol = HOLIDAYS[ds];
    const col = (dowIdx === 0 || hol) ? '#d64545' : (dowIdx === 6 ? '#2f6fed' : 'var(--t1)');
    const chips = (has || []).map(s => { const tc = calTeamColor(s.team); return `<span style="font-size:9.5px;line-height:1.25;background:${isSel ? 'rgba(255,255,255,.22)' : tc + '22'};color:${isSel ? '#fff' : tc};border-radius:4px;padding:1px 3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600;display:block;margin-top:2px" title="${esc(s.team || '')}">${esc(s.name || s.client || '현장')}</span>`; }).join('');
    cells += `<button onclick="crewPickDay('${ds}')" style="min-height:52px;border:${isSel ? '0' : '0.5px solid var(--bd)'};background:${isSel ? 'var(--g)' : (isToday ? 'var(--gl2,#e8f7f0)' : '#fff')};border-radius:9px;display:flex;flex-direction:column;align-items:stretch;cursor:pointer;padding:4px 3px;overflow:hidden">
      <span style="font-size:12px;font-weight:${has ? '700' : '500'};color:${isSel ? '#fff' : col};text-align:left;line-height:1">${dd}</span>
      ${hol ? `<span style="font-size:8.5px;color:${isSel ? '#fff' : '#d64545'};font-weight:600;line-height:1.1;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${hol}</span>` : ''}
      ${chips}
    </button>`;
  }
  const selList = sel ? crewSites().filter(s => s.constructDate === sel) : [];
  let below;
  if (sel) {
    below = `<div style="display:flex;justify-content:space-between;align-items:center;margin:2px 0 8px"><div style="font-size:12.5px;color:var(--t2)"><b>${+sel.slice(5, 7)}/${+sel.slice(8, 10)}</b> 시공 ${selList.length}건</div><button class="btn btn-sm" style="padding:2px 10px" onclick="crewPickDay('${sel}')"><i class="ti ti-calendar"></i> 이달 목록</button></div>${crewListBody(selList)}`;
  } else if (monthSites.length) {
    const rows = monthSites.map(s => `<div onclick="crewPickDay('${s.constructDate}')" style="display:flex;gap:8px;align-items:center;padding:9px 10px;border-top:0.5px solid var(--bd);cursor:pointer">
      <div style="font-size:12px;font-weight:700;color:var(--gd);min-width:36px">${+s.constructDate.slice(5, 7)}/${+s.constructDate.slice(8, 10)}</div>
      <div style="min-width:0;flex:1"><div style="font-size:13px;font-weight:600;word-break:keep-all;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(s.name || s.client || '-')}</div>${s.address || s.region ? `<div style="font-size:11px;color:var(--t3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(s.address || s.region)}</div>` : ''}</div>
      <span class="pill p-prog" style="flex:none;font-size:10px">${esc(s.stage || '접수')}</span>
    </div>`).join('');
    below = `<div style="font-size:12px;color:var(--t3);margin:2px 0 4px">이달 시공 ${monthSites.length}건 · 날짜 또는 항목을 누르면 상세</div><div style="background:#fff;border:0.5px solid var(--bd);border-radius:12px;overflow:hidden">${rows}</div>`;
  } else {
    below = `<div class="empty"><i class="ti ti-calendar-off"></i>이달 예정된 시공이 없습니다</div>`;
  }
  return `<div style="background:#fff;border:0.5px solid var(--bd);border-radius:14px;padding:10px 6px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;padding:0 4px">
      <button class="btn btn-sm" onclick="crewMonthShift(-1)" aria-label="이전달"><i class="ti ti-chevron-left"></i></button>
      <b style="font-size:16px">${Y}년 ${M}월</b>
      <button class="btn btn-sm" onclick="crewMonthShift(1)" aria-label="다음달"><i class="ti ti-chevron-right"></i></button>
    </div>
    <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:5px;margin-bottom:6px">${dow.map((w, i) => `<div style="text-align:center;font-size:12px;font-weight:600;color:${i === 0 ? '#d64545' : (i === 6 ? '#2f6fed' : 'var(--t3)')}">${w}</div>`).join('')}</div>
    <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:5px">${cells}</div>
  </div>
  <div style="margin-top:10px">${below}</div>`;
}
function crewMonthShift(delta) {
  const ym = filters.crewMonth || todayStr().slice(0, 7);
  let [Y, M] = ym.split('-').map(Number);
  M += delta; if (M < 1) { M = 12; Y--; } else if (M > 12) { M = 1; Y++; }
  filters.crewMonth = `${Y}-${String(M).padStart(2, '0')}`; render();
}
function crewPickDay(ds) { filters.crewDay = (filters.crewDay === ds ? '' : ds); render(); }
function goCrewTab(v) { filters.crewTab = v; render(); }
function renderCrewSchedule() {
  const tab = filters.crewTab || 'cal';
  const list = crewSites();
  const upcoming = list.filter(s => { const d = daysFromNow(s.constructDate); return d != null && d >= 0; });
  el('pg-stock').innerHTML = `
    <div class="ph"><div><h2><i class="ti ti-tools"></i>${esc(me.name)}</h2><p><i class="ti ti-calendar-event" style="font-size:12px"></i> 시공 스케줄 · 예정 ${upcoming.length}건</p></div>
      <button class="btn btn-sm" onclick="logout()"><i class="ti ti-logout"></i>로그아웃</button></div>
    <div class="chips" style="margin-bottom:10px">
      <button class="chip ${tab === 'cal' ? 'active' : ''}" onclick="goCrewTab('cal')"><i class="ti ti-calendar"></i> 캘린더</button>
      <button class="chip ${tab === 'list' ? 'active' : ''}" onclick="goCrewTab('list')"><i class="ti ti-list"></i> 목록${list.length ? ` (${list.length})` : ''}</button>
    </div>
    ${tab === 'cal' ? crewCalendarHtml() : crewListBody(list)}`;
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
  if (h && h.items && h.items.length) return h.items.map(x => ({ materialName: x.materialName || x.name || '', jang: +x.jang || +x.qty || 0, hebe: +x.hebe || 0, lot: x.lot || '', pattern: x.pattern || '', planned: !!x.planned }));
  return [{ materialName: (h && h.materialName) || '', jang: +(h && h.jang) || 0, hebe: +(h && h.hebe) || 0, lot: (h && h.lot) || '', pattern: (h && h.pattern) || '', planned: false }];
}
/* 현장의 자재 목록 (다자재 지원, 구버전 호환) */
function siteItems(s) {
  if (s && s.items && s.items.length) return s.items.map(x => ({ name: x.name || x.materialName || '', qty: x.qty != null ? x.qty : (x.jang || ''), lot: x.lot || '' }));
  return (s && s.materialName) ? [{ name: s.materialName, qty: s.qty || '', lot: s.lot || '' }] : [];
}
/* 활성 홀딩(예약 중 '홀딩')으로 잡힌 장수 합계 — 자재명 기준(다자재 합산) */
function heldJangFor(name) {
  if (!name) return 0; const key = _normName(name); let s = 0;
  state.holdings.forEach(h => { if ((h.status || '홀딩') !== '홀딩') return; holdItems(h).forEach(it => { if (_normName(it.materialName) === key && !it.planned) s += (+it.jang || 0); }); });
  return s;
}
/* 가용재고 = 실재고 − 활성홀딩 */
function availJang(it) { return (+it.jang || 0) - heldJangFor(it.name) - Math.max(0, damagedStock(it.name)); }
/* 롯트별 재고: 입고(+) − 출고(−). 자재명 기준(띄어쓰기 무시). 롯트 미입력은 '(미지정)' */
function lotStock(name) {
  if (!name) return [];
  const key = _normName(name); const m = {};
  state.transactions.forEach(t => {
    if (_normName(t.itemName) !== key) return;
    const lot = (t.lot || '').trim() || '(미지정)';
    if (!m[lot]) m[lot] = { lot, inQty: 0, outQty: 0, adjQty: 0 };
    if (t.type === 'in') m[lot].inQty += (+t.jang || 0);
    else if (t.type === 'out') m[lot].outQty += (+t.jang || 0);
    else if (t.type === 'adjust') m[lot].adjQty += (+t.jang || 0);   // 재고 조정(±)
  });
  return Object.values(m).map(x => ({ lot: x.lot, inQty: x.inQty, outQty: x.outQty, remain: x.inQty - x.outQty + x.adjQty }))
    .filter(x => x.inQty > 0 || x.adjQty !== 0 || x.remain !== 0)
    .sort((a, b) => b.remain - a.remain);
}
/* 폼용 롯트 select 옵션(잔여 있는 실제 롯트만). 롯트가 하나만 남으면 자동 선택 */
function soleLot(name) {
  const ls = lotStock(name).filter(l => l.lot !== '(미지정)' && l.remain > 0);
  return ls.length === 1 ? ls[0].lot : '';
}
function lotSelectHtml(name, current) {
  const lots = lotStock(name).filter(l => l.lot !== '(미지정)' && l.remain > 0);
  const sel = current || (lots.length === 1 ? lots[0].lot : '');   // 롯트 하나면 자동 선택
  let html = '<option value="">롯트 선택 (선택사항)</option>';
  lots.forEach(l => { html += `<option value="${esc(l.lot)}" ${sel === l.lot ? 'selected' : ''}>${esc(l.lot)} · 잔여 ${l.remain}장</option>`; });
  if (sel && !lots.some(l => l.lot === sel)) html += `<option value="${esc(sel)}" selected>${esc(sel)}</option>`;
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
/* 패턴별 잔여 재고 (입고 patterns − 출고 pattern) */
function patternStock(name) {
  if (!name) return []; const key = _normName(name); const m = {};
  state.transactions.forEach(t => {
    if (_normName(t.itemName) !== key) return;
    if (t.type === 'in') { (t.patterns || []).forEach(p => { const nm = (p.pattern || '').trim(); if (!nm || nm === '-') return; m[nm] = (m[nm] || 0) + (+p.jang || 0); }); }
    else if (t.type === 'out') { const nm = (t.pattern || '').trim(); if (!nm || nm === '-') return; m[nm] = (m[nm] || 0) - (+t.jang || 0); }
    else if (t.type === 'adjust') { const nm = (t.pattern || '').trim(); if (!nm || nm === '-') return; m[nm] = (m[nm] || 0) + (+t.jang || 0); }   // 재고 조정(±)
  });
  return Object.keys(m).map(k => ({ pattern: k, remain: m[k] })).filter(x => x.remain !== 0).sort((a, b) => b.remain - a.remain);
}
/* 재고 표 셀용: 패턴별 잔여 요약 */
function patternStockCell(name) {
  const ps = patternStock(name);
  if (!ps.length) return '<span style="color:var(--t3)">-</span>';
  return ps.map(p => `<div style="white-space:nowrap">${esc(p.pattern)} <b style="color:${p.remain <= 0 ? 'var(--t3)' : 'var(--gd)'}">${p.remain}</b>장</div>`).join('');
}
/* 창고별 재고: 입고(+) − 출고(−) + 조정(±). 창고 미기록건은 품목 기본창고로 귀속. 자재명 기준 */
function depotStock(name) {
  const it = state.inventory.find(i => _normName(i.name) === _normName(name));
  const def = (it && it.depot) ? it.depot : '본사';
  const key = _normName(name); const m = {};
  state.transactions.forEach(t => {
    if (_normName(t.itemName) !== key) return;
    const dep = (t.depot || '').trim() || def;
    if (!m[dep]) m[dep] = { depot: dep, inQty: 0, outQty: 0, adjQty: 0 };
    if (t.type === 'in') m[dep].inQty += (+t.jang || 0);
    else if (t.type === 'out') m[dep].outQty += (+t.jang || 0);
    else if (t.type === 'adjust') m[dep].adjQty += (+t.jang || 0);
  });
  return Object.values(m).map(x => ({ depot: x.depot, inQty: x.inQty, outQty: x.outQty, remain: x.inQty - x.outQty + x.adjQty }))
    .filter(x => x.inQty > 0 || x.remain !== 0)
    .sort((a, b) => b.remain - a.remain);
}
function depotOptions() { return [...new Set((state.inventory || []).map(i => i.depot).filter(Boolean).concat((state.transactions || []).map(t => (t.depot || '').trim()).filter(Boolean)))].sort(); }
/* 자재행 창고 선택칸 옵션 — 창고 2곳 이상(창고별 재고 있는 자재)만 목록 표시, 아니면 빈 문자열 반환(칸 숨김) */
function depotSelectHtml(name, current) {
  const ds = depotStock(name).filter(d => d.remain > 0);
  if (ds.length <= 1) return '';   // 창고 한 곳뿐 → 선택 불필요
  const cur = (current || '').trim();
  let html = '<option value="">창고 선택 (창고별 재고)</option>';
  ds.forEach(d => { html += `<option value="${esc(d.depot)}" ${cur === d.depot ? 'selected' : ''}>${esc(d.depot)} · 잔여 ${d.remain}장</option>`; });
  if (cur && !ds.some(d => d.depot === cur)) html += `<option value="${esc(cur)}" selected>${esc(cur)}</option>`;
  return html;
}
/* 파손 재고: 입고 비고에 '파손' 포함(+) − 출고 비고에 '파손' 포함(−). 자재명 기준 */
function damagedStock(name) {
  if (!name) return 0;
  const key = _normName(name); let n = 0;
  state.transactions.forEach(t => {
    if (_normName(t.itemName) !== key) return;
    if (t.type === 'damage') { n += (+t.jang || 0); return; }   // 파손 처리(+)/복구(−)
    // '파손 자재'로 표시된 입·출고만 반영. damaged 플래그 우선, 없으면(구버전) note '파손'으로 판단
    const dmgFlag = (t.damaged === true) || (t.damaged === undefined && /파손/.test(t.note || ''));
    if (!dmgFlag) return;
    if (t.type === 'in') n += (+t.jang || 0);
    else if (t.type === 'out') n -= (+t.jang || 0);   // 파손 자재 출고 → 파손 재고에서 차감(폐기·반품)
  });
  return n;
}
function patternSelectHtml(name, current) {
  const ps = patternList(name);
  let html = '<option value="">패턴 선택 (선택)</option>';
  ps.forEach(p => { html += `<option value="${esc(p.pattern)}" ${current === p.pattern ? 'selected' : ''}>${esc(p.pattern)} · ${p.qty}장</option>`; });
  if (current && !ps.some(p => p.pattern === current)) html += `<option value="${esc(current)}" selected>${esc(current)}</option>`;
  return html;
}
/* ===== 예정 입고(재입고 예정) ===== */
/* 특정 자재의 활성(미완료) 예정입고 — 예정일 빠른 순 */
function restocksForItem(name) {
  const key = _normName(name);
  return (state.restocks || []).filter(r => !r.done && _normName(r.itemName) === key)
    .sort((a, b) => (a.expectedDate || '9999-99-99').localeCompare(b.expectedDate || '9999-99-99'));
}
/* 자재의 가장 이른 재입고 예정일 (없으면 '') */
function restockDateForItem(name) { const r = restocksForItem(name)[0]; return r ? (r.expectedDate || '') : ''; }
/* 자재의 예정입고 총 장수(미완료 합계) */
function plannedJangFor(name) { return restocksForItem(name).reduce((a, r) => a + (+r.jang || 0), 0); }
/* 예정입고 변경 후: inventory.restockDate 를 최신 예정일로 동기화(고객 화면 노출용) */
async function syncItemRestock(name) {
  const it = state.inventory.find(i => _normName(i.name) === _normName(name));
  if (!it) return;
  const d = restockDateForItem(name);
  if ((it.restockDate || '') !== d) { try { await Store.update('inventory', it.id, { restockDate: d }); } catch (e) { } }
}
/* 입고 등록 시: 해당 자재의 활성 예정입고를 완료 처리 + 미러 동기화 */
async function clearRestocksOnIn(name) {
  for (const r of restocksForItem(name)) { try { await Store.update('restocks', r.id, { done: true, doneDate: todayStr() }); } catch (e) { } }
  await syncItemRestock(name);
}
/* 재고 부족 판정 (가용재고 기준 안전재고) */
function stockState(it) {
  const avail = availJang(it), safe = +it.safeJang || 0;
  if (avail <= 0) return { k: '없음', cls: 'p-issue' };
  if (safe > 0 && avail < safe) return { k: '부족', cls: 'p-wait' };
  if (safe > 0 && avail < safe * 1.5) return { k: '임박', cls: 'p-wait' };
  return { k: '정상', cls: 'p-prog' };
}
/* 입고 후: 예정홀딩을 검사해 '자재가 전부 가용 범위에 들면' 오래된 순으로 자동 활성화(다자재) */
async function activatePlannedHolds(name, physJang) {
  // 대상: 예정 홀딩 + '홀딩'인데 일부 품목이 예정(planned)인 건
  const cand = state.holdings.filter(h => !['확정', '해제'].includes(h.status || '홀딩') && holdItems(h).some(it => it.planned))
    .sort((a, b) => (a.useDate || '9999').localeCompare(b.useDate || '9999') || (a.createdAt || 0) - (b.createdAt || 0));
  if (!cand.length) return 0;
  const extra = {};
  function physOf(mat) {
    if (name && _normName(mat) === _normName(name) && physJang != null) return physJang;
    const it = state.inventory.find(i => _normName(i.name) === _normName(mat)); return it ? +it.jang || 0 : 0;
  }
  function availOf(mat) { return physOf(mat) - heldJangFor(mat) - (extra[_normName(mat)] || 0) - Math.max(0, damagedStock(mat)); }
  let count = 0;
  for (const h of cand) {
    const items = holdItems(h);
    let changed = false;
    const newItems = items.map(it => {
      if (it.planned && availOf(it.materialName) >= (+it.jang || 0)) {   // 이제 재고 확보 → 활성화
        extra[_normName(it.materialName)] = (extra[_normName(it.materialName)] || 0) + (+it.jang || 0);
        changed = true;
        return Object.assign({}, it, { planned: false });
      }
      return it;
    });
    if (changed) {
      const newStatus = newItems.every(x => x.planned) ? '예정' : '홀딩';
      const patch = { items: newItems, status: newStatus };
      if (!newItems.some(x => x.planned) && h.autoDemoted) patch.autoDemoted = false;   // 다시 전부 확보되면 강등표시 해제
      await Store.update('holdings', h.id, patch);
      count++;
    }
  }
  return count;
}
/* ── 임박 홀딩 선점(preemption) ──
   가용이 없을 때: 사용일이 3일 이내로 임박했지만 재고를 못 잡은(예정) 품목이,
   3주(21일) 이상 남은 기존 활성 홀딩의 같은 자재 수량을 가져온다.
   밀려난(먼) 홀딩은 그만큼 예정홀딩으로 내려간다. 물리 재고 총량은 불변(재배치만).
   정책: 완전 자동 / 트리거 3일 이내 / 보호 3주 이상 / 알림은 직원에게만. */
const PREEMPT_URGENT_DAYS = 3, PREEMPT_FAROUT_DAYS = 21;
async function preemptForUrgent() {
  if (!me || isCustomerRole() || !CLOUD) return 0;
  // 확정·해제 아닌 활성 홀딩만, 품목 클론(불변 원본 보존)
  const work = state.holdings
    .filter(h => !['확정', '해제'].includes(h.status || '홀딩'))
    .map(h => ({ h, items: holdItems(h).map(x => ({ materialName: x.materialName, jang: +x.jang || 0, lot: x.lot || '', pattern: x.pattern || '', planned: !!x.planned })) }));
  if (!work.length) return 0;
  const mats = new Set();
  work.forEach(w => w.items.forEach(it => { if (it.materialName) mats.add(_normName(it.materialName)); }));
  const changed = new Set();
  const moves = [];
  for (const matKey of mats) {
    let guard = 0;
    while (guard++ < 300) {
      // 임박 미충족(planned) 품목: 사용일 today~+3(지난 것 포함), 이른 순
      let U = null;
      for (const w of work.slice().sort((a, b) => (a.h.useDate || '9999-99-99').localeCompare(b.h.useDate || '9999-99-99'))) {
        const d = daysFromNow(w.h.useDate);
        if (d == null || d > PREEMPT_URGENT_DAYS) continue;
        const it = w.items.find(x => _normName(x.materialName) === matKey && x.planned && x.jang > 0);
        if (it) { U = { w, it }; break; }
      }
      if (!U) break;
      // 기증 후보: 사용일 21일 이상 남고, 활성(non-planned) 재고 보유. 가장 멀리 남은 것부터
      let D = null;
      for (const w of work.slice().sort((a, b) => (b.h.useDate || '0000-00-00').localeCompare(a.h.useDate || '0000-00-00'))) {
        const d = daysFromNow(w.h.useDate);
        if (d == null || d < PREEMPT_FAROUT_DAYS) continue;
        if (w === U.w) continue;
        const it = w.items.find(x => _normName(x.materialName) === matKey && !x.planned && x.jang > 0);
        if (it) { D = { w, it }; break; }
      }
      if (!D) break;
      const x = Math.min(U.it.jang, D.it.jang);
      if (x <= 0) break;
      // U: planned → active (x장 확보)
      U.it.jang -= x;
      const uAct = U.w.items.find(y => _normName(y.materialName) === matKey && !y.planned);
      if (uAct) uAct.jang += x; else U.w.items.push({ materialName: U.it.materialName, jang: x, lot: U.it.lot, pattern: U.it.pattern, planned: false });
      // D: active → planned (x장 강등)
      D.it.jang -= x;
      const dPl = D.w.items.find(y => _normName(y.materialName) === matKey && y.planned);
      if (dPl) dPl.jang += x; else D.w.items.push({ materialName: D.it.materialName, jang: x, lot: D.it.lot, pattern: D.it.pattern, planned: true });
      changed.add(U.w); changed.add(D.w);
      moves.push({ donor: D.w.h.vendor || '', mat: D.it.materialName, x, urgent: U.w.h.vendor || '', useDate: U.w.h.useDate || '' });
    }
  }
  if (!changed.size) return 0;
  for (const w of changed) {
    const items = w.items.filter(x => x.jang > 0).map(x => {
      const inv = state.inventory.find(i => _normName(i.name) === _normName(x.materialName));
      return { materialName: x.materialName, jang: x.jang, hebe: inv ? +((x.jang) * (+inv.hebePerJang || 0)).toFixed(2) : 0, lot: x.lot || '', pattern: x.pattern || '', planned: !!x.planned };
    });
    if (!items.length) continue;
    const status = items.every(x => x.planned) ? '예정' : '홀딩';
    const first = items[0];
    const patch = { items, status, materialName: first.materialName, jang: first.jang, hebe: first.hebe, lot: first.lot || '' };
    const hadPlanned = holdItems(w.h).some(x => x.planned);
    if (!hadPlanned && items.some(x => x.planned)) { patch.autoDemoted = true; patch.autoDemotedAt = Date.now(); }   // 강등 표시(직원 홈 알림용)
    try { await Store.update('holdings', w.h.id, patch); } catch (e) { }
  }
  // 직원에게만 알림: 현재 세션 토스트 + 홈 화면 '자동조정' 배지(autoDemoted). 고객에겐 조용히 '예정'으로만 표시.
  try { toast('홀딩 자동조정 ' + moves.length + '건: 임박 건에 재고 배정, 먼 건은 예정으로'); } catch (e) { }
  return changed.size;
}
/* ===== 자재 여러 줄 입력 컴포넌트 (현장/홀딩 공용) ===== */
let _mrowN = 0, _mrowPattern = false, _mrowDepot = false;   // _mrowPattern: 패턴 선택칸 표시 / _mrowDepot: 출고 폼에서 true → 창고별 재고 선택칸 표시
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
    ${_mrowDepot ? `<select class="m-depot" style="${selStyle};display:none"></select>` : ''}
    <div class="m-info" style="font-size:11px;color:var(--t3);margin-top:4px"></div>
  </div>`;
}
function matRowsHtml(items, qtyPh) {
  const arr = (items && items.length) ? items : [{}];
  return `<div id="mat-rows">${arr.map(it => matRowHtml(it, qtyPh)).join('')}</div>
    <button type="button" class="btn btn-ghost btn-sm btn-block" style="margin-bottom:6px" onclick="addMaterialRow({}, '${qtyPh || '수량'}')"><i class="ti ti-plus"></i>자재 추가</button>`;
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
    const depSel = row.querySelector('select.m-depot');
    if (depSel) { const cur = depSel.value; const h = depotSelectHtml(mat, cur); depSel.innerHTML = h; depSel.style.display = h ? '' : 'none'; }
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
    const depSel = row.querySelector('select.m-depot');
    const depot = depSel ? (depSel.value || '').trim() : '';
    if (name && qty > 0) rows.push({ name: name, qty: qty, lot: lot, pattern: pattern, depot: depot });
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
/* 현장에서 불러올 수 있는 홀딩 (진행 홀딩 + 예정홀딩) */
function holdingsForSite() { return state.holdings.filter(h => ['홀딩', '예정'].includes(h.status || '홀딩')); }
function holdingOptions() {
  const list = holdingsForSite();
  if (!list.length) return '';
  return list.sort((a, b) => {
    const pa = a.status === '예정' ? 1 : 0, pb = b.status === '예정' ? 1 : 0;   // 진행 홀딩 먼저, 예정은 뒤
    if (pa !== pb) return pa - pb;
    return (a.useDate || '').localeCompare(b.useDate || '');
  }).map(h =>
    `<option value="${esc(h.id)}">${h.status === '예정' ? '[예정] ' : ''}${esc(h.vendor || '')} · ${esc(h.materialName || '')} · ${+h.jang || 0}장${h.useDate ? ' · ' + esc(h.useDate) : ''}</option>`).join('');
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

  const alerts = buildAlerts();
  const _adism = getAlertDismissed();
  const visible = alerts.filter(a => !_adism.includes(a.key));

  el('pg-home').innerHTML = `
    <div class="ph"><div><h2><i class="ti ti-layout-dashboard"></i>주요 현황</h2><p>${new Date().toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' })} 기준 · 실시간 공유</p></div></div>

    <div class="card">
      <div class="card-h"><h3><i class="ti ti-bolt"></i>빠른 작업</h3></div>
      <div class="qa-grid">
        <button class="qa" onclick="go('stock');setTimeout(openStockForm,50)"><span class="qi ic g"><i class="ti ti-login"></i></span><span><b>입고 등록</b><small>자재 입고</small></span></button>
        <button class="qa" onclick="go('ship');setTimeout(openShipForm,50)"><span class="qi ic b"><i class="ti ti-logout"></i></span><span><b>출고 등록</b><small>현장·공장</small></span></button>
        <button class="qa" onclick="go('sites');setTimeout(openSiteForm,50)"><span class="qi ic a"><i class="ti ti-building-community"></i></span><span><b>현장 등록</b><small>신규 현장</small></span></button>
        <button class="qa" onclick="go('hold');setTimeout(openHoldForm,50)"><span class="qi ic r"><i class="ti ti-lock-plus"></i></span><span><b>홀딩 등록</b><small>자재 홀딩</small></span></button>
      </div>
    </div>

    <div class="stat-grid">
      <button class="stat tap" onclick="openStockTab('all')"><div class="ic g"><i class="ti ti-packages"></i></div><div class="v">${state.inventory.length}</div><div class="l">재고 품종 <i class="ti ti-chevron-right tap-arrow"></i></div><div class="s">실재고 ${state.inventory.reduce((a, b) => a + (+b.jang || 0), 0)}장 · 가용 ${state.inventory.reduce((a, b) => a + availJang(b), 0)}장</div></button>
      <button class="stat tap" onclick="openStockTab('low')"><div class="ic r"><i class="ti ti-alert-triangle"></i></div><div class="v" style="color:${lowItems.length ? 'var(--red-t)' : 'inherit'}">${lowItems.length}</div><div class="l">재고 부족 <i class="ti ti-chevron-right tap-arrow"></i></div><div class="s">${lowItems.length ? '입고 필요' : '정상 운영'}</div></button>
      <button class="stat tap" onclick="filters.sites='all';go('sites')"><div class="ic b"><i class="ti ti-building-community"></i></div><div class="v">${activeSites.length}</div><div class="l">진행 현장 <i class="ti ti-chevron-right tap-arrow"></i></div><div class="s">시공임박 ${soonConstruct.length}</div></button>
      <button class="stat tap" onclick="go('hold')"><div class="ic a"><i class="ti ti-lock"></i></div><div class="v">${state.holdings.filter(h => (h.status || '홀딩') === '홀딩').length}</div><div class="l">홀딩 건수 <i class="ti ti-chevron-right tap-arrow"></i></div><div class="s">임박 ${soonHold.length} · 예정 ${plannedHolds.length}</div></button>
    </div>

    <div class="card">
      <div class="card-h"><h3><i class="ti ti-bell-ringing"></i>긴급 알림</h3><span class="more tap" onclick="openAlerts()" style="cursor:pointer">${visible.length}건${visible.length > 8 ? ' · 전체보기' : ''} <i class="ti ti-chevron-right"></i></span></div>
      <div id="home-alerts">
        ${visible.length ? visible.slice(0, 8).map(alertRowHtml).join('') : `<div class="empty"><i class="ti ti-circle-check"></i>처리할 긴급 항목이 없습니다</div>`}
      </div>
      ${visible.length > 8 ? `<button class="btn btn-ghost btn-block" style="margin-top:8px" onclick="openAlerts()"><i class="ti ti-list"></i>전체 ${visible.length}건 보기</button>` : ''}
      ${_adism.length ? `<button class="btn btn-ghost btn-sm btn-block" style="margin-top:6px;color:var(--t3)" onclick="clearAlertDismiss()"><i class="ti ti-rotate"></i>확인한 알림 다시 보기 (${_adism.length})</button>` : ''}
    </div>`;
}
/* ---------- 긴급 알림: 생성 + 기기별 '확인(숨김)' ---------- */
function buildAlerts() {
  const alerts = [];
  const lowItems = state.inventory.filter(i => { const s = stockState(i).k; return s === '부족' || s === '없음'; });
  const soonConstruct = state.sites.filter(s => { const d = daysFromNow(s.constructDate); return s.stage !== '완료' && d != null && d >= 0 && d <= 3; });
  const soonHold = state.holdings.filter(h => { const d = daysFromNow(h.useDate); return (h.status || '홀딩') === '홀딩' && d != null && d >= 0 && d <= 3; });
  const plannedHolds = state.holdings.filter(h => h.status === '예정');
  const waitQuote = state.sites.filter(s => ['접수', '가견적', '견적'].includes(s.stage));
  const openIssues = state.issues.filter(i => i.status !== '처리완료');
  const holdReqs = (state.holdRequests || []).filter(r => (r.status || '대기') === '대기');
  holdReqs.forEach(r => { const items = (r.items || []).map(it => `${it.materialName} ${+it.jang || 0}장`).join(', '); alerts.push({ key: 'holdreq|' + r.id, c: 'a', ic: 'ti-lock-plus', t: `${r.vendor || ''} 홀딩 요청`, s: items + (r.useDate ? ` · 사용 ${r.useDate}` : '') + (r.note ? ` · ${r.note}` : ''), tag: '홀딩요청' }); });
  lowItems.forEach(i => alerts.push({ key: 'low|' + i.name, c: 'r', ic: 'ti-alert-triangle', t: `${i.name} 입고 필요`, s: `가용 ${availJang(i)}장 · 안전재고 ${(+i.safeJang || 0)}장 미만`, tag: '재고부족' }));
  openIssues.forEach(i => alerts.push({ key: 'issue|' + (i.id || i.reason), c: 'r', ic: 'ti-alert-triangle', t: `${i.siteName || '현장'} 이슈 미해결`, s: (i.reason || '').slice(0, 40), tag: '이슈' }));
  plannedHolds.forEach(h => alerts.push({ key: 'plan|' + h.id, c: 'a', ic: 'ti-clock-pause', t: `${h.materialName || '-'} 입고 대기`, s: `${h.vendor || ''} · ${(+h.jang || 0)}장 예약(예정홀딩) · 입고 시 자동 전환`, tag: '예정홀딩' }));
  const demoted = state.holdings.filter(h => h.autoDemoted && !['확정', '해제'].includes(h.status || '홀딩') && holdItems(h).some(x => x.planned));
  demoted.forEach(h => alerts.push({ key: 'demote|' + h.id, c: 'a', ic: 'ti-transfer', t: `${h.vendor || ''} 홀딩 자동 조정됨`, s: `임박 건에 재고 양보 → 일부 예정홀딩 전환 · 사용예정 ${h.useDate || '-'}`, tag: '자동조정' }));
  soonConstruct.forEach(s => alerts.push({ key: 'const|' + s.id + '|' + s.constructDate, c: 'a', ic: 'ti-tools', t: `${s.name} 시공 임박`, s: `${s.constructDate} 시공 예정 · ${s.team || '시공팀 미정'}`, tag: 'D-' + daysFromNow(s.constructDate) }));
  soonHold.forEach(h => alerts.push({ key: 'hold|' + h.id + '|' + h.useDate, c: 'b', ic: 'ti-lock', t: `${h.vendor} 홀딩 사용 임박`, s: `${h.materialName} ${(+h.hebe || 0).toFixed(1)}㎡ · ${h.useDate} 사용`, tag: '홀딩' }));
  waitQuote.forEach(s => alerts.push({ key: 'quote|' + s.id + '|' + s.stage, c: 'a', ic: 'ti-file-invoice', t: `${s.name} 견적 진행 필요`, s: `현재 단계: ${s.stage} · ${s.client || ''}`, tag: s.stage }));
  const _recency = a => {
    const k = a.key || '';
    if (k.indexOf('holdreq|') === 0) { const x = (state.holdRequests || []).find(r => 'holdreq|' + r.id === k); return x ? +x.createdAt || 0 : 0; }
    if (k.indexOf('low|') === 0) { const it = state.inventory.find(i => 'low|' + i.name === k); return it ? +it.createdAt || 0 : 0; }
    if (k.indexOf('issue|') === 0) { const x = state.issues.find(i => 'issue|' + (i.id || i.reason) === k); return x ? +x.createdAt || 0 : 0; }
    if (k.indexOf('plan|') === 0 || k.indexOf('hold|') === 0) { const x = state.holdings.find(h => k.indexOf('|' + h.id) > -1); return x ? +x.createdAt || 0 : 0; }
    const x = state.sites.find(s => k.indexOf('|' + s.id + '|') > -1); return x ? +x.createdAt || 0 : 0;
  };
  return alerts.sort((a, b) => _recency(b) - _recency(a));   // 최근 등록 항목 알림이 앞에
}
function getAlertDismissed() { try { return JSON.parse(localStorage.getItem('dws_alertDismiss') || '[]'); } catch (e) { return []; } }
function _akey(k) { return String(k).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
function alertRowHtml(a) {
  return `<div class="alert-i ${a.c}">
    <div class="ai"><i class="ti ${a.ic}"></i></div>
    <div class="at"><b>${esc(a.t)}</b><span>${esc(a.s)}</span></div>
    <span class="tag">${esc(a.tag)}</span>
    <button onclick="dismissAlert('${_akey(a.key)}')" title="확인(이 기기에서 숨김)" style="flex:none;background:none;border:none;color:var(--t3);padding:6px;margin-left:2px;cursor:pointer"><i class="ti ti-check" style="font-size:18px"></i></button>
  </div>`;
}
function _alertBodyHtml(list) {
  return list.length ? list.map(alertRowHtml).join('') : `<div class="empty"><i class="ti ti-circle-check"></i>확인할 긴급 항목이 없습니다</div>`;
}
function dismissAlert(key) {
  const d = getAlertDismissed(); if (!d.includes(key)) { d.push(key); localStorage.setItem('dws_alertDismiss', JSON.stringify(d)); }
  const mb = el('alerts-modal-body');
  if (mb) mb.innerHTML = _alertBodyHtml(buildAlerts().filter(a => !getAlertDismissed().includes(a.key)));
  if (tab === 'home') renderHome();
}
function clearAlertDismiss() {
  localStorage.removeItem('dws_alertDismiss'); toast('확인한 알림을 다시 표시합니다');
  const mb = el('alerts-modal-body');
  if (mb) mb.innerHTML = _alertBodyHtml(buildAlerts());
  if (tab === 'home') renderHome();
}
function openAlerts() {
  const visible = buildAlerts().filter(a => !getAlertDismissed().includes(a.key));
  const dcount = getAlertDismissed().length;
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-bell-ringing"></i>긴급 알림 ${visible.length}건</h3><button class="x" onclick="closeModal()">×</button></div>
    <div style="font-size:12.5px;color:var(--t3);margin:-4px 0 10px"><i class="ti ti-info-circle"></i> 확인(체크)한 알림은 <b>이 기기에서만</b> 사라집니다. 다른 직원 화면에는 그대로 보여요.</div>
    <div id="alerts-modal-body" style="max-height:62vh;overflow:auto">${_alertBodyHtml(visible)}</div>
    ${dcount ? `<button class="btn btn-ghost btn-block" style="margin-top:10px" onclick="clearAlertDismiss()"><i class="ti ti-rotate"></i>확인한 알림 다시 보기 (${dcount})</button>` : ''}`);
}

/* ===================================================================
   모달 헬퍼
   =================================================================== */
function openModal(html) { el('sheet').innerHTML = html; el('modal').classList.add('open'); document.body.style.overflow = 'hidden'; }
function closeModal() { el('modal').classList.remove('open'); document.body.style.overflow = ''; _holdLinkSite = null; _holdConfirm = null; }
el('modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
// Esc 키: 자동완성 팝업 먼저, 없으면 모달 닫기
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const p = el('sb-pop'); if (p && p.style.display !== 'none') { p.style.display = 'none'; return; }
  const m = el('modal'); if (m && m.classList.contains('open')) closeModal();
});

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
/* 폼에서 입력한 거래처명이 목록에 없으면 '거래처 관리'에 자동 등록 (현장·출고·홀딩·세면대 공용) */
async function ensureClient(name) {
  const v = (name || '').trim();
  if (!v) return;
  if ((state.clients || []).some(c => _normName(c.value) === _normName(v))) return;   // 이미 있으면 통과
  try { await Store.add('clients', { value: v }); } catch (e) { }
}
/* 입고 자재 검색 후보: 재고에 등록된 품목명만 */
function invNames() {
  return [...new Set(state.inventory.map(i => i.name).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}
/* 자재별 '고정 패턴' 정의 — 품목에 저장된 patterns 우선, 없으면 기존 입고 이력에서 자동 도출 */
function matPatternDefs(name) {
  const it = state.inventory.find(i => _normName(i.name) === _normName(name));
  if (it && Array.isArray(it.patterns) && it.patterns.length) return it.patterns.slice();
  return patternList(name).map(p => p.pattern);
}
/* 품목 수정 화면의 패턴 정의 편집 행 */
function ipatDefRow(name) {
  const inp = 'font-size:14px;padding:9px 11px;border:1.5px solid var(--bd2);border-radius:10px';
  return `<div class="ipat-row" style="display:flex;gap:8px;margin-bottom:6px">
    <input class="ipat-name" lang="ko" placeholder="예: 1번(좌상)" value="${esc(name || '')}" style="flex:1;min-width:0;${inp}">
    <button type="button" class="btn btn-ghost btn-sm" onclick="this.closest('.ipat-row').remove()" aria-label="삭제"><i class="ti ti-x"></i></button>
  </div>`;
}
function addIpatDef() { const c = el('ipat-defs'); if (c) c.insertAdjacentHTML('beforeend', ipatDefRow('')); }
/* searchBox: 입력하면 부분일치 후보가 아래에 뜨고 클릭 선택. id는 그대로 유지(폼 제출 시 사용). */
function searchBox(id, placeholder, value, listFn, pickFn) {
  return `<input id="${id}" class="sb-in" lang="ko" autocomplete="off" placeholder="${esc(placeholder)}" value="${esc(value || '')}" oninput="sbFilter('${id}','${listFn}','${pickFn || ''}')" onfocus="sbFilter('${id}','${listFn}','${pickFn || ''}')" onkeydown="sbKey(event,'${id}','${pickFn || ''}')" onblur="setTimeout(sbHide,180)">`;
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
/* 키보드: 아래/위 방향키로 후보 이동, Enter로 선택, Esc로 닫기 */
function sbKey(e, id, pickFn) {
  const p = el('sb-pop'); if (!p || p.style.display === 'none') return;
  const items = [...p.querySelectorAll('.sb-item')]; if (!items.length) return;
  let idx = items.findIndex(it => it.classList.contains('hl'));
  if (e.key === 'ArrowDown') { e.preventDefault(); idx = (idx + 1) % items.length; }
  else if (e.key === 'ArrowUp') { e.preventDefault(); idx = (idx - 1 + items.length) % items.length; }
  else if (e.key === 'Enter') { if (idx >= 0) { e.preventDefault(); el(id).value = items[idx].dataset.v; p.style.display = 'none'; if (pickFn && window[pickFn]) window[pickFn](); } return; }
  else if (e.key === 'Escape') { p.style.display = 'none'; return; }
  else return;
  items.forEach((it, i) => it.classList.toggle('hl', i === idx));
  if (items[idx]) items[idx].scrollIntoView({ block: 'nearest' });
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
  const isBasin = i.kind === 'basin';
  const site = isBasin ? null : state.sites.find(x => x.id === i.siteId);
  const basin = isBasin ? (state.basins || []).find(x => x.id === i.basinId) : null;
  const stageTxt = isBasin ? (basin ? (basin.stage || '') : '삭제된 발주') : (site ? (site.stage || '') : '삭제된 현장');
  const kindBadge = isBasin ? `<span class="pill p-hold" style="flex:none;margin-right:6px;font-size:10px">세면대</span>` : '';
  return `<div class="site" style="border-left:4px solid ${done ? '#12b76a' : '#f04438'}">
    <div class="site-top">
      <div><div class="nm">${kindBadge}${esc(i.siteName || (isBasin ? '세면대 발주' : '현장'))}</div><div class="ad"><i class="ti ti-calendar-event" style="font-size:13px"></i>${i.createdAt ? new Date(i.createdAt).toLocaleDateString('ko-KR') : ''} · ${esc(i.by || '')} 등록${stageTxt ? ' · 현재 ' + esc(stageTxt) : ''}</div></div>
      <span class="pill ${done ? 'p-done' : 'p-issue'}">${done ? '처리완료' : '미해결'}</span>
    </div>
    <div style="margin-top:9px;font-size:13.5px;color:var(--t1);white-space:pre-wrap;line-height:1.6">${esc(i.reason || '')}</div>
    ${done
      ? `<div style="margin-top:9px;font-size:12px;color:var(--t3)"><i class="ti ti-check"></i> ${esc(i.resolvedDate || '')} ${esc(i.resolvedBy || '')} 처리 완료</div>`
      : `<button class="btn btn-pri btn-block" style="margin-top:10px" onclick="resolveIssue('${i.id}')"><i class="ti ti-circle-check"></i>처리 완료</button>`}
    <div class="frm-foot" style="margin-top:8px">
      ${isBasin
      ? (basin ? `<button class="btn btn-sm" style="flex:1" onclick="openBasinForm('${i.basinId}')"><i class="ti ti-bath"></i>세면대 발주 보기</button>` : '')
      : (site ? `<button class="btn btn-sm" style="flex:1" onclick="openSiteDetail('${i.siteId}')"><i class="ti ti-building-community"></i>현장 보기</button>` : '')}
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
    await Store.add('issues', { kind: 'site', siteId, siteName: s ? s.name : '', reason, status: '미해결', by: me.name, createdAt: Date.now() });
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
/* 세면대(발주) 이슈 등록 */
function basinIssueLabel(b) { return `${b.vendor || '(업체미정)'} · ${basinItems(b).map(it => it.stone).filter(Boolean).join('/') || '세면대'}`; }
function openBasinIssueForm(preBasinId) {
  const all = (state.basins || []).slice().sort((a, b) => (b.orderDate || '0000').localeCompare(a.orderDate || '0000'));
  if (!all.length) { toast('등록된 세면대 발주가 없습니다'); return; }
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-alert-triangle"></i>세면대 이슈 등록</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="frm">
      <div class="fld full"><label>세면대 발주 선택 <span class="req">*</span></label>
        <select id="bi-basin"><option value="">— 발주를 선택하세요 —</option>${all.map(b => `<option value="${b.id}" ${preBasinId === b.id ? 'selected' : ''}>${esc(basinIssueLabel(b))}${b.orderDate ? ' · ' + b.orderDate : ''}</option>`).join('')}</select></div>
      <div class="fld full"><label>이슈 내용 <span class="req">*</span></label>
        <textarea id="bi-reason" placeholder="세면대 관련 문제(파손·납기지연·규격오류·컬러상이 등)를 자세히 적어주세요" style="min-height:130px"></textarea></div>
    </div>
    <div class="frm-foot">
      <button class="btn" style="flex:1" onclick="closeModal()">취소</button>
      <button class="btn btn-pri" style="flex:2" onclick="submitBasinIssue()"><i class="ti ti-check"></i>이슈 등록</button>
    </div>`);
}
async function submitBasinIssue() {
  if (_busy) return;
  const basinId = el('bi-basin').value;
  const reason = el('bi-reason').value.trim();
  if (!basinId) { toast('세면대 발주를 선택하세요'); return; }
  if (!reason) { toast('이슈 내용을 입력하세요'); return; }
  const b = (state.basins || []).find(x => x.id === basinId);
  _busy = true;
  try {
    await Store.add('issues', { kind: 'basin', basinId, siteName: b ? basinIssueLabel(b) : '세면대 발주', reason, status: '미해결', by: me.name, createdAt: Date.now() });
    toast('세면대 이슈 등록됨'); closeModal();
  } finally { setTimeout(() => { _busy = false; }, 800); }
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
  const view = filters.siteView || 'list';
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
    <div class="chips" style="margin-bottom:8px">
      <button class="chip ${view === 'cal' ? '' : 'active'}" onclick="filters.siteView='list';renderSites()"><i class="ti ti-list"></i> 목록</button>
      <button class="chip ${view === 'cal' ? 'active' : ''}" onclick="filters.siteView='cal';renderSites()"><i class="ti ti-calendar"></i> 캘린더</button>
      <button class="chip" style="margin-left:auto" onclick="downloadSiteStatsXls()"><i class="ti ti-file-spreadsheet"></i> 통계 엑셀</button>
    </div>
    ${view === 'cal' ? staffCalendarHtml(list) : `<div style="font-size:12px;color:var(--t3);margin:2px 0 8px">검색 결과 <b id="sites-count" style="color:var(--t1)">${list.length}건</b></div><div class="site-grid" id="sites-grid">${siteGridHtml(list)}</div>`}`;
}
function chip(v, label, cur) { return `<button class="chip ${cur === v ? 'active' : ''}" onclick="filters.sites='${v}';renderSites()">${label}</button>`; }
/* 직원용 현장 캘린더 (전체 현장 · 공휴일 빨강 · 탭하면 상세) */
function staffMonthShift(delta) { const ym = filters.siteMonth || todayStr().slice(0, 7); let [Y, M] = ym.split('-').map(Number); M += delta; if (M < 1) { M = 12; Y--; } else if (M > 12) { M = 1; Y++; } filters.siteMonth = `${Y}-${String(M).padStart(2, '0')}`; renderSites(); }
function staffPickDay(ds) { filters.siteDay = (filters.siteDay === ds ? '' : ds); renderSites(); }
/* 시공팀별 색상 — 자체시공은 그레이톤, 나머지 팀은 대비 강한 색으로 눈에 확 띄게 */
const TEAM_PALETTE = ['#1e5eff', '#ff5a1f', '#12b76a', '#a03cff', '#e11d48', '#0891b2', '#ca8a04', '#7c3aed'];   // 강한 대비 색
const TEAM_GRAY = '#8a8f98';   // 자체시공 등 자체팀
function isSelfTeam(team) { return /자체/.test(String(team || '')); }
function calTeamList() {
  return [...new Set([...(state.teams || []).map(t => t.value || t), ...state.sites.map(s => s.team)].filter(Boolean).map(String))].sort((a, b) => a.localeCompare(b));
}
function calTeamColor(team) {
  if (!team) return TEAM_GRAY;
  if (isSelfTeam(team)) return TEAM_GRAY;   // 자체시공: 그레이톤
  const list = calTeamList().filter(t => !isSelfTeam(t));   // 자체팀 제외하고 순서 매핑 → 나머지 팀이 강한 색 앞순위
  const i = list.findIndex(t => _normName(t) === _normName(team));
  return TEAM_PALETTE[(i < 0 ? 0 : i) % TEAM_PALETTE.length];
}
/* 캘린더에서 시공팀 색상 범례 클릭 → 해당 팀만 보기(토글) */
function goCalTeam(t) { filters.calTeam = (filters.calTeam === t) ? '' : t; renderSites(); }
function staffCalendarHtml(list) {
  const ym = filters.siteMonth || todayStr().slice(0, 7);
  const [Y, M] = ym.split('-').map(Number);
  const startDow = new Date(Y, M - 1, 1).getDay();
  const daysInMonth = new Date(Y, M, 0).getDate();
  const teamFilter = filters.calTeam || '';
  const flist = teamFilter ? list.filter(s => _normName(s.team) === _normName(teamFilter)) : list;
  const monthAll = list.filter(s => (s.constructDate || '').startsWith(ym));
  const legendTeams = [...new Set(monthAll.map(s => s.team).filter(Boolean).map(String))].sort((a, b) => a.localeCompare(b));
  const byDay = {};
  const monthSites = flist.filter(s => (s.constructDate || '').startsWith(ym)).sort((a, b) => (a.constructDate || '').localeCompare(b.constructDate || ''));
  monthSites.forEach(s => { const dd = +s.constructDate.slice(8, 10); (byDay[dd] = byDay[dd] || []).push(s); });
  const today = todayStr(), sel = filters.siteDay || '';
  const dow = ['일', '월', '화', '수', '목', '금', '토'];
  let cells = '';
  for (let i = 0; i < startDow; i++) cells += `<div></div>`;
  for (let dd = 1; dd <= daysInMonth; dd++) {
    const ds = `${ym}-${String(dd).padStart(2, '0')}`;
    const has = byDay[dd], isToday = ds === today, isSel = ds === sel;
    const dowIdx = (startDow + dd - 1) % 7;
    const hol = HOLIDAYS[ds];
    const col = (dowIdx === 0 || hol) ? '#d64545' : (dowIdx === 6 ? '#2f6fed' : 'var(--t1)');
    const chips = (has || []).map(s => { const tc = calTeamColor(s.team); const slf = isSelfTeam(s.team); return `<span style="font-size:11px;line-height:1.3;background:${isSel ? 'rgba(255,255,255,.22)' : (slf ? tc + '1c' : tc + '26')};color:${isSel ? '#fff' : tc};border-radius:5px;padding:2px 5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:${slf ? '600' : '700'};display:block;margin-top:3px;border-left:3px solid ${isSel ? 'rgba(255,255,255,.6)' : tc}" title="${esc(s.team || '')}">${esc(s.name || s.client || '현장')}</span>`; }).join('');
    cells += `<button onclick="staffPickDay('${ds}')" style="min-height:76px;border:${isSel ? '0' : '0.5px solid var(--bd)'};background:${isSel ? 'var(--g)' : (isToday ? 'var(--gl2,#e8f7f0)' : '#fff')};border-radius:10px;display:flex;flex-direction:column;align-items:stretch;cursor:pointer;padding:6px 5px;overflow:hidden">
      <span style="font-size:14px;font-weight:${has ? '700' : '500'};color:${isSel ? '#fff' : col};text-align:left;line-height:1.05">${dd}</span>
      ${hol ? `<span style="font-size:9.5px;color:${isSel ? '#fff' : '#d64545'};font-weight:600;line-height:1.15;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${hol}</span>` : ''}
      ${chips}
    </button>`;
  }
  const rowFn = s => `<div onclick="openSiteDetail('${s.id}')" style="display:flex;gap:8px;align-items:center;padding:9px 10px;border-top:0.5px solid var(--bd);cursor:pointer">
    <div style="font-size:12px;font-weight:700;color:var(--gd);min-width:36px">${+s.constructDate.slice(5, 7)}/${+s.constructDate.slice(8, 10)}</div>
    <div style="min-width:0;flex:1"><div style="font-size:13px;font-weight:600;word-break:keep-all;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(s.name || s.client || '-')}</div><div style="font-size:11px;color:var(--t3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${s.team ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${calTeamColor(s.team)};margin-right:4px;vertical-align:middle"></span>` : ''}${esc(s.team || '')}${s.address ? ' · ' + esc(s.address) : ''}</div></div>
    <span class="pill p-prog" style="flex:none;font-size:10px">${esc(s.stage || '접수')}</span></div>`;
  const sel2 = sel ? flist.filter(s => s.constructDate === sel) : [];
  const legend = legendTeams.length ? `<div style="display:flex;flex-wrap:wrap;gap:5px;margin:0 4px 10px;align-items:center">
      <span style="font-size:11px;color:var(--t3);font-weight:600;margin-right:2px"><i class="ti ti-palette" style="font-size:12px;vertical-align:-1px"></i> 시공팀</span>
      <button onclick="goCalTeam('')" style="font-size:11px;font-weight:600;padding:3px 9px;border-radius:999px;border:1px solid ${!teamFilter ? 'var(--t1)' : 'var(--bd2)'};background:${!teamFilter ? 'var(--t1)' : '#fff'};color:${!teamFilter ? '#fff' : 'var(--t2)'};cursor:pointer">전체</button>
      ${legendTeams.map(t => { const c = calTeamColor(t); const on = _normName(teamFilter) === _normName(t); return `<button onclick="goCalTeam('${_akey(t)}')" style="display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;padding:3px 8px;border-radius:999px;border:1px solid ${on ? c : 'var(--bd2)'};background:${on ? c : '#fff'};color:${on ? '#fff' : 'var(--t2)'};cursor:pointer"><span style="width:9px;height:9px;border-radius:50%;background:${on ? '#fff' : c};display:inline-block"></span>${esc(t)}</button>`; }).join('')}
    </div>` : '';
  let below;
  if (sel) below = `<div style="display:flex;justify-content:space-between;align-items:center;margin:2px 0 8px"><div style="font-size:12.5px;color:var(--t2)"><b>${+sel.slice(5, 7)}/${+sel.slice(8, 10)}</b> 시공 ${sel2.length}건</div><button class="btn btn-sm" style="padding:2px 10px" onclick="staffPickDay('${sel}')"><i class="ti ti-calendar"></i> 이달 목록</button></div><div style="background:#fff;border:0.5px solid var(--bd);border-radius:12px;overflow:hidden">${sel2.length ? sel2.map(rowFn).join('') : '<div class="empty" style="padding:14px">시공 없음</div>'}</div>`;
  else if (monthSites.length) below = `<div style="font-size:12px;color:var(--t3);margin:2px 0 4px">이달 시공 ${monthSites.length}건 · 날짜/항목 누르면 상세</div><div style="background:#fff;border:0.5px solid var(--bd);border-radius:12px;overflow:hidden">${monthSites.map(rowFn).join('')}</div>`;
  else below = `<div class="empty"><i class="ti ti-calendar-off"></i>이달 예정된 시공이 없습니다</div>`;
  return `<div style="background:#fff;border:0.5px solid var(--bd);border-radius:14px;padding:10px 6px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;padding:0 4px">
      <button class="btn btn-sm" onclick="staffMonthShift(-1)" aria-label="이전달"><i class="ti ti-chevron-left"></i></button>
      <b style="font-size:16px">${Y}년 ${M}월</b>
      <button class="btn btn-sm" onclick="staffMonthShift(1)" aria-label="다음달"><i class="ti ti-chevron-right"></i></button>
    </div>
    ${legend}
    <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:5px;margin-bottom:6px">${dow.map((w, i) => `<div style="text-align:center;font-size:12px;font-weight:600;color:${i === 0 ? '#d64545' : (i === 6 ? '#2f6fed' : 'var(--t3)')}">${w}</div>`).join('')}</div>
    <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:5px">${cells}</div>
  </div>
  <div style="margin-top:10px">${below}</div>`;
}

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
  const tc = calTeamColor(s.team);   // 시공팀 색상 (자체시공=그레이)
  return `<div class="site" onclick="openSiteDetail('${s.id}')" style="border-top:3px solid ${tc}"${s.team ? ` title="시공팀: ${esc(s.team)}"` : ''}>
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
  openHoldForm(null, { forSiteId: id, vendor: s.client || '', items: siteItems(s).map(it => ({ materialName: it.name, jang: it.qty, lot: it.lot })), useDate: s.constructDate });
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
async function delSite(id) {
  if (!guardDelete('이 현장을 삭제할까요?')) return;
  const s = state.sites.find(x => x.id === id); const nm = s ? s.name : '';
  await Store.remove('sites', id);
  // 이 현장에 연결됐던 홀딩의 현장 정보 제거(고아 데이터 방지)
  for (const h of state.holdings.filter(h => h.forSiteId === id || (nm && h.forSiteName === nm))) {
    await Store.update('holdings', h.id, { forSiteId: '', forSiteName: '' });
  }
  toast('삭제됨 · 연결 홀딩의 현장 정보도 정리'); closeModal();
}

/* 현장 등록/수정 폼 */
function openSiteForm(id, pre) {
  const s = id ? state.sites.find(x => x.id === id) : null;
  const v = s || Object.assign({ manager: me.name, orderType: '실측', stage: '접수', measureNeeded: true }, pre || {});
  _mrowPattern = false; _mrowDepot = false;
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-building-community"></i>${s ? '현장 수정' : '현장 등록'}</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="frm">
      <div class="fld"><label>현장명 <span style="color:var(--t3);font-weight:500">(미입력 시 업체명)</span></label><input id="s-name" lang="ko" value="${esc(v.name || '')}" placeholder="현장명"></div>
      <div class="fld"><label>업체(거래처)<span class="req">*</span></label>${searchBox('s-client', '업체명 검색·입력', v.client, 'companyNames', '')}</div>
      <div class="fld"><label>지역</label><input id="s-region" lang="ko" value="${esc(v.region || '')}" placeholder="지역"></div>
      <div class="fld"><label>현장 담당자</label><input id="s-manager" lang="ko" value="${esc(v.manager || me.name)}"></div>
      <div class="fld full"><label>현장 주소</label><input id="s-address" lang="ko" value="${esc(v.address || '')}" placeholder="상세 주소"></div>
      <div class="fld"><label>발주 유형</label>
        <div class="seg" id="s-ordertype">
          <button type="button" class="${v.orderType === '실측' ? 'on' : ''}" onclick="pickOrderType('실측')">실측 발주</button>
          <button type="button" class="${v.orderType === '도면' ? 'on' : ''}" onclick="pickOrderType('도면')">도면 발주</button>
        </div>
      </div>
      <div class="fld"><label>진행 단계</label><select id="s-stage">${SITE_STAGES.map(st => `<option ${(v.stage || '접수') === st ? 'selected' : ''}>${st}</option>`).join('')}</select></div>
      ${holdingsForSite().length ? `<div class="fld full"><label><i class="ti ti-lock" style="font-size:13px;color:var(--blue)"></i> 홀딩에서 불러오기 <span style="color:var(--t3);font-weight:500">(진행·예정홀딩 · 불러온 뒤 수량은 실사용량으로 수정 가능)</span></label><select id="s-hold" onchange="pickSiteHolding()"><option value="">— 직접 입력 —</option>${holdingOptions()}</select></div>` : ''}
      <div class="fld full"><label>자재 / 수량 / 롯트<span class="req">*</span> <span style="color:var(--t3);font-weight:500">(여러 종류면 '자재 추가' · 수량은 직접 수정 가능 · 미정이면 아래 체크)</span></label>${matRowsHtml(siteItems(v), '수량')}</div>
      <div class="fld full"><button type="button" id="s-matpending-btn" class="btn btn-ghost btn-sm btn-block${v.matPending ? ' on' : ''}" style="margin:0;color:#d64545;border-color:#e6a9a9;font-weight:600${v.matPending ? ';background:#fdeaea' : ''}" onclick="const on=!this.classList.contains('on');this.classList.toggle('on',on);this.style.background=on?'#fdeaea':''"><i class="ti ti-help-circle"></i> 자재 미정</button></div>
      <div class="fld"><label>실측일 <span id="s-measure-lbl" style="color:var(--t3)">${v.orderType === '도면' ? '(도면발주·생략)' : ''}</span></label><input type="date" id="s-measureDate" value="${esc(v.measureDate || '')}" ${v.orderType === '도면' ? 'disabled' : ''}></div>
      <div class="fld"><label>시공일<span class="req">*</span></label><input type="date" id="s-constructDate" value="${esc(v.constructDate || '')}"></div>
      <div class="fld"><label>가공 공장<span class="req">*</span></label><select id="s-factory" onchange="onMasterChange('s-factory','factories')">${masterOptions('factories', v.factory || '')}</select></div>
      <div class="fld full hidden" id="s-factory-add"><label>새 공장 입력 후 추가</label><div style="display:flex;gap:8px"><input id="s-factory-new" placeholder="이름 입력" style="flex:1"><button class="btn btn-pri btn-sm" type="button" onclick="commitMaster('s-factory','factories')"><i class="ti ti-plus"></i>추가</button></div></div>
      <div class="fld"><label>시공팀<span class="req">*</span></label><select id="s-team" onchange="onMasterChange('s-team','teams')">${masterOptions('teams', v.team || '')}</select></div>
      <div class="fld full hidden" id="s-team-add"><label>새 시공팀 입력 후 추가</label><div style="display:flex;gap:8px"><input id="s-team-new" placeholder="이름 입력" style="flex:1"><button class="btn btn-pri btn-sm" type="button" onclick="commitMaster('s-team','teams')"><i class="ti ti-plus"></i>추가</button></div></div>
      <div class="fld full"><label>특이사항 <span style="color:var(--t3);font-weight:500">(내부용)</span></label><textarea id="s-note" lang="ko" placeholder="현장 메모">${esc(v.note || '')}</textarea></div>
      <div class="fld full"><label><i class="ti ti-message-2" style="font-size:13px;color:var(--blue)"></i> 시공팀 전달사항 <span style="color:var(--t3);font-weight:500">— 시공팀 계정 화면에 표시됨</span></label><textarea id="s-crewnote" lang="ko" placeholder="시공팀(모든대리석 등)에게 전달할 내용">${esc(v.crewNote || '')}</textarea></div>
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
  toast('홀딩 자재를 불러왔습니다 — 수량은 실사용량으로 수정하세요');
}

async function submitSite(id) {
  const name = el('s-name').value.trim();
  const client = el('s-client').value.trim();
  let items = collectMaterialRows();
  const matPending = !!(el('s-matpending-btn') && el('s-matpending-btn').classList.contains('on'));
  if (!items.length && matPending) items = [{ name: '(미정)', qty: 0, lot: '' }];
  const constructDate = el('s-constructDate').value;
  const factory = normFactory(el('s-factory').value === '__add' ? '' : el('s-factory').value);
  const team = el('s-team').value === '__add' ? '' : el('s-team').value;
  if (!client) { toast('업체명을 입력하세요'); return; }
  if (!items.length) { toast("자재명과 수량을 입력하세요 (미정이면 '자재 미정' 체크)"); return; }
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
    matPending, note: el('s-note').value.trim(), crewNote: (el('s-crewnote') && el('s-crewnote').value || '').trim(), updatedBy: me.name
  };
  await ensureClient(client);   // 신규 거래처 자동 등록
  if (id) {
    const s = state.sites.find(x => x.id === id);
    const hist = Object.assign({}, s.history || {}); if (!hist[obj.stage]) hist[obj.stage] = todayStr();
    obj.history = hist;
    await Store.update('sites', id, obj); toast('현장 정보 저장됨');
  } else {
    obj.history = { '접수': todayStr() }; if (obj.stage !== '접수') obj.history[obj.stage] = todayStr();
    await Store.add('sites', obj); toast('현장 등록 완료');
  }
  // 연결된 홀딩에 실사용 수량 연동(출고는 홀딩에서 함) — 이번에 고른 것 우선, 없으면 이미 연결된 홀딩 자동 탐색(재편집 대응)
  let linkHoldId = _holdLinkSite;
  if (!linkHoldId && id) {
    const s0 = state.sites.find(x => x.id === id); const oldName = s0 ? s0.name : '';
    const lh = state.holdings.find(h => !['해제', '확정'].includes(h.status || '홀딩') && (h.forSiteId === id || (oldName && h.forSiteName === oldName)));
    if (lh) linkHoldId = lh.id;
  }
  if (linkHoldId) {
    const hItems = items.map(r => {
      const inv = state.inventory.find(i => _normName(i.name) === _normName(r.name));
      return { materialName: r.name, jang: r.qty, hebe: inv ? +(r.qty * (+inv.hebePerJang || 0)).toFixed(2) : 0, lot: r.lot, pattern: r.pattern || '' };
    });
    const upd = { forSiteName: obj.name, items: hItems, materialName: hItems[0].materialName, jang: hItems[0].jang, hebe: hItems[0].hebe, lot: hItems[0].lot };
    if (id) upd.forSiteId = id;
    await Store.update('holdings', linkHoldId, upd);
  }
  _holdLinkSite = null;
  closeModal();
}

/* ===================================================================
   재고 · 입고
   =================================================================== */
/* ── 제품 종류(카테고리) & 단위 ──
   세라믹·석재·무늬목 = '장', 세면대·기타(폽업·수전 등) = '개'. 규격·헤베·패턴은 세라믹/석재만 사용. */
const ITEM_CATS = ['세라믹', '석재', '세면대', '무늬목', '기타'];
function itemCat(it) { return (it && it.cat) ? it.cat : '세라믹'; }
function itemUnit(cat) { return (cat === '세면대' || cat === '기타') ? '개' : '장'; }
function catIsCeramicLike(cat) { return cat === '세라믹' || cat === '석재'; }   // 헤베(㎡)·패턴 사용
function catUsesSpec(cat) { return cat !== '기타'; }   // 규격: 세라믹·석재·무늬목·세면대
function catUsesStone(cat) { return cat === '세면대'; }   // 석종(자재종류) 선택
function basinStoneNames() { const set = new Set(BASIN_STONES.map(s => s.k)); (state.inventory || []).forEach(i => { if (itemCat(i) === '세면대' && i.stone) set.add(i.stone); }); return [...set]; }
function catColor(c) { return { '세라믹': '#0F6E56', '석재': '#7a5b2e', '세면대': '#2f6fed', '무늬목': '#9a6a12', '기타': '#6b7280' }[c || '세라믹'] || '#6b7280'; }
function catBadge(cat) { const c = cat || '세라믹'; const col = catColor(c); return `<span style="display:inline-block;font-size:9.5px;font-weight:700;color:${col};background:${col}1a;border:1px solid ${col}55;border-radius:7px;padding:1px 6px;vertical-align:middle;margin-left:4px">${esc(c)}</span>`; }
function stockBaseList() {
  const f = filters.stock;
  let list = state.inventory.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  if (f === 'none') list = list.filter(i => stockState(i).k === '없음');
  else if (f === 'short') list = list.filter(i => ['부족', '임박'].includes(stockState(i).k));
  else if (f === 'low') list = list.filter(i => ['부족', '없음'].includes(stockState(i).k));
  else if (f === 'ok') list = list.filter(i => stockState(i).k === '정상');
  else if (f === 'dmg') list = list.filter(i => damagedStock(i.name) > 0);
  const cat = filters.stockCat || 'all';
  if (cat !== 'all') list = list.filter(i => itemCat(i) === cat);
  const q = (filters.stockSearch || '').trim().toLowerCase();
  if (q) list = list.filter(i => (i.name || '').toLowerCase().includes(q) || (i.spec || '').toLowerCase().includes(q) || (i.vendor || '').toLowerCase().includes(q) || itemCat(i).includes(q));
  return list;
}
function stockRowsHtml(list) {
  if (!list.length) return `<tr><td colspan="8"><div class="empty"><i class="ti ti-package-off"></i>해당하는 자재가 없습니다</div></td></tr>`;
  return list.map(i => {
    const s = stockState(i);
    const held = heldJangFor(i.name), avail = (+i.jang || 0) - held;
    const dmg = damagedStock(i.name);
    const plan = plannedJangFor(i.name), planD = restockDateForItem(i.name);
    const cat = itemCat(i), u = itemUnit(cat), ceramic = catIsCeramicLike(cat);
    const planTxt = plan > 0 ? `<div style="font-size:10px;color:#2f6fed;font-weight:700">입고 예정 ${plan}${u}${planD ? ` <span style="font-weight:500;color:#5a86e0">(${(() => { const p = String(planD).split('-'); return p.length === 3 ? +p[1] + '/' + +p[2] : planD; })()})</span>` : ''}</div>` : '';
    return `<tr onclick="openItemForm('${i.id}')">
      <td><b>${esc(i.name)}</b>${catBadge(cat)}${dmg > 0 ? ` <span style="display:inline-block;font-size:10px;font-weight:700;color:#b42318;background:#fef3f2;border:1px solid #fecdca;border-radius:8px;padding:1px 6px">파손 ${dmg}</span>` : ''}<div style="font-size:11px;color:var(--t3)">${esc(i.vendor || '')}${i.stone ? ` · 석종 ${esc(i.stone)}` : ''}</div></td>
      <td>${esc(i.spec || '-')}</td>
      <td style="font-size:11px">${ceramic ? patternStockCell(i.name) : '-'}</td>
      <td><b>${(+i.jang || 0)}</b>${u}${i.safeJang ? `<div style="font-size:10px;color:var(--t3)">안전 ${i.safeJang}</div>` : ''}${planTxt}</td>
      <td><b style="color:${avail <= 0 ? 'var(--red-t)' : 'var(--gd)'}">${avail}</b>${u}${held > 0 ? `<div style="font-size:10px;color:var(--t3)">홀딩 ${held}</div>` : ''}</td>
      <td>${ceramic ? itemHebe(i).toFixed(1) + '㎡' : '-'}</td>
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
/* 입고 내역 전체 (최신순) */
function inTxnList() {
  return state.transactions.filter(t => t.type === 'in').sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || (b.date || '').localeCompare(a.date || ''));
}
/* 입고 내역 목록 HTML (검색 반영) */
function inListHtml() {
  const q = (filters.inSearch || '').trim().toLowerCase();
  let list = inTxnList();
  if (q) list = list.filter(t => (t.itemName || '').toLowerCase().includes(q) || (t.vendor || '').toLowerCase().includes(q) || (t.lot || '').toLowerCase().includes(q));
  if (!list.length) return `<div class="empty"><i class="ti ti-inbox"></i>${q ? '검색 결과가 없습니다' : '입고 내역 없음'}</div>`;
  return list.map(t => `<div class="alert-i b" style="background:var(--gl2);border-color:var(--gbd)"><div class="ai" style="color:var(--gd)"><i class="ti ti-login"></i></div><div class="at"><b>${esc(t.itemName)} +${(+t.hebe || 0).toFixed(1)}㎡ (${+t.jang || 0}장)</b><span>${esc(t.date)} · 롯트 ${esc(t.lot || '-')} · ${esc(t.vendor || '')} · ${esc(t.by || '')}</span></div>${isAdmin() ? `<button class="x" onclick="delIn('${t.id}')" aria-label="삭제"><i class="ti ti-trash" style="font-size:16px;color:var(--red-t)"></i></button>` : ''}</div>`).join('');
}
/* 검색어 입력 시 목록만 교체 (한글 입력 끊김 방지) */
function filterInList() {
  filters.inSearch = el('in-search') ? el('in-search').value : '';
  if (el('in-list')) el('in-list').innerHTML = inListHtml();
  const x = el('in-search-x'); if (x) x.style.display = (filters.inSearch || '').trim() ? '' : 'none';
}
/* 입고 내역 → 엑셀(.xls) 다운로드 (검색 반영, 패턴별 행 분리) */
function downloadInXls() {
  const q = (filters.inSearch || '').trim().toLowerCase();
  let list = inTxnList();
  if (q) list = list.filter(t => (t.itemName || '').toLowerCase().includes(q) || (t.vendor || '').toLowerCase().includes(q) || (t.lot || '').toLowerCase().includes(q));
  if (!list.length) { toast('내보낼 입고 내역이 없습니다'); return; }
  const rows = [];
  list.forEach(t => {
    const it = state.inventory.find(i => _normName(i.name) === _normName(t.itemName));
    const per = it ? (+it.hebePerJang || 0) : 0;
    const pats = (t.patterns && t.patterns.length) ? t.patterns : [{ pattern: '', jang: +t.jang || 0 }];
    pats.forEach(p => { const jg = +p.jang || 0; rows.push({ date: t.date || '', name: t.itemName || '', spec: t.spec || (it && it.spec) || '', pattern: p.pattern || '', jang: jg, hebe: +(jg * per).toFixed(2), lot: t.lot || '', vendor: t.vendor || '', by: t.by || '', note: t.note || '' }); });
  });
  const tj = rows.reduce((a, b) => a + b.jang, 0), th = rows.reduce((a, b) => a + b.hebe, 0);
  const TH = (t, w) => `<th style="background:#0F6E56;color:#fff;font-weight:bold;border:0.5pt solid #0a4f3e;padding:7px 10px;text-align:center" ${w ? 'width="' + w + '"' : ''}>${t}</th>`;
  const TD = (t, st) => `<td style="border:0.5pt solid #cfd8d4;padding:5px 10px;${st || ''}">${t}</td>`;
  const body = rows.map((r, i) => { const bg = i % 2 ? 'background:#f3f6f4;' : ''; return `<tr>${TD(esc(r.date), bg)}${TD('<b>' + esc(r.name) + '</b>', bg)}${TD(esc(r.spec), bg)}${TD(esc(r.pattern), bg)}${TD(r.jang, bg + 'text-align:right')}${TD(r.hebe.toFixed(2), bg + 'text-align:right')}${TD(esc(r.lot), bg)}${TD(esc(r.vendor), bg)}${TD(esc(r.by), bg)}${TD(esc(r.note), bg)}</tr>`; }).join('');
  const sumStyle = 'border:0.5pt solid #cfd8d4;background:#e1f5ee;color:#0a4f3e;font-weight:bold;padding:7px 10px';
  const scope = q ? `검색 "${esc(filters.inSearch.trim())}"` : '전체';
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>입고내역</x:Name><x:WorksheetOptions><x:FreezePanes/><x:SplitHorizontal>3</x:SplitHorizontal><x:TopRowBottomPane>3</x:TopRowBottomPane></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]--></head><body>
<table style="border-collapse:collapse;font-family:'맑은 고딕','Malgun Gothic',sans-serif;font-size:10.5pt">
<tr><td colspan="10" style="font-size:16pt;font-weight:bold;color:#0F6E56;padding:8px 4px 2px">다우세라믹앤석재 · 입고 내역</td></tr>
<tr><td colspan="10" style="font-size:9pt;color:#777;padding:0 4px 10px">범위 ${scope}  ·  생성일 ${todayStr()}  ·  총 ${rows.length}행</td></tr>
<tr>${TH('입고일', 90)}${TH('자재명', 150)}${TH('규격', 110)}${TH('패턴', 90)}${TH('장수', 60)}${TH('헤베(㎡)', 80)}${TH('롯트', 110)}${TH('발주처', 120)}${TH('담당', 80)}${TH('메모', 140)}</tr>
${body}
<tr><td colspan="4" style="${sumStyle};text-align:right">합계</td><td style="${sumStyle};text-align:right">${tj}</td><td style="${sumStyle};text-align:right">${th.toFixed(2)}</td><td colspan="4" style="${sumStyle}"></td></tr>
</table></body></html>`;
  const blob = new Blob(['﻿' + html], { type: 'application/vnd.ms-excel;charset=utf-8;' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = '입고내역_' + todayStr() + '.xls'; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
  toast('입고 엑셀 다운로드 (' + rows.length + '행)');
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
    <div class="chips">${['all'].concat(ITEM_CATS).map(chipCat).join('')}</div>
    <div class="chips">${chipS('all', '전체', f)}${chipS('none', '없음', f)}${chipS('short', '부족', f)}${chipS('ok', '정상', f)}${chipS('dmg', '파손', f)}</div>
    ${f === 'low' ? `<div class="banner warn"><i class="ti ti-alert-triangle"></i><span><b>입고가 필요한 자재</b>만 모았습니다. 자재명과 현재 수량을 확인하세요.</span></div>` : ''}
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><span style="font-size:12px;color:var(--t3)">검색 결과 <b id="stock-count" style="color:var(--t1)">${list.length}종</b></span><button class="btn btn-sm" onclick="stockExportExcel()"><i class="ti ti-download"></i>재고 엑셀</button></div>
    <div class="tbl-wrap" id="stock-wrap" data-keepscroll style="max-height:calc(100vh - 360px);min-height:220px;overflow:auto">
      <table class="tbl">
        <thead><tr><th>자재명</th><th>규격</th><th>패턴별</th><th>실재고</th><th>가용</th><th>헤베(㎡)</th><th>상태</th><th>창고</th></tr></thead>
        <tbody id="stock-tbody">${stockRowsHtml(list)}</tbody>
      </table>
    </div>
    ${restockCardHtml()}
    <div class="card" style="margin-top:14px">
      <div class="card-h"><h3><i class="ti ti-login"></i>입고 내역</h3><button class="btn btn-sm" onclick="downloadInXls()"><i class="ti ti-file-spreadsheet"></i>엑셀</button></div>
      <div class="search-box" style="margin-bottom:10px">
        <i class="ti ti-search"></i>
        <input id="in-search" placeholder="자재명·공급처·롯트 검색" value="${esc(filters.inSearch || '')}" oninput="filterInList()" autocomplete="off" lang="ko">
        <button class="search-x" id="in-search-x" style="${(filters.inSearch || '').trim() ? '' : 'display:none'}" onclick="el('in-search').value='';filterInList()"><i class="ti ti-x"></i></button>
      </div>
      <div id="in-list" data-keepscroll style="max-height:360px;overflow-y:auto;-webkit-overflow-scrolling:touch">${inListHtml()}</div>
    </div>`;
}
function chipS(v, l, c) { return `<button class="chip ${c === v ? 'active' : ''}" onclick="filters.stock='${v}';renderStock()">${l}</button>`; }
function chipCat(c) { const cur = filters.stockCat || 'all'; const label = c === 'all' ? '전체종류' : c; const on = cur === c; const col = c === 'all' ? '' : catColor(c); return `<button class="chip ${on ? 'active' : ''}" style="${on && col ? `background:${col};border-color:${col};color:#fff` : (col ? `color:${col}` : '')}" onclick="filters.stockCat='${c}';renderStock()">${label}</button>`; }
/* 현재 재고 리스트 → 엑셀 (항목별 실재고 · 롯트 참고) */
function stockExportExcel() {
  if (typeof XLSX === 'undefined') { toast('엑셀 모듈 로딩 중 — 잠시 후 다시'); return; }
  const rows = [];
  state.inventory.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).forEach(it => {
    const jang = +it.jang || 0;
    if (jang === 0) return;   // 재고 0 제외
    const per = +it.hebePerJang || 0;
    // 롯트별·패턴별 잔여(참고). 출고에 미기입분은 '(미지정)'으로 집계됨
    const lotText = lotStock(it.name).filter(l => l.remain !== 0)
      .map(l => `${l.lot} ${l.remain}장`).join(' · ');
    const patText = patternStock(it.name).map(p => `${p.pattern} ${p.remain}장`).join(' · ');
    rows.push({
      '자재명': it.name || '',
      '규격': it.spec || '',
      '실재고(장)': jang,
      '가용(장)': availJang(it),
      '파손(장)': (function () { const d = damagedStock(it.name); return d > 0 ? d : ''; })(),
      '헤베(㎡)': +(jang * per).toFixed(2),
      '패턴별(참고)': patText,
      '롯트별(참고)': lotText,
      '창고': it.depot || '',
      '공급처': it.vendor || ''
    });
  });
  if (!rows.length) { toast('재고가 없습니다'); return; }
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '재고');
  XLSX.writeFile(wb, `재고리스트_${todayStr()}.xlsx`);
  toast('재고 ' + rows.length + '종 다운로드');
}

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
      <div class="fld"><label>제품 종류<span class="req">*</span></label>
        <select id="i-cat" onchange="onItemCatChange()">${ITEM_CATS.map(c => `<option value="${c}" ${itemCat(v) === c ? 'selected' : ''}>${c}${c === '기타' ? ' (폽업·수전 등)' : ''}</option>`).join('')}</select>
      </div>
      <div class="fld" id="i-stone-fld"><label>석종(자재종류) <span style="color:var(--t3);font-weight:500">— 세면대 (기존 목록 선택 또는 새로 입력)</span></label>${searchBox('i-stone', '석종 검색·입력', v.stone || '', 'basinStoneNames', '')}</div>
      <div class="fld"><label>자재명<span class="req">*</span> <span style="color:var(--t3);font-weight:500" id="i-name-hint"></span></label><input id="i-name" value="${esc(v.name || '')}" placeholder="자재명"></div>
      <div class="fld" id="i-spec-fld"><label>규격 (가로*세로*두께)</label>
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
      <div class="fld"><label id="i-jang-label">현재 ${itemUnit(itemCat(v)) === '개' ? '수량(개)' : '장수'}</label><input id="i-jang" value="${esc(v.jang || 0)}" inputmode="numeric" oninput="updateItemHebe()"></div>
      <div class="fld"><label id="i-safe-label">안전재고(${itemUnit(itemCat(v))}) — 미만이면 '부족'</label><input id="i-safe" value="${esc(v.safeJang || 0)}" inputmode="numeric" placeholder="안전재고"></div>
      <div class="fld full" id="i-hebe-fld"><div class="reco" id="i-hebe-info" style="margin-top:0"><div class="reco-h"><i class="ti ti-ruler-2"></i>자동 환산</div><div class="row"><span class="rl">장당 헤베</span><span class="rv"><b id="i-perjang">${(parseSpec(v.spec).hebePerJang || 0).toFixed(3)}</b> ㎡/장</span></div><div class="row"><span class="rl">현재 재고 헤베</span><span class="rv"><b id="i-tothebe">${itemHebe(v).toFixed(2)}</b> ㎡</span></div></div></div>
    </div>
    <div id="i-pattern-block">
    <div class="sec-label"><i class="ti ti-layout-grid"></i>패턴 정의(고정) <span style="font-weight:500;color:var(--t3)">— 입고 때 자동 표시</span></div>
    <div style="font-size:11.5px;color:var(--t3);margin-bottom:6px;background:var(--soft);border-radius:9px;padding:9px 11px;line-height:1.5"><i class="ti ti-info-circle"></i> 이 자재의 패턴을 배치 순서대로 적어두면(예: 1번(좌상), 2번(우상)) 입고 등록 때 그대로 자동 표시돼 매번 입력할 필요가 없습니다. 공정이 바뀌면 언제든 여기서 수정하세요.</div>
    <div id="ipat-defs">${(() => { const defs = it ? matPatternDefs(it.name) : []; return defs.length ? defs.map(ipatDefRow).join('') : ipatDefRow(''); })()}</div>
    <button class="btn btn-ghost btn-sm" type="button" onclick="addIpatDef()" style="margin-bottom:8px"><i class="ti ti-plus"></i>패턴 추가</button>
    </div>
    ${it ? `
    <div class="sec-label" style="display:flex;justify-content:space-between;align-items:center"><span><i class="ti ti-list-details"></i>롯트별 재고</span>${isAdmin() ? `<button class="btn btn-ghost btn-sm" type="button" onclick="openAdjustForm('${it.id}')"><i class="ti ti-adjustments"></i>재고 조정</button>` : ''}</div>
    ${(() => { const ls = lotStock(it.name); return ls.length ? `<div class="tbl-wrap" style="margin-bottom:6px"><table class="tbl"><thead><tr><th>롯트</th><th>입고</th><th>출고</th><th>잔여</th></tr></thead><tbody>${ls.map(l => `<tr><td><b>${esc(l.lot)}</b></td><td>${l.inQty}장</td><td>${l.outQty}장</td><td><b style="color:${l.remain <= 0 ? 'var(--t3)' : 'var(--gd)'}">${l.remain}장</b></td></tr>`).join('')}</tbody></table></div>` : `<div style="font-size:12.5px;color:var(--t3);padding:2px 0 8px">롯트 정보가 없습니다 (입고 시 롯트를 입력하면 표시됩니다)</div>`; })()}
    ${(() => { const ds = depotStock(it.name); return ds.length > 1 ? `<div class="sec-label"><i class="ti ti-building-warehouse"></i>창고별 재고</div><div class="tbl-wrap" style="margin-bottom:6px"><table class="tbl"><thead><tr><th>창고</th><th>입고</th><th>출고</th><th>잔여</th></tr></thead><tbody>${ds.map(d => `<tr><td><b>${esc(d.depot)}</b></td><td>${d.inQty}장</td><td>${d.outQty}장</td><td><b style="color:${d.remain <= 0 ? 'var(--t3)' : 'var(--gd)'}">${d.remain}장</b></td></tr>`).join('')}</tbody></table></div>` : ''; })()}
    <div class="sec-label" style="display:flex;justify-content:space-between;align-items:center"><span><i class="ti ti-alert-square-rounded" style="color:#d64545"></i> 파손 재고 <b style="color:#b42318">${damagedStock(it.name)}장</b></span><button class="btn btn-ghost btn-sm" type="button" onclick="openDamageForm('${it.id}')"><i class="ti ti-arrow-right-bar"></i>파손 처리</button></div>
    ${isAdmin() ? `<div class="sec-label"><i class="ti ti-history"></i>재고 조정 내역 <span style="font-weight:500;color:var(--t3)">(관리자)</span></div>
    ${(() => { const adjs = txns.filter(t => t.type === 'adjust').sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || 0) - (a.createdAt || 0)); return adjs.length ? adjs.map(t => { const d = +t.jang || 0; return `<div class="alert-i b" style="margin-bottom:6px"><div class="ai" style="color:${d >= 0 ? 'var(--gd)' : 'var(--red-t)'}"><i class="ti ti-adjustments"></i></div><div class="at"><b style="color:${d >= 0 ? 'var(--gd)' : 'var(--red-t)'}">${d > 0 ? '+' : ''}${d}장</b><span>${esc(t.date || '')}${t.lot ? ' · 롯트 ' + esc(t.lot) : ''}${t.pattern ? ' · 패턴 ' + esc(t.pattern) : ''} · ${esc(t.note || '')} · ${esc(t.by || '')}</span></div><button class="btn btn-ghost btn-sm" type="button" onclick="event.stopPropagation();delAdjust('${t.id}')" title="되돌리기"><i class="ti ti-arrow-back-up"></i></button></div>`; }).join('') : `<div style="font-size:12.5px;color:var(--t3);padding:2px 0 8px">조정 내역이 없습니다</div>`; })()}` : ''}
    <div class="sec-label"><i class="ti ti-logout"></i>출고 내역 <span style="font-weight:500;color:var(--t3)">· 누적 ${totalOut}장</span></div>
    <div style="font-size:11.5px;color:var(--t3);margin-bottom:6px"><i class="ti ti-info-circle"></i> 출고를 탭하면 롯트·패턴을 지정해 미지정을 해소할 수 있습니다</div>
    ${txnRowsWithMore(outs, 'out-more', t => { const dmg = (t.damaged === true) || (t.damaged === undefined && /파손/.test(t.note || '')); return `<div class="alert-i b" style="margin-bottom:6px;cursor:pointer" onclick="openOutEdit('${t.id}')" title="탭하면 롯트·패턴 지정"><div class="ai"><i class="ti ti-logout"></i></div><div class="at"><b>${+t.jang || 0}장${t.hebe ? ` (${(+t.hebe).toFixed(1)}㎡)` : ''}${dmg ? ` <span style="display:inline-block;font-size:10px;font-weight:700;color:#b42318;background:#fef3f2;border:1px solid #fecdca;border-radius:8px;padding:1px 6px">파손</span>` : ''}</b><span>${esc(t.date || '')} · ${esc(t.targetName || '-')}${t.lot ? ' · 롯트 ' + esc(t.lot) : ' · <span style="color:var(--red-t)">롯트 미지정</span>'}</span></div><i class="ti ti-edit" style="color:var(--t3);align-self:center"></i></div>`; }, '출고 내역 없음')}
    <div class="sec-label" style="margin-top:14px"><i class="ti ti-login"></i>입고 내역</div>
    <div style="font-size:11.5px;color:var(--t3);margin-bottom:6px"><i class="ti ti-info-circle"></i> 입고 내역을 탭하면 롯트·패턴을 수정할 수 있습니다</div>
    ${txnRowsWithMore(ins, 'in-more', t => `<div class="alert-i b" style="background:var(--gl2);border-color:var(--gbd);margin-bottom:6px;cursor:pointer" onclick="openInEdit('${t.id}')" title="탭하면 롯트·패턴 수정"><div class="ai" style="color:var(--gd)"><i class="ti ti-login"></i></div><div class="at"><b>+${+t.jang || 0}장${t.hebe ? ` (${(+t.hebe).toFixed(1)}㎡)` : ''}</b><span>${esc(t.date || '')} · 롯트 ${esc(t.lot || '-')} · ${esc(t.by || '')}</span></div><i class="ti ti-edit" style="color:var(--t3);align-self:center"></i></div>`, '입고 내역 없음')}
    ` : ''}
    <div class="frm-foot">
      ${it && isAdmin() ? `<button class="btn btn-danger" onclick="delItem('${id}')"><i class="ti ti-trash"></i></button>` : ''}
      <button class="btn" style="flex:1" onclick="closeModal()">취소</button>
      <button class="btn btn-pri" style="flex:1.4" onclick="submitItem('${id || ''}')"><i class="ti ti-check"></i>저장</button>
    </div>`);
  setSelectValue('i-vendor', 'suppliers', v.vendor);
  onItemCatChange();   // 종류에 맞춰 규격·헤베·패턴 표시/숨김 + 단위 라벨 반영
}
/* 품목 폼: 종류 변경 시 세라믹 전용 항목 표시/숨김 + 단위 라벨 갱신 */
function onItemCatChange() {
  const cat = el('i-cat') ? el('i-cat').value : '세라믹';
  const ceramic = catIsCeramicLike(cat);   // 헤베·패턴
  const toggle = (id, show) => { const e = el(id); if (e) e.style.display = show ? '' : 'none'; };
  toggle('i-stone-fld', catUsesStone(cat));   // 석종 — 세면대만
  toggle('i-spec-fld', catUsesSpec(cat));     // 규격 — 기타 빼고 전부(세면대·무늬목 포함)
  toggle('i-hebe-fld', ceramic);              // 헤베(㎡) — 세라믹·석재
  toggle('i-pattern-block', ceramic);         // 패턴 — 세라믹·석재
  if (!catUsesSpec(cat)) { const a = el('i-spec-add'); if (a) a.classList.add('hidden'); }
  const u = itemUnit(cat);
  const jl = el('i-jang-label'); if (jl) jl.textContent = '현재 ' + (u === '개' ? '수량(개)' : '장수');
  const sl = el('i-safe-label'); if (sl) sl.textContent = "안전재고(" + u + ") — 미만이면 '부족'";
  const nh = el('i-name-hint'); if (nh) nh.textContent = catUsesStone(cat) ? '(비우면 석종명으로 저장)' : '';
}
/* 현재고 → 파손 처리(정상↔파손). 실재고는 그대로, '파손' 수량만 변동 */
function openDamageForm(id) {
  const it = state.inventory.find(x => x.id === id); if (!it) return;
  const cur = damagedStock(it.name);
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-alert-square-rounded" style="color:#d64545"></i>파손 처리</h3><button class="x" onclick="closeModal()">×</button></div>
    <div style="font-size:13px;color:var(--t2);margin-bottom:12px"><b style="color:var(--t1)">${esc(it.name)}</b> · 실재고 ${+it.jang || 0}장 · 현재 파손 <b style="color:#b42318">${cur}장</b></div>
    <div class="frm">
      <div class="fld"><label>구분</label><select id="dm-dir"><option value="1">파손 처리 (정상 → 파손)</option><option value="-1">파손 복구 (파손 → 정상)</option></select></div>
      <div class="fld"><label>장수</label><input id="dm-jang" inputmode="numeric" value="1"></div>
      <div class="fld full"><label>롯트 <span style="color:var(--t3);font-weight:500">(선택)</span></label><select id="dm-lot">${lotSelectHtml(it.name, '')}</select></div>
      <div class="fld full"><label>패턴 <span style="color:var(--t3);font-weight:500">(선택)</span></label><select id="dm-pat">${patternSelectHtml(it.name, '')}</select></div>
      <div class="fld full"><label>사유</label><input id="dm-note" lang="ko" value="모서리 파손" placeholder="파손 사유"></div>
      <div class="fld full" style="font-size:11.5px;color:var(--t3);background:var(--soft);border-radius:9px;padding:9px 11px;line-height:1.5"><i class="ti ti-info-circle"></i> 파손 처리해도 실재고(장수)는 그대로이고 '파손' 수량으로만 표시됩니다. 폐기·반품으로 실재고에서 빼려면 출고로 처리하세요.</div>
    </div>
    <div class="frm-foot"><button class="btn" style="flex:1" onclick="closeModal()">취소</button><button class="btn btn-pri" style="flex:2" onclick="submitDamage('${it.id}')"><i class="ti ti-check"></i>적용</button></div>`);
}
async function submitDamage(id) {
  const it = state.inventory.find(x => x.id === id); if (!it) return;
  const dir = parseInt(el('dm-dir').value, 10) || 1;
  const n = Math.abs(parseFloat(el('dm-jang').value) || 0);
  if (n <= 0) { toast('장수를 입력하세요'); return; }
  if (dir < 0 && n > damagedStock(it.name)) { toast('복구 수량이 현재 파손 수량보다 많습니다'); return; }
  await Store.add('transactions', {
    type: 'damage', itemId: it.id, itemName: it.name, spec: it.spec || '',
    jang: dir * n, lot: (el('dm-lot').value || '').trim(), pattern: (el('dm-pat').value || '').trim(),
    note: (el('dm-note').value || '').trim() || '파손', date: todayStr(), by: me.name
  });
  closeModal();
  toast(dir > 0 ? `파손 ${n}장 처리됨` : `파손 ${n}장 복구됨`);
}
/* 입고 내역 수정 — 롯트·패턴 재배정(롯트별/패턴별 재고 자동 재계산). 장수는 변경하지 않음 */
function iepRowHtml(p) {
  p = p || {};
  const inp = 'font-size:14px;padding:9px 10px;border:1.5px solid var(--bd2);border-radius:9px';
  return `<div class="iep-row" style="display:flex;gap:6px;margin-bottom:6px">
    <input class="iep-name" lang="ko" placeholder="패턴(없으면 비움)" value="${esc(p.pattern && p.pattern !== '-' ? p.pattern : '')}" style="flex:1.4;min-width:0;${inp}">
    <input class="iep-jang" inputmode="numeric" placeholder="장수" value="${esc(p.jang != null ? p.jang : '')}" oninput="iepTotal()" style="flex:1;min-width:50px;${inp}">
    <button type="button" class="btn btn-ghost btn-sm" onclick="this.closest('.iep-row').remove();iepTotal()" aria-label="삭제"><i class="ti ti-x"></i></button>
  </div>`;
}
function addIepRow() { const c = el('iep-rows'); if (c) c.insertAdjacentHTML('beforeend', iepRowHtml({})); }
function iepTotal() { let t = 0; document.querySelectorAll('#iep-rows .iep-jang').forEach(i => t += parseFloat(i.value) || 0); if (el('iep-total')) el('iep-total').textContent = t; return t; }
function openInEdit(id) {
  const t = state.transactions.find(x => x.id === id && x.type === 'in'); if (!t) return;
  const pats = (t.patterns && t.patterns.length) ? t.patterns : [{ pattern: '', jang: +t.jang || 0 }];
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-edit"></i>입고 내역 수정</h3><button class="x" onclick="closeModal()">×</button></div>
    <div style="font-size:13px;color:var(--t2);margin-bottom:12px"><b style="color:var(--t1)">${esc(t.itemName || '')}</b>${t.spec ? ' · ' + esc(t.spec) : ''}</div>
    <div class="frm">
      <div class="fld"><label>입고일</label><input type="date" id="ie-date" value="${esc(t.date || '')}"></div>
      <div class="fld"><label>공급처</label><input id="ie-vendor" lang="ko" value="${esc(t.vendor || '')}"></div>
      <div class="fld"><label>창고(입고지)</label><input id="ie-depot" list="ie-depot-list" value="${esc(t.depot || '')}" placeholder="창고"><datalist id="ie-depot-list">${depotOptions().map(d => `<option value="${esc(d)}">`).join('')}</datalist></div>
      <div class="fld full"><label>롯트 넘버<span class="req">*</span></label><input id="ie-lot" value="${esc(t.lot || '')}" placeholder="롯트 넘버"></div>
      <div class="fld full"><label>패턴별 장수 <span style="color:var(--t3);font-weight:500">(패턴 없으면 이름 비우고 장수만)</span></label>
        <div id="iep-rows">${pats.map(iepRowHtml).join('')}</div>
        <button type="button" class="btn btn-ghost btn-sm btn-block" onclick="addIepRow()"><i class="ti ti-plus"></i>패턴 추가</button>
        <div style="font-size:12px;color:var(--t3);margin-top:4px">합계 <b id="iep-total" style="color:var(--t1)">${+t.jang || 0}</b>장</div>
      </div>
      <div class="fld full"><label>비고</label><input id="ie-note" lang="ko" value="${esc(t.note || '')}"></div>
      <div class="fld full" style="font-size:11.5px;color:var(--t3);background:var(--soft);border-radius:9px;padding:9px 11px;line-height:1.5"><i class="ti ti-info-circle"></i> 롯트 넘버·패턴별 장수를 자유롭게 수정할 수 있습니다. 총 장수가 바뀌면 실재고도 자동 보정됩니다. 롯트별/패턴별 재고는 자동으로 다시 계산됩니다.</div>
    </div>
    <div class="frm-foot">${isAdmin() ? `<button class="btn" style="color:var(--red-t);border-color:#e6a9a9" onclick="delInTxn('${t.id}')"><i class="ti ti-trash"></i></button>` : ''}<button class="btn" style="flex:1" onclick="closeModal()">취소</button><button class="btn btn-pri" style="flex:2" onclick="submitInEdit('${t.id}')"><i class="ti ti-check"></i>저장</button></div>`);
  iepTotal();
}
async function submitInEdit(id) {
  const t = state.transactions.find(x => x.id === id && x.type === 'in'); if (!t) return;
  const lot = (el('ie-lot').value || '').trim();
  if (!lot) { toast('롯트 넘버를 입력하세요'); return; }
  const patterns = []; let newJang = 0;
  document.querySelectorAll('#iep-rows .iep-row').forEach(r => {
    const nm = (r.querySelector('.iep-name').value || '').trim();
    const q = parseFloat(r.querySelector('.iep-jang').value) || 0;
    if (q > 0) { patterns.push({ pattern: nm || '-', jang: q }); newJang += q; }
  });
  if (newJang <= 0) { toast('장수를 입력하세요'); return; }
  const it = state.inventory.find(i => i.id === t.itemId || i.name === t.itemName);
  const per = it ? (+it.hebePerJang || 0) : 0;
  const oldJang = +t.jang || 0;
  await Store.update('transactions', id, {
    lot, patterns, jang: newJang, hebe: +(newJang * per).toFixed(2),
    date: el('ie-date').value || t.date || '', vendor: (el('ie-vendor').value || '').trim(), note: (el('ie-note').value || '').trim(),
    depot: (el('ie-depot') && el('ie-depot').value || '').trim()
  });
  if (it && newJang !== oldJang) {
    await Store.update('inventory', it.id, { jang: Math.max(0, (+it.jang || 0) + (newJang - oldJang)) });   // 입고 총량 변경분만큼 실재고 보정
  }
  closeModal(); toast('입고 내역이 수정되었습니다');
}
/* 입고 삭제 (관리자) — 실재고에서 차감 */
async function delInTxn(id) {
  if (!isAdmin()) { toast('관리자만 삭제할 수 있습니다'); return; }
  const t = state.transactions.find(x => x.id === id && x.type === 'in'); if (!t) return;
  if (!guardDelete(`이 입고를 삭제할까요?\n${t.itemName} +${+t.jang || 0}장 · ${t.date || ''}\n실재고에서 차감됩니다.`)) return;
  const it = state.inventory.find(i => i.id === t.itemId || i.name === t.itemName);
  if (it) await Store.update('inventory', it.id, { jang: Math.max(0, (+it.jang || 0) - (+t.jang || 0)) });
  await Store.remove('transactions', id);
  closeModal(); toast('입고 삭제됨 (재고 차감)');
}
/* 재고 조정(실사 보정) — 롯트+패턴+실재고를 한 번에 ± 보정 */
function openAdjustForm(id) {
  if (!isAdmin()) { toast('재고 조정은 관리자만 가능합니다'); return; }
  const it = state.inventory.find(x => x.id === id); if (!it) return;
  const lots = lotStock(it.name).map(l => l.lot).filter(l => l && l !== '(미지정)');
  const pats = patternStock(it.name).map(p => p.pattern).filter(Boolean);
  const depots = depotStock(it.name).map(d => d.depot);
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-adjustments"></i>재고 조정 (실사 보정)</h3><button class="x" onclick="closeModal()">×</button></div>
    <div style="font-size:13px;color:var(--t2);margin-bottom:12px"><b style="color:var(--t1)">${esc(it.name)}</b> · 실재고 ${+it.jang || 0}장</div>
    <div class="frm">
      <div class="fld"><label>구분</label><select id="aj-dir" onchange="ajDirChange()"><option value="1">증가 (＋ 총재고)</option><option value="-1">감소 (－ 총재고)</option><option value="move">창고 이동 (총량 불변)</option></select></div>
      <div class="fld"><label>장수</label><input id="aj-jang" inputmode="numeric" value="1"></div>
      <div class="fld full" id="aj-depot-fld"><label>창고 <span style="color:var(--t3);font-weight:500">(선택 · 창고별 총재고 보정 시)</span></label><input id="aj-depot" list="aj-depot-list" placeholder="창고"><datalist id="aj-depot-list">${depots.map(d => `<option value="${esc(d)}">`).join('')}</datalist></div>
      <div class="fld full hidden" id="aj-move-fld"><label>창고 이동 (출발 → 도착) <span style="color:var(--t3);font-weight:500">(총재고는 그대로, 창고별만 이동)</span></label><div style="display:flex;gap:6px;align-items:center"><input id="aj-from" list="aj-dep2" placeholder="출발 창고" style="flex:1"><span style="flex:none;color:var(--t3)">→</span><input id="aj-to" list="aj-dep2" placeholder="도착 창고" style="flex:1"></div><datalist id="aj-dep2">${depotOptions().map(d => `<option value="${esc(d)}">`).join('')}</datalist></div>
      <div class="fld full"><label>롯트 <span style="color:var(--t3);font-weight:500">(선택 · 비우면 총량만 보정)</span></label><input id="aj-lot" list="aj-lot-list" placeholder="롯트"><datalist id="aj-lot-list">${lots.map(l => `<option value="${esc(l)}">`).join('')}</datalist></div>
      <div class="fld full"><label>패턴 <span style="color:var(--t3);font-weight:500">(선택)</span></label><input id="aj-pat" list="aj-pat-list" lang="ko" placeholder="패턴"><datalist id="aj-pat-list">${pats.map(p => `<option value="${esc(p)}">`).join('')}</datalist></div>
      <div class="fld full"><label>사유</label><input id="aj-note" lang="ko" placeholder="예: 실사 보정 · 잘못 출고 후 보관 등"></div>
      <div class="fld full" style="font-size:11.5px;color:var(--t3);background:var(--soft);border-radius:9px;padding:9px 11px;line-height:1.5"><i class="ti ti-info-circle"></i> <b>증가/감소</b>는 총재고를 바꿉니다(창고 지정 시 그 창고에 반영). <b>창고 이동</b>은 총재고는 그대로 두고 출발→도착 창고로만 옮깁니다(오출고 보관 등).</div>
    </div>
    <div class="frm-foot"><button class="btn" style="flex:1" onclick="closeModal()">취소</button><button class="btn btn-pri" style="flex:2" onclick="submitAdjust('${it.id}')"><i class="ti ti-check"></i>조정</button></div>`);
  ajDirChange();
}
function ajDirChange() {
  const move = el('aj-dir') && el('aj-dir').value === 'move';
  if (el('aj-depot-fld')) el('aj-depot-fld').classList.toggle('hidden', move);
  if (el('aj-move-fld')) el('aj-move-fld').classList.toggle('hidden', !move);
}
async function submitAdjust(id) {
  if (!isAdmin()) { toast('재고 조정은 관리자만 가능합니다'); return; }
  const it = state.inventory.find(x => x.id === id); if (!it) return;
  const mode = el('aj-dir').value;
  const n = Math.abs(parseFloat(el('aj-jang').value) || 0);
  if (n <= 0) { toast('장수를 입력하세요'); return; }
  const lot = (el('aj-lot').value || '').trim(), pattern = (el('aj-pat').value || '').trim();
  const note = (el('aj-note').value || '').trim() || '재고 조정';
  if (mode === 'move') {
    const from = (el('aj-from').value || '').trim(), to = (el('aj-to').value || '').trim();
    if (!from || !to) { toast('출발·도착 창고를 입력하세요'); return; }
    if (from === to) { toast('출발과 도착 창고가 같습니다'); return; }
    const moveId = 'M' + Date.now();
    const base = { type: 'adjust', moveId, itemId: it.id, itemName: it.name, spec: it.spec || '', lot, pattern, date: todayStr(), by: me.name };
    await Store.add('transactions', Object.assign({}, base, { jang: -n, depot: from, note: `${note} (창고이동 ${from}→${to})` }));
    await Store.add('transactions', Object.assign({}, base, { jang: n, depot: to, note: `${note} (창고이동 ${from}→${to})` }));
    // 총재고(실재고)는 변경하지 않음 — 창고별만 이동
    closeModal(); toast(`창고 이동 완료 · ${from}→${to} ${n}장`);
    setTimeout(() => { if (state.inventory.find(x => x.id === id)) openItemForm(id); }, 350);
    return;
  }
  const dir = parseInt(mode, 10) || 1;
  const delta = dir * n;
  await Store.add('transactions', {
    type: 'adjust', itemId: it.id, itemName: it.name, spec: it.spec || '',
    jang: delta, lot, pattern, depot: (el('aj-depot').value || '').trim(),
    note, date: todayStr(), by: me.name
  });
  await Store.update('inventory', it.id, { jang: Math.max(0, (+it.jang || 0) + delta) });
  closeModal(); toast(`재고 조정 완료 (${delta > 0 ? '+' : ''}${delta}장)`);
  setTimeout(() => { if (state.inventory.find(x => x.id === id)) openItemForm(id); }, 350);
}
/* 조정 되돌리기 (관리자) — 조정 전 상태로 복구. 창고이동(net0)은 총재고 불변으로 그룹 삭제 */
async function delAdjust(id) {
  if (!isAdmin()) { toast('관리자만 가능합니다'); return; }
  const t = state.transactions.find(x => x.id === id && x.type === 'adjust'); if (!t) return;
  const it = state.inventory.find(i => i.id === t.itemId || i.name === t.itemName);
  if (t.moveId) {
    if (!confirm('이 창고 이동을 되돌릴까요? (총재고는 그대로)')) return;
    for (const g of state.transactions.filter(x => x.moveId === t.moveId)) { try { await Store.remove('transactions', g.id); } catch (e) { } }
  } else {
    if (!confirm(`이 조정(${(+t.jang || 0) > 0 ? '+' : ''}${+t.jang || 0}장)을 되돌릴까요?\n실재고·롯트·패턴 재고가 조정 전으로 복구됩니다.`)) return;
    if (it) await Store.update('inventory', it.id, { jang: Math.max(0, (+it.jang || 0) - (+t.jang || 0)) });
    await Store.remove('transactions', id);
  }
  toast('조정 되돌림');
  if (it) setTimeout(() => { if (state.inventory.find(x => x.id === it.id)) openItemForm(it.id); }, 350);
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
  const cat = el('i-cat') ? el('i-cat').value : '세라믹';
  const ceramic = catIsCeramicLike(cat);
  const stone = catUsesStone(cat) ? ((el('i-stone') && el('i-stone').value || '').trim()) : '';
  let name = el('i-name').value.trim();
  if (!name && stone) name = stone;   // 세면대: 자재명 비우면 석종명으로
  if (!name) { toast(catUsesStone(cat) ? '석종을 선택하거나 자재명을 입력하세요' : '자재명을 입력하세요'); return; }
  let spec = catUsesSpec(cat) ? el('i-spec').value : ''; if (spec === '__add') spec = '';
  const ps = parseSpec(spec);
  const jang = parseFloat(el('i-jang').value) || 0;
  let vendor = el('i-vendor').value; if (vendor === '__add') vendor = ''; vendor = vendor.trim();
  const patterns = [];
  if (ceramic) document.querySelectorAll('#ipat-defs .ipat-name').forEach(i => { const val = (i.value || '').trim(); if (val && !patterns.includes(val)) patterns.push(val); });
  const obj = { name, cat, stone, spec, vendor, depot: el('i-depot').value.trim() || '본사', jang, hebePerJang: ceramic ? ps.hebePerJang : 0, safeJang: parseFloat(el('i-safe').value) || 0, patterns };
  if (id) { await Store.update('inventory', id, obj); toast('저장됨'); }
  else { obj.lastInDate = todayStr(); await Store.add('inventory', obj); toast('품목 추가됨'); }
  closeModal();
}
/* 실수 삭제 방지 — 삭제하려면 '삭제' 를 직접 입력해야 진행 */
function guardDelete(msg) {
  const v = prompt((msg ? msg + '\n\n' : '') + "⚠ 실수 방지 — 삭제하려면 아래에 '삭제' 라고 입력하세요.");
  if (v == null) return false;
  if (v.trim() !== '삭제') { toast("삭제하려면 '삭제' 를 정확히 입력해야 합니다"); return false; }
  return true;
}
async function delItem(id) { if (!guardDelete('이 품목을 삭제할까요?')) return; await Store.remove('inventory', id); toast('삭제됨'); closeModal(); }

/* 입고 등록 → 자재 선택(언더바) + 롯트 + 패턴별 장수 → 헤베 자동환산 */
function openStockForm() {
  if (!state.inventory.length) { toast('먼저 품목을 추가하세요'); openItemForm(); return; }
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-login"></i>입고 등록</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="frm">
      <div class="fld full"><label>자재 선택<span class="req">*</span> <span style="color:var(--t3);font-weight:500">(자재명 입력 → ↑↓ 방향키로 선택)</span></label>
        ${searchBox('in-item', '자재명 검색·입력', '', 'invNames', 'onInItemChange')}
      </div>
      <div class="fld"><label>규격</label><input id="in-spec" readonly placeholder="자재 선택 시 자동" style="background:var(--soft)"></div>
      <div class="fld" id="in-lot-fld"><label>롯트 넘버<span class="req">*</span></label><input id="in-lot" placeholder="롯트 넘버 입력"></div>
      <div class="fld"><label>창고(입고지)</label><input id="in-depot" list="in-depot-list" placeholder="창고"><datalist id="in-depot-list">${depotOptions().map(d => `<option value="${esc(d)}">`).join('')}</datalist></div>
    </div>
    <div id="in-pattern-block">
      <div class="sec-label"><i class="ti ti-layout-grid"></i>패턴별 장수 <span style="font-weight:500;color:var(--t3)">(패턴이 없으면 장수만 입력)</span></div>
      <div id="in-patterns"></div>
      <button class="btn btn-ghost btn-sm" type="button" onclick="addPatternRow()" style="margin-top:4px"><i class="ti ti-plus"></i>패턴 추가</button>
    </div>
    <div class="frm" id="in-simple-block" style="display:none">
      <div class="fld"><label id="in-simple-label">수량</label><input id="in-simple-qty" inputmode="numeric" placeholder="수량 입력" oninput="computeInTotal()"></div>
    </div>
    <div class="frm" style="margin-top:14px">
      <div class="fld"><label>입고일</label><input type="date" id="in-date" value="${todayStr()}"></div>
      <div class="fld"><label>발주처/매입처 <span style="color:var(--t3);font-weight:500">(기본: 직발주)</span></label><select id="in-vendor" onchange="onMasterChange('in-vendor','suppliers')">${masterOptions('suppliers', '다우세라믹앤석재')}</select></div>
      <div class="fld full hidden" id="in-vendor-add"><label>기타 발주처 입력 후 추가</label><div style="display:flex;gap:8px"><input id="in-vendor-new" placeholder="이름 입력" style="flex:1"><button class="btn btn-pri btn-sm" type="button" onclick="commitMaster('in-vendor','suppliers')"><i class="ti ti-plus"></i>추가</button></div></div>
      <div class="fld full"><label>메모</label><input id="in-note" placeholder="선택"></div>
    </div>
    <div class="reco" id="in-summary" style="margin-top:14px"><div class="reco-h"><i class="ti ti-calculator"></i>합계</div>
      <div class="row"><span class="rl">총 입고 수량</span><span class="rv"><b id="in-tot-jang">0</b> <span id="in-tot-unit">장</span></span></div>
      <div class="row" id="in-hebe-row"><span class="rl">환산 헤베</span><span class="rv"><b id="in-tot-hebe">0</b> ㎡</span></div>
    </div>
    <div class="frm-foot"><button class="btn" style="flex:1" onclick="closeModal()">취소</button><button class="btn btn-pri" style="flex:2" onclick="submitStock()"><i class="ti ti-check"></i>입고 등록</button></div>`);
  _inLastMat = '';
  addPatternRow();
  onInItemChange();
}
let _inLastMat = '';   // 입고 폼에서 마지막으로 선택된 자재 (패턴 재채움 판단용)
function inSelItem() {   // 입고 폼에서 검색창에 입력된 자재명 → 재고 품목
  const nm = (el('in-item') && el('in-item').value || '').trim();
  return state.inventory.find(i => _normName(i.name) === _normName(nm));
}
function onInItemChange() {
  const it = inSelItem();
  el('in-spec').value = it ? (it.spec || '-') : '';
  if (el('in-depot')) el('in-depot').value = it ? (it.depot || '') : '';   // 선택 자재의 기본 창고
  // 종류별: 세라믹·석재는 롯트+패턴, 그 외(세면대·무늬목·기타)는 수량만
  const cat = it ? itemCat(it) : '세라믹';
  const ceramic = catIsCeramicLike(cat);
  const show = (id, on) => { const e = el(id); if (e) e.style.display = on ? '' : 'none'; };
  show('in-lot-fld', ceramic);
  show('in-pattern-block', ceramic);
  show('in-simple-block', !ceramic && !!it);
  show('in-hebe-row', ceramic);
  const sl = el('in-simple-label'); if (sl) sl.textContent = '수량(' + itemUnit(cat) + ')';
  if (it && it.name !== _inLastMat) {
    _inLastMat = it.name;
    if (ceramic) fillInPatterns(it.name);   // 자재가 바뀔 때만 고정 패턴 새로 채움
  } else if (!it) _inLastMat = '';
  computeInTotal();
}
/* 선택 자재의 고정 패턴대로 입고 패턴칸 자동 구성 (없으면 빈 칸 1개) */
function fillInPatterns(matName) {
  const box = el('in-patterns'); if (!box) return;
  box.innerHTML = '';
  const defs = matPatternDefs(matName);
  if (defs.length) defs.forEach(p => addPatternRow(p));
  else addPatternRow();
  computeInTotal();
}
function addPatternRow(name) {
  const box = el('in-patterns'); if (!box) return;
  const row = document.createElement('div');
  row.className = 'pat-row';
  row.style.cssText = 'display:flex;gap:8px;margin-bottom:8px';
  row.innerHTML = `<input class="in-pat-name" lang="ko" placeholder="패턴(선택)" value="${esc(name || '')}" style="flex:1.2;font-size:14px;padding:9px 11px;border:1.5px solid var(--bd2);border-radius:10px">
    <input class="in-pat-jang" inputmode="numeric" placeholder="장수" oninput="computeInTotal()" style="flex:1;font-size:14px;padding:9px 11px;border:1.5px solid var(--bd2);border-radius:10px">
    <button class="btn btn-ghost btn-sm" type="button" onclick="this.parentElement.remove();computeInTotal()"><i class="ti ti-x"></i></button>`;
  box.appendChild(row);
}
function computeInTotal() {
  const it = inSelItem();
  const cat = it ? itemCat(it) : '세라믹';
  const ceramic = catIsCeramicLike(cat);
  let tot = 0;
  if (ceramic) document.querySelectorAll('#in-patterns .in-pat-jang').forEach(i => tot += parseFloat(i.value) || 0);
  else tot = parseFloat(el('in-simple-qty') && el('in-simple-qty').value) || 0;
  const per = it ? (+it.hebePerJang || 0) : 0;
  if (el('in-tot-jang')) el('in-tot-jang').textContent = tot;
  if (el('in-tot-unit')) el('in-tot-unit').textContent = itemUnit(cat);
  if (el('in-tot-hebe')) el('in-tot-hebe').textContent = (tot * per).toFixed(2);
}
async function submitStock() {
  const it = inSelItem();
  if (!it) { toast('자재를 선택하세요 (자재명 입력 후 목록에서 선택)'); return; }
  const ceramic = catIsCeramicLike(itemCat(it));
  let lot = ''; const patterns = []; let jang = 0;
  if (ceramic) {
    lot = el('in-lot').value.trim();
    if (!lot) { toast('롯트 넘버를 입력하세요 (세라믹·석재 필수)'); return; }
    document.querySelectorAll('#in-patterns .pat-row').forEach(r => {
      const nm = r.querySelector('.in-pat-name').value.trim();
      const q = parseFloat(r.querySelector('.in-pat-jang').value) || 0;
      if (q > 0) { patterns.push({ pattern: nm || '-', jang: q }); jang += q; }
    });
  } else {
    jang = parseFloat(el('in-simple-qty') && el('in-simple-qty').value) || 0;   // 세면대·무늬목·기타: 롯트·패턴 없이 수량만
  }
  if (jang <= 0) { toast('입고 수량을 입력하세요'); return; }
  const hebe = ceramic ? +(jang * (+it.hebePerJang || 0)).toFixed(2) : 0;
  let vendor = el('in-vendor').value; if (vendor === '__add') vendor = ''; vendor = (vendor || '다우세라믹앤석재').trim();
  const date = el('in-date').value, note = el('in-note').value.trim();
  const depot = (el('in-depot') && el('in-depot').value || '').trim() || it.depot || '본사';
  const newJang = (+it.jang || 0) + jang;
  await Store.update('inventory', it.id, { jang: newJang, lastInDate: date });
  await Store.add('transactions', { type: 'in', itemId: it.id, itemName: it.name, spec: it.spec, lot, patterns, jang, hebe, vendor, date, note, depot, by: me.name });
  await clearRestocksOnIn(it.name);
  const conv = await activatePlannedHolds(it.name, newJang);
  const u = itemUnit(itemCat(it));
  toast(`입고 완료 · ${jang}${u}` + (ceramic ? ` (${hebe}㎡)` : '') + (conv ? ` · 예정홀딩 ${conv}건 활성화` : '')); closeModal();
}

/* ===================================================================
   예정 입고(재입고 예정) — 발주 등록 · 실제 입고 시 자동 완료
   =================================================================== */
/* 활성 예정입고 전체 (예정일 빠른 순) */
function activeRestocks() {
  return (state.restocks || []).filter(r => !r.done)
    .sort((a, b) => (a.expectedDate || '9999-99-99').localeCompare(b.expectedDate || '9999-99-99'));
}
let _rsN = 0;
function rsRowHtml(d) {
  d = d || {}; const i = _rsN++;
  return `<div class="rs-row" style="display:flex;gap:8px;margin-bottom:8px;align-items:center">
    <div style="flex:2.2;min-width:0">${searchBox('rsm-' + i, '자재명 검색·입력', d.name || '', 'matNames', '')}</div>
    <input class="rs-qty" inputmode="numeric" placeholder="수량" value="${esc(d.qty || '')}" style="flex:1;min-width:56px;font-size:15px;padding:10px 11px;border:1.5px solid var(--bd2);border-radius:10px">
    <button type="button" class="btn btn-ghost btn-sm" style="flex:none" onclick="this.closest('.rs-row').remove()" aria-label="삭제"><i class="ti ti-x"></i></button>
  </div>`;
}
function addRsRow(d) { const c = el('rs-rows'); if (c) c.insertAdjacentHTML('beforeend', rsRowHtml(d)); }
function collectRsRows() {
  const rows = [];
  document.querySelectorAll('#rs-rows .rs-row').forEach(r => {
    const inp = r.querySelector('input.sb-in'); const name = inp ? (inp.value || '').trim() : '';
    const qty = parseFloat(r.querySelector('.rs-qty').value) || 0;
    if (name) rows.push({ name: name, qty: qty });
  });
  return rows;
}
function openRestockForm(id) {
  const r = id ? (state.restocks || []).find(x => x.id === id) : null; const v = r || {};
  _rsN = 0;
  const rowsInit = r ? [{ name: v.itemName, qty: v.jang || '' }] : [{}];
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-truck-delivery"></i>${r ? '예정 입고 수정' : '예정 입고 등록'}</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="banner info"><i class="ti ti-info-circle"></i><span>발주한 자재의 <b>입고 예정</b>을 등록합니다. 고객 재고 화면의 <b>품절</b> 자재에 예정일이 표시되고, 실제 입고를 등록하면 자동으로 정리됩니다.</span></div>
    <div class="frm">
      <div class="fld full"><label>자재 · 수량<span class="req">*</span> <span style="color:var(--t3);font-weight:500">(여러 개는 '자재 추가')</span></label>
        <div id="rs-rows">${rowsInit.map(rsRowHtml).join('')}</div>
        ${!r ? `<button type="button" class="btn btn-ghost btn-sm btn-block" onclick="addRsRow({})"><i class="ti ti-plus"></i>자재 추가</button>` : ''}
      </div>
      <div class="fld"><label>입고 예정일<span class="req">*</span></label><input type="date" id="rs-date" value="${esc(v.expectedDate || '')}"></div>
      <div class="fld full"><label>메모</label><input id="rs-note" lang="ko" value="${esc(v.note || '')}" placeholder="선택 (공통 적용)"></div>
    </div>
    <div class="frm-foot">
      <button class="btn" style="flex:1" onclick="closeModal()">취소</button>
      <button class="btn btn-pri" style="flex:2" onclick="submitRestock('${id || ''}')"><i class="ti ti-check"></i>${r ? '저장' : '등록'}</button>
    </div>`);
}
async function submitRestock(id) {
  const date = el('rs-date') && el('rs-date').value;
  if (!date) { toast('입고 예정일을 선택하세요'); return; }
  const note = (el('rs-note') && el('rs-note').value || '').trim();
  const rows = collectRsRows();
  if (!rows.length) { toast('자재명을 입력하세요'); return; }
  if (id) {   // 수정: 단일 건
    const row = rows[0];
    const it = state.inventory.find(i => _normName(i.name) === _normName(row.name));
    await Store.update('restocks', id, { itemName: row.name, spec: it ? it.spec : '', jang: row.qty || 0, expectedDate: date, note: note, done: false });
    await syncItemRestock(row.name);
    toast('예정 입고 수정됨'); closeModal(); return;
  }
  const names = new Set();
  for (const row of rows) {
    const it = state.inventory.find(i => _normName(i.name) === _normName(row.name));
    await Store.add('restocks', { itemName: row.name, spec: it ? it.spec : '', jang: row.qty || 0, expectedDate: date, note: note, done: false, createdAt: Date.now(), by: me.name });
    names.add(row.name);
  }
  for (const n of names) await syncItemRestock(n);
  toast(`예정 입고 ${rows.length}건 등록됨`); closeModal();
}
async function delRestock(id) {
  const r = (state.restocks || []).find(x => x.id === id);
  if (!confirm('이 예정 입고를 삭제할까요?')) return;
  await Store.remove('restocks', id);
  if (r) await syncItemRestock(r.itemName);
  toast('삭제됨');
}
/* 재고 화면용 예정 입고 목록 카드 */
function restockCardHtml() {
  const list = activeRestocks();
  const rows = list.length ? list.map(r => {
    const d = daysFromNow(r.expectedDate);
    const dtag = d != null ? (d < 0 ? '<span style="color:var(--red-t)">지남</span>' : (d === 0 ? '<span style="color:var(--amber-t)">오늘</span>' : `D-${d}`)) : '';
    return `<div class="alert-i b" style="background:var(--amber-l,#fef6e7);border-color:#f5d99b">
      <div class="ai" style="color:var(--amber-t)"><i class="ti ti-truck-delivery"></i></div>
      <div class="at"><b style="word-break:keep-all">${esc(r.itemName)}${r.jang ? ` · ${+r.jang || 0}장` : ''}</b><span>입고 예정 ${esc(r.expectedDate || '-')} ${dtag}${r.vendor ? ` · ${esc(r.vendor)}` : ''}</span></div>
      <div style="display:flex;gap:2px;flex:none">
        <button class="x" onclick="openRestockForm('${r.id}')" aria-label="수정"><i class="ti ti-edit" style="font-size:16px;color:var(--t3)"></i></button>
        <button class="x" onclick="delRestock('${r.id}')" aria-label="삭제"><i class="ti ti-trash" style="font-size:16px;color:var(--red-t)"></i></button>
      </div></div>`;
  }).join('') : `<div class="empty"><i class="ti ti-calendar-off"></i>예정된 입고가 없습니다</div>`;
  return `<div class="card" style="margin-top:14px">
    <div class="card-h"><h3><i class="ti ti-truck-delivery"></i>예정 입고 (재입고 예정)${list.length ? ` <span style="font-size:12px;font-weight:500;color:var(--t3)">${list.length}건</span>` : ''}</h3><button class="btn btn-sm" onclick="openRestockForm()"><i class="ti ti-plus"></i>예정 등록</button></div>
    <div id="restock-scroll" data-keepscroll style="max-height:300px;overflow-y:auto;-webkit-overflow-scrolling:touch">${rows}</div></div>`;
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
  // 각 품목의 과거 패턴(좌상/우상 등)을 미리 채워 고정 — 패턴이 여러 개면 행을 나눠 넣음
  const rows = [];
  items.forEach(i => {
    const pats = patternList(i.name);
    if (pats.length) pats.forEach(p => rows.push([i.name || '', i.spec || '', p.pattern, '', '', todayStr(), i.vendor || '다우세라믹앤석재', '']));
    else rows.push([i.name || '', i.spec || '', '', '', '', todayStr(), i.vendor || '다우세라믹앤석재', '']);
  });
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
    for (const nm in affected) { await clearRestocksOnIn(nm); convN += await activatePlannedHolds(nm, affected[nm]); }
    const newCnt = Object.keys(newByName).length, inCnt = ok.filter(r => r.jang > 0).length;
    toast(`완료 · 신규품목 ${newCnt}종 · 입고 ${inCnt}건` + (convN ? ` · 예정홀딩 ${convN}건 활성화` : '')); closeModal();
  } finally { _busy = false; }
}

/* ===================================================================
   출고 (현장/공장·거래처) + 월별/분석
   =================================================================== */
/* 출고 건을 shipId 기준으로 묶은 목록 (최신순) */
/* 출고 정렬용 타임스탬프: 등록시각(createdAt) → shipId 내장 시각(S+ms) → 날짜 순 */
function outTs(t) {
  if (t.createdAt) return +t.createdAt;
  if (t.shipId && /^S\d{10,}$/.test(t.shipId)) return +t.shipId.slice(1);
  return t.date ? new Date(t.date + 'T00:00').getTime() : 0;
}
function shipSlipGroups() {
  const outs = state.transactions.filter(t => t.type === 'out');
  const gmap = {}, groups = [];
  outs.forEach(t => { const k = t.shipId || t.id; if (!gmap[k]) { gmap[k] = { key: k, date: t.date, dest: t.dest || t.factory, targetName: t.targetName, by: t.by, items: [], ts: outTs(t) }; groups.push(gmap[k]); } gmap[k].items.push(t); gmap[k].ts = Math.max(gmap[k].ts, outTs(t)); });
  groups.sort((a, b) => b.ts - a.ts);   // 최근 출고가 맨 위로
  return groups;
}
/* 출고증 인쇄 목록: 검색 없으면 최근 10건, 검색하면 업체명·자재명으로 전체에서 찾기 */
function shipSlipListHtml() {
  const q = (filters.slipSearch || '').trim().toLowerCase();
  let groups = shipSlipGroups();
  if (q) groups = groups.filter(g => (g.targetName || '').toLowerCase().includes(q) || (g.dest || '').toLowerCase().includes(q) || g.items.some(t => (t.itemName || '').toLowerCase().includes(q)));
  const list = q ? groups : groups.slice(0, 10);
  if (!list.length) return `<div class="empty"><i class="ti ti-inbox"></i>${q ? '검색 결과가 없습니다' : '출고 내역 없음'}</div>`;
  return list.map(g => {
    const totJang = g.items.reduce((a, b) => a + (+b.jang || 0), 0), totHebe = g.items.reduce((a, b) => a + (+b.hebe || 0), 0);
    return `<div class="card" style="margin-bottom:10px;padding:11px 13px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div><div style="font-weight:700;font-size:14px"><i class="ti ti-briefcase" style="color:var(--blue);font-size:14px"></i> ${esc(g.targetName || '-')}${(() => { const sc = shipConfirm('out', g.key); return sc && sc.confirmed ? ` <span class="pill" style="background:#e8f7f0;color:#0F6E56;font-size:10px"><i class="ti ti-checks"></i> 확인</span>` : ''; })()}</div>
          <div style="font-size:12px;color:var(--t3);margin-top:2px">${esc(g.date)}${g.dest ? ' · → ' + esc(g.dest) : ''} · ${esc(g.by || '')}</div></div>
        ${isAdmin() ? `<button class="x" onclick="delShipGroup('${g.key}')" aria-label="삭제"><i class="ti ti-trash" style="font-size:16px;color:var(--red-t)"></i></button>` : ''}
      </div>
      <div style="margin-top:7px;font-size:13px">${g.items.map(t => `<div style="color:var(--t2)">· ${esc(t.itemName)} <b style="color:var(--t1)">${+t.jang || 0}장</b>${t.hebe ? ` (${(+t.hebe).toFixed(1)}㎡)` : ''}${t.lot ? ` · 롯트 ${esc(t.lot)}` : ''}${t.pattern ? ` · 패턴 ${esc(t.pattern)}` : ''}</div>`).join('')}</div>
      ${g.items.length > 1 ? `<div style="font-size:11.5px;color:var(--t3);margin-top:6px;text-align:right">합계 ${totJang}장 · ${totHebe.toFixed(1)}㎡</div>` : ''}
      <div style="margin-top:9px;display:flex;gap:6px;justify-content:flex-end"><button class="btn btn-ghost btn-sm" onclick="sendToChulgo('out','${g.key}')" title="출고관리 앱으로 전송">${g.items.some(t => t.sentChulgo) ? '<i class="ti ti-checks" style="color:var(--gd)"></i>출고관리 전송됨' : '<i class="ti ti-send"></i>출고관리 전송'}</button><button class="btn btn-sm" onclick="printShipSlip('${g.key}')"><i class="ti ti-printer"></i>출고증 인쇄</button></div>
    </div>`;
  }).join('');
}
/* 검색어 입력 시 목록만 교체 (한글 입력 끊김 방지) */
function filterShipSlips() {
  filters.slipSearch = el('slip-search') ? el('slip-search').value : '';
  if (el('slip-list')) el('slip-list').innerHTML = shipSlipListHtml();
  const x = el('slip-search-x'); if (x) x.style.display = (filters.slipSearch || '').trim() ? '' : 'none';
}
function renderShip() {
  const _shipSY = window.scrollY, _shipTW = el('r-wrap') ? el('r-wrap').scrollTop : 0;   // 재렌더 후 스크롤 위치 유지
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
  const byClient = {}; outs.forEach(t => { const k = t.targetName || '-'; byClient[k] = (byClient[k] || 0) + (+t.hebe || 0); });
  const topC = Object.entries(byClient).sort((a, b) => b[1] - a[1]).slice(0, 6); const maxC = Math.max(1, ...topC.map(t => t[1]));
  const outClients = [...new Set(outs.map(t => t.targetName).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const outMats = [...new Set(outs.map(t => t.itemName).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const shipTab = filters.shipTab || 'slip';   // slip=출고증 / list=내역조회 / stats=월별·분석
  const shd = t => shipTab === t ? '' : 'display:none';   // 탭별 표시/숨김

  el('pg-ship').innerHTML = `
    <div class="ph"><div><h2><i class="ti ti-truck-delivery"></i>출고 현황</h2><p>현장·공장·거래처 출고 + 월별 분석</p></div>
      <button class="btn btn-pri btn-sm" onclick="openShipForm()"><i class="ti ti-plus"></i>출고 등록</button></div>
    <div class="stat-grid" style="grid-template-columns:repeat(2,1fr)">
      <div class="stat"><div class="ic b"><i class="ti ti-calendar-stats"></i></div><div class="v">${monthHebe.toFixed(0)}<span style="font-size:14px">㎡</span></div><div class="l">이번 달 출고</div><div class="s">${monthOut.length}건</div></div>
      <div class="stat"><div class="ic g"><i class="ti ti-package-export"></i></div><div class="v">${outs.length}</div><div class="l">총 출고 건수</div><div class="s">전체 누적</div></div>
    </div>
    <div class="seg" id="ship-seg" style="margin:2px 0 12px">
      <button type="button" data-t="slip" class="${shipTab === 'slip' ? 'on' : ''}" onclick="goShipTab('slip')"><i class="ti ti-printer" style="font-size:14px"></i> 출고증</button>
      <button type="button" data-t="list" class="${shipTab === 'list' ? 'on' : ''}" onclick="goShipTab('list')"><i class="ti ti-table" style="font-size:14px"></i> 내역 조회</button>
      <button type="button" data-t="stats" class="${shipTab === 'stats' ? 'on' : ''}" onclick="goShipTab('stats')"><i class="ti ti-chart-bar" style="font-size:14px"></i> 월별·분석</button>
    </div>
    <div class="card ship-sec" data-tab="slip" style="${shd('slip')}">
      <div class="card-h"><h3><i class="ti ti-printer"></i>출고증 인쇄</h3></div>
      <div class="search-box" style="margin-bottom:10px">
        <i class="ti ti-search"></i>
        <input id="slip-search" placeholder="업체명·자재명 검색" value="${esc(filters.slipSearch || '')}" oninput="filterShipSlips()" autocomplete="off" lang="ko">
        <button class="search-x" id="slip-search-x" style="${(filters.slipSearch || '').trim() ? '' : 'display:none'}" onclick="el('slip-search').value='';filterShipSlips()"><i class="ti ti-x"></i></button>
      </div>
      <div id="slip-list">${shipSlipListHtml()}</div>
    </div>
    <div class="card ship-sec" data-tab="list" style="${shd('list')}">
      <div class="card-h"><h3><i class="ti ti-table"></i>출고 내역 조회·추출</h3></div>
      <div class="search-box" style="margin-bottom:10px">
        <i class="ti ti-search"></i>
        <input id="r-search" placeholder="자재명·업체명 검색" value="${esc(filters.shipSearch || '')}" oninput="filters.shipSearch=this.value;shipReport()" autocomplete="off">
        ${(filters.shipSearch || '').trim() ? `<button class="search-x" onclick="filters.shipSearch='';el('r-search').value='';shipReport()"><i class="ti ti-x"></i></button>` : ''}
      </div>
      <div class="frm">
        <div class="fld"><label>시작일</label><input type="date" id="r-from" oninput="shipReport()"></div>
        <div class="fld"><label>종료일</label><input type="date" id="r-to" oninput="shipReport()"></div>
        <div class="fld"><label>거래처</label><select id="r-client" onchange="shipReport()"><option value="">전체</option>${outClients.map(c => `<option>${esc(c)}</option>`).join('')}</select></div>
        <div class="fld"><label>자재</label><select id="r-mat" onchange="shipReport()"><option value="">전체</option>${outMats.map(c => `<option>${esc(c)}</option>`).join('')}</select></div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin:4px 0 8px;gap:8px;flex-wrap:wrap">
        <div style="font-size:13px;color:var(--t2)" id="r-sum">전체 기간</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">${isAdmin() ? `<button class="btn btn-sm" onclick="autoLinkSoleLots()"><i class="ti ti-link"></i>미지정 롯트 자동연결</button>` : ''}<button class="btn btn-sm btn-pri" onclick="downloadShipXls()"><i class="ti ti-file-spreadsheet"></i>엑셀 다운로드</button></div>
      </div>
      <div class="tbl-wrap" id="r-wrap" data-keepscroll style="max-height:340px;overflow:auto">
        <table class="tbl"><thead><tr><th>날짜</th><th>거래처</th><th>자재</th><th>장수</th><th>헤베</th><th>출고지</th></tr></thead><tbody id="r-body"></tbody></table>
      </div>
    </div>
    <div class="card ship-sec" data-tab="stats" style="${shd('stats')}">
      <div class="card-h"><h3><i class="ti ti-chart-bar"></i>월별 출고 현황</h3><span class="more">${year}년</span></div>
      <div class="mchart">${monthly.map((v, i) => `<div class="mcol"><div class="val">${v ? v.toFixed(0) : ''}</div><div class="bb ${i === now.getMonth() ? 'cur' : ''}" style="height:${Math.max(2, v / maxM * 100)}%"></div><div class="lb">${i + 1}월</div></div>`).join('')}</div>
    </div>
    <div class="card ship-sec" data-tab="stats" style="${shd('stats')}">
      <div class="card-h"><h3><i class="ti ti-trophy"></i>출고 상위 제품</h3>${top.length ? `<span class="more tap" onclick="openTopProducts()" style="cursor:pointer">더보기 <i class="ti ti-chevron-right"></i></span>` : ''}</div>
      ${top.length ? top.map(([nm, v], i) => `<div class="abar"><span class="rk">${i + 1}</span><span class="nm">${esc(nm)}</span><span class="tr"><i style="width:${v / maxT * 100}%"></i></span><span class="vv">${v.toFixed(0)}㎡</span></div>`).join('') : `<div class="empty"><i class="ti ti-chart-dots"></i>출고 데이터가 쌓이면 표시됩니다</div>`}
    </div>
    ${isAdmin() ? `<div class="card ship-sec" data-tab="stats" style="${shd('stats')}">
      <div class="card-h"><h3><i class="ti ti-building-store"></i>거래량 많은 업체 <span style="font-size:11px;font-weight:500;color:var(--t3)">(관리자)</span></h3>${topC.length ? `<span class="more tap" onclick="openTopClients()" style="cursor:pointer">더보기 <i class="ti ti-chevron-right"></i></span>` : ''}</div>
      ${topC.length ? topC.map(([nm, v], i) => `<div class="abar"><span class="rk">${i + 1}</span><span class="nm">${esc(nm)}</span><span class="tr"><i style="width:${v / maxC * 100}%"></i></span><span class="vv">${v.toFixed(0)}㎡</span></div>`).join('') : `<div class="empty"><i class="ti ti-chart-dots"></i>출고 데이터가 쌓이면 표시됩니다</div>`}
    </div>` : ''}
    `;
  shipReport();
  requestAnimationFrame(() => { window.scrollTo(0, _shipSY); if (el('r-wrap')) el('r-wrap').scrollTop = _shipTW; });   // 저장 후 자리 유지
}
/* 출고 상위 제품 집계 (규격·건수·장수·헤베) — 헤베 기준 정렬 */
function shipTopProducts() {
  const m = {};
  state.transactions.filter(t => t.type === 'out').forEach(t => {
    const k = t.itemName || '-';
    if (!m[k]) m[k] = { name: k, spec: t.spec || '', jang: 0, hebe: 0, cnt: 0 };
    m[k].jang += (+t.jang || 0); m[k].hebe += (+t.hebe || 0); m[k].cnt++;
    if (!m[k].spec && t.spec) m[k].spec = t.spec;
  });
  Object.values(m).forEach(x => { if (!x.spec) { const it = state.inventory.find(i => _normName(i.name) === _normName(x.name)); if (it) x.spec = it.spec || ''; } });
  return Object.values(m).sort((a, b) => b.hebe - a.hebe);
}
/* 출고 상위 업체 집계 (건수·장수·헤베) — 헤베 기준 정렬 */
function shipTopClients() {
  const m = {};
  state.transactions.filter(t => t.type === 'out').forEach(t => {
    const k = t.targetName || '-';
    if (!m[k]) m[k] = { name: k, jang: 0, hebe: 0, cnt: 0 };
    m[k].jang += (+t.jang || 0); m[k].hebe += (+t.hebe || 0); m[k].cnt++;
  });
  return Object.values(m).sort((a, b) => b.hebe - a.hebe);
}
function openTopProducts() {
  const list = shipTopProducts();
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-trophy"></i>출고 상위 제품 전체</h3><button class="x" onclick="closeModal()">×</button></div>
    <div style="font-size:12px;color:var(--t3);margin-bottom:8px">전체 기간 · 총 ${list.length}개 품목 · 헤베 기준 정렬</div>
    <div class="tbl-wrap" style="max-height:62vh;overflow:auto"><table class="tbl"><thead><tr><th>#</th><th>자재</th><th>규격</th><th>건수</th><th>장수</th><th>헤베</th></tr></thead><tbody>
    ${list.length ? list.map((x, i) => `<tr><td>${i + 1}</td><td><b>${esc(x.name)}</b></td><td style="font-size:11px;color:var(--t3);white-space:nowrap">${esc(x.spec || '-')}</td><td>${x.cnt}</td><td>${x.jang}장</td><td><b style="color:var(--gd)">${x.hebe.toFixed(1)}㎡</b></td></tr>`).join('') : `<tr><td colspan="6"><div class="empty" style="padding:16px">출고 내역이 없습니다</div></td></tr>`}
    </tbody></table></div>
    <div class="frm-foot"><button class="btn btn-pri" style="flex:1" onclick="closeModal()">닫기</button></div>`);
}
function openTopClients() {
  if (!isAdmin()) { toast('관리자만 볼 수 있습니다'); return; }
  const list = shipTopClients();
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-building-store"></i>거래량 많은 업체 순위</h3><button class="x" onclick="closeModal()">×</button></div>
    <div style="font-size:12px;color:var(--t3);margin-bottom:8px">전체 기간 · 총 ${list.length}개 업체 · 헤베 기준 정렬</div>
    <div class="tbl-wrap" style="max-height:62vh;overflow:auto"><table class="tbl"><thead><tr><th>#</th><th>거래처</th><th>건수</th><th>장수</th><th>헤베</th></tr></thead><tbody>
    ${list.length ? list.map((x, i) => `<tr><td>${i + 1}</td><td><b>${esc(x.name)}</b></td><td>${x.cnt}</td><td>${x.jang}장</td><td><b style="color:var(--gd)">${x.hebe.toFixed(1)}㎡</b></td></tr>`).join('') : `<tr><td colspan="5"><div class="empty" style="padding:16px">출고 내역이 없습니다</div></td></tr>`}
    </tbody></table></div>
    <div class="frm-foot"><button class="btn btn-pri" style="flex:1" onclick="closeModal()">닫기</button></div>`);
}
/* 출고 화면 탭 전환 — 재렌더 없이 섹션만 표시/숨김 (검색·필터·스크롤 유지) */
function goShipTab(v) {
  filters.shipTab = v;
  document.querySelectorAll('#pg-ship .ship-sec').forEach(s => { s.style.display = (s.dataset.tab === v) ? '' : 'none'; });
  document.querySelectorAll('#ship-seg button').forEach(b => b.classList.toggle('on', b.dataset.t === v));
  const pg = el('pg-ship'); if (pg) pg.scrollIntoView({ block: 'start' }); else window.scrollTo(0, 0);
}
/* 자재의 롯트가 (입고 기준) 딱 하나면 그 롯트 반환 */
function theOnlyLot(name) {
  const lots = [...new Set(state.transactions.filter(x => _normName(x.itemName) === _normName(name) && x.type === 'in').map(x => (x.lot || '').trim()).filter(l => l && l !== '(미지정)'))];
  return lots.length === 1 ? lots[0] : '';
}
/* 기출고 중 롯트 미지정건 — 자재에 롯트가 하나뿐이면 자동 연결 */
async function autoLinkSoleLots() {
  if (!isAdmin()) { toast('관리자만 가능합니다'); return; }
  const targets = state.transactions.filter(t => t.type === 'out' && !((t.lot || '').trim()));
  const doable = targets.filter(t => theOnlyLot(t.itemName));
  if (!doable.length) { toast('자동연결할 미지정 출고가 없습니다 (롯트가 하나뿐인 자재만 대상)'); return; }
  if (!confirm(`롯트 미지정 출고 ${doable.length}건을, 해당 자재의 단일 롯트로 자동 연결할까요?`)) return;
  let n = 0;
  for (const t of doable) { const l = theOnlyLot(t.itemName); if (l) { try { await Store.update('transactions', t.id, { lot: l }); n++; } catch (e) { } } }
  toast(`${n}건 롯트 자동연결 완료`);
}
/* 출고 내역 조회·추출 (거래처/자재/기간별) */
function shipReportList() {
  const from = el('r-from') && el('r-from').value, to = el('r-to') && el('r-to').value;
  const cl = el('r-client') && el('r-client').value, mt = el('r-mat') && el('r-mat').value;
  const q = (filters.shipSearch || '').trim().toLowerCase();
  return state.transactions.filter(t => t.type === 'out')
    .filter(t => (!from || (t.date || '') >= from) && (!to || (t.date || '') <= to) && (!cl || t.targetName === cl) && (!mt || t.itemName === mt)
      && (!q || (t.itemName || '').toLowerCase().includes(q) || (t.targetName || '').toLowerCase().includes(q)))
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (outTs(b) - outTs(a)));
}
function shipReport() {
  const list = shipReportList();
  const tj = list.reduce((a, b) => a + (+b.jang || 0), 0), th = list.reduce((a, b) => a + (+b.hebe || 0), 0);
  if (el('r-body')) el('r-body').innerHTML = list.length ? list.map(t => `<tr style="cursor:pointer" onclick="openOutEdit('${t.id}')" title="탭하면 롯트·패턴·장수 수정"><td>${esc(t.date || '')}</td><td><b>${esc(t.targetName || '')}</b></td><td>${esc(t.itemName || '')}${t.lot || t.pattern ? `<div style="font-size:10.5px;color:var(--t3)">${[t.lot ? '롯트 ' + esc(t.lot) : '', t.pattern ? '패턴 ' + esc(t.pattern) : ''].filter(Boolean).join(' · ')}</div>` : ''}</td><td>${+t.jang || 0}장</td><td>${(+t.hebe || 0).toFixed(1)}㎡</td><td>${esc(t.dest || t.factory || '')}</td></tr>`).join('') : `<tr><td colspan="6"><div class="empty" style="padding:18px"><i class="ti ti-search-off"></i>해당 출고 내역이 없습니다</div></td></tr>`;
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
/* 시공 통계 엑셀 — 시공팀별/업체별 현장 수 + 비율 + 현장 많은 업체 순위 */
function downloadSiteStatsXls() {
  const sites = state.sites || [];
  const total = sites.length;
  if (!total) { toast('현장 데이터가 없습니다'); return; }
  const group = (keyFn) => { const m = {}; sites.forEach(s => { const k = (keyFn(s) || '').trim() || '(미지정)'; m[k] = (m[k] || 0) + 1; }); return Object.entries(m).sort((a, b) => b[1] - a[1]); };
  const teamRows = group(s => s.team);
  const clientRows = group(s => s.client);
  const pct = n => (n / total * 100).toFixed(1) + '%';
  const TH = (t, w) => `<th style="background:#0F6E56;color:#ffffff;font-weight:bold;border:0.5pt solid #0a4f3e;padding:7px 10px;text-align:center"${w ? ' width="' + w + '"' : ''}>${t}</th>`;
  const TD = (t, st) => `<td style="border:0.5pt solid #cfd8d4;padding:5px 10px;${st || ''}">${t}</td>`;
  const sumStyle = 'border:0.5pt solid #cfd8d4;background:#e1f5ee;color:#0a4f3e;font-weight:bold;padding:7px 10px';
  const section = (title, rows, label) => {
    const body = rows.map(([nm, n], i) => { const bg = i % 2 ? 'background:#f3f6f4;' : ''; return `<tr>${TD(i + 1, bg + 'text-align:center')}${TD('<b>' + esc(nm) + '</b>', bg)}${TD(n, bg + 'text-align:right')}${TD(pct(n), bg + 'text-align:right')}</tr>`; }).join('');
    return `<tr><td colspan="4" style="font-size:12pt;font-weight:bold;color:#0F6E56;padding:12px 4px 4px">${title}</td></tr>
      <tr>${TH('순위', 50)}${TH(label, 200)}${TH('현장 수', 80)}${TH('비율', 80)}</tr>
      ${body}
      <tr><td colspan="2" style="${sumStyle};text-align:right">합계</td>${TD(total, sumStyle + ';text-align:right')}${TD('100%', sumStyle + ';text-align:right')}</tr>`;
  };
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"></head><body>
<table style="border-collapse:collapse;font-family:'맑은 고딕','Malgun Gothic',sans-serif;font-size:10.5pt">
<tr><td colspan="4" style="font-size:16pt;font-weight:bold;color:#0F6E56;padding:8px 4px 2px">다우세라믹앤석재 · 시공 통계</td></tr>
<tr><td colspan="4" style="font-size:9pt;color:#777;padding:0 4px 6px">생성일 ${todayStr()}  ·  전체 현장 ${total}건</td></tr>
${section('■ 시공팀별 현장 수', teamRows, '시공팀')}
<tr><td colspan="4" style="padding:6px"></td></tr>
${section('■ 업체별 현장 수 (현장 많은 업체 순)', clientRows, '업체')}
</table></body></html>`;
  const blob = new Blob(['﻿' + html], { type: 'application/vnd.ms-excel;charset=utf-8;' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = '시공통계_' + todayStr() + '.xls'; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
  toast('시공 통계 엑셀 다운로드');
}
/* 출고 내역 수정 — 롯트·패턴 재배정(재고 자동 재계산) + 장수 보정 */
function openOutEdit(id) {
  const t = state.transactions.find(x => x.id === id && x.type === 'out'); if (!t) return;
  const mine = state.transactions.filter(x => _normName(x.itemName) === _normName(t.itemName));
  const lotOpts = [...new Set(mine.map(x => (x.lot || '').trim()).filter(l => l && l !== '(미지정)'))].sort();
  const patOpts = [...new Set(mine.flatMap(x => x.type === 'in' ? (x.patterns || []).map(p => (p.pattern || '').trim()) : [(x.pattern || '').trim()]).filter(p => p && p !== '-'))].sort();
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-edit"></i>출고 내역 수정</h3><button class="x" onclick="closeModal()">×</button></div>
    <div style="font-size:13px;color:var(--t2);margin-bottom:12px"><b style="color:var(--t1)">${esc(t.itemName || '')}</b>${t.spec ? ' · ' + esc(t.spec) : ''}</div>
    <div class="frm">
      <div class="fld"><label>출고일</label><input type="date" id="oe-date" value="${esc(t.date || '')}"></div>
      <div class="fld"><label>장수</label><input id="oe-jang" inputmode="numeric" value="${esc(t.jang || 0)}"></div>
      <div class="fld full"><label>롯트 넘버 <span style="color:var(--t3);font-weight:500">(실제 출고된 롯트로 지정 · 미지정 해소)</span></label><input id="oe-lot" list="oe-lot-list" value="${esc(t.lot || '')}" placeholder="롯트 넘버 입력/선택"><datalist id="oe-lot-list">${lotOpts.map(l => `<option value="${esc(l)}">`).join('')}</datalist></div>
      <div class="fld full"><label>패턴 <span style="color:var(--t3);font-weight:500">(실제 출고된 패턴으로 지정)</span></label><input id="oe-pat" list="oe-pat-list" lang="ko" value="${esc(t.pattern || '')}" placeholder="패턴 입력/선택"><datalist id="oe-pat-list">${patOpts.map(p => `<option value="${esc(p)}">`).join('')}</datalist></div>
      <div class="fld"><label>거래처</label><input id="oe-target" lang="ko" value="${esc(t.targetName || '')}"></div>
      <div class="fld"><label>출고지</label><input id="oe-dest" lang="ko" value="${esc(t.dest || t.factory || '')}"></div>
      <div class="fld full"><label>메모</label><input id="oe-note" lang="ko" value="${esc(t.note || '')}"></div>
      <div class="fld full" style="background:#fff2f0;border-radius:9px;padding:10px 12px"><label style="display:flex;align-items:center;gap:9px;cursor:pointer;font-weight:600;color:#b42318"><input type="checkbox" id="oe-damaged" ${((t.damaged === true) || (t.damaged === undefined && /파손/.test(t.note || ''))) ? 'checked' : ''} style="width:18px;height:18px"> <i class="ti ti-alert-square-rounded"></i>파손 자재 출고 <span style="font-weight:400;color:var(--t3);font-size:12px">(체크 시 파손 재고에서 차감)</span></label></div>
      <div class="fld full" style="font-size:11.5px;color:var(--t3);background:var(--soft);border-radius:9px;padding:9px 11px;line-height:1.5"><i class="ti ti-info-circle"></i> 롯트·패턴을 바꾸면 롯트별/패턴별 재고가 자동으로 다시 계산됩니다. 장수를 바꾸면 실재고도 함께 보정됩니다.</div>
    </div>
    <div class="frm-foot">${isAdmin() ? `<button class="btn" style="color:var(--red-t);border-color:#e6a9a9" onclick="delShip('${t.id}');closeModal()"><i class="ti ti-trash"></i></button>` : ''}<button class="btn" style="flex:1" onclick="closeModal()">취소</button><button class="btn btn-pri" style="flex:2" onclick="submitOutEdit('${t.id}')"><i class="ti ti-check"></i>저장</button></div>`);
}
async function submitOutEdit(id) {
  const t = state.transactions.find(x => x.id === id && x.type === 'out'); if (!t) return;
  const oldJang = +t.jang || 0;
  const newJang = Math.max(0, parseFloat(el('oe-jang').value) || 0);
  const it = state.inventory.find(i => i.id === t.itemId || i.name === t.itemName);
  const per = it ? (+it.hebePerJang || 0) : 0;
  const patch = {
    jang: newJang,
    lot: (el('oe-lot').value || '').trim(),
    pattern: (el('oe-pat').value || '').trim(),
    hebe: +(newJang * per).toFixed(2),
    date: el('oe-date').value || t.date || '',
    targetName: (el('oe-target').value || '').trim(),
    dest: (el('oe-dest').value || '').trim(),
    note: (el('oe-note').value || '').trim(),
    damaged: !!(el('oe-damaged') && el('oe-damaged').checked)   // 파손 자재 출고 지정(체크 해제 시 파손 차감 취소)
  };
  patch.factory = patch.dest;
  await Store.update('transactions', id, patch);
  // 장수 변경 시 실재고 보정: 출고 줄이면 +재고, 늘리면 -재고
  if (it && newJang !== oldJang) {
    await Store.update('inventory', it.id, { jang: Math.max(0, (+it.jang || 0) + (oldJang - newJang)) });
  }
  closeModal(); toast('출고 내역이 수정되었습니다');
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
  const route = (g.dest || '') ? '다우세라믹 상차 →<br>' + e(g.dest) + ' 하차' : '';
  // 출고 확인 도장 (가운데에 출고일자)
  const stamp = `<svg viewBox="0 0 200 200" width="150" height="150" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
    <defs><path id="arcTop" d="M 30,100 A 70,70 0 0 1 170,100"/></defs>
    <circle cx="100" cy="100" r="94" fill="none" stroke="#111" stroke-width="4"/>
    <text font-size="15" font-weight="700" fill="#111" letter-spacing="1"><textPath xlink:href="#arcTop" href="#arcTop" startOffset="50%" text-anchor="middle">주식회사 다우세라믹앤석재</textPath></text>
    <text x="100" y="68" text-anchor="middle" font-size="30" font-weight="800" fill="#111">출고</text>
    <line x1="32" y1="84" x2="168" y2="84" stroke="#111" stroke-width="3"/>
    <text x="100" y="110" text-anchor="middle" font-size="17" font-weight="700" fill="#111">${e(g.date)}</text>
    <line x1="32" y1="122" x2="168" y2="122" stroke="#111" stroke-width="3"/>
    <text x="100" y="152" text-anchor="middle" font-size="30" font-weight="800" fill="#111">확인</text>
  </svg>`;
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
  .issue{text-align:center;font-size:13px}
  .issue .ik{letter-spacing:3px;font-weight:600}
  .issue .iv{font-size:14px;font-weight:600;margin-top:5px;white-space:nowrap}
  .conm{text-align:center;font-size:18px;font-weight:800}
  .recip{text-align:center;vertical-align:middle}
  .recip .rn{font-size:24px;font-weight:800}
  .recip .rt{font-size:15px;font-weight:600;margin-top:22px;word-break:keep-all;line-height:1.55}
  .ck{text-align:center;font-weight:700;background:#f4f4f4;white-space:nowrap}
  .cv{font-size:13.5px}
  .cv .tel{font-size:12px;color:#333}
  .web{text-align:center;font-weight:800;text-decoration:underline;letter-spacing:1px}
  .items{table-layout:fixed;margin-top:14px}
  .items th{border:1px solid #444;background:#eee;padding:8px 6px;font-size:13.5px;font-weight:700}
  .items td{border:1px solid #444;padding:7px 6px;font-size:13px;height:31px}
  .items td.c{text-align:center}.items td.r{text-align:right;padding-right:9px}.items td.l{text-align:left;padding-left:9px}
  .items tfoot td{font-weight:800;background:#faf7ee}
  .bottom{display:flex;align-items:center;justify-content:space-between;gap:18px;margin-top:12px}
  .who{table-layout:fixed;flex:1}
  .who td{border:1px solid #444;padding:10px 10px;font-size:13px}
  .who .wk{text-align:center;font-weight:700;background:#f4f4f4;width:16%}
  .stamp{flex:none;width:150px;height:150px}
  @media print{body{padding:8px 10px}}
</style></head><body>
  <table class="top">
    <colgroup><col style="width:27%"><col style="width:14%"><col style="width:59%"></colgroup>
    <tr>
      <td class="doc"><div class="dl">문 서 번 호</div><div class="dv">${docNo}</div></td>
      <td class="title" colspan="2">출 고 표</td>
    </tr>
    <tr>
      <td class="issue"><div class="ik">발 행 일 자</div><div class="iv">${e(g.date)}</div></td>
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
  <div class="bottom">
    <table class="who"><tr><td class="wk">담당자</td><td>${e(g.by)}</td></tr>${(g.note && g.note.trim()) ? `<tr><td class="wk">메모</td><td style="white-space:pre-wrap">${e(g.note)}</td></tr>` : ''}</table>
    <div class="stamp">${stamp}</div>
  </div>
</body></html>`;
  const w = window.open('', '_blank');
  if (!w) { toast('팝업이 차단되었습니다. 팝업 허용 후 다시 시도하세요'); return; }
  w.document.write(html); w.document.close(); w.focus();
  setTimeout(() => { try { w.print(); } catch (e) { } }, 350);
}

/* ================= 세면대(오더베이스) 발주 · 출고 라인 ================= */
const BASIN_STAGES = ['견적', '발주', '출항', '입항', '국내입고', '완료'];
const BASIN_STAGE_META = {
  '견적': { c: '#5b6472', bg: '#eef1f5' },
  '발주': { c: '#2f6fed', bg: '#eaf1fe' },
  '출항': { c: '#0e9f6e', bg: '#e7f7ef' },
  '입항': { c: '#b5730a', bg: '#fdf3e3' },
  '국내입고': { c: '#7a44c9', bg: '#f2ebfd' },
  '완료': { c: '#0a5b46', bg: '#e6f6ef' }
};
function basinStageIndex(b) { let s = b.stage || '견적'; if (s === '입항대기') s = '입항'; return Math.max(0, BASIN_STAGES.indexOf(s)); }
/* 석종(컬러) — 한국어 / 중국어 / 두께. 팬텀·아스팬·알래스카는 기장 1500mm 제한 */
const BASIN_STONES = [
  { k: '볼라카스', c: '爵士白', t: '15mm' },
  { k: '퓨어 화이트', c: '纯白', t: '15mm' },
  { k: '화이트 트라버티노', c: '罗马印记', t: '15mm' },
  { k: '피스마우골드', c: '鱼肚金', t: '15mm' },
  { k: '크레마 나카', c: '象牙米黄', t: '15mm' },
  { k: '실버 트라버티노', c: '巴洛克灰洞', t: '14.5mm' },
  { k: '아만베이지', c: '阿曼米黄', t: '15mm' },
  { k: '베이지 트라버티노', c: '黄洞石', t: '15mm' },
  { k: '깔라까타 마로네', c: '宝格丽紫', t: '15mm' },
  { k: '아메리칸 블랙', c: '美洲砂岩', t: '15mm' },
  { k: '퓨어 블랙', c: '', t: '15mm' },
  { k: '플래티넘 그레이', c: '', t: '15mm' },
  { k: '팬텀 화이트', c: '罗马幻影白', t: '12mm', maxLen: 1500 },
  { k: '아스팬라이트그레이', c: '塞浦路斯', t: '', maxLen: 1500 },
  { k: '알래스카 화이트', c: '阿拉斯加白', t: '12mm', maxLen: 1500 }
];
const BASIN_BOWLS = ['중방볼', '좌방볼', '우방볼', '타원볼', '물방울볼', '기둥볼', '무봉(심리스)', '평판', '기타'];
function basinStoneMeta(name) { return BASIN_STONES.find(s => s.k === name) || null; }
const BASIN_FILTERS = [
  { k: 'all', label: '진행중', match: b => (b.stage || '견적') !== '완료' },
  { k: '견적', label: '견적', match: b => (b.stage || '견적') === '견적' },
  { k: '발주', label: '발주', match: b => b.stage === '발주' },
  { k: '출항', label: '출항', match: b => b.stage === '출항' },
  { k: '입항', label: '입항', match: b => b.stage === '입항' || b.stage === '입항대기' },
  { k: '국내입고', label: '국내입고', match: b => b.stage === '국내입고' },
  { k: '완료', label: '완료', match: b => b.stage === '완료' }
];
function basinFilteredList() {
  const f = filters.basinTab || 'all';
  const fdef = BASIN_FILTERS.find(x => x.k === f) || BASIN_FILTERS[0];
  let l = (state.basins || []).filter(fdef.match);
  const q = (filters.basinSearch || '').trim().toLowerCase();
  if (q) l = l.filter(b => {
    const hay = [b.vendor, b.address].concat(basinItems(b).flatMap(it => [it.stone, it.spec, it.orderNo, it.quoteNo]));
    return hay.some(v => (v || '').toLowerCase().includes(q));
  });
  l.sort((a, b) => (b.orderDate || '0000').localeCompare(a.orderDate || '0000'));   // 발주일 최신순
  return l;
}
function renderBasin() {
  const f = filters.basinTab || 'all';
  const list = basinFilteredList();
  const chips = BASIN_FILTERS.map(x => {
    const n = (state.basins || []).filter(x.match).length;
    return `<button class="chip ${f === x.k ? 'active' : ''}" onclick="filters.basinTab='${x.k}';renderBasin()">${x.label}${n ? ` <b style="opacity:.7">${n}</b>` : ''}</button>`;
  }).join('');
  el('pg-basin').innerHTML = `
    <div class="ph"><div><h2><i class="ti ti-bath"></i>세면대 발주·출고</h2><p>오더베이스 · 탭하면 상세 · 국내입고 후 출고증</p></div>
      <button class="btn btn-pri btn-sm" onclick="openBasinForm()"><i class="ti ti-plus"></i>발주 등록</button></div>
    <div class="chips">${chips}</div>
    <div class="search-box">
      <i class="ti ti-search"></i>
      <input id="basin-search" placeholder="업체·석종·규격·주문번호 검색" value="${esc(filters.basinSearch || '')}" oninput="filterBasin()" autocomplete="off" lang="ko">
      ${filters.basinSearch ? `<button class="search-x" onclick="el('basin-search').value='';filters.basinSearch='';renderBasin()"><i class="ti ti-x"></i></button>` : ''}
    </div>
    <div style="display:flex;gap:8px;margin-bottom:10px">
      <button class="btn btn-sm" style="flex:2" onclick="basinPackingUpload()"><i class="ti ti-file-spreadsheet"></i> 인보이스 업로드 → 출항</button>
      <button class="btn btn-sm" style="flex:1" onclick="openBasinStats()"><i class="ti ti-chart-bar"></i> 수주 통계</button>
    </div>
    <button class="btn btn-sm btn-block" style="margin-bottom:10px;color:#b42318;border-color:#e6a9a9" onclick="openBasinIssueForm()"><i class="ti ti-alert-triangle"></i> 세면대 이슈 등록 <span style="color:var(--t3);font-weight:500">(파손·납기지연 등)</span></button>
    <div style="font-size:12px;color:var(--t3);margin:2px 0 8px">검색 결과 <b id="basin-count" style="color:var(--t1)">${list.length}건</b></div>
    <div class="site-grid" id="basin-list">${basinListHtml(list)}</div>`;
}
function basinListHtml(list) {
  if (!list.length) return `<div class="empty"><i class="ti ti-inbox"></i>해당하는 발주가 없습니다</div>`;
  return list.map(basinCard).join('');
}
function filterBasin() {
  filters.basinSearch = (el('basin-search') && el('basin-search').value) || '';
  const list = basinFilteredList();
  if (el('basin-list')) el('basin-list').innerHTML = basinListHtml(list);
  if (el('basin-count')) el('basin-count').textContent = list.length + '건';
}
function basinPill(stage) {
  const m = BASIN_STAGE_META[stage] || BASIN_STAGE_META['견적'];
  return `<span class="pill" style="background:${m.bg};color:${m.c}">${esc(stage || '견적')}</span>`;
}
function basinItems(b) {
  if (b.items && b.items.length) return b.items;
  if (b.stone || b.spec || b.qty) return [{ stone: b.stone || '', spec: b.spec || '', qty: b.qty || '', quoteNo: b.quoteNo || '', price: b.price || '' }];   // 구버전 단일품목 호환
  return [];
}
function basinTotalQty(b) { return basinItems(b).reduce((a, it) => a + (parseInt(it.qty, 10) || 0), 0); }
function basinCard(b) {
  const idx = basinStageIndex(b);
  const done = b.stage === '완료';
  const tnodes = BASIN_STAGES.map((st, i) => {
    const cls = i < idx ? 'done' : (i === idx ? 'cur' : '');
    const d = (b.history && b.history[st]) ? b.history[st].slice(5) : '';
    return `<div class="tnode ${cls}"><span class="c">${i < idx ? "<i class='ti ti-check'></i>" : ''}</span><span class="lb">${st}</span><span class="dt">${d}</span></div>`;
  }).join('');
  const items = basinItems(b);
  const totQty = basinTotalQty(b);
  const itemLines = items.slice(0, 4).map(it => `<div style="font-size:12px;color:var(--t2);padding:4px 0;border-top:1px solid var(--bd);display:flex;justify-content:space-between;gap:8px"><span><b style="color:var(--t1);font-weight:600">${esc(it.stone || '-')}</b>${it.spec ? ' · ' + esc(it.spec) : ''}${it.orderNo ? ` <span style="color:var(--t3)">· 주문 ${esc(it.orderNo)}</span>` : ''}</span><span style="flex:none;color:var(--t3)">${it.qty ? esc(it.qty) + '개' : ''}</span></div>`).join('');
  const more = items.length > 4 ? `<div style="font-size:11.5px;color:var(--t3);padding-top:4px">외 ${items.length - 4}개 품목</div>` : '';
  let act = '';
  if (idx > 0) act += `<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();basinBack('${b.id}')" title="이전 단계"><i class="ti ti-chevron-left"></i></button>`;
  if (idx <= 3) act += `<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();basinAdvance('${b.id}')">다음 단계<i class="ti ti-chevron-right"></i></button>`;
  else if (idx === 4) act += `<button class="btn btn-sm" style="background:#0a5b46;color:#fff;border-color:#0a5b46" onclick="event.stopPropagation();basinShipOut('${b.id}')"><i class="ti ti-truck-delivery"></i>출고 처리 · 출고증</button>`;
  else if (done) act += `<button class="btn btn-sm" onclick="event.stopPropagation();printBasinSlip('${b.id}')"><i class="ti ti-printer"></i>출고증 인쇄</button>`;
  return `<div class="site" onclick="openBasinForm('${b.id}')">
    <div class="site-top">
      <div><div class="nm">${esc(b.vendor || '(업체미정)')}</div><div class="ad">${b.address ? `<i class="ti ti-map-pin" style="font-size:13px"></i>${esc(b.address)}` : `<span style="color:var(--t3)">주소 미지정</span>`}</div></div>
      <div style="text-align:right;flex:none">${basinPill(b.stage || '견적')}${(() => { const sc = shipConfirm('basin', b.id); return sc && sc.confirmed ? `<div style="margin-top:5px"><span class="pill" style="background:#e8f7f0;color:#0F6E56;font-size:10px"><i class="ti ti-checks"></i> 출하확인</span></div>` : ''; })()}</div>
    </div>
    <div class="site-meta">
      <div class="mi"><i class="ti ti-stack-2"></i><span class="k">품목</span><b>${items.length}건 · 총 ${totQty}개</b></div>
      <div class="mi"><i class="ti ti-calendar"></i><span class="k">발주일</span><b>${esc(b.orderDate || '-')}</b></div>
    </div>
    ${itemLines ? `<div style="margin:8px 0 2px">${itemLines}${more}</div>` : ''}
    <div class="date-row">
      <div class="db"><div class="k">발주일</div><div class="v">${esc(b.orderDate || '미정')}</div></div>
      <div class="db"><div class="k">출고일</div><div class="v">${esc((done ? b.shipDate : '') || '—')}</div></div>
    </div>
    <div class="tline">${tnodes}</div>
    <div style="display:flex;gap:6px;margin-top:11px;flex-wrap:wrap">${act}
      <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();sendToChulgo('basin','${b.id}')" title="출고관리 앱으로 전송">${b.sentChulgo ? '<i class="ti ti-checks" style="color:var(--gd)"></i>출고관리 전송됨' : '<i class="ti ti-send"></i>출고관리 전송'}</button>
    </div>
  </div>`;
}
async function basinSetStage(id, stage, extra) {
  const b = (state.basins || []).find(x => x.id === id); if (!b) return;
  const history = Object.assign({}, b.history || {});
  if (!history[stage]) history[stage] = todayStr();
  await Store.update('basins', id, Object.assign({ stage, history }, extra || {}));
}
async function basinAdvance(id) {
  const b = (state.basins || []).find(x => x.id === id); if (!b) return;
  const i = basinStageIndex(b); if (i >= BASIN_STAGES.length - 1) return;
  await basinSetStage(id, BASIN_STAGES[i + 1]);
}
async function basinBack(id) {
  const b = (state.basins || []).find(x => x.id === id); if (!b) return;
  const i = basinStageIndex(b); if (i <= 0) return;
  const extra = (b.stage === '완료') ? { shipDate: '' } : null;   // 완료에서 되돌리면 출고일 해제
  await basinSetStage(id, BASIN_STAGES[i - 1], extra);
}
async function basinShipOut(id) {
  const b = (state.basins || []).find(x => x.id === id); if (!b) return;
  if (!confirm('출고 처리하고 완료로 옮길까요?\n출고증을 발행합니다.')) return;
  await basinSetStage(id, '완료', { shipDate: todayStr() });
  toast('출고 완료 처리되었습니다');
  setTimeout(() => printBasinSlip(id), 250);
}
function basinStoneSelectHtml(cls, val) {
  return `<select class="${cls}" onchange="basinLenHint()" style="width:100%;font-size:15px;padding:9px 8px;border:1.5px solid var(--bd2);border-radius:9px;background:#fff">${'<option value="">— 석종(컬러) 선택 —</option>' + BASIN_STONES.map(s => `<option value="${esc(s.k)}" ${val === s.k ? 'selected' : ''}>${esc(s.k)}${s.t ? ' · ' + s.t : ''}${s.maxLen ? ' · 최대' + s.maxLen : ''}</option>`).join('')}</select>`;
}
function basinItemRowHtml(it) {
  it = it || {};
  const inp = 'font-size:16px;padding:9px 8px;border:1.5px solid var(--bd2);border-radius:9px';
  return `<div class="bi-row" style="border:1px solid var(--bd2);border-radius:10px;padding:9px 10px;margin-bottom:8px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><span style="font-size:11.5px;color:var(--t3);font-weight:700">품목</span><button type="button" class="btn btn-ghost btn-sm" onclick="this.closest('.bi-row').remove();basinLenHint()" aria-label="삭제"><i class="ti ti-x"></i></button></div>
    ${basinStoneSelectHtml('bi-stone', it.stone)}
    <div style="display:flex;gap:6px;margin-top:6px">
      <input class="bi-spec" lang="en" placeholder="규격 예:1060*473*550" value="${esc(it.spec || '')}" oninput="basinLenHint()" style="flex:2;min-width:0;${inp}">
      <input class="bi-qty" inputmode="numeric" placeholder="수량" value="${esc(it.qty || '')}" style="flex:1;min-width:50px;${inp}">
    </div>
    <div style="display:flex;gap:6px;margin-top:6px">
      <input class="bi-order" placeholder="주문번호" value="${esc(it.orderNo || '')}" style="flex:1;min-width:0;${inp}">
      <input class="bi-quote" placeholder="견적번호" value="${esc(it.quoteNo || '')}" style="flex:1;min-width:0;${inp}">
    </div>
    <input class="bi-cny" inputmode="decimal" placeholder="위안화 원가 (¥)" value="${esc(it.priceCny || it.price || '')}" style="width:100%;margin-top:6px;${inp}">
    <input class="bi-krw" inputmode="numeric" placeholder="한화 원가 (통관비 포함, ₩) · 통관 담당자 기록" value="${esc(it.priceKrw || '')}" style="width:100%;margin-top:6px;${inp}">
  </div>`;
}
function addBasinItemRow() { const c = el('basin-items'); if (c) c.insertAdjacentHTML('beforeend', basinItemRowHtml({})); }
function collectBasinItems() {
  const items = [];
  [...document.querySelectorAll('#basin-items .bi-row')].forEach(r => {
    const g = sel => { const e2 = r.querySelector(sel); return e2 ? (e2.value || '').trim() : ''; };
    const stone = g('.bi-stone'), spec = g('.bi-spec'), qty = g('.bi-qty');
    if (stone || spec || qty) items.push({ stone, spec, qty, orderNo: g('.bi-order'), quoteNo: g('.bi-quote'), priceCny: g('.bi-cny'), priceKrw: g('.bi-krw') });
  });
  return items;
}
function openBasinForm(id) {
  const b = id ? (state.basins || []).find(x => x.id === id) : null;
  const v = b || {};
  const rows = basinItems(v);
  const rowsHtml = (rows.length ? rows : [{}]).map(basinItemRowHtml).join('');
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-bath"></i>${b ? '세면대 발주 수정' : '세면대 발주 등록'}</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="frm">
      <div class="fld full"><label>발주 업체명<span class="req">*</span></label>${searchBox('b-vendor', '업체명 검색·입력', v.vendor, 'companyNames', '')}</div>
      <div class="fld"><label>발주일</label><input type="date" id="b-orderDate" value="${esc(v.orderDate || todayStr())}"></div>
      <div class="fld full"><label>품목 (석종·규격·수량·주문번호)<span class="req">*</span> <span style="color:var(--t3);font-weight:500">(한 업체 여러 세면대면 '품목 추가')</span></label>
        <div id="basin-items">${rowsHtml}</div>
        <div id="b-lenhint" style="display:none;margin:0 0 8px"></div>
        <button type="button" class="btn btn-ghost btn-sm btn-block" onclick="addBasinItemRow()"><i class="ti ti-plus"></i>품목 추가</button>
      </div>
      <div class="fld"><label>진행 단계</label><select id="b-stage">${BASIN_STAGES.map(st => `<option ${(v.stage || '견적') === st ? 'selected' : ''}>${st}</option>`).join('')}</select></div>
      <div class="fld full"><label>현장 주소 <span style="color:var(--t3);font-weight:500">(출고증에 표시)</span></label><input id="b-address" lang="ko" placeholder="현장 주소지" value="${esc(v.address || '')}"></div>
      <div class="fld full"><label>비고</label><input id="b-note" lang="ko" placeholder="선택" value="${esc(v.note || '')}"></div>
      <div class="fld full" style="font-size:11.5px;color:var(--t3);line-height:1.5;background:var(--soft);border-radius:9px;padding:9px 11px"><i class="ti ti-info-circle"></i> 납기 약 30~33일 · 세면대 1개당 브라켓 1SET 포함(팝업·수전·트랩 별도) · 발주 후 수정 불가</div>
    </div>
    <div class="frm-foot">${b ? `<button class="btn" style="color:var(--red-t);border-color:#e6a9a9" onclick="deleteBasin('${b.id}')"><i class="ti ti-trash"></i></button>` : ''}<button class="btn" style="flex:1" onclick="closeModal()">취소</button><button class="btn btn-pri" style="flex:2" onclick="submitBasin('${b ? b.id : ''}')"><i class="ti ti-check"></i>${b ? '저장' : '등록'}</button></div>`);
  basinLenHint();
}
function basinLen(spec) { const m = String(spec || '').match(/\d+/); return m ? +m[0] : 0; }
function basinLenHint() {
  const box = el('b-lenhint'); if (!box) return;
  let msg = '';
  for (const r of [...document.querySelectorAll('#basin-items .bi-row')]) {
    const stone = (r.querySelector('.bi-stone') || {}).value || '';
    const sm = basinStoneMeta(stone);
    const len = basinLen((r.querySelector('.bi-spec') || {}).value || '');
    if (sm && sm.maxLen && len > sm.maxLen) { msg = `<b>${esc(stone)}</b>는 기장 ${sm.maxLen}mm까지만 제작 가능합니다 (현재 ${len}mm)`; break; }
  }
  if (msg) {
    box.style.display = 'block';
    box.innerHTML = `<div style="font-size:12px;color:#d64545;background:#fdeaea;border:1px solid #e6a9a9;border-radius:9px;padding:8px 10px"><i class="ti ti-alert-triangle"></i> ${msg}</div>`;
  } else { box.style.display = 'none'; box.innerHTML = ''; }
}
async function submitBasin(id) {
  const vendor = (el('b-vendor').value || '').trim();
  if (!vendor) { toast('발주 업체명을 입력하세요'); return; }
  const items = collectBasinItems();
  if (!items.some(it => it.stone)) { toast('품목의 석종(컬러)을 선택하세요'); return; }
  for (const it of items) {
    const sm = basinStoneMeta(it.stone);
    const len = basinLen(it.spec);
    if (sm && sm.maxLen && len > sm.maxLen) {
      if (!confirm(`${it.stone}는 기장 ${sm.maxLen}mm까지만 제작 가능합니다.\n현재 ${len}mm — 그래도 저장할까요?`)) return;
    }
  }
  const stage = el('b-stage').value || '견적';
  const cur = id ? (state.basins || []).find(x => x.id === id) : null;
  const history = Object.assign({}, (cur && cur.history) || {});
  if (!history[stage]) history[stage] = todayStr();
  const obj = {
    vendor, items,
    orderDate: el('b-orderDate').value || '',
    stage, history,
    address: (el('b-address').value || '').trim(),
    note: (el('b-note').value || '').trim(),
    orderNo: '', stone: '', spec: '', qty: '', quoteNo: '', price: ''   // 구버전 단일필드 정리
  };
  if (stage === '완료') obj.shipDate = (cur && cur.shipDate) ? cur.shipDate : todayStr();
  else obj.shipDate = '';
  await ensureClient(vendor);   // 신규 거래처 자동 등록
  if (id) await Store.update('basins', id, obj);
  else await Store.add('basins', obj);
  closeModal();
  toast(id ? '수정되었습니다' : '세면대 발주가 등록되었습니다');
}
async function deleteBasin(id) {
  if (!guardDelete('이 발주 건을 삭제할까요?')) return;
  await Store.remove('basins', id);
  closeModal(); toast('삭제되었습니다');
}
/* ===== 인보이스/패킹리스트 업로드 → 업체명+규격 일치 발주를 '출항'으로 ===== */
function basinPackingUpload() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.xlsx,.xls,.csv';
  inp.onchange = () => basinPackingParse(inp);
  inp.click();
}
/* 규격 치수 3개를 순서 무관하게 정규화 (가로*세로*높이 vs 두께*폭*길이 차이 흡수) */
function _specKey(s) { const n = (String(s || '').match(/\d+/g) || []).map(Number).filter(x => x >= 10).sort((a, b) => a - b); return n.join('x'); }
function basinPackingParse(input) {
  const f = input.files && input.files[0]; if (!f) return;
  if (typeof XLSX === 'undefined') { toast('엑셀 모듈 로딩 중 — 잠시 후 다시'); return; }
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const wb = XLSX.read(e.target.result, { type: 'array' });
      const cells = [];
      wb.SheetNames.forEach(sn => {
        XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: '' })
          .forEach(row => row.forEach(c => { const s = String(c == null ? '' : c).trim(); if (s) cells.push(s); }));
      });
      basinPackingMatch(cells);
    } catch (err) { toast('파일을 읽지 못했습니다'); }
  };
  reader.readAsArrayBuffer(f);
}
function basinPackingMatch(cells) {
  const shipIdx = BASIN_STAGES.indexOf('출항');
  const specKeys = new Set();
  cells.forEach(s => { if (/\d{2,}\s*[*xX×]\s*\d{2,}\s*[*xX×]\s*\d{2,}/.test(s)) specKeys.add(_specKey(s)); });
  const lower = cells.map(c => c.toLowerCase());
  const matches = (state.basins || []).filter(b => {
    if ((b.stage || '견적') === '완료' || basinStageIndex(b) >= shipIdx) return false;   // 이미 출항 이후·완료는 제외
    const vendorHit = b.vendor && lower.some(c => c.includes(b.vendor.toLowerCase()));
    const specHit = basinItems(b).some(it => it.spec && specKeys.has(_specKey(it.spec)));
    return specHit && vendorHit;
  });
  if (!specKeys.size) { toast('파일에서 규격(치수)을 찾지 못했습니다'); return; }
  if (!matches.length) { toast('인보이스와 일치하는 발주(업체+규격)를 찾지 못했습니다'); return; }
  const list = matches.slice(0, 12).map(b => '· ' + (b.vendor || '') + ' (' + basinItems(b).length + '품목)').join('\n');
  if (!confirm(`인보이스와 일치하는 발주 ${matches.length}건을 '출항' 단계로 넘길까요?\n(업체명 + 규격 기준)\n\n${list}${matches.length > 12 ? '\n…' : ''}`)) return;
  basinPackingApply(matches.map(b => b.id));
}
async function basinPackingApply(ids) {
  let n = 0;
  for (const id of ids) { try { await basinSetStage(id, '출항'); n++; } catch (e) { } }
  toast(n + '건을 출항 단계로 이동했습니다');
}
/* ===== 세면대 수주 통계 (석종별 / 사이즈별) ===== */
function basinSizeBucket(spec) {
  const nums = (String(spec || '').match(/\d+/g) || []).map(Number).filter(x => x >= 10);
  if (!nums.length) return '미상';
  const max = Math.max(...nums);
  if (max <= 800) return '~800';
  if (max <= 1200) return '801~1200';
  if (max <= 1600) return '1201~1600';
  if (max <= 2200) return '1601~2200';
  return '2200~';
}
function openBasinStats() {
  const items = [];
  (state.basins || []).forEach(b => basinItems(b).forEach(it => items.push(it)));
  const qOf = it => parseInt(it.qty, 10) || 0;
  const totQty = items.reduce((a, it) => a + qOf(it), 0);
  const byStone = {}, bySize = {};
  items.forEach(it => {
    const sk = it.stone || '미상'; (byStone[sk] = byStone[sk] || { c: 0, q: 0 }); byStone[sk].c++; byStone[sk].q += qOf(it);
    const zk = basinSizeBucket(it.spec); (bySize[zk] = bySize[zk] || { c: 0, q: 0 }); bySize[zk].c++; bySize[zk].q += qOf(it);
  });
  const stoneRows = Object.entries(byStone).sort((a, b) => b[1].q - a[1].q || b[1].c - a[1].c);
  const sizeOrder = ['~800', '801~1200', '1201~1600', '1601~2200', '2200~', '미상'];
  const sizeRows = sizeOrder.filter(k => bySize[k]).map(k => [k, bySize[k]]);
  const palette = ['#0e9f6e', '#2f6fed', '#b5730a', '#7a44c9', '#d84b4a', '#0891b2', '#65a30d', '#db2777', '#5b6472', '#ca8a04', '#0a5b46', '#9333ea', '#e11d48', '#0369a1', '#4d7c0f'];
  const pct = v => totQty ? Math.round(v / totQty * 100) : 0;
  const stackBar = rows => totQty ? `<div style="display:flex;height:15px;border-radius:7px;overflow:hidden;margin-bottom:12px;background:var(--soft)">${rows.map(([k, o], i) => `<div title="${esc(k)} ${pct(o.q)}%" style="width:${o.q / totQty * 100}%;background:${palette[i % palette.length]}"></div>`).join('')}</div>` : '';
  const rowHtml = rows => rows.length ? rows.map(([k, o], i) => {
    const col = palette[i % palette.length];
    return `<div style="margin-bottom:10px"><div style="display:flex;justify-content:space-between;font-size:13px;align-items:center;gap:8px"><span style="display:flex;align-items:center;gap:7px;min-width:0"><span style="width:11px;height:11px;border-radius:3px;background:${col};flex:none"></span><b style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(k)}</b></span><span style="color:var(--t2);flex:none;white-space:nowrap"><b style="color:var(--t1)">${o.q}개</b> · ${o.c}건 · ${pct(o.q)}%</span></div><div style="height:8px;background:var(--soft);border-radius:5px;overflow:hidden;margin-top:5px"><div style="width:${totQty ? o.q / totQty * 100 : 0}%;height:100%;background:${col}"></div></div></div>`;
  }).join('') : '<div style="color:var(--t3);font-size:13px">데이터 없음</div>';
  // 월별 (발주일 기준)
  const byMonth = {};
  (state.basins || []).forEach(b => {
    const m = ((b.orderDate || '').slice(0, 7)) || '미상';
    const its = basinItems(b);
    (byMonth[m] = byMonth[m] || { o: 0, c: 0, q: 0 });
    byMonth[m].o++; byMonth[m].c += its.length; its.forEach(it => byMonth[m].q += qOf(it));
  });
  const monthRows = Object.entries(byMonth).sort((a, b) => a[0].localeCompare(b[0]));
  const maxMonthQ = Math.max(1, ...monthRows.map(r => r[1].q));
  const monthHtml = monthRows.length ? monthRows.map(([m, o]) => {
    const label = m === '미상' ? '미상' : m.replace('-', '.');
    return `<div style="margin-bottom:10px"><div style="display:flex;justify-content:space-between;font-size:13px"><b>${esc(label)}</b><span style="color:var(--t2)"><b style="color:var(--t1)">${o.q}개</b> · ${o.o}발주 · ${o.c}품목</span></div><div style="height:8px;background:var(--soft);border-radius:5px;overflow:hidden;margin-top:5px"><div style="width:${Math.round(o.q / maxMonthQ * 100)}%;height:100%;background:#7a44c9"></div></div></div>`;
  }).join('') : '<div style="color:var(--t3);font-size:13px">데이터 없음</div>';
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-chart-bar"></i>세면대 수주 통계</h3><button class="x" onclick="closeModal()">×</button></div>
    <div style="display:flex;gap:8px;margin-bottom:16px">
      <div style="flex:1;background:var(--soft);border-radius:10px;padding:10px;text-align:center"><div style="font-size:11px;color:var(--t3)">발주</div><div style="font-size:18px;font-weight:800">${(state.basins || []).length}건</div></div>
      <div style="flex:1;background:var(--soft);border-radius:10px;padding:10px;text-align:center"><div style="font-size:11px;color:var(--t3)">품목</div><div style="font-size:18px;font-weight:800">${items.length}건</div></div>
      <div style="flex:1;background:var(--soft);border-radius:10px;padding:10px;text-align:center"><div style="font-size:11px;color:var(--t3)">수량</div><div style="font-size:18px;font-weight:800">${totQty}개</div></div>
    </div>
    <div style="font-weight:700;margin:6px 0 10px"><i class="ti ti-calendar-stats"></i> 월별 수주 <span style="color:var(--t3);font-weight:500;font-size:12px">(발주일 기준)</span></div>
    ${monthHtml}
    <div style="font-weight:700;margin:20px 0 10px"><i class="ti ti-color-swatch"></i> 석종(자재)별 수주 <span style="color:var(--t3);font-weight:500;font-size:12px">(개수·비율)</span></div>
    ${stackBar(stoneRows)}
    ${rowHtml(stoneRows)}
    <div style="font-weight:700;margin:20px 0 10px"><i class="ti ti-ruler-2"></i> 사이즈별 수주 <span style="color:var(--t3);font-weight:500;font-size:12px">(최대 치수 기준 · 개수·비율)</span></div>
    ${stackBar(sizeRows)}
    ${rowHtml(sizeRows)}
    <div class="frm-foot"><button class="btn" style="flex:1" onclick="basinExportExcel()"><i class="ti ti-download"></i> 엑셀 다운로드</button><button class="btn btn-pri" style="flex:1" onclick="closeModal()">닫기</button></div>`);
}
/* 세면대 발주 내역 → 엑셀 (품목 1줄씩) */
function basinExportExcel() {
  if (typeof XLSX === 'undefined') { toast('엑셀 모듈 로딩 중 — 잠시 후 다시'); return; }
  const rows = [];
  (state.basins || []).slice()
    .sort((a, b) => (a.orderDate || '').localeCompare(b.orderDate || ''))
    .forEach(b => basinItems(b).forEach(it => {
      rows.push({
        '발주일': b.orderDate || '',
        '월': (b.orderDate || '').slice(0, 7),
        '업체명': b.vendor || '',
        '단계': b.stage || '견적',
        '석종': it.stone || '',
        '규격': it.spec || '',
        '수량': it.qty || '',
        '주문번호': it.orderNo || '',
        '견적번호': it.quoteNo || '',
        '위안화원가': it.priceCny || it.price || '',
        '한화원가(통관포함)': it.priceKrw || '',
        '현장주소': b.address || '',
        '출고일': b.shipDate || '',
        '비고': b.note || ''
      });
    }));
  if (!rows.length) { toast('내보낼 발주 내역이 없습니다'); return; }
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '세면대발주');
  XLSX.writeFile(wb, `세면대발주내역_${todayStr()}.xlsx`);
  toast('엑셀 ' + rows.length + '줄 다운로드');
}
/* 세면대 출고증 — 회사 양식 재사용 + 현장주소 표시 (단일 발주 건 발행) */
function printBasinSlip(id) {
  const b = (state.basins || []).find(x => x.id === id);
  if (!b) { toast('발주 내역을 찾을 수 없습니다'); return; }
  const e = s => esc(s == null ? '' : String(s));
  const date = b.shipDate || todayStr();
  const sameDay = (state.basins || []).filter(x => x.stage === '완료' && (x.shipDate || '') === date).map(x => x.id).sort();
  const seq = Math.max(1, sameDay.indexOf(id) + 1);
  const docNo = date.replace(/-/g, '') + '-B' + seq;
  const route = b.address ? '다우세라믹 상차 →<br>' + e(b.address) + ' 하차' : '';
  const stamp = `<svg viewBox="0 0 200 200" width="150" height="150" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
    <defs><path id="arcTop" d="M 30,100 A 70,70 0 0 1 170,100"/></defs>
    <circle cx="100" cy="100" r="94" fill="none" stroke="#111" stroke-width="4"/>
    <text font-size="15" font-weight="700" fill="#111" letter-spacing="1"><textPath xlink:href="#arcTop" href="#arcTop" startOffset="50%" text-anchor="middle">주식회사 다우세라믹앤석재</textPath></text>
    <text x="100" y="68" text-anchor="middle" font-size="30" font-weight="800" fill="#111">출고</text>
    <line x1="32" y1="84" x2="168" y2="84" stroke="#111" stroke-width="3"/>
    <text x="100" y="110" text-anchor="middle" font-size="17" font-weight="700" fill="#111">${e(date)}</text>
    <line x1="32" y1="122" x2="168" y2="122" stroke="#111" stroke-width="3"/>
    <text x="100" y="152" text-anchor="middle" font-size="30" font-weight="800" fill="#111">확인</text>
  </svg>`;
  const items = basinItems(b);
  const MINROWS = Math.max(8, items.length);
  let rows = items.map((it, i) => `<tr><td class="c">${i + 1}</td><td class="l">${e(it.stone)}</td><td class="c">개</td><td class="c">${e(it.spec)}</td><td class="r">${e(it.qty)}</td><td class="l">${e([it.orderNo ? '주문 ' + it.orderNo : '', it.quoteNo ? '견적 ' + it.quoteNo : ''].filter(Boolean).join(' / '))}</td></tr>`).join('');
  for (let i = items.length; i < MINROWS; i++) rows += `<tr><td class="c">${i + 1}</td><td></td><td></td><td></td><td></td><td></td></tr>`;
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>세면대 출고표 ${e(b.vendor)} ${e(date)}</title>
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
  .issue{text-align:center;font-size:13px}
  .issue .ik{letter-spacing:3px;font-weight:600}
  .issue .iv{font-size:14px;font-weight:600;margin-top:5px;white-space:nowrap}
  .conm{text-align:center;font-size:18px;font-weight:800}
  .recip{text-align:center;vertical-align:middle}
  .recip .rn{font-size:24px;font-weight:800}
  .recip .rt{font-size:15px;font-weight:600;margin-top:22px;word-break:keep-all;line-height:1.55}
  .ck{text-align:center;font-weight:700;background:#f4f4f4;white-space:nowrap}
  .cv{font-size:13.5px}
  .cv .tel{font-size:12px;color:#333}
  .web{text-align:center;font-weight:800;text-decoration:underline;letter-spacing:1px}
  .items{table-layout:fixed;margin-top:14px}
  .items th{border:1px solid #444;background:#eee;padding:8px 6px;font-size:13.5px;font-weight:700}
  .items td{border:1px solid #444;padding:7px 6px;font-size:13px;height:31px}
  .items td.c{text-align:center}.items td.r{text-align:right;padding-right:9px}.items td.l{text-align:left;padding-left:9px}
  .bottom{display:flex;align-items:center;justify-content:space-between;gap:18px;margin-top:12px}
  .who{table-layout:fixed;flex:1}
  .who td{border:1px solid #444;padding:10px 10px;font-size:13px}
  .who .wk{text-align:center;font-weight:700;background:#f4f4f4;width:16%}
  .stamp{flex:none;width:150px;height:150px}
  @media print{body{padding:8px 10px}}
</style></head><body>
  <table class="top">
    <colgroup><col style="width:27%"><col style="width:14%"><col style="width:59%"></colgroup>
    <tr>
      <td class="doc"><div class="dl">문 서 번 호</div><div class="dv">${docNo}</div></td>
      <td class="title" colspan="2">출 고 표</td>
    </tr>
    <tr>
      <td class="issue"><div class="ik">발 행 일 자</div><div class="iv">${e(date)}</div></td>
      <td class="conm" colspan="2">${DAWOO_CO.name}</td>
    </tr>
    <tr>
      <td class="recip" rowspan="6"><div class="rn">${e(b.vendor)}</div><div class="rt">${route}</div></td>
      <td class="ck">주 소</td><td class="cv">${DAWOO_CO.addr}<br><span class="tel">${DAWOO_CO.tel}</span></td>
    </tr>
    <tr><td class="ck">업 태</td><td class="cv">${DAWOO_CO.biztype}</td></tr>
    <tr><td class="ck">대표이사</td><td class="cv">${DAWOO_CO.ceo}</td></tr>
    <tr><td class="ck">등록번호</td><td class="cv">${DAWOO_CO.bizno}</td></tr>
    <tr><td class="ck">E-mail</td><td class="cv">${DAWOO_CO.email}</td></tr>
    <tr><td class="web" colspan="2">${DAWOO_CO.web}</td></tr>
  </table>
  <table class="items">
    <colgroup><col style="width:6%"><col style="width:32%"><col style="width:10%"><col style="width:22%"><col style="width:12%"><col style="width:18%"></colgroup>
    <thead><tr><th>NO</th><th>품명</th><th>단위</th><th>규격</th><th>수량</th><th>비고</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="bottom">
    <table class="who"><tr><td class="wk">담당자</td><td>${e(me ? me.name : '')}</td></tr><tr><td class="wk">현장주소</td><td>${e(b.address || '')}</td></tr>${b.note ? `<tr><td class="wk">비 고</td><td>${e(b.note)}</td></tr>` : ''}</table>
    <div class="stamp">${stamp}</div>
  </div>
</body></html>`;
  const w = window.open('', '_blank');
  if (!w) { toast('팝업이 차단되었습니다. 팝업 허용 후 다시 시도하세요'); return; }
  w.document.write(html); w.document.close(); w.focus();
  setTimeout(() => { try { w.print(); } catch (e) { } }, 350);
}
function openShipForm(pre) {
  _mrowPattern = true; _mrowDepot = true;
  openModal(`
    <div class="sheet-h"><h3><i class="ti ti-logout"></i>출고 등록</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="frm">
      <div class="fld full"><label>업체명<span class="req">*</span></label>${searchBox('o-targetName', '업체명 검색·입력', '', 'companyNames', '')}</div>
      <div class="fld full"><label>출고 자재 / 장수 / 롯트 / 패턴<span class="req">*</span> <span style="color:var(--t3);font-weight:500">(여러 자재는 '자재 추가')</span></label>${matRowsHtml(pre && pre.items && pre.items.length ? pre.items : (pre && pre.material ? [{ name: pre.material, qty: pre.jang, lot: pre.lot, pattern: pre.pattern }] : [{}]), '장수')}</div>
      <div class="fld"><label>출고일<span class="req">*</span></label><input type="date" id="o-date" value="${todayStr()}"></div>
      <div class="fld"><label>출고 창고 <span style="color:var(--t3);font-weight:500">(창고 여러 곳일 때만)</span></label><input id="o-depot" list="o-depot-list" placeholder="창고(선택)"><datalist id="o-depot-list">${depotOptions().map(d => `<option value="${esc(d)}">`).join('')}</datalist></div>
      <div class="fld full"><label>출고지(공장/현장)<span class="req">*</span></label>
        <select id="o-dest" onchange="onShipDest()">
          <option value="">선택…</option>
          <option value="업체 배차">🚚 업체 배차 (업체가 직접 수령·배차 — 출고지 입력 불필요)</option>
          ${state.factories.slice().sort((a, b) => (a.value || '').localeCompare(b.value || '')).map(f => `<option value="${esc(f.value)}">${esc(f.value)} (공장)</option>`).join('')}
          <option value="__manual">직접 입력 (현장·기타)</option>
        </select>
      </div>
      <div class="fld full hidden" id="o-dest-manual"><label>출고지 직접 입력</label><input id="o-dest-text" placeholder="현장명/출고지 입력" autocomplete="off"></div>
      <div class="fld full"><label>메모</label><input id="o-note" placeholder="선택"></div>
      <div class="fld full" style="background:#fff2f0;border-radius:9px;padding:10px 12px"><label style="display:flex;align-items:center;gap:9px;cursor:pointer;font-weight:600;color:#b42318"><input type="checkbox" id="o-damaged" style="width:18px;height:18px"> <i class="ti ti-alert-square-rounded"></i>파손 자재 출고 <span style="font-weight:400;color:var(--t3);font-size:12px">(체크 시 파손 재고에서 차감 — 폐기·반품)</span></label></div>
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
    await ensureClient(targetName);   // 신규 거래처 자동 등록
    const shipId = 'S' + Date.now();
    const note = el('o-note').value.trim();
    const damaged = !!(el('o-damaged') && el('o-damaged').checked);   // 파손 자재 출고
    let totalJang = 0; const zeroed = [];
    for (const r of rows) {
      const material = r.name, jang = r.qty;
      const it = state.inventory.find(i => i.name === material);
      const oldJang = it ? (+it.jang || 0) : 0;
      const newJang = Math.max(0, oldJang - jang);
      const hebe = it ? +(jang * (+it.hebePerJang || 0)).toFixed(2) : 0;
      const lot = (r.lot && r.lot.trim()) ? r.lot.trim() : soleLot(material);   // 롯트 미지정인데 남은 롯트가 하나면 자동 연동
      const oDepot = (r.depot && r.depot.trim()) ? r.depot.trim() : (el('o-depot') && el('o-depot').value || '').trim();   // 행별 창고 우선(창고별 재고), 없으면 폼 상단 창고
      if (it) await Store.update('inventory', it.id, { jang: newJang });
      await Store.add('transactions', { type: 'out', shipId, itemId: it ? it.id : '', itemName: material, spec: it ? it.spec : '', hebe, jang, lot, pattern: r.pattern, depot: oDepot, dest, factory: dest, target: '', targetName, date, note, damaged, createdAt: Date.now(), by: me.name });
      totalJang += jang;
      if (it && oldJang > 0 && newJang <= 0) zeroed.push(material);
    }
    if (_holdConfirm) { await Store.update('holdings', _holdConfirm, { status: '확정', shippedDate: date, shippedJang: totalJang, confirmShipId: shipId }); _holdConfirm = null; }
    for (const nm of zeroed) notifyStockOut(nm);   // 재고 소진 → 즉시 푸시
    toast(`출고 완료 · ${rows.length}개 자재 · ${totalJang}장`); closeModal();
  } finally { _busy = false; }
}
/* 출고 삭제 (관리자) — 재고 연동분 자동 복구(+장수) */
async function delShip(id) {
  if (!isAdmin()) { toast('관리자만 삭제할 수 있습니다'); return; }
  const t = state.transactions.find(x => x.id === id); if (!t) return;
  if (!guardDelete(`이 출고를 삭제할까요?\n${t.itemName} ${t.jang}장 · ${t.date}\n재고 연동분은 자동 복구됩니다.`)) return;
  if (t.itemId) { const it = state.inventory.find(i => i.id === t.itemId); if (it) await Store.update('inventory', it.id, { jang: (+it.jang || 0) + (+t.jang || 0) }); }
  await Store.remove('transactions', id);
  const key = t.shipId || t.id;
  // 같은 출고건이 더 없으면, 이 출고로 '확정'된 홀딩을 홀딩 상태로 되돌림(출고완료 해제)
  if (!state.transactions.some(x => x.id !== id && x.type === 'out' && (x.shipId || x.id) === key)) await revertHoldsForShip(key);
  toast('출고 삭제됨 (재고 복구)');
}
/* 이 출고(shipId)로 확정됐던 홀딩을 되돌림 — 출고완료 해제 → 홀딩 */
async function revertHoldsForShip(key) {
  for (const h of state.holdings.filter(h => h.confirmShipId === key)) {
    await Store.update('holdings', h.id, { status: '홀딩', shippedDate: '', shippedJang: 0, confirmShipId: '' });
  }
}
/* 출고 묶음 삭제 (관리자) — 같은 shipId 전체 복구 */
async function delShipGroup(key) {
  if (!isAdmin()) { toast('관리자만 삭제할 수 있습니다'); return; }
  const list = state.transactions.filter(t => t.type === 'out' && (t.shipId || t.id) === key);
  if (!list.length) return;
  if (!guardDelete(`이 출고(${list.length}건)를 삭제할까요?\n${list.map(t => `${t.itemName} ${t.jang}장`).join(', ')}\n재고 연동분은 자동 복구됩니다.`)) return;
  for (const t of list) {
    if (t.itemId) { const it = state.inventory.find(i => i.id === t.itemId); if (it) await Store.update('inventory', it.id, { jang: (+it.jang || 0) + (+t.jang || 0) }); }
    await Store.remove('transactions', t.id);
  }
  await revertHoldsForShip(key); // 출고완료됐던 홀딩 되돌리기
  toast(`출고 ${list.length}건 삭제됨 (재고 복구)`);
}
/* 입고 삭제 (관리자) — 오입고 정정: 재고에서 그만큼 차감(되돌림) */
async function delIn(id) {
  if (!isAdmin()) { toast('관리자만 삭제할 수 있습니다'); return; }
  const t = state.transactions.find(x => x.id === id); if (!t) return;
  if (!guardDelete(`이 입고를 삭제할까요?\n${t.itemName} ${t.jang}장 · 롯트 ${t.lot || '-'} · ${t.date}\n재고에서 그만큼 되돌립니다. (수정하려면 삭제 후 다시 입고)`)) return;
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
  const foot = rel ? `<div style="display:flex;gap:8px"><button class="btn btn-sm" style="flex:1" onclick="restoreHold('${h.id}')"><i class="ti ti-refresh"></i>복원</button>${isAdmin() ? `<button class="btn btn-sm btn-danger" onclick="delHold('${h.id}')"><i class="ti ti-trash"></i>영구삭제</button>` : ''}</div>` : (conf ? `<div style="display:flex;gap:8px"><button class="btn btn-sm" style="flex:1" onclick="openHoldForm('${h.id}')"><i class="ti ti-edit"></i>수정</button>${isAdmin() ? `<button class="btn btn-sm btn-danger" onclick="delHold('${h.id}')"><i class="ti ti-trash"></i>삭제</button>` : ''}</div>` : (plan ? `
        <div style="display:flex;gap:8px">
          <button class="btn btn-sm" style="flex:1" onclick="openHoldForm('${h.id}')"><i class="ti ti-edit"></i>수정</button>
          <button class="btn btn-sm" style="flex:1" onclick="releaseHold('${h.id}')"><i class="ti ti-lock-open"></i>해제</button>
          ${isAdmin() ? `<button class="btn btn-sm btn-danger" onclick="delHold('${h.id}')"><i class="ti ti-trash"></i>삭제</button>` : ''}
        </div>` : `
        <div style="display:flex;gap:8px">
          <button class="btn btn-pri btn-sm" style="flex:1" onclick="holdToSite('${h.id}')"><i class="ti ti-building-community"></i>현장으로</button>
          <button class="btn btn-pri btn-sm" style="flex:1;background:var(--blue);border-color:var(--blue)" onclick="holdToShip('${h.id}')"><i class="ti ti-truck-delivery"></i>출고로</button>
        </div>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="btn btn-sm" style="flex:1" onclick="openHoldForm('${h.id}')"><i class="ti ti-edit"></i>수정</button>
          <button class="btn btn-sm" style="flex:1" onclick="releaseHold('${h.id}')"><i class="ti ti-lock-open"></i>해제</button>
          ${isAdmin() ? `<button class="btn btn-sm btn-danger" onclick="delHold('${h.id}')"><i class="ti ti-trash"></i>삭제</button>` : ''}
        </div>`));
  return `<div class="card hold-card" style="margin-bottom:11px;${conf ? 'opacity:.92' : ''}">
        <div class="hold-card-body">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
          <div><div style="font-size:14px;font-weight:600;color:var(--t2)"><i class="ti ti-briefcase" style="font-size:13px"></i> ${esc(h.vendor || '-')}</div>${h.forSiteName ? `<div style="margin-top:5px"><span class="pill p-hold"><i class="ti ti-building-community"></i>${esc(h.forSiteName)}</span></div>` : ''}</div>
          ${rel ? `<span class="pill p-gray"><i class="ti ti-lock-open"></i>해제됨</span>` : (conf ? `<span class="pill p-done"><i class="ti ti-circle-check"></i>확정</span>` : (plan ? `<span class="pill p-wait"><i class="ti ti-clock-pause"></i>예정 · 입고대기</span>` : `<span class="pill ${cls}"><i class="ti ti-calendar"></i>${h.useDate || '미정'}${d != null && d >= 0 && d <= 7 ? ' · D-' + d : ''}</span>`))}
        </div>
        <div style="margin:6px 0 4px">
          ${holdItems(h).map(it => `<div style="margin-bottom:3px"><span style="font-size:15px;font-weight:700;color:var(--t1);word-break:keep-all">${esc(it.materialName || '-')}</span> <span style="color:var(--t2);font-size:12.5px">· ${+it.jang || 0}장${it.hebe ? ` (${(+it.hebe).toFixed(1)}㎡)` : ''}${it.lot ? ` · 롯트 ${esc(it.lot)}` : ''}${it.pattern ? ` · 패턴 ${esc(it.pattern)}` : ''}</span>${it.planned ? ` <span style="font-size:10.5px;font-weight:700;color:#9a6a12;background:#fef3e2;border-radius:5px;padding:1px 6px">예정</span>` : (!plan && holdItems(h).some(x => x.planned) ? ` <span style="font-size:10.5px;font-weight:700;color:#0F6E56;background:var(--gl2,#e8f7f0);border-radius:5px;padding:1px 6px">확보</span>` : '')}</div>`).join('')}
        </div>
        ${!plan && !conf && !rel && holdItems(h).some(x => x.planned) ? `<div style="font-size:12px;color:var(--amber-t);margin-top:4px"><i class="ti ti-clock-pause"></i> '예정' 품목은 입고되면 자동으로 확보됩니다</div>` : ''}
        ${conf ? `<div style="font-size:12px;color:var(--lime-t);margin-top:4px"><i class="ti ti-truck-delivery"></i> 출고 완료 ${esc(h.shippedDate || '')} · ${+h.shippedJang || 0}장</div>` : ''}
        ${plan ? `<div style="font-size:12px;color:var(--amber-t);margin-top:4px"><i class="ti ti-clock-pause"></i> 입고되면 자동으로 홀딩으로 전환됩니다</div>` : ''}
        ${rel && h.releasedAuto ? `<div style="font-size:12px;color:var(--t3);margin-top:4px"><i class="ti ti-history"></i> 사용예정일 경과로 자동 해제됨 (${esc(h.releasedDate || '')})</div>` : ''}
        ${h.note ? `<div style="font-size:12px;color:var(--t3);margin-top:6px">${esc(h.note)}</div>` : ''}
        </div>
        <div class="hold-card-foot" style="margin-top:10px">${foot}</div>
      </div>`;
}
/* 홀딩 목록 → 2칸 카드 그리드 */
function holdTableHtml(list) {
  if (!list.length) return `<div class="empty"><i class="ti ti-lock-off"></i>${(filters.holdSearch || '').trim() ? '검색 결과가 없습니다' : '홀딩이 없습니다'}</div>`;
  return `<div class="hold-grid">${list.map(holdCardHtml).join('')}</div>`;
}
function openHoldDetail(id) {
  const h = state.holdings.find(x => x.id === id); if (!h) return;
  openModal(`<div class="sheet-h"><h3><i class="ti ti-lock"></i>홀딩 상세</h3><button class="x" onclick="closeModal()">×</button></div>${holdCardHtml(h)}`);
}
function holdGroupedHtml(list, keyFn, icon) {
  const map = new Map();
  list.forEach(h => keyFn(h).forEach(k => {
    if (!map.has(k)) map.set(k, []);
    const arr = map.get(k); if (!arr.some(x => x.id === h.id)) arr.push(h);
  }));
  const keys = [...map.keys()].sort((a, b) => a.localeCompare(b));
  if (!keys.length) return `<div class="empty"><i class="ti ti-lock-off"></i>해당하는 홀딩이 없습니다</div>`;
  return keys.map(k => `<div class="sec-label" style="margin-top:8px"><i class="ti ${icon}"></i> ${esc(k)} <span style="color:var(--t3);font-weight:500">· ${map.get(k).length}건</span></div>${holdTableHtml(map.get(k))}`).join('');
}
/* 홀딩 화면 보기 전환: 'active'(진행+예정) / 'done'(출고완료) / 'released'(지난·해제) */
function goHoldView(v) { filters.holdDone = (v === 'done'); filters.holdArchive = (v === 'released'); renderHold(); }
/* 현재 보기/검색이 적용된 홀딩 목록 (기한 임박순). 기본은 출고완료·해제 제외 */
function holdFilteredList() {
  const isResv = h => (h.status || '홀딩') === '홀딩';
  let base;
  if (filters.holdArchive) base = state.holdings.filter(h => h.status === '해제');
  else if (filters.holdDone) base = state.holdings.filter(h => h.status === '확정');
  else base = state.holdings.filter(h => !['해제', '확정'].includes(h.status));   // 진행 홀딩 + 예정홀딩
  return base.filter(holdMatchesSearch).sort((a, b) => {
    const ra = isResv(a) ? 0 : 1, rb = isResv(b) ? 0 : 1;
    if (ra !== rb) return ra - rb;
    return (a.useDate || '9999-99-99').localeCompare(b.useDate || '9999-99-99'); // 기한 임박순
  });
}
function holdStatusText(h) { const s = h.status || '홀딩'; return s === '확정' ? '출고완료' : s; }
/* 홀딩 목록 → 엑셀(.xls) 다운로드. 업체별로 묶어 한눈에 */
function downloadHoldXls() {
  const list = holdFilteredList().slice().sort((a, b) => (a.vendor || '').localeCompare(b.vendor || '') || (a.useDate || '9999-99-99').localeCompare(b.useDate || '9999-99-99'));
  const rows = [];
  list.forEach(h => holdItems(h).forEach(it => rows.push({ vendor: h.vendor || '', mat: it.materialName || '', jang: +it.jang || 0, hebe: +it.hebe || 0, lot: it.lot || '', pattern: it.pattern || '', useDate: h.useDate || '', site: h.forSiteName || '', status: holdStatusText(h), note: h.note || '' })));
  if (!rows.length) { toast('내보낼 홀딩이 없습니다'); return; }
  const tj = rows.reduce((a, b) => a + b.jang, 0), th = rows.reduce((a, b) => a + b.hebe, 0);
  const TH = (t, w) => `<th style="background:#0F6E56;color:#fff;font-weight:bold;border:0.5pt solid #0a4f3e;padding:7px 10px;text-align:center" ${w ? 'width="' + w + '"' : ''}>${t}</th>`;
  const TD = (t, st) => `<td style="border:0.5pt solid #cfd8d4;padding:5px 10px;${st || ''}">${t}</td>`;
  const body = rows.map((r, i) => {
    const bg = i % 2 ? 'background:#f3f6f4;' : '';
    return `<tr>${TD(esc(r.vendor), bg)}${TD('<b>' + esc(r.mat) + '</b>', bg)}${TD(r.jang, bg + 'text-align:right')}${TD(r.hebe.toFixed(2), bg + 'text-align:right')}${TD(esc(r.lot), bg)}${TD(esc(r.pattern), bg)}${TD(esc(r.useDate), bg)}${TD(esc(r.site), bg)}${TD(esc(r.status), bg)}${TD(esc(r.note), bg)}</tr>`;
  }).join('');
  const sumStyle = 'border:0.5pt solid #cfd8d4;background:#e1f5ee;color:#0a4f3e;font-weight:bold;padding:7px 10px';
  const scope = (filters.holdSearch || '').trim() ? `검색 "${esc(filters.holdSearch.trim())}"` : (filters.holdArchive ? '지난·해제' : (filters.holdDone ? '출고완료' : '진행중'));
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>홀딩내역</x:Name><x:WorksheetOptions><x:FreezePanes/><x:SplitHorizontal>3</x:SplitHorizontal><x:TopRowBottomPane>3</x:TopRowBottomPane></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]--></head><body>
<table style="border-collapse:collapse;font-family:'맑은 고딕','Malgun Gothic',sans-serif;font-size:10.5pt">
<tr><td colspan="10" style="font-size:16pt;font-weight:bold;color:#0F6E56;padding:8px 4px 2px">다우세라믹앤석재 · 자재 홀딩 내역</td></tr>
<tr><td colspan="10" style="font-size:9pt;color:#777;padding:0 4px 10px">범위 ${scope}  ·  생성일 ${todayStr()}  ·  총 ${rows.length}건</td></tr>
<tr>${TH('업체', 130)}${TH('자재명', 160)}${TH('장수', 60)}${TH('헤베(㎡)', 80)}${TH('롯트', 110)}${TH('패턴', 100)}${TH('사용예정일', 100)}${TH('현장', 130)}${TH('상태', 80)}${TH('비고', 160)}</tr>
${body}
<tr><td colspan="2" style="${sumStyle};text-align:right">합계</td><td style="${sumStyle};text-align:right">${tj}</td><td style="${sumStyle};text-align:right">${th.toFixed(2)}</td><td colspan="6" style="${sumStyle}"></td></tr>
</table></body></html>`;
  const blob = new Blob(['﻿' + html], { type: 'application/vnd.ms-excel;charset=utf-8;' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = '홀딩내역_' + todayStr() + '.xls'; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
  toast('홀딩 엑셀 다운로드 (' + rows.length + '건)');
}
/* 홀딩 목록 → 한눈에 보는 표(내역). 출고내역처럼 따로 스크롤 */
function holdListTableHtml(list) {
  const rows = [];
  list.forEach(h => holdItems(h).forEach(it => rows.push({ h, it })));
  if (!rows.length) return `<div class="empty"><i class="ti ti-lock-off"></i>${(filters.holdSearch || '').trim() ? '검색 결과가 없습니다' : '홀딩이 없습니다'}</div>`;
  const stColor = st => st === '예정' ? 'var(--amber-t)' : (st === '출고완료' ? 'var(--gd)' : (st === '해제' ? 'var(--t3)' : 'var(--blue)'));
  const body = rows.map(({ h, it }) => {
    const st = it.planned && (h.status || '홀딩') === '홀딩' ? '예정' : holdStatusText(h);   // 품목별 예정 반영
    return `<tr onclick="openHoldDetail('${h.id}')" style="cursor:pointer">
      <td>${esc(h.useDate || '-')}</td>
      <td><b>${esc(h.vendor || '-')}</b></td>
      <td style="word-break:keep-all">${esc(it.materialName || '-')}</td>
      <td style="text-align:right">${(+it.jang || 0)}</td>
      <td style="text-align:right">${(+it.hebe || 0).toFixed(1)}</td>
      <td>${esc(h.forSiteName || '-')}</td>
      <td style="color:${stColor(st)};font-weight:700">${esc(st)}</td>
    </tr>`;
  }).join('');
  return `<div class="tbl-wrap" id="holdlist-wrap" data-keepscroll style="max-height:calc(100vh - 320px);overflow:auto">
    <table class="tbl"><thead><tr><th>예정일</th><th>거래처</th><th>자재</th><th>장수</th><th>헤베</th><th>현장</th><th>상태</th></tr></thead><tbody>${body}</tbody></table>
  </div>`;
}
/* 홀딩 목록 본문만 계산 (검색 시 이 부분만 갱신 → 입력 포커스 유지) */
function holdBodyHtml() {
  const list = holdFilteredList();
  if ((filters.holdLayout || 'card') === 'table') return holdListTableHtml(list);
  const g = filters.holdGroup || 'none';
  let inner;
  if (!list.length) inner = `<div class="empty"><i class="ti ti-lock-off"></i>${(filters.holdSearch || '').trim() ? '검색 결과가 없습니다' : '홀딩이 없습니다'}</div>`;
  else if (g === 'material') inner = holdGroupedHtml(list, h => { const ms = holdItems(h).map(it => it.materialName || '(자재 미지정)'); return ms.length ? [...new Set(ms)] : ['(자재 미지정)']; }, 'ti-box');
  else if (g === 'vendor') inner = holdGroupedHtml(list, h => [h.vendor || '(업체 미지정)'], 'ti-briefcase');
  else inner = holdTableHtml(list);
  return `<div class="hold-scroll">${inner}</div>`;
}
/* 검색어 입력 시: 전체 재렌더 없이 목록 영역만 교체 (모바일 한글 입력 끊김 방지) */
function filterHold() {
  filters.holdSearch = el('hold-search') ? el('hold-search').value : '';
  if (el('hold-body')) el('hold-body').innerHTML = holdBodyHtml();
  const x = el('hold-search-x'); if (x) x.style.display = (filters.holdSearch || '').trim() ? '' : 'none';
}
function clearHoldSearch() {
  filters.holdSearch = ''; if (el('hold-search')) el('hold-search').value = '';
  filterHold(); const i = el('hold-search'); if (i) i.focus();
}
/* 직원용 고객 홀딩 요청 검토 섹션 (홀딩 화면 상단) */
function staffHoldReqHtml() {
  const all = (state.holdRequests || []).slice().sort((a, b) => (+b.createdAt || 0) - (+a.createdAt || 0));
  if (!all.length) return '';
  const pending = all.filter(r => (r.status || '대기') === '대기');
  const past = all.filter(r => (r.status || '대기') !== '대기');
  const showArch = !!filters.holdReqArchive;
  const rowFn = (r, isPending) => {
    const items = (r.items || []).map(it => `<b>${esc(it.materialName || '-')}</b> ${+it.jang || 0}장${it.hebe ? ` (${(+it.hebe).toFixed(1)}㎡)` : ''}`).join(', ');
    const when = r.createdAt ? new Date(+r.createdAt).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' }) : '';
    const st = r.status || '대기';
    const badge = st === '승인' ? `<span style="flex:none;font-size:11px;font-weight:700;background:var(--gl2,#e8f7f0);color:#0F6E56;border-radius:999px;padding:3px 10px">승인</span>` : (st === '취소' ? `<span style="flex:none;font-size:11px;font-weight:700;background:var(--soft);color:var(--t3);border-radius:999px;padding:3px 10px">취소</span>` : '');
    return `<div style="border-top:0.5px solid var(--bd);padding:10px 13px">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">
        <div style="min-width:0"><div style="font-size:13.5px;word-break:keep-all"><b style="color:var(--blue)">${esc(r.vendor || '')}</b> · ${items}</div>
        <div style="font-size:11.5px;color:var(--t3);margin-top:3px">${r.useDate ? '사용예정 ' + esc(r.useDate) + ' · ' : ''}요청 ${when}${r.note ? ' · ' + esc(r.note) : ''}</div></div>
        ${!isPending ? badge : ''}
      </div>
      ${!isPending && st === '취소' && r.rejectReason ? `<div style="font-size:11.5px;color:var(--red-t);margin-top:5px;background:#fff2f0;border-radius:8px;padding:6px 9px"><i class="ti ti-message-2" style="font-size:12px"></i> 취소 사유: ${esc(r.rejectReason)}</div>` : ''}
      ${isPending ? `<div style="display:flex;gap:6px;margin-top:8px">
        <button class="btn btn-sm btn-pri" style="flex:1" onclick="prefillHoldFromReq('${r.id}')"><i class="ti ti-lock-check"></i>확인 · 홀딩 등록</button>
        <button class="btn btn-sm btn-danger" style="flex:none" onclick="rejectHoldReq('${r.id}')"><i class="ti ti-x"></i>취소</button>
      </div>` : ''}
    </div>`;
  };
  const pendHtml = pending.length ? pending.map(r => rowFn(r, true)).join('') : `<div style="padding:12px 13px;font-size:12.5px;color:var(--t3)">대기 중인 요청이 없습니다</div>`;
  return `<div class="card" style="padding:0;margin-bottom:12px;border:1.5px solid ${pending.length ? '#f0b048' : 'var(--bd)'};overflow:hidden">
    <div style="display:flex;justify-content:space-between;align-items:center;padding:11px 13px;background:${pending.length ? '#fef3e2' : 'var(--soft)'}">
      <div style="font-weight:700;font-size:14px"><i class="ti ti-bell-ringing" style="color:${pending.length ? '#9a6a12' : 'var(--t3)'}"></i> 고객 홀딩 요청${pending.length ? ` <span style="color:#9a6a12">· 대기 ${pending.length}</span>` : ''}</div>
      ${past.length ? `<button class="btn btn-ghost btn-sm" onclick="filters.holdReqArchive=${showArch ? 'false' : 'true'};renderHold()">${showArch ? '지난 요청 숨기기' : `지난 요청 (${past.length})`}</button>` : ''}
    </div>
    ${pendHtml}
    ${showArch ? past.map(r => rowFn(r, false)).join('') : ''}
  </div>`;
}
async function rejectHoldReq(id) {
  const r = (state.holdRequests || []).find(x => x.id === id); if (!r) return;
  const reason = prompt('취소 사유를 입력하세요 (고객에게 그대로 전달됩니다)', '');
  if (reason === null) return;   // 취소 안 함
  await Store.update('holdRequests', id, { status: '취소', rejectReason: (reason || '').trim(), handledBy: me.name, handledAt: Date.now() });
  toast('요청을 취소 처리했습니다 (사유 전달)');
}
/* 요청 → 홀딩 등록 연동: 등록 완료 시 해당 요청을 '승인'으로 표시하기 위한 링크 */
let _holdReqLink = '';
function prefillHoldFromReq(id) {
  const r = (state.holdRequests || []).find(x => x.id === id); if (!r) return;
  openHoldForm('', { vendor: r.vendor, useDate: r.useDate || '', note: r.note || '', items: (r.items || []).map(it => ({ materialName: it.materialName, jang: it.jang })) });
  _holdReqLink = id;   // openHoldForm 이 먼저 초기화하므로 그 뒤에 설정
}
function renderHold() {
  const isResv = h => (h.status || '홀딩') === '홀딩';
  const released = state.holdings.filter(h => h.status === '해제');
  const active = state.holdings.filter(h => h.status !== '해제');
  const reserved = active.filter(isResv);
  const planned = active.filter(h => h.status === '예정');
  const confirmed = active.filter(h => h.status === '확정');
  const soon = reserved.filter(h => { const d = daysFromNow(h.useDate); return d != null && d >= 0 && d <= 3; });
  const g = filters.holdGroup || 'none';
  const view = filters.holdArchive ? 'released' : (filters.holdDone ? 'done' : 'active');
  const gchip = (v, label, ic) => `<button class="chip ${g === v ? 'active' : ''}" onclick="filters.holdGroup='${v}';renderHold()"><i class="ti ${ic}"></i> ${label}</button>`;
  const viewBanner = view === 'done' ? `<div class="banner info" style="margin-bottom:10px"><i class="ti ti-circle-check"></i> <b>출고완료</b> 홀딩 내역입니다. 위 '진행 홀딩으로'를 누르면 돌아갑니다.</div>`
    : (view === 'released' ? `<div class="banner info" style="margin-bottom:10px"><i class="ti ti-history"></i> <b>지난·해제</b> 홀딩 내역입니다.</div>` : '');
  const viewBtns = view !== 'active'
    ? `<button class="btn btn-block" style="margin-bottom:10px" onclick="goHoldView('active')"><i class="ti ti-arrow-left"></i>진행 홀딩으로 돌아가기</button>`
    : `<div style="display:flex;gap:8px;margin-bottom:10px">
        <button class="btn" style="flex:1" onclick="goHoldView('done')"><i class="ti ti-circle-check"></i>출고완료 내역${confirmed.length ? ' (' + confirmed.length + ')' : ''}</button>
        <button class="btn" style="flex:1" onclick="goHoldView('released')"><i class="ti ti-history"></i>지난·해제${released.length ? ' (' + released.length + ')' : ''}</button>
      </div>`;
  el('pg-hold').innerHTML = `
    <div>
      <div class="ph"><div><h2><i class="ti ti-lock"></i>자재 홀딩</h2><p>홀딩 ${reserved.length} · 예정 ${planned.length} · 확정 ${confirmed.length}${soon.length ? ' · 임박 ' + soon.length : ''}</p></div>
        <button class="btn btn-pri btn-sm" onclick="openHoldForm()"><i class="ti ti-plus"></i>홀딩 등록</button></div>
      <div class="search-box">
        <i class="ti ti-search"></i>
        <input id="hold-search" placeholder="업체명·자재명 검색" value="${esc(filters.holdSearch || '')}" oninput="filterHold()" autocomplete="off">
        <button class="search-x" id="hold-search-x" style="${(filters.holdSearch || '').trim() ? '' : 'display:none'}" onclick="clearHoldSearch()"><i class="ti ti-x"></i></button>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:2px;flex-wrap:wrap">
        <div class="chips" style="margin:0">${gchip('none', '전체', 'ti-list')}${gchip('material', '자재별', 'ti-box')}${gchip('vendor', '업체별', 'ti-briefcase')}</div>
        <div style="display:flex;gap:8px;align-items:center;flex:none">
          <div class="chips" style="margin:0">
            <button class="chip ${(filters.holdLayout || 'card') === 'card' ? 'active' : ''}" onclick="filters.holdLayout='card';renderHold()"><i class="ti ti-layout-grid"></i> 카드</button>
            <button class="chip ${filters.holdLayout === 'table' ? 'active' : ''}" onclick="filters.holdLayout='table';renderHold()"><i class="ti ti-table"></i> 표</button>
          </div>
          <button class="btn btn-sm" style="flex:none" onclick="downloadHoldXls()"><i class="ti ti-file-spreadsheet"></i>엑셀</button>
        </div>
      </div>
      ${staffHoldReqHtml()}
      ${viewBtns}
      ${viewBanner}
      <div id="hold-body">${holdBodyHtml()}</div>
    </div>`;
}
function openHoldForm(id, pre) {
  const h = id ? state.holdings.find(x => x.id === id) : null; const v = h || Object.assign({}, pre || {});
  _mrowPattern = true; _mrowDepot = false; _holdReqLink = '';   // 일반 홀딩 등록이면 요청 연동 없음
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
  if (el('h-vendor') && s.client) el('h-vendor').value = s.client; // 업체(거래처) 자동 채움
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
    let held = 0; state.holdings.forEach(h => { if (h.id === id) return; if ((h.status || '홀딩') !== '홀딩') return; holdItems(h).forEach(x => { if (_normName(x.materialName) === _normName(mat) && !x.planned) held += (+x.jang || 0); }); });
    return phys - held;
  }
  const useDate = el('h-useDate').value, note = el('h-note').value.trim();
  // 한 건 안에서 품목별로 재고 있으면 확보(planned:false), 부족하면 예정(planned:true) — 같은 자재 여러 줄이면 누적 차감
  const used = {};
  const outItems = items.map(it => {
    const k = _normName(it.materialName);
    const avail = availExcl(it.materialName) - (used[k] || 0);
    const planned = !(avail >= it.jang);
    if (!planned) used[k] = (used[k] || 0) + it.jang;
    return { materialName: it.materialName, jang: it.jang, hebe: it.hebe, lot: it.lot, pattern: it.pattern || '', planned: planned };
  });
  const allPlanned = outItems.every(x => x.planned);
  const anyPlanned = outItems.some(x => x.planned);
  const status = allPlanned ? '예정' : '홀딩';   // 하나라도 재고 있으면 활성 홀딩(카드 1개), 전부 부족하면 예정
  const first = outItems[0];
  const obj = { vendor, items: outItems, materialName: first.materialName, jang: first.jang, hebe: first.hebe, lot: first.lot, useDate, note, status, forSiteId: siteId, forSiteName: siteName, by: me.name };
  await ensureClient(vendor);   // 신규 거래처 자동 등록
  if (id) await Store.update('holdings', id, obj);
  else {
    await Store.add('holdings', obj);
    // 고객 요청에서 넘어온 등록이면 해당 요청을 '승인'으로 마킹
    if (_holdReqLink) { try { await Store.update('holdRequests', _holdReqLink, { status: '승인', handledBy: me.name, handledAt: Date.now() }); } catch (e) { } _holdReqLink = ''; }
  }
  toast(allPlanned ? '예정홀딩으로 등록 — 입고되면 자동 전환' : (anyPlanned ? '홀딩 등록 — 일부 품목은 예정(입고 대기)' : (id ? '저장됨' : '홀딩 등록 완료')));
  closeModal();
}
async function releaseHold(id) { if (!confirm('홀딩을 해제할까요? (기록은 남고 목록에서만 빠집니다 — 지난·해제 내역 보기에서 다시 볼 수 있음)')) return; await Store.update('holdings', id, { status: '해제' }); toast('홀딩 해제됨'); }
/* 특정 자재의 가용 장수(이 홀딩 제외, 활성 '홀딩'만 차감) */
function holdAvailExcl(mat, excludeId) {
  const it = state.inventory.find(i => _normName(i.name) === _normName(mat)); const phys = it ? +it.jang || 0 : 0;
  let held = 0;
  state.holdings.forEach(h => { if (h.id === excludeId) return; if ((h.status || '홀딩') !== '홀딩') return; holdItems(h).forEach(x => { if (_normName(x.materialName) === _normName(mat) && !x.planned) held += (+x.jang || 0); }); });
  return phys - held;
}
function holdFitsStock(h) { return holdItems(h).every(it => holdAvailExcl(it.materialName, h.id) >= (+it.jang || 0)); }
async function restoreHold(id) {
  const h = state.holdings.find(x => x.id === id); if (!h) return;
  const status = holdFitsStock(h) ? '홀딩' : '예정';   // 재고 부족하면 예정홀딩으로 복원
  await Store.update('holdings', id, { status, releasedAuto: false, releasedDate: '' });
  toast(status === '예정' ? '재고 부족 — 예정홀딩으로 복원 (입고 시 자동 전환)' : '홀딩으로 복원됨');
}
async function delHold(id) {
  if (!isAdmin()) { toast('관리자만 삭제할 수 있습니다'); return; }
  const h = state.holdings.find(x => x.id === id); if (!h) return;
  if (!guardDelete(`이 홀딩을 완전히 삭제할까요?\n${h.vendor || ''} · ${h.materialName || ''} ${h.jang || 0}장`)) return;
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
  openShipForm({ items: holdItems(h).map(it => ({ name: it.materialName, qty: it.jang, lot: it.lot, pattern: it.pattern })), targetName: h.vendor || h.forSiteName || '' });
}

/* ===================================================================
   설정
   =================================================================== */
/* ================= 출고관리 (사무실 요청 → 창고 확인) — 이식 1단계 ================= */
function chulgoSide() { return filters.chulgoSide || 'office'; }
function chulgoGoSide(v) { filters.chulgoSide = v; renderChulgo(); }
let _crN = 0;
function crItemRow(d) {
  d = d || {}; const i = _crN++;
  return `<div class="cr-row" style="border:1px solid var(--bd2);border-radius:10px;padding:8px 9px;margin-bottom:8px">
    <div style="display:flex;gap:6px;align-items:center">
      <div style="flex:2.1;min-width:0">${searchBox('crm-' + i, '자재명 검색·입력', d.name || '', 'matNames', '')}</div>
      <input class="cr-qty" inputmode="numeric" placeholder="수량" value="${esc(d.qty || '')}" style="flex:1;min-width:50px;font-size:15px;padding:9px 8px;border:1.5px solid var(--bd2);border-radius:9px">
      <input class="cr-unit" placeholder="단위" value="${esc(d.unit || '')}" style="flex:none;width:52px;font-size:14px;padding:9px 6px;border:1.5px solid var(--bd2);border-radius:9px">
      <button type="button" class="btn btn-ghost btn-sm" style="flex:none" onclick="this.closest('.cr-row').remove()" aria-label="삭제"><i class="ti ti-x"></i></button>
    </div>
    <input class="cr-spec" lang="ko" placeholder="규격/롯트·패턴(선택)" value="${esc(d.spec || '')}" style="width:100%;margin-top:6px;font-size:14px;padding:8px 9px;border:1.5px solid var(--bd2);border-radius:9px">
  </div>`;
}
function addCrRow() { const c = el('cr-rows'); if (c) c.insertAdjacentHTML('beforeend', crItemRow({})); }
function collectCrItems() { const rows = []; document.querySelectorAll('#cr-rows .cr-row').forEach(r => { const inp = r.querySelector('input.sb-in'); const name = inp ? (inp.value || '').trim() : ''; const qty = parseFloat(r.querySelector('.cr-qty').value) || 0; const unit = (r.querySelector('.cr-unit').value || '').trim(); const spec = (r.querySelector('.cr-spec').value || '').trim(); if (name) rows.push({ name: name, qty: qty, unit: unit, spec: spec }); }); return rows; }
function chulgoNextDocNo(reqType) { const d = todayStr().replace(/-/g, ''); const n = (state.chulgoReqs || []).filter(r => (r.docNo || '').startsWith(d)).length + 1; const p = reqType === '입고' ? 'I' : (reqType === '입고알림' ? 'A' : 'O'); return d + '-' + p + String(n).padStart(2, '0'); }
function chulgoReqCard(r, forWarehouse) {
  const st = r.status || '대기';
  const cls = st === '완료' ? 'p-done' : (st === '확인' ? 'p-prog' : 'p-wait');
  const urg = r.urgency || (r.urgent ? '긴급' : '보통');
  const urgBadge = urg === '즉시' ? '<span class="pill" style="background:#fde8e8;color:#a01212;font-size:10px">즉시</span> ' : (urg === '긴급' ? '<span class="pill" style="background:#fde8e8;color:#c0341d;font-size:10px">긴급</span> ' : '');
  const items = (r.items || []).map(it => `<div style="font-size:12.5px;color:var(--t2)">· <b style="color:var(--t1)">${esc(it.name)}</b> ${+it.qty || 0}${it.unit ? esc(it.unit) : ''}${it.spec ? ` <span style="color:var(--t3)">(${esc(it.spec)})</span>` : ''}</div>`).join('');
  const when = r.createdAt ? new Date(+r.createdAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const fl = r.flags || {}; const flTxt = [fl.basin ? '세면대' : '', fl.pack ? '포장' : '', fl.pallet ? '파렛트' : ''].filter(Boolean).join(' · ');
  const sub = [r.schedDate ? '예정 ' + r.schedDate : '', r.vehicle ? '차량 ' + r.vehicle : '', r.driver ? '기사 ' + r.driver : ''].filter(Boolean).join(' · ');
  return `<div class="card" style="margin-bottom:9px;padding:12px 14px;border-left:4px solid ${r.urgent ? '#e23b3b' : 'var(--bd2)'}">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
      <div style="min-width:0"><div style="font-weight:700;font-size:14px">${urgBadge}${esc(r.reqType || '출고')} · ${esc(r.client || '-')}${flTxt ? ` <span style="font-size:10.5px;color:var(--blue)">[${flTxt}]</span>` : ''}</div>
        <div style="font-size:11.5px;color:var(--t3);margin-top:2px">${esc(r.docNo || '')} · ${esc(r.sender || '')} · ${when}</div></div>
      <span class="pill ${cls}" style="flex:none">${esc(st)}</span>
    </div>
    <div style="margin-top:7px">${items}</div>
    ${sub ? `<div style="margin-top:5px;font-size:11.5px;color:var(--t3)"><i class="ti ti-truck" style="font-size:12px"></i> ${esc(sub)}</div>` : ''}
    ${r.memo ? `<div style="margin-top:6px;font-size:12.5px;color:var(--t2);border-top:1px dashed var(--bd2);padding-top:6px"><i class="ti ti-note"></i> ${esc(r.memo)}</div>` : ''}
    ${st !== '대기' && r.ackedBy ? `<div style="margin-top:6px;font-size:11.5px;color:var(--gd)"><i class="ti ti-checks"></i> ${esc(r.ackedBy)} 확인${r.ackedAt ? ' ' + new Date(+r.ackedAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}</div>` : ''}
    <div class="frm-foot" style="margin-top:9px">
      ${forWarehouse && st === '대기' ? `<button class="btn btn-pri btn-sm" style="flex:1" onclick="chulgoAck('${r.id}')"><i class="ti ti-check"></i>확인</button>` : ''}
      ${forWarehouse && st === '확인' ? `<button class="btn btn-sm" style="flex:1" onclick="chulgoDone('${r.id}')"><i class="ti ti-circle-check"></i>완료</button>` : ''}
      <button class="btn btn-sm" onclick="openChulgoChat('${r.id}')"><i class="ti ti-message"></i>채팅${(() => { const u = chulgoUnread(r); return u ? ` <span style="background:#e23b3b;color:#fff;border-radius:9px;padding:0 5px;font-size:10px">${u}</span>` : ((r.chats || []).length ? ` <span style="color:var(--t3)">${(r.chats || []).length}</span>` : ''); })()}</button>
      <button class="btn btn-sm" onclick="chulgoPrint('${r.id}')"><i class="ti ti-printer"></i>지시서</button>
      ${isAdmin() ? `<button class="btn btn-danger btn-sm" onclick="delChulgoReq('${r.id}')"><i class="ti ti-trash"></i></button>` : ''}
    </div>
  </div>`;
}
/* 출고/입고 지시서 인쇄 — 회사 레터헤드 + 품목표 + 확인란 */
function chulgoPrint(id) {
  const r = (state.chulgoReqs || []).find(x => x.id === id); if (!r) { toast('요청을 찾을 수 없습니다'); return; }
  const e = s => esc(s == null ? '' : String(s));
  const isIn = (r.reqType === '입고');
  const title = isIn ? '입 고 지 시 서' : '출 고 지 시 서';
  const urg = r.urgency || (r.urgent ? '긴급' : '보통');
  const fl = r.flags || {}; const flTxt = [fl.basin ? '세면대' : '', fl.pack ? '포장' : '', fl.pallet ? '파렛트' : ''].filter(Boolean).join(' / ') || '-';
  const items = r.items || [];
  const MIN = Math.max(8, items.length);
  let rows = items.map((it, i) => `<tr><td class="c">${i + 1}</td><td class="l">${e(it.name)}</td><td class="l">${e(it.spec)}</td><td class="r">${e(it.qty)}</td><td class="c">${e(it.unit)}</td></tr>`).join('');
  for (let i = items.length; i < MIN; i++) rows += `<tr><td class="c">${i + 1}</td><td></td><td></td><td></td><td></td></tr>`;
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${title} ${e(r.client)} ${e(r.docNo)}</title>
<style>
  *{box-sizing:border-box} body{font-family:'맑은 고딕','Malgun Gothic','Apple SD Gothic Neo',sans-serif;color:#111;margin:0;padding:22px 26px}
  h1{text-align:center;font-size:26px;font-weight:800;letter-spacing:12px;margin:0 0 4px} .co{text-align:center;font-size:13px;color:#333;margin-bottom:14px}
  table{border-collapse:collapse;width:100%} .info td{border:1px solid #444;padding:7px 9px;font-size:13px} .info .k{background:#f2f2f2;font-weight:700;text-align:center;white-space:nowrap;width:14%}
  .urg{color:#c0341d;font-weight:800} .items{margin-top:12px;table-layout:fixed} .items th{border:1px solid #444;background:#eee;padding:7px 6px;font-size:13px} .items td{border:1px solid #444;padding:6px;font-size:12.5px;height:30px}
  .items td.c{text-align:center}.items td.r{text-align:right;padding-right:9px}.items td.l{text-align:left;padding-left:9px}
  .foot{margin-top:12px} .foot td{border:1px solid #444;padding:12px 10px;font-size:12.5px} .foot .k{background:#f2f2f2;font-weight:700;text-align:center;width:16%}
  @media print{body{padding:8px 10px}}
</style></head><body>
  <h1>${title}</h1>
  <div class="co">${e(DAWOO_CO.name)} · ${e(DAWOO_CO.tel)}</div>
  <table class="info">
    <tr><td class="k">문서번호</td><td>${e(r.docNo)}</td><td class="k">발행일자</td><td>${e(todayStr())}</td></tr>
    <tr><td class="k">거래처</td><td>${e(r.client)}</td><td class="k">${isIn ? '입고' : '출고'}예정일</td><td>${e(r.schedDate) || '-'}</td></tr>
    <tr><td class="k">긴급도</td><td class="${urg !== '보통' ? 'urg' : ''}">${e(urg)}</td><td class="k">요청자</td><td>${e(r.sender)}</td></tr>
    <tr><td class="k">차량 / 기사</td><td>${e(r.vehicle) || '-'} / ${e(r.driver) || '-'}</td><td class="k">구분표시</td><td>${e(flTxt)}</td></tr>
  </table>
  <table class="items"><colgroup><col style="width:8%"><col style="width:40%"><col style="width:28%"><col style="width:14%"><col style="width:10%"></colgroup>
    <thead><tr><th>No</th><th>품목명</th><th>규격 / 롯트·패턴</th><th>수량</th><th>단위</th></tr></thead><tbody>${rows}</tbody></table>
  ${r.memo ? `<div style="margin-top:8px;font-size:12.5px;border:1px solid #444;padding:8px 10px"><b>메모</b> : ${e(r.memo)}</div>` : ''}
  <table class="foot"><tr><td class="k">요청자</td><td></td><td class="k">${isIn ? '입고' : '출고'}담당</td><td></td><td class="k">확인자</td><td></td></tr></table>
</body></html>`;
  const w = window.open('', '_blank');
  if (!w) { toast('팝업이 차단되었습니다. 팝업 허용 후 다시'); return; }
  w.document.write(html); w.document.close(); w.focus();
  setTimeout(() => { try { w.print(); } catch (e) { } }, 350);
}
function chulgoOfficeSection() {
  const mine = (state.chulgoReqs || []).slice().sort((a, b) => (+b.createdAt || 0) - (+a.createdAt || 0));
  const box = mine.length ? `<div id="chulgo-office-list" data-keepscroll style="max-height:52vh;overflow-y:auto;-webkit-overflow-scrolling:touch;border:0.5px solid var(--bd);border-radius:12px;padding:9px 9px 1px;background:#fff">${mine.map(r => chulgoReqCard(r, false)).join('')}</div>` : `<div class="empty"><i class="ti ti-inbox"></i>보낸 요청이 없습니다</div>`;
  return `<div class="card" style="padding:13px 15px;margin-bottom:12px">
      <div style="font-weight:600;font-size:14px;margin-bottom:10px"><i class="ti ti-send" style="color:var(--blue)"></i> 출고·입고 요청</div>
      <div style="display:flex;gap:8px;margin-bottom:8px">
        <div class="fld" style="flex:1"><label style="font-size:12px;color:var(--t2)">구분</label><select id="cr-type" style="width:100%;font-size:15px;padding:9px 10px;border:1.5px solid var(--bd2);border-radius:10px"><option>출고</option><option>입고</option><option>입고알림</option></select></div>
        <div class="fld" style="flex:2"><label style="font-size:12px;color:var(--t2)">거래처 <span style="color:var(--red-t)">*</span></label>${searchBox('cr-client', '거래처 검색·입력', '', 'companyNames', '')}</div>
      </div>
      <div class="fld full" style="margin-bottom:8px"><label style="font-size:12px;color:var(--t2)">품목 / 수량 / 단위 / 규격 <span style="color:var(--red-t)">*</span></label><div id="cr-rows">${crItemRow({})}</div><button type="button" class="btn btn-ghost btn-sm" onclick="addCrRow()"><i class="ti ti-plus"></i>자재 추가</button></div>
      <div style="display:flex;gap:8px;margin-bottom:8px">
        <div class="fld" style="flex:1"><label style="font-size:12px;color:var(--t2)">긴급도</label><select id="cr-urg" style="width:100%;font-size:15px;padding:9px 10px;border:1.5px solid var(--bd2);border-radius:10px"><option>보통</option><option>긴급</option><option>즉시</option></select></div>
        <div class="fld" style="flex:1.2"><label style="font-size:12px;color:var(--t2)">예정일</label><input type="date" id="cr-sched" style="width:100%;font-size:14px;padding:8px 10px;border:1.5px solid var(--bd2);border-radius:10px"></div>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:8px">
        <div class="fld" style="flex:1"><label style="font-size:12px;color:var(--t2)">차량</label><input id="cr-vehicle" lang="ko" placeholder="선택" style="width:100%;font-size:15px;padding:9px 11px;border:1.5px solid var(--bd2);border-radius:10px"></div>
        <div class="fld" style="flex:1"><label style="font-size:12px;color:var(--t2)">기사명</label><input id="cr-driver" lang="ko" placeholder="선택" style="width:100%;font-size:15px;padding:9px 11px;border:1.5px solid var(--bd2);border-radius:10px"></div>
      </div>
      <div class="fld full" style="margin-bottom:8px"><label style="font-size:12px;color:var(--t2)">메모</label><input id="cr-memo" lang="ko" placeholder="선택" style="width:100%;font-size:15px;padding:9px 11px;border:1.5px solid var(--bd2);border-radius:10px"></div>
      <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:10px;font-size:13px">
        <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="cr-basin" style="width:17px;height:17px"> 세면대</label>
        <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="cr-pack" style="width:17px;height:17px"> 포장</label>
        <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="cr-pallet" style="width:17px;height:17px"> 파렛트</label>
      </div>
      <button class="btn btn-pri btn-block" onclick="submitChulgoReq()"><i class="ti ti-send"></i>창고로 요청 보내기</button>
    </div>
    <div style="font-size:12px;font-weight:600;color:var(--t2);margin:2px 2px 6px">보낸 요청</div>${box}`;
}
function chulgoWarehouseSection() {
  const reqs = (state.chulgoReqs || []).slice().sort((a, b) => { const ua = (a.status || '대기') === '대기' ? 0 : 1, ub = (b.status || '대기') === '대기' ? 0 : 1; if (ua !== ub) return ua - ub; if ((a.urgent ? 0 : 1) !== (b.urgent ? 0 : 1)) return (a.urgent ? 0 : 1) - (b.urgent ? 0 : 1); return (+b.createdAt || 0) - (+a.createdAt || 0); });
  const pend = reqs.filter(r => (r.status || '대기') === '대기').length;
  const box = reqs.length ? `<div id="chulgo-wh-list" data-keepscroll style="max-height:62vh;overflow-y:auto;-webkit-overflow-scrolling:touch;border:0.5px solid var(--bd);border-radius:12px;padding:9px 9px 1px;background:#fff">${reqs.map(r => chulgoReqCard(r, true)).join('')}</div>` : `<div class="empty"><i class="ti ti-clipboard-off"></i>들어온 요청이 없습니다</div>`;
  return `<div style="font-size:12px;color:var(--t3);margin:2px 0 8px"><span class="live-dot" style="background:#1D9E75;--pc:rgba(29,158,117,.6);width:7px;height:7px;display:inline-block;vertical-align:middle;margin-right:5px"></span>실시간 · 대기 <b style="color:#c0341d">${pend}건</b></div>${box}`;
}
function renderChulgo() {
  const side = chulgoSide();
  const pend = (state.chulgoReqs || []).filter(r => (r.status || '대기') === '대기').length;
  el('pg-chulgo').innerHTML = `
    <div class="ph"><div><h2><i class="ti ti-clipboard-list"></i>출고관리</h2><p>사무실 요청 → 창고 실시간 확인</p></div></div>
    <div class="seg" style="margin:2px 0 12px">
      <button type="button" class="${side === 'office' ? 'on' : ''}" onclick="chulgoGoSide('office')"><i class="ti ti-building" style="font-size:14px"></i> 사무실(요청)</button>
      <button type="button" class="${side === 'warehouse' ? 'on' : ''}" onclick="chulgoGoSide('warehouse')"><i class="ti ti-building-warehouse" style="font-size:14px"></i> 창고(확인)${pend ? ` <b>${pend}</b>` : ''}</button>
    </div>
    ${side === 'office' ? chulgoOfficeSection() : chulgoWarehouseSection()}
    <div class="banner info" style="margin-top:12px"><i class="ti ti-info-circle"></i> 이식 1단계 — 요청·확인 기본 흐름입니다. 지시서 인쇄·채팅·입고 알림·목록·엑셀은 다음 단계에서 추가됩니다.</div>`;
}
async function submitChulgoReq() {
  const client = (el('cr-client') && el('cr-client').value || '').trim();
  const reqType = el('cr-type') ? el('cr-type').value : '출고';
  const items = collectCrItems();
  const urgency = el('cr-urg') ? el('cr-urg').value : '보통';
  const urgent = urgency !== '보통';
  const schedDate = el('cr-sched') ? el('cr-sched').value : '';
  const vehicle = (el('cr-vehicle') && el('cr-vehicle').value || '').trim();
  const driver = (el('cr-driver') && el('cr-driver').value || '').trim();
  const memo = (el('cr-memo') && el('cr-memo').value || '').trim();
  const flags = { basin: !!(el('cr-basin') && el('cr-basin').checked), pack: !!(el('cr-pack') && el('cr-pack').checked), pallet: !!(el('cr-pallet') && el('cr-pallet').checked) };
  if (!client) { toast('거래처를 입력하세요'); return; }
  if (!items.length) { toast('품목·수량을 입력하세요'); return; }
  if (_busy) return; _busy = true;
  try {
    const docNo = chulgoNextDocNo(reqType);
    await ensureClient(client);
    await Store.add('chulgoReqs', { docNo, reqType, client, items, urgency, urgent, schedDate, vehicle, driver, memo, flags, status: '대기', sender: (me && me.name) || '', createdAt: Date.now() });
    toast('요청 등록됨 · ' + docNo);
    renderChulgo();
  } finally { setTimeout(() => { _busy = false; }, 600); }
}
async function chulgoAck(id) { const r = (state.chulgoReqs || []).find(x => x.id === id); if (!r) return; await Store.update('chulgoReqs', id, { status: '확인', ackedBy: (me && me.name) || '', ackedAt: Date.now() }); toast('확인 처리됨'); }
async function chulgoDone(id) { await Store.update('chulgoReqs', id, { status: '완료', doneBy: (me && me.name) || '', doneAt: Date.now() }); toast('완료 처리됨'); }
async function delChulgoReq(id) { if (!guardDelete('이 요청을 삭제할까요?')) return; await Store.remove('chulgoReqs', id); toast('삭제됨'); }
/* ── 요청별 채팅 (사무실 ↔ 창고) ── */
let _chulgoChatOpen = '';
function chulgoMineSide() { return chulgoSide() === 'warehouse' ? 'wh' : 'office'; }
function chulgoUnread(r) { const mine = chulgoMineSide(); const other = mine === 'wh' ? 'office' : 'wh'; const rt = mine === 'wh' ? (+r.readWh || 0) : (+r.readOffice || 0); return (r.chats || []).filter(m => m.side === other && (+m.at || 0) > rt).length; }
function chulgoChatThreadHtml(r) {
  const mine = chulgoMineSide(); const msgs = r.chats || [];
  if (!msgs.length) return `<div style="text-align:center;color:var(--t3);font-size:12.5px;padding:22px">아직 메시지가 없습니다. 첫 메시지를 보내보세요.</div>`;
  return msgs.map(m => { const isMe = m.side === mine; const t = m.at ? new Date(+m.at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''; return `<div style="display:flex;justify-content:${isMe ? 'flex-end' : 'flex-start'};margin:5px 6px"><div style="max-width:78%"><div style="font-size:10.5px;color:var(--t3);margin-bottom:2px;text-align:${isMe ? 'right' : 'left'}">${esc(m.name || (m.side === 'wh' ? '창고' : '사무실'))} · ${t}</div><div style="background:${isMe ? 'var(--g)' : '#fff'};color:${isMe ? '#fff' : 'var(--t1)'};padding:8px 11px;border-radius:12px;font-size:13.5px;word-break:break-word;border:${isMe ? 'none' : '1px solid var(--bd2)'}">${esc(m.text)}</div></div></div>`; }).join('');
}
async function openChulgoChat(id) {
  const r = (state.chulgoReqs || []).find(x => x.id === id); if (!r) { toast('요청을 찾을 수 없습니다'); return; }
  _chulgoChatOpen = id;
  openModal(`<div class="sheet-h"><h3><i class="ti ti-messages"></i>채팅 · ${esc(r.docNo || '')} ${esc(r.client || '')}</h3><button class="x" onclick="closeChulgoChat()">×</button></div>
    <div id="chulgo-chat-thread" style="max-height:52vh;min-height:200px;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:6px 2px;background:var(--soft);border-radius:10px">${chulgoChatThreadHtml(r)}</div>
    <div style="display:flex;gap:8px;margin-top:10px"><input id="chulgo-chat-in" lang="ko" placeholder="메시지 입력 후 Enter" autocomplete="off" style="flex:1;font-size:15px;padding:11px 12px;border:1.5px solid var(--bd2);border-radius:10px" onkeydown="if(event.key==='Enter'){event.preventDefault();sendChulgoChat('${id}');}"><button class="btn btn-pri" onclick="sendChulgoChat('${id}')"><i class="ti ti-send"></i></button></div>`);
  chulgoMarkRead(id);
  setTimeout(() => { const t = el('chulgo-chat-thread'); if (t) t.scrollTop = t.scrollHeight; const i = el('chulgo-chat-in'); if (i) i.focus(); }, 60);
}
function closeChulgoChat() { _chulgoChatOpen = ''; closeModal(); }
async function chulgoMarkRead(id) { const mine = chulgoMineSide(); const patch = {}; if (mine === 'wh') patch.readWh = Date.now(); else patch.readOffice = Date.now(); try { await Store.update('chulgoReqs', id, patch); } catch (e) { } }
async function sendChulgoChat(id) {
  const inp = el('chulgo-chat-in'); const text = inp ? (inp.value || '').trim() : ''; if (!text) return;
  const r = (state.chulgoReqs || []).find(x => x.id === id); if (!r) return;
  const mine = chulgoMineSide();
  const chats = (r.chats || []).slice(); chats.push({ side: mine, name: (me && me.name) || '', text: text, at: Date.now() });
  const patch = { chats: chats }; if (mine === 'wh') patch.readWh = Date.now(); else patch.readOffice = Date.now();
  if (inp) inp.value = '';
  try { await Store.update('chulgoReqs', id, patch); } catch (e) { toast('전송 실패'); }
}
function refreshChulgoChatIfOpen() { if (!_chulgoChatOpen) return; const t = el('chulgo-chat-thread'); if (!t) return; const r = (state.chulgoReqs || []).find(x => x.id === _chulgoChatOpen); if (!r) return; const atBottom = t.scrollHeight - t.scrollTop - t.clientHeight < 40; t.innerHTML = chulgoChatThreadHtml(r); if (atBottom) t.scrollTop = t.scrollHeight; }
function renderSettings() {
  el('pg-settings').innerHTML = `
    <div class="ph"><div><h2><i class="ti ti-settings"></i>설정</h2><p>${esc(me.name)} 님${isAdmin() ? ' · 관리자' : ''}</p></div></div>
    <div class="card">
      <div class="card-h"><h3><i class="ti ti-users"></i>직원 관리</h3>${isAdmin() ? `<button class="more" onclick="openMemberForm()"><i class="ti ti-plus"></i>추가</button>` : ''}</div>
      ${state.members.map(m => `<div class="mem"><div class="av">${esc(initial(m.name))}</div><div class="info"><div class="nm">${esc(m.name)}</div>${isAdmin() ? `<div class="rl">${esc(m.email || '이메일 미설정')}</div>` : ''}</div>${isAdmin() ? `<span class="pill ${m.role === 'admin' ? 'p-prog' : (m.role === 'customer' ? 'p-hold' : (m.role === 'crew' ? 'p-wait' : 'p-gray'))}">${m.role === 'admin' ? '관리자' : (m.role === 'customer' ? '고객' : (m.role === 'crew' ? '시공팀' : '직원'))}</span><button class="x" onclick="openMemberForm('${m.id}')"><i class="ti ti-edit" style="font-size:17px"></i></button>` : ''}</div>`).join('')}
      ${isAdmin() && CLOUD ? `<button class="btn btn-block btn-sm" style="margin-top:10px" onclick="syncAllRolesNow()"><i class="ti ti-shield-check"></i>직원 권한 문서 동기화 <span style="color:var(--t3);font-weight:500">(보안규칙 적용 전 1회)</span></button>` : ''}
      ${isAdmin() && CLOUD ? `<button class="btn btn-block btn-sm" style="margin-top:8px" onclick="unifyFactories()"><i class="ti ti-building-factory-2"></i>공장명 통일 · 중복 정리 <span style="color:var(--t3);font-weight:500">(공장/시공팀/발주처/규격 중복 삭제)</span></button>` : ''}
    </div>
    <div class="card">
      <div class="card-h"><h3><i class="ti ti-briefcase"></i>거래처 관리</h3>${isAdmin() && (state.clients || []).length ? `<button class="more" style="color:var(--red-t)" onclick="delAllClients()"><i class="ti ti-trash" style="font-size:14px"></i>전체 삭제</button>` : ''}</div>
      <div style="display:flex;gap:8px;margin-bottom:10px"><input id="client-new" placeholder="거래처명 입력" autocomplete="off" style="flex:1;font-size:16px;padding:11px 12px;border:1.5px solid var(--bd2);border-radius:10px"><button class="btn btn-pri btn-sm" onclick="addClient()"><i class="ti ti-plus"></i>등록</button></div>
      ${(state.clients || []).length ? `<div id="client-scroll" data-keepscroll style="max-height:300px;overflow-y:auto;-webkit-overflow-scrolling:touch;border:0.5px solid var(--bd);border-radius:10px;padding:2px 8px">${state.clients.slice().sort((a, b) => (a.value || '').localeCompare(b.value || '')).map(c => `<div class="mem"><div class="info"><div class="nm">${esc(c.value)}</div></div>${isAdmin() ? `<button class="x" onclick="delClient('${c.id}')" aria-label="삭제"><i class="ti ti-trash" style="font-size:16px;color:var(--red-t)"></i></button>` : ''}</div>`).join('')}</div><div style="font-size:11.5px;color:var(--t3);margin-top:6px">총 ${(state.clients || []).length}개</div>` : `<div style="font-size:12.5px;color:var(--t3);padding:4px 0">등록된 거래처가 없습니다. 등록하면 현장·출고·홀딩의 업체명 검색에 나옵니다.</div>`}
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
    ${isAdmin() ? `<div class="card">
      <div class="card-h"><h3><i class="ti ti-plug-connected"></i>출고관리 앱 연동</h3></div>
      <div style="font-size:12.5px;color:var(--t2);margin-bottom:8px">출고·세면대 발주를 <b>출고관리 앱(dawoo-chulgo)</b>으로 전송합니다. 두 앱이 다른 Firebase라, 출고관리 앱에 만든 <b>수신 주소(엔드포인트)</b>로 보냅니다.</div>
      <div class="fld"><label>출고관리 수신 주소 (엔드포인트 URL)</label><input id="chulgo-ep" value="${esc(_chulgoEndpoint || '')}" placeholder="https://...cloudfunctions.net/receiveShipment" autocomplete="off" style="width:100%;font-size:14px;padding:10px 11px;border:1.5px solid var(--bd2);border-radius:10px"></div>
      <button class="btn btn-pri btn-sm btn-block" style="margin-top:8px" onclick="saveChulgoEndpoint()"><i class="ti ti-device-floppy"></i>수신 주소 저장</button>
      <div style="font-size:11.5px;color:var(--t2);margin-top:10px;line-height:1.6;background:var(--soft);border-radius:9px;padding:10px 12px">
        <b>출고관리 앱에 만들 '수신 창구' 규격</b> (그쪽 프로젝트에 추가):<br>
        · POST로 아래 JSON을 받아 <b>chulgo_requests</b> 문서로 저장하는 함수(HTTP) 1개.<br>
        · 받는 값: <span style="color:var(--t3)">source, kind('outbound'|'basin'), company, client, content, qty, sender, memo, dest, refId, refDate, status:'requested'</span><br>
        · 저장 시 kind·status·createdAt 등 출고관리 양식에 맞게 매핑하면 됩니다. CORS 허용 필요.
      </div>
    </div>` : ''}
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
      <div class="fld"><label>권한</label><select id="m-role"><option value="staff" ${v.role === 'staff' ? 'selected' : ''}>직원</option><option value="admin" ${v.role === 'admin' ? 'selected' : ''}>관리자</option><option value="customer" ${v.role === 'customer' ? 'selected' : ''}>고객(거래처) · 재고조회만</option><option value="crew" ${v.role === 'crew' ? 'selected' : ''}>시공팀 · 시공 스케줄만</option></select></div>
      <div class="fld full"><label>로그인 이메일<span class="req">*</span></label><input id="m-email" type="email" value="${esc(v.email || '')}" autocapitalize="none" spellcheck="false" placeholder="예) hong@dawoo.com"></div>
    </div>
    ${m && v.email ? `<div class="fld full" style="margin-bottom:12px"><label><i class="ti ti-key" style="font-size:13px;color:var(--blue)"></i> 비밀번호 변경 <span style="color:var(--t3);font-weight:500">— 메일 없이 바로 적용(가메일 계정 가능)</span></label>
      <div style="display:flex;gap:8px">
        <input id="m-newpw" type="text" autocapitalize="none" spellcheck="false" placeholder="새 비밀번호 (6자 이상)" style="flex:1">
        <button class="btn btn-pri btn-sm" type="button" style="flex:none" onclick="adminSetPw('${esc(v.email)}')"><i class="ti ti-check"></i>변경</button>
      </div></div>` : `<div class="banner info" style="margin:0 0 12px"><i class="ti ti-info-circle"></i>이 이메일로 Firebase 콘솔에서 계정(비밀번호)을 먼저 만들어야 로그인됩니다. 만든 뒤엔 여기서 비밀번호를 바로 바꿀 수 있습니다.</div>`}
    <div class="frm-foot">
      ${m && state.members.length > 1 ? `<button class="btn btn-danger" onclick="delMember('${id}')"><i class="ti ti-trash"></i></button>` : ''}
      <button class="btn btn-pri" style="flex:1" onclick="submitMember('${id || ''}')"><i class="ti ti-check"></i>저장</button>
    </div>`);
}
/* 관리자 전용: 계정 비밀번호 직접 변경 (가메일 계정용 · 메일 불필요) */
async function adminSetPw(email) {
  if (!isAdmin()) { toast('관리자만 가능합니다'); return; }
  if (!CLOUD || !auth || !auth.currentUser) { toast('클라우드 모드에서만 가능합니다'); return; }
  email = (email || '').trim().toLowerCase();
  const pw = (el('m-newpw') && el('m-newpw').value) || '';
  if (!email) { toast('이 계정의 로그인 이메일이 없습니다'); return; }
  if (pw.length < 6) { toast('비밀번호는 6자 이상 입력하세요'); return; }
  if (!confirm(email + '\n이 계정의 비밀번호를 변경할까요?')) return;
  try {
    const token = await auth.currentUser.getIdToken();
    const r = await fetch(PUSH_FN + '?action=setpw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ email: email, password: pw })
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok) { toast('비밀번호가 변경되었습니다 ✓'); if (el('m-newpw')) el('m-newpw').value = ''; }
    else if (r.status === 403) { toast('권한 없음 (관리자만)'); }
    else if (j.error === 'invalid input') { toast('이메일/비밀번호를 확인하세요 (6자 이상)'); }
    else if (r.status === 400 || (j.error && /EMAIL_NOT_FOUND|no user/i.test(j.error))) { toast('그 이메일로 만든 계정이 없습니다 (콘솔에서 먼저 생성)'); }
    else { toast('변경 실패: ' + (j.error || r.status)); }
  } catch (e) { toast('변경 실패: ' + (e && e.message || '')); }
}
async function submitMember(id) {
  const name = el('m-name').value.trim();
  const email = (el('m-email').value || '').trim().toLowerCase();
  if (!name || !email) { toast('이름과 로그인 이메일을 입력하세요'); return; }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast('이메일 형식을 확인하세요'); return; }
  if (state.members.some(m => m.id !== id && (m.email || '').toLowerCase() === email)) { toast('이미 등록된 이메일입니다'); return; }
  const obj = { name, role: el('m-role').value, email };
  const prevEmail = id ? ((state.members.find(m => m.id === id) || {}).email || '').toLowerCase() : '';
  if (id) await Store.update('members', id, obj); else await Store.add('members', obj);
  await setRoleDoc(email, obj.role, name, prevEmail);
  toast('저장됨'); closeModal();
}
async function setRoleDoc(email, role, name, prevEmail) {
  if (!CLOUD) return;
  try {
    if (prevEmail && prevEmail !== email) await cref('roles').doc(prevEmail).delete();
    await cref('roles').doc(email).set({ role: role || 'staff', name: name || '' });
  } catch (e) { console.warn('roles doc', e); }
}
async function delMember(id) {
  if (!guardDelete('이 직원 계정을 삭제할까요?')) return;
  const m = state.members.find(x => x.id === id);
  await Store.remove('members', id);
  if (m && m.email) { try { await cref('roles').doc((m.email || '').toLowerCase()).delete(); } catch (e) { } }
  toast('삭제됨'); closeModal();
}
async function addClient() {
  const v = (el('client-new') && el('client-new').value || '').trim();
  if (!v) { toast('거래처명을 입력하세요'); return; }
  if ((state.clients || []).some(c => c.value === v)) { toast('이미 등록된 거래처입니다'); el('client-new').value = ''; return; }
  await Store.add('clients', { value: v }); el('client-new').value = ''; toast('거래처 등록됨');
}
async function delClient(id) { if (!isAdmin()) return; if (!confirm('이 거래처를 삭제할까요?')) return; await Store.remove('clients', id); toast('삭제됨'); }
async function delAllClients() {
  if (!isAdmin()) return;
  if (!guardDelete('등록된 거래처를 전부 삭제할까요? 되돌릴 수 없습니다.')) return;
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
