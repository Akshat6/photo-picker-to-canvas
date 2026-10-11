'use strict';

/**
 * Photo Picker to Canvas v0.3.2 — experimental mobile plugin for ORIGINAL Obsidian Canvas.
 * Uses the public Vault API for saving images and undocumented Canvas methods to insert cards.
 */
const { Plugin, ItemView, Modal, Notice, PluginSettingTab, Setting } = require('obsidian');

const DEFAULT_SETTINGS = {
  horizontalOffset: 16,
  verticalOffset: 16,
  photosFolder: 'Canvas Photos'
};

function validGap(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 10000 ? n : null;
}

function normalizedFolder(raw) {
  const path = String(raw ?? '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!path) throw new Error('Photo folder cannot be empty');
  const parts = path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part))) {
    throw new Error('Invalid photo folder; use a simple vault-relative folder name');
  }
  return path;
}

function getSelectedCard(canvas) {
  if (!canvas || typeof canvas.getData !== 'function') return null;
  const data = canvas.getData();
  if (!data || !Array.isArray(data.nodes)) return null;
  const ids = new Set(Array.from(canvas.selection ?? []).map(item => item?.id).filter(Boolean));
  const selected = data.nodes.filter(node => ids.has(node.id));
  if (selected.length !== 1 || selected[0].type !== 'file') return null;
  const node = selected[0];
  if (![node.x, node.y, node.width, node.height].every(Number.isFinite)) return null;
  if (node.width <= 0 || node.height <= 0) return null;
  return { id: node.id, x: node.x, y: node.y, width: node.width, height: node.height };
}

function imageCardSize(anchor, naturalSize) {
  // Match width of the selected page; preserve photographed page's aspect ratio.
  const width = anchor.width;
  const ratio = naturalSize && naturalSize.width > 0 && naturalSize.height > 0
    ? naturalSize.height / naturalSize.width
    : anchor.height / anchor.width;
  return { width, height: Math.max(60, Math.round(width * ratio)) };
}

function computePosition(anchor, direction, settings, cardSize) {
  const horizontalGap = validGap(settings.horizontalOffset);
  const verticalGap = validGap(settings.verticalOffset);
  if (horizontalGap === null || verticalGap === null) throw new Error('Invalid offset settings');
  if (direction === 'horizontal') {
    return { x: anchor.x + anchor.width + horizontalGap, y: anchor.y, ...cardSize };
  }
  if (direction === 'vertical') {
    return { x: anchor.x, y: anchor.y + anchor.height + verticalGap, ...cardSize };
  }
  throw new Error('Unknown direction');
}

function newCanvasData(existing, anchorId, direction, settings, filePath, size, id) {
  if (!existing || !Array.isArray(existing.nodes)) {
    throw new Error('Canvas data is unavailable');
  }
  const anchor = existing.nodes.find(node => node.id === anchorId);
  if (!anchor || anchor.type !== 'file') throw new Error('The selected page no longer exists');
  const pos = computePosition(anchor, direction, settings, size);
  const node = { id, type: 'file', file: filePath, ...pos };
  // Preserve other nodes, edges, and any plugin-added document metadata unchanged.
  return { ...existing, edges: Array.isArray(existing.edges) ? existing.edges : [], nodes: [...existing.nodes, node] };
}

function extensionForPhoto(file) {
  const mime = String(file.type || '').toLowerCase();
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/heic') return 'heic';
  if (mime === 'image/heif') return 'heif';
  const ext = String(file.name || '').toLowerCase().match(/\.(jpg|jpeg|png|webp|heic|heif)$/);
  return ext ? (ext[1] === 'jpeg' ? 'jpg' : ext[1]) : null;
}

function uniqueNodeId() {
  // JSON Canvas recommends a unique ID, no mandated generation algorithm.
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

async function readImageBinary(file) {
  // On some Android WebViews the picker-supplied File does not expose Blob.arrayBuffer().
  if (typeof file.arrayBuffer === 'function') {
    try {
      const binary = await file.arrayBuffer();
      if (binary instanceof ArrayBuffer) return binary;
    } catch (_) { /* Try FileReader below. */ }
  }
  if (typeof FileReader === 'undefined') {
    throw new Error('Android could not read this photo (arrayBuffer and FileReader unavailable)');
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => reader.result instanceof ArrayBuffer
      ? resolve(reader.result)
      : reject(new Error('Selected image could not be read as binary'));
    reader.onerror = () => reject(reader.error || new Error('FileReader failed to read image'));
    reader.onabort = () => reject(new Error('Photo reading was cancelled'));
    try { reader.readAsArrayBuffer(file); }
    catch (error) { reject(error); }
  });
}

async function getPhotoDimensions(photo) {
  // Dimensions are optional: failing to decode a camera photo should not block its import.
  try {
    if (typeof createImageBitmap === 'function') {
      try {
        const bmp = await createImageBitmap(photo);
        const size = { width: bmp.width, height: bmp.height };
        if (typeof bmp.close === 'function') bmp.close();
        return size;
      } catch (_) { /* Fall back to HTMLImageElement. */ }
    }
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function' || typeof Image === 'undefined') return null;
    let url;
    try { url = URL.createObjectURL(photo); } catch (_) { return null; }
    try {
      return await new Promise(resolve => {
        const img = new Image();
        img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = () => resolve(null);
        img.src = url;
      });
    } finally { try { URL.revokeObjectURL(url); } catch (_) {} }
  } catch (_) { return null; }
}

class OrientationModal extends Modal {
  constructor(app, onPick) {
    super(app);
    this.onPick = onPick;
    this.chosen = false;
  }
  onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass('ctc-orientation-modal');
    this.contentEl.createEl('h3', { text: 'Where should this image go?' });
    this.contentEl.createEl('p', {
      text: 'Position the chosen image relative to the selected Canvas card. Existing cards will not move.'
    });
    const row = this.contentEl.createDiv({ cls: 'ctc-orientation-buttons' });
    const choices = [
      ['horizontal', '→  Horizontal', 'Right of selected page'],
      ['vertical', '↓  Vertical', 'Below selected page']
    ];
    for (const [direction, text, description] of choices) {
      const btn = row.createEl('button', { cls: 'ctc-orientation-choice' });
      btn.createEl('strong', { text });
      btn.createEl('small', { text: description });
      btn.addEventListener('click', () => {
        if (this.chosen) return;
        this.chosen = true;
        this.close();
        void this.onPick(direction);
      });
    }
    const cancel = this.contentEl.createEl('button', { text: 'Cancel', cls: 'ctc-cancel' });
    cancel.addEventListener('click', () => this.close());
  }
  onClose() { this.contentEl.empty(); }
}

class PhotoPickerToCanvas extends Plugin {
  async onload() {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData() || {}) };
    this.pendingInput = null;
    this.shuttingDown = false;
    this.lastError = this.settings.lastError || '';
    this.addSettingTab(new PhotoPickerSettingsTab(this.app, this));

    this.addCommand({
      id: 'pick-one-image-on-canvas',
      name: 'Choose an image and place beside/below selected Canvas page',
      checkCallback: checking => {
        const view = this.activeCanvasView();
        if (!view) return false;
        if (!checking) this.pickFrom(view);
        return true;
      }
    });
    this.addRibbonIcon('image-plus', 'Canvas: choose one image', () => this.pickFrom());
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.scheduleButton()));
    this.registerEvent(this.app.workspace.on('layout-change', () => this.scheduleButton()));
    this.registerEvent(this.app.workspace.on('file-open', () => this.scheduleButton()));
    this.app.workspace.onLayoutReady(() => this.scheduleButton());
  }

  onunload() {
    this.shuttingDown = true;
    if (this.pendingInput) {
      this.pendingInput.remove();
      this.pendingInput = null;
    }
    document.querySelectorAll('.ctc-picker-on-canvas').forEach(el => el.remove());
  }

  activeCanvasView() {
    const v = this.app.workspace.getActiveViewOfType(ItemView);
    return v && v.getViewType?.() === 'canvas' && v.canvas && v.file ? v : null;
  }

  scheduleButton() {
    window.setTimeout(() => {
      if (this.shuttingDown) return;
      const view = this.activeCanvasView();
      if (!view) return;
      if (view.containerEl.querySelector('.ctc-picker-on-canvas')) return;
      view.containerEl.addClass('ctc-canvas-view');
      const btn = view.containerEl.createEl('button', {
        cls: 'ctc-picker-on-canvas',
        text: '🖼  Pick image',
        attr: { type: 'button', title: 'Choose one photo and add to this Canvas' }
      });
      let snapshot = null;
      this.registerDomEvent(btn, 'pointerdown', evt => {
        evt.stopPropagation();
        snapshot = this.getContext(view, true);
      });
      this.registerDomEvent(btn, 'click', evt => {
        evt.preventDefault();
        evt.stopPropagation();
        const remembered = snapshot;
        snapshot = null;
        this.pickFrom(view, remembered);
      });
    }, 80);
  }

  getContext(view, silent = false) {
    if (!view || !view.canvas || !view.file) return null;
    const canvas = view.canvas;
    if (typeof canvas.getData !== 'function' || typeof canvas.setData !== 'function' ||
        typeof canvas.requestSave !== 'function') {
      if (!silent) new Notice('This Obsidian Canvas version is not compatible with this experimental plugin.');
      return null;
    }
    const card = getSelectedCard(canvas);
    if (!card) {
      if (!silent) new Notice('Select exactly one image or PDF page on the Canvas first.');
      return null;
    }
    return { canvasPath: view.file.path, anchorId: card.id };
  }

  findOriginalCanvas(context) {
    const leaves = this.app.workspace.getLeavesOfType('canvas') || [];
    const view = leaves.map(leaf => leaf.view).find(view => view?.file?.path === context.canvasPath && view?.canvas);
    return view?.canvas || null;
  }

  pickFrom(view = null, rememberedContext = null) {
    const targetView = view || this.activeCanvasView();
    const context = rememberedContext || this.getContext(targetView);
    if (!context) return;
    if (this.pendingInput) {
      new Notice('Finish or cancel the current image selection first.');
      return;
    }
    // Must be invoked synchronously during a tap so Android opens its image picker.
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    document.body.appendChild(input);
    this.pendingInput = input;
    const cleanup = () => {
      if (this.pendingInput === input) this.pendingInput = null;
      input.remove();
    };
    // IMPORTANT: Android picker File references can stop being readable after the
    // input element is removed or after a modal is opened. Keep the input alive
    // and copy the binary into memory BEFORE displaying the placement dialog.
    input.addEventListener('change', () => {
      void this.handlePickedImage(input, context, cleanup);
    }, { once: true });
    input.addEventListener('cancel', cleanup, { once: true });
    try { input.click(); } catch (err) {
      cleanup();
      console.error('[Photo Picker to Canvas] Picker failed', err);
      new Notice('The Android image picker could not be opened.');
    }
  }

  async handlePickedImage(input, context, cleanup) {
    try {
      const file = input.files && input.files[0];
      if (!file) return;
      const extension = extensionForPhoto(file);
      if ((file.type && !file.type.startsWith('image/')) || !extension) {
        new Notice('Please choose one image file.');
        return;
      }
      // Start reading right now, while the Android picker grant and input
      // element are still active. No orientation modal or slow image decode yet.
      const bytes = await readImageBinary(file);
      if (!(bytes instanceof ArrayBuffer) || bytes.byteLength === 0) {
        throw new Error('The selected photograph was empty or unreadable.');
      }
      const photo = {
        name: file.name || 'Photo',
        type: file.type || 'image/' + (extension === 'jpg' ? 'jpeg' : extension),
        extension,
        bytes
      };
      cleanup();
      new OrientationModal(this.app, direction => this.placePhoto(context, photo, direction)).open();
    } catch (err) {
      const message = String(err && (err.message || err) || 'Unknown error');
      const report = `Step: Reading image immediately from Android photo picker\nError: ${message}\n` +
        'The picker returned a file that Android could not read. Try selecting a local copy ' +
        'using Browse / My Files instead of a cloud-backed photo or Samsung Gallery provider.';
      this.lastError = report;
      this.settings.lastError = report;
      try { await this.saveSettings(); } catch (savingErr) {
        console.error('[Photo Picker to Canvas] Error storing diagnostic', savingErr);
      }
      console.error('[Photo Picker to Canvas v0.3.2]', report, err);
      new Notice('Cannot read selected image. Try choosing it through My Files. See plugin settings for details.', 14000);
    } finally {
      cleanup();
    }
  }

  async ensurePhotoFolder(folder) {
    let path = '';
    for (const part of folder.split('/')) {
      path = path ? `${path}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (!existing) await this.app.vault.createFolder(path);
      else if (!existing.children) throw new Error(`A file already exists with the folder name: ${path}`);
    }
  }

  async savePhoto(photo) {
    const folder = normalizedFolder(this.settings.photosFolder);
    await this.ensurePhotoFolder(folder);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/[TZ.]/g, '-');
    const ext = photo.extension || extensionForPhoto(photo);
    if (!ext) throw new Error('Unsupported image format');
    let path;
    do {
      path = `${folder}/Page-${stamp}-${Math.random().toString(36).slice(2, 9)}.${ext}`;
    } while (this.app.vault.getAbstractFileByPath(path));
    return this.app.vault.createBinary(path, photo.bytes);
  }

  async placePhoto(context, photo, direction) {
    let stage = 'Starting';
    let savedPhoto = null;
    try {
      stage = 'Locating current Canvas';
      let canvas = this.findOriginalCanvas(context);
      if (!canvas) throw new Error('Original Canvas is no longer open');

      stage = 'Checking selected page';
      let data = canvas.getData();
      if (!data || !Array.isArray(data.nodes)) throw new Error('Canvas nodes could not be read');
      const anchor = data.nodes.find(node => node.id === context.anchorId);
      if (!anchor) throw new Error('Previously selected page is no longer on this Canvas');

      stage = 'Reading photo dimensions';
      const localImage = new Blob([photo.bytes], { type: photo.type || 'image/jpeg' });
      const dimension = await getPhotoDimensions(localImage);
      const size = imageCardSize(anchor, dimension);
      stage = 'Checking placement offsets';
      computePosition(anchor, direction, this.settings, size);

      stage = 'Saving photograph in vault';
      savedPhoto = await this.savePhoto(photo);

      stage = 'Finding Canvas after image picker';
      canvas = this.findOriginalCanvas(context);
      if (!canvas) throw new Error('Photo saved, but original Canvas was closed');
      stage = 'Preparing the new image card';
      data = canvas.getData();
      const updated = newCanvasData(data, context.anchorId, direction, this.settings,
        savedPhoto.path, size, uniqueNodeId());

      stage = 'Inserting card into live Canvas';
      await canvas.setData(updated);
      stage = 'Saving Canvas layout';
      canvas.requestSave(false);

      this.lastError = '';
      this.settings.lastError = '';
      new Notice(`Photo added ${direction === 'horizontal' ? 'to the right' : 'below'} the selected page.`);
    } catch (err) {
      const detail = String(err && (err.message || err) || 'Unknown error');
      const extra = savedPhoto ? ` Photo was saved in: ${savedPhoto.path}` : ' No image card was added.';
      const report = `Step: ${stage}\nError: ${detail}\n${extra}`;
      this.lastError = report;
      this.settings.lastError = report;
      try { await this.saveSettings(); } catch (savingErr) { console.error('[Photo Picker to Canvas] Could not store last error', savingErr); }
      console.error('[Photo Picker to Canvas v0.3.2]', report, err);
      new Notice(`Photo Picker error at: ${stage}\n${detail.slice(0, 220)}\nSee plugin settings for full diagnostic.`, 14000);
    }
  }

  async saveSettings() { await this.saveData(this.settings); }
}

class PhotoPickerSettingsTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Photo Picker to Canvas' });
    containerEl.createEl('p', {
      text: 'Select ONE image or PDF-page card on the original Canvas, tap Pick image, select a photo from Android’s picker, then choose Horizontal or Vertical.'
    });
    new Setting(containerEl)
      .setName('Horizontal offset (gap)')
      .setDesc('Distance in Canvas units between the selected card’s right edge and the new photo’s left edge. Zero means touching.')
      .addText(input => {
        input.inputEl.type = 'number';
        input.inputEl.min = '0';
        input.inputEl.max = '10000';
        input.inputEl.step = '1';
        input.setValue(String(this.plugin.settings.horizontalOffset))
          .onChange(async value => {
            if (value.trim() === '') return;
            const gap = validGap(value);
            if (gap !== null) {
              this.plugin.settings.horizontalOffset = gap;
              await this.plugin.saveSettings();
            }
          });
      });
    new Setting(containerEl)
      .setName('Vertical offset (gap)')
      .setDesc('Distance in Canvas units between the selected card’s bottom edge and the new photo’s top edge.')
      .addText(input => {
        input.inputEl.type = 'number';
        input.inputEl.min = '0';
        input.inputEl.max = '10000';
        input.inputEl.step = '1';
        input.setValue(String(this.plugin.settings.verticalOffset))
          .onChange(async value => {
            if (value.trim() === '') return;
            const gap = validGap(value);
            if (gap !== null) {
              this.plugin.settings.verticalOffset = gap;
              await this.plugin.saveSettings();
            }
          });
      });
    new Setting(containerEl)
      .setName('Image storage folder')
      .setDesc('Vault-relative folder. Default: Canvas Photos. The chosen image is copied into the vault once without compression.')
      .addText(input => input.setValue(this.plugin.settings.photosFolder)
        .onChange(async value => {
          try {
            this.plugin.settings.photosFolder = normalizedFolder(value);
            await this.plugin.saveSettings();
          } catch (_) { /* keep previous valid folder if temporary input invalid */ }
        }));
    new Setting(containerEl)
      .setName('Last error (for troubleshooting)')
      .setDesc('If importing fails, copy this report into ChatGPT. It records the exact stage and error message, without accessing the photo itself.')
      .addButton(btn => btn.setButtonText('Copy last error').onClick(async () => {
        const report = this.plugin.lastError || this.plugin.settings.lastError || 'No recorded error';
        try { await navigator.clipboard.writeText(report); new Notice('Diagnostic copied.'); }
        catch (_) { new Notice(report, 14000); }
      }));
    containerEl.createEl('pre', {
      cls: 'ctc-error-report',
      text: this.plugin.lastError || this.plugin.settings.lastError || 'No recorded error'
    });
    containerEl.createEl('p', {
      text: 'This version deliberately uses the Android image picker, not the camera. It preserves existing cards. Canvas editing APIs are undocumented; test on a duplicate Canvas first.',
      cls: 'ctc-settings-note'
    });
  }
}

module.exports = PhotoPickerToCanvas;
module.exports.__test = { validGap, normalizedFolder, getSelectedCard, imageCardSize, computePosition, newCanvasData, extensionForPhoto, readImageBinary };
