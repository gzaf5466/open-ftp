const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const mime = require('mime-types');
const config = require('./config');
const { generate6DigitPin, formatBytes, categorizeFile, sanitizeFilename } = require('./utils');

class TransferManager {
  constructor() {
    // Map of active 6-digit key transfers: key -> TransferObject
    this.transfers = new Map();
    // Map of transfer ID -> key for reverse lookup
    this.idToKey = new Map();
    // Broadcast callback for WebSockets
    this.wsBroadcast = null;

    // Start background cleanup interval for expired transfers
    this.cleanupInterval = setInterval(() => this.cleanupExpiredTransfers(), config.CLEANUP_INTERVAL_MS);
  }

  setWsBroadcast(broadcastFn) {
    this.wsBroadcast = broadcastFn;
  }

  /**
   * Create a new file transfer session with a 6-digit PIN
   */
  createFileTransfer({ files, senderInfo = {}, expirySeconds = config.DEFAULT_EXPIRY_SECONDS, customPin = null }) {
    const existingPins = new Set(this.transfers.keys());
    const pin = customPin && !existingPins.has(customPin) ? customPin : generate6DigitPin(existingPins);
    const transferId = 'tx_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
    const now = Date.now();
    const expiresAt = now + (expirySeconds * 1000);

    const processedFiles = files.map(file => {
      const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8'); // Handle UTF-8 file names properly
      const category = categorizeFile(originalName, file.mimetype);
      return {
        id: 'f_' + Math.random().toString(36).substring(2, 9),
        originalName: originalName,
        savedPath: file.path,
        size: file.size,
        formattedSize: formatBytes(file.size),
        mimetype: file.mimetype || mime.lookup(originalName) || 'application/octet-stream',
        category: category,
        uploadedAt: now
      };
    });

    const totalSize = processedFiles.reduce((sum, f) => sum + f.size, 0);

    const transferData = {
      id: transferId,
      key: pin,
      type: 'files',
      files: processedFiles,
      fileCount: processedFiles.length,
      totalSize: totalSize,
      formattedTotalSize: formatBytes(totalSize),
      senderInfo: {
        ip: senderInfo.ip || 'Local',
        deviceName: senderInfo.deviceName || 'Anonymous Device',
        userAgent: senderInfo.userAgent || ''
      },
      createdAt: now,
      expiresAt: expiresAt,
      expirySeconds: expirySeconds,
      downloadCount: 0,
      maxDownloads: null, // Unlimited until expired or configurable
      status: 'waiting' // 'waiting', 'transferring', 'completed', 'expired'
    };

    this.transfers.set(pin, transferData);
    this.idToKey.set(transferId, pin);

    // Notify peers via WebSocket
    if (this.wsBroadcast) {
      this.wsBroadcast({
        type: 'transfer_created',
        key: pin,
        fileCount: transferData.fileCount,
        totalSize: transferData.totalSize,
        formattedTotalSize: transferData.formattedTotalSize,
        sender: transferData.senderInfo.deviceName,
        expiresAt: transferData.expiresAt
      });
    }

    return transferData;
  }

  /**
   * Initialize a high-throughput turbo file transfer session
   */
  initTurboTransfer({ fileManifest, senderInfo = {}, expirySeconds = config.DEFAULT_EXPIRY_SECONDS }) {
    const existingPins = new Set(this.transfers.keys());
    const pin = generate6DigitPin(existingPins);
    const transferId = 'tx_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
    const now = Date.now();
    const expiresAt = now + (expirySeconds * 1000);

    const processedFiles = fileManifest.map(f => {
      const fileId = 'f_' + Math.random().toString(36).substring(2, 9);
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      const safeName = path.basename(f.name).replace(/[^a-zA-Z0-9._-]/g, '_');
      const savedPath = path.join(config.TEMP_UPLOAD_DIR, `${uniqueSuffix}-${safeName}`);
      const category = categorizeFile(f.name, f.type);
      return {
        id: fileId,
        originalName: f.name,
        savedPath: savedPath,
        size: f.size,
        formattedSize: formatBytes(f.size),
        mimetype: f.type || mime.lookup(f.name) || 'application/octet-stream',
        category: category,
        uploadedBytes: 0,
        completed: false,
        uploadedAt: now
      };
    });

    const totalSize = processedFiles.reduce((sum, f) => sum + f.size, 0);

    const transferData = {
      id: transferId,
      key: pin,
      type: 'files',
      files: processedFiles,
      fileCount: processedFiles.length,
      totalSize: totalSize,
      formattedTotalSize: formatBytes(totalSize),
      senderInfo: {
        ip: senderInfo.ip || 'Local',
        deviceName: senderInfo.deviceName || 'Turbo Sender',
        userAgent: senderInfo.userAgent || ''
      },
      createdAt: now,
      expiresAt: expiresAt,
      expirySeconds: expirySeconds,
      downloadCount: 0,
      status: 'uploading'
    };

    this.transfers.set(pin, transferData);
    this.idToKey.set(transferId, pin);

    return transferData;
  }

  /**
   * Create a new text / clipboard transfer session with a 6-digit PIN
   */
  createTextTransfer({ text, title = 'Text Message', senderInfo = {}, expirySeconds = config.DEFAULT_EXPIRY_SECONDS }) {
    const existingPins = new Set(this.transfers.keys());
    const pin = generate6DigitPin(existingPins);
    const transferId = 'tx_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
    const now = Date.now();
    const expiresAt = now + (expirySeconds * 1000);
    const byteSize = Buffer.byteLength(text, 'utf8');

    const transferData = {
      id: transferId,
      key: pin,
      type: 'text',
      title: title || 'Clipboard Snippet',
      text: text,
      totalSize: byteSize,
      formattedTotalSize: formatBytes(byteSize),
      senderInfo: {
        ip: senderInfo.ip || 'Local',
        deviceName: senderInfo.deviceName || 'Anonymous Device',
        userAgent: senderInfo.userAgent || ''
      },
      createdAt: now,
      expiresAt: expiresAt,
      expirySeconds: expirySeconds,
      downloadCount: 0,
      status: 'waiting'
    };

    this.transfers.set(pin, transferData);
    this.idToKey.set(transferId, pin);

    return transferData;
  }

  /**
   * Look up transfer by 6-digit key (verifying expiration)
   */
  getTransferByKey(pin) {
    const cleanPin = (pin || '').trim().replace(/\s+/g, '');
    const transfer = this.transfers.get(cleanPin);

    if (!transfer) {
      return { found: false, reason: 'Key not found or expired' };
    }

    if (Date.now() > transfer.expiresAt) {
      this.deleteTransfer(cleanPin, 'expired');
      return { found: false, reason: 'Transfer has expired' };
    }

    return {
      found: true,
      transfer: {
        ...transfer,
        remainingSeconds: Math.max(0, Math.floor((transfer.expiresAt - Date.now()) / 1000))
      }
    };
  }

  /**
   * Mark transfer download
   */
  recordDownload(pin) {
    const cleanPin = (pin || '').trim().replace(/\s+/g, '');
    const transfer = this.transfers.get(cleanPin);
    if (transfer) {
      transfer.downloadCount++;
      transfer.status = 'completed';
      if (this.wsBroadcast) {
        this.wsBroadcast({
          type: 'transfer_downloaded',
          key: cleanPin,
          downloadCount: transfer.downloadCount
        });
      }
    }
  }

  /**
   * Delete transfer and clean temporary files
   */
  deleteTransfer(pin, reason = 'deleted') {
    const transfer = this.transfers.get(pin);
    if (!transfer) return false;

    // Delete temporary files on disk
    if (transfer.type === 'files' && Array.isArray(transfer.files)) {
      transfer.files.forEach(file => {
        try {
          if (file.savedPath && fs.existsSync(file.savedPath)) {
            fs.unlinkSync(file.savedPath);
          }
        } catch (err) {
          console.error(`Error deleting temp file ${file.savedPath}:`, err.message);
        }
      });
    }

    this.idToKey.delete(transfer.id);
    this.transfers.delete(pin);

    if (this.wsBroadcast) {
      this.wsBroadcast({
        type: 'transfer_removed',
        key: pin,
        reason: reason
      });
    }

    return true;
  }

  /**
   * Background cleanup of expired transfers
   */
  cleanupExpiredTransfers() {
    const now = Date.now();
    for (const [pin, transfer] of this.transfers.entries()) {
      if (now > transfer.expiresAt) {
        this.deleteTransfer(pin, 'expired');
      }
    }
  }

  /**
   * Create a ZIP stream of all files in a transfer with level 0 Store mode (zero CPU compression bottleneck)
   */
  createZipStreamForTransfer(transfer, res) {
    const archive = archiver('zip', {
      store: true, // Store mode (level 0) streams at full disk wire speed without CPU lag
      zlib: { level: 0 }
    });

    archive.on('error', (err) => {
      console.error('Archiver error:', err);
      if (!res.headersSent) {
        res.status(500).send({ error: 'Archive creation failed' });
      }
    });

    const zipFilename = `SendAnywhere_${transfer.key}_${Date.now()}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);

    archive.pipe(res);

    transfer.files.forEach(file => {
      if (fs.existsSync(file.savedPath)) {
        archive.file(file.savedPath, { name: file.originalName });
      }
    });

    archive.finalize();
  }

  /* =========================================================================
     VAULT / FTP SHARED STORAGE MANAGER
     ========================================================================= */

  /**
   * List files and folders inside the Vault (FTP storage)
   */
  listVaultContents(subPath = '') {
    const safeSubPath = path.normalize(subPath).replace(/^(\.\.[\/\\])+/, '');
    const targetDir = path.join(config.VAULT_DIR, safeSubPath);

    if (!fs.existsSync(targetDir)) {
      return { success: false, error: 'Directory does not exist' };
    }

    const entries = fs.readdirSync(targetDir, { withFileTypes: true });
    const items = [];

    for (const entry of entries) {
      const fullPath = path.join(targetDir, entry.name);
      try {
        const stats = fs.statSync(fullPath);
        const relPath = path.relative(config.VAULT_DIR, fullPath).replace(/\\/g, '/');
        
        if (entry.isDirectory()) {
          items.push({
            name: entry.name,
            path: relPath,
            type: 'folder',
            category: 'folder',
            size: 0,
            formattedSize: '--',
            modifiedAt: stats.mtimeMs,
            modifiedDate: stats.mtime
          });
        } else {
          const mimeType = mime.lookup(entry.name) || 'application/octet-stream';
          const category = categorizeFile(entry.name, mimeType);
          items.push({
            name: entry.name,
            path: relPath,
            type: 'file',
            category: category,
            mimetype: mimeType,
            size: stats.size,
            formattedSize: formatBytes(stats.size),
            modifiedAt: stats.mtimeMs,
            modifiedDate: stats.mtime
          });
        }
      } catch (err) {
        // Skip unreadable files
      }
    }

    // Sort folders first, then files alphabetically
    items.sort((a, b) => {
      if (a.type === b.type) return a.name.localeCompare(b.name);
      return a.type === 'folder' ? -1 : 1;
    });

    return {
      success: true,
      currentPath: safeSubPath.replace(/\\/g, '/'),
      parentPath: safeSubPath ? path.dirname(safeSubPath).replace(/\\/g, '/') : null,
      items: items
    };
  }

  /**
   * Save an uploaded file directly into Vault / Shared Storage
   */
  saveToVault(file, targetSubDir = '') {
    const safeSubDir = path.normalize(targetSubDir).replace(/^(\.\.[\/\\])+/, '');
    const destDir = path.join(config.VAULT_DIR, safeSubDir);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const safeFilename = sanitizeFilename(originalName);
    const destPath = path.join(destDir, safeFilename);

    // If file already exists, create unique name (e.g. name (1).ext)
    let finalDestPath = destPath;
    let counter = 1;
    const ext = path.extname(safeFilename);
    const baseName = path.basename(safeFilename, ext);
    while (fs.existsSync(finalDestPath)) {
      finalDestPath = path.join(destDir, `${baseName} (${counter})${ext}`);
      counter++;
    }

    fs.renameSync(file.path, finalDestPath);
    const stats = fs.statSync(finalDestPath);
    const relPath = path.relative(config.VAULT_DIR, finalDestPath).replace(/\\/g, '/');

    if (this.wsBroadcast) {
      this.wsBroadcast({
        type: 'vault_updated',
        action: 'add',
        filename: path.basename(finalDestPath)
      });
    }

    return {
      name: path.basename(finalDestPath),
      path: relPath,
      size: stats.size,
      formattedSize: formatBytes(stats.size)
    };
  }

  /**
   * Create a folder in Vault
   */
  createVaultFolder(folderName, parentSubDir = '') {
    const safeFolderName = sanitizeFilename(folderName.trim());
    if (!safeFolderName) return { success: false, error: 'Invalid folder name' };

    const safeParent = path.normalize(parentSubDir).replace(/^(\.\.[\/\\])+/, '');
    const targetPath = path.join(config.VAULT_DIR, safeParent, safeFolderName);

    if (fs.existsSync(targetPath)) {
      return { success: false, error: 'Folder already exists' };
    }

    fs.mkdirSync(targetPath, { recursive: true });

    if (this.wsBroadcast) {
      this.wsBroadcast({ type: 'vault_updated', action: 'create_folder', name: safeFolderName });
    }

    return { success: true, folderName: safeFolderName };
  }

  /**
   * Delete item from Vault
   */
  deleteVaultItem(itemRelPath) {
    const safePath = path.normalize(itemRelPath).replace(/^(\.\.[\/\\])+/, '');
    const fullPath = path.join(config.VAULT_DIR, safePath);

    if (!fs.existsSync(fullPath)) {
      return { success: false, error: 'Item not found' };
    }

    const stats = fs.statSync(fullPath);
    if (stats.isDirectory()) {
      fs.rmSync(fullPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(fullPath);
    }

    if (this.wsBroadcast) {
      this.wsBroadcast({ type: 'vault_updated', action: 'delete', path: itemRelPath });
    }

    return { success: true };
  }

  /**
   * Rename item in Vault
   */
  renameVaultItem(itemRelPath, newName) {
    const safeOld = path.normalize(itemRelPath).replace(/^(\.\.[\/\\])+/, '');
    const oldFullPath = path.join(config.VAULT_DIR, safeOld);
    const safeNewName = sanitizeFilename(newName.trim());

    if (!fs.existsSync(oldFullPath)) return { success: false, error: 'Source not found' };
    if (!safeNewName) return { success: false, error: 'Invalid new name' };

    const newFullPath = path.join(path.dirname(oldFullPath), safeNewName);
    if (fs.existsSync(newFullPath)) return { success: false, error: 'A file/folder with that name already exists' };

    fs.renameSync(oldFullPath, newFullPath);

    if (this.wsBroadcast) {
      this.wsBroadcast({ type: 'vault_updated', action: 'rename', oldName: path.basename(oldFullPath), newName: safeNewName });
    }

    return { success: true, newName: safeNewName };
  }

  /**
   * Get Storage Statistics
   */
  getStorageStats() {
    let totalVaultSize = 0;
    let vaultFileCount = 0;
    let vaultFolderCount = 0;

    function scanDir(dir) {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        try {
          const st = fs.statSync(full);
          if (entry.isDirectory()) {
            vaultFolderCount++;
            scanDir(full);
          } else {
            vaultFileCount++;
            totalVaultSize += st.size;
          }
        } catch (e) {}
      }
    }

    scanDir(config.VAULT_DIR);

    return {
      vaultFileCount,
      vaultFolderCount,
      totalVaultSize,
      formattedVaultSize: formatBytes(totalVaultSize),
      activeTransfersCount: this.transfers.size
    };
  }
}

module.exports = new TransferManager();
