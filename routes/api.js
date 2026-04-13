const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { Rcon } = require('rcon-client');
const router = express.Router();
const db = require('../db');
const { generateToken, requireAuth, requireAdmin } = require('../auth');
const { runCommand, listDirectory, uploadFile, deleteFile } = require('../ssh');

const upload = multer({ dest: '/tmp/mcpanel-uploads/' });

// ─── Auth Routes ──────────────────────────────────────────────────────────────

router.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;
  const user = db.getUserByUsername(username);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
  const token = generateToken(user);
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

router.post('/auth/register', async (req, res) => {
  const { username, password, invite_code } = req.body;
  if (!username || !password || !invite_code) return res.status(400).json({ error: 'All fields required' });
  const code = db.validateInviteCode(invite_code);
  if (!code) return res.status(400).json({ error: 'Invalid or expired invite code' });
  const existing = db.getUserByUsername(username);
  if (existing) return res.status(400).json({ error: 'Username already taken' });
  const hash = await bcrypt.hash(password, 10);
  db.createUser(username, hash, 'player');
  db.useInviteCode(invite_code, username);
  const user = db.getUserByUsername(username);
  const token = generateToken(user);
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

router.get('/auth/me', requireAuth, (req, res) => {
  res.json(req.user);
});

// ─── Servers Routes ───────────────────────────────────────────────────────────

router.get('/servers', requireAuth, (req, res) => {
  const serversJson = JSON.parse(fs.readFileSync(process.env.SERVERS_JSON, 'utf8'));
  res.json(serversJson.servers);
});

router.post('/servers/:id/command', requireAdmin, async (req, res) => {
  const { command } = req.body;
  const serversJson = JSON.parse(fs.readFileSync(process.env.SERVERS_JSON, 'utf8'));
  const srv = serversJson.servers.find(s => s.id === req.params.id);
  if (!srv) return res.status(404).json({ error: 'Server not found' });
  try {
    const rcon = new Rcon({ host: process.env.PC_HOST, port: srv.rconPort, password: srv.rconPassword, timeout: 5000 });
    await rcon.connect();
    const result = await rcon.send(command);
    await rcon.end();
    res.json({ result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/servers/:id/backup', requireAdmin, async (req, res) => {
  const serverId = req.params.id;
  res.json({ success: true, output: 'backup_started', message: 'Backup started in background' });
  try {
    const result = await runCommand(`powershell -Command "& 'C:\\MinecraftServer\\backup.ps1' -serverId ${serverId} -hourly"`);
    console.log(`[Backup] ${serverId}: ${result.stdout.trim()}`);
  } catch (err) {
    console.error(`[Backup] ${serverId} failed:`, err.message);
  }
});

router.post('/servers/:id/stop', requireAdmin, async (req, res) => {
  const serversJson = JSON.parse(fs.readFileSync(process.env.SERVERS_JSON, 'utf8'));
  const srv = serversJson.servers.find(s => s.id === req.params.id);
  if (!srv) return res.status(404).json({ error: 'Server not found' });
  try {
    const { Rcon } = require('rcon-client');
    const rcon = new Rcon({ host: process.env.PC_HOST, port: srv.rconPort, password: srv.rconPassword, timeout: 5000 });
    await rcon.connect();
    await rcon.send('stop');
    await rcon.end();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Backup Archives ──────────────────────────────────────────────────────────

router.get('/backups/:serverId', requireAuth, async (req, res) => {
  try {
    const archivePath = `D:/MinecraftBackups/${req.params.serverId}/Archives`;
    const result = await runCommand(`powershell -NoProfile -NonInteractive -Command "Get-ChildItem '${archivePath}' -Filter *.7z | Sort-Object CreationTime -Descending | Select-Object Name, Length, @{N='Date';E={$_.CreationTime.ToString('yyyy-MM-dd HH:mm')}} | ConvertTo-Json"`);
    if (!result.stdout || result.stdout.trim() === '') return res.json({ archives: [] });
    try {
      let data = JSON.parse(result.stdout.trim());
      if (!Array.isArray(data)) data = [data];
      const archives = data.map(f => ({
        name: f.Name,
        size: fmtBytes(f.Length),
        date: f.Date || '—'
      }));
      res.json({ archives });
    } catch { res.json({ archives: [] }); }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/backups/:serverId/download', requireAuth, async (req, res) => {
  const { file } = req.query;
  if (!file || file.includes('..')) return res.status(400).json({ error: 'Invalid file' });
  const remotePath = `D:/MinecraftBackups/${req.params.serverId}/Archives/${file}`;
  try {
    const SftpClient = require('ssh2-sftp-client');
    const sftp = new SftpClient();
    await sftp.connect({ host: process.env.PC_HOST, username: process.env.PC_USER, privateKey: require('fs').readFileSync(process.env.PC_SSH_KEY) });
    res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    const stream = await sftp.createReadStream(remotePath);
    stream.pipe(res);
    stream.on('end', () => sftp.end());
    stream.on('error', (err) => { sftp.end(); res.status(500).end(); });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function fmtBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes >= 1e9) return `${(bytes/1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes/1e6).toFixed(0)} MB`;
  return `${(bytes/1e3).toFixed(0)} KB`;
}

router.post('/servers/add', requireAdmin, async (req, res) => {
  const { id, name, port, rconPort, rconPassword, jvmArgs } = req.body;
  try {
    await runCommand(`powershell -Command "New-Item -ItemType Directory -Force -Path 'C:\\MinecraftServer\\${id}' | Out-Null"`);
    const serversJson = JSON.parse(fs.readFileSync(process.env.SERVERS_JSON, 'utf8'));
    serversJson.servers.push({
      id, name,
      jar: `C:\\MinecraftServer\\${id}\\server.jar`,
      dir: `C:\\MinecraftServer\\${id}`,
      worldDir: `C:\\MinecraftServer\\${id}\\world`,
      port: parseInt(port),
      rconPort: parseInt(rconPort),
      rconPassword,
      backupDest: `D:\\MinecraftBackups\\${id}`,
      jvmArgs: jvmArgs || '-Xms2G -Xmx4G',
      address: `${id}.deancimatu.com`
    });
    fs.writeFileSync(process.env.SERVERS_JSON, JSON.stringify(serversJson, null, 2));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Logs Routes ──────────────────────────────────────────────────────────────

router.get('/logs/:serverId', requireAuth, (req, res) => {
  const { limit = 200, offset = 0, search = '' } = req.query;
  const logs = db.getLogs(req.params.serverId, parseInt(limit), parseInt(offset), search);
  const total = db.getLogCount(req.params.serverId, search);
  res.json({ logs: logs.reverse(), total });
});

// ─── Users Routes (admin only) ────────────────────────────────────────────────

router.get('/users', requireAdmin, (req, res) => {
  res.json(db.getAllUsers());
});

router.patch('/users/:id/role', requireAdmin, (req, res) => {
  const { role } = req.body;
  if (!['player', 'admin'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  db.updateUserRole(req.params.id, role);
  res.json({ success: true });
});

router.delete('/users/:id', requireAdmin, (req, res) => {
  db.deleteUser(req.params.id);
  res.json({ success: true });
});

// ─── Invite Codes ─────────────────────────────────────────────────────────────

router.post('/invites/generate', requireAdmin, (req, res) => {
  const code = uuidv4().split('-')[0].toUpperCase();
  db.createInviteCode(code);
  res.json({ code, expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() });
});

// ─── File Manager ─────────────────────────────────────────────────────────────

router.get('/files', requireAdmin, async (req, res) => {
  const reqPath = req.query.path || process.env.PC_MINECRAFT_ROOT;
  const root = process.env.PC_MINECRAFT_ROOT.replace(/\\/g, '/');
  const normalised = reqPath.replace(/\\/g, '/');
  if (!normalised.startsWith(root)) return res.status(403).json({ error: 'Access denied' });
  try {
    const list = await listDirectory(reqPath);
    res.json({ path: reqPath, files: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/files/upload', requireAdmin, upload.single('file'), async (req, res) => {
  const { remotePath } = req.body;
  const root = process.env.PC_MINECRAFT_ROOT.replace(/\\/g, '/');
  if (!remotePath.replace(/\\/g, '/').startsWith(root)) return res.status(403).json({ error: 'Access denied' });
  try {
    const dest = remotePath.endsWith('/') || remotePath.endsWith('\\')
      ? remotePath + req.file.originalname
      : remotePath + '/' + req.file.originalname;
    await uploadFile(req.file.path, dest);
    fs.unlinkSync(req.file.path);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/files/download', requireAuth, async (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'No path' });
  const root = process.env.PC_MINECRAFT_ROOT.replace(/\\/g, '/');
  if (!filePath.replace(/\\/g, '/').startsWith(root)) return res.status(403).json({ error: 'Access denied' });
  try {
    const SftpClient = require('ssh2-sftp-client');
    const sftp = new SftpClient();
    await sftp.connect({ host: process.env.PC_HOST, username: process.env.PC_USER, privateKey: require('fs').readFileSync(process.env.PC_SSH_KEY) });
    const filename = filePath.split('/').pop().split('\\').pop();
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    const stream = await sftp.createReadStream(filePath);
    stream.pipe(res);
    stream.on('end', () => sftp.end());
    stream.on('error', () => { sftp.end(); res.status(500).end(); });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/files', requireAdmin, async (req, res) => {
  const { path: filePath } = req.body;
  const root = process.env.PC_MINECRAFT_ROOT.replace(/\\/g, '/');
  if (!filePath.replace(/\\/g, '/').startsWith(root)) return res.status(403).json({ error: 'Access denied' });
  try {
    await deleteFile(filePath);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Stats ────────────────────────────────────────────────────────────────────

async function queryPrometheus(fetch, query) {
  try {
    const r = await fetch(`${process.env.PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(query)}`);
    const data = await r.json();
    return parseFloat(data.data?.result?.[0]?.value?.[1] || 0);
  } catch { return 0; }
}

router.get('/stats', requireAuth, async (req, res) => {
  try {
    const fetch = (await import('node-fetch')).default;

    const pi_cpu = await queryPrometheus(fetch, '100-(avg(rate(node_cpu_seconds_total{job="node",mode="idle"}[1m]))*100)');
    const pi_ram_used = await queryPrometheus(fetch, 'node_memory_MemTotal_bytes{job="node"}-node_memory_MemAvailable_bytes{job="node"}');
    const pi_ram_total = await queryPrometheus(fetch, 'node_memory_MemTotal_bytes{job="node"}');
    const pi_disk_used = await queryPrometheus(fetch, 'node_filesystem_size_bytes{job="node",mountpoint="/"}-node_filesystem_avail_bytes{job="node",mountpoint="/"}');
    const pi_disk_total = await queryPrometheus(fetch, 'node_filesystem_size_bytes{job="node",mountpoint="/"}');

    const pc_cpu = await queryPrometheus(fetch, '100-(avg(rate(windows_cpu_time_total{job="pc",mode="idle"}[1m]))*100)');
    const pc_ram_used = await queryPrometheus(fetch, 'windows_os_physical_memory_free_bytes{job="pc"}');
    const pc_ram_total = await queryPrometheus(fetch, 'windows_cs_physical_memory_bytes{job="pc"}');
    const pc_disk_used = await queryPrometheus(fetch, 'windows_logical_disk_size_bytes{job="pc",volume="C:"}-windows_logical_disk_free_bytes{job="pc",volume="C:"}');
    const pc_disk_total = await queryPrometheus(fetch, 'windows_logical_disk_size_bytes{job="pc",volume="C:"}');
    const pc_disk_d_used = await queryPrometheus(fetch, 'windows_logical_disk_size_bytes{job="pc",volume="D:"}-windows_logical_disk_free_bytes{job="pc",volume="D:"}');
    const pc_disk_d_total = await queryPrometheus(fetch, 'windows_logical_disk_size_bytes{job="pc",volume="D:"}');

    res.json({
      pi: { cpu: pi_cpu, ram_used: pi_ram_used, ram_total: pi_ram_total, disk_used: pi_disk_used, disk_total: pi_disk_total },
      pc: {
        cpu: pc_cpu,
        ram_used: pc_ram_total > 0 ? pc_ram_total - pc_ram_used : 0,
        ram_total: pc_ram_total,
        disk_c_used: pc_disk_used, disk_c_total: pc_disk_total,
        disk_d_used: pc_disk_d_used, disk_d_total: pc_disk_d_total
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PC Power ─────────────────────────────────────────────────────────────────

function isPcOnline(host, port = 22) {
  return new Promise(res => {
    const sock = new net.Socket();
    sock.setTimeout(2000);
    sock.on('connect', () => { sock.destroy(); res(true); });
    sock.on('error', () => res(false));
    sock.on('timeout', () => { sock.destroy(); res(false); });
    sock.connect(port, host);
  });
}

router.get('/pc/status', requireAuth, async (req, res) => {
  const pcOnline = await isPcOnline(process.env.PC_HOST);
  res.json({ pi: true, pc: pcOnline });
});

router.post('/pc/wake', requireAdmin, (req, res) => {
  const { exec } = require('child_process');
  exec('sudo etherwake -i eth0 10:ff:e0:09:ae:6e', (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, message: 'WoL packet sent' });
  });
});

// ─── Snapshots ────────────────────────────────────────────────────────────────

router.get('/snapshots/:serverId/manifest', requireAuth, async (req, res) => {
  try {
    const fetch = (await import('node-fetch')).default;
    const response = await fetch(`http://${process.env.PC_HOST}:8200/${req.params.serverId}/manifest.json`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.json({ serverId: req.params.serverId, snapshots: [] });
  }
});

module.exports = router;
