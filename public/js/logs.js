/**
 * Activity & Transfer Logs Controller
 * Manages persistent transfer logs, real-time sync, filtering, and timestamp rendering
 */

class LogsController {
  constructor() {
    this.logs = [];
    this.currentFilter = 'all';
    this.searchQuery = '';
    this.modalId = 'modal-transfer-logs';
  }

  init() {
    this.bindEvents();
    this.setupWebSocketListeners();
    this.refreshLogsSilent();
  }

  bindEvents() {
    // Header trigger button
    const toggleBtn = document.getElementById('btn-toggle-logs');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        this.open();
      });
    }

    // Filter Chips
    document.querySelectorAll('[data-log-filter]').forEach(chip => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('[data-log-filter]').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        this.currentFilter = chip.dataset.logFilter;
        this.renderLogs();
      });
    });

    // Search Input
    const searchInput = document.getElementById('logs-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        this.searchQuery = e.target.value.trim().toLowerCase();
        this.renderLogs();
      });
    }

    // Clear Logs Button
    const clearBtn = document.getElementById('btn-clear-logs');
    if (clearBtn) {
      clearBtn.addEventListener('click', async () => {
        if (!confirm('Are you sure you want to clear all transfer logs?')) return;
        try {
          await window.API.clearTransferLogs();
          this.logs = [];
          this.renderLogs();
          if (window.app) window.app.showToast('Transfer logs cleared', 'info');
        } catch (err) {
          if (window.app) window.app.showToast('Failed to clear logs', 'error');
        }
      });
    }
  }

  setupWebSocketListeners() {
    if (!window.wsClient) return;

    window.wsClient.on('transfer_logged', (msg) => {
      if (msg && msg.log) {
        // Prepend new log
        this.logs.unshift(msg.log);
        if (this.logs.length > 500) this.logs.pop();
        this.updateBadge();
        this.renderLogs();
      }
    });

    window.wsClient.on('transfer_logs_cleared', () => {
      this.logs = [];
      this.updateBadge();
      this.renderLogs();
    });
  }

  async open() {
    if (window.app) window.app.openModal(this.modalId);
    await this.fetchLogs();
  }

  async refreshLogsSilent() {
    try {
      const res = await window.API.getTransferLogs(200);
      if (res && res.logs) {
        this.logs = res.logs;
        this.updateBadge();
      }
    } catch (e) {}
  }

  async fetchLogs() {
    try {
      const res = await window.API.getTransferLogs(200);
      if (res && res.logs) {
        this.logs = res.logs;
        this.updateBadge();
        this.renderLogs();
      }
    } catch (err) {
      console.error('Error fetching logs:', err);
    }
  }

  updateBadge() {
    const badge = document.getElementById('logs-count-badge');
    if (badge) {
      badge.textContent = this.logs.length;
    }
  }

  formatTimeAgo(isoString) {
    if (!isoString) return '';
    const date = new Date(isoString);
    const now = new Date();
    const diffSec = Math.floor((now - date) / 1000);

    if (diffSec < 15) return 'Just now';
    if (diffSec < 60) return `${diffSec}s ago`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHour = Math.floor(diffMin / 60);
    if (diffHour < 24) return `${diffHour}h ago`;
    const diffDay = Math.floor(diffHour / 24);
    if (diffDay < 7) return `${diffDay}d ago`;
    return date.toLocaleDateString();
  }

  formatExactTime(isoString) {
    if (!isoString) return '';
    const d = new Date(isoString);
    return d.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  renderLogs() {
    const container = document.getElementById('logs-list-container');
    if (!container) return;

    let filtered = this.logs;

    // Filter Chips
    if (this.currentFilter === 'p2p') {
      filtered = filtered.filter(l => l.mode === 'p2p');
    } else if (this.currentFilter === 'server') {
      filtered = filtered.filter(l => l.mode === 'server');
    } else if (this.currentFilter === 'vault') {
      filtered = filtered.filter(l => l.mode === 'vault');
    } else if (this.currentFilter === 'send') {
      filtered = filtered.filter(l => l.type === 'send' || l.type === 'p2p_direct');
    } else if (this.currentFilter === 'receive') {
      filtered = filtered.filter(l => l.type === 'receive');
    }

    // Search Query
    if (this.searchQuery) {
      const q = this.searchQuery;
      filtered = filtered.filter(l => {
        const keyMatch = (l.key || '').toLowerCase().includes(q);
        const senderMatch = (l.sender?.name || '').toLowerCase().includes(q);
        const receiverMatch = (l.receiver?.name || '').toLowerCase().includes(q);
        const fileMatch = (l.files || []).some(f => (f.name || '').toLowerCase().includes(q));
        const textMatch = (l.textSnippet || '').toLowerCase().includes(q);
        return keyMatch || senderMatch || receiverMatch || fileMatch || textMatch;
      });
    }

    if (filtered.length === 0) {
      container.innerHTML = `
        <div class="log-empty-view">
          <div class="log-empty-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          </div>
          <div style="font-weight: 500;">No transfer logs found</div>
          <div style="font-size: 0.75rem; color: var(--text-subtle);">Transfers made via P2P Direct, 6-digit PIN, or Vault will appear here with full timestamps.</div>
        </div>
      `;
      return;
    }

    container.innerHTML = filtered.map(log => {
      const relativeTime = this.formatTimeAgo(log.timestamp);
      const exactTime = this.formatExactTime(log.timestamp);

      // Mode Badge
      let modeBadge = '';
      if (log.mode === 'p2p') {
        modeBadge = '<span class="log-badge log-badge-p2p">⚡ P2P Direct</span>';
      } else if (log.mode === 'vault') {
        modeBadge = '<span class="log-badge log-badge-vault">📁 Vault</span>';
      } else {
        modeBadge = '<span class="log-badge log-badge-server">🔑 PIN Transfer</span>';
      }

      // Status Badge
      let statusClass = 'log-badge-status-completed';
      let statusLabel = 'Completed';
      if (log.status === 'resumed') {
        statusClass = 'log-badge-status-resumed';
        statusLabel = 'Resumed';
      } else if (log.status === 'in_progress') {
        statusClass = 'log-badge-status-inprogress';
        statusLabel = 'In Progress';
      } else if (log.status === 'downloaded') {
        statusClass = 'log-badge-status-downloaded';
        statusLabel = 'Downloaded';
      }

      // Files or text content
      let contentHtml = '';
      if (log.type === 'text') {
        contentHtml = `
          <div class="log-text-snippet">
            ${this.escapeHtml(log.textSnippet || '')}
          </div>
        `;
      } else if (log.files && log.files.length > 0) {
        contentHtml = `
          <div class="log-files-list">
            ${log.files.map(f => `
              <div class="log-file-pill">
                <span class="log-file-name" title="${this.escapeHtml(f.name)}">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
                  ${this.escapeHtml(f.name)}
                </span>
                <span class="log-file-size">${f.formattedSize || ''}</span>
              </div>
            `).join('')}
          </div>
        `;
      }

      // PIN Badge
      const pinHtml = (log.key && log.key !== '--')
        ? `<span class="log-pin-pill" title="6-Digit PIN">${log.key}</span>`
        : '';

      // Parties
      const senderName = log.sender?.name || 'Local Device';
      const receiverName = log.receiver?.name || (log.mode === 'p2p' ? 'Direct Peer' : 'LAN Peer');

      return `
        <div class="log-item-card animate-fade-in" data-log-id="${log.id}">
          <div class="log-item-top">
            <div class="log-time-group" title="${exactTime}">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              <span class="log-relative-time">${relativeTime}</span>
              <span>•</span>
              <span>${exactTime}</span>
            </div>
            <div class="log-badges-group">
              ${modeBadge}
              <span class="log-badge ${statusClass}">${statusLabel}</span>
            </div>
          </div>

          <div class="log-item-content">
            ${contentHtml}
          </div>

          <div class="log-item-footer">
            <div class="log-party-route">
              <span class="log-party-badge">${this.escapeHtml(senderName)}</span>
              <span>→</span>
              <span class="log-party-badge">${this.escapeHtml(receiverName)}</span>
            </div>
            <div style="display: flex; align-items: center; gap: 0.4rem;">
              ${pinHtml}
              <span style="font-family: var(--font-mono); font-weight: 600; color: var(--text-main);">${log.formattedTotalSize || ''}</span>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}

window.LogsController = new LogsController();
