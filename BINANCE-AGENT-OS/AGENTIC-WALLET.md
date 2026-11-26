# Prove control of a BNB Chain address

Astarter asks Binance Agentic Wallet one question during setup. Can the holder sign a fresh challenge for this address and this Astarter session? A verified signature establishes address control. It grants Astarter no spending allowance, trading permission or custody. [Astarter wallet settings](https://demo.astarter.io/settings#ux-local-agent) · [Binance Agentic Wallet](https://developers.binance.com/en/docs/products/agentic-wallet/welcome)

1. In Astarter settings, generate a challenge. The EIP-712 message identifies BNB Smart Chain (chain ID 56), the site, the Astarter account or guest scope, the agent wallet address and the purpose. It includes a random nonce and expires after five minutes.
2. Review the message with the paired Binance Agentic Wallet, then approve the signature if the fields match. The wallet returns the address and signature for verification.
3. Astarter verifies the signature against the submitted address and the original challenge. A change of site or account, an expired challenge or reuse after successful verification fails the check. [Verifier source](../src/astarter-frontend/agent-wallet-proof.mjs) · [Version served by the dApp](https://demo.astarter.io/agent-wallet-proof.mjs)

The Astarter CLI offers a read-only way to inspect the handoff. Its `connect` command prints the provider, chain ID and browser setup URL. Signing takes place in the wallet. [CLI source](../src/astarter-cli/astarter.mjs)

```sh
node src/astarter-cli/astarter.mjs connect
```

To verify the signature checks offline with Node.js 24, run these commands from the repository root. The test creates temporary keys in memory and signs a challenge locally. It checks expiry, site and account binding, signer identity and single use.

```sh
cd src/astarter-frontend
npm ci
node --test agent-wallet-proof.test.mjs
```
