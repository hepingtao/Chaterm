import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'

const SRC_USER = '5003054'
const DST_USER = '999999999'

const userDataPath = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'chaterm')
  : path.join(process.env.HOME, '.config', 'chaterm')

const srcDbPath = path.join(userDataPath, 'chaterm_db', SRC_USER, 'complete_data.db')
const dstDbPath = path.join(userDataPath, 'chaterm_db', DST_USER, 'complete_data.db')

console.log('Source: ' + srcDbPath)
console.log('Dest:   ' + dstDbPath)

if (!fs.existsSync(srcDbPath)) {
  console.error('Source database not found')
  process.exit(1)
}

// Backup destination first
const backupPath = dstDbPath + '.bak.' + Date.now()
if (fs.existsSync(dstDbPath)) {
  fs.copyFileSync(dstDbPath, backupPath)
  console.log('Backed up destination to: ' + backupPath)
}

const srcDb = new Database(srcDbPath, { readonly: true })
const dstDb = new Database(dstDbPath)

const tables = srcDb
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all()
  .map((t) => t.name)

console.log('\nFound ' + tables.length + ' tables in source:', tables)

for (const table of tables) {
  const srcCount = srcDb.prepare(`SELECT COUNT(*) as cnt FROM "${table}"`).get().cnt
  if (srcCount === 0) {
    console.log('  [' + table + '] source empty, skipping')
    continue
  }

  const columns = srcDb.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name)
  const colList = columns.map((c) => `"${c}"`).join(', ')
  const placeholders = columns.map(() => '?').join(', ')

  const rows = srcDb.prepare(`SELECT ${colList} FROM "${table}"`).all()

  const dstTableExists = dstDb
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(table)

  if (!dstTableExists) {
    const createSql = srcDb
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
      .get(table).sql
    dstDb.exec(createSql)
    console.log('  [' + table + '] created table in destination')
  }

  const dstCount = dstDb.prepare(`SELECT COUNT(*) as cnt FROM "${table}"`).get().cnt
  dstDb.exec(`DELETE FROM "${table}"`)

  const insert = dstDb.prepare(`INSERT INTO "${table}" (${colList}) VALUES (${placeholders})`)
  const insertMany = dstDb.transaction((rows) => {
    for (const row of rows) {
      const values = columns.map((c) => row[c])
      insert.run(...values)
    }
  })
  insertMany(rows)

  console.log('  [' + table + '] ' + dstCount + ' old rows deleted, ' + rows.length + ' rows copied')
}

srcDb.close()
dstDb.close()

console.log('\nDone! Restart Chaterm and skip login to use the copied data.')
