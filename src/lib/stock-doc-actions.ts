/** Read-only UI hints, never an authorization token. Every write rechecks the database. */
export interface StockDocActionHints {
  submit: boolean;
  withdraw: boolean;
  void: boolean;
  approve: boolean;
  shortClose: boolean;
  reverse: boolean;
  reason: string | null;
}
