export function allocate(levels, quantity) {
  const ordered = [...levels].sort(
    (a, b) => a.priority - b.priority,
  );
  let remaining = quantity;
  const lines = [];
  for (const level of ordered) {
    if (remaining === 0) break;
    const available = level.onHand;
    const take = Math.min(available, remaining);
    if (take > 0) {
      lines.push({ warehouse: level.warehouse, quantity: take });
      remaining -= take;
    }
  }
  return { lines, backorderQuantity: remaining };
}
