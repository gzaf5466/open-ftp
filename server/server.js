const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const qrcode = require('qrcode');
const mime = require('mime-types');
const archiver = require('archiver');

const config = require('./config');
const { getNetworkInterfacesList, getPrimaryLanIP, formatBytes } = require('./utils');
const transferManager = require('./transferManager');
const wsManager = require('./wsManager');
const ftpServer = require('./ftpServer');
const logger = require('./logger');

const app = express();
const server = http.createServer(app);

// Disable socket timeouts for massive 20GB+ file transfers
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 120000;
server.timeout = 0;

// Initialize WebSockets
wsManager.init(server);
transferManager.setWsBroadcast((data) => wsManager.broadcast(data));
logger.setWsBroadcast((data) => wsManager.broadcast(data));

// Start FTP Server
ftpServer.start();

// Multer storage for temporary 6-digit key transfers
const tempStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, config.TEMP_UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_'));
  }
});
const uploadTemp = multer({
  storage: tempStorage,
  limits: { fileSize: config.MAX_FILE_SIZE_BYTES }
});

// Multer storage for direct Vault / Shared Storage uploads
const vaultTempStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, config.TEMP_UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    cb(null, 'vault_' + Date.now() + '-' + path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_'));
  }
});
const uploadVault = multer({
  storage: vaultTempStorage,
  limits: { fileSize: config.MAX_FILE_SIZE_BYTES }
});

// Express Middlewares
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve static frontend assets
app.use(express.static(path.join(config.ROOT_DIR, 'public')));

/* =========================================================================
   SYSTEM & NETWORK APIS
   ========================================================================= */

// Get LAN and Server Info
app.get('/api/info', async (req, res) => {
  try {
    const interfaces = getNetworkInterfacesList();
    const primaryIp = getPrimaryLanIP();
    const storageStats = transferManager.getStorageStats();
    const ftpStatus = ftpServer.getStatus();

    const lanUrl = `http://${primaryIp}:${config.HTTP_PORT}`;
    const qrDataUrl = await qrcode.toDataURL(lanUrl, { margin: 2, width: 256, color: { dark: '#111827', light: '#ffffff' } });

    res.json({
      hostname: config.HOST_NAME,
      primaryIp,
      port: config.HTTP_PORT,
      lanUrl,
      interfaces,
      qrDataUrl,
      storage: storageStats,
      ftp: ftpStatus,
      defaultExpiry: config.DEFAULT_EXPIRY_SECONDS
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Generate dynamic QR Code for any text or PIN
app.get('/api/qr', async (req, res) => {
  try {
    const text = req.query.text || '';
    if (!text) return res.status(400).json({ error: 'Text query parameter is required' });

    const qrDataUrl = await qrcode.toDataURL(text, {
      margin: 2,
      width: req.query.size ? parseInt(req.query.size) : 260,
      color: { dark: '#111827', light: '#ffffff' }
    });

    res.json({ qrDataUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Quick short link redirect for mobile scans: http://<ip>:3000/r/:key
app.get('/r/:key', (req, res) => {
  const pin = req.params.key;
  res.redirect(`/#receive/${pin}`);
});

/* =========================================================================
   SEND ANYWHERE TRANSFERS (6-DIGIT KEY)
   ========================================================================= */

// Turbo Transfer Initialization: Prepares 6-digit key and file slots for parallel raw binary streams
app.post('/api/transfer/turbo-init', (req, res) => {
  try {
    const { files, expiry, deviceName } = req.body;
    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'No files in manifest' });
    }

    const expirySeconds = expiry ? parseInt(expiry) : config.DEFAULT_EXPIRY_SECONDS;
    const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').replace(/^.*:/, '');

    const totalRequestedBytes = files.reduce((sum, f) => sum + (f.size || 0), 0);

    // Verify disk free space
    if (fs.statfsSync) {
      try {
        const diskStats = fs.statfsSync(config.DATA_DIR);
        const freeBytes = diskStats.bavail * diskStats.bsize;
        if (freeBytes < totalRequestedBytes + (50 * 1024 * 1024)) { // 50MB safety buffer
          return res.status(400).json({
            error: `Disk storage full! Free space: ${formatBytes(freeBytes)}, Requested: ${formatBytes(totalRequestedBytes)}`
          });
        }
      } catch (e) {}
    }

    const transfer = transferManager.initTurboTransfer({
      fileManifest: files,
      senderInfo: {
        ip: clientIp || 'Local',
        deviceName: deviceName || 'Turbo Sender',
        userAgent: req.headers['user-agent']
      },
      expirySeconds
    });

    // Record activity log with timestamp
    logger.log({
      type: 'send',
      mode: 'server',
      key: transfer.key,
      files: files.map(f => ({ name: f.name, size: f.size, category: f.category || 'file' })),
      totalSize: totalRequestedBytes,
      sender: transfer.senderInfo,
      status: 'in_progress'
    });

    res.json({ success: true, transfer });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Check already uploaded bytes for resumable retry
app.get('/api/transfer/resume-status/:key/:fileId', (req, res) => {
  const { key, fileId } = req.params;
  const result = transferManager.getTransferByKey(key);

  if (!result.found) {
    return res.status(404).json({ error: result.reason });
  }

  const targetFile = result.transfer.files.find(f => f.id === fileId);
  if (!targetFile) {
    return res.status(404).json({ error: 'File slot not found' });
  }

  let uploadedBytes = 0;
  if (fs.existsSync(targetFile.savedPath)) {
    try {
      uploadedBytes = fs.statSync(targetFile.savedPath).size;
    } catch (e) {}
  }

  res.json({
    success: true,
    fileId: fileId,
    totalSize: targetFile.size,
    uploadedBytes: uploadedBytes,
    completed: !!targetFile.completed
  });
});

// Turbo Transfer Raw Binary Stream (Supports Resumable Append at x-start-byte)
app.put('/api/transfer/turbo-stream/:key/:fileId', (req, res) => {
  const { key, fileId } = req.params;
  const result = transferManager.getTransferByKey(key);

  if (!result.found) {
    return res.status(404).json({ error: result.reason });
  }

  const targetFile = result.transfer.files.find(f => f.id === fileId);
  if (!targetFile) {
    return res.status(404).json({ error: 'File slot not found' });
  }

  if (req.socket) req.socket.setNoDelay(true);

  const startByte = parseInt(req.headers['x-start-byte'] || '0', 10);
  const streamFlags = (startByte > 0 && fs.existsSync(targetFile.savedPath)) ? 'a' : 'w';

  const writeStream = fs.createWriteStream(targetFile.savedPath, {
    flags: streamFlags,
    highWaterMark: 1024 * 1024 // 1 MB high-speed buffer for maximum I/O throughput
  });

  req.pipe(writeStream);

  writeStream.on('finish', () => {
    targetFile.completed = true;

    // Check if entire bundle is finished to log complete status
    const allDone = result.transfer.files.every(f => f.completed);
    if (allDone) {
      logger.log({
        type: 'send',
        mode: 'server',
        key: result.transfer.key,
        files: result.transfer.files.map(f => ({ name: f.name || f.originalName, size: f.size })),
        totalSize: result.transfer.totalSize,
        sender: result.transfer.senderInfo,
        status: startByte > 0 ? 'resumed' : 'completed'
      });
    }

    res.json({ success: true, fileId: fileId, size: targetFile.size, resumedFrom: startByte });
  });

  writeStream.on('error', (err) => {
    console.error('Turbo stream write error:', err);
    res.status(500).json({ error: err.message });
  });
});

// Turbo Chunk Upload: Random-Access Byte Slicing for 20GB+ Files with Failsafe Retries
app.put('/api/transfer/turbo-chunk/:key/:fileId', (req, res) => {
  const { key, fileId } = req.params;
  const result = transferManager.getTransferByKey(key);

  if (!result.found) {
    return res.status(404).json({ error: result.reason });
  }

  const targetFile = result.transfer.files.find(f => f.id === fileId);
  if (!targetFile) {
    return res.status(404).json({ error: 'File slot not found' });
  }

  if (req.socket) {
    req.socket.setNoDelay(true);
    req.socket.setTimeout(0);
  }

  const chunkOffset = parseInt(req.headers['x-chunk-offset'] || '0', 10);
  const isLastChunk = req.headers['x-is-last-chunk'] === '1';

  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    try {
      const buffer = Buffer.concat(chunks);

      const dir = path.dirname(targetFile.savedPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const fileMode = fs.existsSync(targetFile.savedPath) ? 'r+' : 'w';
      const fd = fs.openSync(targetFile.savedPath, fileMode);
      fs.writeSync(fd, buffer, 0, buffer.length, chunkOffset);
      fs.closeSync(fd);

      const writtenBytes = chunkOffset + buffer.length;
      if (!targetFile.uploadedBytes || writtenBytes > targetFile.uploadedBytes) {
        targetFile.uploadedBytes = writtenBytes;
      }

      if (isLastChunk || (targetFile.size && targetFile.uploadedBytes >= targetFile.size)) {
        targetFile.completed = true;
        const allDone = result.transfer.files.every(f => f.completed);
        if (allDone) {
          logger.log({
            type: 'send',
            mode: 'server',
            key: result.transfer.key,
            files: result.transfer.files.map(f => ({ name: f.name || f.originalName, size: f.size })),
            totalSize: result.transfer.totalSize,
            sender: result.transfer.senderInfo,
            status: 'completed'
          });
        }
      }

      res.json({
        success: true,
        fileId: fileId,
        offset: chunkOffset,
        bytesWritten: buffer.length,
        totalUploaded: targetFile.uploadedBytes,
        completed: !!targetFile.completed
      });
    } catch (err) {
      console.error('Error writing turbo chunk:', err);
      res.status(500).json({ error: err.message });
    }
  });

  req.on('error', (err) => {
    console.error('Turbo chunk request error:', err);
    res.status(500).json({ error: err.message });
  });
});

// Create file transfer with 6-digit key (Fallback multipart)
app.post('/api/transfer/send-files', uploadTemp.array('files'), (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files were uploaded' });
    }

    const expirySeconds = req.body.expiry ? parseInt(req.body.expiry) : config.DEFAULT_EXPIRY_SECONDS;
    const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').replace(/^.*:/, '');

    const transfer = transferManager.createFileTransfer({
      files: req.files,
      senderInfo: {
        ip: clientIp || 'Local',
        deviceName: req.body.deviceName || 'Web Sender',
        userAgent: req.headers['user-agent']
      },
      expirySeconds: expirySeconds
    });

    logger.log({
      type: 'send',
      mode: 'server',
      key: transfer.key,
      files: transfer.files.map(f => ({ name: f.originalName, size: f.size })),
      totalSize: transfer.totalSize,
      sender: transfer.senderInfo,
      status: 'completed'
    });

    res.json({
      success: true,
      transfer: transfer
    });
  } catch (err) {
    console.error('Error in /api/transfer/send-files:', err);
    res.status(500).json({ error: err.message });
  }
});

// Create text transfer with 6-digit key
app.post('/api/transfer/send-text', (req, res) => {
  try {
    const { text, title, expiry } = req.body;
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Text content is required' });
    }

    const expirySeconds = expiry ? parseInt(expiry) : config.DEFAULT_EXPIRY_SECONDS;
    const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').replace(/^.*:/, '');

    const transfer = transferManager.createTextTransfer({
      text: text,
      title: title || 'Clipboard Snippet',
      senderInfo: {
        ip: clientIp || 'Local',
        deviceName: req.body.deviceName || 'Web Sender',
        userAgent: req.headers['user-agent']
      },
      expirySeconds: expirySeconds
    });

    logger.log({
      type: 'text',
      mode: 'server',
      key: transfer.key,
      text: text,
      totalSize: Buffer.byteLength(text, 'utf8'),
      sender: transfer.senderInfo,
      status: 'completed'
    });

    res.json({
      success: true,
      transfer: transfer
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lookup 6-digit key
app.get('/api/transfer/receive/:key', (req, res) => {
  const pin = req.params.key;
  const result = transferManager.getTransferByKey(pin);

  if (!result.found) {
    return res.status(404).json({ success: false, error: result.reason });
  }

  res.json({
    success: true,
    transfer: result.transfer
  });
});

// Download single file from transfer (Optimized 1MB HighWaterMark & setNoDelay)
app.get('/api/transfer/download-file/:key/:fileId', (req, res) => {
  const { key, fileId } = req.params;
  const result = transferManager.getTransferByKey(key);

  if (!result.found) {
    return res.status(404).json({ error: result.reason });
  }

  const transfer = result.transfer;
  const targetFile = transfer.files.find(f => f.id === fileId);

  if (!targetFile || !fs.existsSync(targetFile.savedPath)) {
    return res.status(404).json({ error: 'File not found on server' });
  }

  if (res.socket) {
    res.socket.setNoDelay(true);
    res.socket.setTimeout(0);
  }
  transferManager.recordDownload(key);

  const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').replace(/^.*:/, '');
  logger.log({
    type: 'receive',
    mode: 'server',
    key: key,
    files: [{ name: targetFile.originalName, size: targetFile.size }],
    totalSize: targetFile.size,
    receiver: { name: 'Download Client', ip: clientIp || 'LAN' },
    status: 'downloaded'
  });

  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : targetFile.size - 1;
    const chunksize = (end - start) + 1;
    const file = fs.createReadStream(targetFile.savedPath, { start, end, highWaterMark: 1024 * 1024 });

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${targetFile.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': targetFile.mimetype,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(targetFile.originalName)}"`
    });
    file.pipe(res);
  } else {
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(targetFile.originalName)}"`);
    res.setHeader('Content-Type', targetFile.mimetype);
    res.setHeader('Content-Length', targetFile.size);
    res.setHeader('Accept-Ranges', 'bytes');

    const fileStream = fs.createReadStream(targetFile.savedPath, {
      highWaterMark: 1024 * 1024 // 1 MB high-throughput buffer for line-rate transfers
    });
    fileStream.pipe(res);
  }
});

// Download all files from transfer as ZIP bundle (Store mode level 0)
app.get('/api/transfer/download-all/:key', (req, res) => {
  const { key } = req.params;
  const result = transferManager.getTransferByKey(key);

  if (!result.found) {
    return res.status(404).json({ error: result.reason });
  }

  const transfer = result.transfer;
  transferManager.recordDownload(key);

  const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').replace(/^.*:/, '');
  logger.log({
    type: 'receive',
    mode: 'server',
    key: key,
    files: transfer.files.map(f => ({ name: f.originalName, size: f.size })),
    totalSize: transfer.totalSize,
    receiver: { name: 'ZIP Download Client', ip: clientIp || 'LAN' },
    status: 'downloaded'
  });

  transferManager.createZipStreamForTransfer(transfer, res);
});

// Cancel / delete transfer
app.delete('/api/transfer/:key', (req, res) => {
  const pin = req.params.key;
  const deleted = transferManager.deleteTransfer(pin, 'cancelled_by_user');
  res.json({ success: deleted });
});

/* =========================================================================
   VAULT / FTP FILE EXPLORER APIS
   ========================================================================= */

// List Vault directory
app.get('/api/vault/list', (req, res) => {
  const subPath = req.query.path || '';
  const result = transferManager.listVaultContents(subPath);
  if (!result.success) {
    return res.status(400).json(result);
  }
  res.json(result);
});

// Upload files to Vault
app.post('/api/vault/upload', uploadVault.array('files'), (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const targetSubDir = req.body.targetPath || '';
    const uploadedItems = [];

    for (const file of req.files) {
      const saved = transferManager.saveToVault(file, targetSubDir);
      uploadedItems.push(saved);
    }

    const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').replace(/^.*:/, '');
    logger.log({
      type: 'vault_upload',
      mode: 'vault',
      files: req.files.map(f => ({ name: f.originalname, size: f.size })),
      totalSize: req.files.reduce((sum, f) => sum + f.size, 0),
      sender: {
        name: 'Web Vault Client',
        ip: clientIp || 'Local'
      },
      status: 'completed'
    });

    res.json({
      success: true,
      count: uploadedItems.length,
      items: uploadedItems
    });
  } catch (err) {
    console.error('Vault upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Create folder in Vault
app.post('/api/vault/folder', (req, res) => {
  const { name, path: parentPath } = req.body;
  const result = transferManager.createVaultFolder(name, parentPath || '');
  if (!result.success) {
    return res.status(400).json(result);
  }
  res.json(result);
});

// Delete item from Vault
app.delete('/api/vault/item', (req, res) => {
  const itemPath = req.query.path || req.body.path;
  if (!itemPath) return res.status(400).json({ error: 'Path is required' });

  const result = transferManager.deleteVaultItem(itemPath);
  if (!result.success) return res.status(400).json(result);

  res.json(result);
});

// Rename item in Vault
app.post('/api/vault/rename', (req, res) => {
  const { path: itemPath, newName } = req.body;
  if (!itemPath || !newName) return res.status(400).json({ error: 'Path and new name required' });

  const result = transferManager.renameVaultItem(itemPath, newName);
  if (!result.success) return res.status(400).json(result);

  res.json(result);
});

// Turbo Vault Direct Stream Upload: High-speed binary upload directly to Vault without multipart overhead
app.put('/api/vault/turbo-upload', (req, res) => {
  try {
    const rawFileName = req.headers['x-file-name'];
    const targetSubDir = req.headers['x-target-path'] || '';
    if (!rawFileName) return res.status(400).json({ error: 'x-file-name header is required' });

    const originalName = decodeURIComponent(rawFileName);
    const safeSubDir = path.normalize(targetSubDir).replace(/^(\.\.[\/\\])+/, '');
    const destDir = path.join(config.VAULT_DIR, safeSubDir);

    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    const { sanitizeFilename } = require('./utils');
    const safeFilename = sanitizeFilename(originalName);
    const destPath = path.join(destDir, safeFilename);

    if (req.socket) req.socket.setNoDelay(true);

    const writeStream = fs.createWriteStream(destPath, {
      highWaterMark: 1024 * 1024 // 1 MB buffer for maximum write rate
    });

    req.pipe(writeStream);

    writeStream.on('finish', () => {
      const stats = fs.statSync(destPath);
      const relPath = path.relative(config.VAULT_DIR, destPath).replace(/\\/g, '/');

      wsManager.broadcast({
        type: 'vault_updated',
        action: 'add',
        filename: safeFilename
      });

      res.json({
        success: true,
        name: safeFilename,
        path: relPath,
        size: stats.size,
        formattedSize: formatBytes(stats.size)
      });
    });

    writeStream.on('error', (err) => {
      res.status(500).json({ error: err.message });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Download file from Vault (Optimized 1MB Buffer & setNoDelay)
app.get('/api/vault/download', (req, res) => {
  const subPath = req.query.path || '';
  const safePath = path.normalize(subPath).replace(/^(\.\.[\/\\])+/, '');
  const fullPath = path.join(config.VAULT_DIR, safePath);

  if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
    return res.status(404).send('File not found');
  }

  const filename = path.basename(fullPath);
  const mimeType = mime.lookup(filename) || 'application/octet-stream';
  const stats = fs.statSync(fullPath);

  if (res.socket) res.socket.setNoDelay(true);

  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Length', stats.size);
  res.setHeader('Accept-Ranges', 'bytes');

  const fileStream = fs.createReadStream(fullPath, {
    highWaterMark: 1024 * 1024 // 1 MB buffer
  });
  fileStream.pipe(res);
});

// Stream file for Preview (Images, Audio, Video, Code, PDF)
app.get('/api/vault/preview', (req, res) => {
  const subPath = req.query.path || '';
  const safePath = path.normalize(subPath).replace(/^(\.\.[\/\\])+/, '');
  const fullPath = path.join(config.VAULT_DIR, safePath);

  if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
    return res.status(404).send('File not found');
  }

  const filename = path.basename(fullPath);
  const mimeType = mime.lookup(filename) || 'application/octet-stream';
  const stats = fs.statSync(fullPath);

  if (res.socket) res.socket.setNoDelay(true);

  // Support range requests for video and audio streaming
  const range = req.headers.range;
  if (range && (mimeType.startsWith('video/') || mimeType.startsWith('audio/'))) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;
    const chunksize = (end - start) + 1;
    const file = fs.createReadStream(fullPath, { start, end, highWaterMark: 1024 * 1024 });

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stats.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': mimeType
    });
    file.pipe(res);
  } else {
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', stats.size);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`);
    const file = fs.createReadStream(fullPath, { highWaterMark: 1024 * 1024 });
    file.pipe(res);
  }
});

// Download folder as ZIP (Level 0 Store Mode - Wire Speed Disk Streaming)
app.get('/api/vault/download-zip', (req, res) => {
  const subPath = req.query.path || '';
  const safePath = path.normalize(subPath).replace(/^(\.\.[\/\\])+/, '');
  const fullPath = path.join(config.VAULT_DIR, safePath);

  if (!fs.existsSync(fullPath)) {
    return res.status(404).send('Folder not found');
  }

  const folderName = safePath ? path.basename(safePath) : 'Vault_Root';
  const archive = archiver('zip', {
    store: true, // Store mode (level 0) streams at full disk wire speed without CPU lag
    zlib: { level: 0 }
  });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(folderName)}.zip"`);

  archive.pipe(res);
  archive.directory(fullPath, false);
  archive.finalize();
});

// Storage stats
app.get('/api/vault/stats', (req, res) => {
  res.json(transferManager.getStorageStats());
});

/* =========================================================================
   FTP STATUS & CONTROLS
   ========================================================================= */
app.get('/api/ftp/status', (req, res) => {
  res.json(ftpServer.getStatus());
});

app.post('/api/ftp/toggle', async (req, res) => {
  if (ftpServer.isRunning) {
    await ftpServer.stop();
  } else {
    ftpServer.start();
  }
  res.json(ftpServer.getStatus());
});

/* =========================================================================
   ACTIVITY & TRANSFER LOGS APIS
   ========================================================================= */
app.get('/api/logs', (req, res) => {
  const limit = req.query.limit ? parseInt(req.query.limit, 10) : 100;
  const q = req.query.q || '';
  res.json({ success: true, logs: logger.getLogs(limit, q) });
});

app.post('/api/logs/record', (req, res) => {
  try {
    const entry = logger.log(req.body);
    res.json({ success: true, log: entry });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/logs', (req, res) => {
  res.json(logger.clearLogs());
});

// Catch-all route to serve SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(config.ROOT_DIR, 'public', 'index.html'));
});

// Start listening
server.listen(config.HTTP_PORT, '0.0.0.0', () => {
  const primaryIp = getPrimaryLanIP();
  console.log('====================================================');
  console.log('🚀 SendAnywhere LAN & Local FTP Server is RUNNING!');
  console.log(`🌐 Local Web UI:    http://localhost:${config.HTTP_PORT}`);
  console.log(`📱 LAN Web UI:      http://${primaryIp}:${config.HTTP_PORT}`);
  console.log(`📁 Local FTP Server: ftp://${primaryIp}:${config.FTP_PORT}`);
  console.log('====================================================');
});
