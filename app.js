// ============================================================
//  주식회사 다우세라믹앤석재 — 수발주 / 입출고 / 홀딩 / 롯트 / 자재판매
// ============================================================

const KEY = 'tilemaster_v3';
const TEAM_KEY = 'tilemaster_team';
const USER_KEY = 'tilemaster_user';

let currentUser = (() => {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); }
  catch { return null; }
})();
let siteFilter = 'all';
let stockQuery = '';
let pendingHoldForOrder = null;  // 홀딩에서 발주로 넘어갈 때 임시 저장
const COLLECTIONS = ['sites','sales','orders','materials','txns','holds','managers','crews','factories','history'];
const defaultDB = { sites:[], sales:[], orders:[], materials:[], txns:[], holds:[], managers:[], crews:[], factories:[], history:[] };

let db = structuredClone(defaultDB);
let mode = 'local';
let teamCode = localStorage.getItem(TEAM_KEY) || '';
let fs = null;
let unsubs = [];

// ===== Firebase init =====
const cfg = window.FIREBASE_CONFIG;
const cfgOk = cfg && cfg.apiKey && !/여기에/.test(cfg.apiKey) && cfg.projectId;

if (cfgOk) {
  try {
    const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js');
    const firestore = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
    const app = initializeApp(cfg);
    fs = { db: firestore.getFirestore(app), ...firestore };
    mode = 'cloud';
  } catch (e) {
    console.warn('Firebase 로드 실패 → 로컬 모드:', e);
    mode = 'local';
  }
}

// ===== Storage =====
function loadLocal() {
  try {
    const raw = localStorage.getItem(KEY);
    db = raw ? { ...structuredClone(defaultDB), ...JSON.parse(raw) } : structuredClone(defaultDB);
  } catch { db = structuredClone(defaultDB); }
}
function saveLocal() { localStorage.setItem(KEY, JSON.stringify(db)); }

function colRef(name) { return fs.collection(fs.db, 'teams', teamCode, name); }
function clearSubs() { unsubs.forEach(u => u && u()); unsubs = []; }

async function startCloudSync() {
  if (mode !== 'cloud' || !teamCode) return;
  clearSubs();
  db = structuredClone(defaultDB);
  COLLECTIONS.forEach(name => {
    const q = fs.query(colRef(name), fs.orderBy('createdAt', 'desc'));
    const un = fs.onSnapshot(q, snap => {
      db[name] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      render();
    }, err => {
      console.error('Firestore 구독 오류:', err);
      toast('동기화 오류: ' + (err.message || err.code), true);
    });
    unsubs.push(un);
  });
}

async function cloudAdd(name, data) {
  data.createdAt = data.createdAt || new Date().toISOString();
  if (data.id) {
    // setDoc with our pre-generated UID so the Firestore doc ID
    // matches data.id (needed for cross-collection references)
    await fs.setDoc(fs.doc(fs.db, 'teams', teamCode, name, data.id), data);
    return data.id;
  }
  const ref = await fs.addDoc(colRef(name), data);
  return ref.id;
}
async function cloudDel(name, id) {
  await fs.deleteDoc(fs.doc(fs.db, 'teams', teamCode, name, id));
}
async function cloudUpdate(name, id, patch) {
  await fs.updateDoc(fs.doc(fs.db, 'teams', teamCode, name, id), patch);
}
async function cloudClear(name) {
  const snap = await fs.getDocs(colRef(name));
  await Promise.all(snap.docs.map(d => fs.deleteDoc(d.ref)));
}

// ===== Universal CRUD =====
async function addRecord(name, data) {
  data.id = data.id || uid();
  data.createdAt = data.createdAt || new Date().toISOString();
  // 모든 신규 레코드에 작성자 자동 기록 (입출고/홀딩/판매/발주 등 전부)
  if (!data.createdBy) {
    data.createdBy = {
      id: (currentUser && currentUser.id) || '',
      name: (currentUser && currentUser.name) || ''
    };
  }
  if (mode === 'cloud' && teamCode) {
    await cloudAdd(name, data);
  } else {
    db[name].unshift(data);
    saveLocal(); render();
  }
  return data.id;
}
async function removeRecord(name, id) {
  if (mode === 'cloud' && teamCode) await cloudDel(name, id);
  else { db[name] = db[name].filter(x => x.id !== id); saveLocal(); render(); }
}
async function updateRecord(name, id, patch) {
  if (mode === 'cloud' && teamCode) await cloudUpdate(name, id, patch);
  else {
    const i = db[name].findIndex(x => x.id === id);
    if (i >= 0) { db[name][i] = { ...db[name][i], ...patch }; saveLocal(); render(); }
  }
}
async function clearCollection(name) {
  if (mode === 'cloud' && teamCode) await cloudClear(name);
  else { db[name] = []; saveLocal(); render(); }
}

async function logHistory(action, target, detail) {
  const entry = {
    id: uid(),
    action, target, detail: detail||'',
    userId: (currentUser && currentUser.id) || '',
    userName: (currentUser && currentUser.name) || '',
    at: new Date().toISOString(),
    createdAt: new Date().toISOString()
  };
  if (mode === 'cloud' && teamCode) await cloudAdd('history', entry);
  else { db.history.unshift(entry); if (db.history.length > 300) db.history.pop(); saveLocal(); }
}

// ===== Inventory math =====
function materialStock(materialId, lotNo, pattern) {
  let inn = 0, out = 0;
  db.txns.forEach(t => {
    if (t.materialId !== materialId) return;
    if (lotNo !== undefined && t.lotNo !== lotNo) return;
    if (pattern !== undefined && (t.pattern || '') !== pattern) return;
    if (t.type === 'in') inn += Number(t.qty)||0;
    else if (t.type === 'out') out += Number(t.qty)||0;
    else if (t.type === 'adjust') inn += Number(t.qty)||0;
  });
  return inn - out;
}
function materialHeld(materialId, lotNo, pattern) {
  return db.holds.filter(h =>
    (h.status === 'active' || h.status === 'order_placed') &&
    h.materialId === materialId &&
    (lotNo === undefined || h.lotNo === lotNo) &&
    (pattern === undefined || (h.pattern || '') === pattern)
  ).reduce((s,h) => s + (Number(h.qty)||0), 0);
}
// 규격 문자열에서 m² (1장 면적) 계산. "3200*1600*12(MM)" / "600x600" 등
function specToM2(spec) {
  if (!spec) return 0;
  const m = String(spec).match(/(\d+)\s*[*xX×]\s*(\d+)/);
  if (!m) return 0;
  const w = Number(m[1]), h = Number(m[2]);
  if (!w || !h) return 0;
  return (w * h) / 1_000_000;  // mm² → m²
}

// "2장 · 0.72m²" / "50장 · 5박스 · 18.00m²" 형태 표기
function formatQty(materialId, qty) {
  const m = db.materials.find(x => x.id === materialId);
  const unit = (m && m.unit) || '장';
  const perBox = m && m.perBox ? Number(m.perBox) : 0;
  const m2per = m ? specToM2(m.spec) : 0;
  const n = Number(qty) || 0;
  const parts = [`${n}${unit}`];
  if (perBox > 0 && unit !== '박스') {
    const boxes = Math.floor(n / perBox);
    const rem = n - boxes * perBox;
    if (boxes > 0) {
      parts.push(rem ? `${boxes}박스 +${rem}${unit}` : `${boxes}박스`);
    }
  }
  if (m2per > 0) {
    const total = n * m2per;
    parts.push(`${total.toFixed(2)}㎡`);
  }
  return parts.join(' · ');
}

function lotsOf(materialId) {
  // lots are derived from 'in' transactions
  const map = new Map();
  db.txns.filter(t => t.type === 'in' && t.materialId === materialId).forEach(t => {
    if (!map.has(t.lotNo)) map.set(t.lotNo, { lotNo: t.lotNo, firstIn: t.date || t.createdAt });
  });
  return [...map.values()];
}

// ===== Boot =====
if (mode === 'cloud' && teamCode) await startCloudSync();
else { loadLocal(); }

updateStatus(); render(); updateUserChip();
maybePromptUser();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  });
}

// ===== Tabs =====
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const t = btn.dataset.tab;
    ['site','sale','order','stock','hold','history'].forEach(k => {
      document.getElementById('panel-' + k).classList.toggle('hidden', k !== t);
    });
  });
});

// ===== Current User & Permissions =====
function isAdmin() { return !!(currentUser && currentUser.role === 'admin'); }

function updateUserChip() {
  const el = document.getElementById('user-chip');
  if (el) {
    if (currentUser && currentUser.name) {
      el.textContent = currentUser.name + (currentUser.role === 'admin' ? ' · 관리자' : '');
      el.classList.add('set');
    } else {
      el.textContent = '내 이름 선택';
      el.classList.remove('set');
    }
  }
  // body 클래스로 UI 전체 토글: 관리자 전용 / 게스트 잠금
  document.body.classList.toggle('is-admin', isAdmin());
  document.body.classList.toggle('no-user', !currentUser);
}

window.saveUser = function() {
  const sel = document.getElementById('user-select');
  const custom = val('user-custom');
  const adminCheck = document.getElementById('user-admin');
  let user = null;
  if (custom) {
    user = { id: 'custom:' + custom, name: custom };
  } else if (sel && sel.value) {
    const m = db.managers.find(x => x.id === sel.value);
    if (m) user = { id: m.id, name: m.name + (m.title ? ' ' + m.title : '') };
  }
  if (!user) return alert('이름을 선택하거나 직접 입력하세요.');
  user.role = adminCheck && adminCheck.checked ? 'admin' : 'user';
  const wasNotUserBefore = !currentUser;
  currentUser = user;
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  updateUserChip();
  render();  // setup-card 갱신
  closeModal('user');
  toast(`'${user.name}'${user.role==='admin' ? ' (관리자)':''}로 설정됨`);
  // 처음 로그인한 관리자인데 담당자가 비어있으면 즉시 담당자 등록 모달
  if (wasNotUserBefore && user.role === 'admin' && db.managers.length === 0) {
    setTimeout(() => openModal('managers'), 400);
  }
};
window.clearUser = function() {
  if (!currentUser) return;  // 이미 없음
  if (!confirm('내 이름 설정을 지울까요? (앱 사용이 잠깁니다)')) return;
  currentUser = null;
  localStorage.removeItem(USER_KEY);
  updateUserChip();
  closeModal('user');
  setTimeout(() => openModal('user'), 200);  // 다시 즉시 표시
};

// 액션 가드 — currentUser 없으면 모달 띄움
function requireUser() {
  if (!currentUser) {
    alert('먼저 "내 이름"을 설정해주세요.');
    openModal('user');
    return false;
  }
  return true;
}
function requireAdmin() {
  if (!requireUser()) return false;
  if (!isAdmin()) {
    alert('관리자 권한이 필요합니다.\n("내 이름" 설정에서 관리자 권한 체크)');
    return false;
  }
  return true;
}

// 부팅 시 사용자 미설정이면 즉시 강제 모달
function maybePromptUser() {
  if (!currentUser) setTimeout(() => openModal('user'), 200);
}

// ===== Status =====
function updateStatus() {
  const el = document.getElementById('status');
  const tx = document.getElementById('statusText');
  const nt = document.getElementById('noticeText');
  const chip = document.getElementById('teamChip');
  chip.textContent = teamCode ? teamCode : '— 설정 안 됨 —';
  el.classList.remove('ok','local');
  if (mode === 'cloud' && teamCode) {
    el.classList.add('ok'); tx.textContent = '실시간 공유 중 · ' + teamCode;
    nt.textContent = `팀 코드 "${teamCode}" 의 모든 사람이 같은 데이터를 실시간으로 공유합니다.`;
  } else if (mode === 'cloud') {
    el.classList.add('local'); tx.textContent = '팀 코드 필요';
    nt.textContent = '오른쪽 위 상태 또는 "팀 코드" 칩을 눌러 코드를 설정하세요.';
  } else {
    el.classList.add('local'); tx.textContent = '로컬 저장 모드';
    nt.textContent = 'Firebase 설정이 없어 본인 기기에만 저장됩니다. firebase-config.js 를 채우면 자동으로 실시간 공유로 전환됩니다.';
  }
}

// ===== Modals =====
window.openModal = function(type) {
  // 'user'/'team' 모달 외에는 사용자 설정 필수
  if (type !== 'user' && type !== 'team' && !requireUser()) return;
  // 마스터 편집 모달은 관리자만
  if ((type === 'managers' || type === 'crews' || type === 'factories') && !requireAdmin()) return;

  if (type === 'team') document.getElementById('team-code').value = teamCode;
  if (type === 'site') {
    fillSelect('site-crew', crewOptions());
    fillSelect('site-factory', factoryOptions());
    // 담당자는 선택 없이 현재 사용자로 자동 — 정적 표시만
    const disp = document.getElementById('site-manager-display');
    if (disp) disp.textContent = (currentUser && currentUser.name) || '(미설정)';
    // 실측일자 활성화 상태 리셋 (이전 도면발주 선택 잔재 제거)
    const md = document.getElementById('site-measure-date');
    if (md) { md.disabled = false; md.style.opacity = ''; md.style.cursor = ''; }
  }
  if (type === 'order') {
    fillSelect('order-site', [{value:'',label:'(현장 선택)'},
      ...db.sites.map(s => ({
        value: s.id,
        label: (s.customer || s.name || '(이름없음)') + (s.customer && s.name ? ' · ' + s.name : '')
      }))]);
    fillSelect('order-factory', factoryOptions());
    fillSelect('order-item-select', [{value:'',label:'(직접 입력)'}, ...materialOptions(false)]);
    // 발주일 기본 = 오늘
    const dateInp = document.getElementById('order-date');
    if (dateInp && !dateInp.value) dateInp.value = todayISO();
    // 담당자 자동 = 내 이름 (정적 표시)
    const disp = document.getElementById('order-manager-display');
    if (disp) disp.textContent = (currentUser && currentUser.name) || '(미설정)';
  }
  if (type === 'in') {
    fillSelect('in-material', materialOptions(true));
    fillSelect('in-factory', factoryOptions());
    onInMaterialChange();  // 첫 자재 기준으로 패턴 UI 갱신
    // 과거 사용 롯트를 최근순으로 모음
    const seen = new Map();
    db.txns.forEach(t => {
      if (!t.lotNo) return;
      const at = t.createdAt || '';
      if (!seen.has(t.lotNo) || at > seen.get(t.lotNo)) seen.set(t.lotNo, at);
    });
    const sorted = [...seen.entries()].sort((a,b) => b[1].localeCompare(a[1])).map(e => e[0]);
    // datalist (PC 자동완성)
    const dl = document.getElementById('in-lot-list');
    if (dl) dl.innerHTML = sorted.map(l => `<option value="${escape(l)}"></option>`).join('');
    // 칩 (모바일 친화 — 탭 한 번에 입력)
    const chips = document.getElementById('in-lot-chips');
    if (chips) {
      if (sorted.length === 0) {
        chips.innerHTML = '<span class="chip-empty">아직 사용한 롯트 없음</span>';
      } else {
        chips.innerHTML = '<span class="chip-label">최근 사용:</span>' +
          sorted.slice(0, 10).map(l =>
            `<span class="chip" onclick="document.getElementById('in-lot').value='${esc(l)}'">${esc(l)}</span>`
          ).join('');
      }
    }
  }
  if (type === 'out') { fillSelect('out-material', materialOptions(false)); fillOutLots(); }
  if (type === 'hold') {
    fillSelect('hold-material', materialOptions(false));
    fillHoldLots();
    fillHoldCustomers();
    // 예약일 기본 = 오늘
    const startInp = document.getElementById('hold-start');
    if (startInp && !startInp.value) startInp.value = todayISO();
  }
  if (type === 'sale') {
    fillSelect('sale-factory', factoryOptions());
    document.getElementById('sale-items').innerHTML = '';
    addSaleItem();
    // 담당자 자동 = 내 이름 (정적 표시)
    const disp = document.getElementById('sale-manager-display');
    if (disp) disp.textContent = (currentUser && currentUser.name) || '(미설정)';
  }
  if (type === 'user') {
    fillSelect('user-select', [
      {value:'', label: db.managers.length ? '(담당자 목록에서 선택)' : '(등록된 담당자 없음 — 직접 입력)'},
      ...db.managers.map(m => ({value: m.id, label: m.name + (m.title ? ' ' + m.title : '')}))
    ]);
    document.getElementById('user-custom').value = '';
    const adminCheck = document.getElementById('user-admin');
    if (adminCheck) adminCheck.checked = !!(currentUser && currentUser.role === 'admin');
    if (currentUser && currentUser.id && !currentUser.id.startsWith('custom:')) {
      const sel = document.getElementById('user-select');
      if (sel) sel.value = currentUser.id;
    } else if (currentUser && currentUser.id && currentUser.id.startsWith('custom:')) {
      document.getElementById('user-custom').value = currentUser.name;
    }
    // 사용자가 아직 설정되지 않았다면 취소/지우기 버튼 숨김 → 강제 입력
    const cancelBtn = document.getElementById('user-cancel');
    const clearBtn = document.getElementById('user-clear');
    if (cancelBtn) cancelBtn.style.display = currentUser ? '' : 'none';
    if (clearBtn) clearBtn.style.display = currentUser ? '' : 'none';
  }
  if (type === 'material') fillMaterialSpecOptions();
  if (type === 'managers') renderManagersList();
  if (type === 'crews') renderCrewsList();
  if (type === 'factories') renderFactoriesList();
  document.getElementById('modal-' + type).classList.add('open');
};
window.closeModal = function(type) {
  if (type === 'order') pendingHoldForOrder = null;  // 발주 모달 닫으면 pending 해제
  document.getElementById('modal-' + type).classList.remove('open');
};
document.querySelectorAll('.modal-bg').forEach(bg => {
  bg.addEventListener('click', e => {
    if (e.target !== bg) return;
    // 사용자 미설정 상태에서 user 모달 잠금
    if (bg.id === 'modal-user' && !currentUser) return;
    bg.classList.remove('open');
  });
});

function fillSelect(id, opts) {
  document.getElementById(id).innerHTML = opts.map(o =>
    `<option value="${escape(o.value)}">${escape(o.label)}</option>`).join('');
}
function materialOptions(includeBlank) {
  const opts = db.materials.map(m => ({
    value: m.id,
    label: `${m.name}${m.spec ? ' · ' + m.spec : ''}`
  }));
  return includeBlank && opts.length === 0
    ? [{value:'',label:'(자재가 없습니다 — 먼저 자재 등록)'}]
    : opts;
}
function managerOptions(includeBlank = true) {
  const opts = db.managers.map(m => ({
    value: m.id,
    label: m.name + (m.title ? ' ' + m.title : '')
  }));
  return includeBlank ? [{value:'', label:'(선택 안 함)'}, ...opts] : opts;
}
function managerLabel(id) {
  if (!id) return '';
  const m = db.managers.find(x => x.id === id);
  return m ? m.name + (m.title ? ' ' + m.title : '') : String(id || '');
}
// 우측 표시용 manager-tag HTML. record.managerId / record.manager / record.managerName 폴백
function managerTag(record) {
  const name = managerLabel(record?.managerId)
    || record?.managerName
    || record?.manager
    || '';
  if (!name) return '';
  return `<div class="manager-tag"><span class="lbl">담당</span><span class="nm">${esc(name)}</span></div>`;
}
// 현재 사용자가 담당자 마스터에 있으면 그 ID 반환 (커스텀 입력 사용자는 매칭 시도)
function defaultManagerId() {
  if (!currentUser) return '';
  // 1) 사용자가 담당자 목록에서 선택했던 경우 → ID 그대로
  if (currentUser.id && db.managers.find(m => m.id === currentUser.id)) return currentUser.id;
  // 2) 커스텀 이름이지만 같은 이름·직책 담당자가 있으면 매칭
  if (currentUser.name) {
    const match = db.managers.find(m => {
      const label = m.name + (m.title ? ' ' + m.title : '');
      return label === currentUser.name || m.name === currentUser.name;
    });
    if (match) return match.id;
  }
  return '';
}

function refreshManagerSelects() {
  // 현재 select 없음 — 관리자가 마스터 편집해도 폼은 정적 표시라 영향 없음
  // (필요 시 정적 표시 갱신)
  ['site-manager-display','order-manager-display','sale-manager-display'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = (currentUser && currentUser.name) || '(미설정)';
  });
}
function crewOptions(includeBlank = true) {
  const opts = db.crews.map(c => ({
    value: c.id,
    label: c.name + (c.leader ? ' (' + c.leader + ')' : '')
  }));
  return includeBlank ? [{value:'', label:'(선택 안 함)'}, ...opts] : opts;
}
function crewLabel(id) {
  if (!id) return '';
  const c = db.crews.find(x => x.id === id);
  return c ? c.name + (c.leader ? ' (' + c.leader + ')' : '') : String(id || '');
}
function refreshCrewSelects() {
  const el = document.getElementById('site-crew');
  if (el && el.tagName === 'SELECT') {
    const current = el.value;
    el.innerHTML = crewOptions().map(o =>
      `<option value="${escape(o.value)}">${escape(o.label)}</option>`).join('');
    el.value = current;
  }
}
function factoryOptions(includeBlank = true) {
  const opts = db.factories.map(f => ({
    value: f.id,
    label: f.name + (f.contact ? ' (' + f.contact + ')' : '')
  }));
  return includeBlank ? [{value:'', label:'(선택 안 함)'}, ...opts] : opts;
}
function factoryLabel(id) {
  if (!id) return '';
  const f = db.factories.find(x => x.id === id);
  return f ? f.name : String(id || '');
}
function refreshFactorySelects() {
  ['order-factory','site-factory','sale-factory','in-factory'].forEach(id => {
    const el = document.getElementById(id);
    if (el && el.tagName === 'SELECT') {
      const current = el.value;
      el.innerHTML = factoryOptions().map(o =>
        `<option value="${escape(o.value)}">${escape(o.label)}</option>`).join('');
      el.value = current;
    }
  });
}
// 롯트×패턴 조합을 옵션으로 — value: "lot|pattern"
function lotPatternOptions(matId, requireAvail = true) {
  const mat = db.materials.find(m => m.id === matId);
  const patterns = (mat && Array.isArray(mat.patterns) && mat.patterns.length > 0) ? mat.patterns : [''];
  const out = [];
  lotsOf(matId).forEach(l => {
    patterns.forEach(p => {
      const stock = materialStock(matId, l.lotNo, p);
      const held = materialHeld(matId, l.lotNo, p);
      const avail = stock - held;
      if (requireAvail && avail <= 0) return;
      if (!requireAvail && stock === 0) return;
      const label = p
        ? `${l.lotNo} · 패턴 ${p} (가용 ${avail})`
        : `${l.lotNo} (가용 ${avail})`;
      out.push({ value: l.lotNo + '|' + p, label });
    });
  });
  return out;
}
window.fillOutLots = function() {
  const matId = document.getElementById('out-material').value;
  const opts = lotPatternOptions(matId, true);
  fillSelect('out-lot',
    opts.length === 0 ? [{value:'',label:'(가용 롯트가 없습니다)'}] : opts
  );
};
window.fillHoldCustomers = function() {
  // Aggregate distinct customer names from sites + sales + previous holds
  const set = new Set();
  db.sites.forEach(s => { if (s.customer) set.add(s.customer); if (s.name) set.add(s.name); });
  db.sales.forEach(s => { if (s.customer) set.add(s.customer); });
  db.holds.forEach(h => { if (h.reservedFor) set.add(h.reservedFor); });
  const dl = document.getElementById('hold-customers');
  if (dl) {
    dl.innerHTML = [...set].sort().map(n => `<option value="${escape(n)}"></option>`).join('');
  }
};
window.fillHoldLots = function() {
  const matId = document.getElementById('hold-material').value;
  const opts = lotPatternOptions(matId, false);
  fillSelect('hold-lot',
    opts.length === 0 ? [{value:'',label:'(롯트가 없습니다 — 먼저 입고)'}] : opts
  );
};

// ===== Team code =====
window.setTeamCode = async function() {
  const v = document.getElementById('team-code').value.trim()
            .replace(/[^a-zA-Z0-9\-_]/g, '').toLowerCase();
  if (!v) return alert('팀 코드를 입력하세요.');
  teamCode = v; localStorage.setItem(TEAM_KEY, v);
  closeModal('team'); updateStatus();
  if (mode === 'cloud') { toast('팀 코드 적용 · 동기화 시작'); await startCloudSync(); }
  else toast('팀 코드 저장 (로컬 모드)');
};

// ===== Managers (담당자) =====
window.addManager = async function() {
  if (!requireAdmin()) return;
  const name = val('manager-name'), title = val('manager-title');
  if (!name) return alert('이름을 입력하세요.');
  await addRecord('managers', { name, title });
  await logHistory('담당자 추가', name + (title ? ' ' + title : ''));
  ['manager-name','manager-title'].forEach(id => document.getElementById(id).value = '');
  renderManagersList();
  refreshManagerSelects();
  toast('담당자 추가');
};
window.removeManager = async function(id) {
  if (!requireAdmin()) return;
  const m = db.managers.find(x => x.id === id);
  if (!confirm(`담당자 "${m?.name}${m?.title ? ' ' + m.title : ''}" 를 삭제할까요?`)) return;
  await removeRecord('managers', id);
  await logHistory('담당자 삭제', m?.name || '');
  renderManagersList();
  refreshManagerSelects();
};

// ===== Crews (시공팀) =====
window.addCrew = async function() {
  if (!requireAdmin()) return;
  const name = val('crew-name');
  if (!name) return alert('팀명을 입력하세요.');
  await addRecord('crews', {
    name,
    leader: val('crew-leader'),
    phone: val('crew-phone')
  });
  await logHistory('시공팀 추가', name);
  ['crew-name','crew-leader','crew-phone'].forEach(id => document.getElementById(id).value = '');
  renderCrewsList();
  refreshCrewSelects();
  toast('시공팀 추가');
};
window.removeCrew = async function(id) {
  if (!requireAdmin()) return;
  const c = db.crews.find(x => x.id === id);
  if (!confirm(`시공팀 "${c?.name}" 을 삭제할까요?`)) return;
  await removeRecord('crews', id);
  await logHistory('시공팀 삭제', c?.name || '');
  renderCrewsList();
  refreshCrewSelects();
};

// ===== Factories (공장 마스터) =====
window.addFactory = async function() {
  if (!requireAdmin()) return;
  const name = val('factory-name');
  if (!name) return alert('공장명을 입력하세요.');
  await addRecord('factories', {
    name,
    contact: val('factory-contact'),
    note: val('factory-note')
  });
  await logHistory('공장 추가', name);
  ['factory-name','factory-contact','factory-note'].forEach(id => document.getElementById(id).value = '');
  renderFactoriesList();
  refreshFactorySelects();
  toast('공장 추가');
};
window.removeFactory = async function(id) {
  if (!requireAdmin()) return;
  const f = db.factories.find(x => x.id === id);
  if (!confirm(`공장 "${f?.name}" 을 삭제할까요?`)) return;
  await removeRecord('factories', id);
  await logHistory('공장 삭제', f?.name || '');
  renderFactoriesList();
  refreshFactorySelects();
};

// 실측 여부 변경 시 → 도면발주면 실측일자 비활성화
window.onMeasureChange = function() {
  const sel = document.getElementById('site-measure');
  const dateInp = document.getElementById('site-measure-date');
  if (!sel || !dateInp) return;
  if (sel.value === 'drawing') {
    dateInp.value = '';
    dateInp.disabled = true;
    dateInp.style.opacity = '0.5';
    dateInp.style.cursor = 'not-allowed';
  } else {
    dateInp.disabled = false;
    dateInp.style.opacity = '';
    dateInp.style.cursor = '';
  }
};

// ===== Sites (시공현장) =====
window.addSite = async function() {
  const customer = val('site-customer');
  const name = val('site-name');
  const addr = val('site-addr');
  const crewId = val('site-crew');
  const measureType = val('site-measure');     // '' | 'measured' | 'drawing'
  const measureDate = val('site-measure-date');
  const installDate = val('site-install-date');
  if (!customer) return alert('거래처를 입력하세요.');
  if (!addr) return alert('주소를 입력하세요.');
  if (!crewId) return alert('시공팀을 선택하세요. (없으면 + 버튼으로 추가)');
  if (!measureType) return alert('실측 여부를 선택하세요. (실측 완료 / 도면발주)');
  if (!installDate) return alert('시공 일자를 입력하세요.');
  const data = {
    name, customer, addr,
    crewId,
    // 담당자 = 현재 사용자 자동
    managerId: defaultManagerId() || '',
    managerName: (currentUser && currentUser.name) || '',
    factoryId: val('site-factory'),
    status: val('site-status'),
    measureType,                                       // 'measured' | 'drawing'
    measureDone: measureType === 'measured',           // 옛 필드 호환
    measureDate: measureType === 'drawing' ? '' : measureDate,
    installDate,
    note: val('site-note')
  };
  await addRecord('sites', data);
  await logHistory('현장 추가', customer + (name ? ' / ' + name : ''));
  ['site-name','site-customer','site-addr','site-factory',
   'site-measure','site-measure-date','site-install-date','site-note']
    .forEach(id => document.getElementById(id).value = '');
  closeModal('site'); toast('저장됨');
};
window.removeSite = async function(id) {
  const s = db.sites.find(x => x.id === id);
  const label = s?.customer || s?.name || '';
  if (!confirm(`"${label}" 현장을 삭제할까요?`)) return;
  await removeRecord('sites', id);
  await logHistory('현장 삭제', label);
};

// ===== Sales (자재판매) =====
let saleItemCounter = 0;
window.addSaleItem = function() {
  saleItemCounter++;
  const i = saleItemCounter;
  const matOpts = materialOptions(false);
  if (matOpts.length === 0) {
    toast('먼저 자재를 등록하세요 (재고 탭 → 자재 등록)', true);
    return;
  }
  const div = document.createElement('div');
  div.className = 'sale-item';
  div.dataset.idx = i;
  div.innerHTML = `
    <div class="row">
      <select onchange="updateSaleItemLot(${i})">
        ${matOpts.map(o => `<option value="${escape(o.value)}">${escape(o.label)}</option>`).join('')}
      </select>
      <input type="number" inputmode="numeric" placeholder="수량" />
      <select><option value="">롯트 선택</option></select>
      <button type="button" class="rm" onclick="this.closest('.sale-item').remove()">×</button>
    </div>`;
  document.getElementById('sale-items').appendChild(div);
  updateSaleItemLot(i);
};
window.updateSaleItemLot = function(i) {
  const div = document.querySelector(`.sale-item[data-idx="${i}"]`);
  if (!div) return;
  const matSel = div.querySelector('select');
  const lotSel = div.querySelectorAll('select')[1];
  const matId = matSel.value;
  const lots = lotsOf(matId);
  lotSel.innerHTML = lots.length === 0
    ? '<option value="">(롯트 없음)</option>'
    : lots.map(l => {
        const a = materialStock(matId,l.lotNo) - materialHeld(matId,l.lotNo);
        return `<option value="${escape(l.lotNo)}">${escape(l.lotNo)} (가용 ${a})</option>`;
      }).join('');
};
window.addSale = async function() {
  const customer = val('sale-customer');
  if (!customer) return alert('거래처를 입력하세요.');
  const items = [];
  document.querySelectorAll('.sale-item').forEach(div => {
    const selects = div.querySelectorAll('select');
    const qty = Number(div.querySelector('input').value)||0;
    const materialId = selects[0].value;
    const lotNo = selects[1].value;
    if (materialId && qty > 0) {
      const mat = db.materials.find(m => m.id === materialId);
      items.push({ materialId, lotNo, qty, materialName: mat?.name||'', spec: mat?.spec||'' });
    }
  });
  if (items.length === 0) return alert('판매 자재를 1개 이상 추가하세요.');

  // 재고 검증
  for (const it of items) {
    const avail = materialStock(it.materialId, it.lotNo) - materialHeld(it.materialId, it.lotNo);
    if (it.qty > avail) {
      const mat = db.materials.find(m => m.id === it.materialId);
      return alert(`재고 부족: ${mat?.name} (롯트 ${it.lotNo}) 가용 ${avail}, 요청 ${it.qty}`);
    }
  }

  const sale = {
    customer, shipTo: val('sale-shipto'),
    factoryId: val('sale-factory'),
   