/**
 * IDM 20-Day Persistent Resumption Engine & Telemetry Controller
 * Integrates Apple-style self-healing with Google-style technical diagnostics.
 */
class IdmResumeController {
  constructor() {
    this.totalRenderBlocks = 100; // 100 blocks representing 1% each
    this.isSendSpecsOpen = false;
    this.isReceiveSpecsOpen = false;
  }

  async init() {
    this.bindEvents();
    await this.refreshCheckpoints();

    // Listen to p2pManager progress events
    if (window.p2pManager) {
      window.p2pManager.on('progress', (data) => this.handleP2pProgress(data));
      window.p2pManager.on('resumed', (data) => this.handleP2pResumed(data));
      window.p2pManager.on('file_downloaded', () => this.refreshCheckpoints());
    }
  }

  bindEvents() {
    // Send specs toggles
    const btnToggleSend = document.getElementById('btn-toggle-send-specs');
    const headerToggleSend = document.getElementById('btn-toggle-send-specs-header');
    if (btnToggleSend) {
      btnToggleSend.addEventListener('click', () => this.toggleSendSpecs());
    }
    if (headerToggleSend) {
      headerToggleSend.addEventListener('click', () => this.toggleSendSpecs());
    }

    // Receive specs toggles
    const btnToggleReceive = document.getElementById('btn-toggle-receive-specs');
    const headerToggleReceive = document.getElementById('btn-toggle-receive-specs-header');
    if (btnToggleReceive) {
      btnToggleReceive.addEventListener('click', () => this.toggleReceiveSpecs());
    }
    if (headerToggleReceive) {
      headerToggleReceive.addEventListener('click', () => this.toggleReceiveSpecs());
    }
  }

  toggleSendSpecs() {
    this.isSendSpecsOpen = !this.isSendSpecsOpen;
    const drawer = document.getElementById('send-turbo-specs-drawer');
    const body = document.getElementById('send-turbo-specs-body');
    const stateLabel = document.getElementById('send-specs-toggle-state');
    if (drawer && body) {
      drawer.style.display = 'block';
      body.style.display = this.isSendSpecsOpen ? 'flex' : 'none';
      if (stateLabel) stateLabel.textContent = this.isSendSpecsOpen ? '▲ Collapse' : '▼ Expand';
    }
  }

  toggleReceiveSpecs() {
    this.isReceiveSpecsOpen = !this.isReceiveSpecsOpen;
    const drawer = document.getElementById('receive-turbo-specs-drawer');
    const body = document.getElementById('receive-turbo-specs-body');
    const stateLabel = document.getElementById('receive-specs-toggle-state');
    if (drawer && body) {
      drawer.style.display = 'block';
      body.style.display = this.isReceiveSpecsOpen ? 'flex' : 'none';
      if (stateLabel) stateLabel.textContent = this.isReceiveSpecsOpen ? '▲ Collapse' : '▼ Expand';
    }
  }

  async refreshCheckpoints() {
    if (!window.p2pManager) return;
    const checkpoints = await window.p2pManager.getAllCheckpoints();
    this.renderCheckpointsList(checkpoints);
  }

  renderCheckpointsList(checkpoints) {
    const validCheckpoints = (checkpoints || []).filter(c => c && c.totalSize > 0 && c.bytesWritten < c.totalSize);

    const sendShelf = document.getElementById('send-idm-resume-shelf');
    const sendList = document.getElementById('send-idm-resume-list');
    const sendBadge = document.getElementById('send-resume-count-badge');

    const receiveShelf = document.getElementById('receive-idm-resume-shelf');
    const receiveList = document.getElementById('receive-idm-resume-list');
    const receiveBadge = document.getElementById('receive-resume-count-badge');

    const updateShelf = (shelf, list, badge) => {
      if (!shelf || !list) return;
      if (validCheckpoints.length === 0) {
        shelf.classList.remove('has-items');
        list.innerHTML = '';
        if (badge) badge.textContent = '0 paused';
        return;
      }

      shelf.classList.add('has-items');
      if (badge) badge.textContent = `${validCheckpoints.length} paused`;

      list.innerHTML = validCheckpoints.map(item => {
        const percent = Math.min(99, Math.round((item.bytesWritten / item.totalSize) * 100));
        const savedMB = (item.bytesWritten / (1024 * 1024)).toFixed(1);
        const totalMB = (item.totalSize / (1024 * 1024)).toFixed(1);
        const timeAgo = this.formatTimeAgo(item.lastUpdated);

        return `
          <div class="idm-resume-item press" data-checkpoint-id="${item.id}">
            <div class="idm-resume-info">
              <span class="idm-resume-name" title="${item.fileName || 'Unnamed File'}">
                📄 ${item.fileName || 'Unnamed File'}
              </span>
              <div class="idm-resume-meta">
                <span class="idm-resume-progress-pill">${percent}%</span>
                <span>${savedMB} MB / ${totalMB} MB saved</span>
                <span>• ${timeAgo}</span>
              </div>
            </div>
            <div class="idm-resume-actions">
              <button class="btn btn-primary btn-sm btn-action-resume" data-resume-id="${item.id}">
                ▶️ Resume
              </button>
              <button class="btn btn-ghost btn-sm btn-action-discard" data-discard-id="${item.id}" title="Discard Checkpoint">
                🗑️
              </button>
            </div>
          </div>
        `;
      }).join('');

      // Bind resume & discard actions
      list.querySelectorAll('.btn-action-resume').forEach(btn => {
        btn.addEventListener('click', () => this.handleResumeClick(btn.dataset.resumeId));
      });
      list.querySelectorAll('.btn-action-discard').forEach(btn => {
        btn.addEventListener('click', () => this.handleDiscardClick(btn.dataset.discardId));
      });
    };

    updateShelf(sendShelf, sendList, sendBadge);
    updateShelf(receiveShelf, receiveList, receiveBadge);
  }

  async handleResumeClick(checkpointId) {
    if (!window.p2pManager) return;
    const checkpoint = await window.p2pManager.getCheckpoint(checkpointId);
    if (!checkpoint) return;

    if (window.App) {
      window.App.switchTab('receive');
      window.App.showToast(`Found checkpoint for "${checkpoint.fileName}". Ready to resume!`, 'info');
    }
  }

  async handleDiscardClick(checkpointId) {
    if (!window.p2pManager) return;
    await window.p2pManager.clearCheckpoint(checkpointId);
    if (window.App) {
      window.App.showToast('Transfer checkpoint removed.', 'info');
    }
    await this.refreshCheckpoints();
  }

  handleP2pProgress(data) {
    const percent = data.percent || 0;
    const speedMB = (data.speedBps / (1024 * 1024)).toFixed(2);
    const bufferMB = (data.bufferedAmount / (1024 * 1024)).toFixed(2);

    // Update Chunk Matrix (Sender)
    this.renderMatrixBlocks('send-idm-chunk-matrix', percent, 'send-matrix-verified-count');
    // Update Chunk Matrix (Receiver)
    this.renderMatrixBlocks('receive-idm-chunk-matrix', percent, 'receive-matrix-verified-count');

    // Telemetry - Sender
    const sendSpeed = document.getElementById('send-telemetry-speed');
    const sendBuffer = document.getElementById('send-telemetry-buffer');
    const sendIce = document.getElementById('send-telemetry-ice');
    if (sendSpeed) sendSpeed.textContent = `${speedMB} MB/s`;
    if (sendBuffer) sendBuffer.textContent = `${bufferMB} MB buffered`;
    if (sendIce) sendIce.textContent = data.iceState || 'Connected';

    // Telemetry - Receiver
    const recSpeed = document.getElementById('receive-telemetry-speed');
    const recState = document.getElementById('receive-telemetry-state');
    if (recSpeed) recSpeed.textContent = `${speedMB} MB/s`;
    if (recState) recState.textContent = data.iceState || 'Connected';
  }

  handleP2pResumed(data) {
    if (window.App) {
      const offsetMB = ((data.offset || 0) / (1024 * 1024)).toFixed(1);
      window.App.showToast(`⚡ IDM Auto-Resume: Preserved ${offsetMB} MB! Resuming losslessly...`, 'success');
    }
  }

  renderMatrixBlocks(containerId, percent, counterId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const verifiedCount = Math.floor((percent / 100) * this.totalRenderBlocks);
    const counter = document.getElementById(counterId);
    if (counter) counter.textContent = `${verifiedCount}/${this.totalRenderBlocks}`;

    // Render 100 micro blocks if not already initialized
    if (container.children.length !== this.totalRenderBlocks) {
      container.innerHTML = Array.from({ length: this.totalRenderBlocks }, (_, i) => {
        return `<div class="idm-chunk-block" data-block-idx="${i}"></div>`;
      }).join('');
    }

    // Update block states
    const blocks = container.children;
    for (let i = 0; i < this.totalRenderBlocks; i++) {
      const block = blocks[i];
      if (i < verifiedCount) {
        block.className = 'idm-chunk-block verified';
      } else if (i === verifiedCount && percent > 0 && percent < 100) {
        block.className = 'idm-chunk-block inflight';
      } else {
        block.className = 'idm-chunk-block';
      }
    }
  }

  formatTimeAgo(timestamp) {
    if (!timestamp) return 'recently';
    const diff = Math.floor((Date.now() - timestamp) / 1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    const days = Math.floor(diff / 86400);
    return `${days}d ago`;
  }
}

// Global Controller Instance
window.IdmResumeController = new IdmResumeController();
