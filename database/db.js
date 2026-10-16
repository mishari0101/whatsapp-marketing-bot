const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = path.join(__dirname, 'flux_bot.db');

// Database connect panrathu (File illana auto-va create aagum)
const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('❌ SQLite connection error:', err.message);
    } else {
        console.log('✅ Connected to SQLite database.');
    }
});

// Tables create panra query (Lead states matrum Chat History-kaga)
db.serialize(() => {
    // 1. Lead State Table
    db.run(`CREATE TABLE IF NOT EXISTS lead_state (
        jid TEXT PRIMARY KEY,
        stage TEXT,
        category TEXT,
        interestTurns INTEGER,
        firstInterestAt INTEGER,
        lastMsgAt INTEGER,
        handedAt INTEGER,
        incompleteSent INTEGER,
        followupCount INTEGER,
        lastFollowupAt INTEGER,
        phone TEXT,
        pushName TEXT,
        details TEXT
    )`);

    // 2. Chat History Table
    db.run(`CREATE TABLE IF NOT EXISTS chat_history (
        jid TEXT,
        role TEXT,
        content TEXT,
        timestamp INTEGER
    )`);
});

module.exports = db;