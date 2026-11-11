/** Rates by currency: US sales tax, and VAT for EUR and GBP. Order totals are tax-inclusive. */
export const TAX_RATES: Record<string, number> = { USD: 0.0825, EUR: 0.2, GBP: 0.2 };

export function taxRate(currency: string): number {
  const rate = TAX_RATES[currency];
  if (rate === undefined) throw new Error(`no tax rule for currency ${currency}`);
  return rate;
}

/** Splits a tax-inclusive total, so the invoice total always equals what the customer paid. */
export function splitInclusive(total: number, currency: string): { subtotal: number; tax: number; rate: number } {
  const rate = taxRate(currency);
  const tax = Math.round((total * rate) / (1 + rate));
  return { subtotal: total - tax, tax, rate };
}

export const formatMoney = (minor: number, currency: string) => `${currency} ${(minor / 100).toFixed(2)}`;
