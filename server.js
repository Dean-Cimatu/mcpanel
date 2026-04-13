require('dotenv').config({ path: './panel.env' });
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const { NodeSSH } = require('node-ssh');
const { Rcon } = require('rcon-client');
const { v4: uuidv4 } = require('uuid');
const { createProxyMiddleware } = require('http-proxy-middleware');
const db = require('./db');
const { verifyToken } = require('./auth');
const apiRouter = require('./routes/api');

db.init();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());

// ─── BlueMap Proxy ────────────────────────────────────────────────────────────

app.use('/bluemap', createProxyMiddleware({
  target: `http://${process.env.PC_HOST}:8100`,
  changeOrigin: true,
  pathRewrite: { '^/bluemap': '' },
  on: {
    error: (err, req, res) => {
      res.status(502).send('BlueMap unavailable — PC may be offline');
    }
  }
}));

// ─── Snapshot Tile Proxy ──────────────────────────────────────────────────────

app.use('/snapshots', createProxyMiddleware({
  target: `http://${process.env.PC_HOST}:8200`,
  changeOrigin: true,
  pathRewrite: { '^/snapshots': '' },
  on: {
    error: (err, req, res) => {
      res.status(502).send('Snapshot server unavailable');
    }
  }
}));

app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', apiRouter);

// Serve frontend for all non-API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Socket.io Auth ───────────────────────────────────────────────────────────

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  const user = verifyToken(token);
  if (!user) return next(new Error('Unauthorized'));
  socket.user = user;
  next();
});

// ─── Log Tail per Server ──────────────────────────────────────────────────────

const logWatchers = {};

function getServers() {
  try {
    return JSON.parse(fs.readFileSync(process.env.SERVERS_JSON, 'utf8')).servers;
  } catch { return []; }
}

async function startLogWatcher(serverId, logPath) {
  if (logWatchers[serverId]) return;
  const Client = require('ssh2').Client;

  function connect() {
    const conn = new Client();
    conn.on('ready', () => {
      console.log(`[LogWatcher] Connected for ${serverId}`);
      const cmd = `powershell -NoProfile -NonInteractive -Command "Get-Content '${logPath}' -Wait -Tail 20"`;
      conn.exec(cmd, (err, stream) => {
        if (err) { conn.end(); setTimeout(connect, 60000); return; }
        let buffer = '';
        const processData = (data) => {
          buffer += data.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop();
          for (const line of lines) {
            const clean = line.replace(/\r/g, '').trim();
            if (!clean) continue;
            db.addLogLine(serverId, clean);
            io.to(`server:${serverId}`).emit('log', { serverId, line: clean, timestamp: new Date().toISOString() });
            const chatMatch = clean.match(/<([^>]+)> (.+)/);
            if (chatMatch) {
              io.to(`server:${serverId}`).emit('chat', { serverId, player: chatMatch[1], message: chatMatch[2], timestamp: new Date().toISOString() });
            }
          }
        };
        stream.on('data', processData);
        stream.stderr.on('data', () => {});
        stream.on('close', () => { delete logWatchers[serverId]; conn.end(); setTimeout(connect, 30000); });
        logWatchers[serverId] = { conn, stream };
      });
    });
    conn.on('error', (err) => {
      console.error(`[LogWatcher] ${serverId}:`, err.message);
      delete logWatchers[serverId];
      setTimeout(connect, 60000);
    });
    conn.connect({
      host: process.env.PC_HOST, username: process.env.PC_USER,
      privateKey: fs.readFileSync(process.env.PC_SSH_KEY),
      readyTimeout: 10000, keepaliveInterval: 5000
    });
  }
  connect();
}

async function initLogWatchers() {
  const servers = getServers();
  for (const srv of servers) {
    const online = await isPortOpen(process.env.PC_HOST, srv.port);
    if (!online) {
      console.log(`[LogWatcher] Skipping ${srv.id} - offline`);
      continue;
    }
    const logPath = `${srv.dir}/logs/latest.log`.replace(/\//g, '\\');
    await startLogWatcher(srv.id, logPath);
  }
}

setTimeout(initLogWatchers, 5000);
setInterval(initLogWatchers, 5 * 60 * 1000);

// ─── Server Status Loop ───────────────────────────────────────────────────────

const net = require('net');

function isPortOpen(host, port) {
  return new Promise(res => {
    const sock = new net.Socket();
    sock.setTimeout(2000);
    sock.on('connect', () => { sock.destroy(); res(true); });
    sock.on('error', () => res(false));
    sock.on('timeout', () => { sock.destroy(); res(false); });
    sock.connect(port, host);
  });
}

async function broadcastServerStatus() {
  const servers = getServers();
  const statuses = [];
  for (const srv of servers) {
    const online = await isPortOpen(process.env.PC_HOST, srv.port);
    let players = [];
    let tps = null;

    if (online) {
      try {
        const rcon = new Rcon({ host: process.env.PC_HOST, port: srv.rconPort, password: srv.rconPassword, timeout: 3000 });
        await rcon.connect();
        const listRes = await rcon.send('minecraft:list');
        const countMatch = listRes.match(/There are (\d+) of/);
        const namesMatch = listRes.match(/online: (.+)$/);
        if (namesMatch && countMatch && countMatch[1] !== '0') {
          players = namesMatch[1].split(', ').map(p => p.trim());
        }
        const tpsRes = await rcon.send('tps');
        const tpsMatch = tpsRes.replace(/§[0-9a-fk-or]/gi, '').match(/(\d+\.?\d*),\s*(\d+\.?\d*),\s*(\d+\.?\d*)/);
        if (tpsMatch) tps = { m1: parseFloat(tpsMatch[1]), m5: parseFloat(tpsMatch[2]), m15: parseFloat(tpsMatch[3]) };
        await rcon.end();
      } catch {}
    }

    statuses.push({ id: srv.id, name: srv.name, online, players, tps, address: srv.address });
  }
  io.emit('server_status', statuses);
}

setInterval(broadcastServerStatus, 30000);
setTimeout(broadcastServerStatus, 2000);

// ─── Socket Events ────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[Panel] ${socket.user.username} connected`);

  socket.on('subscribe_server', (serverId) => {
    socket.join(`server:${serverId}`);
    const logs = db.getLogs(serverId, 100, 0);
    socket.emit('log_history', { serverId, logs: logs.reverse() });
    const chatLogs = db.getLogs(serverId, 200, 0, '<');
    const chatMessages = chatLogs.reverse().filter(l => l.line.match(/<([^>]+)> (.+)/));
    const chatHistory = chatMessages.slice(-50).map(l => {
      const m = l.line.match(/(?:\[Not Secure\] )?<([^>]+)> (.+)/);
      return m ? { serverId, player: m[1], message: m[2], timestamp: l.timestamp } : null;
    }).filter(Boolean);
    socket.emit('chat_history', { serverId, messages: chatHistory });
  });

  socket.on('unsubscribe_server', (serverId) => {
    socket.leave(`server:${serverId}`);
  });

  socket.on('disconnect', () => {
    console.log(`[Panel] ${socket.user.username} disconnected`);
  });
});

// ─── Export invite code generator for MCBot ──────────────────────────────────

global.generatePanelInvite = () => {
  const code = uuidv4().split('-')[0].toUpperCase();
  db.createInviteCode(code);
  return { code, url: process.env.PANEL_URL, expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() };
};

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`[MCPanel] Running on http://localhost:${PORT}`);
});

module.exports = { generatePanelInvite: global.generatePanelInvite };
