// Local presentation control for the territorial mask. It only toggles the inline
// `display` of the page's own `.leaflet-mask-pane` element; it never touches
// SOGEFI objects, authorizations, requests or responses, and persists nothing:
// a page reload restores the site's normal behaviour.
export const MASK_PANE_SELECTOR = '.leaflet-mask-pane';
export const MASK_LABELS = Object.freeze({ visible: 'Masquer le masque', hidden: 'Afficher le masque', absent: 'Masquer le masque' });
export const MASK_ABSENT_MESSAGE = 'Masque non détecté';

export function createMaskControl(doc) {
  let previousDisplay = '';
  const pane = () => doc.querySelector(MASK_PANE_SELECTOR);
  // The DOM is the single source of truth, so the label can never drift from reality.
  const state = () => { const element = pane(); return !element ? 'absent' : element.style.display === 'none' ? 'hidden' : 'visible'; };
  const toggle = () => {
    const element = pane();
    if (!element) return 'absent';
    if (element.style.display === 'none') element.style.display = previousDisplay;
    else { previousDisplay = element.style.display; element.style.display = 'none'; }
    return state();
  };
  return { state, toggle, label: () => MASK_LABELS[state()] };
}

globalThis.MonTerritoireMaskControl = { createMaskControl, MASK_PANE_SELECTOR, MASK_LABELS, MASK_ABSENT_MESSAGE };
