export interface Env {
  AMEX_SYNC_KV: KVNamespace;

  MONZO_CLIENT_ID: string;
  MONZO_CLIENT_SECRET: string;
  MONZO_ACCOUNT_ID: string; // source account to withdraw the sweep from
  MONZO_POT_ID: string; // destination "Amex" pot

  TRUELAYER_CLIENT_ID: string;
  TRUELAYER_CLIENT_SECRET: string;
  TRUELAYER_CARD_ACCOUNT_ID: string; // account_id from GET /data/v1/cards

  // Optional: set this to a URL (e.g. a Slack/Discord webhook or
  // healthchecks.io ping) to get notified when a sync run fails,
  // e.g. because the TrueLayer consent has expired.
  ALERT_WEBHOOK_URL?: string;

  // A secret you make up yourself, used only to authorise manual
  // triggers of this Worker over HTTP. Not a Monzo/TrueLayer credential.
  WORKER_AUTH_SECRET: string;
}

export interface TokenSet {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
}

export interface TrueLayerTransaction {
  transaction_id: string;
  timestamp: string;
  description: string;
  amount: number; // positive for spend on a card transaction
  currency: string;
  transaction_type: string; // "DEBIT" | "CREDIT"
  transaction_category?: string;
  merchant_name?: string;
}

export interface TrueLayerCardBalance {
  available: number;
  current: number; // outstanding balance on the card
  credit_limit?: number;
  last_statement_balance?: number;
  payment_due?: number;
  currency: string;
  update_timestamp?: string;
}

// The subset of a Monzo /transactions entry the in-flight payment
// detection reads. `amount` is signed pence from the current account's
// side: negative = money out.
export interface MonzoTransaction {
  id: string;
  created: string; // ISO
  amount: number;
  description: string;
  scheme: string; // e.g. "bacs" (DD), "payport_faster_payments", "uk_retail_pot"
  decline_reason?: string;
  counterparty?: { name?: string };
}

// A spend pushed from the iPhone Shortcut the instant it happens on
// Apple Wallet, before TrueLayer shows it. The reconcile counts these
// toward the pot target until the matching transaction appears in
// TrueLayer's data (pending or posted), or the record ages out.
export interface PushRecord {
  id: string; // uuid; also the Monzo dedupe_id for the deposit
  amount_pence: number;
  pushed_at: string; // ISO
  note?: string; // optional merchant text from the Shortcut
}
