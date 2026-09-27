import { dispatchInvoice, validateInvoiceFields } from "./validation.js";

export function submitInvoice(): string {
  if (!validateInvoiceFields()) return "rejected";
  return dispatchInvoice();
}

export function previewInvoice(): number {
  return 42;
}

export function resubmitInvoice(): string {
  return dispatchInvoice();
}
