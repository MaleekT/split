import { defineChain } from 'viem'

// Arc Testnet — defined locally rather than imported from `viem/chains`.
//
// The `viem/chains` barrel re-exports viem's newer `tempo` chains, which load
// `ox`'s internal dynamic `require()` (virtualMasterPool). webpack flags that as
// "Critical dependency: the request of a dependency is an expression" and the
// corrupted server module graph breaks `next build` at the "Collecting page data"
// step. Defining the chain locally keeps the barrel — and tempo/ox — out of the
// bundle entirely.
//
// Config copied verbatim from viem 2.52.2's own arcTestnet definition.
export const arcTestnet = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: {
    default: {
      http: [
        'https://rpc.testnet.arc.network',
        'https://rpc.quicknode.testnet.arc.network',
        'https://rpc.blockdaemon.testnet.arc.network',
      ],
      webSocket: [
        'wss://rpc.testnet.arc.network',
        'wss://rpc.quicknode.testnet.arc.network',
      ],
    },
  },
  blockExplorers: {
    default: {
      name: 'ArcScan',
      url: 'https://testnet.arcscan.app',
      apiUrl: 'https://testnet.arcscan.app/api',
    },
  },
  contracts: {
    multicall3: {
      address: '0xcA11bde05977b3631167028862bE2a173976CA11',
      blockCreated: 0,
    },
  },
  testnet: true,
})
