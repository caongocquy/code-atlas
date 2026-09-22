export function normalizeTerm(value) {
  return String(value).trim().toLowerCase().replace(/\s+/g, " ");
}
