const { WebSocketServer } = require('ws');
const { getDeviceNameFromUA } = require('./utils');

class WebSocketManager {
  constructor() {
    this.wss = null;
    this.clients = new Map(); // ws -> clientData
    this.p2pRooms = new Map(); // pin -> { senderId, filesMeta, deviceName, createdAt, expiresAt }
  }

  init(server) {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (ws, req) => {
      const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').replace(/^.*:/, '');
      const userAgent = req.headers['user-agent'] || '';
      const clientId = 'peer_' + Math.random().toString(36).substring(2, 9);
      const defaultName = getDeviceNameFromUA(userAgent, clientIp);

      const clientData = {
        id: clientId,
        ip: clientIp || '127.0.0.1',
        userAgent: userAgent,
        name: defaultName,
        connectedAt: Date.now(),
        ws: ws
      };

      this.clients.set(ws, clientData);

      // Send greeting & own peer ID to the client
      this.sendTo(ws, {
        type: 'welcome',
        client: {
          id: clientId,
          ip: clientData.ip,
          name: clientData.name
        }
      });

      // Broadcast updated peer list to everyone
      this.broadcastPeerList();

      ws.on('message', (messageRaw) => {
        try {
          const msg = JSON.parse(messageRaw.toString());
          this.handleMessage(ws, clientData, msg);
        } catch (err) {
          console.error('Invalid WS message:', err.message);
        }
      });

      ws.on('close', () => {
        // Remove any P2P rooms created by this client
        for (const [pin, room] of this.p2pRooms.entries()) {
          if (room.senderId === clientData.id) {
            this.p2pRooms.delete(pin);
          }
        }
        this.clients.delete(ws);
        this.broadcastPeerList();
      });

      ws.on('error', (err) => {
        console.warn('WS client error:', err.message);
        this.clients.delete(ws);
      });
    });

    console.log('[WebSocket] Real-time engine initialized');
  }

  handleMessage(ws, clientData, msg) {
    switch (msg.type) {
      case 'set_name':
        if (msg.name && typeof msg.name === 'string') {
          clientData.name = msg.name.trim().substring(0, 40);
          this.broadcastPeerList();
        }
        break;

      case 'register_p2p_room':
        if (msg.pin) {
          const pin = String(msg.pin).trim();
          this.p2pRooms.set(pin, {
            pin: pin,
            senderId: clientData.id,
            filesMeta: msg.filesMeta || [],
            deviceName: clientData.name,
            createdAt: Date.now(),
            expiresAt: Date.now() + ((msg.expirySeconds || 600) * 1000)
          });
          this.sendTo(ws, { type: 'p2p_room_registered', pin: pin });
        }
        break;

      case 'join_p2p_room':
        const searchPin = String(msg.pin || '').trim();
        const room = this.p2pRooms.get(searchPin);
        if (!room) {
          this.sendTo(ws, { type: 'p2p_room_error', error: 'P2P Key not found or sender offline' });
          return;
        }

        if (Date.now() > room.expiresAt) {
          this.p2pRooms.delete(searchPin);
          this.sendTo(ws, { type: 'p2p_room_error', error: 'P2P Session has expired' });
          return;
        }

        const senderClient = this.findClientById(room.senderId);
        if (!senderClient || senderClient.ws.readyState !== 1) {
          this.p2pRooms.delete(searchPin);
          this.sendTo(ws, { type: 'p2p_room_error', error: 'Sender is no longer online' });
          return;
        }

        // Notify Receiver about Sender
        this.sendTo(ws, {
          type: 'p2p_room_joined',
          pin: searchPin,
          senderId: room.senderId,
          senderName: room.deviceName,
          filesMeta: room.filesMeta
        });

        // Notify Sender about Receiver to initiate WebRTC Offer
        this.sendTo(senderClient.ws, {
          type: 'p2p_peer_joined',
          pin: searchPin,
          receiverId: clientData.id,
          receiverName: clientData.name
        });
        break;

      case 'direct_transfer_request':
        // Target peer ID
        const targetPeerId = msg.targetPeerId;
        const targetClient = this.findClientById(targetPeerId);
        if (targetClient && targetClient.ws.readyState === 1) {
          this.sendTo(targetClient.ws, {
            type: 'incoming_transfer_request',
            fromPeer: {
              id: clientData.id,
              name: clientData.name,
              ip: clientData.ip
            },
            key: msg.key,
            isP2P: !!msg.isP2P,
            fileCount: msg.fileCount,
            totalSize: msg.totalSize,
            formattedTotalSize: msg.formattedTotalSize,
            filesSummary: msg.filesSummary || []
          });
        }
        break;

      case 'direct_transfer_response':
        const senderPeer = this.findClientById(msg.senderPeerId);
        if (senderPeer && senderPeer.ws.readyState === 1) {
          this.sendTo(senderPeer.ws, {
            type: 'direct_transfer_response',
            accepted: msg.accepted,
            key: msg.key,
            receiverId: clientData.id,
            receiverName: clientData.name
          });
        }
        break;

      case 'transfer_progress':
        // Broadcast transfer progress update to interested peers
        this.broadcast({
          type: 'transfer_progress',
          key: msg.key,
          percent: msg.percent,
          speed: msg.speed,
          transferredFormatted: msg.transferredFormatted
        });
        break;

      case 'webrtc_signal':
        const rtcTarget = this.findClientById(msg.targetPeerId);
        if (rtcTarget && rtcTarget.ws.readyState === 1) {
          this.sendTo(rtcTarget.ws, {
            ...msg,
            type: 'webrtc_signal',
            fromPeerId: clientData.id,
            fromPeerName: clientData.name
          });
        }
        break;

      case 'ping':
        this.sendTo(ws, { type: 'pong' });
        break;

      default:
        break;
    }
  }

  findClientById(id) {
    for (const client of this.clients.values()) {
      if (client.id === id) return client;
    }
    return null;
  }

  sendTo(ws, data) {
    if (ws && ws.readyState === 1) {
      try {
        ws.send(JSON.stringify(data));
      } catch (e) {}
    }
  }

  broadcast(data, excludeWs = null) {
    const payload = JSON.stringify(data);
    for (const [ws] of this.clients.entries()) {
      if (ws !== excludeWs && ws.readyState === 1) {
        try {
          ws.send(payload);
        } catch (e) {}
      }
    }
  }

  broadcastPeerList() {
    const peers = [];
    for (const client of this.clients.values()) {
      peers.push({
        id: client.id,
        name: client.name,
        ip: client.ip,
        connectedAt: client.connectedAt
      });
    }

    this.broadcast({
      type: 'peer_list',
      peers: peers,
      totalConnected: peers.length
    });
  }
}

module.exports = new WebSocketManager();
