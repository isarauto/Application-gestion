/* =========================================================
 * db.js — Couche de persistance
 * - Sur Android (Capacitor) : SQLite (fichier durable sur le téléphone)
 * - Dans un navigateur (test) : fallback localStorage
 * API asynchrone unique : DB.init, DB.getAll, DB.put, DB.remove,
 * DB.replaceAll, DB.getSettings, DB.saveSettings, DB.exportAll, DB.importAll
 * ========================================================= */

const DB = (() => {
  const DB_NAME = 'gestion_location';
  const COLLECTIONS = ['cars', 'rentals', 'expenses', 'invoices', 'clients'];
  // anciennes clés localStorage (v2.x) -> collection
  const LEGACY_KEYS = { cars: 'carsData', rentals: 'rentalsData', expenses: 'expensesData', invoices: 'invoicesData', clients: 'clientsData' };

  let sqlite = null; // plugin natif si disponible

  /* ---------- détection du backend ---------- */
  function nativePlugin() {
    try {
      if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
        return window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorSQLite || null;
      }
    } catch (_) {}
    return null;
  }

  /* ---------- helpers SQLite ---------- */
  async function sqlExec(statements) {
    await sqlite.execute({ database: DB_NAME, statements });
  }
  async function sqlRun(statement, values = []) {
    await sqlite.run({ database: DB_NAME, statement, values });
  }
  async function sqlQuery(statement, values = []) {
    const r = await sqlite.query({ database: DB_NAME, statement, values });
    return (r && r.values) || [];
  }

  async function initSqlite() {
    try {
      await sqlite.createConnection({ database: DB_NAME, version: 1, encrypted: false, mode: 'no-encryption', readonly: false });
    } catch (_) { /* connexion déjà existante */ }
    await sqlite.open({ database: DB_NAME });
    const ddl = COLLECTIONS.map(c =>
      `CREATE TABLE IF NOT EXISTS ${c} (id TEXT PRIMARY KEY, json TEXT NOT NULL);`
    ).join('\n') + `\nCREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);`;
    await sqlExec(ddl);
    await migrateFromLocalStorage();
  }

  /* Migration automatique des données v2.x (localStorage) vers SQLite, une seule fois */
  async function migrateFromLocalStorage() {
    const done = await sqlQuery(`SELECT value FROM settings WHERE key='__migrated__'`);
    if (done.length) return;
    for (const c of COLLECTIONS) {
      try {
        const old = JSON.parse(localStorage.getItem(LEGACY_KEYS[c]) || 'null');
        if (Array.isArray(old)) {
          for (const obj of old) {
            if (obj && obj.id) await sqlRun(`INSERT OR REPLACE INTO ${c} (id, json) VALUES (?, ?)`, [obj.id, JSON.stringify(obj)]);
          }
        }
      } catch (_) {}
    }
    try {
      const oldSettings = JSON.parse(localStorage.getItem('appSettings') || 'null');
      if (oldSettings && typeof oldSettings === 'object') {
        await sqlRun(`INSERT OR REPLACE INTO settings (key, value) VALUES ('__settings__', ?)`, [JSON.stringify(oldSettings)]);
      }
    } catch (_) {}
    await sqlRun(`INSERT OR REPLACE INTO settings (key, value) VALUES ('__migrated__', '1')`, []);
  }

  /* ---------- API publique ---------- */
  return {
    backend: 'localStorage',

    async init() {
      sqlite = nativePlugin();
      if (sqlite) {
        try {
          await initSqlite();
          this.backend = 'sqlite';
        } catch (e) {
          console.error('SQLite indisponible, fallback localStorage', e);
          sqlite = null;
        }
      }
      return this.backend;
    },

    async getAll(collection) {
      if (sqlite) {
        const rows = await sqlQuery(`SELECT json FROM ${collection}`);
        return rows.map(r => JSON.parse(r.json));
      }
      return JSON.parse(localStorage.getItem(LEGACY_KEYS[collection]) || '[]') || [];
    },

    async put(collection, obj) {
      if (sqlite) {
        await sqlRun(`INSERT OR REPLACE INTO ${collection} (id, json) VALUES (?, ?)`, [obj.id, JSON.stringify(obj)]);
        return;
      }
      const arr = await this.getAll(collection);
      const i = arr.findIndex(x => x.id === obj.id);
      if (i >= 0) arr[i] = obj; else arr.push(obj);
      localStorage.setItem(LEGACY_KEYS[collection], JSON.stringify(arr));
    },

    async remove(collection, id) {
      if (sqlite) {
        await sqlRun(`DELETE FROM ${collection} WHERE id = ?`, [id]);
        return;
      }
      const arr = (await this.getAll(collection)).filter(x => x.id !== id);
      localStorage.setItem(LEGACY_KEYS[collection], JSON.stringify(arr));
    },

    async replaceAll(collection, arr) {
      if (sqlite) {
        await sqlRun(`DELETE FROM ${collection}`, []);
        for (const obj of arr) {
          if (obj && obj.id) await sqlRun(`INSERT INTO ${collection} (id, json) VALUES (?, ?)`, [obj.id, JSON.stringify(obj)]);
        }
        return;
      }
      localStorage.setItem(LEGACY_KEYS[collection], JSON.stringify(arr));
    },

    async getSettings(defaults = {}) {
      if (sqlite) {
        const rows = await sqlQuery(`SELECT value FROM settings WHERE key='__settings__'`);
        return rows.length ? Object.assign({}, defaults, JSON.parse(rows[0].value)) : { ...defaults };
      }
      const s = JSON.parse(localStorage.getItem('appSettings') || 'null');
      return s ? Object.assign({}, defaults, s) : { ...defaults };
    },

    async saveSettings(settings) {
      if (sqlite) {
        await sqlRun(`INSERT OR REPLACE INTO settings (key, value) VALUES ('__settings__', ?)`, [JSON.stringify(settings)]);
        return;
      }
      localStorage.setItem('appSettings', JSON.stringify(settings));
    },

    /* Sauvegarde / restauration complète (fichier JSON) */
    async exportAll() {
      const out = { exportedAt: new Date().toISOString(), version: 3 };
      for (const c of COLLECTIONS) out[c] = await this.getAll(c);
      out.settings = await this.getSettings();
      return out;
    },

    async importAll(data) {
      if (!data || typeof data !== 'object') throw new Error('Fichier de sauvegarde invalide');
      for (const c of COLLECTIONS) {
        if (Array.isArray(data[c])) await this.replaceAll(c, data[c]);
      }
      if (data.settings && typeof data.settings === 'object') await this.saveSettings(data.settings);
    }
  };
})();
