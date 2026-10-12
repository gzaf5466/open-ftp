/**
 * Headless Real-Time P2P Signaling Engine
 * Powered by MQTT over WebSocket & WebRTC DataChannels (Port 443 WSS)
 * - 100% Serverless & Headless (Runs entirely in-browser on Vercel)
 * - Ultra-low latency public broker mesh (EMQX / HiveMQ SSL WebSockets)
 * - Global Cross-Device Radar Discovery (Real-time presence across phone & PC)
 * - Instant 6-digit PIN room matching with zero connection drops
 * - End-to-end encrypted direct browser-to-browser WebRTC DataChannel transfers
 */

class WebSocketClient {
  constructor() {
    this.mqttClient = null;
    this.connected = false;
    this.ownClient = null;
    this.peers = [];
    this.peerMap = new Map();
    this.listeners = new Map();
    this.activeRooms = new Map(); // pin -> { filesMeta, files, expirySeconds, ts }
    this.subscribedRooms = new Set();
    this.publishQueue = [];
    this.heartbeatTimer = null;
    this.pruneTimer = null;
    this.broadcastChannel = null;

    // Brokers (SSL WebSockets Port 8084 / 8884 - accessible worldwide)
    this.brokers = [
      'wss://broker.emqx.io:8084/mqtt',
      'wss://broker.hivemq.com:8884/mqtt'
    ];
    this.currentBrokerIdx = 0;

    // Load or generate stable device ID per tab/session
    let savedId = sessionStorage.getItem('openftp_peer_id');
    if (!savedId) {
      savedId = 'node_' + Math.random().toString(36).substring(2, 9);
      sessionStorage.setItem('openftp_peer_id', savedId);
    }

    const defaultName = this.detectDeviceName();
    const savedName = localStorage.getItem('custom_device_name') || defaultName;

    this.ownClient = {
      id: savedId,
      name: savedName,
      ip: 'WebRTC P2P'
    };

    // Fast local channel for same-browser tabs
    if ('BroadcastChannel' in window) {
      try {
        this.broadcastChannel = new BroadcastChannel('openftp_radar');
        this.broadcastChannel.onmessage = (e) => this.handleRadarBroadcast(e.data);
      } catch (e) {}
    }

    // Auto cleanup on window unload
    window.addEventListener('beforeunload', () => {
      this.publishRadarLeave();
    });

    // Auto start
    this.connect();
  }

  detectDeviceName() {
    const ua = navigator.userAgent || '';
    let os = 'Device';
    if (/windows/i.test(ua)) os = 'Windows PC';
    else if (/macintosh|mac os x/i.test(ua)) os = 'Mac';
    else if (/android/i.test(ua)) os = 'Android';
    else if (/iphone/i.test(ua)) os = 'iPhone';
    else if (/ipad/i.test(ua)) os = 'iPad';
    else if (/linux/i.test(ua)) os = 'Linux';

    let browser = 'Browser';
    if (/chrome|crios/i.test(ua) && !/edg/i.test(ua)) browser = 'Chrome';
    else if (/safari/i.test(ua) && !/chrome/i.test(ua)) browser = 'Safari';
    else if (/firefox|fxios/i.test(ua)) browser = 'Firefox';
    else if (/edg/i.test(ua)) browser = 'Edge';

    return `${os} (${browser})`;
  }

  connect() {
    if (this.mqttClient && this.connected) return;

    if (typeof window.mqtt === 'undefined') {
      setTimeout(() => this.connect(), 200);
      return;
    }

    const brokerUrl = this.brokers[this.currentBrokerIdx];
    const clientId = `openftp_${this.ownClient.id}_${Math.random().toString(16).substring(2, 6)}`;
    console.log(`[P2P Signaling] Connecting to broker: ${brokerUrl} as ${clientId}`);

    try {
      this.mqttClient = window.mqtt.connect(brokerUrl, {
        clientId: clientId,
        clean: true,
        reconnectPeriod: 3000,
        connectTimeout: 10000,
        keepalive: 30
      });

      this.mqttClient.on('connect', () => {
        console.log(`[P2P Signaling] Connected to real-time mesh via ${brokerUrl}!`);
        this.connected = true;

        // 1. Subscribe to Radar presence channel
        this.mqttClient.subscribe('openftp/v2/radar', { qos: 0 });

        // 2. Subscribe to own private signaling topic
        this.mqttClient.subscribe(`openftp/v2/peer/${this.ownClient.id}`, { qos: 1 });

        // 3. Resubscribe to any active PIN rooms
        for (const pin of this.subscribedRooms) {
          this.mqttClient.subscribe(`openftp/v2/room/${pin}`, { qos: 1 });
        }

        // Flush any queued publishes
        while (this.publishQueue.length > 0) {
          const item = this.publishQueue.shift();
          this.publish(item.topic, item.payload, item.qos);
        }

        this.emit('welcome', this.ownClient);
        this.startRadarBroadcast();
      });

      this.mqttClient.on('message', (topic, payload) => {
        try {
          const data = JSON.parse(payload.toString());
          this.handleIncomingMqttMessage(topic, data);
        } catch (e) {
          console.warn('[P2P Signaling] Invalid message payload:', e);
        }
      });

      this.mqttClient.on('error', (err) => {
        console.warn(`[P2P Signaling] Broker error on ${brokerUrl}:`, err.message || err);
        this.connected = false;
        // Rotate broker on failure
        this.currentBrokerIdx = (this.currentBrokerIdx + 1) % this.brokers.length;
      });

      this.mqttClient.on('close', () => {
        this.connected = false;
      });

      this.mqttClient.on('offline', () => {
        this.connected = false;
      });

    } catch (e) {
      console.error('[P2P Signaling] MQTT initialization error:', e);
      setTimeout(() => this.connect(), 2000);
    }
  }

  publish(topic, payload, qos = 0) {
    const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
    if (this.mqttClient && this.connected) {
      this.mqttClient.publish(topic, payloadStr, { qos: qos });
    } else {
      this.publishQueue.push({ topic, payload: payloadStr, qos });
      if (!this.connected) this.connect();
    }
  }

  handleIncomingMqttMessage(topic, msg) {
    if (!msg) return;

    // 1. Global Radar presence
    if (topic === 'openftp/v2/radar') {
      this.handleRadarMessage(msg);
      return;
    }

    // 2. Room signaling: openftp/v2/room/{pin}
    if (topic.startsWith('openftp/v2/room/')) {
      const pin = topic.replace('openftp/v2/room/', '');
      this.handleRoomMessage(pin, msg);
      return;
    }

    // 3. Direct peer-to-peer signaling: openftp/v2/peer/{ownId}
    if (topic === `openftp/v2/peer/${this.ownClient.id}`) {
      this.handleDirectPeerMessage(msg);
      return;
    }
  }

  // --------------------------------------------------------------------------
  // RADAR PRESENCE & DISCOVERY ENGINE
  // --------------------------------------------------------------------------
  startRadarBroadcast() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);

    const ping = () => {
      const pingMsg = {
        type: 'radar_ping',
        id: this.ownClient.id,
        name: this.ownClient.name,
        ip: 'WebRTC P2P',
        ts: Date.now()
      };
      this.publish('openftp/v2/radar', pingMsg, 0);

      if (this.broadcastChannel) {
        try { this.broadcastChannel.postMessage(pingMsg); } catch (e) {}
      }
    };

    ping();
    this.heartbeatTimer = setInterval(ping, 3000);

    // Prune stale peers every 2 seconds
    this.pruneTimer = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [id, peer] of this.peerMap.entries()) {
        if (now - peer.lastSeen > 8500) {
          this.peerMap.delete(id);
          changed = true;
        }
      }
      if (changed) {
        this.peers = Array.from(this.peerMap.values());
        this.emit('peers_updated', { peers: this.peers, total: this.peers.length });
      }
    }, 2000);
  }

  publishRadarLeave() {
    const leaveMsg = {
      type: 'radar_leave',
      id: this.ownClient.id
    };
    this.publish('openftp/v2/radar', leaveMsg, 0);
  }

  handleRadarMessage(msg) {
    if (!msg || msg.id === this.ownClient.id) return;

    if (msg.type === 'radar_leave') {
      if (this.peerMap.has(msg.id)) {
        this.peerMap.delete(msg.id);
        this.peers = Array.from(this.peerMap.values());
        this.emit('peers_updated', { peers: this.peers, total: this.peers.length });
      }
      return;
    }

    if (msg.type === 'radar_ping') {
      const isNew = !this.peerMap.has(msg.id);
      this.peerMap.set(msg.id, {
        id: msg.id,
        name: msg.name,
        ip: msg.ip || 'LAN / WebRTC',
        lastSeen: Date.now()
      });

      this.peers = Array.from(this.peerMap.values());
      this.emit('peers_updated', { peers: this.peers, total: this.peers.length });
    }
  }

  handleRadarBroadcast(msg) {
    this.handleRadarMessage(msg);
  }

  // --------------------------------------------------------------------------
  // 6-DIGIT PIN ROOM MATCHING ENGINE
  // --------------------------------------------------------------------------
  registerRoom(data) {
    const pin = String(data.pin).trim();
    console.log(`[P2P] Registering PIN room: ${pin}`);

    this.activeRooms.set(pin, {
      pin: pin,
      filesMeta: data.filesMeta || [],
      files: data.files || [],
      senderId: this.ownClient.id,
      senderName: this.ownClient.name,
      expirySeconds: data.expirySeconds || 600,
      ts: Date.now()
    });

    // Subscribe to room topic
    const topic = `openftp/v2/room/${pin}`;
    this.subscribedRooms.add(pin);
    if (this.mqttClient && this.connected) {
      this.mqttClient.subscribe(topic, { qos: 1 });
    }

    // Publish room announcement with manifest
    this.publish(topic, {
      type: 'room_announcement',
      pin: pin,
      senderId: this.ownClient.id,
      senderName: this.ownClient.name,
      filesMeta: data.filesMeta || [],
      ts: Date.now()
    }, 1);

    this.emit('room_ready', { pin });
  }

  joinRoom(data) {
    const pin = String(data.pin).trim();
    console.log(`[P2P] Joining PIN room: ${pin}`);

    const topic = `openftp/v2/room/${pin}`;
    this.subscribedRooms.add(pin);
    if (this.mqttClient && this.connected) {
      this.mqttClient.subscribe(topic, { qos: 1 });
    }

    let joined = false;
    let attempts = 0;
    const maxAttempts = 7;

    const sendJoinReq = () => {
      if (joined) return;
      attempts++;
      console.log(`[P2P] Sending room_join_request for PIN ${pin} (attempt ${attempts}/${maxAttempts})...`);
      this.publish(topic, {
        type: 'room_join_request',
        pin: pin,
        receiverId: this.ownClient.id,
        receiverName: this.ownClient.name,
        ts: Date.now()
      }, 1);
    };

    sendJoinReq();
    const retryInterval = setInterval(() => {
      if (joined || attempts >= maxAttempts) {
        clearInterval(retryInterval);
        return;
      }
      sendJoinReq();
    }, 1200);

    // Cancel retry once room joined
    const cleanup = (msg) => {
      if (msg && msg.pin === pin) {
        joined = true;
        clearInterval(retryInterval);
        this.off('p2p_room_joined', cleanup);
      }
    };
    this.on('p2p_room_joined', cleanup);
  }

  handleRoomMessage(pin, msg) {
    if (!msg) return;

    // CASE 1: Receiver sent join request -> Sender answers with manifest & starts WebRTC connection
    if (msg.type === 'room_join_request') {
      if (msg.receiverId === this.ownClient.id) return; // ignore self
      const room = this.activeRooms.get(pin);
      if (room) {
        console.log(`[P2P] Sender answering join request for PIN ${pin} from receiver ${msg.receiverId}`);
        // Publish manifest
        this.publish(`openftp/v2/room/${pin}`, {
          type: 'room_manifest',
          pin: pin,
          senderId: this.ownClient.id,
          senderName: this.ownClient.name,
          filesMeta: room.filesMeta,
          targetReceiverId: msg.receiverId
        }, 1);

        // Notify SendController
        this.emit('p2p_peer_joined', {
          pin: pin,
          receiverId: msg.receiverId,
          receiverName: msg.receiverName || 'Recipient Device'
        });

        // Sender initiates direct WebRTC DataChannel connection to receiver
        if (window.p2pEngine) {
          console.log(`[P2P] Sender initiating WebRTC offer to ${msg.receiverId}...`);
          window.p2pEngine.initiateOffer(msg.receiverId);
        }
      }
      return;
    }

    // CASE 2: Sender sent manifest -> Receiver updates UI and prepares to receive
    if (msg.type === 'room_manifest' || msg.type === 'room_announcement') {
      if (msg.senderId === this.ownClient.id) return; // ignore self
      if (msg.targetReceiverId && msg.targetReceiverId !== this.ownClient.id) return; // intended for other receiver

      console.log(`[P2P] Receiver got room manifest for PIN ${pin}:`, msg.filesMeta);
      this.emit('p2p_room_joined', {
        pin: pin,
        senderId: msg.senderId,
        senderName: msg.senderName,
        filesMeta: msg.filesMeta || []
      });
      return;
    }
  }

  // --------------------------------------------------------------------------
  // DIRECT 1-TO-1 PEER SIGNALING & AIRDROP TRANSFERS
  // --------------------------------------------------------------------------
  handleDirectPeerMessage(msg) {
    if (!msg) return;

    // WebRTC SDP offer / answer / ICE candidate
    if (msg.type === 'webrtc_signal') {
      this.emit('webrtc_signal', {
        fromPeerId: msg.fromPeerId,
        signal: msg.signal
      });
      return;
    }

    // AirDrop / Radar 1-on-1 direct transfer request
    if (msg.type === 'direct_transfer_request') {
      if (window.sounds) window.sounds.playNotification();
      this.emit('incoming_direct_transfer', msg);
      return;
    }

    // AirDrop direct transfer accept/decline response
    if (msg.type === 'direct_transfer_response') {
      this.emit('direct_transfer_response', msg);
      return;
    }
  }

  send(data) {
    if (!data || !data.type) return;

    switch (data.type) {
      case 'set_name':
        if (data.name) {
          this.ownClient.name = data.name.trim();
          localStorage.setItem('custom_device_name', this.ownClient.name);
          this.startRadarBroadcast();
        }
        break;

      case 'register_p2p_room':
        this.registerRoom(data);
        break;

      case 'join_p2p_room':
        this.joinRoom(data);
        break;

      case 'webrtc_signal':
        if (data.targetPeerId && data.signal) {
          this.publish(`openftp/v2/peer/${data.targetPeerId}`, {
            type: 'webrtc_signal',
            fromPeerId: this.ownClient.id,
            signal: data.signal
          }, 1);
        }
        break;

      case 'direct_transfer_request':
        if (data.targetPeerId) {
          this.publish(`openftp/v2/peer/${data.targetPeerId}`, {
            ...data,
            fromPeer: {
              id: this.ownClient.id,
              name: this.ownClient.name,
              ip: 'WebRTC P2P'
            }
          }, 1);
        }
        break;

      case 'direct_transfer_response':
        if (data.senderPeerId) {
          this.publish(`openftp/v2/peer/${data.senderPeerId}`, {
            ...data,
            receiverId: this.ownClient.id,
            receiverName: this.ownClient.name
          }, 1);
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
      filesSummary: (transferData.files || []).map(f => ({
        name: f.originalName || f.name,
        size: f.formattedSize
      }))
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

  // --------------------------------------------------------------------------
  // EVENT EMITTER UTILITIES
  // --------------------------------------------------------------------------
  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
  }

  once(event, callback) {
    const wrapper = (data) => {
      this.off(event, wrapper);
      callback(data);
    };
    this.on(event, wrapper);
  }

  off(event, callback) {
    if (!this.listeners.has(event)) return;
    const filtered = this.listeners.get(event).filter(cb => cb !== callback);
    this.listeners.set(event, filtered);
  }

  emit(event, data) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).forEach(cb => {
        try { cb(data); } catch (e) { console.error(`Error in event listener for [${event}]:`, e); }
      });
    }
  }
}

window.wsClient = new WebSocketClient();
