import { PENALTY_BPS, BPS_TOTAL } from './lock'

// Derived, not typed out, so the copy cannot drift from the contract constant it
// describes. PENALTY_BPS mirrors BucketLock.PENALTY_BPS.
const PENALTY_PCT = `${Number(PENALTY_BPS * 100n / BPS_TOTAL)}%`
// The smallest early withdrawal that leaves the owner anything: ceiling rounding
// takes the whole of a single raw unit, so two is the floor.
const MIN_EARLY_WITHDRAWAL = '0.000002 USDC'

export const splitErrors: Record<string, string> = {
  TooManyBuckets:      'You have reached the maximum of 10 buckets.',
  BucketNotFound:      'Bucket not found.',
  ExceedsBPS:          'This allocation would take your total above 100%.',
  InvalidBPSTotal:     'Your bucket rules must total exactly 100% before depositing.',
  InsufficientBalance: 'Not enough balance in this bucket.',
  NotScheduler:        'Only the scheduler can execute this.',
  TooEarly:            'Scheduled send is not due yet.',
  InvalidInterval:     'Minimum schedule interval is 1 day.',
  NoBuckets:           'Set up at least one bucket before depositing.',
  DestinationRequired: 'A scheduled send requires a destination address.',
  InvalidAmount:       'Amount must be greater than zero.',

  // BucketLock / BucketLockFactory. Kept in the same map so lock reverts get the
  // same plain-language treatment as Split's, rather than surfacing raw revert
  // text. `InsufficientBalance` and `InvalidAmount` are shared names above and
  // read correctly for both contracts, so they are deliberately not duplicated.
  PenaltyExceedsAmount: `That amount is too small to withdraw early — the ${PENALTY_PCT} fee would take all of it. Withdraw at least ${MIN_EARLY_WITHDRAWAL}.`,
  NotOwner:             'Only the owner of this lock can withdraw from it.',
  DateRequired:         'A locked bucket needs an unlock date.',
  UnlockTooSoon:        'The unlock date must be at least 1 day away.',
  UnlockInPast:         'The unlock date has already passed.',
  NoUnlockCondition:    'Set an unlock date for this lock.',
  ZeroAddress:          'That address is not valid.',
}

// Pre-compiled word-boundary regexes — one per error name, built once at module load.
const errorPatterns: Array<[string, RegExp]> = Object.keys(splitErrors).map(
  (name) => [name, new RegExp(`\\b${name}\\b`)],
)

export function parseSplitError(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    // viem ContractFunctionRevertedError exposes structured error data
    const errorName = (error as { data?: { errorName?: string } }).data?.errorName
    if (errorName !== undefined && errorName in splitErrors) {
      return splitErrors[errorName] as string
    }
    // Fallback: word-boundary match against the message string
    const msg = String((error as { message?: unknown }).message ?? '')
    for (const [name, pattern] of errorPatterns) {
      if (pattern.test(msg)) {
        return splitErrors[name] as string
      }
    }
  }
  return 'Something went wrong. Please try again.'
}
