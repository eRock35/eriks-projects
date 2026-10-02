// Who a scheduled job may spend on, and how much a run may spend at most.
//
// The jobs run with no request and no session, so requireBudget cannot stand
// in front of them. They ask the same questions by uid instead - Trip
// Planner's sweep is the pattern ("The sweep charges the owner"):
//
//   - no shared account any more: skip;
//   - an unconfirmed address on the free allowance: skip (the free $2 is one
//     per PROVED address - identity.mustVerifyForFreeAi);
//   - no credit left: skip;
//   - the free tier's daily ceiling (FREE_TIER_DAILY_CAP_USD, off by default)
//     reached, and they are on the free tier: skip.
//
// And every call is charged to that person (context.clientForUid), never left
// unattributed on the shared key.
//
// The run itself has two ceilings on top of everyone's own budget, so a
// burst of new postings or new users cannot run away with the bill:
// NEXTMOVE_MAX_CALLS_PER_RUN and NEXTMOVE_MAX_USD_PER_RUN.

const identityLib = require('./identity');

function spendsOwnMoney(user) {
  const b = identityLib.budgetFor(user);
  return b.unlimited || identityLib.isMember(user) || Number(user.toppedUpUsd || 0) > 0;
}

/**
 * The shared-account record for `uid` if they may spend now, else {skip: reason}.
 * @returns {account, remainingUsd, tier} | {skip}
 */
async function eligible(identity, identityStore, uid, MODELS) {
  const shared = await identityStore.get('users', uid).catch(() => null);
  if (!shared || shared.disabled) return { skip: 'no-account' };
  const account = { id: uid, ...shared };
  if (identityLib.mustVerifyForFreeAi(account)) return { skip: 'unverified' };
  const b = identityLib.budgetFor(account);
  if (!b.unlimited && !(b.remainingUsd > 0)) return { skip: 'no-credit' };
  if (identity.dailyCapUsd() && !spendsOwnMoney(account)) {
    const today = await identity.spentTodayUsd();
    if (today >= identity.dailyCapUsd()) return { skip: 'free-tier-cap' };
  }
  const plan = identityLib.planFor(account, MODELS);
  return { account, remainingUsd: b.unlimited ? Infinity : b.remainingUsd, plan };
}

/** The run's ceilings, and a tally against them. */
function runCaps(env = process.env, defaults = {}) {
  const calls = Number(env.NEXTMOVE_MAX_CALLS_PER_RUN || defaults.calls || 400);
  const usd = Number(env.NEXTMOVE_MAX_USD_PER_RUN || defaults.usd || 10);
  let spentCalls = 0;
  let spentUsd = 0;
  return {
    limits: { calls, usd },
    canSpend() { return spentCalls < calls && spentUsd < usd; },
    record(model, usage) {
      spentCalls++;
      const c = identityLib.priceOf(model, usage);
      if (typeof c === 'number') spentUsd += c;
      return typeof c === 'number' ? c : 0;
    },
    get calls() { return spentCalls; },
    get usd() { return Math.round(spentUsd * 1e6) / 1e6; },
  };
}

module.exports = { eligible, runCaps, spendsOwnMoney };
