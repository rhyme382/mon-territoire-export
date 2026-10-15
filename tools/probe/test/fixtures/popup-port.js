// Fake extension popup side of the runtime port the content script listens on (chrome.tabs.connect from the popup).
export function popupHarness({ id = 'ext' } = {}) {
  const connectListeners = [];
  const runtime = { id, onConnect: { addListener: fn => connectListeners.push(fn) } };
  function open({ sender = { id }, name = 'mte-popup' } = {}) {
    const posted = []; const messageListeners = []; const disconnectListeners = [];
    const port = { name, sender, postMessage: message => posted.push(message), onMessage: { addListener: fn => messageListeners.push(fn) }, onDisconnect: { addListener: fn => disconnectListeners.push(fn) } };
    for (const listener of connectListeners) listener(port);
    return {
      port, posted,
      send: message => { for (const listener of messageListeners) listener(message); },
      close: () => { for (const listener of disconnectListeners) listener(); },
      exportVisible() { this.send({ type: 'mte:export' }); },
      toggleMask() { this.send({ type: 'mte:mask-toggle' }); },
      statuses: () => posted.filter(message => message.type === 'mte:status'),
      lastStatus: () => posted.filter(message => message.type === 'mte:status').at(-1),
      lastMask: () => posted.filter(message => message.type === 'mte:mask').at(-1),
    };
  }
  return { runtime, connectListeners, open };
}
