import Database from 'better-sqlite3'
import path from 'path'

const dst = path.join(process.env.APPDATA, 'chaterm', 'chaterm_db', '999999999', 'complete_data.db')
const src = path.join(process.env.APPDATA, 'chaterm', 'chaterm_db', '5003054', 'complete_data.db')

console.log('=== DEST (999999999) ===')
const ddb = new Database(dst, { readonly: true })
const dt = ddb.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
for (const t of dt) {
  const cnt = ddb.prepare('SELECT COUNT(*) as c FROM "' + t.name + '"').get().c
  if (cnt > 0) console.log('  ' + t.name + ': ' + cnt + ' rows')
}
ddb.close()

console.log('=== SRC (5003054) ===')
const sdb = new Database(src, { readonly: true })
const st = sdb.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
for (const t of st) {
  const cnt = sdb.prepare('SELECT COUNT(*) as c FROM "' + t.name + '"').get().c
  if (cnt > 0) console.log('  ' + t.name + ': ' + cnt + ' rows')
}
sdb.close()
