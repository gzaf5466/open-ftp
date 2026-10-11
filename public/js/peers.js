/**
 * LAN Peer Discovery & Direct 1-to-1 Transfer Controller
 * AirDrop-style peer detection, radar mapping, and direct device-to-device transfers
 */

const PeersController = {
  peers: [],
  selectedPeer: null,
  pendingIncomingTransfer: null,

  init() {
    this.bindEvents();
    this.setupWsListeners();
  },

  bindEvents() {
    // Edit Device Name Trigger
    const editNameBtn = document.getElementById('btn-edit-device-name');
    if (editNameBtn) {
      editNameBtn.onclick = () => {
        const input = document.getElementById('edit-device-name-input');
        const currentName = localStorage.getItem('custom_device_name') || (window.wsClient.ownClient ? window.wsClient.ownClient.name : '');
        if (input) input.value = currentName;
        app.openModal('modal-edit-device-name');
      };
    }

    // Save Device Name Confirm
    const saveNameBtn = document.getElementById('btn-save-device-name');
    if (saveNameBtn) {
      saveNameBtn.onclick = () => {
        const input = document.getElementById('edit-device-name-input');
        const newName = input ? input.value.trim() : '';
        if (newName) {
          window.wsClient.setDeviceName(newName);
          this.updateOwnDeviceDisplay(newName);
          app.closeModal('modal-edit-device-name');
          app.showToast(`Device name updated to "${newName}"`, 'success');
        }
      };
    }

    // Direct Send File Input
    const directFileInput = document.getElementById('direct-send-file-input');
    if (directFileInput) {
      directFileInput.onchange = (e) => {
        if (e.target.files && e.target.files.length > 0 && this.selectedPeer) {
          this.executeDirectSend(e.target.files, this.selectedPeer);
          directFileInput.value = '';
        }
      };
    }

    // Accept Incoming Transfer
    const acceptBtn = document.getElementById('btn-accept-incoming-transfer');
    if (acceptBtn) {
      acceptBtn.onclick = () => this.handleAcceptIncoming();
    }

    // Decline Incoming Transfer
    const declineBtn = document.getElementById('btn-decline-incoming-transfer');
    if (declineBtn) {
      declineBtn.onclick = () => this.handleDeclineIncoming();
    }
  },

  setupWsListeners() {
    if (!window.wsClient) return;

    window.wsClient.on('welcome', (client) => {
      this.updateOwnDeviceDisplay(client.name);
    });

    window.wsClient.on('peers_updated', ({ peers, total }) => {
      this.peers = peers;
      this.renderPeers();
      this.renderRadarNodes();

      // Update badge counts
      const badge = document.getElementById('radar-peers-count-badge');
      if (badge) badge.textContent = peers.length;

      const mobileBadge = document.getElementById('mobile-radar-badge');
      if (mobileBadge) {
        mobileBadge.textContent = peers.length;
        mobileBadge.style.display = peers.length > 0 ? 'flex' : 'none';
      }
    });

    window.wsClient.on('incoming_direct_transfer', (data) => {
      this.showIncomingTransferPrompt(data);
    });

    window.wsClient.on('direct_transfer_response', async (data) => {
      if (data.accepted) {
        app.showToast(`${data.receiverName} accepted! Starting P2P direct stream...`, 'success');
        if (this.stagedP2PFiles && this.stagedP2PFiles.length > 0) {
          this.startP2PSending(this.stagedP2PFiles);
        }
      } else {
        app.showToast(`${data.receiverName} declined your transfer.`, 'info');
      }
    });

    // P2P Engine completion & progress
    window.p2pEngine.on('file_downloaded', (info) => {
      if (window.sounds) window.sounds.playSuccess();
      app.showToast(`P2P File "${info.name}" received successfully!`, 'success');
    });
  },

  updateOwnDeviceDisplay(name) {
    const el = document.getElementById('own-device-name-label');
    if (el) el.textContent = name;
  },

  renderRadarNodes() {
    const radar = document.getElementById('radar-screen-viewport');
    if (!radar) return;

    // Remove existing peer nodes (preserve rings and beams)
    radar.querySelectorAll('.radar-peer-node').forEach(n => n.remove());

    const total = this.peers.length;
    if (total === 0) return;

    const rect = radar.getBoundingClientRect();
    const centerX = rect.width > 0 ? rect.width / 2 : 120;
    const centerY = rect.height > 0 ? rect.height / 2 : 120;
    const radius = Math.min(centerX, centerY) * 0.65;

    this.peers.forEach((peer, idx) => {
      const angle = (idx / total) * 2 * Math.PI - Math.PI / 2;
      const x = centerX + radius * Math.cos(angle) - 14;
      const y = centerY + radius * Math.sin(angle) - 14;

      const node = document.createElement('div');
      node.className = 'radar-peer-node animate-fade-in';
      node.style.position = 'absolute';
      node.style.left = `${x}px`;
      node.style.top = `${y}px`;
      node.style.width = '28px';
      node.style.height = '28px';
      node.style.borderRadius = '50%';
      node.style.background = 'var(--primary)';
      node.style.display = 'flex';
      node.style.alignItems = 'center';
      node.style.justifyContent = 'center';
      node.style.color = 'white';
      node.style.cursor = 'pointer';
      node.style.zIndex = '15';
      node.style.boxShadow = '0 0 10px var(--primary-glow)';
      node.title = `${peer.name} (${peer.ip})`;

      node.innerHTML = this.getDeviceIconSvg(peer.name);
      node.addEventListener('click', () => this.promptDirectSend(peer));

      radar.appendChild(node);
    });
  },

  renderPeers() {
    const grid = document.getElementById('peers-grid-container');
    const emptyState = document.getElementById('peers-empty-state');
    if (!grid) return;

    if (this.peers.length === 0) {
      grid.style.display = 'none';
      if (emptyState) emptyState.style.display = 'block';
      return;
    }

    if (emptyState) emptyState.style.display = 'none';
    grid.style.display = 'grid';
    grid.innerHTML = '';

    this.peers.forEach(peer => {
      const card = document.createElement('div');
      card.className = 'peer-card animate-fade-in';
      const icon = this.getDeviceIconSvg(peer.name);

      const leftDiv = document.createElement('div');
      leftDiv.className = 'peer-card-left';
      leftDiv.innerHTML = `
        <div class="peer-avatar-box">${icon}</div>
        <div class="peer-meta">
          <div class="peer-name" title="${peer.name}">${peer.name}</div>
          <div class="peer-ip-badge">${peer.ip}</div>
        </div>
      `;

      const sendBtn = document.createElement('button');
      sendBtn.className = 'btn btn-primary btn-sm';
      sendBtn.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        <span>P2P Send</span>
      `;
      sendBtn.addEventListener('click', () => this.promptDirectSend(peer));

      card.appendChild(leftDiv);
      card.appendChild(sendBtn);
      grid.appendChild(card);
    });
  },

  promptDirectSend(peer) {
    this.selectedPeer = peer;
    const fileInput = document.getElementById('direct-send-file-input');
    if (fileInput) fileInput.click();
  },

  async executeDirectSend(files, peer) {
    const fileArray = Array.from(files);
    if (fileArray.length === 0) return;
    this.stagedP2PFiles = fileArray;

    const totalBytes = fileArray.reduce((sum, f) => sum + f.size, 0);
    const summary = fileArray.map(f => ({ name: f.name, size: SendController.formatBytes(f.size) }));

    try {
      // 1. Establish WebRTC connection to peer
      await window.p2pEngine.initiateOffer(peer.id);

      // 2. Send transfer prompt to recipient via WebSocket
      window.wsClient.send({
        type: 'direct_transfer_request',
        targetPeerId: peer.id,
        isP2P: true,
        key: 'p2p_' + Math.floor(100000 + Math.random() * 900000),
        fileCount: fileArray.length,
        totalSize: totalBytes,
        formattedTotalSize: SendController.formatBytes(totalBytes),
        filesSummary: summary
      });

      app.showToast(`P2P Request sent to ${peer.name}. Waiting for approval...`, 'info');
    } catch (e) {
      console.error('P2P direct send error:', e);
      app.showToast('Could not initiate P2P connection', 'error');
    }
  },

  async startP2PSending(files) {
    for (const file of files) {
      app.showToast(`Streaming "${file.name}" peer-to-peer...`, 'info');
      try {
        await window.p2pEngine.sendFile(file, {
          onProgress: (p) => {
            const speedMb = (p.speedBps / (1024 * 1024)).toFixed(1);
            app.showToast(`P2P Sending: ${p.percent}% (${speedMb} MB/s)`, 'info');
          },
          onComplete: () => {
            if (window.sounds) window.sounds.playSuccess();
            app.showToast(`"${file.name}" sent directly to peer!`, 'success');
          }
        });
      } catch (err) {
        app.showToast(`P2P Transfer failed: ${err.message}`, 'error');
      }
    }
    this.stagedP2PFiles = [];
  },

  showIncomingTransferPrompt(data) {
    this.pendingIncomingTransfer = data;

    const senderNameEl = document.getElementById('incoming-sender-name');
    const senderIpEl = document.getElementById('incoming-sender-ip');
    const metaEl = document.getElementById('incoming-transfer-meta');
    const filesListEl = document.getElementById('incoming-files-preview-list');

    if (senderNameEl) senderNameEl.textContent = data.fromPeer.name;
    if (senderIpEl) senderIpEl.textContent = data.fromPeer.ip;
    if (metaEl) {
      const p2pTag = data.isP2P ? '⚡ P2P Direct (Zero Server) • ' : '';
      metaEl.textContent = `${p2pTag}${data.fileCount} file(s) • ${data.formattedTotalSize}`;
    }

    if (filesListEl) {
      filesListEl.innerHTML = '';
      (data.filesSummary || []).forEach(f => {
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.justifyContent = 'space-between';
        row.style.fontSize = '0.85rem';
        row.style.padding = '0.3rem 0';
        row.innerHTML = `<span style="font-weight: 600; color: var(--text-main);">${f.name}</span><span style="color: var(--text-muted);">${f.size}</span>`;
        filesListEl.appendChild(row);
      });
    }

    app.openModal('modal-incoming-transfer');
  },

  handleAcceptIncoming() {
    if (!this.pendingIncomingTransfer) return;
    const data = this.pendingIncomingTransfer;

    window.wsClient.respondDirectTransfer(data.fromPeer.id, data.key, true);
    app.closeModal('modal-incoming-transfer');

    if (data.isP2P) {
      app.showToast(`P2P Pipe connected with ${data.fromPeer.name}! Awaiting stream...`, 'success');
    } else {
      // Switch to receive tab and load transfer immediately
      app.switchTab('receive');
      ReceiveController.fetchTransferByKey(data.key);
    }
    this.pendingIncomingTransfer = null;
  },

  handleDeclineIncoming() {
    if (!this.pendingIncomingTransfer) return;
    window.wsClient.respondDirectTransfer(this.pendingIncomingTransfer.fromPeer.id, this.pendingIncomingTransfer.key, false);
    app.closeModal('modal-incoming-transfer');
    this.pendingIncomingTransfer = null;
  },

  getDeviceIconSvg(name = '') {
    const lower = name.toLowerCase();
    if (lower.includes('iphone') || lower.includes('android') || lower.includes('phone') || lower.includes('mobile')) {
      return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>';
    }
    if (lower.includes('mac') || lower.includes('laptop') || lower.includes('book')) {
      return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>';
    }
    return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>';
  }
};

window.PeersController = PeersController;
