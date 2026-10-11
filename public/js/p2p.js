/**
 * P2P WebRTC Transfer Engine
 * Direct browser-to-browser streaming via RTCDataChannel
 * - Zero server storage (bytes never touch backend disk)
 * - Zero frontend RAM bloat (streams directly to disk via File System Access API)
 * - Resumable checkpointing protocol (retry large files without losing progress)
 * - Flow control backpressure management (bufferedAmountLowThreshold)
 */

class P2PEngine {
  constructor() {
    this.peerConnection = null;
    this.dataChannel = null;
    this.targetPeerId = null;
    this.isInitiator = false;
    this.activeTransfer = null;
    this.db = null;

    this.CHUNK_SIZE = 64 * 1024; // 64 KB optimal WebRTC packet size
    this.MAX_BUFFER_AMOUNT = 4 * 1024 * 1024; // 4 MB flow control ceiling
    this.BUFFER_LOW_THRESHOLD = 512 * 1024; // 512 KB resume threshold

    this.transferState = {
      status: 'idle', // 'idle' | 'connecting' | 'transferring' | 'paused' | 'completed' | 'error'
      file: null,
      meta: null,
      bytesTransferred: 0,
      totalBytes: 0,
      resumedOffset: 0,
      speedBps: 0,
      etaSeconds: 0,
      startTime: 0,
      lastProgressTime: 0,
      lastBytesTransferred: 0
    };

    this.listeners = new Map();
    this.initDatabase();
    this.setupSignalingListener();
  }

  // --------------------------------------------------------------------------
  // IndexedDB Checkpoint Store (Lossless Resume)
  // --------------------------------------------------------------------------
  async initDatabase() {
    return new Promise((resolve) => {
      if (!window.indexedDB) {
        return resolve(null);
      }
      const request = indexedDB.open('SendAnywhere_P2P_Checkpoints', 1);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('checkpoints')) {
          db.createObjectStore('checkpoints', { keyPath: 'id' });
        }
      };
      request.onsuccess = (e) => {
        this.db = e.target.result;
        resolve(this.db);
      };
      request.onerror = () => resolve(null);
    });
  }

  generateFileId(file) {
    return `f_${file.name}_${file.size}_${file.lastModified || 0}`.replace(/[^a-zA-Z0-9_]/g, '_');
  }

  async saveCheckpoint(fileId, bytesWritten, totalSize, fileName) {
    if (!this.db) return;
    try {
      const tx = this.db.transaction('checkpoints', 'readwrite');
      const store = tx.objectStore('checkpoints');
      store.put({
        id: fileId,
        fileName: fileName,
        bytesWritten: bytesWritten,
        totalSize: totalSize,
        lastUpdated: Date.now()
      });
    } catch (e) {}
  }

  async getCheckpoint(fileId) {
    if (!this.db) return null;
    return new Promise((resolve) => {
      try {
        const tx = this.db.transaction('checkpoints', 'readonly');
        const store = tx.objectStore('checkpoints');
        const req = store.get(fileId);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch (e) {
        resolve(null);
      }
    });
  }

  async clearCheckpoint(fileId) {
    if (!this.db) return;
    try {
      const tx = this.db.transaction('checkpoints', 'readwrite');
      const store = tx.objectStore('checkpoints');
      store.delete(fileId);
    } catch (e) {}
  }

  async getAllCheckpoints() {
    if (!this.db) await this.initDatabase();
    if (!this.db) return [];
    return new Promise((resolve) => {
      try {
        const tx = this.db.transaction('checkpoints', 'readonly');
        const store = tx.objectStore('checkpoints');
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      } catch (e) {
        resolve([]);
      }
    });
  }

  // --------------------------------------------------------------------------
  // WebRTC PeerConnection Setup
  // --------------------------------------------------------------------------
  createPeerConnection(targetPeerId, isInitiator = false) {
    this.closeConnection();
    this.targetPeerId = targetPeerId;
    this.isInitiator = isInitiator;

    const config = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' }
      ]
    };

    this.peerConnection = new RTCPeerConnection(config);

    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate && window.wsClient) {
        window.wsClient.send({
          type: 'webrtc_signal',
          targetPeerId: this.targetPeerId,
          signal: { type: 'candidate', candidate: event.candidate }
        });
      }
    };

    this.peerConnection.onconnectionstatechange = () => {
      const state = this.peerConnection.connectionState;
      if (state === 'connected') {
        this.emit('connected', { peerId: this.targetPeerId });
      } else if (state === 'disconnected' || state === 'failed') {
        this.emit('disconnected', { peerId: this.targetPeerId });
      }
    };

    if (isInitiator) {
      // Create DataChannel with reliable ordering
      const dataChannel = this.peerConnection.createDataChannel('sendanywhere_p2p_channel', {
        ordered: true
      });
      this.setupDataChannel(dataChannel);
    } else {
      this.peerConnection.ondatachannel = (event) => {
        this.setupDataChannel(event.channel);
      };
    }

    return this.peerConnection;
  }

  setupDataChannel(channel) {
    this.dataChannel = channel;
    this.dataChannel.binaryType = 'arraybuffer';
    this.dataChannel.bufferedAmountLowThreshold = this.BUFFER_LOW_THRESHOLD;

    this.dataChannel.onopen = () => {
      this.emit('channel_open');
    };

    this.dataChannel.onclose = () => {
      this.emit('channel_close');
    };

    this.dataChannel.onerror = (err) => {
      console.warn('[P2P DataChannel Error]:', err);
      this.emit('error', err);
    };

    this.dataChannel.onmessage = (event) => {
      this.handleChannelMessage(event.data);
    };
  }

  // --------------------------------------------------------------------------
  // WebRTC Signaling via WebSocket
  // --------------------------------------------------------------------------
  setupSignalingListener() {
    if (!window.wsClient) return;

    window.wsClient.on('webrtc_signal', async (data) => {
      const { signal, fromPeerId } = data;
      if (!signal) return;

      if (signal.type === 'offer') {
        this.createPeerConnection(fromPeerId, false);
        await this.peerConnection.setRemoteDescription(new RTCSessionDescription(signal));
        const answer = await this.peerConnection.createAnswer();
        await this.peerConnection.setLocalDescription(answer);

        window.wsClient.send({
          type: 'webrtc_signal',
          targetPeerId: fromPeerId,
          signal: answer
        });
      } else if (signal.type === 'answer' && this.peerConnection) {
        await this.peerConnection.setRemoteDescription(new RTCSessionDescription(signal));
      } else if (signal.type === 'candidate' && this.peerConnection) {
        try {
          await this.peerConnection.addIceCandidate(new RTCIceCandidate(signal.candidate));
        } catch (e) {
          console.warn('[P2P] ICE Candidate error:', e);
        }
      }
    });
  }

  async initiateOffer(targetPeerId) {
    this.createPeerConnection(targetPeerId, true);
    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);

    window.wsClient.send({
      type: 'webrtc_signal',
      targetPeerId: targetPeerId,
      signal: offer
    });
  }

  // --------------------------------------------------------------------------
  // SENDER ENGINE: High-Speed File Slicing & Resumable Streaming
  // --------------------------------------------------------------------------
  async sendFile(file, { onProgress = null, onComplete = null, onError = null } = {}) {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      throw new Error('P2P DataChannel is not open');
    }

    this.currentFile = file;
    this.fileId = this.generateFileId(file);
    this.transferState.status = 'transferring';
    this.transferState.file = file;
    this.transferState.totalBytes = file.size;
    this.transferState.bytesTransferred = 0;
    this.transferState.startTime = Date.now();
    this.transferState.lastProgressTime = Date.now();
    this.transferState.lastBytesTransferred = 0;

    // Send metadata header
    const fileHeader = {
      type: 'FILE_HEADER',
      fileId: this.fileId,
      name: file.name,
      size: file.size,
      mimetype: file.type || 'application/octet-stream'
    };
    this.dataChannel.send(JSON.stringify(fileHeader));

    this.onProgressCb = onProgress;
    this.onCompleteCb = onComplete;
    this.onErrorCb = onError;
  }

  // Called when receiver responds with resume offset or ready signal
  async startStreamingFromOffset(startOffset = 0) {
    let offset = startOffset;
    const file = this.currentFile;
    if (!file) return;

    this.transferState.bytesTransferred = offset;
    this.transferState.resumedOffset = startOffset;

    const readAndSendChunk = () => {
      if (this.transferState.status === 'paused' || this.transferState.status === 'idle') {
        return;
      }

      while (offset < file.size) {
        // Backpressure check: if buffer is full, wait for bufferedamountlow event
        if (this.dataChannel.bufferedAmount > this.MAX_BUFFER_AMOUNT) {
          this.dataChannel.onbufferedamountlow = () => {
            this.dataChannel.onbufferedamountlow = null;
            readAndSendChunk();
          };
          return;
        }

        const nextOffset = Math.min(offset + this.CHUNK_SIZE, file.size);
        const slice = file.slice(offset, nextOffset);
        const reader = new FileReader();

        reader.onload = (e) => {
          if (!this.dataChannel || this.dataChannel.readyState !== 'open') return;

          try {
            this.dataChannel.send(e.target.result);
            offset = nextOffset;
            this.transferState.bytesTransferred = offset;
            this.reportProgress();

            if (offset >= file.size) {
              // Notify receiver that file stream is done
              this.dataChannel.send(JSON.stringify({ type: 'FILE_END', fileId: this.fileId }));
              this.transferState.status = 'completed';
              if (this.onCompleteCb) this.onCompleteCb({ fileId: this.fileId, fileName: file.name, size: file.size });
              this.emit('file_sent', { name: file.name, size: file.size });

              // Record in persistent activity logs
              try {
                if (window.API && window.API.recordTransferLog) {
                  window.API.recordTransferLog({
                    type: 'p2p_direct',
                    mode: 'p2p',
                    key: this.currentPin || '--',
                    files: [{ name: file.name, size: file.size }],
                    totalSize: file.size,
                    sender: { name: 'This Device (Sender)', ip: 'LAN' },
                    receiver: { name: this.targetPeerId ? `Peer (${this.targetPeerId.substring(0, 6)})` : 'P2P Receiver', ip: 'LAN' },
                    status: 'completed'
                  }).catch(() => {});
                }
              } catch (e) {}
            } else {
              // Continue chunking
              readAndSendChunk();
            }
          } catch (err) {
            console.error('Error sending P2P chunk:', err);
            this.transferState.status = 'error';
            if (this.onErrorCb) this.onErrorCb(err);
          }
        };

        reader.readAsArrayBuffer(slice);
        return;
      }
    };

    readAndSendChunk();
  }

  // --------------------------------------------------------------------------
  // RECEIVER ENGINE: Zero-RAM Disk Streaming & Checkpoint Tracker
  // --------------------------------------------------------------------------
  async handleChannelMessage(message) {
    if (typeof message === 'string') {
      try {
        const msg = JSON.parse(message);
        this.handleControlMessage(msg);
      } catch (e) {}
      return;
    }

    // Binary Chunk received (ArrayBuffer)
    if (message instanceof ArrayBuffer) {
      await this.handleReceivedChunk(message);
    }
  }

  async handleControlMessage(msg) {
    switch (msg.type) {
      case 'FILE_HEADER':
        this.incomingMeta = msg;
        this.receivedBytes = 0;
        this.receivedChunks = [];
        this.transferState.totalBytes = msg.size;
        this.transferState.bytesTransferred = 0;
        this.transferState.status = 'transferring';
        this.transferState.startTime = Date.now();
        this.transferState.lastProgressTime = Date.now();

        // Check for existing checkpoint (Resumable large file)
        const checkpoint = await this.getCheckpoint(msg.fileId);
        let resumeOffset = 0;

        if (checkpoint && checkpoint.bytesWritten > 0 && checkpoint.bytesWritten < msg.size) {
          resumeOffset = checkpoint.bytesWritten;
          this.receivedBytes = resumeOffset;
          this.transferState.bytesTransferred = resumeOffset;
          this.transferState.resumedOffset = resumeOffset;
          this.emit('resumed', { fileId: msg.fileId, offset: resumeOffset });
        }

        // If direct disk stream was already prepared by user click
        if (this.fileWritableStream) {
          this.dataChannel.send(JSON.stringify({
            type: 'READY_TO_RECEIVE',
            fileId: msg.fileId,
            resumeOffset: resumeOffset
          }));
        } else {
          // Signal receiver UI that incoming file is awaiting disk destination
          this.emit('awaiting_disk_destination', { meta: msg, resumeOffset: resumeOffset });
        }
        break;

      case 'READY_TO_RECEIVE':
        // Sender starts streaming from the requested offset
        this.startStreamingFromOffset(msg.resumeOffset || 0);
        break;

      case 'FILE_END':
        await this.finalizeReceivedFile();
        break;

      case 'PAUSE_TRANSFER':
        this.transferState.status = 'paused';
        this.emit('paused');
        break;

      case 'RESUME_TRANSFER':
        this.transferState.status = 'transferring';
        this.emit('resumed', { offset: this.transferState.bytesTransferred });
        if (this.isInitiator) {
          this.startStreamingFromOffset(this.transferState.bytesTransferred);
        }
        break;
    }
  }

  async prepareReceiverStorage(meta, resumeOffset) {
    // If supported, use File System Access API for ZERO memory usage
    if ('showSaveFilePicker' in window && !this.fileWritableStream) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: meta.name
        });
        this.fileWritableStream = await handle.createWritable({
          keepExistingData: resumeOffset > 0
        });
        if (resumeOffset > 0) {
          await this.fileWritableStream.seek(resumeOffset);
        }
        this.usingDiskStream = true;
      } catch (e) {
        // User cancelled picker or browser denied, fallback to in-memory streaming
        this.usingDiskStream = false;
      }
    } else {
      this.usingDiskStream = false;
    }
  }

  async handleReceivedChunk(chunk) {
    if (this.usingDiskStream && this.fileWritableStream) {
      // Direct disk write - zero frontend RAM footprint!
      await this.fileWritableStream.write(chunk);
    } else {
      // Memory chunk buffer fallback
      this.receivedChunks.push(chunk);
    }

    this.receivedBytes += chunk.byteLength;
    this.transferState.bytesTransferred = this.receivedBytes;

    // Periodically save checkpoint every 2 MB
    if (this.receivedBytes % (2 * 1024 * 1024) < chunk.byteLength && this.incomingMeta) {
      await this.saveCheckpoint(this.incomingMeta.fileId, this.receivedBytes, this.incomingMeta.size, this.incomingMeta.name);
    }

    this.reportProgress();
  }

  async finalizeReceivedFile() {
    this.transferState.status = 'completed';

    if (this.incomingMeta) {
      await this.clearCheckpoint(this.incomingMeta.fileId);
    }

    if (this.usingDiskStream && this.fileWritableStream) {
      await this.fileWritableStream.close();
      this.fileWritableStream = null;
      this.emit('file_downloaded', { name: this.incomingMeta.name, size: this.incomingMeta.size });
    } else {
      // Assemble Blob and trigger instant browser download
      const blob = new Blob(this.receivedChunks, { type: this.incomingMeta.mimetype });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = this.incomingMeta.name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
        a.remove();
      }, 2000);
      this.receivedChunks = [];
      this.emit('file_downloaded', { name: this.incomingMeta.name, size: this.incomingMeta.size });
    }

    // Record in persistent activity logs
    try {
      if (window.API && window.API.recordTransferLog && this.incomingMeta) {
        window.API.recordTransferLog({
          type: 'p2p_direct',
          mode: 'p2p',
          key: this.currentPin || '--',
          files: [{ name: this.incomingMeta.name, size: this.incomingMeta.size }],
          totalSize: this.incomingMeta.size,
          sender: { name: this.targetPeerId ? `Peer (${this.targetPeerId.substring(0, 6)})` : 'P2P Sender', ip: 'LAN' },
          receiver: { name: 'This Device (Receiver)', ip: 'LAN' },
          status: 'completed'
        }).catch(() => {});
      }
    } catch (e) {}
  }

  // --------------------------------------------------------------------------
  // Speed, Progress, & ETA Calculations
  // --------------------------------------------------------------------------
  reportProgress() {
    const now = Date.now();
    const timeDiff = (now - this.transferState.lastProgressTime) / 1000;

    if (timeDiff >= 0.25) {
      const bytesDiff = this.transferState.bytesTransferred - this.transferState.lastBytesTransferred;
      this.transferState.speedBps = bytesDiff / timeDiff;
      this.transferState.lastProgressTime = now;
      this.transferState.lastBytesTransferred = this.transferState.bytesTransferred;

      const remainingBytes = Math.max(0, this.transferState.totalBytes - this.transferState.bytesTransferred);
      this.transferState.etaSeconds = this.transferState.speedBps > 0 ? Math.round(remainingBytes / this.transferState.speedBps) : 0;
    }

    const percent = this.transferState.totalBytes > 0
      ? Math.min(100, Math.round((this.transferState.bytesTransferred / this.transferState.totalBytes) * 100))
      : 0;

    const totalChunks = Math.max(1, Math.ceil(this.transferState.totalBytes / (256 * 1024)));
    const currentChunk = Math.min(totalChunks, Math.floor(this.transferState.bytesTransferred / (256 * 1024)));

    const data = {
      percent: percent,
      loaded: this.transferState.bytesTransferred,
      total: this.transferState.totalBytes,
      speedBps: this.transferState.speedBps,
      etaSeconds: this.transferState.etaSeconds,
      resumedOffset: this.transferState.resumedOffset,
      currentChunk: currentChunk,
      totalChunks: totalChunks,
      bufferedAmount: this.dataChannel ? this.dataChannel.bufferedAmount : 0,
      iceState: this.peerConnection ? this.peerConnection.iceConnectionState : 'connected'
    };

    if (this.onProgressCb) this.onProgressCb(data);
    this.emit('progress', data);
  }

  pause() {
    this.transferState.status = 'paused';
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      this.dataChannel.send(JSON.stringify({ type: 'PAUSE_TRANSFER' }));
    }
    this.emit('paused');
  }

  resume() {
    this.transferState.status = 'transferring';
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      this.dataChannel.send(JSON.stringify({ type: 'RESUME_TRANSFER' }));
    }
    this.emit('resumed', { offset: this.transferState.bytesTransferred });
    if (this.isInitiator && this.currentFile) {
      this.startStreamingFromOffset(this.transferState.bytesTransferred);
    }
  }

  closeConnection() {
    if (this.dataChannel) {
      try { this.dataChannel.close(); } catch (e) {}
      this.dataChannel = null;
    }
    if (this.peerConnection) {
      try { this.peerConnection.close(); } catch (e) {}
      this.peerConnection = null;
    }
    if (this.fileWritableStream) {
      try { this.fileWritableStream.close(); } catch (e) {}
      this.fileWritableStream = null;
    }
    this.transferState.status = 'idle';
  }

  on(event, cb) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(cb);
  }

  emit(event, data) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).forEach(cb => {
        try { cb(data); } catch (e) { console.error(e); }
      });
    }
  }
}

window.p2pEngine = new P2PEngine();
