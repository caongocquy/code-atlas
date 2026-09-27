import { checkStockLevels, renderStockSummary } from "./availability.js";

export function placeBackorder(): number {
  const stock = checkStockLevels();
  return stock > 0 ? stock : 1;
}

export function describeAvailability(): string {
  return renderStockSummary();
}

export function reserveWarehouseUnits(): number {
  return checkStockLevels();
}
