/**
 * API Client Module - High-Speed Turbo Streaming Engine
 * Direct binary socket piping, multi-connection concurrency, and hardware acceleration
 */

const API = {
  // Base request helper
  async request(url, options = {}) {
    try {
      const res = await fetch(url, options);
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || `HTTP error ${res.status}`);
      }
      return await res.json();
    } catch (err) {
      console.error(`API Error [${url}]:`, err.message);
      throw err;
    }
  },

  // --------------------------------------------------------------------------
  // System Info & QR
  // --------------------------------------------------------------------------
  async getServerInfo() {
    return this.request('/api/info');
  },

  async getQrCode(text, size = 260) {
    return this.request(`/api/qr?text=${encodeURIComponent(text)}&size=${size}`);
  },

  // --------------------------------------------------------------------------
  // High-Speed Turbo SendAnywhere Transfers
  // --------------------------------------------------------------------------
  async sendFiles(files, { expiry = 600, deviceName = '' } = {}, onProgress = null) {
    const fileArray = Array.from(files);
    const totalBytes = fileArray.reduce((sum, f) => sum + f.size, 0);

    // 1. Initialize Turbo transfer session on server
    const manifest = fileArray.map(f => ({ name: f.name, size: f.size, type: f.type }));
    const initRes = await this.request('/api/transfer/turbo-init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: manifest,
        expiry: expiry,
        deviceName: deviceName
      })
    });

    if (!initRes.success || !initRes.transfer) {
      throw new Error('Failed to initialize high-speed transfer');
    }

    const transfer = initRes.transfer;
    const key = transfer.key;

    // Track overall progress across all files
    const fileProgress = new Map();
    let lastTime = Date.now();
    let lastTotalLoaded = 0;

    const reportProgress = () => {
      let currentTotalLoaded = 0;
      for (const loaded of fileProgress.values()) {
        currentTotalLoaded += loaded;
      }

      const now = Date.now();
      const timeDiff = (now - lastTime) / 1000;
      let speedBps = 0;
      if (timeDiff > 0.1) {
        speedBps = (currentTotalLoaded - lastTotalLoaded) / timeDiff;
        lastTime = now;
        lastTotalLoaded = currentTotalLoaded;
      }

      const percent = totalBytes > 0 ? Math.min(100, Math.round((currentTotalLoaded / totalBytes) * 100)) : 100;
      if (onProgress) {
        onProgress({
          loaded: currentTotalLoaded,
          total: totalBytes,
          percent: percent,
          speedBps: speedBps
        });
      }
    };

    // 2. Stream files using direct binary pipe (adaptive concurrency: 2 for mobile, 4 for desktop)
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || (window.innerWidth <= 768);
    const maxConcurrency = isMobile ? 2 : 4;
    const concurrency = Math.min(maxConcurrency, fileArray.length);
    let currentIndex = 0;

    const uploadWorker = async () => {
      while (currentIndex < fileArray.length) {
        const index = currentIndex++;
        const file = fileArray[index];
        const fileMeta = transfer.files[index];

        await this.streamSingleFile(key, fileMeta.id, file, (loaded) => {
          fileProgress.set(fileMeta.id, loaded);
          reportProgress();
        });
        fileProgress.set(fileMeta.id, file.size);
        reportProgress();
      }
    };

    const workers = [];
    for (let i = 0; i < concurrency; i++) {
      workers.push(uploadWorker());
    }
    await Promise.all(workers);

    if (onProgress) {
      onProgress({ loaded: totalBytes, total: totalBytes, percent: 100, speedBps: 0 });
    }

    return { success: true, transfer: transfer };
  },

  // Check if server already has partial bytes for this file
  async getResumeStatus(key, fileId) {
    try {
      return await this.request(`/api/transfer/resume-status/${key}/${fileId}`);
    } catch (e) {
      return { uploadedBytes: 0, completed: false };
    }
  },

  // Stream a single file with random-access chunking & failsafe retries for massive 20GB+ files
  async streamSingleFile(key, fileId, fileBlob, onChunkProgress) {
    const status = await this.getResumeStatus(key, fileId);
    let startByte = 0;
    if (status && status.uploadedBytes > 0 && status.uploadedBytes < fileBlob.size) {
      startByte = status.uploadedBytes;
      if (onChunkProgress) onChunkProgress(startByte);
    } else if (status && status.completed) {
      if (onChunkProgress) onChunkProgress(fileBlob.size);
      return;
    }

    // For files smaller than 16 MB: upload as single stream with retry
    if (fileBlob.size <= 16 * 1024 * 1024) {
      return this.uploadSingleStreamWithRetry(key, fileId, fileBlob, startByte, onChunkProgress);
    }

    // FOR MASSIVE FILES (e.g. 18.5 GB / 20 GB): Chunked Pipeline with Failsafe Retries
    const CHUNK_SIZE = 16 * 1024 * 1024; // 16 MB chunks
    const totalChunks = Math.ceil(fileBlob.size / CHUNK_SIZE);
    const startChunkIdx = Math.floor(startByte / CHUNK_SIZE);
    let uploadedBytesTotal = startByte;

    // Adaptive concurrency: 2 parallel pipelines
    const concurrency = 2;
    let nextChunkIndex = startChunkIdx;

    const chunkWorker = async () => {
      while (nextChunkIndex < totalChunks) {
        const chunkIdx = nextChunkIndex++;
        const chunkStart = chunkIdx * CHUNK_SIZE;
        const chunkEnd = Math.min(chunkStart + CHUNK_SIZE, fileBlob.size);
        const chunkSlice = fileBlob.slice(chunkStart, chunkEnd);
        const isLast = chunkIdx === totalChunks - 1;

        // Failsafe auto-retry: up to 5 attempts per chunk
        let attempts = 5;
        let lastError = null;

        while (attempts > 0) {
          try {
            await this.uploadSingleChunk(key, fileId, chunkSlice, chunkStart, isLast);
            uploadedBytesTotal = Math.max(uploadedBytesTotal, chunkEnd);
            if (onChunkProgress) onChunkProgress(Math.min(fileBlob.size, uploadedBytesTotal));
            lastError = null;
            break; // Success!
          } catch (err) {
            attempts--;
            lastError = err;
            console.warn(`[Failsafe Chunk Retry] Chunk ${chunkIdx + 1}/${totalChunks} failed (${5 - attempts}/5). Retrying in 1s...`, err.message);
            await new Promise(r => setTimeout(r, 1000));
          }
        }

        if (lastError) {
          throw new Error(`Upload stalled at ${Math.round((chunkStart / fileBlob.size) * 100)}% after 5 retries: ${lastError.message}`);
        }
      }
    };

    const workers = [];
    for (let w = 0; w < concurrency; w++) {
      workers.push(chunkWorker());
    }
    await Promise.all(workers);
  },

  // Upload an individual random-access chunk with explicit header offsets
  async uploadSingleChunk(key, fileId, chunkBlob, offset, isLast) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `/api/transfer/turbo-chunk/${key}/${fileId}`, true);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('x-chunk-offset', offset.toString());
      xhr.setRequestHeader('x-chunk-size', chunkBlob.size.toString());
      if (isLast) {
        xhr.setRequestHeader('x-is-last-chunk', '1');
      }

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          reject(new Error(`Chunk upload error code: ${xhr.status}`));
        }
      };

      xhr.onerror = () => reject(new Error('Network error uploading chunk'));
      xhr.ontimeout = () => reject(new Error('Chunk upload timed out'));
      xhr.send(chunkBlob);
    });
  },

  // Single stream helper with auto-retry
  async uploadSingleStreamWithRetry(key, fileId, fileBlob, startByte, onChunkProgress) {
    let attempts = 3;
    while (attempts > 0) {
      try {
        const payload = startByte > 0 ? fileBlob.slice(startByte) : fileBlob;
        return await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('PUT', `/api/transfer/turbo-stream/${key}/${fileId}`, true);
          xhr.setRequestHeader('Content-Type', 'application/octet-stream');
          if (startByte > 0) xhr.setRequestHeader('x-start-byte', startByte.toString());

          xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable && onChunkProgress) onChunkProgress(startByte + e.loaded);
          });

          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) resolve();
            else reject(new Error(`Stream failed with code ${xhr.status}`));
          };
          xhr.onerror = () => reject(new Error('Network stream error'));
          xhr.send(payload);
        });
      } catch (err) {
        attempts--;
        if (attempts === 0) throw err;
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  },

  // IDM-Style Multi-Threaded Chunk Downloader with Direct-to-Disk Stream
  async downloadFileInTurboChunks(key, fileId, fileName, totalSize, onProgress) {
    if (!('showSaveFilePicker' in window)) {
      window.location.href = `/api/transfer/download-file/${key}/${fileId}`;
      return;
    }

    const handle = await window.showSaveFilePicker({ suggestedName: fileName });
    const writableStream = await handle.createWritable();

    const CHUNK_SIZE = 16 * 1024 * 1024; // 16 MB chunks
    const totalChunks = Math.ceil(totalSize / CHUNK_SIZE);
    let downloadedBytes = 0;
    let nextChunkIdx = 0;
    const concurrency = 3; // 3 concurrent pipelines

    const downloadWorker = async () => {
      while (nextChunkIdx < totalChunks) {
        const chunkIdx = nextChunkIdx++;
        const start = chunkIdx * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE - 1, totalSize - 1);

        let attempts = 5;
        let lastErr = null;

        while (attempts > 0) {
          try {
            const res = await fetch(`/api/transfer/download-file/${key}/${fileId}`, {
              headers: { 'Range': `bytes=${start}-${end}` }
            });
            if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
            const arrayBuffer = await res.arrayBuffer();

            // Direct random-access write to physical disk at exact byte offset!
            await writableStream.seek(start);
            await writableStream.write(arrayBuffer);

            downloadedBytes += arrayBuffer.byteLength;
            if (onProgress) onProgress(downloadedBytes, totalSize);
            lastErr = null;
            break;
          } catch (err) {
            attempts--;
            lastErr = err;
            await new Promise(r => setTimeout(r, 1000));
          }
        }

        if (lastErr) throw lastErr;
      }
    };

    const workers = [];
    for (let i = 0; i < concurrency; i++) workers.push(downloadWorker());
    await Promise.all(workers);

    await writableStream.close();
  },

  async sendText({ text, title = 'Clipboard Snippet', expiry = 600, deviceName = '' }) {
    return this.request('/api/transfer/send-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, title, expiry, deviceName })
    });
  },

  async lookupTransfer(pin) {
    const cleanPin = (pin || '').trim();
    return this.request(`/api/transfer/receive/${cleanPin}`);
  },

  async deleteTransfer(pin) {
    return this.request(`/api/transfer/${pin}`, { method: 'DELETE' });
  },

  // --------------------------------------------------------------------------
  // Vault & Shared Storage (Turbo Direct Stream)
  // --------------------------------------------------------------------------
  async listVault(subPath = '') {
    return this.request(`/api/vault/list?path=${encodeURIComponent(subPath)}`);
  },

  async uploadVault(files, targetPath = '', onProgress = null) {
    const fileArray = Array.from(files);
    const totalBytes = fileArray.reduce((sum, f) => sum + f.size, 0);
    let loadedBytes = 0;

    for (const file of fileArray) {
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', '/api/vault/turbo-upload', true);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
        xhr.setRequestHeader('x-target-path', encodeURIComponent(targetPath));

        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable && onProgress) {
            const currentTotal = loadedBytes + e.loaded;
            const percent = totalBytes > 0 ? Math.round((currentTotal / totalBytes) * 100) : 100;
            onProgress({ loaded: currentTotal, total: totalBytes, percent });
          }
        });

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            loadedBytes += file.size;
            resolve();
          } else {
            reject(new Error(`Upload failed for ${file.name}`));
          }
        };

        xhr.onerror = () => reject(new Error('Network error uploading to Vault'));
        xhr.send(file);
      });
    }

    return { success: true, count: fileArray.length };
  },

  async createVaultFolder(name, parentPath = '') {
    return this.request('/api/vault/folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, path: parentPath })
    });
  },

  async renameVaultItem(itemPath, newName) {
    return this.request('/api/vault/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: itemPath, newName })
    });
  },

  async deleteVaultItem(itemPath) {
    return this.request('/api/vault/item', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: itemPath })
    });
  },

  async getVaultStats() {
    return this.request('/api/vault/stats');
  },

  // --------------------------------------------------------------------------
  // FTP Server Controls
  // --------------------------------------------------------------------------
  async getFtpStatus() {
    return this.request('/api/ftp/status');
  },

  async toggleFtp() {
    return this.request('/api/ftp/toggle', { method: 'POST' });
  },

  // --------------------------------------------------------------------------
  // Activity & Transfer Logs
  // --------------------------------------------------------------------------
  async getTransferLogs(limit = 100, searchQuery = '') {
    const q = searchQuery ? `&q=${encodeURIComponent(searchQuery)}` : '';
    return this.request(`/api/logs?limit=${limit}${q}`);
  },

  async recordTransferLog(entry) {
    return this.request('/api/logs/record', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry)
    });
  },

  async clearTransferLogs() {
    return this.request('/api/logs', {
      method: 'DELETE'
    });
  }
};

window.API = API;
