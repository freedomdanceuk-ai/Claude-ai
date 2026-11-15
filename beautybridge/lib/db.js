// Tiny JSON-file datastore. Fine for an MVP with modest traffic; swap for
// Postgres (e.g. via Prisma) before scaling.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SEED_FILE = path.join(__dirname, '..', 'seed.json');

let state;

function load() {
  if (state) return state;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    state = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } else {
    const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
    state = { products: seed.products, orders: [], requests: [] };
    save();
  }
  return state;
}

function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

const id = (prefix) => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
const now = () => new Date().toISOString();

module.exports = { load, save, id, now };
