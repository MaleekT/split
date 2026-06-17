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
