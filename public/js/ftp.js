/**
 * FTP Server Hub & Connection Assistant Controller
 * Manages FTP Server state, credentials helper, and client configuration guides
 */

const FtpController = {
  ftpStatus: null,
  currentLanIp: '127.0.0.1',

  init() {
    this.bindEvents();
    this.refreshStatus();
  },

  bindEvents() {
    const toggleBtn = document.getElementById('btn-toggle-ftp');
    if (toggleBtn) {
      toggleBtn.onclick = () => this.handleToggleFtp();
    }

    // Network Interface switch dropdown
    const ifaceSelect = document.getElementById('ftp-interface-select');
    if (ifaceSelect) {
      ifaceSelect.onchange = (e) => {
        this.currentLanIp = e.target.value;
        this.updateClientSnippets();
      };
    }

    // Copy snippet buttons
    document.querySelectorAll('[data-copy-target]').forEach(btn => {
      btn.onclick = () => {
        const targetId = btn.dataset.copyTarget;
        const targetEl = document.getElementById(targetId);
        if (targetEl) {
          navigator.clipboard.writeText(targetEl.textContent.trim()).then(() => {
            if (window.sounds) window.sounds.playPop();
            app.showToast('Connection string copied!', 'success');
          });
        }
      };
    });
  },

  async refreshStatus() {
    try {
      const status = await API.getFtpStatus();
      this.ftpStatus = status;
      this.renderStatus(status);
    } catch (e) {
      console.error('Failed to get FTP status:', e);
    }
  },

  renderStatus(status) {
    const badge = document.getElementById('ftp-live-status-badge');
    const toggleBtn = document.getElementById('btn-toggle-ftp');
    const portEl = document.getElementById('ftp-port-label');
    const authEl = document.getElementById('ftp-auth-label');

    if (badge) {
      badge.className = `ftp-live-badge ${status.running ? 'online' : 'offline'}`;
      badge.innerHTML = `
        <span class="lan-dot" style="background: ${status.running ? 'var(--accent-emerald)' : 'var(--accent-rose)'};"></span>
        ${status.running ? 'Running & Active' : 'Stopped'}
      `;
    }

    if (toggleBtn) {
      toggleBtn.className = status.running ? 'btn btn-danger btn-sm' : 'btn btn-emerald btn-sm';
      toggleBtn.innerHTML = status.running 
        ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Stop Server'
        : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg> Start Server';
    }

    if (portEl) portEl.textContent = status.port;
    if (authEl) authEl.textContent = status.anonymous ? 'Anonymous (or admin / admin123)' : 'admin / admin123';

    this.updateClientSnippets();
  },

  async handleToggleFtp() {
    try {
      const newStatus = await API.toggleFtp();
      this.ftpStatus = newStatus;
      this.renderStatus(newStatus);
      if (window.sounds) window.sounds.playPop();
      app.showToast(newStatus.running ? 'FTP Server Started' : 'FTP Server Stopped', 'success');
    } catch (e) {
      app.showToast(e.message || 'Failed to toggle FTP server', 'error');
    }
  },

  updateClientSnippets() {
    const ip = this.currentLanIp || (window.appState ? window.appState.primaryIp : '127.0.0.1');
    const port = this.ftpStatus ? this.ftpStatus.port : 2121;
    const ftpUrl = `ftp://${ip}:${port}`;

    const winSnippet = document.getElementById('ftp-snippet-windows');
    const macSnippet = document.getElementById('ftp-snippet-mac');
    const filezillaHost = document.getElementById('ftp-snippet-host');
    const curlSnippet = document.getElementById('ftp-snippet-curl');

    if (winSnippet) winSnippet.textContent = ftpUrl;
    if (macSnippet) macSnippet.textContent = ftpUrl;
    if (filezillaHost) filezillaHost.textContent = ip;
    if (curlSnippet) curlSnippet.textContent = `curl -u anonymous: "${ftpUrl}/"`;
  },

  populateInterfaces(interfaces, primaryIp) {
    this.currentLanIp = primaryIp;
    const select = document.getElementById('ftp-interface-select');
    if (!select) return;

    select.innerHTML = '';
    interfaces.forEach(iface => {
      const opt = document.createElement('option');
      opt.value = iface.address;
      opt.textContent = iface.label;
      opt.selected = iface.address === primaryIp;
      select.appendChild(opt);
    });

    this.updateClientSnippets();
  }
};

window.FtpController = FtpController;
