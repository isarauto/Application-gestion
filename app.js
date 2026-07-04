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
const DEFAULT_SETTINGS = { taxRate: 0.2, companyName: 'ISAR AUTO sarl', currency: 'د.م', logoDataUrl: '', version: '3.0' };
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
  if (!isNaN(ms)) { try { return localDayKey(new Date(ms)); } catch (_) {} }
  return '';
}

/* Dates en heure LOCALE — toISOString() convertit en UTC et decale d'un jour/mois
   (c'est ce qui faisait afficher "aucune donnee" dans les graphiques) */
function parseLocalDate(s) {
  if (!s) return new Date(NaN);
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  return new Date(s);
}
function localDayKey(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function localMonthKey(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }

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
  const pdfBtn = document.getElementById('download-invoice-pdf');
  if (pdfBtn) pdfBtn.addEventListener('click', downloadInvoiceAsPDF);
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

}

function loadSettingsForm() {
  document.getElementById('company-name').value = appData.settings.companyName ?? '';
  document.getElementById('currency').value = appData.settings.currency ?? 'د.م';
  document.getElementById('tax-rate-setting').value = appData.settings.taxRate ?? 0.2;
}

async function saveGeneralSettings() {
  const taxInput = parseFloat(document.getElementById('tax-rate-setting').value);
  if (isNaN(taxInput) || taxInput < 0 || taxInput > 1) { alert('نسبة الضريبة يجب أن تكون بين 0 و 1'); return; }
  appData.settings.companyName = document.getElementById('company-name').value ?? '';
  appData.settings.currency = document.getElementById('currency').value ?? 'د.م';
  appData.settings.taxRate = taxInput;
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

/* ---- Valeurs calculees de la facture (partagees HTML / PDF) ---- */
function invoiceComputedParts(rentalData) {
  const bd = rentalBreakdown(rentalData);
  const net = (typeof rentalData.invNet === 'number') ? rentalData.invNet : bd.net;
  const tax = (typeof rentalData.invTax === 'number') ? rentalData.invTax : bd.tax;
  const gross = (typeof rentalData.invGross === 'number') ? rentalData.invGross : bd.gross;
  const days = Number(rentalData.days) || 1;
  const rate = (typeof rentalData.taxRate === 'number') ? rentalData.taxRate : ((appData.settings && appData.settings.taxRate) ?? 0.2);
  return { net, tax, gross, days, dailyNet: net / days, dailyGross: gross / days, ratePct: formatNumberLatn(rate * 100, { maximumFractionDigits: 2 }) };
}
function invoicePeriodText(r) {
  if (r.startDate && r.endDate) return `من ${formatDate(r.startDate)} إلى ${formatDate(r.endDate)}`;
  if (r.startDate) return formatDate(r.startDate);
  return '';
}

function generateInvoiceHTML(rentalData, invoiceNumber, invoiceDate, notes) {
  const s = appData.settings;
  const logo = s.logoDataUrl;
  const p = invoiceComputedParts(rentalData);
  const period = invoicePeriodText(rentalData);
  const infoRow = (label, value) => `<div style="margin:3px 0;font-size:13.5px"><span style="color:#66788d">${label}:</span> <strong style="color:#2c3e50">${value}</strong></div>`;
  const cell = 'padding:10px 8px;border-bottom:1px solid #edf0f5;text-align:center;white-space:nowrap';
  return `
  <div dir="rtl" style="direction:rtl;text-align:right;max-width:820px;margin:0 auto;background:#fff;border:1px solid #e4e8ef;border-radius:14px;overflow:hidden;font-family:'Cairo','Segoe UI',Tahoma,sans-serif;color:#2c3e50">
    <div style="background:linear-gradient(135deg,#2c3e50,#4a6491);color:#fff;padding:16px 18px;display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between;align-items:center">
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;min-width:0">
        ${logo ? `<span style="background:#fff;border-radius:10px;padding:5px 9px;display:inline-block"><img src="${logo}" alt="logo" style="height:46px;max-width:140px;object-fit:contain;display:block"></span>` : ''}
        <span style="min-width:0">
          <span style="display:block;font-size:19px;font-weight:800;word-break:break-word">${escapeHtml(s.companyName ?? 'الشركة')}</span>
          <span style="display:block;font-size:12.5px;opacity:.85">فاتورة إيجار سيارة</span>
        </span>
      </div>
      <div style="text-align:left">
        <div style="font-size:23px;font-weight:800">فاتورة</div>
        <div style="background:rgba(255,255,255,.16);padding:2px 10px;border-radius:99px;font-size:12.5px;margin-top:4px;direction:ltr;display:inline-block">${escapeHtml(invoiceNumber)}</div>
        <div style="font-size:12.5px;opacity:.85;margin-top:4px">${formatDate(invoiceDate)}</div>
      </div>
    </div>
    <div style="padding:15px 16px">
      <div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:13px">
        <div style="flex:1;min-width:190px;background:#f6f8fb;border:1px solid #e4e8ef;border-radius:10px;padding:9px 12px">
          <div style="color:#4a6491;font-weight:800;font-size:12.5px;margin-bottom:5px">معلومات العميل</div>
          ${infoRow('الاسم', escapeHtml(rentalData.customerName || '—'))}
        </div>
        <div style="flex:1.4;min-width:210px;background:#f6f8fb;border:1px solid #e4e8ef;border-radius:10px;padding:9px 12px">
          <div style="color:#4a6491;font-weight:800;font-size:12.5px;margin-bottom:5px">تفاصيل الإيجار</div>
          ${infoRow('السيارة', escapeHtml(rentalData.carModel || '—'))}
          ${infoRow('رقم السيارة', escapeHtml(rentalData.carNumber || '—'))}
          ${period ? infoRow('الفترة', period) : ''}
          ${rentalData.paymentMethod ? infoRow('طريقة الدفع', escapeHtml(rentalData.paymentMethod)) : ''}
        </div>
      </div>
      <table style="width:100%;border-collapse:collapse;margin-bottom:12px;font-size:13.5px">
        <thead>
          <tr>
            <th style="background:#4a6491;color:#fff;padding:9px 8px;text-align:right;border-radius:0 8px 0 0">الوصف</th>
            <th style="background:#4a6491;color:#fff;padding:9px 8px;text-align:center">المدة</th>
            <th style="background:#4a6491;color:#fff;padding:9px 8px;text-align:center">السعر اليومي</th>
            <th style="background:#4a6491;color:#fff;padding:9px 8px;text-align:center;border-radius:8px 0 0 0">المبلغ</th>
          </tr>
        </thead>
        <tbody>
          <tr style="background:#fbfcfe">
            <td style="padding:10px 8px;border-bottom:1px solid #edf0f5;text-align:right">
              <div style="font-weight:700">إيجار سيارة</div>
              <div style="color:#66788d;font-size:12px">${escapeHtml(rentalData.carModel || '')}${rentalData.carNumber ? ' — ' + escapeHtml(rentalData.carNumber) : ''}</div>
            </td>
            <td style="${cell}">${formatNumberLatn(p.days)} يوم</td>
            <td style="${cell}">${formatCurrency(p.dailyGross)}</td>
            <td style="${cell};font-weight:700">${formatCurrency(p.gross)}</td>
          </tr>
        </tbody>
      </table>
      <div style="width:min(330px,100%);margin-right:auto">
        <div style="display:flex;justify-content:space-between;padding:4px 10px;color:#556070;font-size:13.5px"><span>قبل الضريبة</span><span style="white-space:nowrap">${formatCurrency(p.net)}</span></div>
        <div style="display:flex;justify-content:space-between;padding:4px 10px;color:#556070;font-size:13.5px"><span>الضريبة (${p.ratePct}%)</span><span style="white-space:nowrap">${formatCurrency(p.tax)}</span></div>
        <div style="display:flex;justify-content:space-between;align-items:center;background:#2c3e50;color:#fff;border-radius:10px;padding:9px 12px;font-weight:800;font-size:14.5px;margin-top:4px;gap:8px"><span>الإجمالي (شامل الضريبة)</span><span style="white-space:nowrap">${formatCurrency(p.gross)}</span></div>
      </div>
      ${notes ? `<div style="background:#fff8e6;border:1px solid #f1e2b6;border-radius:10px;padding:9px 12px;margin-top:12px;font-size:13px"><strong>ملاحظات:</strong> ${escapeHtml(notes)}</div>` : ''}
    </div>
    <div style="background:#f6f8fb;border-top:1px solid #e4e8ef;padding:9px;text-align:center;color:#8a93a3;font-size:12px">شكرًا لتعاملكم مع ${escapeHtml(s.companyName ?? 'الشركة')}</div>
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
  const html = `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>فاتورة ${escapeHtml(number)}</title><style>body{font-family:'Cairo','Segoe UI',Tahoma,sans-serif;background:#eef1f5;margin:0;padding:16px}@media print{body{background:#fff;padding:0}}@page{size:A4;margin:12mm}</style></head><body>${generateInvoiceHTML(rentalData, number, date, notes)}</body></html>`;
  await saveCurrentInvoice();
  await deliverFile(`فاتورة_${number}.html`, textToBase64(html), 'text/html');
  currentInvoice = null;
  document.getElementById('invoice-preview').style.display = 'none';
}

/* ===== Facture PDF (canvas -> image -> jsPDF) =====
   Le texte arabe est dessine par le moteur du WebView (ligatures + sens RTL corrects,
   avec la police Cairo de l'app), puis insere comme image dans un PDF A4.
   C'est fiable hors ligne — contrairement au texte arabe natif de jsPDF. */
const INV_W = 1240, INV_H = 1754; // A4 ~150 dpi

function loadImageAsync(src) {
  return new Promise(resolve => {
    if (!src) return resolve(null);
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => resolve(null);
    im.src = src;
  });
}

async function buildInvoiceCanvas(rentalData, invoiceNumber, invoiceDate, notes) {
  try {
    if (document.fonts && document.fonts.load) {
      await Promise.all([document.fonts.load("700 40px Cairo"), document.fonts.load("400 30px Cairo")]);
      await document.fonts.ready;
    }
  } catch (_) {}
  const logoImg = await loadImageAsync(appData.settings.logoDataUrl);

  const c = document.createElement('canvas');
  c.width = INV_W; c.height = INV_H;
  c.dir = 'rtl';
  const x = c.getContext('2d');
  try { x.direction = 'rtl'; } catch (_) {}

  const M = 70, CW = INV_W - 2 * M;
  const F = (size, weight) => `${weight || 400} ${size}px Cairo,'Segoe UI',Tahoma,sans-serif`;
  const rr = (px, py, w, h, r) => { x.beginPath(); x.moveTo(px + r, py); x.arcTo(px + w, py, px + w, py + h, r); x.arcTo(px + w, py + h, px, py + h, r); x.arcTo(px, py + h, px, py, r); x.arcTo(px, py, px + w, py, r); x.closePath(); };
  const fit = (txt, size, weight, maxW) => { let s = size; x.font = F(s, weight); while (s > 15 && x.measureText(txt).width > maxW) { s -= 1; x.font = F(s, weight); } return s; };
  const wrapText = (txt, size, maxW) => {
    x.font = F(size); const words = String(txt).split(/\s+/); const lines = []; let line = '';
    words.forEach(w => {
      const t = line ? line + ' ' + w : w;
      if (x.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
    });
    if (line) lines.push(line);
    return lines.slice(0, 5);
  };

  const p = invoiceComputedParts(rentalData);
  const period = invoicePeriodText(rentalData);
  const company = appData.settings.companyName || 'الشركة';
  const dt = parseLocalDate(invoiceDate);
  const dateStr = isNaN(dt) ? String(invoiceDate) : `${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}/${dt.getFullYear()}`;

  // fond blanc
  x.fillStyle = '#ffffff'; x.fillRect(0, 0, INV_W, INV_H);

  // bandeau d'en-tete
  const grad = x.createLinearGradient(0, 0, INV_W, 230);
  grad.addColorStop(0, '#2c3e50'); grad.addColorStop(1, '#4a6491');
  x.fillStyle = grad; x.fillRect(0, 0, INV_W, 230);

  // logo (a droite)
  let rightAnchor = INV_W - M;
  if (logoImg && logoImg.width && logoImg.height) {
    const bw = 280, bh = 130, bx = INV_W - M - bw, by = 50;
    x.fillStyle = '#ffffff'; rr(bx, by, bw, bh, 14); x.fill();
    const sc = Math.min((bw - 28) / logoImg.width, (bh - 24) / logoImg.height);
    const dw = logoImg.width * sc, dh = logoImg.height * sc;
    x.drawImage(logoImg, bx + (bw - dw) / 2, by + (bh - dh) / 2, dw, dh);
    rightAnchor = bx - 26;
  }

  // nom de la societe + sous-titre
  x.textAlign = 'right'; x.textBaseline = 'alphabetic';
  x.fillStyle = '#ffffff';
  x.font = F(fit(company, 44, 700, rightAnchor - 480), 700);
  x.fillText(company, rightAnchor, 105);
  x.font = F(26); x.fillStyle = 'rgba(255,255,255,.85)';
  x.fillText('فاتورة إيجار سيارة', rightAnchor, 150);

  // bloc gauche : titre, numero, date
  x.textAlign = 'left';
  x.fillStyle = '#ffffff'; x.font = F(50, 700);
  x.fillText('فاتورة', M, 100);
  x.font = F(25);
  const numW = x.measureText(invoiceNumber).width;
  x.fillStyle = 'rgba(255,255,255,.16)'; rr(M, 118, numW + 36, 44, 22); x.fill();
  x.fillStyle = '#ffffff'; x.fillText(invoiceNumber, M + 18, 148);
  x.fillStyle = 'rgba(255,255,255,.85)'; x.fillText(dateStr, M, 200);

  // cartes d'information
  let y = 270;
  const rentalRows = [['السيارة', rentalData.carModel || '—'], ['رقم السيارة', rentalData.carNumber || '—']];
  if (period) rentalRows.push(['الفترة', period]);
  if (rentalData.paymentMethod) rentalRows.push(['طريقة الدفع', rentalData.paymentMethod]);
  const clientRows = [['الاسم', rentalData.customerName || '—']];
  const rowH = 44, headH = 58;
  const cardH = headH + Math.max(rentalRows.length, clientRows.length) * rowH + 16;
  const drawCard = (cx, cw, title, rows) => {
    x.fillStyle = '#f6f8fb'; rr(cx, y, cw, cardH, 14); x.fill();
    x.strokeStyle = '#e4e8ef'; x.lineWidth = 2; rr(cx, y, cw, cardH, 14); x.stroke();
    x.textAlign = 'right';
    x.fillStyle = '#4a6491'; x.font = F(25, 700);
    x.fillText(title, cx + cw - 24, y + 40);
    rows.forEach((rw, i) => {
      const ry = y + headH + 22 + i * rowH;
      const lx = cx + cw - 24;
      x.fillStyle = '#66788d'; x.font = F(24);
      x.fillText(rw[0] + ':', lx, ry);
      const lw = x.measureText(rw[0] + ':').width;
      const maxVW = cw - 48 - lw - 14;
      x.fillStyle = '#2c3e50'; x.font = F(fit(String(rw[1]), 25, 700, maxVW), 700);
      x.fillText(String(rw[1]), lx - lw - 14, ry);
    });
  };
  drawCard(730, 440, 'معلومات العميل', clientRows);
  drawCard(M, 620, 'تفاصيل الإيجار', rentalRows);
  y += cardH + 44;

  // tableau des articles
  const cols = [{ label: 'الوصف', w: 420 }, { label: 'المدة', w: 200 }, { label: 'السعر اليومي', w: 240 }, { label: 'المبلغ', w: 240 }];
  x.fillStyle = '#4a6491'; rr(M, y, CW, 64, 10); x.fill();
  x.fillStyle = '#ffffff'; x.font = F(26, 700); x.textAlign = 'center';
  const centers = []; let cxe = INV_W - M;
  cols.forEach(col => { centers.push(cxe - col.w / 2); cxe -= col.w; });
  cols.forEach((col, i) => x.fillText(col.label, centers[i], y + 42));
  y += 64;
  x.fillStyle = '#fbfcfe'; x.fillRect(M, y, CW, 110);
  x.strokeStyle = '#edf0f5'; x.lineWidth = 2;
  x.beginPath(); x.moveTo(M, y + 110); x.lineTo(M + CW, y + 110); x.stroke();
  x.textAlign = 'right'; x.fillStyle = '#2c3e50'; x.font = F(27, 700);
  x.fillText('إيجار سيارة', INV_W - M - 24, y + 46);
  x.fillStyle = '#66788d'; x.font = F(23);
  x.fillText(`${rentalData.carModel || ''}${rentalData.carNumber ? ' — ' + rentalData.carNumber : ''}`, INV_W - M - 24, y + 84);
  x.textAlign = 'center'; x.fillStyle = '#2c3e50'; x.font = F(26);
  x.fillText(`${formatNumberLatn(p.days)} يوم`, centers[1], y + 66);
  x.fillText(formatCurrency(p.dailyGross), centers[2], y + 66);
  x.font = F(26, 700);
  x.fillText(formatCurrency(p.gross), centers[3], y + 66);
  y += 154;

  // totaux (a gauche) + zone signature (a droite)
  const tw = 640, lx2 = M + tw - 24, vx2 = M + 220;
  x.textAlign = 'right';
  x.fillStyle = '#556070'; x.font = F(25);
  x.fillText('قبل الضريبة', lx2, y + 34);
  x.fillText(`الضريبة (${p.ratePct}%)`, lx2, y + 76);
  x.fillText(formatCurrency(p.net), vx2, y + 34);
  x.fillText(formatCurrency(p.tax), vx2, y + 76);
  x.fillStyle = '#2c3e50'; rr(M, y + 96, tw, 66, 12); x.fill();
  x.fillStyle = '#ffffff'; x.font = F(26, 700);
  x.fillText('الإجمالي (شامل الضريبة)', lx2, y + 139);
  x.font = F(29, 700);
  x.fillText(formatCurrency(p.gross), vx2 + 10, y + 139);

  x.strokeStyle = '#c9d2de'; x.lineWidth = 2; x.setLineDash([10, 8]);
  rr(810, y, 360, 162, 12); x.stroke(); x.setLineDash([]);
  x.fillStyle = '#8a93a3'; x.font = F(23); x.textAlign = 'center';
  x.fillText('التوقيع والختم', 990, y + 40);
  y += 162 + 44;

  // notes
  if (notes) {
    const lines = wrapText(notes, 24, CW - 40);
    const nh = 46 + 36 + lines.length * 34 + 14;
    x.fillStyle = '#fff8e6'; rr(M, y, CW, nh, 12); x.fill();
    x.strokeStyle = '#f1e2b6'; x.lineWidth = 2; rr(M, y, CW, nh, 12); x.stroke();
    x.textAlign = 'right'; x.fillStyle = '#7a6520'; x.font = F(24, 700);
    x.fillText('ملاحظات:', INV_W - M - 20, y + 36);
    x.fillStyle = '#5c5433'; x.font = F(24);
    lines.forEach((ln, i) => x.fillText(ln, INV_W - M - 20, y + 72 + i * 34));
    y += nh + 30;
  }

  // pied de page
  x.strokeStyle = '#e4e8ef'; x.lineWidth = 2;
  x.beginPath(); x.moveTo(M, INV_H - 120); x.lineTo(INV_W - M, INV_H - 120); x.stroke();
  x.textAlign = 'center';
  x.fillStyle = '#66788d'; x.font = F(26);
  x.fillText(`شكرًا لتعاملكم مع ${company}`, INV_W / 2, INV_H - 74);
  x.fillStyle = '#a7b0bd'; x.font = F(20);
  x.fillText(`${invoiceNumber} • ${dateStr}`, INV_W / 2, INV_H - 40);
  return c;
}

async function downloadInvoiceAsPDF() {
  if (!currentInvoice) { alert('قم بالمعاينة أولاً'); return; }
  const JsPdf = window.jspdf && window.jspdf.jsPDF;
  if (!JsPdf) { alert('مكتبة PDF غير متوفرة (vendor/jspdf.umd.min.js مفقود)'); return; }
  try {
    const { rentalData, number, date, notes } = currentInvoice;
    const canvas = await buildInvoiceCanvas(rentalData, number, date, notes);
    const png = canvas.toDataURL('image/png');
    const doc = new JsPdf({ orientation: 'p', unit: 'mm', format: 'a4', compress: true });
    doc.addImage(png, 'PNG', 0, 0, 210, 297, undefined, 'FAST');
    const bytes = new Uint8Array(doc.output('arraybuffer'));
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    await saveCurrentInvoice();
    await deliverFile(`فاتورة_${number}.pdf`, btoa(bin), 'application/pdf');
  } catch (e) { alert('تعذر إنشاء ملف PDF: ' + e); }
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
    return list.filter(x => { const d = parseLocalDate(getDate(x)); return d >= start && d <= end; });
  }
  if (period === 'month') {
    const m = now.getMonth(), y = now.getFullYear();
    return list.filter(x => { const d = parseLocalDate(getDate(x)); return d.getMonth() === m && d.getFullYear() === y; });
  }
  if (period === '6months') {
    const start = new Date(now.getFullYear(), now.getMonth() - 5, 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return list.filter(x => { const d = parseLocalDate(getDate(x)); return d >= start && d <= end; });
  }
  if (period === 'year') {
    const y = now.getFullYear();
    return list.filter(x => { const d = parseLocalDate(getDate(x)); return d.getFullYear() === y; });
  }
  return list;
}

/* Intervalles du graphique selon la periode : jours (semaine), semaines (mois),
   mois (6 mois / annee), et adaptatif en mode personnalise. Cles en heure LOCALE. */
function buildChartSeries(list, getDate, getVal, period, customStart, customEnd) {
  const now = new Date();
  const buckets = [];
  const dayLabel = d => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
  const pushDays = (start, count) => {
    for (let i = 0; i < count; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      buckets.push({ kind: 'day', key: localDayKey(d), label: dayLabel(d), sum: 0 });
    }
  };
  const pushMonths = (start, count, fmt) => {
    for (let i = 0; i < count; i++) {
      const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
      buckets.push({ kind: 'month', key: localMonthKey(d), label: fmt(d), sum: 0 });
    }
  };

  if (period === 'week') {
    const { start } = getWeekRange(now);
    pushDays(start, 7);
  } else if (period === 'month') {
    const mKey = localMonthKey(now);
    const nbDays = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    for (let s = 1; s <= nbDays; s += 7) {
      const e = Math.min(s + 6, nbDays);
      buckets.push({ kind: 'span', monthKey: mKey, from: s, to: e, label: `${String(s).padStart(2, '0')}-${String(e).padStart(2, '0')}`, sum: 0 });
    }
  } else if (period === '6months') {
    pushMonths(new Date(now.getFullYear(), now.getMonth() - 5, 1), 6, d => d.toLocaleDateString(LATN_LOCALE, { month: 'short' }));
  } else if (period === 'year') {
    pushMonths(new Date(now.getFullYear(), 0, 1), 12, d => String(d.getMonth() + 1).padStart(2, '0'));
  } else {
    const sd = parseLocalDate(customStart), ed = parseLocalDate(customEnd);
    if (isNaN(sd) || isNaN(ed) || ed < sd) return [];
    const nbDays = Math.round((ed - sd) / 86400000) + 1;
    if (nbDays <= 31) pushDays(sd, nbDays);
    else {
      const months = (ed.getFullYear() - sd.getFullYear()) * 12 + (ed.getMonth() - sd.getMonth()) + 1;
      pushMonths(new Date(sd.getFullYear(), sd.getMonth(), 1), months, d => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getFullYear()).slice(2)}`);
    }
  }

  list.forEach(item => {
    const ds = String(getDate(item) ?? '').slice(0, 10);
    if (!ds) return;
    const v = Number(getVal(item)) || 0;
    for (const b of buckets) {
      if (b.kind === 'span') {
        if (ds.slice(0, 7) === b.monthKey) {
          const dd = parseInt(ds.slice(8, 10), 10);
          if (dd >= b.from && dd <= b.to) { b.sum += v; break; }
        }
      } else if (b.kind === 'month' ? ds.slice(0, 7) === b.key : ds === b.key) { b.sum += v; break; }
    }
  });
  return buckets;
}

function formatCompactLatn(v) {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 1000) return formatNumberLatn(n, { notation: 'compact', maximumFractionDigits: 1 });
  return formatNumberLatn(n, { maximumFractionDigits: 0 });
}
function renderBars(containerId, series, type) {
  const cont = document.getElementById(containerId); if (!cont) return; cont.innerHTML = '';
  const totalVal = (series || []).reduce((s, b) => s + (Number(b.sum) || 0), 0);
  if (!series || !series.length || !totalVal) { cont.innerHTML = '<div class="hint" style="padding:10px">لا توجد بيانات لعرضها في هذه الفترة</div>'; return; }
  const max = Math.max(1, ...series.map(b => b.sum));
  const BASE = 185;
  const scroll = document.createElement('div'); scroll.className = 'chart-scroll';
  const wrap = document.createElement('div'); wrap.className = 'chart';
  series.forEach(b => {
    const col = document.createElement('div'); col.className = 'bar-col';
    const bar = document.createElement('div'); bar.className = 'bar ' + type;
    bar.style.height = (b.sum > 0 ? Math.max(5, Math.round((b.sum / max) * BASE)) : 2) + 'px';
    if (b.sum > 0) {
      const val = document.createElement('div'); val.className = 'bar-value';
      val.textContent = formatCompactLatn(b.sum);
      bar.appendChild(val);
    }
    const lab = document.createElement('div'); lab.className = 'bar-label'; lab.textContent = b.label;
    col.appendChild(bar); col.appendChild(lab);
    wrap.appendChild(col);
  });
  scroll.appendChild(wrap); cont.appendChild(scroll);
}
function generateIncomeReport() {
  const period = document.getElementById('income-period').value;
  let filtered = [], cs = '', ce = '';
  if (period === 'custom') {
    cs = document.getElementById('income-start').value;
    ce = document.getElementById('income-end').value;
    if (!cs || !ce) { alert('حدد نطاق التاريخ'); return; }
    const sd = parseLocalDate(cs), ed = parseLocalDate(ce); ed.setHours(23, 59, 59, 999);
    filtered = appData.rentals.filter(r => { const d = parseLocalDate(rentalDate(r)); return d >= sd && d <= ed; });
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
  </div><div id='income-chart' style='margin-top:12px'></div>
  <div class='hint' style='margin-top:4px;font-size:.78rem'>الرسم البياني: الإيرادات (بدون ضريبة) حسب الفترة المختارة</div>`;
  renderBars('income-chart', buildChartSeries(filtered, rentalDate, r => rentalBreakdown(r).net, period, cs, ce), 'income');
}

function generateExpenseReport() {
  const period = document.getElementById('expense-period').value;
  let filtered = [], cs = '', ce = '';
  if (period === 'custom') {
    cs = document.getElementById('expense-start').value;
    ce = document.getElementById('expense-end').value;
    if (!cs || !ce) { alert('حدد نطاق التاريخ'); return; }
    const sd = parseLocalDate(cs), ed = parseLocalDate(ce); ed.setHours(23, 59, 59, 999);
    filtered = appData.expenses.filter(r => { const d = parseLocalDate(r.date); return d >= sd && d <= ed; });
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
  </div><div id='expense-chart' style='margin-top:12px'></div>
  <div class='hint' style='margin-top:4px;font-size:.78rem'>الرسم البياني: المصاريف حسب الفترة المختارة</div>`;
  renderBars('expense-chart', buildChartSeries(filtered, e => e.date, e => e.amount, period, cs, ce), 'expense');
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

/* v3.0 — ajout de l'heure (début/fin) pour les locations */
