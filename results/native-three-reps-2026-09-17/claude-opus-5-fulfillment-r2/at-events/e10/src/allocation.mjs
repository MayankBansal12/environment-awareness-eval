const compareWarehouse = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function allocate(levels, quantity) {
  const ordered = [...levels].sort(
    (a, b) => a.priority - b.priority || compareWarehouse(a.warehouse, b.warehouse),
  );
  let remaining = quantity;
  const lines = [];
  for (const level of ordered) {
    if (remaining === 0) break;
    const available = Math.max(0, level.onHand - (level.held ?? 0));
    const take = Math.min(available, remaining);
    if (take > 0) {
      lines.push({ warehouse: level.warehouse, quantity: take });
      remaining -= take;
    }
  }
  return { lines, backorderQuantity: remaining };
}
