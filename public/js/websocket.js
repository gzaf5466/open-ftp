/**
 * Headless Real-Time P2P Client & Signaling Engine
 * Powered by public secure MQTT over WebSocket (WSS) mesh
 * - Zero backend server needed (runs 100% in-browser on Vercel)
 * - Encrypted WebRTC signaling for direct browser-to-browser transfers
 * - Live peer radar discovery across Wi-Fi & internet
 */

class WebSocketClient {
  constructor() {
    this.client = null;
    this.ownClient = null;
    this.peers = [];
    this.listeners = new Map();
    this.p2pRooms = new Map(); // pin -> { pin, filesMeta, senderId, senderName, expiresAt }
    this.subscribedPins = new Set();
    this.heartbeatTimer = null;
    this.peerCache = new Map(); // peerId -> { id, name, ip, connectedAt, lastSeen }
    this.brokerIndex = 0;
    this.brokers = [
      'wss://broker.emqx.io:8084/mqtt',
      'wss://broker.hivemq.com:8884/mqtt'
    ];

    // Generate stable peer ID per browser session
    let savedId = sessionStorage.getItem('openftp_peer_id');
    if (!savedId) {
      savedId = 'peer_' + Math.random().toString(36).substring(2, 9);
      sessionStorage.setItem('openftp_peer_id', savedId);
    }

    const defaultName = this.detectDeviceName();
    const savedName = localStorage.getItem('custom_device_name') || defaultName;

    this.ownClient = {
      id: savedId,
      name: savedName,
      ip: 'P2P Mesh'
    };
  }

  detectDeviceName() {
    const ua = navigator.userAgent || '';
    let os = 'Device';
    if (/windows/i.test(ua)) os = 'Windows';
    else if (/macintosh|mac os x/i.test(ua)) os = 'Mac';
    else if (/android/i.test(ua)) os = 'Android';
    else if (/iphone|ipad|ipod/i.test(ua)) os = 'iOS';
    else if (/linux/i.test(ua)) os = 'Linux';

    let browser = 'Browser';
    if (/chrome|crios/i.test(ua) && !/edg/i.test(ua)) browser = 'Chrome';
    else if (/safari/i.test(ua) && !/chrome/i.test(ua)) browser = 'Safari';
    else if (/firefox|fxios/i.test(ua)) browser = 'Firefox';
    else if (/edg/i.test(ua)) browser = 'Edge';

    return `${os} (${browser})`;
  }

  connect() {
    if (this.client && this.client.connected) return;

    if (typeof mqtt === 'undefined') {
      console.warn('[P2P Signaling] MQTT vendor library loading, retrying in 300ms...');
      setTimeout(() => this.connect(), 300);
      return;
    }

    const brokerUrl = this.brokers[this.brokerIndex % this.brokers.length];
    console.log(`[P2P Signaling] Connecting to serverless mesh: ${brokerUrl}`);

    try {
      this.client = mqtt.connect(brokerUrl, {
        clientId: 'openftp_' + this.ownClient.id + '_' + Math.random().toString(36).substring(2, 6),
        clean: true,
        connectTimeout: 7000,
        reconnectPeriod: 4000,
        keepalive: 30
      });

      this.client.on('connect', () => {
        console.log('[P2P Signaling] Connected to headless mesh network!');

        // 1. Subscribe to own private signaling inbox
        this.client.subscribe(`openftp/v1/peer/${this.ownClient.id}`, { qos: 1 });

        // 2. Subscribe to global radar discovery channel
        this.client.subscribe('openftp/v1/radar', { qos: 0 });

        // 3. Re-subscribe to any active PIN rooms
        for (const pin of this.subscribedPins) {
          this.client.subscribe(`openftp/v1/pin/${pin}`, { qos: 1 });
        }

        // Notify client app
        this.emit('welcome', this.ownClient);

        // Start radar heartbeat
        this.startHeartbeat();
      });

      this.client.on('message', (topic, payload) => {
        try {
          const msg = JSON.parse(payload.toString());
          this.handleNetworkMessage(topic, msg);
        } catch (e) {
          console.warn('[P2P Signaling] Message parse error:', e);
        }
      });

      this.client.on('error', (err) => {
        console.warn('[P2P Signaling] Mesh broker warning:', err.message);
        this.brokerIndex++;
      });

      this.client.on('offline', () => {
        console.warn('[P2P Signaling] Mesh offline, attempting reconnect...');
      });

    } catch (err) {
      console.error('[P2P Signaling] Connect error:', err);
      setTimeout(() => this.connect(), 5000);
    }
  }

  startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

    const publishHeartbeat = () => {
      if (this.client && this.client.connected) {
        const payload = JSON.stringify({
          type: 'presence',
          id: this.ownClient.id,
          name: this.ownClient.name,
          ip: 'P2P Direct',
          ts: Date.now()
        });
        this.client.publish('openftp/v1/radar', payload, { qos: 0 });
      }

      // Clean stale peers (offline for > 15 seconds)
      const now = Date.now();
      let changed = false;
      for (const [id, peer] of this.peerCache.entries()) {
        if (now - peer.lastSeen > 16000) {
          this.peerCache.delete(id);
          changed = true;
        }
      }

      if (changed) {
        this.updatePeerList();
      }
    };

    publishHeartbeat();
    this.heartbeatTimer = setInterval(publishHeartbeat, 6000);
  }

  updatePeerList() {
    this.peers = Array.from(this.peerCache.values()).filter(p => p.id !== this.ownClient.id);
    this.emit('peers_updated', {
      peers: this.peers,
      total: this.peers.length
    });
  }

  handleNetworkMessage(topic, msg) {
    // 1. Radar Presence Channel
    if (topic === 'openftp/v1/radar') {
      if (msg.type === 'presence' && msg.id && msg.id !== this.ownClient.id) {
        const isNew = !this.peerCache.has(msg.id);
        this.peerCache.set(msg.id, {
          id: msg.id,
          name: msg.name || 'Nearby Peer',
          ip: msg.ip || 'LAN / P2P',
          connectedAt: msg.ts || Date.now(),
          lastSeen: Date.now()
        });
        if (isNew) this.updatePeerList();
      }
      return;
    }

    // 2. PIN Room Channel (e.g., openftp/v1/pin/783989)
    if (topic.startsWith('openftp/v1/pin/')) {
      const pin = topic.split('/').pop();

      // Receiver wants to join room created by this Sender
      if (msg.type === 'join_p2p_room' && msg.pin === pin) {
        const room = this.p2pRooms.get(pin);
        if (room && room.senderId === this.ownClient.id) {
          // Tell Receiver about this Sender & file manifest
          this.publishToPeer(msg.receiverId, {
            type: 'p2p_room_joined',
            pin: pin,
            senderId: this.ownClient.id,
            senderName: this.ownClient.name,
            filesMeta: room.filesMeta || []
          });

          // Trigger local P2P offer initiation in Sender UI
          this.emit('p2p_peer_joined', {
            pin: pin,
            receiverId: msg.receiverId,
            receiverName: msg.receiverName || 'Peer Receiver'
          });
        }
      }
      return;
    }

    // 3. Direct Peer-to-Peer Signaling Channel
    if (topic === `openftp/v1/peer/${this.ownClient.id}`) {
      this.handleDirectMessage(msg);
    }
  }

  handleDirectMessage(msg) {
    switch (msg.type) {
      case 'p2p_room_joined':
        this.emit('p2p_room_joined', msg);
        break;

      case 'webrtc_signal':
        this.emit('webrtc_signal', msg);
        break;

      case 'incoming_transfer_request':
        if (window.sounds) window.sounds.playNotification();
        this.emit('incoming_direct_transfer', msg);
        break;

      case 'direct_transfer_response':
        this.emit('direct_transfer_response', msg);
        break;

      case 'transfer_progress':
        this.emit('transfer_progress', msg);
        break;

      default:
        this.emit(msg.type, msg);
        break;
    }
  }

  publishToPeer(peerId, message) {
    if (this.client && this.client.connected) {
      const payload = JSON.stringify(message);
      this.client.publish(`openftp/v1/peer/${peerId}`, payload, { qos: 1 });
    }
  }

  send(data) {
    if (!data || !data.type) return;

    switch (data.type) {
      case 'set_name':
        if (data.name) {
          this.ownClient.name = data.name.trim();
          localStorage.setItem('custom_device_name', this.ownClient.name);
          this.startHeartbeat();
        }
        break;

      case 'register_p2p_room':
        if (data.pin) {
          const pin = String(data.pin).trim();
          this.p2pRooms.set(pin, {
            pin: pin,
            senderId: this.ownClient.id,
            senderName: this.ownClient.name,
            filesMeta: data.filesMeta || [],
            expiresAt: Date.now() + ((data.expirySeconds || 600) * 1000)
          });
          this.subscribedPins.add(pin);
          if (this.client && this.client.connected) {
            this.client.subscribe(`openftp/v1/pin/${pin}`, { qos: 1 });
          }
        }
        break;

      case 'join_p2p_room':
        if (data.pin) {
          const pin = String(data.pin).trim();
          this.subscribedPins.add(pin);
          if (this.client && this.client.connected) {
            this.client.subscribe(`openftp/v1/pin/${pin}`, { qos: 1 }, () => {
              // Broadcast join request to PIN channel
              const payload = JSON.stringify({
                type: 'join_p2p_room',
                pin: pin,
                receiverId: this.ownClient.id,
                receiverName: this.ownClient.name
              });
              this.client.publish(`openftp/v1/pin/${pin}`, payload, { qos: 1 });
            });
          }
        }
        break;

      case 'webrtc_signal':
        if (data.targetPeerId && data.signal) {
          this.publishToPeer(data.targetPeerId, {
            type: 'webrtc_signal',
            fromPeerId: this.ownClient.id,
            fromPeerName: this.ownClient.name,
            signal: data.signal
          });
        }
        break;

      case 'direct_transfer_request':
        if (data.targetPeerId) {
          this.publishToPeer(data.targetPeerId, {
            ...data,
            fromPeer: {
              id: this.ownClient.id,
              name: this.ownClient.name,
              ip: 'P2P Direct'
            }
          });
        }
        break;

      case 'direct_transfer_response':
        if (data.senderPeerId) {
          this.publishToPeer(data.senderPeerId, {
            ...data,
            receiverId: this.ownClient.id,
            receiverName: this.ownClient.name
          });
        }
        break;

      default:
        break;
    }
  }

  setDeviceName(name) {
    this.send({ type: 'set_name', name: name });
  }

  sendDirectTransfer(targetPeerId, transferData) {
    this.send({
      type: 'direct_transfer_request',
      targetPeerId: targetPeerId,
      key: transferData.key,
      isP2P: true,
      fileCount: transferData.fileCount,
      totalSize: transferData.totalSize,
      formattedTotalSize: transferData.formattedTotalSize,
      filesSummary: (transferData.files || []).map(f => ({ name: f.originalName || f.name, size: f.formattedSize }))
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
