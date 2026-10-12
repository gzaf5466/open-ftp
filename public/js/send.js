/**
 * Send Controller Module
 * Handles file selection, drag & drop, text snippets, 6-digit PIN creation, and live transfer tracking
 */

const SendController = {
  stagedFiles: [],
  activeTransfer: null,
  countdownInterval: null,
  currentTab: 'files', // 'files' | 'text'
  sendMode: 'p2p', // 'p2p' (zero server storage) | 'server' (LAN relay storage)
  isPaused: false,

  init() {
    this.bindEvents();
    this.setupWsListeners();
  },

  setupWsListeners() {
    if (!window.wsClient) return;

    // Triggered when receiver joins our P2P 6-digit PIN room
    window.wsClient.on('p2p_peer_joined', async (data) => {
      app.showToast(`${data.receiverName || 'Recipient'} connected! Streaming pipe ready.`, 'success');
      try {
        window.p2pEngine.currentPin = data.pin;
        window.p2pEngine.stagedFiles = this.stagedFiles;
        if (data.conn) {
          window.p2pEngine.attachConnection(data.conn);
        }
        if (this.stagedFiles && this.stagedFiles.length > 0) {
          window.p2pEngine.currentFile = this.stagedFiles[0];
          await window.p2pEngine.sendFile(this.stagedFiles[0], {
            onProgress: (p) => {
              const progressBar = document.getElementById('transfer-progress-fill');
              const progressPercent = document.getElementById('transfer-progress-percent');
              const progressSpeed = document.getElementById('transfer-progress-speed');
              if (progressBar) progressBar.style.width = `${p.percent}%`;
              if (progressPercent) progressPercent.textContent = `${p.percent}%`;
              if (progressSpeed) {
                const speedMb = (p.speedBps / (1024 * 1024)).toFixed(1);
                progressSpeed.textContent = `${speedMb} MB/s`;
              }
            },
            onComplete: () => {
              if (window.sounds) window.sounds.playSuccess();
              app.showToast(`P2P File "${this.stagedFiles[0].name}" sent successfully!`, 'success');
            }
          });
        }
      } catch (err) {
        console.error('P2P stream setup failed:', err);
      }
    });

    window.p2pEngine.on('resumed', (data) => {
      const badge = document.getElementById('send-progress-resumed-badge');
      if (badge) {
        badge.style.display = 'inline-flex';
        badge.textContent = `⚡ Resumed from ${SendController.formatBytes(data.offset)}`;
      }
      app.showToast(`Transfer resumed without losing progress!`, 'success');
    });
  },

  async startP2PStreaming() {
    if (!this.stagedFiles || this.stagedFiles.length === 0) return;
    for (const file of this.stagedFiles) {
      app.showToast(`P2P Pipe established! Streaming "${file.name}" direct to peer...`, 'info');
      try {
        await window.p2pEngine.sendFile(file, {
          onProgress: (p) => {
            const progressBar = document.getElementById('transfer-progress-fill');
            const progressPercent = document.getElementById('transfer-progress-percent');
            const progressSpeed = document.getElementById('transfer-progress-speed');
            if (progressBar) progressBar.style.width = `${p.percent}%`;
            if (progressPercent) progressPercent.textContent = `${p.percent}%`;
            if (progressSpeed) {
              const speedMb = (p.speedBps / (1024 * 1024)).toFixed(1);
              progressSpeed.textContent = `${speedMb} MB/s`;
            }
          },
          onComplete: () => {
            if (window.sounds) window.sounds.playSuccess();
            app.showToast(`P2P File "${file.name}" sent successfully!`, 'success');
          }
        });
      } catch (err) {
        console.error('P2P stream failed:', err);
        app.showToast(`P2P Streaming error: ${err.message}`, 'error');
      }
    }
  },

  bindEvents() {
    // Transfer Mode Selector (P2P vs Server)
    document.querySelectorAll('[data-transfer-mode]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.setTransferMode(btn.dataset.transferMode, false);
      });
    });

    // Pause / Resume Button
    const pauseBtn = document.getElementById('btn-pause-resume-send');
    if (pauseBtn) {
      pauseBtn.addEventListener('click', () => {
        if (!this.isPaused) {
          window.p2pEngine.pause();
          this.isPaused = true;
          pauseBtn.textContent = 'Resume';
          pauseBtn.className = 'btn btn-primary btn-sm';
          app.showToast('Transfer paused', 'info');
        } else {
          window.p2pEngine.resume();
          this.isPaused = false;
          pauseBtn.textContent = 'Pause';
          pauseBtn.className = 'btn btn-secondary btn-sm';
          app.showToast('Transfer resumed', 'success');
        }
      });
    }

    // Dropzone elements
    const dropzone = document.getElementById('send-dropzone');
    const fileInput = document.getElementById('send-file-input');
    const folderInput = document.getElementById('send-folder-input');
    const selectFilesBtn = document.getElementById('btn-select-files');
    const selectFolderBtn = document.getElementById('btn-select-folder');
    const cameraInput = document.getElementById('send-camera-input');
    const selectCameraBtn = document.getElementById('btn-select-camera');

    // Drag & drop handlers
    if (dropzone) {
      ['dragenter', 'dragover'].forEach(eventName => {
        dropzone.addEventListener(eventName, (e) => {
          e.preventDefault();
          e.stopPropagation();
          dropzone.classList.add('drag-over');
        });
      });

      ['dragleave', 'drop'].forEach(eventName => {
        dropzone.addEventListener(eventName, (e) => {
          e.preventDefault();
          e.stopPropagation();
          dropzone.classList.remove('drag-over');
        });
      });

      dropzone.addEventListener('drop', (e) => {
        const files = e.dataTransfer.files;
        if (files && files.length > 0) {
          this.addFiles(files);
        }
      });

      dropzone.addEventListener('click', (e) => {
        if (e.target.closest('#btn-select-folder') || e.target.closest('#btn-select-camera')) return;
        fileInput.click();
      });
    }

    if (fileInput) {
      fileInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files.length > 0) {
          this.addFiles(e.target.files);
          fileInput.value = '';
        }
      });
    }

    if (selectCameraBtn && cameraInput) {
      selectCameraBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        cameraInput.click();
      });
      cameraInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files.length > 0) {
          this.addFiles(e.target.files);
          cameraInput.value = '';
        }
      });
    }

    if (selectFolderBtn && folderInput) {
      selectFolderBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        folderInput.click();
      });
      folderInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files.length > 0) {
          this.addFiles(e.target.files);
          folderInput.value = '';
        }
      });
    }

    // Subtab switching (Files vs Text)
    document.querySelectorAll('[data-send-subtab]').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.sendSubtab;
        this.switchSubtab(target);
      });
    });

    // Start Send Button
    const sendSubmitBtn = document.getElementById('btn-execute-send');
    if (sendSubmitBtn) {
      sendSubmitBtn.addEventListener('click', () => this.handleSendSubmit());
    }

    // Cancel Active Transfer
    const cancelTransferBtn = document.getElementById('btn-cancel-transfer');
    if (cancelTransferBtn) {
      cancelTransferBtn.addEventListener('click', () => this.cancelActiveTransfer());
    }

    // Copy PIN Button
    const copyPinBtn = document.getElementById('btn-copy-pin');
    if (copyPinBtn) {
      copyPinBtn.addEventListener('click', () => this.copyActivePin());
    }

    // View QR Button
    const viewQrBtn = document.getElementById('btn-view-qr');
    if (viewQrBtn) {
      viewQrBtn.addEventListener('click', () => this.showQrModal());
    }

    // Copy Link Button
    const copyLinkBtn = document.getElementById('btn-copy-share-link');
    if (copyLinkBtn) {
      copyLinkBtn.addEventListener('click', () => this.copyShareLink());
    }

    // New Transfer Button
    const newTransferBtn = document.getElementById('btn-new-send');
    if (newTransferBtn) {
      newTransferBtn.addEventListener('click', () => this.resetSendView());
    }
  },

  switchSubtab(tab) {
    this.currentTab = tab;
    document.querySelectorAll('[data-send-subtab]').forEach(b => {
      b.classList.toggle('active', b.dataset.sendSubtab === tab);
    });

    const filesPanel = document.getElementById('send-files-panel');
    const textPanel = document.getElementById('send-text-panel');
    if (filesPanel && textPanel) {
      filesPanel.style.display = tab === 'files' ? 'block' : 'none';
      textPanel.style.display = tab === 'text' ? 'block' : 'none';
    }
  },

  addFiles(fileList) {
    Array.from(fileList).forEach(file => {
      // Prevent exact duplicates in staging
      const exists = this.stagedFiles.some(f => f.name === file.name && f.size === file.size);
      if (!exists) {
        this.stagedFiles.push(file);
      }
    });

    if (window.sounds) window.sounds.playPop();
    this.renderStagedFiles();
  },

  removeFile(index) {
    this.stagedFiles.splice(index, 1);
    this.renderStagedFiles();
  },

  setTransferMode(mode, isAuto = false) {
    this.sendMode = mode;
    this.manualModeOverride = !isAuto;

    document.querySelectorAll('[data-transfer-mode]').forEach(b => {
      b.classList.toggle('active', b.dataset.transferMode === mode);
    });

    const autoBadge = document.getElementById('transfer-mode-auto-badge');
    if (autoBadge) {
      if (isAuto) {
        autoBadge.style.display = 'inline-flex';
        autoBadge.textContent = mode === 'p2p' ? '⚡ Auto: P2P (>50 MB)' : '📦 Auto: Server (<50 MB)';
      } else {
        autoBadge.style.display = 'none';
      }
    }
  },

  clearStagedFiles() {
    this.stagedFiles = [];
    this.manualModeOverride = false;
    this.renderStagedFiles();
  },

  renderStagedFiles() {
    const stagingCard = document.getElementById('send-staging-card');
    const listEl = document.getElementById('staged-files-list');
    const countEl = document.getElementById('staged-files-count');
    const totalSizeEl = document.getElementById('staged-files-total-size');
    const sendBtn = document.getElementById('btn-execute-send');

    if (!stagingCard || !listEl) return;

    if (this.stagedFiles.length === 0) {
      stagingCard.style.display = 'none';
      if (sendBtn && this.currentTab === 'files') sendBtn.disabled = true;
      const autoBadge = document.getElementById('transfer-mode-auto-badge');
      if (autoBadge) autoBadge.style.display = 'none';
      return;
    }

    stagingCard.style.display = 'block';
    if (sendBtn) sendBtn.disabled = false;

    let totalBytes = 0;
    listEl.innerHTML = '';

    this.stagedFiles.forEach((file, idx) => {
      totalBytes += file.size;
      const category = this.getFileCategory(file.name, file.type);
      const icon = this.getCategoryIcon(category);

      const item = document.createElement('div');
      item.className = 'staged-file-item';
      item.innerHTML = `
        <div class="staged-file-left">
          <div class="file-icon-box ${category}">${icon}</div>
          <div class="staged-file-meta">
            <div class="staged-file-name" title="${file.name}">${file.name}</div>
            <div class="staged-file-size">${this.formatBytes(file.size)}</div>
          </div>
        </div>
        <button class="staged-file-remove" title="Remove file" onclick="SendController.removeFile(${idx})">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      `;
      listEl.appendChild(item);
    });

    if (countEl) countEl.textContent = `${this.stagedFiles.length} file${this.stagedFiles.length > 1 ? 's' : ''}`;
    if (totalSizeEl) totalSizeEl.textContent = this.formatBytes(totalBytes);

    // Headless P2P Mode (Always direct browser-to-browser)
    this.setTransferMode('p2p', true);
  },

  async handleSendSubmit() {
    const expirySelect = document.getElementById('send-expiry-select');
    const expirySeconds = expirySelect ? parseInt(expirySelect.value) : 600;
    const customDeviceName = localStorage.getItem('custom_device_name') || '';

    const progressCard = document.getElementById('send-progress-card');
    const progressBar = document.getElementById('send-progress-bar');
    const progressPercent = document.getElementById('send-progress-percent');
    const progressSpeed = document.getElementById('send-progress-speed');
    const sendFormCard = document.getElementById('send-form-card');

    try {
      if (this.currentTab === 'files') {
        if (this.stagedFiles.length === 0) {
          app.showToast('Please select at least one file to send', 'error');
          return;
        }

        // P2P DIRECT MODE: Zero server storage, streaming directly to recipient disk
        if (this.sendMode === 'p2p') {
          const pin = Math.floor(100000 + Math.random() * 900000).toString();
          const totalBytes = this.stagedFiles.reduce((sum, f) => sum + f.size, 0);
          const manifest = this.stagedFiles.map(f => ({
            name: f.name,
            size: f.size,
            type: f.type,
            formattedSize: this.formatBytes(f.size)
          }));

          // Register P2P room with WebSocket server
          window.wsClient.send({
            type: 'register_p2p_room',
            pin: pin,
            filesMeta: manifest,
            expirySeconds: expirySeconds
          });

          const p2pTransfer = {
            key: pin,
            type: 'files',
            isP2P: true,
            fileCount: this.stagedFiles.length,
            totalSize: totalBytes,
            formattedTotalSize: this.formatBytes(totalBytes),
            expiresAt: Date.now() + (expirySeconds * 1000)
          };

          this.displayActiveTransfer(p2pTransfer);
          return;
        }

        // SERVER RELAY MODE: Upload to local server storage
        if (sendFormCard) sendFormCard.style.display = 'none';
        if (progressCard) progressCard.style.display = 'block';
        if (app.requestWakeLock) app.requestWakeLock();

        const result = await API.sendFiles(this.stagedFiles, {
          expiry: expirySeconds,
          deviceName: customDeviceName
        }, (p) => {
          if (progressBar) progressBar.style.width = `${p.percent}%`;
          if (progressPercent) progressPercent.textContent = `${p.percent}%`;
          if (progressSpeed) {
            const speedMb = (p.speedBps / (1024 * 1024)).toFixed(1);
            progressSpeed.textContent = `${speedMb} MB/s`;
          }
        });

        if (app.releaseWakeLock) app.releaseWakeLock();

        if (result.success && result.transfer) {
          this.displayActiveTransfer(result.transfer);
        }

      } else {
        // Text Snippet transfer (Headless P2P)
        const textInput = document.getElementById('send-text-input');
        const titleInput = document.getElementById('send-text-title');
        const content = textInput ? textInput.value.trim() : '';

        if (!content) {
          app.showToast('Please enter some text to send', 'error');
          return;
        }

        const pin = Math.floor(100000 + Math.random() * 900000).toString();
        const snippetTitle = (titleInput && titleInput.value.trim()) ? titleInput.value.trim() : 'Clipboard Snippet';

        window.wsClient.send({
          type: 'register_p2p_room',
          pin: pin,
          filesMeta: [{
            name: `${snippetTitle}.txt`,
            size: new Blob([content]).size,
            type: 'text/plain',
            text: content
          }],
          expirySeconds: expirySeconds
        });

        const p2pTransfer = {
          key: pin,
          type: 'text',
          text: content,
          title: snippetTitle,
          isP2P: true,
          expiresAt: Date.now() + (expirySeconds * 1000)
        };

        this.displayActiveTransfer(p2pTransfer);
      }

    } catch (err) {
      if (app.releaseWakeLock) app.releaseWakeLock();
      console.error('Send error:', err);
      app.showToast(err.message || 'Failed to create transfer', 'error');
      if (sendFormCard) sendFormCard.style.display = 'block';
      if (progressCard) progressCard.style.display = 'none';
    }
  },

  async startP2PStreaming() {
    const sendFormCard = document.getElementById('send-form-card');
    const activeCard = document.getElementById('send-active-card');
    const progressCard = document.getElementById('send-progress-card');
    const progressBar = document.getElementById('send-progress-bar');
    const progressPercent = document.getElementById('send-progress-percent');
    const progressSpeed = document.getElementById('send-progress-speed');

    if (sendFormCard) sendFormCard.style.display = 'none';
    if (activeCard) activeCard.style.display = 'none';
    if (progressCard) progressCard.style.display = 'block';
    if (app.requestWakeLock) app.requestWakeLock();

    for (const file of this.stagedFiles) {
      try {
        await window.p2pEngine.sendFile(file, {
          onProgress: (p) => {
            if (progressBar) progressBar.style.width = `${p.percent}%`;
            if (progressPercent) progressPercent.textContent = `${p.percent}%`;
            if (progressSpeed) {
              const speedMb = (p.speedBps / (1024 * 1024)).toFixed(1);
              progressSpeed.textContent = `${speedMb} MB/s`;
            }
          },
          onComplete: () => {
            if (window.sounds) window.sounds.playSuccess();
            app.showToast(`P2P streamed "${file.name}" to peer!`, 'success');
          }
        });
      } catch (err) {
        console.error('P2P stream failed:', err);
        app.showToast(`P2P transfer error: ${err.message}`, 'error');
      }
    }

    if (app.releaseWakeLock) app.releaseWakeLock();
  },

  displayActiveTransfer(transfer) {
    this.activeTransfer = transfer;
    if (window.sounds) window.sounds.playSuccess();

    const sendFormCard = document.getElementById('send-form-card');
    const progressCard = document.getElementById('send-progress-card');
    const activeCard = document.getElementById('send-active-card');

    if (sendFormCard) sendFormCard.style.display = 'none';
    if (progressCard) progressCard.style.display = 'none';
    if (activeCard) activeCard.style.display = 'block';

    // Render 6-digit PIN pills
    const pinContainer = document.getElementById('active-pin-display');
    if (pinContainer) {
      pinContainer.innerHTML = '';
      const pinStr = String(transfer.key);
      for (let i = 0; i < pinStr.length; i++) {
        const pill = document.createElement('div');
        pill.className = 'pin-char-pill';
        pill.textContent = pinStr[i];
        pinContainer.appendChild(pill);
      }
    }

    // Set Share Links
    const baseUrl = window.location.href.split('#')[0].split('?')[0].replace(/\/+$/, '');
    const senderId = window.wsClient && window.wsClient.ownClient ? window.wsClient.ownClient.id : '';
    const shareUrl = `${baseUrl}#receive/${transfer.key}${senderId ? `?s=${senderId}` : ''}`;
    const shareLinkEl = document.getElementById('active-share-link-text');
    if (shareLinkEl) shareLinkEl.textContent = shareUrl;

    // Start Expiry Countdown
    this.startCountdown(transfer.expiresAt);

    // Broadcast or announce
    app.showToast(`Transfer ready! Key: ${transfer.key}`, 'success');
  },

  startCountdown(expiresAt) {
    if (this.countdownInterval) clearInterval(this.countdownInterval);

    const countdownEl = document.getElementById('active-countdown-timer');

    const updateTimer = () => {
      const remainingMs = expiresAt - Date.now();
      if (remainingMs <= 0) {
        clearInterval(this.countdownInterval);
        if (countdownEl) {
          countdownEl.textContent = 'Expired';
          countdownEl.classList.add('warning');
        }
        app.showToast('Transfer session has expired', 'info');
        return;
      }

      const totalSeconds = Math.floor(remainingMs / 1000);
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      const formatted = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

      if (countdownEl) {
        countdownEl.textContent = `Valid for: ${formatted}`;
        if (totalSeconds < 60) {
          countdownEl.classList.add('warning');
        } else {
          countdownEl.classList.remove('warning');
        }
      }
    };

    updateTimer();
    this.countdownInterval = setInterval(updateTimer, 1000);
  },

  copyActivePin() {
    if (!this.activeTransfer) return;
    navigator.clipboard.writeText(this.activeTransfer.key).then(() => {
      if (window.sounds) window.sounds.playPop();
      app.showToast(`6-Digit Key ${this.activeTransfer.key} copied to clipboard!`, 'success');
    });
  },

  copyShareLink() {
    if (!this.activeTransfer) return;
    const shareLinkEl = document.getElementById('active-share-link-text');
    const url = shareLinkEl ? shareLinkEl.textContent : '';
    if (url) {
      navigator.clipboard.writeText(url).then(() => {
        if (window.sounds) window.sounds.playPop();
        app.showToast('Direct download link copied!', 'success');
      });
    }
  },

  async showQrModal() {
    if (!this.activeTransfer) return;
    const baseUrl = window.location.href.split('#')[0].split('?')[0].replace(/\/+$/, '');
    const senderId = window.wsClient && window.wsClient.ownClient ? window.wsClient.ownClient.id : '';
    const shareUrl = `${baseUrl}#receive/${this.activeTransfer.key}${senderId ? `?s=${senderId}` : ''}`;

    try {
      const qrData = await API.getQrCode(shareUrl, 280);
      const modalImg = document.getElementById('qr-modal-img');
      const modalText = document.getElementById('qr-modal-key-text');

      const src = qrData ? (qrData.qrDataUrl || qrData.url || qrData) : '';
      if (modalImg) modalImg.src = src;
      if (modalText) modalText.textContent = `Key: ${this.activeTransfer.key}`;

      app.openModal('modal-qr-view');
    } catch (e) {
      app.showToast('Failed to generate QR code', 'error');
    }
  },

  async cancelActiveTransfer() {
    if (!this.activeTransfer) return;
    try {
      await API.deleteTransfer(this.activeTransfer.key);
      app.showToast('Transfer session cancelled', 'info');
      this.resetSendView();
    } catch (e) {
      this.resetSendView();
    }
  },

  resetSendView() {
    if (this.countdownInterval) clearInterval(this.countdownInterval);
    this.activeTransfer = null;
    this.stagedFiles = [];

    const sendFormCard = document.getElementById('send-form-card');
    const progressCard = document.getElementById('send-progress-card');
    const activeCard = document.getElementById('send-active-card');
    const textInput = document.getElementById('send-text-input');

    if (sendFormCard) sendFormCard.style.display = 'block';
    if (progressCard) progressCard.style.display = 'none';
    if (activeCard) activeCard.style.display = 'none';
    if (textInput) textInput.value = '';

    this.renderStagedFiles();
  },

  // Helpers
  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  },

  getFileCategory(name, type) {
    const ext = name.split('.').pop().toLowerCase();
    if (type.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp'].includes(ext)) return 'image';
    if (type.startsWith('video/') || ['mp4', 'mkv', 'avi', 'mov', 'webm'].includes(ext)) return 'video';
    if (type.startsWith('audio/') || ['mp3', 'wav', 'flac', 'ogg', 'm4a'].includes(ext)) return 'audio';
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 'archive';
    if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'txt'].includes(ext)) return 'document';
    if (['js', 'html', 'css', 'json', 'py', 'java', 'c', 'cpp'].includes(ext)) return 'code';
    return 'document';
  },

  getCategoryIcon(category) {
    switch (category) {
      case 'image': return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';
      case 'video': return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>';
      case 'audio': return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
      case 'archive': return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><line x1="10" y1="12" x2="14" y2="12"/></svg>';
      case 'code': return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>';
      default: return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
    }
  }
};

window.SendController = SendController;
