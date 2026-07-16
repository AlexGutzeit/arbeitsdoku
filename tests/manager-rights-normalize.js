// Unit-Test (#9): normalizeManagerRights() nullt die redundanten Einzelrecht-Flags von Chef/Admin
// (die per Rolle ohnehin alles dürfen) und lässt Mitarbeiter-Rechte unangetastet. Idempotent.
//   node tests/manager-rights-normalize.js
const os = require('os'), path = require('path');
process.env.DB_PATH = path.join(os.tmpdir(), 'mgr-norm-' + Date.now() + '.db');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);
const { initDatabase, getDb, normalizeManagerRights } = require('../database/init');

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✅ ' + n)) : (fail++, fails.push(n), console.log('  ❌ ' + n + (e ? '  → ' + e : '')));

(async () => {
  await initDatabase();
  const db = getDb();
  const mk = (nm, role, f) => db.prepare(
    "INSERT INTO users (username,password_hash,name,role,target_hours_per_week,can_plan,can_plan_all,can_bulletin,can_upload) VALUES (?,?,?,?,40,?,?,?,?)"
  ).run(nm, 'x', nm, role, f.p || 0, f.pa || 0, f.b || 0, f.u || 0).lastInsertRowid;
  const g = id => db.prepare("SELECT can_plan,can_plan_all,can_bulletin,can_upload FROM users WHERE id=?").get(id);

  const chefId = mk('chef_flags', 'chef', { p: 1, pa: 1, b: 1, u: 1 });
  const adminId = mk('admin_flags', 'admin', { p: 1, pa: 0, b: 1, u: 0 });
  const maId = mk('ma_flags', 'mitarbeiter', { p: 1, pa: 1, b: 1, u: 1 });

  normalizeManagerRights(db);
  const chef = g(chefId), admin = g(adminId), ma = g(maId);

  console.log('normalizeManagerRights:');
  ok('Chef: alle Einzelrechte 0', chef.can_plan === 0 && chef.can_plan_all === 0 && chef.can_bulletin === 0 && chef.can_upload === 0, JSON.stringify(chef));
  ok('Admin: alle Einzelrechte 0', admin.can_plan === 0 && admin.can_plan_all === 0 && admin.can_bulletin === 0 && admin.can_upload === 0, JSON.stringify(admin));
  ok('Mitarbeiter: Einzelrechte UNVERÄNDERT (1/1/1/1)', ma.can_plan === 1 && ma.can_plan_all === 1 && ma.can_bulletin === 1 && ma.can_upload === 1, JSON.stringify(ma));

  // Idempotenz: erneuter Lauf ohne offene Manager-Flags darf nicht crashen und nichts kaputt machen.
  normalizeManagerRights(db);
  ok('2. Lauf idempotent (Chef bleibt 0, MA bleibt 1)', g(chefId).can_plan === 0 && g(maId).can_plan === 1);

  console.log(`\nManager-Rights-Normalize: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
