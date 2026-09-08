import {
  Wallet,
  keccak256,
  getAddress,
  type JsonRpcProvider,
  type TransactionRequest,
  type TransactionReceipt,
} from 'ethers';
import { ERC20 } from './abi.js';
import { safeError, type Config } from './config.js';
import { Store, type Pending } from './store.js';
import type { RpcProvider } from './v3.js';

export type Intent = Omit<Pending, 'raw' | 'hash' | 'nonce' | 'createdAt'>;
export class Transactions {
  readonly wallet: Wallet;
  constructor(
    readonly c: Config,
    readonly provider: RpcProvider,
    readonly store: Store,
    readonly canSend: (action: Intent['action']) => boolean = () => true,
  ) {
    if (c.MODE !== 'live') throw Error('A signer can only exist in live mode');
    this.wallet = new Wallet(c.PRIVATE_KEY, provider);
  }
  async execute(request: TransactionRequest, intent: Intent) {
    if (this.store.state.pending) throw Error('An unresolved transaction already exists');
    if (Number(BigInt(await this.provider.send('eth_chainId', []))) !== this.c.CHAIN_ID)
      throw Error('Chain changed before signing');
    const fees = await this.provider.getFeeData();
    const price = fees.maxFeePerGas ?? fees.gasPrice;
    if (!price || price <= 0n || price > this.c.MAX_FEE_GWEI)
      throw Error('Gas price exceeds configured limit');
    const from = this.wallet.address;
    await this.provider.call({ ...request, from });
    const gas = ((await this.provider.estimateGas({ ...request, from })) * 125n) / 100n;
    if (gas * price > this.c.MAX_GAS_PER_TX_ETH) throw Error('Transaction gas budget exceeded');
    if ((await this.provider.getBalance(from)) < BigInt(request.value ?? 0) + gas * price)
      throw Error('Insufficient ETH for amount plus bounded gas');
    const nonce = await this.provider.getTransactionCount(from, 'pending');
    if (!this.canSend(intent.action))
      throw Error('New transaction cancelled by stop or entry limits');
    const feeFields = fees.maxFeePerGas
      ? { type: 2, maxFeePerGas: price, maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 0n }
      : { type: 0, gasPrice: price };
    const raw = await this.wallet.signTransaction({
      ...request,
      chainId: this.c.CHAIN_ID,
      nonce,
      gasLimit: gas,
      ...feeFields,
    });
    const hash = keccak256(raw);
    // Write-ahead journal: crash recovery can only rebroadcast these exact bytes.
    this.store.state.pending = { ...intent, raw, hash, nonce, createdAt: Date.now() };
    this.store.event(
      'SIGNED',
      `${intent.action.toUpperCase()} ${intent.token.slice(0, 10)} ${hash.slice(0, 12)}`,
    );
    try {
      await this.provider.broadcastTransaction(raw);
      await this.provider.waitForTransaction(hash, this.c.CONFIRMATIONS, this.c.TX_WAIT_MS);
    } catch (e) {
      this.store.event(
        'PENDING',
        `Receipt unresolved: ${safeError(e)}. New transactions are held.`,
      );
    }
    return this.reconcile(false);
  }
  async reconcile(rebroadcast = true): Promise<boolean> {
    const job = this.store.state.pending;
    if (!job) return true;
    const receipt = await this.provider.getTransactionReceipt(job.hash);
    if (receipt) {
      if ((await receipt.confirmations()) < this.c.CONFIRMATIONS) return false;
      this.applyReceipt(job, receipt);
      return true;
    }
    if (rebroadcast && Date.now() - job.createdAt > 10000) {
      // Never sign a replacement or allocate the next nonce while outcome is unknown.
      try {
        await this.provider.broadcastTransaction(job.raw);
      } catch {
        /* same hash may already be pending */
      }
    }
    return false;
  }
  private applyReceipt(job: Pending, r: TransactionReceipt) {
    const s = this.store.state;
    const fee = r.fee;
    const p = s.positions[job.token];
    let received = 0n;
    if (job.action === 'buy' && !s.pools[job.pool])
      throw Error('Pending buy has no candidate record');
    if (job.action !== 'buy' && (!p || p.closedAt))
      throw Error('Pending transaction has no open position');
    if (r.status === 1 && job.action !== 'approve') {
      for (const log of r.logs) {
        try {
          const event = ERC20.parseLog(log);
          if (!event) continue;
          if (
            job.action === 'buy' &&
            getAddress(log.address) === job.token &&
            event.name === 'Transfer'
          ) {
            if (getAddress(event.args.to) === this.wallet.address)
              received += BigInt(event.args.value);
            if (getAddress(event.args.from) === this.wallet.address)
              received -= BigInt(event.args.value);
          }
          if (
            job.action === 'sell' &&
            getAddress(log.address) === this.c.WETH &&
            event.name === 'Withdrawal' &&
            getAddress(event.args.src) === this.c.V3_ROUTER
          )
            received += BigInt(event.args.wad);
        } catch {
          /* unrelated log */
        }
      }
      if (received <= 0n)
        throw Error(
          'Receipt accounting is ambiguous. Pending journal retained; inspect transaction before continuing.',
        );
    }
    s.gasWei = (BigInt(s.gasWei) + fee).toString();
    if (r.status !== 1) {
      if (p && !p.closedAt) p.gasWei = (BigInt(p.gasWei) + fee).toString();
      else s.realizedWei = (BigInt(s.realizedWei) - fee).toString();
      const c = s.pools[job.pool];
      if (c) c.nextTry = Date.now() + 15000;
      if (p) p.nextExitTry = Date.now() + 15000;
      s.pending = null;
      this.store.event(
        'REVERTED',
        `${job.action.toUpperCase()} ${job.hash.slice(0, 12)} — gas recorded`,
      );
      return;
    }
    if (job.action === 'buy') {
      const c = s.pools[job.pool];
      if (!c) throw Error('Pending buy has no candidate record');
      s.spentWei = (BigInt(s.spentWei) + BigInt(job.amountWei)).toString();
      s.positions[job.token] = {
        token: job.token,
        pool: job.pool,
        symbol: c.symbol,
        decimals: c.decimals,
        fee: c.fee,
        amountWei: received.toString(),
        entryWei: job.amountWei,
        gasWei: fee.toString(),
        openedAt: Date.now(),
        markWei: job.amountWei,
        markAt: 0,
        buyHash: job.hash,
        nextExitTry: 0,
      };
      c.status = 'entered';
      c.reason = 'Receipt confirmed';
      if (received < BigInt(job.minimumWei))
        s.halt = 'Actual token transfer below quoted minimum; new entries paused';
    } else if (job.action === 'approve') {
      if (!p) throw Error('Approval has no position');
      p.gasWei = (BigInt(p.gasWei) + fee).toString();
    } else {
      if (!p || p.closedAt) throw Error('Sell has no open position');
      p.gasWei = (BigInt(p.gasWei) + fee).toString();
      p.exitWei = received.toString();
      p.closedAt = Date.now();
      p.sellHash = job.hash;
      p.markWei = '0';
      s.realizedWei = (
        BigInt(s.realizedWei) +
        received -
        BigInt(p.entryWei) -
        BigInt(p.gasWei)
      ).toString();
    }
    s.pending = null;
    this.store.event(
      job.action === 'buy' ? 'FILLED' : job.action === 'sell' ? 'CLOSED' : 'APPROVED',
      `${job.action.toUpperCase()} ${job.token.slice(0, 10)} ${job.hash.slice(0, 12)}`,
    );
  }
}
