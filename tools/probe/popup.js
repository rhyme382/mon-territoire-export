// Extension popup (separate extension document, never injected into the page). Opening it from the toolbar icon is the user
// gesture that grants activeTab on the current tab; commands then go to the content script over a runtime port.
// A File / ArrayBuffer is not assumed to outlive the popup: the GeoPackage is parsed and exported while the popup is open.
(() => {
  const $ = id => document.getElementById(id);
  const exportButton = $('export-visible'), maskButton = $('toggle-mask'), visibleMessage = $('visible-message'), maskMessage = $('mask-message');
  const setText = (element, text, error = false) => { element.textContent = text || ''; element.className = error ? 'error' : ''; };
  let port = null; let exporting = false;

  const connect = async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (typeof tab?.id !== 'number') throw new Error('no-tab');
      port = chrome.tabs.connect(tab.id, { name: 'mte-popup' });
      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(() => { void chrome.runtime.lastError; port = null; exportButton.disabled = true; maskButton.disabled = true; if (!exporting) setText(visibleMessage, 'Ouvrez Mon Territoire dans cet onglet.', true); });
      port.postMessage({ type: 'mte:mask-state' });
    } catch { port = null; exportButton.disabled = true; maskButton.disabled = true; setText(visibleMessage, 'Ouvrez Mon Territoire dans cet onglet.', true); }
  };

  const onMessage = message => {
    if (message?.type === 'mte:mask') { maskButton.textContent = message.label; setText(maskMessage, message.message || ''); return; }
    if (message?.type !== 'mte:status') return;
    const final = message.phase === 'done' || message.phase === 'error';
    exporting = !final; exportButton.disabled = !final && message.phase !== 'idle';
    setText(visibleMessage, message.text, message.phase === 'error');
  };

  exportButton.addEventListener('click', () => { if (!port || exporting) return; exporting = true; exportButton.disabled = true; setText(visibleMessage, 'Préparation du fond…'); port.postMessage({ type: 'mte:export' }); });
  maskButton.addEventListener('click', () => { if (port) port.postMessage({ type: 'mte:mask-toggle' }); });

  // GeoPackage -> SVG, entirely local: no network, no storage.
  const gpkgFile = $('gpkg-file'), gpkgButton = $('export-svg'), gpkgMessage = $('gpkg-message');
  const saveSvg = (name, svg) => { const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })); link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 10000); };
  const controller = globalThis.MonTerritoireGpkgSvg?.createExportController({ save: saveSvg });
  const renderGpkg = () => {
    const state = controller.state; const loaded = Boolean(state.summary);
    $('gpkg-summary').hidden = !loaded; gpkgButton.disabled = !loaded;
    if (loaded) { $('sum-layer').textContent = state.summary.layer; $('sum-features').textContent = String(state.summary.features); }
    setText(gpkgMessage, { loading: 'Lecture du fichier…', loaded: 'Fichier prêt.', exported: `SVG généré : ${state.fileName}`, error: state.message }[state.status] || '', state.status === 'error');
  };
  if (controller) {
    gpkgFile.addEventListener('change', async () => { const file = gpkgFile.files?.[0]; $('gpkg-name').textContent = file ? file.name : ''; renderGpkg(); const pending = controller.selectFile(file); renderGpkg(); await pending; renderGpkg(); });
    gpkgButton.addEventListener('click', () => { controller.exportSvg(); renderGpkg(); });
  } else { gpkgFile.disabled = true; }

  connect();
})();
