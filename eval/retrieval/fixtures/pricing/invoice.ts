import { calculateTax, type TaxPolicy } from "./tax.js";

export function calculateInvoice(subtotal: number, policy: TaxPolicy): number {
  return subtotal + calculateTax(subtotal, policy);
}

export function createInvoice(subtotal: number, policy: TaxPolicy): number {
  return calculateInvoice(subtotal, policy);
}
