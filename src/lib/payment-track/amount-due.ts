/** Only confirmed customer receipts reduce Amount Due; rebates and pending receipts do not. */
export function confirmedCustomerPayments(project: {
  deposit: { confirmedAmountCents: number | null };
  collection: { confirmedAmountCents: number | null };
  finalPayments?: Array<{ confirmedAmountCents: number | null }>;
}) {
  return (project.deposit.confirmedAmountCents || 0)
    + (project.collection.confirmedAmountCents || 0)
    + (project.finalPayments || []).reduce((sum, payment) => sum + (payment.confirmedAmountCents || 0), 0);
}
export const MAX_RECEIVABLE_CENTS = 100_000_000_000;
