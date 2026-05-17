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
    managerId: defaultManagerId() || '',
    managerName: (currentUser && currentUser.name) || '',
    saleDate: val('sale-date') || todayISO(),
    items, note: val('sale-note'), status: '출고완료'
  };
  const saleId = await addRecord('sales', sale);

  // 자동 출고 트랜잭션 생성
  for (const it of items) {
    await addRecord('txns', {
      type: 'out', materialId: it.materialId, lotNo: it.lotNo,
      qty: it.qty, date: sale.saleDate,
      source: 'sale', refId: saleId,
      refLabel: `[판매] ${customer}${val('sale-shipto') ? ' / '+val('sale-shipto'):''}`,
      note: it.materialName
    });
  }
  await logHistory('자재판매', customer, `${items.length}건 출고`);
  ['sale-customer','sale-shipto','sale-factory','sale-date','sale-note'].forEach(id => document.getElementById(id).value = '');
  closeModal('sale'); toast('판매 저장 · 출고 완료');
};
window.removeSale = async function(id) {
  const s = db.sales.find(x => x.id === id);
  if (!confirm(`"${s?.customer}" 판매 건을 삭제할까요? (관련 출고도 취소됩니다)`)) return;
  // 관련 트랜잭션도 삭제
  const related = db.txns.filter(t => t.source === 'sale' && t.refId === id);
  for (const t of related) await removeRecord('txns', t.id);
  await removeRecord('sales', id);
  await logHistory('판매 삭제', s?.customer||'', '관련 출고 취소');
};

// 다우세라믹앤석재 자주 쓰는 규격
const COMMON_SPECS = [
  '3200*1600*12(MM)',
  '2700*1200*6(MM)',
  '2700*1200*9(MM)',
  '1200*600',
  '600*600'
];

function fillMaterialSpecOptions() {
  const usedSpecs = [...new Set(db.materials.map(m => m.spec).filter(Boolean))];
  // 자주 쓰는 규격 먼저(지정 순서 유지), 그 뒤에 사용된 적 있지만 목록에 없는 것들
  const extras = usedSpecs.filter(s => !COMMON_SPECS.includes(s)).sort((a,b)=>a.localeCompare(b,'ko'));
  const all = [...COMMON_SPECS, ...extras];
  const opts = [
    {value:'', label:'(선택 안 함)'},
    ...all.map(s => ({value: s, label: s})),
    {value: '__custom__', label: '+ 직접 입력...'}
  ];
  fillSelect('material-spec-select', opts);
  const inp = document.getElementById('material-spec');
  if (inp) { inp.value = ''; inp.classList.add('hidden'); }
}

window.onMaterialSpecChange = function() {
  const sel = document.getElementById('material-spec-select');
  const inp = document.getElementById('material-spec');
  if (!sel || !inp) return;
  if (sel.value === '__custom__') {
    inp.classList.remove('hidden');
    inp.value = '';
    inp.focus();
  } else {
    inp.classList.add('hidden');
    inp.value = sel.value;
  }
};

// 입고 모달: 자재 변경 시 패턴별 입력란 동적 생성
window.onInMaterialChange = function() {
  const sel = document.getElementById('in-material');
  const matId = sel ? sel.value : '';
  const mat = matId ? db.materials.find(m => m.id === matId) : null;
  const single = document.getElementById('in-qty');
  const patternsBox = document.getElementById('in-qty-patterns');
  const label = document.getElementById('in-qty-label');
  if (!single || !patternsBox || !label) return;
  const patterns = (mat && Array.isArray(mat.patterns)) ? mat.patterns : [];
  if (patterns.length === 0) {
    label.textContent = '수량 *';
    single.classList.remove('hidden');
    patternsBox.classList.add('hidden');
    patternsBox.innerHTML = '';
  } else {
    label.textContent = '패턴별 수량 * ' + `(${patterns.length}개)`;
    single.classList.add('hidden');
    single.value = '';
    patternsBox.classList.remove('hidden');
    patternsBox.innerHTML = `<div class="pattern-grid">${patterns.map(p => `
      <div class="pattern-row">
        <span class="pattern-label">패턴 ${esc(p)}</span>
        <input type="number" inputmode="numeric" placeholder="0" data-pattern="${esc(p)}" min="0" />
      </div>`).join('')}</div>`;
  }
};

window.onOrderMaterialChange = function() {
  const sel = document.getElementById('order-item-select');
  const mat = sel ? db.materials.find(m => m.id === sel.value) : null;
  const itemInp = document.getElementById('order-item');
  const specInp = document.getElementById('order-spec');
  const unitInp = document.getElementById('order-unit');
  if (mat) {
    if (itemInp) itemInp.value = mat.name;
    if (specInp) specInp.value = mat.spec || '';
    if (unitInp) unitInp.value = mat.unit || '박스';
  }
};

// ===== Orders (공장 발주) =====
window.addOrder = async function() {
  const factoryId = val('order-factory');
  const materialId = val('order-item-select');
  const itemText = val('order-item');
  const siteId = val('order-site');
  const managerId = defaultManagerId() || '';
  const managerName = (currentUser && currentUser.name) || '';
  const mat = materialId ? db.materials.find(m => m.id === materialId) : null;
  const item = mat ? mat.name : itemText;

  if (!factoryId) return alert('발주 공장을 선택하세요. (필요하면 +로 추가)');
  if (!item) return alert('품목을 선택하거나 직접 입력하세요.');
  if (!siteId) return alert('연관 현장을 선택하세요.');

  const data = {
    factoryId,
    materialId: materialId || '',
    item,
    spec: mat ? (mat.spec || val('order-spec')) : val('order-spec'),
    qty: Number(val('order-qty'))||0,
    unit: (mat && mat.unit) ? mat.unit : (val('order-unit')||'장'),
    orderDate: val('order-date') || todayISO(),
    expectedDate: val('order-expected'),
    siteId, managerId, managerName,
    status: '발주대기', note: val('order-note')
  };
  const orderId = await addRecord('orders', data);
  await logHistory('발주 등록', `${factoryLabel(factoryId)} / ${item}`);

  if (pendingHoldForOrder) {
    const holdId = pendingHoldForOrder;
    pendingHoldForOrder = null;
    await updateRecord('holds', holdId, { status: 'order_placed', orderId });
    await logHistory('홀딩 → 발주완료', item, `${data.qty}${data.unit}`);
  }

  ['order-item','order-spec','order-qty','order-date','order-expected','order-note']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  closeModal('order'); toast('저장됨');
};
window.removeOrder = async function(id) {
  const o = db.orders.find(x => x.id === id);
  if (!o) return;
  let msg = '이 발주를 삭제할까요?';
  if (o.outTxnId) msg += '\n· 공장 출고 기록 삭제 → 재고 복귀';
  if (o.receivedTxnId) msg += '\n· (옛) 입고 기록 삭제 → 재고 차감';
  if (!confirm(msg)) return;
  if (o.outTxnId) await removeRecord('txns', o.outTxnId);
  if (o.receivedTxnId) await removeRecord('txns', o.receivedTxnId);
  const linkedHold = db.holds.find(h => h.orderId === id);
  if (linkedHold) await updateRecord('holds', linkedHold.id, { status: 'active', orderId: null });
  await removeRecord('orders', id);
  await logHistory('발주 삭제', o.item||'');
};
// === 발주 4단계 워크플로 ===
const ORDER_FLOW = ['발주대기', '자재출고', '재단진행', '출고완료'];

function normalizeOrderStatus(status) {
  if (!status) return '발주대기';
  const map = { '발주': '발주대기', '입고대기': '재단진행', '입고완료': '출고완료' };
  return map[status] || status;
}

window.toggleOrderStatus = async function(id) {
  const o = db.orders.find(x => x.id === id); if (!o) return;
  const cur = normalizeOrderStatus(o.status);
  const idx = ORDER_FLOW.indexOf(cur);
  const next = ORDER_FLOW[(idx + 1) % ORDER_FLOW.length];

  if (cur === '출고완료' && next === '발주대기') {
    const msgs = ['이 발주를 처음부터 다시 시작할까요?'];
    if (o.outTxnId) msgs.push('· 공장 출고 기록 취소 → 재고 복귀');
    if (o.receivedTxnId) msgs.push('· (옛) 입고 기록 취소 → 재고 차감');
    if (!confirm(msgs.join('\n'))) return;
    if (o.outTxnId) await removeRecord('txns', o.outTxnId);
    if (o.receivedTxnId) await removeRecord('txns', o.receivedTxnId);
    await updateRecord('orders', id, {
      status: next,
      outTxnId: null, outLot: null, outDate: null,
      receivedTxnId: null, receivedLot: null, receivedDate: null
    });
    await logHistory('발주 리셋', o.item);
    toast('발주 초기화');
    return;
  }

  if (next === '자재출고') {
    if (!o.materialId) {
      if (!confirm('이 발주는 자재 마스터에 연결되지 않아 재고 자동 반영이 불가합니다.\n수동으로 [출고] 메뉴를 사용해 주세요.\n\n그래도 상태만 변경할까요?')) return;
      await updateRecord('orders', id, { status: next });
      await logHistory('발주 단계', o.item, `${cur} → ${next} (재고 미반영)`);
      return;
    }
    const allLots = lotsOf(o.materialId).map(l => {
      const avail = materialStock(o.materialId, l.lotNo) - materialHeld(o.materialId, l.lotNo);
      return { lotNo: l.lotNo, avail };
    });
    const ok = allLots.filter(l => l.avail >= o.qty);
    if (ok.length === 0) {
      const totals = allLots.map(l => `  ${l.lotNo}: 가용 ${l.avail}`).join('\n');
      return alert(`가용 재고 부족 (필요: ${o.qty}${o.unit||'장'})\n\n현재 롯트별 가용:\n${totals || '  (입고된 롯트 없음)'}`);
    }
    const lotChoice = ok.length === 1
      ? ok[0].lotNo
      : prompt(
          `공장 출고할 롯트를 선택하세요:\n${ok.map(l => `  ${l.lotNo} (가용 ${l.avail})`).join('\n')}\n\n롯트 넘버 입력:`,
          ok[0].lotNo
        );
    if (lotChoice === null) return;
    const chosen = ok.find(l => l.lotNo === String(lotChoice).trim());
    if (!chosen) return alert('유효하지 않은 롯트입니다.');

    const site = o.siteId ? db.sites.find(s => s.id === o.siteId) : null;
    const siteLabel = site ? (site.customer || site.name || '') : '';
    const factoryName = factoryLabel(o.factoryId);
    const txnId = await addRecord('txns', {
      type: 'out',
      materialId: o.materialId,
      lotNo: chosen.lotNo,
      qty: o.qty,
      date: todayISO(),
      source: 'order_out',
      factoryId: o.factoryId,
      orderId: o.id,
      refLabel: `[공장출고] ${factoryName}${siteLabel ? ' · ' + siteLabel : ''}`,
      note: '재단용'
    });
    await updateRecord('orders', id, {
      status: next, outTxnId: txnId, outLot: chosen.lotNo, outDate: todayISO()
    });
    await logHistory('자재 공장출고', o.item, `${o.qty}${o.unit||'장'} · 롯트 ${chosen.lotNo} → ${factoryName}`);
    toast(`출고 완료 · 재고 -${o.qty}${o.unit||'장'}`);
    return;
  }

  await updateRecord('orders', id, { status: next });
  await logHistory('발주 단계', o.item, `${cur} → ${next}`);
};

// ===== Materials (마스터) =====
window.addMaterial = async function() {
  const name = val('material-name');
  if (!name) return alert('자재명을 입력하세요.');
  const patternsRaw = val('material-patterns');
  const patterns = patternsRaw
    ? patternsRaw.split(',').map(s => s.trim()).filter(Boolean)
    : [];
  await addRecord('materials', {
    name, spec: val('material-spec'),
    unit: val('material-unit')||'장',
    perBox: Number(val('material-per-box'))||0,
    patterns,
    note: val('material-note')
  });
  await logHistory('자재 등록', name);
  ['material-name','material-spec','material-per-box','material-patterns','material-note']
    .forEach(id => document.getElementById(id).value = '');
  closeModal('material'); toast('저장됨');
};
window.removeMaterial = async function(id) {
  const m = db.materials.find(x => x.id === id);
  if (!confirm(`자재 "${m?.name}" 를 삭제할까요? (입출고 이력은 남습니다)`)) return;
  await removeRecord('materials', id);
  await logHistory('자재 삭제', m?.name||'');
};

// ===== In/Out transactions =====
window.addIn = async function() {
  const materialId = val('in-material'), lotNo = val('in-lot').trim();
  if (!materialId) return alert('자재를 선택하세요.');
  if (!lotNo) return alert('롯트 넘버를 입력하세요.');
  const mat = db.materials.find(m => m.id === materialId);
  const factoryId = val('in-factory');
  const fname = factoryLabel(factoryId);
  const patterns = (mat && Array.isArray(mat.patterns)) ? mat.patterns : [];

  let entries = [];
  if (patterns.length === 0) {
    const qty = Number(val('in-qty'))||0;
    if (qty <= 0) return alert('수량을 입력하세요.');
    entries.push({ pattern: '', qty });
  } else {
    document.querySelectorAll('#in-qty-patterns input[data-pattern]').forEach(inp => {
      const p = inp.dataset.pattern;
      const q = Number(inp.value)||0;
      if (q > 0) entries.push({ pattern: p, qty: q });
    });
    if (entries.length === 0) return alert('최소 한 패턴 이상 수량을 입력하세요.');
  }

  const date = val('in-date') || todayISO();
  const note = val('in-note');
  for (const e of entries) {
    await addRecord('txns', {
      type: 'in', materialId, lotNo, qty: e.qty,
      pattern: e.pattern,
      date, source: 'purchase', factoryId,
      refLabel: fname ? `[입고] ${fname}` : '[입고]',
      note
    });
  }
  const total = entries.reduce((s,e) => s+e.qty, 0);
  const patternSummary = patterns.length > 0
    ? ' [' + entries.map(e => `P${e.pattern}:${e.qty}`).join(', ') + ']'
    : '';
  await logHistory('입고', `${mat?.name} / 롯트 ${lotNo}`, `총 ${total}${mat?.unit||'장'}${patternSummary}`);
  ['in-lot','in-qty','in-date','in-note'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  document.querySelectorAll('#in-qty-patterns input').forEach(i => i.value = '');
  closeModal('in'); toast(`입고 완료 · 총 ${total}${mat?.unit||'장'}`);
};
window.addOut = async function() {
  const materialId = val('out-material'), lotValue = val('out-lot');
  const qty = Number(val('out-qty'))||0;
  if (!materialId || !lotValue) return alert('자재/롯트를 선택하세요.');
  if (qty <= 0) return alert('수량을 입력하세요.');
  const [lotNo, pattern] = lotValue.split('|');
  const avail = materialStock(materialId, lotNo, pattern || '') - materialHeld(materialId, lotNo, pattern || '');
  if (qty > avail) return alert(`가용 재고 부족 (가용 ${avail})`);
  const mat = db.materials.find(m => m.id === materialId);
  await addRecord('txns', {
    type: 'out', materialId, lotNo, qty,
    pattern: pattern || '',
    date: val('out-date') || todayISO(),
    source: 'manual', refLabel: `[수동출고] ${val('out-target')||''}`, note: ''
  });
  const patternStr = pattern ? ` 패턴 ${pattern}` : '';
  await logHistory('수동 출고', `${mat?.name} / 롯트 ${lotNo}${patternStr}`, `${qty}${mat?.unit||'장'}`);
  ['out-qty','out-date','out-target'].forEach(id => document.getElementById(id).value = '');
  closeModal('out'); toast('출고 완료');
};

// ===== Holds (홀딩) =====
window.addHold = async function() {
  const materialId = val('hold-material'), lotValue = val('hold-lot');
  const qty = Number(val('hold-qty'))||0;
  const reservedFor = val('hold-for');
  if (!materialId || !lotValue) return alert('자재/롯트를 선택하세요.');
  if (qty <= 0) return alert('수량을 입력하세요.');
  if (!reservedFor) return alert('거래처명을 입력하세요.');
  const [lotNo, pattern] = lotValue.split('|');
  const avail = materialStock(materialId, lotNo, pattern || '') - materialHeld(materialId, lotNo, pattern || '');
  if (qty > avail) return alert(`가용 재고 부족 (가용 ${avail})`);
  const mat = db.materials.find(m => m.id === materialId);
  await addRecord('holds', {
    materialId, lotNo, qty, reservedFor,
    pattern: pattern || '',
    startDate: val('hold-start') || todayISO(),
    expiryDate: val('hold-end'),
    status: 'active', note: val('hold-note'),
    managerId: (currentUser && currentUser.id) || '',
    managerName: (currentUser && currentUser.name) || ''
  });
  const patternStr = pattern ? ` 패턴 ${pattern}` : '';
  await logHistory('홀딩', `${mat?.name} / 롯트 ${lotNo}${patternStr}`, `${qty}${mat?.unit||'장'} → ${reservedFor}`);
  ['hold-qty','hold-for','hold-start','hold-end','hold-note'].forEach(id => document.getElementById(id).value = '');
  closeModal('hold'); toast('홀딩 등록');
};
window.orderFromHold = function(id) {
  const h = db.holds.find(x => x.id === id);
  if (!h) return;
  pendingHoldForOrder = id;
  openModal('order');
  const sel = document.getElementById('order-item-select');
  if (sel) { sel.value = h.materialId; onOrderMaterialChange(); }
  const qtyEl = document.getElementById('order-qty');
  if (qtyEl) qtyEl.value = h.qty;
  const matchedSite = db.sites.find(s => s.name === h.reservedFor || s.customer === h.reservedFor);
  if (matchedSite) {
    const siteSel = document.getElementById('order-site');
    if (siteSel) siteSel.value = matchedSite.id;
  }
  const noteEl = document.getElementById('order-note');
  if (noteEl) noteEl.value = `홀딩 → 발주 전환 (거래처: ${h.reservedFor})`;
  toast('홀딩 정보로 발주 폼 채움');
};

window.releaseHold = async function(id) {
  const h = db.holds.find(x => x.id === id); if (!h) return;
  if (!confirm(`"${h.reservedFor}" 홀딩을 해제할까요? (재고로 복귀)`)) return;
  await updateRecord('holds', id, { status: 'released', releasedAt: new Date().toISOString() });
  const mat = db.materials.find(m => m.id === h.materialId);
  await logHistory('홀딩 해제', `${mat?.name} / 롯트 ${h.lotNo}`, `${h.qty} ← ${h.reservedFor}`);
};
window.consumeHold = async function(id) {
  const h = db.holds.find(x => x.id === id); if (!h) return;
  if (!confirm(`"${h.reservedFor}" 홀딩 ${formatQty(h.materialId, h.qty)} 를 출고 처리할까요?`)) return;
  const mat = db.materials.find(m => m.id === h.materialId);
  await addRecord('txns', {
    type: 'out', materialId: h.materialId, lotNo: h.lotNo, qty: h.qty,
    pattern: h.pattern || '',
    date: todayISO(), source: 'hold',
    refLabel: `[홀딩출고] ${h.reservedFor}`, note: ''
  });
  await updateRecord('holds', id, { status: 'consumed', releasedAt: new Date().toISOString() });
  await logHistory('홀딩 출고', `${mat?.name} / 롯트 ${h.lotNo}`, `${h.qty} → ${h.reservedFor}`);
};

window.clearHistory = async function() {
  if (!confirm('이력을 모두 삭제할까요?')) return;
  await clearCollection('history');
};

// ===== Render =====
function render() {
  renderSetupCard();
  renderStats();
  renderSites(); renderSales(); renderOrders(); renderStock();
  renderHolds(); renderManagersList(); renderCrewsList(); renderFactoriesList(); renderHistory();
}

function renderSetupCard() {
  const card = document.getElementById('setup-card');
  const actions = document.getElementById('setup-actions');
  if (!card || !actions) return;
  if (!isAdmin()) { card.classList.add('hidden'); return; }
  const items = [
    { empty: db.managers.length === 0,  label: '담당자 등록',  modal: 'managers' },
    { empty: db.factories.length === 0, label: '공장 등록',    modal: 'factories' },
    { empty: db.crews.length === 0,     label: '시공팀 등록',  modal: 'crews' },
  ].filter(x => x.empty);
  if (items.length === 0) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  actions.innerHTML = items.map(x =>
    `<button class="btn" onclick="openModal('${x.modal}')">+ ${x.label}</button>`
  ).join('');
}

function renderStats() {
  const total = db.sites.length;
  setText('stat-sites', total);
  const counts = { '시공중':0, '완료':0, '대기':0, '이슈':0 };
  db.sites.forEach(s => {
    const st = s.status || '대기';
    counts[st] = (counts[st]||0) + 1;
  });
  const breakdown = ['시공중','완료','대기','이슈']
    .filter(k => counts[k] > 0)
    .map(k => `${k} ${counts[k]}`).join(' · ');
  setText('stat-sites-breakdown', breakdown || '아직 현장 없음');

  const now = new Date();
  const thisMon = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');
  const last = new Date(now.getFullYear(), now.getMonth()-1, 1);
  const lastMon = last.getFullYear() + '-' + String(last.getMonth()+1).padStart(2,'0');
  const orderDateOf = o => (o.orderDate || (o.createdAt||'').slice(0,10) || '');
  const thisCount = db.orders.filter(o => orderDateOf(o).startsWith(thisMon)).length;
  const lastCount = db.orders.filter(o => orderDateOf(o).startsWith(lastMon)).length;
  setText('stat-month-orders', thisCount);
  let delta = '—';
  if (lastCount > 0) {
    const pct = Math.round((thisCount - lastCount) / lastCount * 100);
    delta = (pct >= 0 ? '+' : '') + pct + '%';
  } else if (thisCount > 0) {
    delta = '신규';
  } else {
    delta = '0';
  }
  setText('stat-month-delta', delta);

  const today = todayISO();
  const activeOrders = db.orders.filter(o => {
    const s = normalizeOrderStatus(o.status);
    return s !== '출고완료' && s !== '취소';
  });
  const pendingKeys = new Set(activeOrders.map(o => o.materialId || o.item || ''));
  pendingKeys.delete('');
  setText('stat-pending', pendingKeys.size);
  const delayed = activeOrders.filter(o => o.expectedDate && o.expectedDate < today);
  const delayKeys = new Set(delayed.map(o => o.materialId || o.item || ''));
  delayKeys.delete('');
  const delayText = delayKeys.size > 0
    ? `지연 위험 ${delayKeys.size}종`
    : (pendingKeys.size > 0 ? '정상 진행' : '대기 자재 없음');
  setText('stat-delay-risk', delayText);

  const issues = db.sites.filter(s => s.status === '이슈').length;
  setText('stat-issues', issues);
  setText('stat-issues-sub', issues > 0 ? '즉시 확인 필요' : '이슈 없음');
}

window.onStockSearch = function(e) {
  stockQuery = (e.target.value || '').trim().toLowerCase();
  renderStock();
};

window.setSiteFilter = function(f) {
  siteFilter = f;
  document.querySelectorAll('.site-filter-pill').forEach(p =>
    p.classList.toggle('active', p.dataset.filter === f));
  renderSites();
};

function siteProgress(site) {
  if (site.status === '완료') return 100;
  const orders = db.orders.filter(o => o.siteId === site.id && normalizeOrderStatus(o.status) !== '취소');
  const holds = db.holds.filter(h =>
    (h.status === 'active' || h.status === 'order_placed') &&
    (h.reservedFor === site.name || h.reservedFor === site.customer)
  );
  if (orders.length === 0) {
    if (holds.length > 0) return 15;
    return site.status === '시공중' ? 10 : 0;
  }
  const stageMap = { '발주대기': 25, '자재출고': 50, '재단진행': 75, '출고완료': 100 };
  const sum = orders.reduce((s, o) => s + (stageMap[normalizeOrderStatus(o.status)] || 0), 0);
  return Math.round(sum / orders.length);
}

function renderSites() {
  const el = document.getElementById('site-list');
  if (db.sites.length === 0) return el.innerHTML = empty('등록된 현장이 없습니다.');
  const visible = siteFilter === 'all'
    ? db.sites
    : db.sites.filter(s => (s.status || '대기') === siteFilter);
  if (visible.length === 0) return el.innerHTML = empty(`'${siteFilter}' 상태의 현장이 없습니다.`);
  el.innerHTML = `<div class="site-grid">${visible.map(s => {
    const linkedOrders = db.orders.filter(o => o.siteId === s.id);
    const linkedHolds = db.holds.filter(h =>
      (h.status === 'active' || h.status === 'order_placed') &&
      (h.reservedFor === s.name || h.reservedFor === s.customer)
    );
    const completedOrders = linkedOrders.filter(o => normalizeOrderStatus(o.status) === '출고완료').length;
    const pendingOrders = linkedOrders.length - completedOrders;
    const customer = s.customer || s.name || '(미입력)';
    const factoryName = factoryLabel(s.factoryId) || s.factoryName || '';
    const crewName = crewLabel(s.crewId) || s.crewName || '';
    const managerName = managerLabel(s.managerId) || s.managerName || s.manager || '';
    const measureLabel = s.measureType === 'drawing' ? '도면발주'
      : (s.measureType === 'measured' || s.measureDone) ? ('실측 ' + (s.measureDate||''))
      : '미실측';
    return `
    <div class="site-card">
      <div class="head">
        <div class="head-left">
          <div class="customer">${esc(customer)}</div>
          ${(s.name && s.customer) || s.addr ? `<div class="sub">${esc([s.customer ? s.name : '', s.addr].filter(Boolean).join(' · '))}</div>` : ''}
        </div>
        <div style="display:flex; gap:6px; align-items:center;">
          ${statusBadge(s.status)}
          <button class="delete-btn" title="삭제" onclick="removeSite('${s.id}')">${ICONS.trash}</button>
        </div>
      </div>
      <div class="meta-grid">
        ${crewName ? `<div class="meta-item">${ICONS.users}<span>시공팀 <b>${esc(crewName)}</b></span></div>` : ''}
        ${factoryName ? `<div class="meta-item">${ICONS.factory}<span>공장 <b>${esc(factoryName)}</b></span></div>` : ''}
        ${managerName ? `<div class="meta-item">${ICONS.user}<span>담당 <b>${esc(managerName)}</b></span></div>` : ''}
        ${s.installDate ? `<div class="meta-item">${ICONS.calendar}<span>시공 <b>${esc(s.installDate)}</b></span></div>` : ''}
        <div class="meta-item">${ICONS.ruler}<span>${esc(measureLabel)}</span></div>
      </div>
      ${(() => {
        const pct = siteProgress(s);
        const fillCls = pct >= 100 ? 'complete' : (s.status === '이슈' ? 'danger' : '');
        return `
        <div class="progress-row">
          <div class="progress-label">
            <span>진행률</span>
            <span class="progress-pct">${pct}%</span>
          </div>
          <div class="progress-bar"><div class="progress-fill ${fillCls}" style="width:${pct}%"></div></div>
        </div>`;
      })()}
      ${linkedOrders.length > 0 || linkedHolds.length > 0 ? `<div class="mat-chips">
        ${linkedOrders.map(o => {
          const norm = normalizeOrderStatus(o.status);
          const cls = norm === '출고완료' ? 'green' : norm === '취소' ? 'red' : 'amber';
          return `<span class="mat-chip ${cls}" title="${esc(norm)}">${esc(o.item || '?')}</span>`;
        }).join('')}
        ${linkedHolds.length > 0 ? `<span class="mat-chip blue" title="홀딩">홀딩 ${linkedHolds.length}건</span>` : ''}
      </div>` : ''}
      ${s.note ? `<div class="footer"><div class="badges"><span class="badge">${esc(s.note)}</span></div></div>` : ''}
    </div>`;
  }).join('')}</div>`;
}

function renderSales() {
  const el = document.getElementById('sale-list');
  if (db.sales.length === 0) return el.innerHTML = empty('자재판매 내역이 없습니다.');
  el.innerHTML = `<div class="list">${db.sales.map(s => `
    <div class="item">
      <div class="item-row">
        <div class="meta">
          <div class="title">${esc(s.customer)} <span class="badge blue">${s.saleDate||''}</span></div>
          <div class="sub">${s.shipTo ? '출고지: '+esc(s.shipTo) : ''}${s.shipTo && (s.factoryId || s.factoryName) ? ' · ' : ''}${(s.factoryId || s.factoryName) ? '발주처: '+esc(factoryLabel(s.factoryId) || s.factoryName || '') : ''}</div>
        </div>
        ${managerTag(s)}
        <div class="actions">
          <button class="icon-btn" title="삭제" onclick="removeSale('${s.id}')">${ICONS.trash}</button>
        </div>
      </div>
      <div class="info">
        ${(s.items||[]).map(i => `${esc(i.materialName)}${i.spec ? ' ('+esc(i.spec)+')' : ''} · 롯트 ${esc(i.lotNo||'-')} · <b>${formatQty(i.materialId, i.qty)}</b>`).join('<br/>')}
      </div>
      ${s.note ? `<div class="info muted">메모: ${esc(s.note)}</div>` : ''}
    </div>`).join('')}</div>`;
}

function renderOrders() {
  const el = document.getElementById('order-list');
  if (db.orders.length === 0) return el.innerHTML = empty('발주 내역이 없습니다.');
  el.innerHTML = `<div class="list">${db.orders.map(o => {
    const site = o.siteId ? db.sites.find(s => s.id === o.siteId) : null;
    return `<div class="item">
      <div class="item-row">
        <div class="meta">
          <div class="title">${esc(o.item)}${o.spec ? ' <span class="badge">'+esc(o.spec)+'</span>':''}</div>
          <div class="sub"><b>${esc(factoryLabel(o.factoryId) || o.factoryName || '?')}</b> · ${o.qty}${esc(o.unit||'장')} · 발주 ${o.orderDate||'-'}${o.expectedDate ? ' · 상차예정 '+o.expectedDate : ''}${o.outLot ? ' · 출고 롯트 '+esc(o.outLot) : (o.receivedLot ? ' · 입고 롯트 '+esc(o.receivedLot) : '')}</div>
        </div>
        ${managerTag(o)}
        <div class="actions">
          <button class="icon-btn" title="상태 변경" onclick="toggleOrderStatus('${o.id}')">${ICONS.cycle}</button>
          <button class="icon-btn" title="삭제" onclick="removeOrder('${o.id}')">${ICONS.trash}</button>
        </div>
      </div>
      <div class="badges">
        ${orderStatusBadge(o.status)}
        ${site ? `<span class="badge blue">${esc(site.customer || site.name)}</span>` : ''}
        ${o.note ? `<span class="badge">${esc(o.note)}</span>` : ''}
      </div>
    </div>`;
  }).join('')}</div>`;
}

function renderStock() {
  const el = document.getElementById('stock-list');
  if (db.materials.length === 0) return el.innerHTML = empty('등록된 자재가 없습니다. "자재 등록" 후 "입고" 진행.');

  let list = db.materials.slice();
  if (stockQuery) {
    const q = stockQuery;
    const matches = [], rest = [];
    list.forEach(m => {
      const hay = ((m.name||'') + ' ' + (m.spec||'')).toLowerCase();
      if (hay.includes(q)) matches.push(m);
      else rest.push(m);
    });
    list = matches;
    if (list.length === 0) {
      return el.innerHTML = empty(`"${esc(stockQuery)}" 검색 결과 없음`);
    }
  }

  el.innerHTML = list.map(m => {
    const lots = lotsOf(m.id);
    const totalStock = materialStock(m.id);
    const totalHeld = materialHeld(m.id);
    const avail = totalStock - totalHeld;
    const unit = m.unit || '장';
    const perBox = Number(m.perBox)||0;
    const m2per = specToM2(m.spec);
    const meta = [];
    if (perBox > 0) meta.push(`박스당 ${perBox}${unit}`);
    if (m2per > 0) meta.push(`1${unit} = ${m2per.toFixed(2)}㎡`);
    const boxInfo = meta.length ? ' · ' + meta.join(' · ') : '';
    const totalSub = (perBox > 0 || m2per > 0)
      ? `재고 ${formatQty(m.id, totalStock)} · 가용 ${formatQty(m.id, avail)}`
      : '';
    return `<div class="stock-mat">
      <div class="stock-mat-head">
        <div>
          <div class="title">${highlightMatch(m.name, stockQuery)}</div>
          <div class="sub">${esc(m.spec||'')}${m.spec ? ' · ' : ''}${esc(unit)} 단위${boxInfo}</div>
        </div>
        <div class="stock-figs">
          <div class="fig"><div class="lbl">재고</div><div class="val">${totalStock}</div></div>
          <div class="fig held"><div class="lbl">홀딩</div><div class="val">${totalHeld}</div></div>
          <div class="fig avail"><div class="lbl">가용</div><div class="val">${avail}</div></div>
        </div>
      </div>
      ${totalSub ? `<div style="padding:0 18px 8px; font-size:11.5px; color:var(--muted);">${totalSub}</div>` : ''}
      ${lots.length === 0 ? '' : (() => {
        const patterns = Array.isArray(m.patterns) ? m.patterns : [];
        const headRow = `<div class="lot-row">
          <div class="lot head">${patterns.length > 0 ? '롯트 · 패턴' : '롯트 넘버'}</div>
          <div class="num head">재고</div>
          <div class="num head">홀딩</div>
          <div class="num head">가용</div>
        </div>`;
        let rows = '';
        lots.forEach(l => {
          if (patterns.length === 0) {
            const ls = materialStock(m.id, l.lotNo);
            const lh = materialHeld(m.id, l.lotNo);
            rows += `<div class="lot-row">
              <div class="lot">${esc(l.lotNo)}</div>
              <div class="num">${ls}</div>
              <div class="num held">${lh}</div>
              <div class="num avail">${ls-lh}</div>
            </div>`;
          } else {
            patterns.forEach(p => {
              const ls = materialStock(m.id, l.lotNo, p);
              const lh = materialHeld(m.id, l.lotNo, p);
              if (ls === 0 && lh === 0) return;
              rows += `<div class="lot-row">
                <div class="lot">${esc(l.lotNo)} <span class="badge" style="font-size:10px; margin-left:4px;">패턴 ${esc(p)}</span></div>
                <div class="num">${ls}</div>
                <div class="num held">${lh}</div>
                <div class="num avail">${ls-lh}</div>
              </div>`;
            });
          }
        });
        return `<div class="stock-lots">${headRow}${rows}</div>`;
      })()}
      <div style="padding:10px 16px; display:flex; gap:6px; justify-content:flex-end;">
        <button class="icon-btn" title="자재 삭제" onclick="removeMaterial('${m.id}')">${ICONS.trash}</button>
      </div>
    </div>`;
  }).join('');
}

function highlightMatch(text, q) {
  const safe = esc(text || '');
  if (!q) return safe;
  const re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
  return safe.replace(re, '<mark style="background:var(--accent-soft); color:var(--accent-dark); padding:0 3px; border-radius:3px;">$1</mark>');
}

function renderHolds() {
  const el = document.getElementById('hold-list');
  const list = db.holds.filter(h => h.status === 'active' || h.status === 'order_placed');
  const past = db.holds.filter(h => h.status === 'released' || h.status === 'consumed').slice(0, 20);
  if (list.length === 0 && past.length === 0) return el.innerHTML = empty('홀딩 내역이 없습니다.');
  el.innerHTML = `
    ${list.length > 0 ? `<div class="list">${list.map(h => {
      const mat = db.materials.find(m => m.id === h.materialId);
      const orderedFor = h.status === 'order_placed';
      const linkedOrder = orderedFor && h.orderId ? db.orders.find(o => o.id === h.orderId) : null;
      const factoryName = linkedOrder ? (factoryLabel(linkedOrder.factoryId) || '?') : '';
      const orderStatus = linkedOrder ? linkedOrder.status : '';
      return `<div class="item">
        <div class="item-row">
          <div class="meta">
            <div class="title">${esc(mat?.name || '?')} <span class="badge">롯트 ${esc(h.lotNo)}</span>${orderedFor ? ` <span class="badge amber">발주완료${factoryName ? ' · ' + esc(factoryName) : ''}</span>` : ''}</div>
            <div class="sub">거래처: <b>${esc(h.reservedFor)}</b></div>
          </div>
          ${managerTag(h)}
          <div class="actions">
            <button class="btn small-btn" onclick="consumeHold('${h.id}')">출고</button>
            ${!orderedFor ? `<button class="btn ghost small-btn" onclick="orderFromHold('${h.id}')">발주</button>` : ''}
            <button class="btn ghost small-btn" onclick="releaseHold('${h.id}')">해제</button>
          </div>
        </div>
        <div class="info"><b>${formatQty(h.materialId, h.qty)}</b> · ${h.startDate||''}${h.expiryDate ? ' ~ '+h.expiryDate:''}${orderedFor && linkedOrder?.expectedDate ? ` · 상차예정 ${linkedOrder.expectedDate}` : ''}${orderedFor && orderStatus ? ` · 발주상태 ${orderStatus}` : ''}</div>
        ${h.note ? `<div class="info muted">${esc(h.note)}</div>` : ''}
      </div>`;
    }).join('')}</div>` : ''}
    ${past.length > 0 ? `<h3 style="font-size:13px; color:var(--muted); margin:20px 0 8px;">최근 해제/소진</h3>
    <div class="list">${past.map(h => {
      const mat = db.materials.find(m => m.id === h.materialId);
      return `<div class="item" style="opacity:.65">
        <div class="meta">
          <div class="title">${esc(mat?.name || '?')} <span class="badge">${h.status === 'consumed' ? '출고완료' : '해제'}</span></div>
          <div class="sub">${esc(h.reservedFor)} · 롯트 ${esc(h.lotNo)} · ${formatQty(h.materialId, h.qty)}</div>
        </div>
      </div>`;
    }).join('')}</div>` : ''}
  `;
}

function renderManagersList() {
  const el = document.getElementById('managers-list');
  if (!el) return;
  if (db.managers.length === 0) {
    el.innerHTML = '<div style="text-align:center; color:var(--muted); font-size:13px; padding:24px;">등록된 담당자가 없습니다.<br/>위 입력란으로 추가하세요.</div>';
    return;
  }
  el.innerHTML = `<div class="list">${db.managers.map(m => `
    <div class="item">
      <div class="item-row">
        <div class="meta">
          <div class="title">${esc(m.name)}${m.title ? ' <span class="badge">'+esc(m.title)+'</span>' : ''}</div>
        </div>
        <div class="actions">
          <button class="icon-btn" title="삭제" onclick="removeManager('${m.id}')">${ICONS.trash}</button>
        </div>
      </div>
    </div>`).join('')}</div>`;
}

function renderCrewsList() {
  const el = document.getElementById('crews-list');
  if (!el) return;
  if (db.crews.length === 0) {
    el.innerHTML = '<div style="text-align:center; color:var(--muted); font-size:13px; padding:24px;">등록된 시공팀이 없습니다.<br/>위 입력란으로 추가하세요.</div>';
    return;
  }
  el.innerHTML = `<div class="list">${db.crews.map(c => `
    <div class="item">
      <div class="item-row">
        <div class="meta">
          <div class="title">${esc(c.name)}${c.leader ? ' <span class="badge">반장 '+esc(c.leader)+'</span>' : ''}</div>
          ${c.phone ? `<div class="sub">${esc(c.phone)}</div>` : ''}
        </div>
        <div class="actions">
          <button class="icon-btn" title="삭제" onclick="removeCrew('${c.id}')">${ICONS.trash}</button>
        </div>
      </div>
    </div>`).join('')}</div>`;
}

function renderFactoriesList() {
  const el = document.getElementById('factories-list');
  if (!el) return;
  if (db.factories.length === 0) {
    el.innerHTML = '<div style="text-align:center; color:var(--muted); font-size:13px; padding:24px;">등록된 공장이 없습니다.<br/>위 입력란으로 추가하세요.</div>';
    return;
  }
  el.innerHTML = `<div class="list">${db.factories.map(f => `
    <div class="item">
      <div class="item-row">
        <div class="meta">
          <div class="title">${esc(f.name)}</div>
          ${f.contact ? `<div class="sub">${esc(f.contact)}</div>` : ''}
          ${f.note ? `<div class="sub muted">${esc(f.note)}</div>` : ''}
        </div>
        <div class="actions">
          <button class="icon-btn" title="삭제" onclick="removeFactory('${f.id}')">${ICONS.trash}</button>
        </div>
      </div>
    </div>`).join('')}</div>`;
}

function renderHistory() {
  const el = document.getElementById('history-list');
  if (db.history.length === 0) return el.innerHTML = empty('이력이 없습니다.');
  el.innerHTML = `<div class="list">${db.history.map(h => `
    <div class="item">
      <div class="meta">
        <div class="title">${h.userName ? '<span class="badge blue">'+esc(h.userName)+'</span> ' : ''}${esc(h.action)} · ${esc(h.target)}</div>
        <div class="sub">${h.detail ? esc(h.detail) + ' · ' : ''}${new Date(h.at||h.createdAt).toLocaleString('ko-KR')}</div>
      </div>
    </div>`).join('')}</div>`;
}

// ===== Helpers =====
const ICONS = {
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/></svg>',
  cycle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  factory: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21h18M5 21V11l5 3V8l5 4V5h2v16"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
  ruler: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.3 8.7l-9.6 9.6a1 1 0 0 1-1.4 0L2.7 10.7a1 1 0 0 1 0-1.4l5.6-5.6a1 1 0 0 1 1.4 0l7.6 7.6"/><path d="M7.5 7.5l1 1M10 5l1 1M5 10l1 1M14.5 9.5l1 1M12 12l1 1"/></svg>'
};
function empty(msg) {
  return `<div class="empty">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
    <p>${msg}</p>
  </div>`;
}
function statusBadge(st) {
  const m = { '대기':'', '시공중':'green', '완료':'blue', '이슈':'red' };
  return `<span class="badge ${m[st]||''}">${st||'-'}</span>`;
}
function orderStatusBadge(st) {
  const norm = normalizeOrderStatus(st);
  const color = {
    '발주대기': '',
    '자재출고': 'amber',
    '재단진행': 'blue',
    '출고완료': 'green',
    '취소': 'red'
  };
  return `<span class="badge ${color[norm]||''}">${norm}</span>`;
}
function val(id) { return document.getElementById(id).value.trim(); }
function setText(id, v) { document.getElementById(id).textContent = v; }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function todayISO() { return new Date().toISOString().slice(0,10); }
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escape(s) { return esc(s); }
function toast(msg, isError) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.toggle('error', !!isError);
  t.classList.add('show');
  clearTimeout(window._tt); window._tt = setTimeout(()=>t.classList.remove('show'), 2200);
}
