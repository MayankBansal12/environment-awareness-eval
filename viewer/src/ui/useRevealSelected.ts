import { useEffect, useRef } from 'react';

/** Keep the cursor visible inside a scrollable pane without moving the whole page. */
export function useRevealSelected(selector: string, selection: string | number) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const pane = ref.current;
    const selected = pane?.querySelector<HTMLElement>(selector);
    if (!pane || !selected) return;
    const bounds = pane.getBoundingClientRect();
    const item = selected.getBoundingClientRect();
    if (item.top < bounds.top || item.bottom > bounds.bottom)
      pane.scrollTop += item.top - bounds.top;
  }, [selector, selection]);
  return ref;
}
