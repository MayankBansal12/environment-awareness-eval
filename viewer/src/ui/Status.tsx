export function Status({ valid, censored }: { valid: boolean; censored: boolean }) {
  if (!valid)
    return (
      <span className="status critical" title="Excluded from aggregates">
        ✕ invalid
      </span>
    );
  if (censored)
    return (
      <span className="status warning" title="Hit the wall-clock or token guard">
        ◐ censored
      </span>
    );
  return <span className="status good">✓ valid</span>;
}
