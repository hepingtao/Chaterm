import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync('C:/Users/hepingtao/AppData/Roaming/Chaterm/chaterm_db/5003054/chaterm_data.db')
const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all()
console.log('Tables:', tables.map((r) => r.name).join(', '))
for (const t of tables) {
  const cols = db.prepare(`PRAGMA table_info()`).all()
  console.log(t.name + ': ', cols.map((c) => c.name).join(', '))
}
