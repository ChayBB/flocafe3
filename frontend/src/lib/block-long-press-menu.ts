const TEXT_ENTRY = 'input, textarea, [contenteditable="true"]';

/** A long press opens the browser's page or image menu; touch screens here only need taps. */
export function blockLongPressMenu(): () => void {
  const style = document.createElement('style');
  style.textContent = `html{-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}img{-webkit-user-drag:none}${TEXT_ENTRY}{-webkit-touch-callout:default;-webkit-user-select:text;user-select:text}`;
  document.head.appendChild(style);
  const onContextMenu = (event: Event) => {
    if (!(event.target instanceof Element && event.target.closest(TEXT_ENTRY))) {
      event.preventDefault();
    }
  };
  const onDragStart = (event: Event) => {
    if (event.target instanceof HTMLImageElement) event.preventDefault();
  };
  document.addEventListener('contextmenu', onContextMenu, { capture: true });
  document.addEventListener('dragstart', onDragStart, { capture: true });
  return () => {
    style.remove();
    document.removeEventListener('contextmenu', onContextMenu, { capture: true });
    document.removeEventListener('dragstart', onDragStart, { capture: true });
  };
}
