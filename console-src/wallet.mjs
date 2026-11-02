// Finds Solana wallets through the Wallet Standard, which Phantom, Solflare, Backpack, and others implement.
const CHAIN = 'solana:mainnet';
const CONNECT = 'standard:connect';
const SEND = 'solana:signAndSendTransaction';

/** Calls onWallet for each usable wallet, including ones that register later. */
export function discoverWallets(onWallet) {
  const seen = new Set();
  const register = (...wallets) => {
    for (const wallet of wallets) {
      if (seen.has(wallet) || !wallet.features?.[CONNECT] || !wallet.features?.[SEND] || !wallet.chains?.includes(CHAIN)) continue;
      seen.add(wallet);
      onWallet(wallet);
    }
    return () => {};
  };
  const api = Object.freeze({ register });
  window.addEventListener('wallet-standard:register-wallet', (event) => event.detail(api));
  window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }));
}

export async function connectWallet(wallet, silent = false) {
  const { accounts } = await wallet.features[CONNECT].connect({ silent });
  const account = accounts.find((a) => a.chains?.includes(CHAIN)) ?? accounts[0];
  if (!account) throw new Error('The wallet shared no account.');
  return account;
}

export const disconnectWallet = (wallet) => wallet.features['standard:disconnect']?.disconnect();
export const watchWallet = (wallet, listener) => wallet.features['standard:events']?.on('change', listener) ?? (() => {});

/** Has the wallet sign and send, and returns the signature bytes. */
export async function signAndSend(wallet, account, bytes) {
  const [{ signature }] = await wallet.features[SEND].signAndSendTransaction({ account, chain: CHAIN, transaction: bytes });
  return signature;
}
