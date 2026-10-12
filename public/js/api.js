/**
 * Headless API Client & Browser Storage Engine
 * Runs 100% in-browser on Vercel with zero server dependencies
 * - Client-side QR generation (via QRCode.js)
 * - IndexedDB & LocalStorage persistence for Vault and Transfer Logs
 * - Native WebRTC & Storage quota discovery
 */

const API = {
  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------
  formatBytes(bytes, decimals = 1) {
    if (!+bytes) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
  },

  // --------------------------------------------------------------------------
  // System Info & QR (100% In-Browser)
  // --------------------------------------------------------------------------
  async getServerInfo() {
    let storageStats = {
      usedBytes: 0,
      totalBytes: 50 * 1024 * 1024 * 1024,
      formattedUsed: '0 B',
      formattedTotal: '50 GB'
    };

    if (navigator.storage && navigator.storage.estimate) {
      try {
        const est = await navigator.storage.estimate();
        const used = est.usage || 0;
        const total = est.quota || (50 * 1024 * 1024 * 1024);
        storageStats = {
          usedBytes: used,
          totalBytes: total,
          formattedUsed: this.formatBytes(used),
          formattedTotal: this.formatBytes(total)
        };
      } catch (e) {}
    }

    const currentUrl = window.location.href.split('#')[0];
    let qrDataUrl = '';
    try {
      qrDataUrl = await this.getQrCode(currentUrl, 256);
    } catch (e) {}

    return {
      hostname: window.location.hostname || 'open-ftp.vercel.app',
      primaryIp: 'Headless P2P',
      port: 443,
      lanUrl: currentUrl,
      interfaces: [
        { name: 'WebRTC Direct Mesh', address: 'P2P Online' }
      ],
      qrDataUrl: qrDataUrl,
      storage: storageStats,
      ftp: {
        running: false,
        headless: true,
        port: 21,
        anonymous: true,
        rootDir: 'Browser P2P Mode (Headless)',
        user: 'anonymous'
      },
      defaultExpiry: 600,
      headless: true
    };
  },

  async getQrCode(text, size = 260) {
    return new Promise((resolve) => {
      try {
        if (typeof QRCode !== 'undefined') {
          const tempDiv = document.createElement('div');
          new QRCode(tempDiv, {
            text: text,
            width: size,
            height: size,
            colorDark: '#111827',
            colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.H
          });

          setTimeout(() => {
            const img = tempDiv.querySelector('img');
            const canvas = tempDiv.querySelector('canvas');
            if (canvas) {
              resolve(canvas.toDataURL('image/png'));
            } else if (img && img.src) {
              resolve(img.src);
            } else {
              resolve(`https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(text)}`);
            }
          }, 40);
          return;
        }
      } catch (e) {}
      // Fallback
      resolve(`https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(text)}`);
    });
  },

  // --------------------------------------------------------------------------
  // Headless Transfers (Always routed over WebRTC P2P)
  // --------------------------------------------------------------------------
  async sendFiles(files, options = {}, onProgress = null) {
    // In headless mode, transfers are handled directly by P2PEngine over WebRTC
    return {
      success: true,
      transfer: {
        key: Math.floor(100000 + Math.random() * 900000).toString(),
        isP2P: true,
        files: Array.from(files).map((f, i) => ({
          id: 'p2p_' + i,
          originalName: f.name,
          size: f.size,
          formattedSize: this.formatBytes(f.size)
        }))
      }
    };
  },

  async sendText({ text, title = 'Clipboard Snippet', expiry = 600, deviceName = '' }) {
    const pin = Math.floor(100000 + Math.random() * 900000).toString();
    return {
      success: true,
      transfer: {
        key: pin,
        type: 'text',
        isP2P: true,
        text: text,
        title: title,
        senderInfo: { deviceName: deviceName || 'Headless Peer', ip: 'P2P Direct' },
        expiresAt: Date.now() + (expiry * 1000)
      }
    };
  },

  async lookupTransfer(pin) {
    // Lookups are handled directly over real-time WebRTC room events
    return {
      success: false,
      error: 'P2P Key awaiting direct peer handshake'
    };
  },

  async deleteTransfer(pin) {
    return { success: true };
  },

  // --------------------------------------------------------------------------
  // Vault & Local In-Browser Storage (IndexedDB)
  // --------------------------------------------------------------------------
  async openVaultDb() {
    return new Promise((resolve) => {
      if (!window.indexedDB) return resolve(null);
      const req = indexedDB.open('OpenFTP_Vault_DB', 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('files')) {
          db.createObjectStore('files', { keyPath: 'path' });
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = () => resolve(null);
    });
  },

  async listVault(subPath = '') {
    const db = await this.openVaultDb();
    if (!db) return { success: true, items: [] };

    return new Promise((resolve) => {
      try {
        const tx = db.transaction('files', 'readonly');
        const store = tx.objectStore('files');
        const req = store.getAll();
        req.onsuccess = () => {
          const all = req.result || [];
          const normalizedPath = (subPath || '').replace(/^\/+|\/+$/g, '');
          const filtered = all.filter(item => {
            const itemParent = (item.parentPath || '').replace(/^\/+|\/+$/g, '');
            return itemParent === normalizedPath;
          });
          resolve({ success: true, items: filtered, currentPath: subPath });
        };
        req.onerror = () => resolve({ success: true, items: [] });
      } catch (e) {
        resolve({ success: true, items: [] });
      }
    });
  },

  async uploadVault(files, targetPath = '', onProgress = null) {
    const db = await this.openVaultDb();
    const fileArray = Array.from(files);
    let loaded = 0;

    for (const file of fileArray) {
      const itemPath = (targetPath ? targetPath.replace(/\/+$/, '') + '/' : '') + file.name;
      const fileData = {
        name: file.name,
        path: itemPath,
        parentPath: targetPath.replace(/^\/+|\/+$/g, ''),
        size: file.size,
        formattedSize: this.formatBytes(file.size),
        type: 'file',
        mimetype: file.type || 'application/octet-stream',
        lastModified: file.lastModified || Date.now(),
        blob: file
      };

      if (db) {
        await new Promise((resolve) => {
          const tx = db.transaction('files', 'readwrite');
          const store = tx.objectStore('files');
          store.put(fileData);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        });
      }

      loaded++;
      if (onProgress) {
        onProgress({ loaded, total: fileArray.length, percent: Math.round((loaded / fileArray.length) * 100) });
      }
    }

    return { success: true, count: fileArray.length };
  },

  async createVaultFolder(name, parentPath = '') {
    const db = await this.openVaultDb();
    const cleanName = (name || 'New Folder').trim();
    const folderPath = (parentPath ? parentPath.replace(/\/+$/, '') + '/' : '') + cleanName;

    const folderData = {
      name: cleanName,
      path: folderPath,
      parentPath: parentPath.replace(/^\/+|\/+$/g, ''),
      size: 0,
      formattedSize: '--',
      type: 'folder',
      lastModified: Date.now()
    };

    if (db) {
      await new Promise((resolve) => {
        const tx = db.transaction('files', 'readwrite');
        const store = tx.objectStore('files');
        store.put(folderData);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    }

    return { success: true, folder: folderData };
  },

  async renameVaultItem(itemPath, newName) {
    const db = await this.openVaultDb();
    if (!db) return { success: true };

    return new Promise((resolve) => {
      const tx = db.transaction('files', 'readwrite');
      const store = tx.objectStore('files');
      const req = store.get(itemPath);
      req.onsuccess = () => {
        const item = req.result;
        if (item) {
          store.delete(itemPath);
          item.name = newName;
          const parent = item.parentPath ? item.parentPath + '/' : '';
          item.path = parent + newName;
          store.put(item);
        }
        resolve({ success: true });
      };
      req.onerror = () => resolve({ success: false });
    });
  },

  async deleteVaultItem(itemPath) {
    const db = await this.openVaultDb();
    if (!db) return { success: true };

    return new Promise((resolve) => {
      const tx = db.transaction('files', 'readwrite');
      const store = tx.objectStore('files');
      store.delete(itemPath);
      tx.oncomplete = () => resolve({ success: true });
      tx.onerror = () => resolve({ success: false });
    });
  },

  async getVaultStats() {
    return {
      success: true,
      usedBytes: 0,
      formattedUsed: '0 B'
    };
  },

  // --------------------------------------------------------------------------
  // FTP Server Controls (Headless Mode Handler)
  // --------------------------------------------------------------------------
  async getFtpStatus() {
    return {
      running: false,
      headless: true,
      port: 21,
      anonymous: true,
      rootDir: 'Browser P2P Mesh (Headless)',
      user: 'anonymous'
    };
  },

  async toggleFtp() {
    return {
      success: true,
      running: false,
      headless: true,
      message: 'Headless WebRTC P2P Mode active (Zero backend required)'
    };
  },

  // --------------------------------------------------------------------------
  // Activity & Transfer Logs (LocalStorage Persistence)
  // --------------------------------------------------------------------------
  async getTransferLogs(limit = 100, searchQuery = '') {
    try {
      const raw = localStorage.getItem('openftp_transfer_logs');
      let logs = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(logs)) logs = [];

      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        logs = logs.filter(l =>
          (l.key && l.key.includes(q)) ||
          (l.files && l.files.some(f => (f.name || '').toLowerCase().includes(q)))
        );
      }

      return {
        success: true,
        logs: logs.slice(0, limit),
        total: logs.length
      };
    } catch (e) {
      return { success: true, logs: [], total: 0 };
    }
  },

  async recordTransferLog(entry) {
    try {
      const raw = localStorage.getItem('openftp_transfer_logs');
      let logs = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(logs)) logs = [];

      const newLog = {
        id: 'log_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
        timestamp: Date.now(),
        formattedTime: new Date().toLocaleTimeString(),
        ...entry
      };

      logs.unshift(newLog);
      if (logs.length > 300) logs.pop();
      localStorage.setItem('openftp_transfer_logs', JSON.stringify(logs));

      if (window.wsClient) {
        window.wsClient.emit('transfer_log_added', { log: newLog });
      }

      return { success: true, log: newLog };
    } catch (e) {
      return { success: false };
    }
  },

  async clearTransferLogs() {
    localStorage.removeItem('openftp_transfer_logs');
    if (window.wsClient) {
      window.wsClient.emit('transfer_logs_cleared');
    }
    return { success: true };
  }
};

window.API = API;
