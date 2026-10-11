/**
 * Vault & Shared Storage (FTP) File Explorer Controller
 * Manages directory navigation, file uploads, folder creation, renaming, deletion, and previews
 */

const VaultController = {
  currentPath: '',
  items: [],
  viewMode: localStorage.getItem('vault_view_mode') || 'grid', // 'grid' | 'list'
  searchQuery: '',
  itemToRename: null,
  itemToDelete: null,

  init() {
    this.bindEvents();
  },

  bindEvents() {
    // View mode switchers
    const gridBtn = document.getElementById('btn-vault-view-grid');
    const listBtn = document.getElementById('btn-vault-view-list');
    if (gridBtn) gridBtn.onclick = () => this.setViewMode('grid');
    if (listBtn) listBtn.onclick = () => this.setViewMode('list');

    // Search input
    const searchInput = document.getElementById('vault-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        this.searchQuery = e.target.value.toLowerCase().trim();
        this.renderExplorer();
      });
    }

    // New Folder Trigger
    const newFolderBtn = document.getElementById('btn-vault-new-folder');
    if (newFolderBtn) {
      newFolderBtn.onclick = () => {
        const input = document.getElementById('new-folder-name-input');
        if (input) input.value = '';
        app.openModal('modal-new-folder');
      };
    }

    const confirmFolderBtn = document.getElementById('btn-confirm-create-folder');
    if (confirmFolderBtn) {
      confirmFolderBtn.onclick = () => this.handleCreateFolder();
    }

    // File Upload Trigger
    const uploadInput = document.getElementById('vault-upload-input');
    const uploadBtn = document.getElementById('btn-vault-upload');
    if (uploadBtn && uploadInput) {
      uploadBtn.onclick = () => uploadInput.click();
      uploadInput.onchange = (e) => {
        if (e.target.files && e.target.files.length > 0) {
          this.handleFileUpload(e.target.files);
          uploadInput.value = '';
        }
      };
    }

    // Drag and drop onto explorer viewport
    const viewport = document.getElementById('vault-explorer-viewport');
    if (viewport) {
      ['dragenter', 'dragover'].forEach(name => {
        viewport.addEventListener(name, (e) => {
          e.preventDefault();
          viewport.classList.add('drag-active');
        });
      });

      ['dragleave', 'drop'].forEach(name => {
        viewport.addEventListener(name, (e) => {
          e.preventDefault();
          viewport.classList.remove('drag-active');
        });
      });

      viewport.addEventListener('drop', (e) => {
        const files = e.dataTransfer.files;
        if (files && files.length > 0) {
          this.handleFileUpload(files);
        }
      });
    }

    // Download Folder ZIP
    const downloadZipBtn = document.getElementById('btn-vault-download-zip');
    if (downloadZipBtn) {
      downloadZipBtn.onclick = () => {
        const zipUrl = `/api/vault/download-zip?path=${encodeURIComponent(this.currentPath)}`;
        window.location.href = zipUrl;
      };
    }

    // Rename confirmation
    const confirmRenameBtn = document.getElementById('btn-confirm-rename');
    if (confirmRenameBtn) {
      confirmRenameBtn.onclick = () => this.handleRenameSubmit();
    }

    // Delete confirmation
    const confirmDeleteBtn = document.getElementById('btn-confirm-delete');
    if (confirmDeleteBtn) {
      confirmDeleteBtn.onclick = () => this.handleDeleteSubmit();
    }

    // Listen for WebSocket updates to auto refresh
    if (window.wsClient) {
      window.wsClient.on('vault_updated', () => {
        if (window.appState && window.appState.currentTab === 'vault') {
          this.loadDirectory(this.currentPath);
        }
      });
    }
  },

  setViewMode(mode) {
    this.viewMode = mode;
    localStorage.setItem('vault_view_mode', mode);
    const gridBtn = document.getElementById('btn-vault-view-grid');
    const listBtn = document.getElementById('btn-vault-view-list');
    if (gridBtn) gridBtn.classList.toggle('active', mode === 'grid');
    if (listBtn) listBtn.classList.toggle('active', mode === 'list');
    this.renderExplorer();
  },

  async loadDirectory(subPath = '') {
    this.currentPath = subPath;
    try {
      const data = await API.listVault(subPath);
      if (data.success) {
        this.items = data.items || [];
        this.renderBreadcrumbs(data.currentPath);
        this.renderExplorer();
        this.updateStats();
      } else {
        app.showToast(data.error || 'Failed to load directory', 'error');
      }
    } catch (err) {
      app.showToast(err.message || 'Error connecting to Vault', 'error');
    }
  },

  renderBreadcrumbs(currentPath) {
    const container = document.getElementById('vault-breadcrumbs-container');
    if (!container) return;

    container.innerHTML = '';
    const rootBtn = document.createElement('div');
    rootBtn.className = `breadcrumb-item ${!currentPath ? 'active' : ''}`;
    rootBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
      Vault Root
    `;
    rootBtn.onclick = () => this.loadDirectory('');
    container.appendChild(rootBtn);

    if (currentPath) {
      const parts = currentPath.split('/').filter(Boolean);
      let accumulated = '';
      parts.forEach((part, index) => {
        accumulated += (accumulated ? '/' : '') + part;
        const target = accumulated;
        const isLast = index === parts.length - 1;

        const sep = document.createElement('span');
        sep.className = 'breadcrumb-separator';
        sep.textContent = '/';
        container.appendChild(sep);

        const crumb = document.createElement('div');
        crumb.className = `breadcrumb-item ${isLast ? 'active' : ''}`;
        crumb.textContent = part;
        if (!isLast) {
          crumb.onclick = () => this.loadDirectory(target);
        }
        container.appendChild(crumb);
      });
    }
  },

  renderExplorer() {
    const gridLayout = document.getElementById('vault-grid-container');
    const listLayout = document.getElementById('vault-list-container');
    const emptyState = document.getElementById('vault-empty-state');

    if (!gridLayout || !listLayout) return;

    let filtered = this.items;
    if (this.searchQuery) {
      filtered = this.items.filter(item => item.name.toLowerCase().includes(this.searchQuery));
    }

    if (filtered.length === 0) {
      gridLayout.style.display = 'none';
      listLayout.style.display = 'none';
      if (emptyState) emptyState.style.display = 'block';
      return;
    }

    if (emptyState) emptyState.style.display = 'none';

    if (this.viewMode === 'grid') {
      gridLayout.style.display = 'grid';
      listLayout.style.display = 'none';
      this.renderGridView(filtered, gridLayout);
    } else {
      gridLayout.style.display = 'none';
      listLayout.style.display = 'table';
      this.renderListView(filtered, listLayout);
    }
  },

  renderGridView(items, container) {
    container.innerHTML = '';
    items.forEach(item => {
      const card = document.createElement('div');
      card.className = `vault-grid-item ${item.type}`;
      const icon = item.type === 'folder' 
        ? '<svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>'
        : SendController.getCategoryIcon(item.category);

      card.innerHTML = `
        <button class="vault-item-actions-btn" title="Options" onclick="event.stopPropagation(); VaultController.showItemMenu(event, '${encodeURIComponent(JSON.stringify(item))}')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg>
        </button>
        <div class="vault-grid-icon-wrap ${item.category || 'folder'}">${icon}</div>
        <div class="vault-grid-name" title="${item.name}">${item.name}</div>
        <div class="vault-grid-meta">${item.type === 'folder' ? 'Folder' : item.formattedSize}</div>
      `;

      card.onclick = () => {
        if (item.type === 'folder') {
          this.loadDirectory(item.path);
        } else {
          PreviewController.open(item);
        }
      };

      container.appendChild(card);
    });
  },

  renderListView(items, container) {
    const tbody = container.querySelector('tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    items.forEach(item => {
      const row = document.createElement('tr');
      row.className = 'vault-list-row';
      const icon = item.type === 'folder' 
        ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" style="color: #eab308;"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>'
        : `<div class="file-icon-box ${item.category}">${SendController.getCategoryIcon(item.category)}</div>`;

      row.innerHTML = `
        <td>
          <div class="vault-list-file-cell">
            ${icon}
            <div style="font-weight: 600; color: var(--text-main);">${item.name}</div>
          </div>
        </td>
        <td style="color: var(--text-muted);">${item.type === 'folder' ? 'Directory' : item.category}</td>
        <td style="color: var(--text-muted);">${item.type === 'folder' ? '--' : item.formattedSize}</td>
        <td style="text-align: right;">
          <div style="display: inline-flex; gap: 0.35rem;">
            ${item.type === 'file' ? `
              <button class="btn-icon" title="Preview" onclick="event.stopPropagation(); PreviewController.open(JSON.parse(decodeURIComponent('${encodeURIComponent(JSON.stringify(item))}')))">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              </button>
              <a href="/api/vault/download?path=${encodeURIComponent(item.path)}" download="${item.name}" class="btn-icon" title="Download" onclick="event.stopPropagation();">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              </a>
            ` : ''}
            <button class="btn-icon" title="Rename" onclick="event.stopPropagation(); VaultController.promptRename(JSON.parse(decodeURIComponent('${encodeURIComponent(JSON.stringify(item))}')))">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
            </button>
            <button class="btn-icon" title="Delete" onclick="event.stopPropagation(); VaultController.promptDelete(JSON.parse(decodeURIComponent('${encodeURIComponent(JSON.stringify(item))}')))">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--accent-rose);"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>
        </td>
      `;

      row.onclick = () => {
        if (item.type === 'folder') {
          this.loadDirectory(item.path);
        } else {
          PreviewController.open(item);
        }
      };

      tbody.appendChild(row);
    });
  },

  showItemMenu(event, encodedItem) {
    const item = JSON.parse(decodeURIComponent(encodedItem));
    this.promptRename(item); // Quick fallback action or context modal
  },

  promptRename(item) {
    this.itemToRename = item;
    const input = document.getElementById('rename-item-input');
    if (input) input.value = item.name;
    app.openModal('modal-rename-item');
  },

  async handleRenameSubmit() {
    if (!this.itemToRename) return;
    const input = document.getElementById('rename-item-input');
    const newName = input ? input.value.trim() : '';

    if (!newName) {
      app.showToast('Please enter a name', 'error');
      return;
    }

    try {
      const res = await API.renameVaultItem(this.itemToRename.path, newName);
      if (res.success) {
        app.showToast('Renamed successfully', 'success');
        app.closeModal('modal-rename-item');
        this.loadDirectory(this.currentPath);
      } else {
        app.showToast(res.error || 'Failed to rename', 'error');
      }
    } catch (e) {
      app.showToast(e.message, 'error');
    }
  },

  promptDelete(item) {
    this.itemToDelete = item;
    const nameEl = document.getElementById('delete-item-name-label');
    if (nameEl) nameEl.textContent = `"${item.name}"`;
    app.openModal('modal-delete-confirm');
  },

  async handleDeleteSubmit() {
    if (!this.itemToDelete) return;
    try {
      const res = await API.deleteVaultItem(this.itemToDelete.path);
      if (res.success) {
        app.showToast('Item deleted', 'success');
        app.closeModal('modal-delete-confirm');
        this.loadDirectory(this.currentPath);
      } else {
        app.showToast(res.error || 'Failed to delete', 'error');
      }
    } catch (e) {
      app.showToast(e.message, 'error');
    }
  },

  async handleCreateFolder() {
    const input = document.getElementById('new-folder-name-input');
    const folderName = input ? input.value.trim() : '';

    if (!folderName) {
      app.showToast('Please enter a folder name', 'error');
      return;
    }

    try {
      const res = await API.createVaultFolder(folderName, this.currentPath);
      if (res.success) {
        app.showToast('Folder created', 'success');
        app.closeModal('modal-new-folder');
        this.loadDirectory(this.currentPath);
      } else {
        app.showToast(res.error || 'Failed to create folder', 'error');
      }
    } catch (e) {
      app.showToast(e.message, 'error');
    }
  },

  async handleFileUpload(files) {
    app.showToast(`Uploading ${files.length} file(s)...`, 'info');
    try {
      const res = await API.uploadVault(files, this.currentPath);
      if (res.success) {
        if (window.sounds) window.sounds.playSuccess();
        app.showToast(`Uploaded ${res.count} file(s) to Vault`, 'success');
        this.loadDirectory(this.currentPath);
      }
    } catch (e) {
      app.showToast(e.message || 'Upload failed', 'error');
    }
  },

  async updateStats() {
    try {
      const stats = await API.getVaultStats();
      const filesCountEl = document.getElementById('vault-stat-files-count');
      const foldersCountEl = document.getElementById('vault-stat-folders-count');
      const sizeEl = document.getElementById('vault-stat-total-size');

      if (filesCountEl) filesCountEl.textContent = stats.vaultFileCount;
      if (foldersCountEl) foldersCountEl.textContent = stats.vaultFolderCount;
      if (sizeEl) sizeEl.textContent = stats.formattedVaultSize;
    } catch (e) {}
  }
};

window.VaultController = VaultController;
