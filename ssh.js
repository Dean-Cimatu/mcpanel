const { NodeSSH } = require('node-ssh');
const SftpClient = require('ssh2-sftp-client');

function getSSHConfig() {
  return {
    host: process.env.PC_HOST,
    username: process.env.PC_USER,
    privateKeyPath: process.env.PC_SSH_KEY,
    readyTimeout: 10000,
    keepaliveInterval: 5000
  };
}

async function runCommand(command) {
  const ssh = new NodeSSH();
  try {
    await ssh.connect(getSSHConfig());
    const result = await ssh.execCommand(command);
    return result;
  } finally {
    try { ssh.dispose(); } catch {}
  }
}

async function getSftpClient() {
  const sftp = new SftpClient();
  await sftp.connect({
    host: process.env.PC_HOST,
    username: process.env.PC_USER,
    privateKey: require('fs').readFileSync(process.env.PC_SSH_KEY)
  });
  return sftp;
}

async function listDirectory(remotePath) {
  const sftp = await getSftpClient();
  try {
    const list = await sftp.list(remotePath);
    return list.map(item => ({
      name: item.name,
      type: item.type === 'd' ? 'directory' : 'file',
      size: item.size,
      modifyTime: item.modifyTime
    }));
  } finally {
    try { await sftp.end(); } catch {}
  }
}

async function uploadFile(localPath, remotePath) {
  const sftp = await getSftpClient();
  try {
    await sftp.put(localPath, remotePath);
  } finally {
    try { await sftp.end(); } catch {}
  }
}

async function deleteFile(remotePath) {
  const sftp = await getSftpClient();
  try {
    const stat = await sftp.stat(remotePath);
    if (stat.isDirectory) {
      await sftp.rmdir(remotePath, true);
    } else {
      await sftp.delete(remotePath);
    }
  } finally {
    try { await sftp.end(); } catch {}
  }
}

module.exports = { runCommand, getSftpClient, listDirectory, uploadFile, deleteFile };
