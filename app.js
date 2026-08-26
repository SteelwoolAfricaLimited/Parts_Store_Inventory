// ================= API CLIENT =================
// Replaces google.script.run: POST to the Apps Script /exec URL as
// text/plain (keeps it a CORS "simple request", no preflight needed —
// Apps Script web apps can't answer an OPTIONS preflight).
function callApi(fn, ...args) {
  const url = window.APP_CONFIG.APPS_SCRIPT_URL;
  if (!url || url.indexOf('PASTE_YOUR') !== -1) {
    return Promise.reject(new Error('App not configured yet — edit config.js with your Apps Script Web App URL.'));
  }
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ fn, args })
  })
    .then(r => {
      if (!r.ok) throw new Error('Network error: ' + r.status);
      return r.json();
    })
    .then(data => {
      if (!data.ok) throw new Error(data.error || 'Unknown server error');
      return data.result;
    });
}

// ================= APP STATE =================
let ITEMS = [];
let LAST_DATA = null;
let MONTHLY_DATA = null;
let REQUISITIONS = [];
let CURRENT_REQ_DETAIL = null;
let REQ_CART = [];
let REQ_SELECTED_ITEM = null;
let REQ_SELECTED_FOR_PRINT = new Set();
let ACCESS_LISTS = null;
let CURRENT_USER = null; // { name, role: 'requestor' | 'approver' | 'superuser' | 'store' }

const REQUESTOR_RESTRICTED_TABS = ['overview', 'movers', 'reorder', 'monthly', 'search', 'purchase'];

document.addEventListener('DOMContentLoaded', () => {
  if (!window.APP_CONFIG || !window.APP_CONFIG.APPS_SCRIPT_URL || window.APP_CONFIG.APPS_SCRIPT_URL.indexOf('PASTE_YOUR') !== -1) {
    document.getElementById('configBanner').style.display = 'block';
  }

  document.querySelectorAll('nav button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    });
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('.datalist-wrap')) {
      document.querySelectorAll('.suggest').forEach(s => s.style.display = 'none');
    }
  });

  load();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
});

// ---- Identity gate ----
function loadAccessLists() {
  const lists = window.APP_CONFIG.ACCESS_LISTS;
  ACCESS_LISTS = lists;
  const gateSel = document.getElementById('gate_name');
  gateSel.innerHTML = '<option value="">— Select your name —</option>' +
    '<optgroup label="Requesting Staff">' +
    lists.requestors.map(n => '<option value="' + escapeHtml(n) + '" data-role="requestor">' + escapeHtml(n) + '</option>').join('') +
    '</optgroup>' +
    '<optgroup label="Stage 1 Approvers">' +
    (lists.stage1Approvers || []).map(n => '<option value="' + escapeHtml(n) + '" data-role="approver">' + escapeHtml(n) + '</option>').join('') +
    '</optgroup>' +
    '<optgroup label="Stage 2 Approvers (Super Users)">' +
    (lists.stage2Approvers || []).map(n => '<option value="' + escapeHtml(n) + '" data-role="superuser">' + escapeHtml(n) + '</option>').join('') +
    '</optgroup>' +
    '<optgroup label="Store Personnel">' +
    (lists.storeKeepers || []).map(n => '<option value="' + escapeHtml(n) + '" data-role="store">' + escapeHtml(n) + '</option>').join('') +
    '</optgroup>';
  const rbSel = document.getElementById('rq_requestedBy');
  if (rbSel) {
    rbSel.innerHTML = '<option value="">— Select requester —</option>' +
      lists.requestors.map(n => '<option value="' + escapeHtml(n) + '">' + escapeHtml(n) + '</option>').join('');
  }
}

function onGateNameChange() {
  const sel = document.getElementById('gate_name');
  const role = sel.selectedOptions[0] ? sel.selectedOptions[0].dataset.role : '';
  document.getElementById('gate_codeWrap').style.display =
    (role === 'approver' || role === 'superuser' || role === 'store') ? 'block' : 'none';
  document.getElementById('gate_code').value = '';
  document.getElementById('gate_msg').style.display = 'none';
}

function confirmIdentity() {
  const sel = document.getElementById('gate_name');
  const name = sel.value;
  const gateMsg = document.getElementById('gate_msg');
  gateMsg.style.display = 'none';
  if (!name) { gateMsg.textContent = 'Please select your name.'; gateMsg.style.display = 'block'; return; }
  const role = sel.selectedOptions[0].dataset.role;

  if (role === 'approver' || role === 'superuser' || role === 'store') {
    const code = document.getElementById('gate_code').value.trim();
    if (!code) { gateMsg.textContent = 'Enter your code.'; gateMsg.style.display = 'block'; return; }
    callApi('verifyApprovalIdentity', name, code).then(res => {
      if (!res.valid) { gateMsg.textContent = 'Incorrect code for ' + name + '.'; gateMsg.style.display = 'block'; return; }
      CURRENT_USER = { name: name, role: role };
      document.getElementById('identityGate').style.display = 'none';
      applyAccessControl();
    }).catch(err => {
      gateMsg.textContent = 'Error: ' + err.message; gateMsg.style.display = 'block';
    });
  } else {
    CURRENT_USER = { name: name, role: role };
    document.getElementById('identityGate').style.display = 'none';
    applyAccessControl();
  }
}

function applyAccessControl() {
  const isRequestor = CURRENT_USER && CURRENT_USER.role === 'requestor';
  const isStore = CURRENT_USER && CURRENT_USER.role === 'store';
  const isApprover = CURRENT_USER && (CURRENT_USER.role === 'approver' || CURRENT_USER.role === 'superuser');

  document.querySelectorAll('nav button').forEach(btn => {
    btn.style.display = ((isRequestor || isStore) && REQUESTOR_RESTRICTED_TABS.includes(btn.dataset.tab)) ? 'none' : '';
  });

  if (isRequestor) {
    document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelector('nav button[data-tab="newreq"]').classList.add('active');
    document.getElementById('tab-newreq').classList.add('active');
  } else if (isStore) {
    document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelector('nav button[data-tab="requisitions"]').classList.add('active');
    document.getElementById('tab-requisitions').classList.add('active');
  }

  const rbSel = document.getElementById('rq_requestedBy');
  if (rbSel) {
    if (isRequestor) {
      rbSel.value = CURRENT_USER.name;
      rbSel.disabled = true;
    } else if (isApprover) {
      ensureRequesterOption_(rbSel, CURRENT_USER.name);
      rbSel.value = CURRENT_USER.name;
      rbSel.disabled = false; // still free to file on someone else's behalf if needed
    } else {
      rbSel.disabled = false;
    }
  }
}

// Approvers aren't in the regular REQ_REQUESTORS list, so their own name
// may not exist as an option yet — add it if missing.
function ensureRequesterOption_(selectEl, name) {
  const exists = Array.from(selectEl.options).some(o => o.value === name);
  if (!exists) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name + ' (You)';
    selectEl.insertBefore(opt, selectEl.options[1] || null);
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmt(n) {
  if (n === '' || n === null || n === undefined) return '—';
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function todayStr() { return new Date().toISOString().slice(0, 10); }

function load() {
  callApi('getDashboardData').then(renderAll).catch(showLoadError);
  callApi('getItemPickList').then(items => { ITEMS = items; renderCatalogue(); }).catch(() => {});
  callApi('getMonthlySummaryData').then(d => { MONTHLY_DATA = d; renderMonthlySummary(); }).catch(() => {});
  loadRequisitions();
  loadAccessLists();
}

function showLoadError(err) {
  document.getElementById('kpiRow').innerHTML = '<div class="empty">Could not load data: ' + escapeHtml(err.message || err) + '</div>';
}

function renderAll(data) {
  LAST_DATA = data;
  const k = data.kpis;
  document.getElementById('kpiRow').innerHTML =
    kpiCard(k.totalItems, 'Total Items in Master') +
    kpiCard(k.itemsWithActivity, 'Items With Movement') +
    kpiCard(k.reorderCount, 'Need Re-order', k.reorderCount > 0) +
    kpiCard(k.monthsOfData, 'Months of Issuance Data') +
    kpiCard(fmt(k.totalStockValue), 'Expected Stock Value');
  document.getElementById('lastRun').textContent = 'Last calculated: ' + new Date(data.generatedAt).toLocaleString();

  document.getElementById('moversBody').innerHTML = data.topMovers.length ? data.topMovers.map((i, idx) =>
    '<tr><td><span class="rank">' + (idx + 1) + '</span></td><td>' + escapeHtml(i.code) + '</td><td>' + escapeHtml(i.name) +
    '</td><td>' + escapeHtml(i.bin) + '</td><td>' + escapeHtml(i.category) + '</td>' +
    '<td class="num-cell">' + i.issuanceFrequency + '</td><td class="num-cell">' + fmt(i.issued) + '</td></tr>'
  ).join('') : '<tr><td colspan="7" class="empty">No issuance data yet.</td></tr>';

  document.getElementById('reorderBody').innerHTML = data.reorderAlerts.length ? data.reorderAlerts.map(i =>
    '<tr><td>' + escapeHtml(i.code) + '</td><td>' + escapeHtml(i.name) + '</td><td>' + escapeHtml(i.bin) + '</td>' +
    '<td class="num-cell">' + fmt(i.expectedClosing) + '</td><td class="num-cell">' + fmt(i.reorderLevel) + '</td>' +
    '<td class="num-cell">' + fmt(i.reorderQty) + '</td><td><span class="badge reorder">Re-order</span></td></tr>'
  ).join('') : '<tr><td colspan="7" class="empty">Nothing needs re-ordering right now 🎉</td></tr>';

  doSearch();
}

function kpiCard(num, label, warn) {
  return '<div class="kpi' + (warn ? ' warn' : '') + '"><div class="num">' + num + '</div><div class="lbl">' + label + '</div></div>';
}

function doSearch() {
  const q = document.getElementById('searchBox').value.trim();
  if (!LAST_DATA) return;
  const list = q
    ? LAST_DATA.items.filter(i => (i.bin + i.name + i.code).toLowerCase().indexOf(q.toLowerCase()) !== -1)
    : LAST_DATA.items.slice(0, 50);
  document.getElementById('searchBody').innerHTML = list.length ? list.map(i =>
    '<tr><td>' + escapeHtml(i.code) + '</td><td>' + escapeHtml(i.name) + '</td><td>' + escapeHtml(i.bin) + '</td>' +
    '<td>' + escapeHtml(i.category) + '</td><td class="num-cell">' + fmt(i.expectedClosing) + '</td>' +
    '<td class="num-cell">' + fmt(i.reorderLevel) + '</td>' +
    '<td>' + (i.needsReorder ? '<span class="badge reorder">Re-order</span>' : '<span class="badge ok">OK</span>') + '</td></tr>'
  ).join('') : '<tr><td colspan="7" class="empty">No matches.</td></tr>';
}

function renderMonthlySummary() {
  if (!MONTHLY_DATA) return;
  const q = document.getElementById('monthlySearchBox').value.trim().toLowerCase();

  const headerRow = document.getElementById('monthlyHeaderRow');
  headerRow.innerHTML = '<th>Code</th><th>Name</th><th>Bin</th>' +
    MONTHLY_DATA.months.map(m =>
      '<th class="num-cell">' + escapeHtml(m.label) + '<br><span class="muted" style="font-weight:400">Qty / Reqs</span></th>'
    ).join('') +
    '<th class="num-cell">Avg Qty/Mo</th><th class="num-cell">Avg Reqs/Mo</th>';

  const list = q
    ? MONTHLY_DATA.items.filter(i => (i.code + i.name + i.bin).toLowerCase().indexOf(q) !== -1)
    : MONTHLY_DATA.items.slice(0, 50);

  const colCount = 5 + MONTHLY_DATA.months.length;
  document.getElementById('monthlyBody').innerHTML = list.length ? list.map(i =>
    '<tr><td>' + escapeHtml(i.code) + '</td><td>' + escapeHtml(i.name) + '</td><td>' + escapeHtml(i.bin) + '</td>' +
    i.perMonth.map(m => '<td class="num-cell">' + fmt(m.qty) + ' / ' + fmt(m.freq) + '</td>').join('') +
    '<td class="num-cell">' + fmt(i.avgConsumption) + '</td><td class="num-cell">' + fmt(i.avgFrequency) + '</td></tr>'
  ).join('') : '<tr><td colspan="' + colCount + '" class="empty">No matches.</td></tr>';

  document.getElementById('monthlyFooterNote').textContent = q
    ? (list.length + ' item(s) match "' + document.getElementById('monthlySearchBox').value + '".')
    : ('Showing first 50 of ' + MONTHLY_DATA.items.length + ' items — type in the filter box to search all.');
}

function exportMonthlySummaryToSheet() {
  document.getElementById('monthlyMsg').textContent = 'Exporting…';
  callApi('writeMonthlySummarySheet').then(res => {
    document.getElementById('monthlyMsg').textContent =
      'Exported ' + res.itemCount + ' items × ' + res.monthCount + ' months to the "MONTHLY SUMMARY" sheet.';
  }).catch(err => {
    document.getElementById('monthlyMsg').textContent = 'Error: ' + err.message;
  });
}

function exportMonthlySummaryToExcelFile() {
  document.getElementById('monthlyMsg').textContent = 'Preparing Excel file…';
  callApi('exportMonthlySummaryToExcel').then(res => {
    downloadBase64File(res.base64, res.filename, res.mimeType);
    document.getElementById('monthlyMsg').textContent =
      'Downloaded ' + res.filename + ' (' + res.itemCount + ' items × ' + res.monthCount + ' months).';
  }).catch(err => {
    document.getElementById('monthlyMsg').textContent = 'Error: ' + err.message;
  });
}

function downloadBase64File(base64, filename, mimeType) {
  const byteChars = atob(base64);
  const byteNumbers = new Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
  const blob = new Blob([new Uint8Array(byteNumbers)], { type: mimeType });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(link.href), 4000);
}

function recalc() {
  const msg = document.getElementById('overviewMsg');
  msg.className = 'msg'; msg.style.display = 'none';
  callApi('recalculateAll').then(res => {
    showMsg('overviewMsg', 'Recalculated ' + res.itemCount + ' items — ' + res.reorderCount + ' need re-ordering.', true);
    load();
  }).catch(err => showMsg('overviewMsg', 'Error: ' + err.message, false));
}

function checkReorder() {
  callApi('checkReorderAndNotify').then(res => {
    showMsg('overviewMsg', res.sent ? ('Email sent — ' + res.count + ' item(s) need re-ordering.') : 'No items below re-order level — no email sent.', true);
    load();
  }).catch(err => showMsg('overviewMsg', 'Error: ' + err.message, false));
}

function showMsg(id, text, ok) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = 'msg ' + (ok ? 'ok' : 'err');
}

// ---- searchable item pickers ----
function filterItems(prefix) {
  const val = document.getElementById(prefix + '_code').value.trim().toLowerCase();
  const box = document.getElementById(prefix + '_suggest');
  if (!val) { box.style.display = 'none'; box.innerHTML = ''; return; }
  const matches = ITEMS.filter(i => i.code.toLowerCase().indexOf(val) !== -1 || i.name.toLowerCase().indexOf(val) !== -1).slice(0, 20);
  box.innerHTML = matches.map(i => '<div onclick="pickItem(\'' + prefix + '\',\'' + i.code.replace(/'/g, "\\'") + '\')">' +
    '<b>' + escapeHtml(i.code) + '</b> — ' + escapeHtml(i.name) + ' <span class="muted">(' + escapeHtml(i.bin) + ')</span></div>').join('');
  box.style.display = matches.length ? 'block' : 'none';
}
function pickItem(prefix, code) {
  document.getElementById(prefix + '_code').value = code;
  document.getElementById(prefix + '_suggest').style.display = 'none';
  if (prefix === 'p') fillPurchaseDefaults_(code);
}

// Autofills Unit Cost and Bin Location from Stocks Balance the moment a
// part is picked on the Log Purchase form. Both fields stay fully editable
// afterward — this only sets an initial value.
function fillPurchaseDefaults_(code) {
  const item = ITEMS.find(i => i.code === code);
  if (!item) return;
  callApi('getItemPurchaseInfoByName', item.name).then(info => {
    if (!info) return;
    document.getElementById('p_unitCost').value = info.unitCost;
    document.getElementById('p_toBin').value = info.bin;
  }).catch(() => {});
}

function submitPurchase() {
  document.getElementById('p_date').value = document.getElementById('p_date').value || todayStr();
  const form = {
    code: document.getElementById('p_code').value.trim(),
    date: document.getElementById('p_date').value,
    qty: document.getElementById('p_qty').value,
    unitCost: document.getElementById('p_unitCost').value,
    toBin: document.getElementById('p_toBin').value,
    supplier: document.getElementById('p_supplier').value,
    grn: document.getElementById('p_grn').value
  };
  if (!form.code || !form.qty) { showMsg('purchaseMsg', 'Part code and quantity are required.', false); return; }
  callApi('addPurchase', form).then(res => {
    showMsg('purchaseMsg', 'Purchase saved. ' + res.reorderCount + ' item(s) currently need re-ordering.', true);
    ['p_code', 'p_qty', 'p_unitCost', 'p_toBin', 'p_supplier', 'p_grn'].forEach(id => document.getElementById(id).value = '');
    load();
  }).catch(err => showMsg('purchaseMsg', 'Error: ' + err.message, false));
}

// ================= CATALOGUE =================

function renderCatalogue() {
  const box = document.getElementById('catSearchBox');
  const grid = document.getElementById('catGrid');
  if (!box || !grid) return; // catalogue tab not present in this build

  const q = box.value.trim().toLowerCase();
  const list = q
    ? ITEMS.filter(i => (i.code + i.name + i.bin).toLowerCase().indexOf(q) !== -1)
    : ITEMS.slice(0, 60);

  grid.innerHTML = list.length ? list.map(i =>
    '<div style="border:1px solid var(--border);border-radius:8px;overflow:hidden;background:#fff">' +
      (i.photoUrl
        ? '<img src="' + i.photoUrl + '" loading="lazy" style="width:100%;height:120px;object-fit:cover;display:block">'
        : '<div style="width:100%;height:120px;background:#eee;display:flex;align-items:center;justify-content:center;color:#999;font-size:12px">No photo</div>') +
      '<div style="padding:8px 10px">' +
        '<div style="font-weight:600;font-size:12.5px">' + escapeHtml(i.code) + '</div>' +
        '<div style="font-size:12px;color:var(--muted)">' + escapeHtml(i.name) + '</div>' +
        '<div style="font-size:11px;color:var(--muted);margin-top:2px">Bin: ' + escapeHtml(i.bin) + '</div>' +
      '</div>' +
    '</div>'
  ).join('') : '<div class="empty">No matches.</div>';

  const footer = document.getElementById('catFooterNote');
  if (footer) {
    footer.textContent = q
      ? (list.length + ' item(s) match "' + box.value + '".')
      : ('Showing first 60 of ' + ITEMS.length + ' items — type in the search box to filter all ' + ITEMS.length + '.');
  }
}

// ================= REQUISITIONS =================

function filterReqItems() {
  const val = document.getElementById('rq_search').value.trim().toLowerCase();
  const box = document.getElementById('rq_suggest');
  if (!val) { box.style.display = 'none'; box.innerHTML = ''; REQ_SELECTED_ITEM = null; renderStockInfo(null); return; }
  const matches = ITEMS.filter(i => i.code.toLowerCase().indexOf(val) !== -1 || i.name.toLowerCase().indexOf(val) !== -1).slice(0, 20);
  box.innerHTML = matches.map(i =>
    '<div onclick="pickReqItem(\'' + i.code.replace(/'/g, "\\'") + '\')" style="display:flex;align-items:center;gap:8px">' +
      (i.photoUrl
        ? '<img src="' + i.photoUrl + '" loading="lazy" style="width:32px;height:32px;object-fit:cover;border-radius:4px;flex:0 0 auto">'
        : '<div style="width:32px;height:32px;flex:0 0 auto;background:#eee;border-radius:4px"></div>') +
      '<div><b>' + escapeHtml(i.code) + '</b> — ' + escapeHtml(i.name) + ' <span class="muted">(' + escapeHtml(i.bin) + ')</span></div>' +
    '</div>'
  ).join('');
  box.style.display = matches.length ? 'block' : 'none';
}
function pickReqItem(code) {
  const item = ITEMS.find(i => i.code === code);
  if (!item) return;
  REQ_SELECTED_ITEM = item;
  document.getElementById('rq_search').value = item.code + ' — ' + item.name;
  document.getElementById('rq_bin').value = item.bin || '';
  document.getElementById('rq_suggest').style.display = 'none';
  document.getElementById('rq_stockInfo').innerHTML = '<span class="muted">Checking available stock…</span>';
  callApi('getItemStock', code).then(stock => renderStockInfo(stock, item.photoUrl)).catch(() => renderStockInfo(null));
}
function renderStockInfo(stock, photoUrl) {
  const el = document.getElementById('rq_stockInfo');
  if (!stock) { el.innerHTML = ''; return; }
  const qty = Number(stock.expectedClosing) || 0;
  const cls = qty <= 0 ? 'reorder' : (stock.needsReorder ? 'reorder' : 'ok');
  const label = qty <= 0 ? 'Out of stock' : (stock.needsReorder ? 'Below re-order level' : 'In stock');
  const img = photoUrl
    ? '<img src="' + photoUrl + '" style="width:60px;height:60px;object-fit:cover;border-radius:6px;margin-right:10px;vertical-align:middle">'
    : '';
  el.innerHTML = img + 'Available stock: <b>' + fmt(qty) + ' ' + escapeHtml(stock.uom) + '</b> <span class="badge ' + cls + '">' + label + '</span>';
}
function addReqItem() {
  if (!REQ_SELECTED_ITEM) { showMsg('newReqMsg', 'Search and select a part first.', false); return; }
  const qty = Number(document.getElementById('rq_qty').value) || 0;
  if (qty <= 0) { showMsg('newReqMsg', 'Enter a quantity greater than 0.', false); return; }
  REQ_CART.push({
    code: REQ_SELECTED_ITEM.code, name: REQ_SELECTED_ITEM.name, uom: REQ_SELECTED_ITEM.uom,
    bin: document.getElementById('rq_bin').value.trim() || REQ_SELECTED_ITEM.bin,
    qty: qty, purpose: document.getElementById('rq_purpose').value.trim(), oldPartReturned: document.getElementById('rq_oldPart').value.trim()
  });
  document.getElementById('newReqMsg').style.display = 'none';
  ['rq_search', 'rq_qty', 'rq_bin', 'rq_purpose', 'rq_oldPart'].forEach(id => document.getElementById(id).value = '');
  REQ_SELECTED_ITEM = null;
  renderStockInfo(null);
  renderReqCart();
}
function removeReqItem(idx) {
  REQ_CART.splice(idx, 1);
  renderReqCart();
}
function renderReqCart() {
  document.getElementById('rq_cartBody').innerHTML = REQ_CART.length ? REQ_CART.map((it, idx) =>
    '<tr><td>' + (idx + 1) + '</td><td>' + escapeHtml(it.code) + '</td><td>' + escapeHtml(it.name) + '</td>' +
    '<td class="num-cell">' + it.qty + '</td><td>' + escapeHtml(it.uom) + '</td><td>' + escapeHtml(it.bin) + '</td>' +
    '<td>' + escapeHtml(it.purpose) + '</td><td>' + escapeHtml(it.oldPartReturned) + '</td>' +
    '<td><button class="secondary" onclick="removeReqItem(' + idx + ')">✕</button></td></tr>'
  ).join('') : '<tr><td colspan="9" class="empty">No items added yet.</td></tr>';
}
function submitRequisition() {
  const requestedBy = document.getElementById('rq_requestedBy').value.trim();
  document.getElementById('rq_date').value = document.getElementById('rq_date').value || todayStr();
  if (!requestedBy) { showMsg('newReqMsg', 'Select who this requisition is for.', false); return; }
  if (REQ_CART.length === 0) { showMsg('newReqMsg', 'Add at least one item.', false); return; }

  const btn = document.getElementById('rq_submitBtn');
  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.innerHTML = '<span class="spin"></span>Submitting…';
  document.getElementById('newReqMsg').style.display = 'none';

  const form = { requestedBy: requestedBy, date: document.getElementById('rq_date').value, items: REQ_CART };
  callApi('createRequisition', form).then(res => {
    showMsg('newReqMsg', '✅ Requisition ' + res.reqNo + ' submitted successfully — awaiting Stage 1 approval (' + res.itemCount + ' item(s)).', true);
    REQ_CART = [];
    renderReqCart();
    if (!(CURRENT_USER && CURRENT_USER.role === 'requestor')) {
      document.getElementById('rq_requestedBy').value = '';
    }
    loadRequisitions();
    btn.textContent = originalLabel;
    btn.disabled = false; // re-enabled for the NEXT requisition, but this one is safely submitted
  }).catch(err => {
    showMsg('newReqMsg', 'Error: ' + err.message, false);
    btn.textContent = originalLabel;
    btn.disabled = false; // re-enable so the user can retry after a genuine failure
  });
}

function loadRequisitions() {
  callApi('getRequisitions').then(list => {
    REQUISITIONS = list;
    const stillApproved = new Set(list.filter(r => r.status === 'Approved').map(r => r.reqNo));
    Array.from(REQ_SELECTED_FOR_PRINT).forEach(reqNo => { if (!stillApproved.has(reqNo)) REQ_SELECTED_FOR_PRINT.delete(reqNo); });
    renderRequisitionsList();
  }).catch(() => {});
}

function statusBadge(status) {
  const cls = status === 'Approved' ? 'ok'
    : status === 'Issued' ? 'issued'
    : (status === 'Rejected' || status === 'Cancelled') ? 'reorder'
    : 'pending';
  return '<span class="badge ' + cls + '">' + escapeHtml(status) + '</span>';
}

function renderRequisitionsList() {
  const filterEl = document.getElementById('rq_statusFilter');
  const filter = filterEl ? filterEl.value : 'All';
  const list = filter === 'All' ? REQUISITIONS : REQUISITIONS.filter(r => r.status === filter);
  document.getElementById('rq_listBody').innerHTML = list.length ? list.map(r => {
    const canPrint = r.status === 'Approved' || r.status === 'Issued';
    const checked = REQ_SELECTED_FOR_PRINT.has(r.reqNo) ? 'checked' : '';
    return '<tr>' +
      '<td onclick="event.stopPropagation()">' + (canPrint
        ? '<input type="checkbox" ' + checked + ' onchange="toggleReqSelected(\'' + r.reqNo + '\', this.checked)">'
        : '') + '</td>' +
      '<td class="clickable" onclick="viewRequisition(\'' + r.reqNo + '\')"><b>' + escapeHtml(r.reqNo) + '</b></td>' +
      '<td class="clickable" onclick="viewRequisition(\'' + r.reqNo + '\')">' + (r.dateRequested ? new Date(r.dateRequested).toLocaleDateString() : '—') + '</td>' +
      '<td class="clickable" onclick="viewRequisition(\'' + r.reqNo + '\')">' + escapeHtml(r.requestedBy) + '</td>' +
      '<td class="num-cell clickable" onclick="viewRequisition(\'' + r.reqNo + '\')">' + r.itemCount + '</td>' +
      '<td class="clickable" onclick="viewRequisition(\'' + r.reqNo + '\')">' + statusBadge(r.status) + '</td></tr>';
  }).join('') : '<tr><td colspan="6" class="empty">No requisitions' + (filter === 'All' ? '' : ' with status "' + escapeHtml(filter) + '"') + ' yet.</td></tr>';
  updateSelectedCount();
}

function toggleReqSelected(reqNo, checked) {
  if (checked) REQ_SELECTED_FOR_PRINT.add(reqNo);
  else REQ_SELECTED_FOR_PRINT.delete(reqNo);
  updateSelectedCount();
}

function updateSelectedCount() {
  const n = REQ_SELECTED_FOR_PRINT.size;
  document.getElementById('rq_selectedCount').textContent = n ? (n + ' selected') : '';
}

function printSelectedRequisitions() {
  const reqNos = Array.from(REQ_SELECTED_FOR_PRINT);
  if (reqNos.length === 0) { alert('Tick at least one Approved requisition to print.'); return; }
  callApi('getRequisitionsBatchPrintHtml', reqNos).then(html => {
    const w = window.open('', '_blank');
    if (!w) { alert('Please allow pop-ups for this site to print/download the requisitions.'); return; }
    w.document.open();
    w.document.write(html);
    w.document.close();
  }).catch(err => alert('Error: ' + err.message));
}

function viewRequisition(reqNo) {
  document.getElementById('rq_detailMsg').style.display = 'none';
  callApi('getRequisitionDetail', reqNo).then(detail => {
    CURRENT_REQ_DETAIL = detail;
    renderRequisitionDetail();
  }).catch(err => showMsg('rq_detailMsg', 'Error: ' + err.message, false));
}

function renderRequisitionDetail() {
  const d = CURRENT_REQ_DETAIL;
  if (!d) return;
  document.getElementById('rq_detailPanel').style.display = 'block';
  document.getElementById('rq_detailTitle').textContent = d.header.reqNo + ' — ' + d.header.requestedBy;
  document.getElementById('rq_detailStatus').innerHTML = statusBadge(d.header.status);
  document.getElementById('rq_detailItems').innerHTML = d.items.map(it =>
    '<tr><td>' + it.itemNo + '</td><td>' + escapeHtml(it.code) + '</td><td>' + escapeHtml(it.name) + '</td>' +
    '<td class="num-cell">' + it.qty + '</td><td>' + escapeHtml(it.uom) + '</td><td>' + escapeHtml(it.bin) + '</td>' +
    '<td>' + escapeHtml(it.purpose) + '</td><td>' + escapeHtml(it.oldPartReturned) + '</td></tr>'
  ).join('');

  const actions = document.getElementById('rq_detailActions');
  if (d.header.status === 'Pending Stage 1 Approval') {
    actions.innerHTML =
      '<div class="field" style="max-width:280px"><label>Stage 1 Approval Code</label><input id="rq_approvalCode" type="password" placeholder="Enter your code"></div>' +
      '<button class="primary" onclick="doApproveStage1()">✅ Approve (Stage 1)</button> ' +
      '<button class="secondary" onclick="doReject()">✖ Reject</button>' +
      '<p class="stage-note">Stage 1 approvers: Lee Kariuki, James Kamami, or Francis Mutie.</p>';
  } else if (d.header.status === 'Pending Stage 2 Approval') {
    actions.innerHTML =
      '<p class="muted">Stage 1 approved by <b>' + escapeHtml(d.header.stage1ApprovedBy) + '</b>' +
      (d.header.stage1Date ? ' on ' + new Date(d.header.stage1Date).toLocaleDateString() : '') + '</p>' +
      '<div class="field" style="max-width:280px"><label>Stage 2 (Final) Approval Code</label><input id="rq_approvalCode" type="password" placeholder="Enter your code"></div>' +
      '<button class="primary" onclick="doApproveStage2()">✅ Approve (Final)</button> ' +
      '<button class="secondary" onclick="doReject()">✖ Reject</button>' +
      '<p class="stage-note">Stage 2 approvers: Rocky Rohit or Mary Rimui.</p>';
  } else if (d.header.status === 'Approved') {
    let html =
      '<p class="muted">Stage 1 approved by <b>' + escapeHtml(d.header.stage1ApprovedBy) + '</b>' +
      (d.header.stage1Date ? ' on ' + new Date(d.header.stage1Date).toLocaleDateString() : '') + '<br>' +
      'Final approval by <b>' + escapeHtml(d.header.stage2ApprovedBy) + '</b>' +
      (d.header.stage2Date ? ' on ' + new Date(d.header.stage2Date).toLocaleDateString() : '') + '</p>' +
      '<button class="primary" onclick="printRequisition()">🖨️ Print / Download Requisition</button>';

    // Store personnel AND Stage 2 approvers (super users) can perform store actions.
    if (CURRENT_USER && (CURRENT_USER.role === 'store' || CURRENT_USER.role === 'superuser')) {
      html +=
        '<div class="store-action">' +
        '<h3 style="font-size:14px;margin:0 0 8px">Store Action</h3>' +
        '<div class="field" style="max-width:280px"><label>' + (CURRENT_USER.role === 'superuser' ? 'Stage 2 Approval Code' : 'Store Keeper Code') + '</label><input id="rq_storeCode" type="password" placeholder="Enter your code"></div>' +
        '<div class="field" style="max-width:480px"><label>Notes (optional)</label><input id="rq_storeNotes" placeholder="e.g. reason for revision"></div>' +
        '<button class="primary" onclick="doStoreAction(\'Issued\')">✅ Mark Issued</button> ' +
        '<button class="secondary" onclick="doStoreAction(\'To Be Revised\')">✏️ To Be Revised</button> ' +
        '<button class="secondary" onclick="doStoreAction(\'Cancelled\')">✖ Cancel</button>' +
        '</div>';
    }
    actions.innerHTML = html;
  } else if (d.header.status === 'Issued') {
    actions.innerHTML =
      '<p class="muted">Issued by <b>' + escapeHtml(d.header.storeActionBy) + '</b>' +
      (d.header.storeActionDate ? ' on ' + new Date(d.header.storeActionDate).toLocaleDateString() : '') +
      (d.header.storeNotes ? ' — ' + escapeHtml(d.header.storeNotes) : '') + '</p>' +
      '<button class="primary" onclick="printRequisition()">🖨️ Print / Download Requisition</button>';
  } else if (d.header.status === 'To Be Revised') {
    actions.innerHTML =
      '<p class="muted">Flagged for revision by <b>' + escapeHtml(d.header.storeActionBy) + '</b>' +
      (d.header.storeActionDate ? ' on ' + new Date(d.header.storeActionDate).toLocaleDateString() : '') +
      (d.header.storeNotes ? ' — ' + escapeHtml(d.header.storeNotes) : '') + '</p>';
  } else if (d.header.status === 'Cancelled') {
    actions.innerHTML =
      '<p class="muted">Cancelled by <b>' + escapeHtml(d.header.storeActionBy) + '</b>' +
      (d.header.storeActionDate ? ' on ' + new Date(d.header.storeActionDate).toLocaleDateString() : '') +
      (d.header.storeNotes ? ' — ' + escapeHtml(d.header.storeNotes) : '') + '</p>';
  } else if (d.header.status === 'Rejected') {
    actions.innerHTML = '<p class="muted">Rejected at Stage ' + escapeHtml(String(d.header.rejectedStage)) + ' by <b>' + escapeHtml(d.header.rejectedBy) + '</b>' +
      (d.header.notes ? ' — ' + escapeHtml(d.header.notes) : '') + '</p>';
  }
}

function doApproveStage1() {
  const code = document.getElementById('rq_approvalCode').value.trim();
  if (!code) { showMsg('rq_detailMsg', 'Enter your Stage 1 approval code.', false); return; }
  callApi('approveRequisitionStage1', CURRENT_REQ_DETAIL.header.reqNo, code).then(res => {
    showMsg('rq_detailMsg', res.reqNo + ' approved at Stage 1 by ' + res.approvedBy + ' — now awaiting Stage 2.', true);
    loadRequisitions();
    viewRequisition(res.reqNo);
  }).catch(err => showMsg('rq_detailMsg', 'Error: ' + err.message, false));
}

function doApproveStage2() {
  const code = document.getElementById('rq_approvalCode').value.trim();
  if (!code) { showMsg('rq_detailMsg', 'Enter your Stage 2 approval code.', false); return; }
  callApi('approveRequisitionStage2', CURRENT_REQ_DETAIL.header.reqNo, code).then(res => {
    showMsg('rq_detailMsg', res.reqNo + ' fully approved by ' + res.approvedBy + '.', true);
    loadRequisitions();
    viewRequisition(res.reqNo);
  }).catch(err => showMsg('rq_detailMsg', 'Error: ' + err.message, false));
}

function doReject() {
  const code = document.getElementById('rq_approvalCode').value.trim();
  if (!code) { showMsg('rq_detailMsg', 'Enter your approval code to reject.', false); return; }
  const reason = prompt('Reason for rejection (optional):') || '';
  callApi('rejectRequisition', CURRENT_REQ_DETAIL.header.reqNo, code, reason).then(res => {
    showMsg('rq_detailMsg', res.reqNo + ' rejected.', true);
    loadRequisitions();
    viewRequisition(res.reqNo);
  }).catch(err => showMsg('rq_detailMsg', 'Error: ' + err.message, false));
}

function doStoreAction(action) {
  const code = document.getElementById('rq_storeCode').value.trim();
  const notes = document.getElementById('rq_storeNotes').value.trim();
  if (!code) { showMsg('rq_detailMsg', 'Enter your Store Keeper code.', false); return; }
  callApi('markRequisitionStoreAction', CURRENT_REQ_DETAIL.header.reqNo, code, action, notes).then(res => {
    showMsg('rq_detailMsg', res.reqNo + ' marked as "' + res.status + '" by ' + res.by + '.', true);
    loadRequisitions();
    viewRequisition(res.reqNo);
  }).catch(err => showMsg('rq_detailMsg', 'Error: ' + err.message, false));
}

function printRequisition() {
  callApi('getRequisitionPrintHtml', CURRENT_REQ_DETAIL.header.reqNo).then(html => {
    const w = window.open('', '_blank');
    if (!w) { alert('Please allow pop-ups for this site to print/download the requisition.'); return; }
    w.document.open();
    w.document.write(html);
    w.document.close();
  }).catch(err => showMsg('rq_detailMsg', 'Error: ' + err.message, false));
}
