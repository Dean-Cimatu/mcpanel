const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const db = new Database(path.join(__dirname, 'mcpanel.db'));

function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'player',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS invite_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      used INTEGER DEFAULT 0,
      used_by TEXT
    );

    CREATE TABLE IF NOT EXISTS console_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id TEXT NOT NULL,
      line TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_console_logs_server ON console_logs(server_id);
    CREATE INDEX IF NOT EXISTS idx_console_logs_timestamp ON console_logs(timestamp);
  `);

  // Create default admin if not exists
  const admin = db.prepare('SELECT id FROM users WHERE username = ?').get(process.env.ADMIN_USERNAME || 'dean');
  if (!admin) {
    const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin123', 10);
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(
      process.env.ADMIN_USERNAME || 'dean', hash, 'admin'
    );
    console.log('[DB] Default admin account created');
  }
}

function createInviteCode(code) {
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO invite_codes (code, expires_at) VALUES (?, ?)').run(code, expires);
}

function validateInviteCode(code) {
  const row = db.prepare('SELECT * FROM invite_codes WHERE code = ? AND used = 0 AND expires_at > datetime("now")').get(code);
  return row || null;
}

function useInviteCode(code, username) {
  db.prepare('UPDATE invite_codes SET used = 1, used_by = ? WHERE code = ?').run(username, code);
}

function createUser(username, passwordHash, role = 'player') {
  db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(username, passwordHash, role);
}

function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function getAllUsers() {
  return db.prepare('SELECT id, username, role, created_at FROM users ORDER BY created_at DESC').all();
}

function updateUserRole(userId, role) {
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
}

function deleteUser(userId) {
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
}

function addLogLine(serverId, line) {
  db.prepare('INSERT INTO console_logs (server_id, line) VALUES (?, ?)').run(serverId, line);
}

function getLogs(serverId, limit = 200, offset = 0, search = '') {
  if (search) {
    return db.prepare(
      'SELECT * FROM console_logs WHERE server_id = ? AND line LIKE ? ORDER BY timestamp DESC LIMIT ? OFFSET ?'
    ).all(serverId, `%${search}%`, limit, offset);
  }
  return db.prepare(
    'SELECT * FROM console_logs WHERE server_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?'
  ).all(serverId, limit, offset);
}

function getLogCount(serverId, search = '') {
  if (search) {
    return db.prepare('SELECT COUNT(*) as count FROM console_logs WHERE server_id = ? AND line LIKE ?').get(serverId, `%${search}%`).count;
  }
  return db.prepare('SELECT COUNT(*) as count FROM console_logs WHERE server_id = ?').get(serverId).count;
}

module.exports = {
  init, createInviteCode, validateInviteCode, useInviteCode,
  createUser, getUserByUsername, getAllUsers, updateUserRole, deleteUser,
  addLogLine, getLogs, getLogCount
};
