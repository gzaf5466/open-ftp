/**
 * Multi-Media Preview Modal Controller
 * Previews images, audio, video, PDF, and code/text files with range streaming
 */

const PreviewController = {
  currentFile: null,

  open(file) {
    this.currentFile = file;
    const modalTitle = document.getElementById('preview-modal-title');
    const modalBody = document.getElementById('preview-modal-body');
    const downloadBtn = document.getElementById('btn-preview-download');

    if (modalTitle) modalTitle.textContent = file.name;
    if (downloadBtn) {
      downloadBtn.href = `/api/vault/download?path=${encodeURIComponent(file.path)}`;
      downloadBtn.setAttribute('download', file.name);
    }

    if (!modalBody) return;
    modalBody.innerHTML = '<div class="animate-spin" style="padding: 3rem;"><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 2a10 10 0 0 1 10 10"/></svg></div>';

    app.openModal('modal-file-preview');

    const previewUrl = `/api/vault/preview?path=${encodeURIComponent(file.path)}`;
    const category = file.category;

    switch (category) {
      case 'image':
        const img = document.createElement('img');
        img.className = 'preview-media-img';
        img.src = previewUrl;
        img.alt = file.name;
        img.onload = () => { modalBody.innerHTML = ''; modalBody.appendChild(img); };
        img.onerror = () => { modalBody.innerHTML = '<p style="color: var(--text-muted); padding: 2rem;">Failed to load image preview.</p>'; };
        break;

      case 'video':
        const video = document.createElement('video');
        video.className = 'preview-media-video';
        video.controls = true;
        video.autoplay = true;
        video.src = previewUrl;
        modalBody.innerHTML = '';
        modalBody.appendChild(video);
        break;

      case 'audio':
        const audioWrapper = document.createElement('div');
        audioWrapper.style.textAlign = 'center';
        audioWrapper.style.width = '100%';
        audioWrapper.innerHTML = `
          <div style="font-size: 3rem; margin-bottom: 1rem; color: var(--accent-amber);">
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
          </div>
          <div style="font-weight: 600; margin-bottom: 1.5rem; color: var(--text-main);">${file.name}</div>
        `;
        const audio = document.createElement('audio');
        audio.className = 'preview-media-audio';
        audio.controls = true;
        audio.autoplay = true;
        audio.src = previewUrl;
        audioWrapper.appendChild(audio);
        modalBody.innerHTML = '';
        modalBody.appendChild(audioWrapper);
        break;

      case 'code':
      case 'document':
        if (file.name.toLowerCase().endsWith('.pdf') || (file.mimetype && file.mimetype.includes('pdf'))) {
          const iframe = document.createElement('iframe');
          iframe.className = 'preview-pdf-frame';
          iframe.src = previewUrl;
          modalBody.innerHTML = '';
          modalBody.appendChild(iframe);
        } else {
          // Fetch text content
          fetch(previewUrl)
            .then(res => res.text())
            .then(text => {
              modalBody.innerHTML = '';
              const pre = document.createElement('pre');
              pre.className = 'preview-code-box';
              pre.textContent = text;
              modalBody.appendChild(pre);
            })
            .catch(() => {
              modalBody.innerHTML = '<p style="color: var(--text-muted); padding: 2rem;">Unable to display text preview.</p>';
            });
        }
        break;

      default:
        modalBody.innerHTML = `
          <div style="text-align: center; padding: 3rem;">
            <div style="font-size: 3rem; margin-bottom: 1rem; color: var(--text-subtle);">
              <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            </div>
            <p style="color: var(--text-muted); margin-bottom: 1.5rem;">No direct preview available for this file type.</p>
            <a href="${previewUrl}" download="${file.name}" class="btn btn-primary">Download File</a>
          </div>
        `;
        break;
    }
  },

  close() {
    const modalBody = document.getElementById('preview-modal-body');
    if (modalBody) {
      // Pause any running audio/video
      const media = modalBody.querySelector('video, audio');
      if (media) media.pause();
      modalBody.innerHTML = '';
    }
    this.currentFile = null;
    app.closeModal('modal-file-preview');
  }
};

window.PreviewController = PreviewController;
