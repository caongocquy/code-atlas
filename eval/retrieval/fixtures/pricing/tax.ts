export interface TaxPolicy {
  rateFor(region: string): number;
}

export class StandardTaxPolicy implements TaxPolicy {
  rateFor(region: string): number {
    return region === "CA" ? 0.0825 : 0.05;
  }
}

export function calculateTax(amount: number, policy: TaxPolicy): number {
  return amount * policy.rateFor("CA");
}
