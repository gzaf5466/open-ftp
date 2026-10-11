/**
 * WebSocket Real-Time Client Manager
 * Handles live peer discovery, transfer events, and direct 1-to-1 sends
 */

class WebSocketClient {
  constructor() {
    this.ws = null;
    this.ownClient = null;
    this.peers = [];
    this.listeners = new Map();
    this.reconnectTimeout = null;
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/ws`;

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log('[WS] Connected to real-time server');
        if (this.reconnectTimeout) {
          clearTimeout(this.reconnectTimeout);
          this.reconnectTimeout = null;
        }

        // Restore custom device name if saved
        const savedName = localStorage.getItem('custom_device_name');
        if (savedName) {
          this.setDeviceName(savedName);
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          this.handleMessage(msg);
        } catch (e) {
          console.error('[WS] Parse error:', e);
        }
      };

      this.ws.onclose = () => {
        console.warn('[WS] Disconnected, scheduling reconnect...');
        this.reconnectTimeout = setTimeout(() => this.connect(), 3000);
      };

      this.ws.onerror = (err) => {
        console.warn('[WS] Error:', err);
      };

    } catch (e) {
      console.error('[WS] Initialization failed:', e);
      this.reconnectTimeout = setTimeout(() => this.connect(), 4000);
    }
  }

  handleMessage(msg) {
    switch (msg.type) {
      case 'welcome':
        this.ownClient = msg.client;
        this.emit('welcome', msg.client);
        break;

      case 'peer_list':
        // Filter out own self from active peers list for clarity
        const selfId = this.ownClient ? this.ownClient.id : null;
        this.peers = msg.peers.filter(p => p.id !== selfId);
        this.emit('peers_updated', { peers: this.peers, total: msg.totalConnected });
        break;

      case 'incoming_transfer_request':
        if (window.sounds) window.sounds.playNotification();
        this.emit('incoming_direct_transfer', msg);
        break;

      case 'direct_transfer_response':
        this.emit('direct_transfer_response', msg);
        break;

      case 'transfer_created':
        this.emit('transfer_created', msg);
        break;

      case 'transfer_downloaded':
        if (window.sounds) window.sounds.playSuccess();
        this.emit('transfer_downloaded', msg);
        break;

      case 'vault_updated':
        this.emit('vault_updated', msg);
        break;

      case 'transfer_progress':
        this.emit('transfer_progress', msg);
        break;

      default:
        this.emit(msg.type, msg);
        break;
    }
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  setDeviceName(name) {
    if (!name) return;
    localStorage.setItem('custom_device_name', name);
    this.send({ type: 'set_name', name: name });
  }

  sendDirectTransfer(targetPeerId, transferData) {
    this.send({
      type: 'direct_transfer_request',
      targetPeerId: targetPeerId,
      key: transferData.key,
      fileCount: transferData.fileCount,
      totalSize: transferData.totalSize,
      formattedTotalSize: transferData.formattedTotalSize,
      filesSummary: (transferData.files || []).map(f => ({ name: f.originalName, size: f.formattedSize }))
    });
  }

  respondDirectTransfer(senderPeerId, key, accepted) {
    this.send({
      type: 'direct_transfer_response',
      senderPeerId: senderPeerId,
      key: key,
      accepted: accepted
    });
  }

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
  }

  emit(event, data) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).forEach(cb => {
        try { cb(data); } catch (e) { console.error(e); }
      });
    }
  }
}

window.wsClient = new WebSocketClient();
