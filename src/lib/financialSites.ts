/** Banks, payments and exchanges: "Import cookies" shows them, but leaves them unticked, so signing
 *  the agent's browser in to them is a choice. */
const FINANCIAL = /bank|banco|banca|paypal|stripe|bbva|santander|caixa|sabadell|bankinter|chase|wellsfargo|citi|hsbc|barclays|revolut|wise\.com|n26|monzo|coinbase|binance|kraken|schwab|fidelity|vanguard|robinhood|americanexpress|amex|mastercard|visa\.|klarna|venmo|mercadopago/i;

export const isFinancialSite = (site: string) => FINANCIAL.test(site);
