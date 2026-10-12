/**
 * Receive Controller Module
 * Handles 6-digit PIN inputs, clipboard paste split, auto-fetching, and downloading transfers
 */

const ReceiveController = {
  currentTransfer: null,
  isP2P: false,
  isPaused: false,

  init() {
    this.bindPinInputs();
    this.bindButtons();
    this.setupP2PListeners();
  },

  bindPinInputs() {
    const pinBoxes = document.querySelectorAll('.pin-digit-box');
    if (!pinBoxes || pinBoxes.length === 0) return;

    pinBoxes.forEach((box, idx) => {
      // Input event (digit entered)
      box.addEventListener('input', () => {
        const val = box.value.replace(/[^0-9]/g, '');
        box.value = val ? val[val.length - 1] : '';

        if (box.value) {
          box.classList.add('filled');
          if (idx < pinBoxes.length - 1) {
            pinBoxes[idx + 1].focus();
          }
        } else {
          box.classList.remove('filled');
        }

        // If all 6 digits entered, auto-submit
        const fullPin = this.getEnteredPin();
        if (fullPin.length === 6) {
          this.handlePinSubmit();
        }
      });

      // Keydown: Backspace, Arrows, Enter
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace') {
          if (!box.value && idx > 0) {
            pinBoxes[idx - 1].focus();
            pinBoxes[idx - 1].value = '';
            pinBoxes[idx - 1].classList.remove('filled');
          } else {
            box.value = '';
            box.classList.remove('filled');
          }
        } else if (e.key === 'ArrowLeft' && idx > 0) {
          pinBoxes[idx - 1].focus();
        } else if (e.key === 'ArrowRight' && idx < pinBoxes.length - 1) {
          pinBoxes[idx + 1].focus();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          this.handlePinSubmit();
        }
      });

      // Paste support on any box
      box.addEventListener('paste', (e) => {
        e.preventDefault();
        const clipboardText = (e.clipboardData || window.clipboardData).getData('text') || '';
        const digits = clipboardText.trim().replace(/[^0-9]/g, '');
        if (digits) {
          this.fillPin(digits);
          if (digits.length >= 6) {
            this.handlePinSubmit();
          }
        }
      });

      box.addEventListener('focus', () => {
        box.select();
      });
    });
  },

  setupP2PListeners() {
    if (!window.wsClient) return;

    // WebSocket signals for P2P Rooms
    window.wsClient.on('p2p_room_joined', (data) => {
      if (this.p2pLookupTimeout) {
        clearTimeout(this.p2pLookupTimeout);
        this.p2pLookupTimeout = null;
      }
      this.isP2P = true;
      const totalBytes = (data.filesMeta || []).reduce((sum, f) => sum + f.size, 0);

      const p2pTransfer = {
        key: data.pin,
        type: 'files',
        isP2P: true,
        fileCount: (data.filesMeta || []).length,
        totalSize: totalBytes,
        formattedTotalSize: SendController.formatBytes(totalBytes),
        senderInfo: { deviceName: data.senderName, ip: 'P2P Direct Pipe' },
        files: data.filesMeta.map((f, i) => ({
          id: 'p2p_f_' + i,
          originalName: f.name,
          size: f.size,
          formattedSize: f.formattedSize || SendController.formatBytes(f.size),
          category: SendController.getFileCategory(f.name, f.type || '')
        }))
      };

      this.renderTransferDetails(p2pTransfer);
      app.showToast('P2P Direct Pipe matched! Ready to stream to disk.', 'success');
    });

    window.wsClient.on('p2p_room_error', async (data) => {
      if (this.p2pLookupTimeout) {
        clearTimeout(this.p2pLookupTimeout);
        this.p2pLookupTimeout = null;
      }
      // Not a P2P room, fallback to standard Server transfer lookup
      if (this.pendingLookupPin && !this.currentTransfer) {
        const pinToFetch = this.pendingLookupPin;
        this.pendingLookupPin = null;
        await this.fetchServerTransferByKey(pinToFetch);
      }
    });

    // P2P Engine Live Progress
    window.p2pEngine.on('progress', (p) => {
      const p2pContainer = document.getElementById('receive-p2p-stream-container');
      const progressBar = document.getElementById('receive-p2p-progress-bar');
      const progressPercent = document.getElementById('receive-p2p-progress-percent');
      const progressSpeed = document.getElementById('receive-p2p-progress-speed');

      if (p2pContainer) p2pContainer.style.display = 'block';
      if (progressBar) progressBar.style.width = `${p.percent}%`;
      if (progressPercent) progressPercent.textContent = `${p.percent}%`;
      if (progressSpeed) {
        const speedMb = (p.speedBps / (1024 * 1024)).toFixed(1);
        progressSpeed.textContent = `${speedMb} MB/s`;
      }
    });

    window.p2pEngine.on('resumed', (data) => {
      const badge = document.getElementById('receive-p2p-resumed-badge');
      if (badge) {
        badge.style.display = 'inline-flex';
        badge.textContent = `⚡ Resumed from ${SendController.formatBytes(data.offset)}`;
      }
      app.showToast(`Transfer resumed without losing progress!`, 'success');
    });

    window.p2pEngine.on('file_downloaded', (info) => {
      if (window.sounds) window.sounds.playSuccess();
      app.showToast(`File "${info.name}" successfully streamed to disk!`, 'success');
      const p2pContainer = document.getElementById('receive-p2p-stream-container');
      if (p2pContainer) {
        const progressPercent = document.getElementById('receive-p2p-progress-percent');
        if (progressPercent) progressPercent.textContent = '100% Completed';
      }
    });
  },

  bindButtons() {
    const submitBtn = document.getElementById('btn-lookup-pin');
    if (submitBtn) {
      submitBtn.addEventListener('click', () => this.handlePinSubmit());
    }

    const pasteBtn = document.getElementById('btn-paste-pin');
    if (pasteBtn) {
      pasteBtn.addEventListener('click', () => this.handlePasteFromClipboard());
    }

    const scanQrBtn = document.getElementById('btn-scan-qr');
    if (scanQrBtn) {
      scanQrBtn.addEventListener('click', () => {
        if (window.QrScannerController) {
          window.QrScannerController.startScanner((scannedPin) => {
            this.fillPin(scannedPin);
            this.fetchTransferByKey(scannedPin);
          });
        }
      });
    }

    const downloadAllBtn = document.getElementById('btn-download-all-zip');
    if (downloadAllBtn) {
      downloadAllBtn.addEventListener('click', () => this.downloadAllZip());
    }

    const receiveAnotherBtn = document.getElementById('btn-receive-another');
    if (receiveAnotherBtn) {
      receiveAnotherBtn.addEventListener('click', () => this.resetReceiveView());
    }

    // Pause / Resume for P2P streaming
    const pauseBtn = document.getElementById('btn-pause-resume-receive');
    if (pauseBtn) {
      pauseBtn.addEventListener('click', () => {
        if (!this.isPaused) {
          window.p2pEngine.pause();
          this.isPaused = true;
          pauseBtn.textContent = 'Resume';
          pauseBtn.className = 'btn btn-primary btn-sm';
          app.showToast('P2P download paused', 'info');
        } else {
          window.p2pEngine.resume();
          this.isPaused = false;
          pauseBtn.textContent = 'Pause';
          pauseBtn.className = 'btn btn-secondary btn-sm';
          app.showToast('P2P download resumed', 'success');
        }
      });
    }
  },

  async handlePasteFromClipboard() {
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        const text = await navigator.clipboard.readText();
        const clean = text.trim().replace(/[^0-9]/g, '');
        if (clean) {
          this.fillPin(clean);
          if (window.sounds) window.sounds.playPop();
          if (clean.length >= 6) {
            this.handlePinSubmit();
          } else {
            app.showToast('Key pasted from clipboard', 'info');
          }
          return;
        }
      }
      app.showToast('No 6-digit key in clipboard', 'info');
    } catch (e) {
      app.showToast('Could not read clipboard. Please paste manually.', 'info');
    }
  },

  fillPin(pinString) {
    const pinBoxes = document.querySelectorAll('.pin-digit-box');
    const digits = pinString.slice(0, 6).split('');

    pinBoxes.forEach((box, idx) => {
      if (digits[idx]) {
        box.value = digits[idx];
        box.classList.add('filled');
      } else {
        box.value = '';
        box.classList.remove('filled');
      }
    });

    const nextIndex = Math.min(digits.length, pinBoxes.length - 1);
    if (pinBoxes[nextIndex]) pinBoxes[nextIndex].focus();
  },

  getEnteredPin() {
    const pinBoxes = document.querySelectorAll('.pin-digit-box');
    let pin = '';
    pinBoxes.forEach(box => { pin += box.value; });
    return pin;
  },

  async handlePinSubmit() {
    const pin = this.getEnteredPin();
    if (pin.length !== 6) {
      app.showToast('Please enter a 6-digit key', 'error');
      return;
    }

    await this.fetchTransferByKey(pin);
  },

  async fetchTransferByKey(pin) {
    const cleanPin = String(pin || '').trim();
    if (!cleanPin || cleanPin.length !== 6) {
      app.showToast('Please enter a valid 6-digit key', 'error');
      return;
    }

    this.pendingLookupPin = cleanPin;
    this.isP2P = false;

    if (this.p2pLookupTimeout) {
      clearTimeout(this.p2pLookupTimeout);
      this.p2pLookupTimeout = null;
    }

    // Headless P2P Room Join over mesh
    if (window.wsClient) {
      window.wsClient.send({ type: 'join_p2p_room', pin: cleanPin });
      app.showToast(`Looking for sender with key ${cleanPin}...`, 'info');

      this.p2pLookupTimeout = setTimeout(() => {
        if (!this.currentTransfer && this.pendingLookupPin === cleanPin) {
          app.showToast('Transfer key not found or sender offline. Please check the 6-digit PIN.', 'error');
          this.pendingLookupPin = null;
        }
      }, 7000);
    }
  },

  renderTransferDetails(transfer) {
    this.currentTransfer = transfer;
    if (window.sounds) window.sounds.playSuccess();

    const inputCard = document.getElementById('receive-input-card');
    const detailsCard = document.getElementById('receive-details-card');

    if (inputCard) inputCard.style.display = 'none';
    if (detailsCard) detailsCard.style.display = 'block';

    // Populate Sender Info
    const senderNameEl = document.getElementById('receive-sender-name');
    const senderIpEl = document.getElementById('receive-sender-ip');
    const transferMetaEl = document.getElementById('receive-transfer-meta');

    if (senderNameEl) senderNameEl.textContent = transfer.senderInfo.deviceName || 'Local Device';
    if (senderIpEl) senderIpEl.textContent = transfer.senderInfo.ip || 'LAN';
    if (transferMetaEl) {
      if (transfer.type === 'files') {
        transferMetaEl.textContent = `${transfer.fileCount} file${transfer.fileCount > 1 ? 's' : ''} • ${transfer.formattedTotalSize}`;
      } else {
        transferMetaEl.textContent = `Text Snippet • ${transfer.formattedTotalSize}`;
      }
    }

    // Populate Content (Files vs Text)
    const filesContainer = document.getElementById('receive-files-list-container');
    const textContainer = document.getElementById('receive-text-content-container');
    const downloadAllBtn = document.getElementById('btn-download-all-zip');

    if (transfer.type === 'text') {
      if (filesContainer) filesContainer.style.display = 'none';
      if (textContainer) textContainer.style.display = 'block';
      if (downloadAllBtn) downloadAllBtn.style.display = 'none';

      const textBody = document.getElementById('receive-text-body');
      if (textBody) textBody.textContent = transfer.text;

      const copyTextBtn = document.getElementById('btn-copy-received-text');
      if (copyTextBtn) {
        copyTextBtn.onclick = () => {
          navigator.clipboard.writeText(transfer.text).then(() => {
            if (window.sounds) window.sounds.playPop();
            app.showToast('Snippet copied to clipboard!', 'success');
          });
        };
      }
    } else {
      if (filesContainer) filesContainer.style.display = 'block';
      if (textContainer) textContainer.style.display = 'none';
      if (downloadAllBtn) downloadAllBtn.style.display = transfer.files.length > 1 ? 'inline-flex' : 'none';

      const tbody = document.getElementById('receive-files-tbody');
      if (tbody) {
        tbody.innerHTML = '';
        transfer.files.forEach((file, index) => {
          const row = document.createElement('tr');
          const categoryIcon = SendController.getCategoryIcon(file.category);
          row.innerHTML = `
            <td>
              <div class="vault-list-file-cell">
                <div class="file-icon-box ${file.category}">${categoryIcon}</div>
                <div>
                  <div style="font-weight: 600; color: var(--text-main);">${file.originalName}</div>
                  <div style="font-size: 0.75rem; color: var(--text-muted);">${file.formattedSize}</div>
                </div>
              </div>
            </td>
            <td style="text-align: right;">
              <div style="display: inline-flex; gap: 0.35rem;">
                <button type="button" class="btn btn-primary btn-sm btn-action-p2p-save">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  <span>Save to Disk</span>
                </button>
              </div>
            </td>
          `;

          if (isP2P) {
            const saveBtn = row.querySelector('.btn-action-p2p-save');
            if (saveBtn) {
              saveBtn.addEventListener('click', () => this.startP2PDiskStream(file));
            }
          } else {
            const turboBtn = row.querySelector('.btn-action-turbo-download');
            if (turboBtn) {
              turboBtn.addEventListener('click', () => this.startTurboChunkDownload(file));
            }
          }

          tbody.appendChild(row);
        });
      }
    }
  },

  async startP2PDiskStream(file) {
    if (!window.p2pEngine) return;

    try {
      const suggestedName = file.originalName || file.name || 'download';
      let resumeOffset = 0;

      // Check checkpoint
      const fileId = window.p2pEngine.generateFileId({ name: suggestedName, size: file.size });
      const checkpoint = await window.p2pEngine.getCheckpoint(fileId);
      if (checkpoint && checkpoint.bytesWritten > 0 && checkpoint.bytesWritten < file.size) {
        resumeOffset = checkpoint.bytesWritten;
      }

      // Prompt native Save File Picker (direct user activation!)
      if ('showSaveFilePicker' in window) {
        const handle = await window.showSaveFilePicker({ suggestedName: suggestedName });
        window.p2pEngine.fileWritableStream = await handle.createWritable({
          keepExistingData: resumeOffset > 0
        });
        if (resumeOffset > 0) {
          await window.p2pEngine.fileWritableStream.seek(resumeOffset);
        }
        window.p2pEngine.usingDiskStream = true;
      } else {
        window.p2pEngine.usingDiskStream = false;
      }

      // Show P2P progress view
      const p2pContainer = document.getElementById('receive-p2p-stream-container');
      const p2pFileName = document.getElementById('receive-p2p-file-name');
      if (p2pContainer) p2pContainer.style.display = 'block';
      if (p2pFileName) p2pFileName.textContent = `P2P Streaming "${suggestedName}" to disk...`;

      // Signal sender that receiver is ready
      if (window.p2pEngine.dataChannel && window.p2pEngine.dataChannel.readyState === 'open') {
        window.p2pEngine.dataChannel.send(JSON.stringify({
          type: 'READY_TO_RECEIVE',
          fileId: fileId,
          resumeOffset: resumeOffset
        }));
        app.showToast('Direct P2P pipe active! Streaming to disk...', 'success');
      } else {
        app.showToast('Waiting for peer data channel to open...', 'info');
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('P2P Save error:', err);
        app.showToast('Failed to start P2P stream: ' + err.message, 'error');
      }
    }
  },

  async startTurboChunkDownload(file) {
    try {
      const p2pContainer = document.getElementById('receive-p2p-stream-container');
      const progressBar = document.getElementById('receive-p2p-progress-bar');
      const progressPercent = document.getElementById('receive-p2p-progress-percent');
      const progressSpeed = document.getElementById('receive-p2p-progress-speed');
      const p2pFileName = document.getElementById('receive-p2p-file-name');

      if (p2pContainer) p2pContainer.style.display = 'block';
      if (p2pFileName) p2pFileName.textContent = `Turbo Downloading "${file.originalName}" in parallel chunks...`;

      let lastBytes = 0;
      let lastTime = Date.now();

      await window.API.downloadFileInTurboChunks(
        this.currentTransfer.key,
        file.id,
        file.originalName,
        file.size,
        (downloaded, total) => {
          const percent = Math.min(100, Math.round((downloaded / total) * 100));
          if (progressBar) progressBar.style.width = `${percent}%`;
          if (progressPercent) progressPercent.textContent = `${percent}%`;

          const now = Date.now();
          const diffSec = (now - lastTime) / 1000;
          if (diffSec >= 0.3) {
            const speedMb = (((downloaded - lastBytes) / diffSec) / (1024 * 1024)).toFixed(1);
            if (progressSpeed) progressSpeed.textContent = `${speedMb} MB/s`;
            lastTime = now;
            lastBytes = downloaded;
          }
        }
      );

      if (window.sounds) window.sounds.playSuccess();
      app.showToast(`Turbo Download completed: "${file.originalName}" saved directly to disk!`, 'success');
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('Turbo Download error:', err);
        app.showToast('Turbo download failed: ' + err.message, 'error');
      }
    }
  },

  downloadAllZip() {
    if (!this.currentTransfer || !this.currentTransfer.files) return;
    app.showToast('Starting P2P stream for files...', 'info');
    for (const file of this.currentTransfer.files) {
      this.startP2PDiskStream(file);
    }
  },

  resetReceiveView() {
    this.currentTransfer = null;
    const inputCard = document.getElementById('receive-input-card');
    const detailsCard = document.getElementById('receive-details-card');

    if (inputCard) inputCard.style.display = 'block';
    if (detailsCard) detailsCard.style.display = 'none';

    this.fillPin('');
    const firstBox = document.querySelector('.pin-digit-box');
    if (firstBox) firstBox.focus();
  }
};

window.ReceiveController = ReceiveController;
