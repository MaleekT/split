// Bucket lock contracts: ABIs and the trusted-factory allowlist.
//
// The ABIs below are COPIED VERBATIM from contracts/out/ after `forge build`,
// per rule 2 of split-CLAUDE.md. Never hand-write or hand-edit them: regenerate
// from the artifacts instead.
//
// The trust model, stated honestly
// --------------------------------
// This is APPLICATION ALLOWLISTING plus FACTORY PROVENANCE. It is not
// cryptographic proof of arbitrary bytecode identity. The chain of reasoning is:
//
//   the factory address is on this pinned chain-ID + address allowlist
//     -> factory.isLock(x) says this factory created x
//     -> the factory deploys the fixed BucketLock creation bytecode compiled
//        into it
//     -> therefore x runs the reviewed implementation with these constants.
//
// `isLock` proves PROVENANCE, never OWNERSHIP. Every caller must separately check
// the lock's own owner(). Treating provenance as ownership is a fund-loss path:
// routing deposits into somebody else's lock is unrecoverable by the sender.
//
// "Factory-only" is a product statement, not a technical impossibility. Anyone can
// deploy BucketLock directly and it works for them; it is simply unsupported here
// and must classify as UNSUPPORTED, never ELIGIBLE.
//
// Runtime bytecode-hash pinning is a MAINNET hardening requirement. It is
// deliberately not implemented for Arc Testnet.
//
// The allowlist is pinned in code rather than read from env because it is the
// trust anchor itself: an attacker who can set an env var must not thereby be
// able to make the app trust an arbitrary factory. Old versions are never
// removed, since locks created under them never expire.

/** Exactly 10%. Mirrored on both contracts and asserted against both at load. */
export const LOCK_PENALTY_BPS = 1_000n

export interface TrustedFactory {
  readonly chainId:    number
  readonly address:    `0x${string}`
  readonly version:    bigint
  readonly token:      `0x${string}`
  readonly treasury:   `0x${string}`
  readonly penaltyBps: bigint
}

/**
 * Every factory this application trusts, and exactly what each must report.
 * A mismatch on ANY field makes the factory unsupported and its locks
 * ineligible - including the treasury, which fails closed. A factory whose
 * treasury is not the one we expect is not a factory we understand.
 */
export const TRUSTED_FACTORIES: readonly TrustedFactory[] = [
  {
    chainId:    5042002,
    address:    '0x43213D5dF2e96780D6eC6054aaD7071D53DE4d7B',
    version:    1n,
    token:      '0x3600000000000000000000000000000000000000',
    // Arc Testnet throwaway (the deployer). Mainnet REQUIRES a Safe; that is a
    // hard gate, and a new factory must be deployed for it, since treasury is
    // immutable per lock and inherited permanently.
    treasury:   '0x530F03BB23119c8D94d5FC36105c2C4b19Fbe9E4',
    penaltyBps: LOCK_PENALTY_BPS,
  },
] as const

/** The trusted factory for a chain, or null when the chain has none. */
export function trustedFactoryFor(chainId: number): TrustedFactory | null {
  return TRUSTED_FACTORIES.find((f) => f.chainId === chainId) ?? null
}

export const bucketLockAbi = [{"type":"constructor","inputs":[{"name":"_owner","type":"address","internalType":"address"},{"name":"_token","type":"address","internalType":"contract IERC20"},{"name":"_treasury","type":"address","internalType":"address"},{"name":"_unlockAt","type":"uint64","internalType":"uint64"},{"name":"_target","type":"uint256","internalType":"uint256"}],"stateMutability":"nonpayable"},{"type":"function","name":"BPS_TOTAL","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},{"type":"function","name":"PENALTY_BPS","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},{"type":"function","name":"isUnlocked","inputs":[],"outputs":[{"name":"","type":"bool","internalType":"bool"}],"stateMutability":"view"},{"type":"function","name":"owner","inputs":[],"outputs":[{"name":"","type":"address","internalType":"address"}],"stateMutability":"view"},{"type":"function","name":"poke","inputs":[],"outputs":[],"stateMutability":"nonpayable"},{"type":"function","name":"previewWithdraw","inputs":[{"name":"amount","type":"uint256","internalType":"uint256"}],"outputs":[{"name":"net","type":"uint256","internalType":"uint256"},{"name":"penalty","type":"uint256","internalType":"uint256"},{"name":"early","type":"bool","internalType":"bool"}],"stateMutability":"view"},{"type":"function","name":"quotePenalty","inputs":[{"name":"amount","type":"uint256","internalType":"uint256"}],"outputs":[{"name":"penalty","type":"uint256","internalType":"uint256"},{"name":"net","type":"uint256","internalType":"uint256"}],"stateMutability":"pure"},{"type":"function","name":"target","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},{"type":"function","name":"targetMet","inputs":[],"outputs":[{"name":"","type":"bool","internalType":"bool"}],"stateMutability":"view"},{"type":"function","name":"token","inputs":[],"outputs":[{"name":"","type":"address","internalType":"contract IERC20"}],"stateMutability":"view"},{"type":"function","name":"treasury","inputs":[],"outputs":[{"name":"","type":"address","internalType":"address"}],"stateMutability":"view"},{"type":"function","name":"unlockAt","inputs":[],"outputs":[{"name":"","type":"uint64","internalType":"uint64"}],"stateMutability":"view"},{"type":"function","name":"withdraw","inputs":[{"name":"amount","type":"uint256","internalType":"uint256"}],"outputs":[],"stateMutability":"nonpayable"},{"type":"function","name":"withdrawAll","inputs":[],"outputs":[],"stateMutability":"nonpayable"},{"type":"event","name":"TargetMet","inputs":[{"name":"balance","type":"uint256","indexed":false,"internalType":"uint256"},{"name":"target","type":"uint256","indexed":false,"internalType":"uint256"}],"anonymous":false},{"type":"event","name":"Withdrawn","inputs":[{"name":"owner","type":"address","indexed":true,"internalType":"address"},{"name":"grossAmount","type":"uint256","indexed":false,"internalType":"uint256"},{"name":"penalty","type":"uint256","indexed":false,"internalType":"uint256"},{"name":"netAmount","type":"uint256","indexed":false,"internalType":"uint256"},{"name":"early","type":"bool","indexed":false,"internalType":"bool"}],"anonymous":false},{"type":"error","name":"InsufficientBalance","inputs":[]},{"type":"error","name":"InvalidAmount","inputs":[]},{"type":"error","name":"NoUnlockCondition","inputs":[]},{"type":"error","name":"NotOwner","inputs":[]},{"type":"error","name":"PenaltyExceedsAmount","inputs":[]},{"type":"error","name":"ReentrancyGuardReentrantCall","inputs":[]},{"type":"error","name":"SafeERC20FailedOperation","inputs":[{"name":"token","type":"address","internalType":"address"}]},{"type":"error","name":"UnlockInPast","inputs":[]},{"type":"error","name":"ZeroAddress","inputs":[]}] as const

export const bucketLockFactoryAbi = [{"type":"constructor","inputs":[{"name":"_token","type":"address","internalType":"contract IERC20"},{"name":"_treasury","type":"address","internalType":"address"}],"stateMutability":"nonpayable"},{"type":"function","name":"MIN_DURATION","inputs":[],"outputs":[{"name":"","type":"uint64","internalType":"uint64"}],"stateMutability":"view"},{"type":"function","name":"PENALTY_BPS","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},{"type":"function","name":"VERSION","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},{"type":"function","name":"createLock","inputs":[{"name":"unlockAt","type":"uint64","internalType":"uint64"},{"name":"target","type":"uint256","internalType":"uint256"}],"outputs":[{"name":"lock","type":"address","internalType":"address"}],"stateMutability":"nonpayable"},{"type":"function","name":"isLock","inputs":[{"name":"","type":"address","internalType":"address"}],"outputs":[{"name":"","type":"bool","internalType":"bool"}],"stateMutability":"view"},{"type":"function","name":"locksOfAt","inputs":[{"name":"user","type":"address","internalType":"address"},{"name":"index","type":"uint256","internalType":"uint256"}],"outputs":[{"name":"","type":"address","internalType":"address"}],"stateMutability":"view"},{"type":"function","name":"locksOfLength","inputs":[{"name":"user","type":"address","internalType":"address"}],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},{"type":"function","name":"token","inputs":[],"outputs":[{"name":"","type":"address","internalType":"contract IERC20"}],"stateMutability":"view"},{"type":"function","name":"treasury","inputs":[],"outputs":[{"name":"","type":"address","internalType":"address"}],"stateMutability":"view"},{"type":"event","name":"LockCreated","inputs":[{"name":"owner","type":"address","indexed":true,"internalType":"address"},{"name":"lock","type":"address","indexed":true,"internalType":"address"},{"name":"unlockAt","type":"uint64","indexed":false,"internalType":"uint64"},{"name":"target","type":"uint256","indexed":false,"internalType":"uint256"}],"anonymous":false},{"type":"error","name":"DateRequired","inputs":[]},{"type":"error","name":"UnlockTooSoon","inputs":[]},{"type":"error","name":"ZeroAddress","inputs":[]}] as const
