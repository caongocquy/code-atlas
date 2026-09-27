export function checkStockLevels(): number {
  return 12;
}

export function renderStockSummary(): string {
  return `available: ${checkStockLevels()}`;
}

export function refreshWarehouseSummary(): string {
  const count = checkStockLevels();
  return `warehouse bins: ${count}`;
}
