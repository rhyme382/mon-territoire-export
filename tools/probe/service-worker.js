// MVP-06, extension service worker. It owns the only privileged call of the extension: chrome.tabs.captureVisibleTab,
// which content scripts cannot make. It is stateless (no storage, no persisted screenshot) and answers with a closed
// vocabulary: the Chrome error text is classified here and never forwarded.
//
// activeTab is granted by the toolbar click that opens the extension popup (an extension gesture on the tab). The popup then
// commands the content script, whose capture request reaches this worker while the grant lasts (until the tab navigates).
// With action.default_popup, chrome.action.onClicked never fires: there is no click handler here.
const SW_CAPTURE_MESSAGE = 'mte:capture-visible-tab';
const SW_ORIGIN = 'https://carto.monterritoire.fr';
const SW_PNG = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;

function swSenderOrigin(sender) { try { return new URL(sender.url).origin; } catch { return null; } }

export function swClassify(error) {
  return /activeTab|<all_urls>|permission|cannot access/i.test(String(error && error.message || '')) ? 'permission' : 'capture-failed';
}

// api: the `chrome` object (injected for tests). Returns { ok: true, dataUrl } or { ok: false, reason }.
export async function swCapture(api, sender) {
  if (typeof api?.tabs?.captureVisibleTab !== 'function') return { ok: false, reason: 'api-unavailable' };
  if (!sender || sender.id !== api.runtime?.id || !sender.tab || typeof sender.tab.id !== 'number' || (sender.frameId !== undefined && sender.frameId !== 0) || swSenderOrigin(sender) !== SW_ORIGIN) return { ok: false, reason: 'sender-rejected' };
  try {
    // Never screenshot a tab the user switched to meanwhile.
    const active = await api.tabs.query({ active: true, windowId: sender.tab.windowId });
    if (!Array.isArray(active) || active[0]?.id !== sender.tab.id) return { ok: false, reason: 'not-active-tab' };
    const dataUrl = await api.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' });
    return typeof dataUrl === 'string' && SW_PNG.test(dataUrl) ? { ok: true, dataUrl } : { ok: false, reason: 'capture-failed' };
  } catch (error) { return { ok: false, reason: swClassify(error) }; }
}

export function swInstall(api) {
  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== SW_CAPTURE_MESSAGE) return false;
    swCapture(api, sender).then(sendResponse, () => sendResponse({ ok: false, reason: 'capture-failed' }));
    return true; // asynchronous response
  });
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) swInstall(chrome);
