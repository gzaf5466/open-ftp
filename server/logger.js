const fs = require('fs');
const path = require('path');
const config = require('./config');
const { formatBytes } = require('./utils');

const LOGS_FILE = path.join(config.DATA_DIR, 'transfer_logs.json');

class TransferLogger {
  constructor() {
    this.logs = [];
    this.wsBroadcast = null;
    this.loadLogs();
  }

  setWsBroadcast(broadcastFn) {
    this.wsBroadcast = broadcastFn;
  }

  loadLogs() {
    try {
      if (fs.existsSync(LOGS_FILE)) {
        const raw = fs.readFileSync(LOGS_FILE, 'utf8');
        this.logs = JSON.parse(raw);
        if (!Array.isArray(this.logs)) this.logs = [];
      } else {
        this.logs = [];
        this.saveLogs();
      }
    } catch (e) {
      console.warn('[Logger] Error reading transfer logs:', e.message);
      this.logs = [];
    }
  }

  saveLogs() {
    try {
      fs.writeFileSync(LOGS_FILE, JSON.stringify(this.logs, null, 2), 'utf8');
    } catch (e) {
      console.error('[Logger] Failed to write transfer logs:', e.message);
    }
  }

  /**
   * Log an activity / transfer event
   * @param {Object} entry
   */
  log({
    type = 'send', // 'send' | 'receive' | 'p2p_direct' | 'vault_upload' | 'text'
    mode = 'p2p',  // 'p2p' | 'server' | 'vault'
    key = '',
    files = [],
    text = '',
    totalSize = 0,
    sender = null,
    receiver = null,
    status = 'completed' // 'completed' | 'in_progress' | 'downloaded' | 'resumed' | 'failed'
  }) {
    const now = new Date();
    const logId = 'log_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);

    // Normalize files format
    const normalizedFiles = (files || []).map(f => ({
      name: f.name || f.originalName || 'Unnamed File',
      size: f.size || 0,
      formattedSize: f.formattedSize || formatBytes(f.size || 0),
      category: f.category || 'file'
    }));

    const calculatedTotal = totalSize || normalizedFiles.reduce((sum, f) => sum + (f.size || 0), 0) || (text ? Buffer.byteLength(text, 'utf8') : 0);

    const logEntry = {
      id: logId,
      timestamp: now.toISOString(),
      formattedTime: now.toLocaleString(),
      timeAgoMs: Date.now(),
      type: type,
      mode: mode,
      key: key || '--',
      fileCount: normalizedFiles.length,
      files: normalizedFiles,
      textSnippet: text ? (text.length > 80 ? text.substring(0, 80) + '...' : text) : null,
      totalBytes: calculatedTotal,
      formattedTotalSize: formatBytes(calculatedTotal),
      sender: {
        name: sender ? (sender.name || sender.deviceName || 'Local Device') : 'Local Device',
        ip: sender ? (sender.ip || 'LAN') : 'LAN'
      },
      receiver: receiver ? {
        name: receiver.name || receiver.deviceName || 'Peer Device',
        ip: receiver.ip || 'LAN'
      } : null,
      status: status
    };

    // Prepend (newest first) and limit to 500 entries
    this.logs.unshift(logEntry);
    if (this.logs.length > 500) {
      this.logs = this.logs.slice(0, 500);
    }

    this.saveLogs();

    // Broadcast to real-time clients
    if (this.wsBroadcast) {
      this.wsBroadcast({
        type: 'transfer_logged',
        log: logEntry
      });
    }

    return logEntry;
  }

  getLogs(limit = 100, searchQuery = '') {
    let result = this.logs;
    if (searchQuery) {
      const q = searchQuery.toLowerCase().trim();
      result = result.filter(item => {
        const matchKey = (item.key || '').toLowerCase().includes(q);
        const matchSender = (item.sender?.name || '').toLowerCase().includes(q);
        const matchReceiver = (item.receiver?.name || '').toLowerCase().includes(q);
        const matchFiles = (item.files || []).some(f => (f.name || '').toLowerCase().includes(q));
        const matchText = (item.textSnippet || '').toLowerCase().includes(q);
        return matchKey || matchSender || matchReceiver || matchFiles || matchText;
      });
    }
    return result.slice(0, limit);
  }

  clearLogs() {
    this.logs = [];
    this.saveLogs();
    if (this.wsBroadcast) {
      this.wsBroadcast({ type: 'transfer_logs_cleared' });
    }
    return { success: true };
  }
}

module.exports = new TransferLogger();
