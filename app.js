/* =========================================================
 * app.js — Gestion comptable location de voitures v3.0
 * Persistance via DB (SQLite sur Android, localStorage en test navigateur)
 * ========================================================= */

/* ===== Locale (chiffres latins) ===== */
const LATN_LOCALE = 'ar-MA-u-nu-latn';
function formatNumberLatn(n, opts = {}) { return new Intl.NumberFormat(LATN_LOCALE, opts).format(Number(n || 0)); }
function formatCurrency(x) { const v = Number(x || 0); return `${formatNumberLatn(v, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${appData.settings.currency}`; }
function formatDate(s) { if (!s) return 'غير محدد'; return new Date(s).toLocaleDateString(LATN_LOCALE, { year: 'numeric', month: '2-digit', day: '2-digit' }); }
function formatDateTime(s, t) { if (!s) return 'غير محدد'; const d = formatDate(s); return t ? `${d} - ${t}` : d; }
function genId(p) { return p + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).substr(2, 4); }
function escapeHtml(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ===== Données ===== */
const DEFAULT_SETTINGS = { taxRate: 0.2, companyName: 'ISAR AUTO sarl', currency: 'د.م', logoDataUrl: '', version: '3.0', gasEndpoint: '' };
const defaultCars = [
  { id: 'CAR-001', model: 'DACIA LOGAN', number: '35110-D-40', year: 2022, color: 'أبيض', dailyPrice: 200, status: 'متاحة' },
  { id: 'CAR-002', model: 'SANDERO', number: '35119-D-40', year: 2022, color: 'رمادي', dailyPrice: 220, status: 'متاحة' },
  { id: 'CAR-003', model: 'RENAULT CLIO', number: '35068-D-40', year: 2023, color: 'أحمر', dailyPrice: 250, status: 'متاحة' }
];

let appData = { rentals: [], expenses: [], invoices: [], cars: [], clients: [], settings: { ...DEFAULT_SETTINGS } };
let editingRentalId = null, editingCarId = null, editingExpenseId = null, editingClientId = null;
let currentInvoice = null;

/* ===== Calcul de la taxe : la TVA est INCLUSE dans le prix payé =====
   gross = prix payé par le client (TTC) ; net = gross / (1 + taux) ; taxe = gross - net */
function taxBreakdown(gross, rate) {
  const g = Number(gross) || 0;
  const r = (typeof rate === 'number' && rate >= 0) ? rate : ((appData.settings && appData.settings.taxRate) ?? 0.2);
  const net = r > 0 ? g / (1 + r) : g;
  const tax = g - net;
  return { gross: g, net: net, tax: tax, rate: r };
}
function rentalGross(r) {
  const g = (Number(r.days) || 0) * (Number(r.pricePerDay) || 0);
  return g > 0 ? g : (Number(r.totalAmount) || 0);
}
function rentalBreakdown(r) {
  const rate = (typeof r.taxRate === 'number') ? r.taxRate : ((appData.settings && appData.settings.taxRate) ?? 0.2);
  return taxBreakdown(rentalGross(r), rate);
}
/* Date de référence d'un contrat pour les rapports (repli si startDate vide) */
function rentalDate(r) {
  if (r.startDate) return r.startDate;
  if (r.createdAt) return String(r.createdAt).slice(0, 10);
  const part = String(r.id || '').split('-')[1];
  const ms = part ? parseInt(part, 36) : NaN;
  if (!isNaN(ms)) { try { return new Date(ms).toISOString().slice(0, 10); } catch (_) {} }
  return '';
}

/* ===== Fichiers (téléchargement web / partage natif) ===== */
function isNative() { return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()); }
function textToBase64(s) { return btoa(unescape(encodeURIComponent(s))); }

async function deliverFile(filename, base64, mime) {
  if (isNative()) {
    const { Filesystem, Share } = window.Capacitor.Plugins;
    try {
      const res = await Filesystem.writeFile({ path: filename, data: base64, directory: 'CACHE' });
      await Share.share({ title: filename, url: res.uri });
      return;
    } catch (e) {
      if (String(e).includes('canceled')) return;
      alert('تعذر حفظ الملف: ' + e); return;
    }
  }
  // navigateur
  const byteChars = atob(base64);
  const bytes = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}

/* ===== Démarrage ===== */
window.addEventListener('DOMContentLoaded', async () => {
  const backend = await DB.init();
  document.getElementById('db-badge').textContent = backend === 'sqlite' ? 'SQLite ✓' : 'وضع المتصفح';

  appData.settings = await DB.getSettings(DEFAULT_SETTINGS);
  appData.cars = await DB.getAll('cars');
  appData.rentals = await DB.getAll('rentals');
  appData.expenses = await DB.getAll('expenses');
  appData.invoices = await DB.getAll('invoices');
  appData.clients = await DB.getAll('clients');

  if (!appData.cars.length) {
    appData.cars = [...defaultCars];
    await DB.replaceAll('cars', appData.cars);
  }

  await autoFreeCars();
  bindUI();
  loadSettingsForm();
  setupAmountCalculation();
  populateCarSelects(); populateClientSelect(); renderClients(); updateRentalsUI(); renderExpenses(); renderCars(); populateInvoiceRentals(); renderInvoicesTable(); updateDashboard(); refreshHeaderLogo();
  document.getElementById('invoice-date').value = new Date().toISOString().split('T')[0];
});

/* Statut auto : libère les voitures dont aucun contrat n'est en cours */
async function autoFreeCars() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (const car of appData.cars) {
    if (car.status !== 'مؤجرة') continue;
    const active = appData.rentals.some(r => r.carNumber === car.number && r.endDate && new Date(r.endDate) >= today);
    if (!active) { car.status = 'متاحة'; await DB.put('cars', car); }
  }
}

async function setCarStatus(carNumber, status) {
  const car = appData.cars.find(c => c.number === carNumber);
  if (car && car.status !== status) { car.status = status; await DB.put('cars', car); renderCars(); updateDashboard(); }
}

/* ===== Liaison UI ===== */
function bindUI() {
  document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'cars') renderCars();
    if (btn.dataset.tab === 'clients') renderClients();
    if (btn.dataset.tab === 'invoices') { populateInvoiceRentals(); renderInvoicesTable(); }
  }));

  document.getElementById('save-general-settings').addEventListener('click', saveGeneralSettings);

  // Logo
  const logoInput = document.getElementById('logo-input');
  const logoPreview = document.getElementById('logo-preview');
  if (appData.settings.logoDataUrl) logoPreview.src = appData.settings.logoDataUrl;
  document.getElementById('save-logo').addEventListener('click', async () => {
    if (!logoPreview.src) { alert('اختر الشعار أولًا'); return; }
    appData.settings.logoDataUrl = logoPreview.src;
    await DB.saveSettings(appData.settings);
    refreshHeaderLogo(); alert('تم حفظ الشعار');
  });
  document.getElementById('remove-logo').addEventListener('click', async () => {
    appData.settings.logoDataUrl = '';
    await DB.saveSettings(appData.settings);
    logoPreview.removeAttribute('src'); refreshHeaderLogo(); alert('تمت إزالة الشعار');
  });
  logoInput.addEventListener('change', e => {
    const f = e.target.files[0]; if (!f) return;
    if (f.size > 2 * 1024 * 1024) { alert('حجم الملف يتجاوز 2MB'); return; }
    const r = new FileReader();
    r.onload = ev => { logoPreview.src = ev.target.result; };
    r.readAsDataURL(f);
  });

  // Voitures
  document.getElementById('add-car-btn').addEventListener('click', saveCarFromForm);
  document.getElementById('cancel-car-edit').addEventListener('click', () => resetCarForm());

  // Contrats
  document.getElementById('add-rental-btn').addEventListener('click', saveRentalFromForm);
  document.getElementById('cancel-rental-edit').addEventListener('click', () => resetRentalForm());

  // Dépenses
  document.getElementById('add-expense-btn').addEventListener('click', saveExpenseFromForm);
  document.getElementById('cancel-expense-edit').addEventListener('click', () => resetExpenseForm());

  // Clients (زبائن)
  document.getElementById('add-client-btn').addEventListener('click', saveClientFromForm);
  document.getElementById('cancel-client-edit').addEventListener('click', () => resetClientForm());
  document.getElementById('client-search').addEventListener('input', renderClients);
  document.getElementById('export-clients-excel').addEventListener('click', () => exportArrayToExcel(clientsForExport(), 'الزبائن.xlsx'));
  document.getElementById('export-clients-csv').addEventListener('click', () => exportArrayToCSV(clientsForExport(), 'الزبائن.csv'));

  // Factures
  document.getElementById('gen-invoice-number').addEventListener('click', () => { document.getElementById('invoice-number').value = generateInvoiceNumber(); });
  document.getElementById('preview-invoice-btn').addEventListener('click', previewInvoice);
  document.getElementById('download-invoice-html').addEventListener('click', downloadInvoiceAsHTML);
  document.getElementById('refresh-invoice-rentals').addEventListener('click', populateInvoiceRentals);
  document.querySelectorAll('input[name="inv-mode"]').forEach(r => r.addEventListener('change', toggleInvoiceMode));

  // Rapports
  document.getElementById('income-period').addEventListener('change', e => { document.getElementById('income-custom').style.display = (e.target.value === 'custom') ? 'grid' : 'none'; });
  document.getElementById('expense-period').addEventListener('change', e => { document.getElementById('expense-custom').style.display = (e.target.value === 'custom') ? 'grid' : 'none'; });
  document.getElementById('gen-income-report').addEventListener('click', generateIncomeReport);
  document.getElementById('gen-expense-report').addEventListener('click', generateExpenseReport);

  // Exports
  document.getElementById('export-rentals-excel').addEventListener('click', () => exportArrayToExcel(rentalsForExport(), 'الإيجارات.xlsx'));
  document.getElementById('export-rentals-csv').addEventListener('click', () => exportArrayToCSV(rentalsForExport(), 'الإيجارات.csv'));
  document.getElementById('export-expenses-excel').addEventListener('click', () => exportArrayToExcel(expensesForExport(), 'المصاريف.xlsx'));
  document.getElementById('export-expenses-csv').addEventListener('click', () => exportArrayToCSV(expensesForExport(), 'المصاريف.csv'));

  // Sauvegarde / restauration
  document.getElementById('backup-download').addEventListener('click', async () => {
    const data = await DB.exportAll();
    const name = 'sauvegarde_' + new Date().toISOString().split('T')[0] + '.json';
    await deliverFile(name, textToBase64(JSON.stringify(data, null, 2)), 'application/json');
  });
  document.getElementById('backup-restore-btn').addEventListener('click', () => document.getElementById('backup-restore-input').click());
  document.getElementById('backup-restore-input').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    if (!confirm('سيتم استبدال كل البيانات الحالية بمحتوى الملف. هل أنت متأكد؟')) { e.target.value = ''; return; }
    try {
      const text = await f.text();
      await DB.importAll(JSON.parse(text));
      appData.settings = await DB.getSettings(DEFAULT_SETTINGS);
      appData.cars = await DB.getAll('cars');
      appData.rentals = await DB.getAll('rentals');
      appData.expenses = await DB.getAll('expenses');
      appData.invoices = await DB.getAll('invoices');
      appData.clients = await DB.getAll('clients');
      loadSettingsForm(); populateCarSelects(); populateClientSelect(); renderClients(); updateRentalsUI(); renderExpenses(); renderCars(); populateInvoiceRentals(); renderInvoicesTable(); updateDashboard(); refreshHeaderLogo();
      alert('تم الاسترجاع بنجاح');
    } catch (err) { alert('ملف غير صالح: ' + err); }
    e.target.value = '';
  });

  // Google Sheets
  document.getElementById('sync-push').addEventListener('click', syncPushToSheets);
  document.getElementById('sync-pull').addEventListener('click', syncPullFromSheets);
}

function loadSettingsForm() {
  document.getElementById('company-name').value = appData.settings.companyName ?? '';
  document.getElementById('currency').value = appData.settings.currency ?? 'د.م';
  document.getElementById('tax-rate-setting').value = appData.settings.taxRate ?? 0.2;
  document.getElementById('gas-endpoint').value = appData.settings.gasEndpoint ?? '';
}

async function saveGeneralSettings() {
  const taxInput = parseFloat(document.getElementById('tax-rate-setting').value);
  if (isNaN(taxInput) || taxInput < 0 || taxInput > 1) { alert('نسبة الضريبة يجب أن تكون بين 0 و 1'); return; }
  appData.settings.companyName = document.getElementById('company-name').value ?? '';
  appData.settings.currency = document.getElementById('currency').value ?? 'د.م';
  appData.settings.taxRate = taxInput;
  appData.settings.gasEndpoint = (document.getElementById('gas-endpoint').value || '').trim();
  await DB.saveSettings(appData.settings);
  alert('تم حفظ الإعدادات');
  refreshHeaderLogo(); updateDashboard();
}

function refreshHeaderLogo() {
  const img = document.getElementById('company-logo');
  if (appData.settings.logoDataUrl) { img.src = appData.settings.logoDataUrl; img.style.display = 'block'; }
  else { img.removeAttribute('src'); img.style.display = 'none'; }
}

function updateDashboard() {
  let totalRevenue = 0, totalTax = 0;
  appData.rentals.forEach(r => { const bd = rentalBreakdown(r); totalRevenue += bd.gross; totalTax += bd.tax; });
  const totalExpenses = appData.expenses.reduce((s, e) => s + (e.amount || 0), 0);
  const net = totalRevenue - totalTax - totalExpenses;
  document.getElementById('total-income').textContent = formatCurrency(totalRevenue);
  document.getElementById('total-expenses').textContent = formatCurrency(totalExpenses);
  document.getElementById('net-profit').textContent = formatCurrency(net);
  const taxEl = document.getElementById('total-tax'); if (taxEl) taxEl.textContent = formatCurrency(totalTax);
  document.getElementById('total-cars').textContent = formatNumberLatn(appData.cars.length);
  document.getElementById('available-cars').textContent = formatNumberLatn(appData.cars.filter(c => c.status === 'متاحة').length);
  const totalClientsEl = document.getElementById('total-clients'); if (totalClientsEl) totalClientsEl.textContent = formatNumberLatn(appData.clients.length);
}

/* ===== Sélecteurs voitures ===== */
function populateCarSelects() {
  const carType = document.getElementById('rental-car-type');
  const carNumber = document.getElementById('rental-car-number');
  const expenseCar = document.getElementById('expense-car');
  const pm = document.getElementById('rental-payment-method');
  if (!carType || !carNumber || !expenseCar) return;

  carType.innerHTML = ''; carNumber.innerHTML = ''; expenseCar.innerHTML = '';
  const opt0 = document.createElement('option'); opt0.value = ''; opt0.textContent = '-- اختر سيارة --'; opt0.disabled = true; opt0.selected = true; carType.appendChild(opt0);

  appData.cars.forEach(c => {
    const t = document.createElement('option');
    t.value = JSON.stringify({ model: c.model, number: c.number, price: c.dailyPrice });
    t.textContent = `${c.model} (${c.number})${c.status === 'مؤجرة' ? ' — مؤجرة' : ''}`;
    carType.appendChild(t);

    const n = document.createElement('option'); n.value = c.number; n.textContent = c.number; carNumber.appendChild(n);
    const e = document.createElement('option'); e.value = c.number; e.textContent = `${c.model} - ${c.number}`; expenseCar.appendChild(e);
  });

  pm.innerHTML = '';
  ['نقد', 'تحويل', 'بطاقة', 'شيك'].forEach(m => { const o = document.createElement('option'); o.value = m; o.textContent = m; pm.appendChild(o); });

  carType.onchange = function () {
    try {
      const sel = JSON.parse(this.value);
      if (sel && sel.number) {
        carNumber.value = sel.number;
        document.getElementById('rental-price').value = parseFloat(sel.price) || 200;
        recalcRentalAmount();
      }
    } catch (_) {}
  };
  carNumber.onchange = function () {
    const car = appData.cars.find(x => x.number === this.value);
    if (car) {
      for (const o of carType.options) {
        try { const v = JSON.parse(o.value); if (v && v.number === car.number) { carType.value = o.value; break; } } catch (_) {}
      }
      document.getElementById('rental-price').value = car.dailyPrice;
      recalcRentalAmount();
    }
  };
}

/* ===== Calcul manuel jours × prix ===== */
function setupAmountCalculation() {
  const s = document.getElementById('rental-start-date');
  const e = document.getElementById('rental-end-date');
  const sTime = document.getElementById('rental-start-time');
  const eTime = document.getElementById('rental-end-time');
  const p = document.getElementById('rental-price');
  const daysInput = document.getElementById('rental-days');

  const t = new Date().toISOString().split('T')[0];
  const tm = new Date(); tm.setDate(tm.getDate() + 1);
  s.value = t; e.value = tm.toISOString().split('T')[0];
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  if (sTime) sTime.value = hhmm;
  if (eTime) eTime.value = hhmm;

  function calc() {
    const pr = parseFloat(p.value) || 0;
    const days = parseInt(daysInput.value, 10) || 1;
    const disp = document.getElementById('total-amount-display');
    if (pr <= 0) { disp.textContent = 'السعر اليومي غير صالح'; return; }
    const bd = taxBreakdown(days * pr, appData.settings.taxRate ?? 0.2);
    disp.innerHTML = `${formatCurrency(bd.gross)} <span style="font-weight:400;font-size:.8rem;color:#666">(صافي ${formatCurrency(bd.net)} + ضريبة ${formatCurrency(bd.tax)})</span>`;
  }
  window.recalcRentalAmount = calc;
  p.addEventListener('input', calc);
  daysInput.addEventListener('input', calc);
  calc();
}

/* ===== Voitures : CRUD ===== */
function resetCarForm() {
  editingCarId = null;
  document.getElementById('car-form-title').textContent = 'إضافة سيارة';
  document.getElementById('add-car-btn').textContent = 'إضافة سيارة';
  document.getElementById('cancel-car-edit').style.display = 'none';
  ['car-model', 'car-number', 'car-color'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('car-year').value = 2023;
  document.getElementById('car-price').value = 200;
  document.getElementById('car-status').value = 'متاحة';
}

async function saveCarFromForm() {
  const m = document.getElementById('car-model').value.trim();
  const n = document.getElementById('car-number').value.trim();
  const y = parseInt(document.getElementById('car-year').value, 10);
  const c = document.getElementById('car-color').value.trim();
  const d = parseFloat(document.getElementById('car-price').value);
  const st = document.getElementById('car-status').value;
  if (!m || !n || !y || isNaN(d)) { alert('يرجى ملء كل الحقول'); return; }
  if (d <= 0) { alert('السعر اليومي يجب أن يكون أكبر من صفر'); return; }
  const dup = appData.cars.find(x => x.number === n && x.id !== editingCarId);
  if (dup) { alert('رقم السيارة موجود'); return; }

  if (editingCarId) {
    const car = appData.cars.find(x => x.id === editingCarId);
    Object.assign(car, { model: m, number: n, year: y, color: c, dailyPrice: d, status: st });
    await DB.put('cars', car);
    alert('تم تعديل السيارة');
  } else {
    const car = { id: genId('CAR'), model: m, number: n, year: y, color: c, dailyPrice: d, status: st };
    appData.cars.push(car);
    await DB.put('cars', car);
    alert('تمت إضافة السيارة');
  }
  resetCarForm(); populateCarSelects(); renderCars(); updateDashboard();
}

function renderCars() {
  const body = document.getElementById('cars-table-body'); body.innerHTML = '';
  if (!appData.cars.length) { body.innerHTML = '<tr><td colspan="5" style="color:#666;padding:14px">لا توجد سيارات</td></tr>'; return; }
  appData.cars.forEach(c => {
    const tr = document.createElement('tr');
    [c.model, c.number, formatCurrency(c.dailyPrice), c.status].forEach(v => {
      const td = document.createElement('td'); td.textContent = v; tr.appendChild(td);
    });
    const td = document.createElement('td');
    td.appendChild(actionBtn('تعديل', '', () => {
      editingCarId = c.id;
      document.getElementById('car-form-title').textContent = 'تعديل سيارة';
      document.getElementById('add-car-btn').textContent = 'حفظ التعديل';
      document.getElementById('cancel-car-edit').style.display = 'inline-block';
      document.getElementById('car-model').value = c.model;
      document.getElementById('car-number').value = c.number;
      document.getElementById('car-year').value = c.year;
      document.getElementById('car-color').value = c.color || '';
      document.getElementById('car-price').value = c.dailyPrice;
      document.getElementById('car-status').value = c.status;
    }));
    td.appendChild(actionBtn('حذف', 'btn-danger', async () => {
      if (appData.rentals.some(r => r.carNumber === c.number)) {
        if (!confirm('توجد عقود مرتبطة بهذه السيارة. حذفها على أي حال؟')) return;
      } else if (!confirm('حذف هذه السيارة؟')) return;
      appData.cars = appData.cars.filter(x => x.id !== c.id);
      await DB.remove('cars', c.id);
      populateCarSelects(); renderCars(); updateDashboard();
    }));
    tr.appendChild(td);
    body.appendChild(tr);
  });
}

function actionBtn(label, cls, onclick) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'btn btn-sm ' + cls; b.textContent = label;
  b.style.margin = '2px'; b.addEventListener('click', onclick);
  return b;
}

/* ===== Contrats : CRUD ===== */
function resetRentalForm() {
  editingRentalId = null;
  document.getElementById('rental-form-title').textContent = 'إضافة عقد إيجار';
  document.getElementById('add-rental-btn').textContent = 'إضافة العقد';
  document.getElementById('cancel-rental-edit').style.display = 'none';
  document.getElementById('rental-customer').value = '';
  const rcs = document.getElementById('rental-client'); if (rcs) rcs.value = '';
  document.getElementById('rental-days').value = 1;
  recalcRentalAmount();
}

async function saveRentalFromForm() {
  const customer = document.getElementById('rental-customer').value.trim();
  const clientSel = document.getElementById('rental-client');
  const clientId = clientSel ? clientSel.value : '';
  const val = document.getElementById('rental-car-type').value;
  let carModel = '', carNumber = '';
  let price = parseFloat(document.getElementById('rental-price').value) || 0;
  try { const obj = JSON.parse(val); carModel = obj.model; carNumber = obj.number; } catch (_) {}

  const s = document.getElementById('rental-start-date').value;
  const e = document.getElementById('rental-end-date').value;
  const sTime = document.getElementById('rental-start-time').value;
  const eTime = document.getElementById('rental-end-time').value;
  const days = parseInt(document.getElementById('rental-days').value, 10) || 1;
  const paymentMethod = document.getElementById('rental-payment-method').value;

  if (!customer || !carModel || !carNumber) { alert('يرجى ملء الحقول الأساسية'); return; }
  if (price <= 0) { alert('السعر اليومي غير صالح'); return; }
  if (days <= 0) { alert('عدد الأيام غير صالح'); return; }
  if (s && e) {
    const sd = new Date(`${s}T${sTime || '00:00'}`), ed = new Date(`${e}T${eTime || '00:00'}`);
    if (ed < sd) { alert('تاريخ/وقت الانتهاء يجب أن يكون بعد البدء'); return; }
  }

  const rate = appData.settings.taxRate ?? 0.2;
  const bd = taxBreakdown(days * price, rate);

  if (editingRentalId) {
    const r = appData.rentals.find(x => x.id === editingRentalId);
    const oldCar = r.carNumber;
    Object.assign(r, { customerName: customer, clientId, carModel, carNumber, startDate: s, endDate: e, startTime: sTime, endTime: eTime, days, pricePerDay: price, totalAmount: bd.gross, taxAmount: bd.tax, netAmount: bd.net, taxRate: rate, paymentMethod });
    await DB.put('rentals', r);
    if (oldCar !== carNumber) await setCarStatus(oldCar, 'متاحة');
    await setCarStatus(carNumber, 'مؤجرة');
    alert('تم تعديل العقد');
  } else {
    const r = { id: genId('RENT'), customerName: customer, clientId, carModel, carNumber, startDate: s, endDate: e, startTime: sTime, endTime: eTime, days, pricePerDay: price, totalAmount: bd.gross, taxAmount: bd.tax, netAmount: bd.net, taxRate: rate, paymentMethod, isPaid: false, createdAt: new Date().toISOString() };
    appData.rentals.push(r);
    await DB.put('rentals', r);
    await setCarStatus(carNumber, 'مؤجرة');
    alert('تمت إضافة العقد');
  }
  resetRentalForm(); updateRentalsUI(); populateInvoiceRentals();
}

function updateRentalsUI() {
  const body = document.getElementById('rentals-table-body'); body.innerHTML = '';
  if (!appData.rentals.length) {
    body.innerHTML = '<tr><td colspan="9" style="color:#666;padding:14px">لا توجد عقود</td></tr>';
    updateDashboard(); return;
  }
  appData.rentals.slice().reverse().forEach(r => {
    const bd = rentalBreakdown(r);
    const tr = document.createElement('tr');
    [r.customerName, r.carModel, r.carNumber, formatDateTime(r.startDate, r.startTime), (r.endDate ? formatDateTime(r.endDate, r.endTime) : '-'), `${formatNumberLatn(r.days)} يوم`]
      .forEach(v => { const td = document.createElement('td'); td.textContent = v; tr.appendChild(td); });

    const tdNet = document.createElement('td');
    tdNet.innerHTML = `<div style="font-weight:800">${formatCurrency(bd.net)}</div><div class="hint" style="font-size:.78rem">ضريبة: ${formatCurrency(bd.tax)}</div>`;
    tr.appendChild(tdNet);

    const tdPaid = document.createElement('td');
    const tag = document.createElement('span');
    tag.className = 'tag ' + (r.isPaid ? 'tag-paid' : 'tag-unpaid');
    tag.textContent = r.isPaid ? 'مدفوع' : 'غير مدفوع';
    tag.style.cursor = 'pointer';
    tag.title = 'اضغط للتغيير';
    tag.addEventListener('click', async () => { r.isPaid = !r.isPaid; await DB.put('rentals', r); updateRentalsUI(); });
    tdPaid.appendChild(tag); tr.appendChild(tdPaid);

    const td = document.createElement('td');
    td.appendChild(actionBtn('تعديل', '', () => {
      editingRentalId = r.id;
      document.getElementById('rental-form-title').textContent = 'تعديل عقد';
      document.getElementById('add-rental-btn').textContent = 'حفظ التعديل';
      document.getElementById('cancel-rental-edit').style.display = 'inline-block';
      document.getElementById('rental-customer').value = r.customerName;
      const rcs2 = document.getElementById('rental-client'); if (rcs2) rcs2.value = r.clientId || '';
      document.getElementById('rental-start-date').value = r.startDate || '';
      document.getElementById('rental-end-date').value = r.endDate || '';
      document.getElementById('rental-start-time').value = r.startTime || '';
      document.getElementById('rental-end-time').value = r.endTime || '';
      document.getElementById('rental-days').value = r.days;
      document.getElementById('rental-price').value = r.pricePerDay;
      const carNumber = document.getElementById('rental-car-number');
      carNumber.value = r.carNumber; carNumber.onchange && carNumber.onchange.call(carNumber);
      recalcRentalAmount();
      document.querySelector('.tab-btn[data-tab="rentals"]').click();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }));
    td.appendChild(actionBtn('حذف', 'btn-danger', async () => {
      if (!confirm('حذف هذا العقد؟')) return;
      appData.rentals = appData.rentals.filter(x => x.id !== r.id);
      await DB.remove('rentals', r.id);
      const stillRented = appData.rentals.some(x => x.carNumber === r.carNumber);
      if (!stillRented) await setCarStatus(r.carNumber, 'متاحة');
      updateRentalsUI(); populateInvoiceRentals();
    }));
    tr.appendChild(td);
    body.appendChild(tr);
  });
  updateDashboard();
}

/* ===== Dépenses : CRUD ===== */
function resetExpenseForm() {
  editingExpenseId = null;
  document.getElementById('expense-form-title').textContent = 'إضافة مصروف';
  document.getElementById('add-expense-btn').textContent = 'إضافة';
  document.getElementById('cancel-expense-edit').style.display = 'none';
  document.getElementById('expense-description').value = '';
  document.getElementById('expense-amount').value = 0;
  document.getElementById('expense-date').value = '';
}

async function saveExpenseFromForm() {
  const type = document.getElementById('expense-type').value;
  const desc = document.getElementById('expense-description').value.trim();
  const amount = parseFloat(document.getElementById('expense-amount').value) || 0;
  if (amount <= 0) { alert('المبلغ يجب أن يكون أكبر من صفر'); return; }
  const date = document.getElementById('expense-date').value || new Date().toISOString().split('T')[0];
  const car = document.getElementById('expense-car').value;
  const st = document.getElementById('expense-status').value;

  if (editingExpenseId) {
    const ex = appData.expenses.find(x => x.id === editingExpenseId);
    Object.assign(ex, { type, description: desc, amount, date, car, status: st });
    await DB.put('expenses', ex);
    alert('تم تعديل المصروف');
  } else {
    const ex = { id: genId('EXP'), type, description: desc, amount, date, car, status: st };
    appData.expenses.push(ex);
    await DB.put('expenses', ex);
    alert('تمت إضافة المصروف');
  }
  resetExpenseForm(); renderExpenses(); updateDashboard();
}

function renderExpenses() {
  const body = document.getElementById('expenses-table-body'); body.innerHTML = '';
  if (!appData.expenses.length) { body.innerHTML = '<tr><td colspan="5" style="color:#666;padding:14px">لا توجد مصاريف</td></tr>'; return; }
  appData.expenses.slice().reverse().forEach(e => {
    const tr = document.createElement('tr');
    [e.type, (e.car || '-'), formatCurrency(e.amount), formatDate(e.date)].forEach(v => {
      const td = document.createElement('td'); td.textContent = v; tr.appendChild(td);
    });
    const td = document.createElement('td');
    td.appendChild(actionBtn('تعديل', '', () => {
      editingExpenseId = e.id;
      document.getElementById('expense-form-title').textContent = 'تعديل مصروف';
      document.getElementById('add-expense-btn').textContent = 'حفظ التعديل';
      document.getElementById('cancel-expense-edit').style.display = 'inline-block';
      document.getElementById('expense-type').value = e.type;
      document.getElementById('expense-description').value = e.description || '';
      document.getElementById('expense-amount').value = e.amount;
      document.getElementById('expense-date').value = e.date || '';
      document.getElementById('expense-car').value = e.car || '';
      document.getElementById('expense-status').value = e.status || 'مدفوع';
    }));
    td.appendChild(actionBtn('حذف', 'btn-danger', async () => {
      if (!confirm('حذف هذا المصروف؟')) return;
      appData.expenses = appData.expenses.filter(x => x.id !== e.id);
      await DB.remove('expenses', e.id);
      renderExpenses(); updateDashboard();
    }));
    tr.appendChild(td);
    body.appendChild(tr);
  });
}

/* ===== Clients (زبائن) : CRUD + statistiques ===== */
function resetClientForm() {
  editingClientId = null;
  document.getElementById('client-form-title').textContent = 'إضافة زبون';
  document.getElementById('add-client-btn').textContent = 'إضافة الزبون';
  document.getElementById('cancel-client-edit').style.display = 'none';
  ['client-name', 'client-phone', 'client-address', 'client-email', 'client-birthdate', 'client-nationality', 'client-notes']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const bl = document.getElementById('client-blacklist'); if (bl) bl.checked = false;
}

async function saveClientFromForm() {
  const fullName = document.getElementById('client-name').value.trim();
  const phone = document.getElementById('client-phone').value.trim();
  const address = document.getElementById('client-address').value.trim();
  const email = document.getElementById('client-email').value.trim();
  const birthDate = document.getElementById('client-birthdate').value;
  const nationality = document.getElementById('client-nationality').value.trim();
  const notes = document.getElementById('client-notes').value.trim();
  const blacklisted = document.getElementById('client-blacklist').checked;
  if (!fullName) { alert('يرجى إدخال اسم الزبون'); return; }

  if (editingClientId) {
    const c = appData.clients.find(x => x.id === editingClientId);
    if (!c) { resetClientForm(); return; }
    const oldName = c.fullName;
    Object.assign(c, { fullName, phone, address, email, birthDate, nationality, notes, blacklisted });
    await DB.put('clients', c);
    if (oldName !== fullName) {
      for (const r of appData.rentals) {
        if (r.clientId === c.id && r.customerName !== fullName) { r.customerName = fullName; await DB.put('rentals', r); }
      }
    }
    alert('تم تعديل بيانات الزبون');
  } else {
    const c = { id: genId('CLI'), fullName, phone, address, email, birthDate, nationality, notes, blacklisted, createdAt: new Date().toISOString() };
    appData.clients.push(c);
    await DB.put('clients', c);
    alert('تمت إضافة الزبون');
  }
  resetClientForm(); renderClients(); populateClientSelect(); updateRentalsUI(); populateInvoiceRentals(); updateDashboard();
}

/* Statistiques d'un client : nombre de contrats, total dépensé, dernière location.
   Lien prioritaire par clientId ; repli sur le nom pour les anciens contrats non liés. */
function computeClientStats(client) {
  const list = appData.rentals.filter(r =>
    (r.clientId && r.clientId === client.id) ||
    (!r.clientId && client.fullName && r.customerName && r.customerName.trim() === client.fullName.trim())
  );
  const count = list.length;
  const totalSpent = list.reduce((sum, r) => sum + rentalBreakdown(r).gross, 0);
  let last = '';
  list.forEach(r => { const d = rentalDate(r); if (d && d > last) last = d; });
  return { count, totalSpent, last };
}

function renderClients() {
  const body = document.getElementById('clients-table-body'); if (!body) return;
  body.innerHTML = '';
  const searchEl = document.getElementById('client-search');
  const q = (searchEl ? searchEl.value : '').trim().toLowerCase();
  let list = appData.clients.slice().sort((a, b) => (a.fullName || '').localeCompare(b.fullName || '', 'ar'));
  if (q) list = list.filter(c => (c.fullName || '').toLowerCase().includes(q) || (c.phone || '').toLowerCase().includes(q));
  if (!list.length) { body.innerHTML = '<tr><td colspan="8" style="color:#666;padding:14px">لا يوجد زبائن</td></tr>'; return; }

  list.forEach(c => {
    const st = computeClientStats(c);
    const tr = document.createElement('tr');
    if (c.blacklisted) tr.style.background = '#fdecea';
    [c.fullName, (c.phone || '-'), (c.nationality || '-'), formatNumberLatn(st.count), formatCurrency(st.totalSpent), (st.last ? formatDate(st.last) : '-')]
      .forEach(v => { const td = document.createElement('td'); td.textContent = v; tr.appendChild(td); });

    const tdStatus = document.createElement('td');
    const tag = document.createElement('span');
    tag.className = 'tag ' + (c.blacklisted ? 'tag-blacklist' : 'tag-active');
    tag.textContent = c.blacklisted ? 'قائمة سوداء' : 'عادي';
    tdStatus.appendChild(tag); tr.appendChild(tdStatus);

    const td = document.createElement('td');
    td.appendChild(actionBtn('تعديل', '', () => {
      editingClientId = c.id;
      document.getElementById('client-form-title').textContent = 'تعديل زبون';
      document.getElementById('add-client-btn').textContent = 'حفظ التعديل';
      document.getElementById('cancel-client-edit').style.display = 'inline-block';
      document.getElementById('client-name').value = c.fullName || '';
      document.getElementById('client-phone').value = c.phone || '';
      document.getElementById('client-address').value = c.address || '';
      document.getElementById('client-email').value = c.email || '';
      document.getElementById('client-birthdate').value = c.birthDate || '';
      document.getElementById('client-nationality').value = c.nationality || '';
      document.getElementById('client-notes').value = c.notes || '';
      document.getElementById('client-blacklist').checked = !!c.blacklisted;
      document.querySelector('.tab-btn[data-tab="clients"]').click();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }));
    td.appendChild(actionBtn('حذف', 'btn-danger', async () => {
      const linked = appData.rentals.filter(r => r.clientId === c.id).length;
      if (linked) {
        if (!confirm('هذا الزبون مرتبط بـ ' + formatNumberLatn(linked) + ' عقد. سيتم فك الارتباط مع الاحتفاظ بالعقود. حذف الزبون؟')) return;
      } else if (!confirm('حذف هذا الزبون؟')) return;
      for (const r of appData.rentals) { if (r.clientId === c.id) { delete r.clientId; await DB.put('rentals', r); } }
      appData.clients = appData.clients.filter(x => x.id !== c.id);
      await DB.remove('clients', c.id);
      renderClients(); populateClientSelect(); updateRentalsUI(); updateDashboard();
    }));
    tr.appendChild(td);
    body.appendChild(tr);
  });
}

/* Données aplaties pour l'export Excel/CSV des clients (avec statistiques) */
function clientsForExport() {
  return appData.clients.map(c => {
    const st = computeClientStats(c);
    return {
      'الاسم': c.fullName || '',
      'الهاتف': c.phone || '',
      'العنوان': c.address || '',
      'البريد': c.email || '',
      'تاريخ الازدياد': c.birthDate ? formatDate(c.birthDate) : '',
      'الجنسية': c.nationality || '',
      'عدد العقود': st.count,
      'إجمالي الإنفاق': st.totalSpent,
      'آخر إيجار': st.last ? formatDate(st.last) : '',
      'الحالة': c.blacklisted ? 'قائمة سوداء' : 'عادي',
      'ملاحظات': c.notes || ''
    };
  });
}

/* Remplit le menu déroulant "client" du formulaire de contrat */
function populateClientSelect() {
  const sel = document.getElementById('rental-client'); if (!sel) return;
  const old = sel.value;
  sel.innerHTML = '<option value="">— زبون غير مسجّل —</option>';
  appData.clients.slice().sort((a, b) => (a.fullName || '').localeCompare(b.fullName || '', 'ar')).forEach(c => {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = (c.fullName || '') + (c.phone ? ' — ' + c.phone : '') + (c.blacklisted ? ' (قائمة سوداء)' : '');
    sel.appendChild(o);
  });
  if ([...sel.options].some(o => o.value === old)) sel.value = old;
  sel.onchange = function () {
    const c = appData.clients.find(x => x.id === this.value);
    if (!c) return;
    const nameInput = document.getElementById('rental-customer');
    if (nameInput) nameInput.value = c.fullName || '';
    if (c.blacklisted) alert('تنبيه: هذا الزبون مُدرَج في القائمة السوداء.');
  };
}

/* ===== Factures ===== */
function toggleInvoiceMode() {
  const mode = document.querySelector('input[name="inv-mode"]:checked').value;
  document.getElementById('inv-from-rental').style.display = (mode === 'from_rental') ? 'block' : 'none';
  document.getElementById('inv-manual').style.display = (mode === 'manual') ? 'block' : 'none';
}

function populateInvoiceRentals() {
  const sel = document.getElementById('invoice-rental'); if (!sel) return;
  const oldVal = sel.value;
  sel.innerHTML = '<option value="">-- اختر عقد إيجار --</option>';
  appData.rentals.slice().reverse().forEach(r => {
    const o = document.createElement('option');
    o.value = r.id;
    o.textContent = `${r.customerName} — ${r.carModel} (${formatCurrency(rentalBreakdown(r).gross)})`;
    sel.appendChild(o);
  });
  if ([...sel.options].some(o => o.value === oldVal)) sel.value = oldVal;
}

/* Numérotation fiable : max séquence du jour + 1 (les suppressions ne créent plus de doublons) */
function generateInvoiceNumber() {
  const d = new Date();
  const prefix = `INV-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  let maxSeq = 0;
  appData.invoices.forEach(inv => {
    if (inv.number && inv.number.startsWith(prefix)) {
      const seq = parseInt(inv.number.split('-').pop(), 10);
      if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
    }
  });
  return `${prefix}-${String(maxSeq + 1).padStart(4, '0')}`;
}

function buildInvoiceDataFromUI() {
  const mode = document.querySelector('input[name="inv-mode"]:checked').value;
  if (mode === 'from_rental') {
    const sel = document.getElementById('invoice-rental');
    if (!sel.value) { alert('اختر عقد الإيجار أولاً'); return null; }
    const r = appData.rentals.find(x => x.id === sel.value);
    if (!r) { alert('العقد غير موجود'); return null; }
    const bd = rentalBreakdown(r);
    return { ...r, invNet: bd.net, invTax: bd.tax, invGross: bd.gross };
  }
  const name = document.getElementById('inv-cust-name').value.trim();
  const carModel = document.getElementById('inv-car-model').value.trim();
  const carNumber = document.getElementById('inv-car-number').value.trim();
  const days = parseInt(document.getElementById('inv-days').value, 10) || 1;
  const price = parseFloat(document.getElementById('inv-price-per-day').value) || 0;
  if (!name || !carModel || !carNumber) { alert('يرجى ملء بيانات العميل والسيارة'); return null; }
  if (price <= 0) { alert('السعر اليومي غير صالح'); return null; }
  const bd = taxBreakdown(days * price, appData.settings.taxRate ?? 0.2);
  return { id: 'MANUAL-' + genId('R'), customerName: name, carModel, carNumber, startDate: new Date().toISOString().split('T')[0], days, pricePerDay: price, totalAmount: bd.gross, taxAmount: bd.tax, netAmount: bd.net, invNet: bd.net, invTax: bd.tax, invGross: bd.gross, isPaid: false };
}

function generateInvoiceHTML(rentalData, invoiceNumber, invoiceDate, notes) {
  const logo = appData.settings.logoDataUrl;
  const net = (typeof rentalData.invNet === 'number') ? rentalData.invNet : rentalBreakdown(rentalData).net;
  const taxAmount = (typeof rentalData.invTax === 'number') ? rentalData.invTax : rentalBreakdown(rentalData).tax;
  const grossAmount = (typeof rentalData.invGross === 'number') ? rentalData.invGross : rentalBreakdown(rentalData).gross;
  const invDays = Number(rentalData.days) || 1;
  const dailyNet = net / invDays;
  const subtotal = net;
  return `
  <div style="direction:rtl;text-align:right;font-family:'Cairo',sans-serif;padding:16px;background:white;">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px;border-bottom:2px solid #2c3e50;padding-bottom:8px;">
      <div style="display:flex;align-items:center;gap:10px;">
        ${logo ? `<img src="${logo}" alt="logo" style="width:140px;height:auto;object-fit:contain">` : ''}
        <div><h1 style="color:#2c3e50;margin:0;font-size:22px">${escapeHtml(appData.settings.companyName ?? 'شركة')}</h1><p style="margin:4px 0;color:#666">فاتورة إيجار سيارة</p></div>
      </div>
      <div style="text-align:left">
        <h2 style="color:#4a6491;margin:0;font-size:20px">فاتورة</h2>
        <p style="margin:4px 0"><strong>رقم:</strong> ${escapeHtml(invoiceNumber)}</p>
        <p style="margin:4px 0"><strong>التاريخ:</strong> ${formatDate(invoiceDate)}</p>
      </div>
    </div>
    <div style="margin-bottom:10px;">
      <h3 style="color:#2c3e50;margin:0 0 6px 0;font-size:16px">معلومات العميل</h3>
      <p style="margin:3px 0"><strong>الاسم:</strong> ${escapeHtml(rentalData.customerName)}</p>
      <p style="margin:3px 0"><strong>السيارة:</strong> ${escapeHtml(rentalData.carModel)}</p>
      <p style="margin:3px 0"><strong>رقم السيارة:</strong> ${escapeHtml(rentalData.carNumber)}</p>
    </div>
    <table style="width:100%;border-collapse:collapse;margin-bottom:12px;">
      <thead>
        <tr style="background:#4a6491;color:white">
          <th style="padding:8px;border:1px solid #ddd">الوصف</th>
          <th style="padding:8px;border:1px solid #ddd">المدة</th>
          <th style="padding:8px;border:1px solid #ddd">السعر اليومي</th>
          <th style="padding:8px;border:1px solid #ddd">المبلغ</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td style="padding:8px;border:1px solid #ddd">إيجار سيارة ${escapeHtml(rentalData.carModel)}</td>
          <td style="padding:8px;border:1px solid #ddd">${formatNumberLatn(rentalData.days)} يوم</td>
          <td style="padding:8px;border:1px solid #ddd">${formatCurrency(dailyNet)}</td>
          <td style="padding:8px;border:1px solid #ddd">${formatCurrency(subtotal)}</td>
        </tr>
      </tbody>
    </table>
    <div style="margin-left:auto;width:320px;margin-bottom:12px;">
      <div style="display:flex;justify-content:space-between;margin-bottom:6px"><span>قبل الضريبة:</span><span>${formatCurrency(subtotal)}</span></div>
      <div style="display:flex;justify-content:space-between;margin-bottom:6px"><span>الضريبة (${formatNumberLatn((rentalData.taxRate ?? appData.settings.taxRate) * 100, { maximumFractionDigits: 2 })}%):</span><span>${formatCurrency(taxAmount)}</span></div>
      <div style="display:flex;justify-content:space-between;font-weight:800;border-top:2px solid #333;padding-top:6px"><span>الإجمالي (شامل الضريبة):</span><span>${formatCurrency(grossAmount)}</span></div>
    </div>
    ${notes ? `<div style="background:#f1f3f5;padding:10px;border-radius:8px;margin-bottom:8px"><strong>ملاحظات:</strong> ${escapeHtml(notes)}</div>` : ''}
    <div style="text-align:center;color:#666;font-size:.9em;margin-top:10px;border-top:1px solid #eee;padding-top:8px">
      شكرًا لتعاملكم مع ${escapeHtml(appData.settings.companyName ?? 'الشركة')}
    </div>
  </div>`;
}

function previewInvoice() {
  const rentalData = buildInvoiceDataFromUI(); if (!rentalData) return;
  const number = (document.getElementById('invoice-number').value || '').trim() || generateInvoiceNumber();
  const date = document.getElementById('invoice-date').value || new Date().toISOString().split('T')[0];
  const notes = document.getElementById('invoice-notes').value || '';
  document.getElementById('invoice-number').value = number;
  const prev = document.getElementById('invoice-preview');
  prev.innerHTML = generateInvoiceHTML(rentalData, number, date, notes);
  prev.style.display = 'block';
  currentInvoice = { rentalData, number, date, notes };
}

function renderInvoicesTable() {
  const body = document.getElementById('invoices-table-body'); body.innerHTML = '';
  if (!appData.invoices.length) { body.innerHTML = '<tr><td colspan="6" style="color:#666;padding:12px">لا توجد فواتير</td></tr>'; return; }
  appData.invoices.slice().reverse().forEach(inv => {
    const tr = document.createElement('tr');
    [inv.number, inv.customerName, inv.carModel, formatDate(inv.date), formatCurrency(inv.totalAmount)].forEach(v => {
      const td = document.createElement('td'); td.textContent = v; tr.appendChild(td);
    });
    const td = document.createElement('td');
    td.appendChild(actionBtn('حذف', 'btn-danger', async () => {
      if (!confirm('حذف هذه الفاتورة؟')) return;
      appData.invoices = appData.invoices.filter(x => x.id !== inv.id);
      await DB.remove('invoices', inv.id);
      renderInvoicesTable();
    }));
    tr.appendChild(td);
    body.appendChild(tr);
  });
}

async function saveCurrentInvoice() {
  if (!currentInvoice || currentInvoice.alreadySaved) return;
  if (appData.invoices.some(inv => inv.number === currentInvoice.number)) return;
  const r = currentInvoice.rentalData;
  const invObj = {
    id: genId('INV'), number: currentInvoice.number,
    customerName: r.customerName, carModel: r.carModel, carNumber: r.carNumber,
    date: currentInvoice.date, days: r.days, pricePerDay: r.pricePerDay,
    subtotal: (typeof r.invNet === 'number' ? r.invNet : r.netAmount), taxAmount: (typeof r.invTax === 'number' ? r.invTax : r.taxAmount), totalAmount: (typeof r.invGross === 'number' ? r.invGross : r.totalAmount),
    notes: currentInvoice.notes ?? '', isPaid: false
  };
  appData.invoices.push(invObj);
  await DB.put('invoices', invObj);
  renderInvoicesTable();
}

async function downloadInvoiceAsHTML() {
  if (!currentInvoice) { alert('قم بالمعاينة أولاً'); return; }
  const { rentalData, number, date, notes } = currentInvoice;
  const html = `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>فاتورة ${escapeHtml(number)}</title><style>body{font-family:'Cairo',sans-serif;padding:20px;background:white}</style></head><body>${generateInvoiceHTML(rentalData, number, date, notes)}</body></html>`;
  await saveCurrentInvoice();
  await deliverFile(`فاتورة_${number}.html`, textToBase64(html), 'text/html');
  currentInvoice = null;
  document.getElementById('invoice-preview').style.display = 'none';
}

/* ===== Rapports ===== */
function getWeekRange(d) {
  const date = new Date(d); const day = date.getDay(); const diffToMon = (day === 0 ? 6 : day - 1);
  const start = new Date(date); start.setDate(date.getDate() - diffToMon); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(start.getDate() + 6); end.setHours(23, 59, 59, 999);
  return { start, end };
}

function filterByPeriod(list, getDate, period) {
  const now = new Date();
  if (period === 'week') {
    const { start, end } = getWeekRange(now);
    return list.filter(x => { const d = new Date(getDate(x)); return d >= start && d <= end; });
  }
  if (period === 'month') {
    const m = now.getMonth(), y = now.getFullYear();
    return list.filter(x => { const d = new Date(getDate(x)); return d.getMonth() === m && d.getFullYear() === y; });
  }
  if (period === '6months') {
    const start = new Date(now.getFullYear(), now.getMonth() - 5, 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return list.filter(x => { const d = new Date(getDate(x)); return d >= start && d <= end; });
  }
  if (period === 'year') {
    const y = now.getFullYear();
    return list.filter(x => { const d = new Date(getDate(x)); return d.getFullYear() === y; });
  }
  return list;
}

function monthsSeries(list, getDate, getVal) {
  const val = getVal || (x => (typeof x.amount === 'number' ? x.amount : (typeof x.netAmount === 'number' ? x.netAmount : 0)));
  const now = new Date(); const arr = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = d.toISOString().slice(0, 7);
    const label = d.toLocaleDateString(LATN_LOCALE, { month: 'short' });
    const sum = list.filter(x => String(getDate(x) ?? '').startsWith(key))
      .reduce((s, x) => s + (Number(val(x)) || 0), 0);
    arr.push({ label, sum });
  }
  return arr;
}

function renderBars(containerId, series, type) {
  const cont = document.getElementById(containerId); if (!cont) return; cont.innerHTML = '';
  const totalVal = series.reduce((s, x) => s + (Number(x.sum) || 0), 0);
  if (!totalVal) { cont.innerHTML = '<div class="hint" style="padding:10px">لا توجد بيانات لعرضها في هذه الفترة</div>'; return; }
  const max = Math.max(1, ...series.map(s => s.sum));
  const BASE = 200; // hauteur max en pixels (plus fiable que les %)
  const wrap = document.createElement('div'); wrap.className = 'chart';
  series.forEach(s => {
    const bar = document.createElement('div'); bar.className = 'bar ' + type;
    const h = s.sum > 0 ? Math.max(4, Math.round((s.sum / max) * BASE)) : 0;
    bar.style.height = h + 'px';
    bar.innerHTML = `<div class='bar-value'>${formatCurrency(s.sum)}</div><div class='bar-label'>${s.label}</div>`;
    wrap.appendChild(bar);
  });
  cont.appendChild(wrap);
}

function generateIncomeReport() {
  const period = document.getElementById('income-period').value;
  let filtered = [];
  if (period === 'custom') {
    const s = document.getElementById('income-start').value;
    const e = document.getElementById('income-end').value;
    if (!s || !e) { alert('حدد نطاق التاريخ'); return; }
    const sd = new Date(s), ed = new Date(e); ed.setHours(23, 59, 59, 999);
    filtered = appData.rentals.filter(r => { const d = new Date(rentalDate(r)); return d >= sd && d <= ed; });
  } else {
    filtered = filterByPeriod(appData.rentals, rentalDate, period);
  }
  let totalGross = 0, totalIncome = 0, totalTax = 0;
  filtered.forEach(r => { const bd = rentalBreakdown(r); totalGross += bd.gross; totalIncome += bd.net; totalTax += bd.tax; });
  const avg = filtered.length ? totalIncome / filtered.length : 0;
  document.getElementById('income-report-result').innerHTML = `<div>
    <div><strong>عدد العقود:</strong> ${formatNumberLatn(filtered.length)}</div>
    <div><strong>إجمالي المقبوضات (شامل الضريبة):</strong> ${formatCurrency(totalGross)}</div>
    <div><strong>إجمالي الإيرادات (بدون ضريبة):</strong> ${formatCurrency(totalIncome)}</div>
    <div><strong>إجمالي الضريبة:</strong> ${formatCurrency(totalTax)}</div>
    <div><strong>متوسط العقد:</strong> ${formatCurrency(avg)}</div>
  </div><div id='income-chart' style='margin-top:12px'></div>`;
  renderBars('income-chart', monthsSeries(appData.rentals, rentalDate, r => rentalBreakdown(r).net), 'income');
}

function generateExpenseReport() {
  const period = document.getElementById('expense-period').value;
  let filtered = [];
  if (period === 'custom') {
    const s = document.getElementById('expense-start').value;
    const e = document.getElementById('expense-end').value;
    if (!s || !e) { alert('حدد نطاق التاريخ'); return; }
    filtered = appData.expenses.filter(r => { const d = new Date(r.date); return d >= new Date(s) && d <= new Date(e); });
  } else {
    filtered = filterByPeriod(appData.expenses, e => e.date, period);
  }
  const total = filtered.reduce((s, e) => s + (e.amount || 0), 0);
  const avg = filtered.length ? total / filtered.length : 0;
  const byType = {}; filtered.forEach(e => { byType[e.type] = (byType[e.type] || 0) + (e.amount || 0); });
  let byTypeHTML = ''; Object.keys(byType).forEach(t => {
    const pct = total > 0 ? (byType[t] / total) * 100 : 0;
    byTypeHTML += `<div><strong>${escapeHtml(t)}:</strong> ${formatCurrency(byType[t])} (${formatNumberLatn(pct, { maximumFractionDigits: 1 })}%)</div>`;
  });
  document.getElementById('expense-report-result').innerHTML = `<div>
    <div><strong>عدد المصاريف:</strong> ${formatNumberLatn(filtered.length)}</div>
    <div><strong>إجمالي المصاريف:</strong> ${formatCurrency(total)}</div>
    <div><strong>متوسط المصروف:</strong> ${formatCurrency(avg)}</div>
    <div style='margin-top:8px'><strong>حسب النوع:</strong><div>${byTypeHTML || 'لا توجد مصاريف'}</div></div>
  </div><div id='expense-chart' style='margin-top:12px'></div>`;
  renderBars('expense-chart', monthsSeries(appData.expenses, e => e.date, e => e.amount), 'expense');
}

/* Données aplaties pour l'export des contrats (avec ventilation de la taxe) */
function rentalsForExport() {
  return appData.rentals.map(r => {
    const bd = rentalBreakdown(r);
    return {
      'الزبون': r.customerName || '',
      'السيارة': r.carModel || '',
      'رقم السيارة': r.carNumber || '',
      'من': r.startDate ? formatDateTime(r.startDate, r.startTime) : '',
      'إلى': r.endDate ? formatDateTime(r.endDate, r.endTime) : '',
      'المدة (أيام)': r.days || 0,
      'الإجمالي (شامل الضريبة)': Math.round(bd.gross * 100) / 100,
      'الصافي (بدون ضريبة)': Math.round(bd.net * 100) / 100,
      'الضريبة': Math.round(bd.tax * 100) / 100,
      'طريقة الدفع': r.paymentMethod || '',
      'الحالة': r.isPaid ? 'مدفوع' : 'غير مدفوع'
    };
  });
}

function expensesForExport() {
  return appData.expenses.map(e => ({
    'النوع': e.type || '',
    'الوصف': e.description || '',
    'السيارة': e.car || '',
    'المبلغ': e.amount || 0,
    'التاريخ': e.date ? formatDate(e.date) : '',
    'الحالة': e.status || ''
  }));
}

/* ===== Exports ===== */
async function exportArrayToExcel(arr, filename) {
  if (!arr || !arr.length) { alert('لا توجد بيانات لتصديرها'); return; }
  const ws = XLSX.utils.json_to_sheet(arr);
  // largeur des colonnes ajustée au contenu (pour que tout le texte tienne)
  const keys = Array.from(arr.reduce((set, o) => { Object.keys(o).forEach(k => set.add(k)); return set; }, new Set()));
  ws['!cols'] = keys.map(k => {
    let w = String(k).length;
    arr.forEach(o => { const v = (o[k] == null) ? '' : String(o[k]); if (v.length > w) w = v.length; });
    return { wch: Math.min(Math.max(w + 2, 10), 60) };
  });
  ws['!views'] = [{ RTL: true }];
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Data');
  const b64 = XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
  await deliverFile(filename, b64, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

async function exportArrayToCSV(arr, filename) {
  if (!arr || !arr.length) { alert('لا توجد بيانات لتصديرها'); return; }
  const keys = Array.from(arr.reduce((s, o) => { Object.keys(o).forEach(k => s.add(k)); return s; }, new Set()));
  const csv = [keys.join(',')].concat(arr.map(o => keys.map(k => JSON.stringify(o[k] ?? '')).join(','))).join('\n');
  await deliverFile(filename, textToBase64('﻿' + csv), 'text/csv');
}

/* ===== Google Sheets (optionnel, nécessite internet) ===== */
async function syncPushToSheets() {
  const endpoint = (appData.settings.gasEndpoint || '').trim();
  if (!endpoint) { alert('أدخل رابط Google Apps Script في الإعدادات'); return; }
  const payload = {
    cars: appData.cars, rentals: appData.rentals, expenses: appData.expenses, invoices: appData.invoices, clients: appData.clients,
    settings: [
      { key: 'companyName', value: appData.settings.companyName },
      { key: 'currency', value: appData.settings.currency },
      { key: 'taxRate', value: appData.settings.taxRate },
      { key: 'version', value: appData.settings.version }
    ]
  };
  try {
    const res = await fetch(endpoint, { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) });
    const json = await res.json().catch(() => ({}));
    if (json.status === 'ok') alert('تمت المزامنة إلى Google Sheets بنجاح');
    else alert('خطأ في المزامنة: ' + (json.message || ''));
  } catch (err) { alert('فشل الاتصال بـ Apps Script: ' + err); }
}

async function syncPullFromSheets() {
  const endpoint = (appData.settings.gasEndpoint || '').trim();
  if (!endpoint) { alert('أدخل رابط Google Apps Script في الإعدادات'); return; }
  try {
    const res = await fetch(endpoint, { method: 'GET', redirect: 'follow' });
    const json = await res.json();
    if (json.status !== 'ok' || !json.data) { alert('تعذر جلب البيانات'); return; }
    const d = json.data;
    appData.cars = Array.isArray(d.cars) ? d.cars : [];
    appData.rentals = Array.isArray(d.rentals) ? d.rentals : [];
    appData.expenses = Array.isArray(d.expenses) ? d.expenses : [];
    appData.invoices = Array.isArray(d.invoices) ? d.invoices : [];
    if (Array.isArray(d.clients)) appData.clients = d.clients;
    if (Array.isArray(d.settings)) {
      d.settings.forEach(it => {
        if (it.key === 'companyName') appData.settings.companyName = it.value;
        if (it.key === 'currency') appData.settings.currency = it.value;
        if (it.key === 'taxRate') appData.settings.taxRate = parseFloat(it.value) || appData.settings.taxRate;
        if (it.key === 'version') appData.settings.version = it.value;
      });
    }
    await DB.replaceAll('cars', appData.cars);
    await DB.replaceAll('rentals', appData.rentals);
    await DB.replaceAll('expenses', appData.expenses);
    await DB.replaceAll('invoices', appData.invoices);
    await DB.replaceAll('clients', appData.clients);
    await DB.saveSettings(appData.settings);
    populateCarSelects(); populateClientSelect(); renderClients(); updateRentalsUI(); renderExpenses(); renderCars(); renderInvoicesTable(); refreshHeaderLogo(); updateDashboard();
    alert('تم السحب من Google Sheets بنجاح');
  } catch (err) { alert('فشل الاتصال بـ Apps Script: ' + err); }
}

/* v3.0 — ajout de l'heure (début/fin) pour les locations */
