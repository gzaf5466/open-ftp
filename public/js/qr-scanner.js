/**
 * Mobile Camera QR Code Scanner Module
 * Provides camera viewfinder, BarcodeDetector API detection, torch toggle, and QR auto-lookup
 */

const QrScannerController = {
  stream: null,
  videoElement: null,
  scanning: false,
  barcodeDetector: null,
  scanTimer: null,
  hasTorch: false,
  torchActive: false,

  async init() {
    this.videoElement = document.getElementById('qr-scanner-video');
    this.bindEvents();

    if ('BarcodeDetector' in window) {
      try {
        const formats = await BarcodeDetector.getSupportedFormats();
        if (formats.includes('qr_code')) {
          this.barcodeDetector = new BarcodeDetector({ formats: ['qr_code'] });
        }
      } catch (e) {
        console.warn('BarcodeDetector initialization warning:', e);
      }
    }
  },

  bindEvents() {
    // Torch button
    const torchBtn = document.getElementById('btn-qr-scanner-torch');
    if (torchBtn) {
      torchBtn.addEventListener('click', () => this.toggleTorch());
    }

    // Modal Close
    const modalClose = document.querySelectorAll('[data-close-modal="modal-qr-scanner"]');
    modalClose.forEach(btn => {
      btn.addEventListener('click', () => this.stopScanner());
    });
  },

  async startScanner(onSuccessCallback) {
    this.onSuccess = onSuccessCallback;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      app.showToast('Camera access is not supported on this browser/device', 'error');
      return;
    }

    try {
      app.openModal('modal-qr-scanner');
      if (app.requestWakeLock) app.requestWakeLock();

      const constraints = {
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      };

      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
      if (this.videoElement) {
        this.videoElement.srcObject = this.stream;
        await this.videoElement.play();
      }

      // Check if torch is available
      const track = this.stream.getVideoTracks()[0];
      const capabilities = track.getCapabilities ? track.getCapabilities() : {};
      this.hasTorch = !!capabilities.torch;
      const torchBtn = document.getElementById('btn-qr-scanner-torch');
      if (torchBtn) {
        torchBtn.style.display = this.hasTorch ? 'inline-flex' : 'none';
      }

      this.scanning = true;
      this.runDetectionLoop();

    } catch (err) {
      console.error('Camera access error:', err);
      app.closeModal('modal-qr-scanner');
      if (app.releaseWakeLock) app.releaseWakeLock();
      app.showToast(err.name === 'NotAllowedError' ? 'Camera permission was denied' : 'Could not open camera', 'error');
    }
  },

  async runDetectionLoop() {
    if (!this.scanning) return;

    if (this.videoElement && this.videoElement.readyState >= 2) {
      try {
        let detectedText = null;

        if (this.barcodeDetector) {
          const barcodes = await this.barcodeDetector.detect(this.videoElement);
          if (barcodes && barcodes.length > 0) {
            detectedText = barcodes[0].rawValue;
          }
        } else {
          // Canvas fallback or standard detection
          detectedText = await this.detectFromCanvas();
        }

        if (detectedText) {
          this.handleQrFound(detectedText);
          return;
        }
      } catch (e) {}
    }

    if (this.scanning) {
      this.scanTimer = requestAnimationFrame(() => this.runDetectionLoop());
    }
  },

  async detectFromCanvas() {
    // If native BarcodeDetector is not present, scan via lightweight canvas analysis
    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    }
    if (!this.videoElement || this.videoElement.videoWidth === 0) return null;

    this.canvas.width = this.videoElement.videoWidth;
    this.canvas.height = this.videoElement.videoHeight;
    this.ctx.drawImage(this.videoElement, 0, 0, this.canvas.width, this.canvas.height);

    // If BarcodeDetector is supported with canvas
    if ('BarcodeDetector' in window && !this.barcodeDetector) {
      try {
        this.barcodeDetector = new BarcodeDetector({ formats: ['qr_code'] });
        const codes = await this.barcodeDetector.detect(this.canvas);
        if (codes.length > 0) return codes[0].rawValue;
      } catch (e) {}
    }

    return null;
  },

  handleQrFound(rawText) {
    this.stopScanner();

    if (window.sounds) window.sounds.playSuccess();
    if ('vibrate' in navigator) navigator.vibrate([30, 50, 30]);

    // Parse PIN from URL (e.g., http://10.75.143.1:3300/r/123456 or #receive/123456 or 123456)
    let pin = '';
    const clean = rawText.trim();

    if (/^\d{6}$/.test(clean)) {
      pin = clean;
    } else {
      const match = clean.match(/\/r\/(\d{6})/i) || clean.match(/#receive\/(\d{6})/i) || clean.match(/(\d{6})/);
      if (match) {
        pin = match[1];
      }
    }

    if (pin && this.onSuccess) {
      this.onSuccess(pin);
    } else if (clean.startsWith('http://') || clean.startsWith('https://')) {
      window.location.href = clean;
    } else {
      app.showToast(`Scanned: ${clean}`, 'info');
    }
  },

  async toggleTorch() {
    if (!this.stream || !this.hasTorch) return;
    const track = this.stream.getVideoTracks()[0];
    try {
      this.torchActive = !this.torchActive;
      await track.applyConstraints({
        advanced: [{ torch: this.torchActive }]
      });
      const torchBtn = document.getElementById('btn-qr-scanner-torch');
      if (torchBtn) {
        torchBtn.classList.toggle('active', this.torchActive);
      }
    } catch (e) {
      console.warn('Torch toggle failed:', e);
    }
  },

  stopScanner() {
    this.scanning = false;
    if (this.scanTimer) {
      cancelAnimationFrame(this.scanTimer);
      this.scanTimer = null;
    }

    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }

    if (this.videoElement) {
      this.videoElement.srcObject = null;
    }

    this.torchActive = false;
    if (app.releaseWakeLock) app.releaseWakeLock();
    app.closeModal('modal-qr-scanner');
  }
};

window.QrScannerController = QrScannerController;
