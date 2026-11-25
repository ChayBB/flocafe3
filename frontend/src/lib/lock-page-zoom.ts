/** Keeps a phone menu page at its fitted scale: iOS Safari ignores user-scalable=no, so pinch and double-tap zoom are blocked here. */
export function lockPageZoom(): () => void {
  const style = document.createElement('style');
  style.textContent = 'html{touch-action:pan-x pan-y}';
  document.head.appendChild(style);
  const block = (event: Event) => event.preventDefault();
  const onTouchMove = (event: TouchEvent) => {
    if (event.touches.length > 1) event.preventDefault();
  };
  const gestures = ['gesturestart', 'gesturechange', 'gestureend'] as const;
  for (const name of gestures) document.addEventListener(name, block, { passive: false });
  document.addEventListener('touchmove', onTouchMove, { passive: false });
  return () => {
    style.remove();
    for (const name of gestures) document.removeEventListener(name, block);
    document.removeEventListener('touchmove', onTouchMove);
  };
}
