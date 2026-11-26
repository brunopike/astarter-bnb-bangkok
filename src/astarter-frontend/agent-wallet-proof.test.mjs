import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyTypedData } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { agentWalletTypedData, createAgentWalletProof, verifyAgentWalletProof } from './agent-wallet-proof.mjs';

test('a signed address proof binds the site, account and chain and can be used once', async () => {
  const origin = 'https://example.test';
  const signer = privateKeyToAccount(generatePrivateKey());
  const owner = privateKeyToAccount(generatePrivateKey()).address;
  const challenge = createAgentWalletProof({ origin, siteOwner: owner, locale: 'en' });
  const data = agentWalletTypedData(challenge, signer.address);
  assert.equal(data.domain.chainId, 56);
  assert.equal(challenge.expiresAt - challenge.issuedAt, 300_000);
  const signature = await signer.signTypedData(data);
  const proof = { challenge, address: signer.address, signature, origin, siteOwner: owner, verifyTypedData };

  await assert.rejects(verifyAgentWalletProof({ ...proof, origin: 'https://another.test' }), { code: 'SCOPE_CHANGED' });
  await assert.rejects(verifyAgentWalletProof({ ...proof, siteOwner: null }), { code: 'SCOPE_CHANGED' });
  await assert.rejects(verifyAgentWalletProof({ ...proof, address: owner }), { code: 'INVALID_SIGNATURE' });

  const verified = await verifyAgentWalletProof(proof);
  assert.equal(verified.address, signer.address.toLowerCase());
  await assert.rejects(verifyAgentWalletProof(proof), { code: 'CHALLENGE_USED' });
});

test('an expired challenge is rejected before signature verification', async () => {
  const origin = 'https://example.test';
  const challenge = createAgentWalletProof({ origin, locale: 'en', now: () => Date.now() - 300_000 });
  await assert.rejects(verifyAgentWalletProof({ challenge, origin }), { code: 'CHALLENGE_EXPIRED' });
});
