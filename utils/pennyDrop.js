// Bank account verification by penny-drop: the provider deposits ₹1 and
// returns the account holder's registered name, which is compared with the
// name the player entered. No provider has been chosen yet:
//
//   PENNY_DROP_PROVIDER unset → returns null: the bank step stays 'pending'
//                               until a provider (or an admin) verifies it
//   PENNY_DROP_PROVIDER=mock  → treats every account as a name match.
//                               Local development and testing only.
//
// To add a real provider (Razorpay, Cashfree, etc.), add a branch that calls
// it and returns { nameMatch: boolean, providerRef: string }.

async function verifyBankAccount({ accountHolderName, accountNumber, ifsc }) {
  const provider = process.env.PENNY_DROP_PROVIDER;

  if (provider === 'mock') {
    return { nameMatch: Boolean(accountHolderName && accountNumber && ifsc), providerRef: `mock-${Date.now()}` };
  }

  return null;
}

module.exports = { verifyBankAccount };
