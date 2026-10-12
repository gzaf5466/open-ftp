/**
 * Headless Real-Time P2P Client & Signaling Engine
 * Powered by PeerJS & WebRTC DataChannels over standard HTTPS/WSS (Port 443)
 * - Zero backend server needed (runs 100% in-browser on Vercel)
 * - End-to-end encrypted direct browser-to-browser transfers
 * - Automatic NAT traversal via Google STUN servers
 * - Live peer radar discovery
 */

class WebSocketClient {
  constructor() {
    this.peer = null;
    this.ownClient = null;
    this.peers = [];
    this.listeners = new Map();
    this.activePinPeers = new Map(); // pin -> Peer instance
    this.activeRooms = new Map(); // pin -> { filesMeta, files, senderId, senderName, ts }
    this.activeConnections = new Map();
    this.peerMap = new Map();
    this.heartbeatTimer = null;
    this.broadcastChannel = null;

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

    if ('BroadcastChannel' in window) {
      try {
        this.broadcastChannel = new BroadcastChannel('openftp_radar');
        this.broadcastChannel.onmessage = (e) => this.handleRadarBroadcast(e.data);
      } catch (e) {}
    }
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
    if (this.peer && !this.peer.destroyed) return;

    if (typeof Peer === 'undefined') {
      setTimeout(() => this.connect(), 200);
      return;
    }

    const peerId = `openftp-${this.ownClient.id}`;
    console.log(`[P2P] Initializing PeerJS node: ${peerId}`);

    try {
      this.peer = new Peer(peerId, {
        debug: 1,
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' }
          ]
        }
      });

      this.peer.on('open', (id) => {
        console.log('[P2P] Connected to WebRTC signaling mesh with ID:', id);
        this.emit('welcome', this.ownClient);
        this.startRadarBroadcast();
      });

      this.peer.on('connection', (conn) => {
        console.log('[P2P] Incoming connection from peer:', conn.peer);
        this.handleIncomingDirectConnection(conn);
      });

      this.peer.on('error', (err) => {
        console.warn('[P2P] Peer notice:', err.type, err.message);
        if (err.type === 'unavailable-id') {
          // Retry with fresh session ID if collision
          this.ownClient.id = 'node_' + Math.random().toString(36).substring(2, 9);
          sessionStorage.setItem('openftp_peer_id', this.ownClient.id);
          this.peer = null;
          setTimeout(() => this.connect(), 300);
        }
      });

      this.peer.on('disconnected', () => {
        if (this.peer && !this.peer.destroyed) {
          this.peer.reconnect();
        }
      });

    } catch (e) {
      console.error('[P2P] PeerJS init error:', e);
      setTimeout(() => this.connect(), 3000);
    }
  }

  handleIncomingDirectConnection(conn) {
    conn.on('open', () => {
      console.log('[P2P] Direct connection opened with:', conn.peer);
    });

    conn.on('data', (data) => {
      if (!data) return;

      if (data.type === 'request_room_meta' || data.type === 'join_p2p_room') {
        const pin = String(data.pin || '').trim();
        const room = this.activeRooms.get(pin);
        if (room) {
          console.log(`[P2P] Answering room request for PIN ${pin} to ${conn.peer}`);
          conn.send({
            type: 'p2p_room_joined',
            pin: pin,
            senderId: this.ownClient.id,
            senderName: this.ownClient.name,
            filesMeta: room.filesMeta || []
          });
          window.p2pEngine.attachConnection(conn);
          this.emit('p2p_peer_joined', {
            pin: pin,
            receiverId: conn.peer,
            receiverName: data.receiverName || 'Recipient Device',
            conn: conn
          });
          return;
        }
      }

      if (data.type === 'direct_transfer_request') {
        if (window.sounds) window.sounds.playNotification();
        this.emit('incoming_direct_transfer', data);
      } else if (data.type === 'direct_transfer_response') {
        this.emit('direct_transfer_response', data);
      } else if (data.type === 'p2p_room_joined') {
        window.p2pEngine.attachConnection(conn);
        this.emit('p2p_room_joined', data);
      } else {
        window.p2pEngine.handleChannelMessage(data);
      }
    });

    conn.on('error', (err) => {
      console.warn('[P2P] Connection error:', err);
    });
  }

  startRadarBroadcast() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

    const broadcastPresence = () => {
      const msg = {
        type: 'presence',
        id: this.ownClient.id,
        name: this.ownClient.name,
        ip: 'LAN / WebRTC',
        ts: Date.now()
      };

      if (this.broadcastChannel) {
        try { this.broadcastChannel.postMessage(msg); } catch (e) {}
      }

      // Also track in localStorage for same-browser Radar nodes
      try {
        const raw = localStorage.getItem('openftp_active_nodes');
        const map = raw ? JSON.parse(raw) : {};
        map[this.ownClient.id] = msg;

        // Prune nodes older than 12s
        const now = Date.now();
        const activePeers = [];
        for (const [id, node] of Object.entries(map)) {
          if (now - node.ts < 12000) {
            if (id !== this.ownClient.id) activePeers.push(node);
          } else {
            delete map[id];
          }
        }
        localStorage.setItem('openftp_active_nodes', JSON.stringify(map));

        this.peers = activePeers;
        this.emit('peers_updated', {
          peers: this.peers,
          total: this.peers.length
        });
      } catch (e) {}
    };

    broadcastPresence();
    this.heartbeatTimer = setInterval(broadcastPresence, 4000);
  }

  handleRadarBroadcast(msg) {
    if (!msg || msg.id === this.ownClient.id) return;
    this.peerMap.set(msg.id, {
      id: msg.id,
      name: msg.name,
      ip: msg.ip || 'LAN / WebRTC',
      connectedAt: msg.ts || Date.now()
    });
    this.peers = Array.from(this.peerMap.values());
    this.emit('peers_updated', {
      peers: this.peers,
      total: this.peers.length
    });
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

      case 'direct_transfer_request':
        this.sendDirectTransferToPeer(data.targetPeerId, data);
        break;

      case 'direct_transfer_response':
        this.sendDirectResponseToPeer(data.senderPeerId, data);
        break;

      default:
        break;
    }
  }

  registerRoom(data) {
    const pin = String(data.pin).trim();
    const pinPeerId = `openftp-pin-${pin}`;
    console.log(`[P2P] Registering PIN room: ${pinPeerId}`);

    // Store active room locally so primary peer can also serve it
    this.activeRooms.set(pin, {
      filesMeta: data.filesMeta || [],
      senderId: this.ownClient.id,
      senderName: this.ownClient.name,
      ts: Date.now()
    });

    // Broadcast room presence to local peers / other tabs via BroadcastChannel & localStorage
    try {
      const roomNotice = {
        type: 'room_announcement',
        pin: pin,
        senderPeerId: this.ownClient.id,
        senderName: this.ownClient.name,
        filesMeta: data.filesMeta || [],
        ts: Date.now()
      };
      if (this.broadcastChannel) this.broadcastChannel.postMessage(roomNotice);
      localStorage.setItem(`openftp_room_${pin}`, JSON.stringify(roomNotice));
    } catch (e) {}

    // If an existing room Peer for this pin exists, destroy it first
    if (this.activePinPeers.has(pin)) {
      try { this.activePinPeers.get(pin).destroy(); } catch (e) {}
    }

    try {
      const pinPeer = new Peer(pinPeerId, {
        debug: 1,
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' }
          ]
        }
      });

      pinPeer.on('open', (id) => {
        console.log(`[P2P] PIN room live on mesh: ${pinPeerId}`);
        this.emit('room_ready', { pin, id });
      });

      pinPeer.on('connection', (conn) => {
        console.log(`[P2P] Recipient joined PIN room ${pin}! Setting up data pipe...`);

        const sendManifest = () => {
          console.log(`[P2P] Sending room manifest for PIN ${pin} to recipient ${conn.peer}`);
          try {
            conn.send({
              type: 'p2p_room_joined',
              pin: pin,
              senderId: this.ownClient.id,
              senderName: this.ownClient.name,
              filesMeta: data.filesMeta || []
            });
          } catch (e) {
            console.warn('[P2P] Error sending manifest:', e);
          }

          // Attach data connection to P2PEngine
          window.p2pEngine.attachConnection(conn);

          // Notify SendController
          this.emit('p2p_peer_joined', {
            pin: pin,
            receiverId: conn.peer,
            receiverName: 'Recipient Device',
            conn: conn
          });
        };

        if (conn.open) {
          sendManifest();
        } else {
          conn.on('open', sendManifest);
        }

        conn.on('data', (msg) => {
          if (msg && (msg.type === 'request_room_meta' || msg.type === 'get_manifest' || msg.type === 'join_p2p_room')) {
            sendManifest();
          } else {
            window.p2pEngine.handleChannelMessage(msg);
          }
        });

        conn.on('error', (err) => {
          console.warn('[P2P] PIN room connection error:', err);
        });
      });

      pinPeer.on('error', (err) => {
        console.warn(`[P2P] PIN room peer event:`, err.type, err.message);
      });

      this.activePinPeers.set(pin, pinPeer);

    } catch (e) {
      console.error('[P2P] Failed to create PIN room Peer:', e);
    }
  }

  joinRoom(data) {
    const pin = String(data.pin).trim();
    let senderPeerId = data.senderPeerId || '';

    // Check if sender Peer ID was cached in localStorage
    if (!senderPeerId) {
      try {
        const raw = localStorage.getItem(`openftp_room_${pin}`);
        if (raw) {
          const roomNotice = JSON.parse(raw);
          if (roomNotice && roomNotice.senderPeerId && (Date.now() - roomNotice.ts < 600000)) {
            senderPeerId = roomNotice.senderPeerId;
            console.log(`[P2P] Resolved sender Peer ID from local broadcast: ${senderPeerId}`);
          }
        }
      } catch (e) {}
    }

    const targetPeerId = senderPeerId
      ? (senderPeerId.startsWith('openftp-') ? senderPeerId : `openftp-${senderPeerId}`)
      : `openftp-pin-${pin}`;

    console.log(`[P2P] Dialing sender target: ${targetPeerId} (PIN: ${pin})`);

    if (!this.peer || this.peer.destroyed) {
      this.connect();
    }

    let attempts = 0;
    const maxAttempts = 5;
    let joined = false;
    let retryTimer = null;

    const attemptConnect = () => {
      if (joined) return;
      attempts++;
      console.log(`[P2P] Attempt ${attempts}/${maxAttempts} connecting to ${targetPeerId}...`);

      try {
        const conn = this.peer.connect(targetPeerId, {
          reliable: true
        });

        const sendReq = () => {
          console.log(`[P2P] Connected to room ${targetPeerId}! Requesting manifest for ${pin}...`);
          try {
            conn.send({
              type: 'request_room_meta',
              pin: pin,
              receiverName: this.ownClient.name
            });
          } catch (e) {}
        };

        if (conn.open) {
          sendReq();
        } else {
          conn.on('open', sendReq);
        }

        conn.on('data', (msg) => {
          if (msg && msg.type === 'p2p_room_joined') {
            console.log(`[P2P] Received room manifest for ${pin}!`);
            joined = true;
            if (retryTimer) clearTimeout(retryTimer);
            window.p2pEngine.attachConnection(conn);
            this.emit('p2p_room_joined', msg);
          } else {
            window.p2pEngine.handleChannelMessage(msg);
          }
        });

        conn.on('close', () => {
          console.log(`[P2P] Room connection closed.`);
        });

        conn.on('error', (err) => {
          console.warn('[P2P] Join PIN room error on attempt', attempts, err);
          if (!joined && attempts < maxAttempts) {
            retryTimer = setTimeout(attemptConnect, 1200);
          } else if (!joined) {
            this.emit('p2p_room_error', { pin: pin, error: err.message });
          }
        });

      } catch (e) {
        console.error('[P2P] Connection dispatch error:', e);
        if (!joined && attempts < maxAttempts) {
          retryTimer = setTimeout(attemptConnect, 1200);
        } else if (!joined) {
          this.emit('p2p_room_error', { pin: pin, error: e.message });
        }
      }
    };

    // Catch peer-unavailable on this.peer to trigger retry automatically
    const onPeerUnavailable = (err) => {
      if (err && err.type === 'peer-unavailable') {
        console.warn(`[P2P] Peer ${targetPeerId} not yet ready on attempt ${attempts}. Retrying in 1.2s...`);
        if (!joined && attempts < maxAttempts) {
          if (retryTimer) clearTimeout(retryTimer);
          retryTimer = setTimeout(attemptConnect, 1200);
        }
      }
    };

    this.peer.on('error', onPeerUnavailable);

    this.once('p2p_room_joined', () => {
      joined = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (this.peer) this.peer.off('error', onPeerUnavailable);
    });

    console.log(`[P2P] Starting room join. Peer state: open=${this.peer?.open}, id=${this.peer?.id}`);
    if (this.peer && (this.peer.open || this.peer.id)) {
      attemptConnect();
    } else {
      if (this.peer) this.peer.once('open', attemptConnect);
      setTimeout(attemptConnect, 800);
    }
  }

  sendDirectTransferToPeer(targetId, data) {
    const targetPeerId = targetId.startsWith('openftp-') ? targetId : `openftp-${targetId}`;
    if (!this.peer || !this.peer.open) return;

    try {
      const conn = this.peer.connect(targetPeerId, { reliable: true });
      conn.on('open', () => {
        conn.send({
          ...data,
          fromPeer: {
            id: this.ownClient.id,
            name: this.ownClient.name,
            ip: 'WebRTC P2P'
          }
        });
        window.p2pEngine.attachConnection(conn);
      });
      conn.on('data', (msg) => {
        if (msg && msg.type === 'direct_transfer_response') {
          this.emit('direct_transfer_response', msg);
        } else {
          window.p2pEngine.handleChannelMessage(msg);
        }
      });
    } catch (e) {}
  }

  sendDirectResponseToPeer(senderId, data) {
    const targetPeerId = senderId.startsWith('openftp-') ? senderId : `openftp-${senderId}`;
    if (!this.peer || !this.peer.open) return;

    try {
      const conn = this.peer.connect(targetPeerId, { reliable: true });
      conn.on('open', () => {
        conn.send({
          ...data,
          receiverId: this.ownClient.id,
          receiverName: this.ownClient.name
        });
        window.p2pEngine.attachConnection(conn);
      });
      conn.on('data', (msg) => {
        window.p2pEngine.handleChannelMessage(msg);
      });
    } catch (e) {}
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
