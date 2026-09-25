import type { MonzoTransaction, TrueLayerTransaction } from "./types";

// ---------------------------------------------------------------------------
// In-flight card payments
//
// A payment to Amex (the monthly DD, or a manual transfer) leaves Monzo
// immediately but can take days to land on the card — until then
// TrueLayer's `current` still includes it, so the reconcile would see a
// stale high target and refund the pot from the current account. So
// payments seen leaving Monzo are subtracted from the target until the
// matching payment CREDIT shows up on TrueLayer (pending or posted), at
// which point `current` already reflects it.
//
// Stateless: re-derived every run from the last PAYMENT_LOOKBACK_MS of
// Monzo transactions, so a payment that never matches simply stops
// counting once it ages out of the window.
//
// Observed shapes (manual £1 test, 2026-09-25):
//   Monzo:     scheme payport_faster_payments, counterparty.name
//              "AMERICAN EXP nnnn" (truncated — "american express"
//              doesn't match), description = a payment reference.
//   TrueLayer: pending CREDIT, amount -1.00 (negative), description
//              "PAYMENT RECEIVED - THANK YOU", timestamp 00:00Z on the
//              payment date; `current` dropped at the same time.
// DD: shows on Monzo as "American Express" (per the account holder; not
// yet observed via the API — first one due ~15 Oct 2026).
// ---------------------------------------------------------------------------

export const PAYMENT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

const CARD_PAYEE_RE = /american\s*exp|amex/i;
const CARD_PAYMENT_CREDIT_RE = /payment received/i;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface InFlightPayment {
  id: string; // Monzo transaction id
  amount_pence: number; // positive
  created: string;
}

/** Pence value of a TrueLayer amount, sign dropped (CREDITs come back negative). */
export function absPence(t: TrueLayerTransaction): number {
  return Math.abs(Math.round(t.amount * 100));
}

/** A payment towards the card balance, as opposed to e.g. a merchant refund. */
export function isCardPaymentCredit(t: TrueLayerTransaction): boolean {
  return t.transaction_type === "CREDIT" && CARD_PAYMENT_CREDIT_RE.test(t.description);
}

function isToOrFromCard(t: MonzoTransaction): boolean {
  if (t.decline_reason) return false;
  // Pot transfers (incl. the pot side of a pay-from-pot DD) and Monzo
  // card spend at an Amex-named merchant aren't payments to the card.
  if (t.scheme === "uk_retail_pot" || t.scheme === "mastercard") return false;
  return CARD_PAYEE_RE.test(`${t.counterparty?.name ?? ""} ${t.description}`);
}

/**
 * Monzo payments to the card that TrueLayer doesn't show as landed yet.
 * `cardTxns` is TrueLayer pending + recent posted, any type — only
 * payment CREDITs are used. Each credit matches at most one payment, of
 * the same amount, dated no earlier than the day before the payment
 * (so an older same-amount payment's credit can't match). A returned
 * payment (money back in from the payee) cancels one of the same amount.
 */
export function findInFlightPayments(
  monzoTxns: MonzoTransaction[],
  cardTxns: TrueLayerTransaction[]
): InFlightPayment[] {
  const card = monzoTxns.filter(isToOrFromCard);

  const returned = new Map<number, number>();
  for (const t of card) {
    if (t.amount > 0) returned.set(t.amount, (returned.get(t.amount) ?? 0) + 1);
  }

  const credits = cardTxns
    .filter(isCardPaymentCredit)
    .map((t) => ({ pence: absPence(t), at: Date.parse(t.timestamp) }));

  const inFlight: InFlightPayment[] = [];
  const payments = card
    .filter((t) => t.amount < 0)
    .sort((a, b) => a.created.localeCompare(b.created));
  for (const t of payments) {
    const pence = -t.amount;
    const ret = returned.get(pence) ?? 0;
    if (ret > 0) {
      returned.set(pence, ret - 1);
      continue;
    }
    const earliest = Math.floor(Date.parse(t.created) / DAY_MS) * DAY_MS - DAY_MS;
    const i = credits.findIndex((c) => c.pence === pence && c.at >= earliest);
    if (i >= 0) {
      credits.splice(i, 1);
      continue;
    }
    inFlight.push({ id: t.id, amount_pence: pence, created: t.created });
  }
  return inFlight;
}
