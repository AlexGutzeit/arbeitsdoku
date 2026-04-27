const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.resolve(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'arbeitsdoku.db'));

let db;
let SQL;

function saveToFile() {
  if (!db) return;
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// Autosave alle 5 Sekunden wenn Änderungen vorliegen
let dirty = false;
function markDirty() { dirty = true; }
setInterval(() => {
  if (dirty) { saveToFile(); dirty = false; }
}, 5000);

// Wrapper um sql.js-DB mit better-sqlite3-ähnlicher API
function wrapDb(rawDb) {
  const wrapper = {
    _db: rawDb,

    prepare(sql) {
      return {
        _sql: sql,
        _db: rawDb,
        run(...params) {
          rawDb.run(sql, params);
          markDirty();
          const lastId = rawDb.exec("SELECT last_insert_rowid() as id")[0]?.values[0][0];
          const changes = rawDb.getRowsModified();
          return { lastInsertRowid: lastId, changes };
        },
        get(...params) {
          const stmt = rawDb.prepare(sql);
          stmt.bind(params);
          if (stmt.step()) {
            const cols = stmt.getColumnNames();
            const vals = stmt.get();
            stmt.free();
            const row = {};
            cols.forEach((c, i) => { row[c] = vals[i]; });
            return row;
          }
          stmt.free();
          return undefined;
        },
        all(...params) {
          const results = [];
          const stmt = rawDb.prepare(sql);
          stmt.bind(params);
          while (stmt.step()) {
            const cols = stmt.getColumnNames();
            const vals = stmt.get();
            const row = {};
            cols.forEach((c, i) => { row[c] = vals[i]; });
            results.push(row);
          }
          stmt.free();
          return results;
        }
      };
    },

    exec(sql) {
      rawDb.run(sql);
      markDirty();
    },

    pragma(p) {
      try { rawDb.run('PRAGMA ' + p); } catch (e) {}
    },

    transaction(fn) {
      return (...args) => {
        rawDb.run('BEGIN TRANSACTION');
        try {
          const result = fn(...args);
          rawDb.run('COMMIT');
          markDirty();
          return result;
        } catch (e) {
          rawDb.run('ROLLBACK');
          throw e;
        }
      };
    },

    close() {
      saveToFile();
      rawDb.close();
    },

    export() {
      return rawDb.export();
    }
  };
  return wrapper;
}

function getDb() {
  if (!db) throw new Error('Datenbank nicht initialisiert. Rufe zuerst initDatabase() auf.');
  return db;
}

function closeDb() {
  if (db) {
    saveToFile();
    db._db.close();
    db = null;
  }
}

function setDb(newDb) {
  db = newDb;
}

async function initDatabase() {
  SQL = await initSqlJs();

  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let rawDb;
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    rawDb = new SQL.Database(buffer);
  } else {
    rawDb = new SQL.Database();
  }

  db = wrapDb(rawDb);
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      password_plain TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','chef','buchhalter','mitarbeiter')),
      target_hours_per_week REAL DEFAULT 40.0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      time_from TEXT NOT NULL,
      time_to TEXT NOT NULL,
      break_minutes INTEGER DEFAULT 0,
      net_hours REAL NOT NULL,
      address TEXT DEFAULT '',
      client TEXT DEFAULT '',
      project_id INTEGER,
      project_text TEXT DEFAULT '',
      description TEXT DEFAULT '',
      personal_note TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS user_target_hours (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      hours_per_week REAL NOT NULL,
      valid_from TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS planning_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_by INTEGER NOT NULL,
      date TEXT NOT NULL,
      time_from TEXT NOT NULL,
      time_to TEXT NOT NULL,
      break_minutes INTEGER DEFAULT 0,
      address TEXT DEFAULT '',
      client TEXT DEFAULT '',
      project_id INTEGER,
      project_text TEXT DEFAULT '',
      description TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS planning_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      planning_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      FOREIGN KEY (planning_id) REFERENCES planning_entries(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(planning_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS bulletin_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_by INTEGER NOT NULL,
      title TEXT NOT NULL,
      text TEXT DEFAULT '',
      event_date TEXT,
      auto_delete_date TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // Bestellliste
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quantity INTEGER,
      unit TEXT,
      product TEXT NOT NULL,
      comment TEXT,
      user_id INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      ordered_at TEXT,
      ordered_by INTEGER,
      project_id INTEGER,
      location_text TEXT DEFAULT 'Lager',
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (ordered_by) REFERENCES users(id) ON DELETE SET NULL
    );
  `);

  // Werkzeugliste
  db.exec(`
    CREATE TABLE IF NOT EXISTS tools (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tool_checkouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      checked_out_at TEXT NOT NULL,
      returned_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (tool_id) REFERENCES tools(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      body TEXT DEFAULT '',
      project_id INTEGER,
      project_text TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS note_shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      permission TEXT NOT NULL DEFAULT 'read',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(note_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS note_offers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER NOT NULL,
      from_user_id INTEGER NOT NULL,
      to_user_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
      FOREIGN KEY (from_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (to_user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(note_id, to_user_id)
    );
  `);

  // Migration: target_hours_per_day → target_hours_per_week
  try {
    const cols = db.prepare("PRAGMA table_info(users)").all();
    const hasOld = cols.some(c => c.name === 'target_hours_per_day');
    const hasNew = cols.some(c => c.name === 'target_hours_per_week');
    if (hasOld && !hasNew) {
      db.exec("ALTER TABLE users ADD COLUMN target_hours_per_week REAL DEFAULT 40.0");
      db.exec("UPDATE users SET target_hours_per_week = target_hours_per_day * 5");
      console.log('Migration: target_hours_per_day → target_hours_per_week (Werte * 5 umgerechnet)');
    } else if (!hasNew) {
      db.exec("ALTER TABLE users ADD COLUMN target_hours_per_week REAL DEFAULT 40.0");
    }
  } catch (e) { /* Spalte existiert bereits */ }

  // Migration: start_overtime Spalte
  try {
    const cols2 = db.prepare("PRAGMA table_info(users)").all();
    if (!cols2.some(c => c.name === 'start_overtime')) {
      db.exec("ALTER TABLE users ADD COLUMN start_overtime REAL DEFAULT 0");
      console.log('Migration: start_overtime Spalte hinzugefügt.');
    }
  } catch (e) {}

  // Migration: can_plan Spalte
  try {
    const cols3 = db.prepare("PRAGMA table_info(users)").all();
    if (!cols3.some(c => c.name === 'can_plan')) {
      db.exec("ALTER TABLE users ADD COLUMN can_plan INTEGER DEFAULT 0");
      console.log('Migration: can_plan Spalte hinzugefügt.');
    }
  } catch (e) {}

  // Migration: can_bulletin Spalte
  try {
    const cols4 = db.prepare("PRAGMA table_info(users)").all();
    if (!cols4.some(c => c.name === 'can_bulletin')) {
      db.exec("ALTER TABLE users ADD COLUMN can_bulletin INTEGER DEFAULT 0");
      console.log('Migration: can_bulletin Spalte hinzugefügt.');
    }
  } catch (e) {}

  // Migration: Bestehende target_hours_per_week in user_target_hours übernehmen
  try {
    const existingTargets = db.prepare('SELECT COUNT(*) as count FROM user_target_hours').get();
    if (existingTargets.count === 0) {
      const allUsers = db.prepare('SELECT id, target_hours_per_week, created_at FROM users').all();
      for (const u of allUsers) {
        db.prepare('INSERT INTO user_target_hours (user_id, hours_per_week, valid_from) VALUES (?, ?, ?)').run(
          u.id, u.target_hours_per_week || 40, u.created_at ? u.created_at.slice(0, 10) : '2025-01-01'
        );
      }
      if (allUsers.length > 0) console.log('Migration: Soll-Stunden-Historie initialisiert.');
    }
  } catch (e) {}

  // Migration: Tages-Spalten in user_target_hours hinzufügen
  try {
    const thCols = db.prepare("PRAGMA table_info(user_target_hours)").all();
    if (!thCols.some(c => c.name === 'hours_mon')) {
      db.exec("ALTER TABLE user_target_hours ADD COLUMN hours_mon REAL DEFAULT 0");
      db.exec("ALTER TABLE user_target_hours ADD COLUMN hours_tue REAL DEFAULT 0");
      db.exec("ALTER TABLE user_target_hours ADD COLUMN hours_wed REAL DEFAULT 0");
      db.exec("ALTER TABLE user_target_hours ADD COLUMN hours_thu REAL DEFAULT 0");
      db.exec("ALTER TABLE user_target_hours ADD COLUMN hours_fri REAL DEFAULT 0");
      // Bestehende hours_per_week gleichmäßig auf Mo-Fr verteilen
      const allTargets = db.prepare('SELECT id, hours_per_week FROM user_target_hours').all();
      const upd = db.prepare('UPDATE user_target_hours SET hours_mon=?, hours_tue=?, hours_wed=?, hours_thu=?, hours_fri=? WHERE id=?');
      for (const t of allTargets) {
        const daily = Math.round((t.hours_per_week / 5) * 100) / 100;
        upd.run(daily, daily, daily, daily, daily, t.id);
      }
      console.log('Migration: Tages-Spalten in user_target_hours hinzugefügt.');
    }
  } catch (e) { console.error('Migration Tages-Spalten:', e.message); }

  // Migration: Adresse-Spalte in projects
  try {
    const projCols = db.prepare("PRAGMA table_info(projects)").all();
    if (!projCols.some(c => c.name === 'address')) {
      db.exec("ALTER TABLE projects ADD COLUMN address TEXT DEFAULT ''");
      console.log('Migration: address Spalte in projects hinzugefügt.');
    }
  } catch (e) {}

  // Migration: Regiezettel-Spalten in entries
  try {
    const entryCols = db.prepare("PRAGMA table_info(entries)").all();
    if (!entryCols.some(c => c.name === 'has_regie')) {
      db.exec("ALTER TABLE entries ADD COLUMN has_regie INTEGER DEFAULT 0");
      db.exec("ALTER TABLE entries ADD COLUMN regie_user_id INTEGER");
      console.log('Migration: Regiezettel-Spalten in entries hinzugefügt.');
    }
  } catch (e) {}

  // Migration: password_plain leeren (Sicherheit)
  try {
    db.exec("UPDATE users SET password_plain = NULL WHERE password_plain IS NOT NULL");
  } catch (e) {}

  // Migration: group_id für Planungsgruppen
  try {
    const planCols = db.prepare("PRAGMA table_info(planning_entries)").all();
    if (!planCols.some(c => c.name === 'group_id')) {
      db.exec("ALTER TABLE planning_entries ADD COLUMN group_id TEXT");
      console.log('Migration: group_id in planning_entries hinzugefügt.');
    }
    if (!planCols.some(c => c.name === 'color')) {
      db.exec("ALTER TABLE planning_entries ADD COLUMN color TEXT DEFAULT '#f59e0b'");
      console.log('Migration: color in planning_entries hinzugefügt.');
    }
  } catch (e) {}

  // Migration: orders – quantity nullable + location-Spalten
  try {
    const orderCols = db.prepare("PRAGMA table_info(orders)").all();
    const qtyCol = orderCols.find(c => c.name === 'quantity');
    if (qtyCol && qtyCol.notnull) {
      // quantity von NOT NULL auf nullable ändern (erfordert Tabellen-Neuerstellung)
      db.exec(`
        CREATE TABLE orders_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          quantity INTEGER,
          unit TEXT,
          product TEXT NOT NULL,
          comment TEXT,
          user_id INTEGER NOT NULL,
          created_at TEXT DEFAULT (datetime('now')),
          ordered_at TEXT,
          ordered_by INTEGER,
          project_id INTEGER,
          location_text TEXT DEFAULT 'Lager',
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (ordered_by) REFERENCES users(id) ON DELETE SET NULL
        );
        INSERT INTO orders_new (id, quantity, unit, product, comment, user_id, created_at, ordered_at, ordered_by)
          SELECT id, quantity, unit, product, comment, user_id, created_at, ordered_at, ordered_by FROM orders;
        DROP TABLE orders;
        ALTER TABLE orders_new RENAME TO orders;
      `);
      console.log('Migration: orders – quantity nullable + location-Spalten hinzugefügt.');
    } else if (!orderCols.some(c => c.name === 'project_id')) {
      db.exec("ALTER TABLE orders ADD COLUMN project_id INTEGER");
      db.exec("ALTER TABLE orders ADD COLUMN location_text TEXT DEFAULT 'Lager'");
      console.log('Migration: location-Spalten in orders hinzugefügt.');
    }
  } catch (e) {}

  // Migration: Projekt/Ort in tool_checkouts
  try {
    const tcCols = db.prepare("PRAGMA table_info(tool_checkouts)").all();
    if (!tcCols.some(c => c.name === 'project_id')) {
      db.exec("ALTER TABLE tool_checkouts ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL");
      db.exec("ALTER TABLE tool_checkouts ADD COLUMN project_text TEXT");
      db.exec("ALTER TABLE tool_checkouts ADD COLUMN address TEXT");
      console.log('Migration: Projekt/Ort in tool_checkouts hinzugefügt.');
    }
  } catch (e) {}

  // Migration: Edit-Lock-Spalten in notes
  try {
    const noteCols = db.prepare("PRAGMA table_info(notes)").all();
    if (!noteCols.some(c => c.name === 'editing_by')) {
      db.exec("ALTER TABLE notes ADD COLUMN editing_by INTEGER");
      db.exec("ALTER TABLE notes ADD COLUMN editing_since TEXT");
      console.log('Migration: Edit-Lock-Spalten in notes hinzugefuegt.');
    }
  } catch (e) {}

  // Seed-Daten nur wenn DB leer
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
  if (userCount.count === 0) {
    const insertUser = db.prepare(
      'INSERT INTO users (username, password_hash, password_plain, name, role, target_hours_per_week) VALUES (?, ?, ?, ?, ?, ?)'
    );

    const users = [
      ['admin', 'admin123', 'Administrator', 'admin', 40],
      ['chef', 'chef123', 'Chef', 'chef', 40],
      ['buchhalter', 'buch123', 'Buchhalter', 'buchhalter', 40],
      ['max', 'max123', 'Max Mustermann', 'mitarbeiter', 40],
    ];

    for (const [username, password, name, role, hours] of users) {
      const hash = bcrypt.hashSync(password, 10);
      insertUser.run(username, hash, password, name, role, hours);
    }

    db.prepare('INSERT INTO projects (name) VALUES (?)').run('Projekt Alpha');
    db.prepare('INSERT INTO projects (name) VALUES (?)').run('Projekt Beta');

    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('company_name', 'Musterfirma GmbH');
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('company_logo', '');

    saveToFile();
    console.log('Datenbank initialisiert mit Seed-Daten.');
  }
}

function reloadFromFile(filePath) {
  const buffer = fs.readFileSync(filePath || DB_PATH);
  const rawDb = new SQL.Database(buffer);
  db = wrapDb(rawDb);
  db.pragma('foreign_keys = ON');
}

module.exports = { getDb, closeDb, setDb, initDatabase, saveToFile, reloadFromFile, DB_PATH, get SQL() { return SQL; } };
