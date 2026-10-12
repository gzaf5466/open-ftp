/**
 * Main Application Orchestrator & Router
 * Manages view routing, themes, sound settings, toasts, modals, and system bootstrap
 */

class App {
  constructor() {
    this.currentTab = 'send';
    this.systemInfo = null;
    this.theme = localStorage.getItem('theme') || 'light';
  }

  async init() {
    this.applyTheme(this.theme);
    this.bindGlobalEvents();

    // Initialize sub-controllers safely
    const controllers = [
      ['SendController', () => window.SendController?.init()],
      ['ReceiveController', () => window.ReceiveController?.init()],
      ['VaultController', () => window.VaultController?.init()],
      ['PeersController', () => window.PeersController?.init()],
      ['FtpController', () => window.FtpController?.init()],
      ['LogsController', () => window.LogsController?.init()],
      ['QrScannerController', () => window.QrScannerController?.init()],
      ['IdmResumeController', () => window.IdmResumeController?.init()]
    ];

    controllers.forEach(([name, initFn]) => {
      try {
        initFn();
      } catch (err) {
        console.error(`[App] Error initializing ${name}:`, err);
      }
    });

    // Connect WebSocket
    try {
      window.wsClient.connect();
    } catch (err) {
      console.error('[App] WebSocket connection error:', err);
    }

    // Load Server Info
    await this.loadSystemInfo();

    // Process initial route / hash
    this.handleRouting();
    window.addEventListener('hashchange', () => this.handleRouting());

    // Register Service Worker for PWA
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }

    // Update sound icon
    this.updateSoundToggleIcon();
  }

  triggerHaptic(duration = 12) {
    if ('vibrate' in navigator) {
      try {
        navigator.vibrate(duration);
      } catch (e) {}
    }
  }

  async requestWakeLock() {
    try {
      if ('wakeLock' in navigator && !this.wakeLock) {
        this.wakeLock = await navigator.wakeLock.request('screen');
        this.wakeLock.addEventListener('release', () => { this.wakeLock = null; });
      }
    } catch (e) {}
  }

  releaseWakeLock() {
    if (this.wakeLock) {
      this.wakeLock.release().catch(() => {});
      this.wakeLock = null;
    }
  }

  async loadSystemInfo() {
    try {
      const info = await API.getServerInfo();
      this.systemInfo = info;
      window.appState = {
        primaryIp: info.primaryIp,
        port: info.port,
        currentTab: this.currentTab
      };

      // Header LAN IP (Dynamic: Shows LAN IP on local Wi-Fi, or "Online" on Vercel/Cloud)
      const headerIpLabel = document.getElementById('header-lan-ip-label');
      if (headerIpLabel) {
        const isLocalHost = ['localhost', '127.0.0.1'].includes(window.location.hostname) ||
                            /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/.test(window.location.hostname);
        if (isLocalHost && info.primaryIp && !info.headless) {
          headerIpLabel.textContent = `${info.primaryIp}:${info.port}`;
        } else {
          headerIpLabel.textContent = 'P2P Online';
        }
      }

      // FTP Interfaces Dropdown
      if (info.interfaces) {
        FtpController.populateInterfaces(info.interfaces, info.primaryIp);
      }

      // Quick QR Hub Image
      const qrHubImg = document.getElementById('qr-hub-preview-img');
      const qrHubUrl = document.getElementById('qr-hub-lan-url');
      if (qrHubImg && info.qrDataUrl) qrHubImg.src = info.qrDataUrl;
      if (qrHubUrl) qrHubUrl.textContent = info.lanUrl;

    } catch (e) {
      console.warn('Could not load system info:', e);
    }
  }

  bindGlobalEvents() {
    // Nav Tab Buttons
    document.querySelectorAll('[data-nav-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.navTab;
        this.switchTab(tab);
      });
    });

    // Theme Toggle
    const themeBtn = document.getElementById('btn-toggle-theme');
    if (themeBtn) {
      themeBtn.addEventListener('click', () => this.toggleTheme());
    }

    // Sound Toggle
    const soundBtn = document.getElementById('btn-toggle-sound');
    if (soundBtn) {
      soundBtn.addEventListener('click', () => this.toggleSound());
    }

    // LAN IP / Public Domain Copy in Header
    const lanBadge = document.getElementById('header-lan-badge');
    if (lanBadge) {
      lanBadge.addEventListener('click', () => {
        const isLocalHost = ['localhost', '127.0.0.1'].includes(window.location.hostname) ||
                            /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/.test(window.location.hostname);
        const urlToCopy = (isLocalHost && this.systemInfo && this.systemInfo.lanUrl)
          ? this.systemInfo.lanUrl
          : window.location.origin;

        navigator.clipboard.writeText(urlToCopy).then(() => {
          if (window.sounds) window.sounds.playPop();
          this.showToast(`URL copied: ${urlToCopy}`, 'success');
        });
      });
    }

    // Modal Close Triggers
    document.querySelectorAll('[data-close-modal]').forEach(btn => {
      btn.addEventListener('click', () => {
        const modalId = btn.dataset.closeModal || btn.closest('.modal-overlay').id;
        this.closeModal(modalId);
      });
    });

    // Close modal on click outside container
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          this.closeModal(overlay.id);
        }
      });
    });

    // Escape key closes modals
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.modal-overlay.active').forEach(m => this.closeModal(m.id));
      }
    });
  }

  handleRouting() {
    const hash = window.location.hash.replace(/^#/, '');

    if (hash.startsWith('receive/') || hash.startsWith('receive=')) {
      const parts = hash.split('?');
      const pin = parts[0].replace(/^receive[/=]/, '').replace(/[^0-9]/g, '');
      const searchParams = new URLSearchParams(parts[1] || window.location.search);
      const senderId = searchParams.get('s') || searchParams.get('sender') || '';
      this.switchTab('receive');
      if (pin && pin.length === 6) {
        setTimeout(() => {
          ReceiveController.fillPin(pin);
          ReceiveController.fetchTransferByKey(pin, senderId);
        }, 150);
      }
    } else if (['send', 'receive', 'vault', 'radar', 'ftp'].includes(hash)) {
      this.switchTab(hash);
    } else {
      this.switchTab('send');
    }
  }

  switchTab(tabName) {
    this.currentTab = tabName;
    if (window.appState) window.appState.currentTab = tabName;
    this.triggerHaptic(10);

    // Update nav tab buttons
    document.querySelectorAll('[data-nav-tab]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.navTab === tabName);
    });

    // Update section view visibility
    document.querySelectorAll('.app-tab-section').forEach(section => {
      const isTarget = section.id === `section-${tabName}`;
      section.style.display = isTarget ? 'block' : 'none';
      if (isTarget) {
        section.classList.remove('animate-fade-in');
        void section.offsetWidth; // trigger reflow
        section.classList.add('animate-fade-in');
      }
    });

    // Load data specific to tabs
    if (tabName === 'vault') {
      VaultController.loadDirectory(VaultController.currentPath);
    } else if (tabName === 'ftp') {
      FtpController.refreshStatus();
    } else if (tabName === 'radar' && window.PeersController) {
      PeersController.renderRadarNodes();
      PeersController.renderPeers();
    }

    // Refresh IDM Resume Vault Checkpoints
    if (window.IdmResumeController) {
      window.IdmResumeController.refreshCheckpoints();
    }

    if (window.location.hash !== `#${tabName}` && !window.location.hash.startsWith('#receive/')) {
      window.history.replaceState(null, '', `#${tabName}`);
    }
  }

  toggleTheme() {
    this.theme = this.theme === 'dark' ? 'light' : 'dark';
    this.applyTheme(this.theme);
  }

  applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);

    const themeIcon = document.getElementById('theme-icon-slot');
    if (themeIcon) {
      themeIcon.innerHTML = theme === 'dark'
        ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>'
        : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
    }
  }

  toggleSound() {
    const isMuted = window.sounds.toggleMute();
    this.updateSoundToggleIcon();
    this.showToast(isMuted ? 'Sound muted' : 'Sound enabled', 'info');
  }

  updateSoundToggleIcon() {
    const isMuted = window.sounds.isMuted();
    const soundIconSlot = document.getElementById('sound-icon-slot');
    if (soundIconSlot) {
      soundIconSlot.innerHTML = isMuted
        ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/></svg>'
        : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
    }
  }

  openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.classList.add('active');
    }
  }

  closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.classList.remove('active');
      if (modalId === 'modal-file-preview' && window.PreviewController) {
        window.PreviewController.close();
      }
    }
  }

  showToast(message, type = 'info', duration = 2500) {
    const stack = document.getElementById('toast-stack');
    if (!stack || !message) return;

    // 1. Deduplication: Don't stack duplicate identical messages
    const existing = Array.from(stack.querySelectorAll('.toast')).find(t => {
      const content = t.querySelector('.toast-content');
      return content && content.textContent.trim() === message.trim();
    });

    if (existing) {
      existing.classList.remove('pulse-shake');
      void existing.offsetWidth; // trigger reflow
      existing.classList.add('pulse-shake');
      if (existing._dismissTimer) clearTimeout(existing._dismissTimer);
      existing._dismissTimer = setTimeout(() => {
        existing.classList.remove('show');
        setTimeout(() => existing.remove(), 250);
      }, duration);
      return;
    }

    // 2. Limit Stack Size: Maximum 2 toasts at once
    const currentToasts = stack.querySelectorAll('.toast');
    if (currentToasts.length >= 2) {
      const oldest = currentToasts[0];
      if (oldest._dismissTimer) clearTimeout(oldest._dismissTimer);
      oldest.classList.remove('show');
      setTimeout(() => oldest.remove(), 150);
    }

    // 3. Create fresh toast
    const toast = document.createElement('div');
    toast.className = `toast toast-${type} press`;

    let iconSvg = '';
    if (type === 'success') {
      iconSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-emerald)" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
    } else if (type === 'error') {
      iconSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-rose)" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
    } else {
      iconSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-cyan)" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
    }

    toast.innerHTML = `
      <div class="toast-icon">${iconSvg}</div>
      <div class="toast-content">${message}</div>
      <button class="toast-close" title="Dismiss">&times;</button>
    `;

    const dismiss = () => {
      if (toast._dismissTimer) clearTimeout(toast._dismissTimer);
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 250);
    };

    toast.addEventListener('click', dismiss);

    stack.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));

    toast._dismissTimer = setTimeout(dismiss, duration);
  }
}

window.app = new App();
document.addEventListener('DOMContentLoaded', () => window.app.init());
