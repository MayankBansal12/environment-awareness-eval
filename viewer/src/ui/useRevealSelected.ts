import { useEffect, useRef } from 'react';

/** Keep the cursor visible inside a scrollable pane without moving the whole page. */
export function useRevealSelected(selector: string, selection: string | number) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const pane = ref.current;
    if (!pane) return;
    const reveal = () => {
      const selected = pane.querySelector<HTMLElement>(selector);
      if (!selected) return;
      const bounds = pane.getBoundingClientRect();
      const item = selected.getBoundingClientRect();
      if (
        item.top < bounds.top ||
        item.top >= bounds.bottom ||
        (item.height <= bounds.height && item.bottom > bounds.bottom)
      )
        pane.scrollTop += item.top - bounds.top;
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(pane);
    return () => observer.disconnect();
  }, [selector, selection]);
  return ref;
}
