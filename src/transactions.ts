import {
  Wallet,
  keccak256,
  getAddress,
  type JsonRpcProvider,
  type TransactionRequest,
  type TransactionReceipt,
} from 'ethers';
import { ERC20 } from './abi.js';
import { CURVE, V4_MANAGER } from './pons-abi.js';
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
    let spent = BigInt(job.amountWei);
    let tokenDebited = 0n;
    const route = job.route ?? 'v3';
    let curveTrade: { input: bigint; output: bigint } | undefined;
    let curveRefund = 0n;
    let v4Input = 0n;
    if (getAddress(r.from) !== this.wallet.address) throw Error('Receipt sender mismatch');
    if (job.action === 'buy' && !s.pools[job.pool])
      throw Error('Pending buy has no candidate record');
    if (job.action !== 'buy' && (!p || p.closedAt))
      throw Error('Pending transaction has no open position');
    if (r.status === 1 && job.action !== 'approve') {
      for (const log of r.logs) {
        if (route === 'curve' && getAddress(log.address) === job.pool) {
          const event = CURVE.parseLog(log);
          if (
            event?.name === 'CurveBuyRefunded' &&
            getAddress(event.args.buyer) === this.wallet.address
          )
            curveRefund += BigInt(event.args.refund);
          if (event?.name === (job.action === 'buy' ? 'CurveBuy' : 'CurveSell')) {
            const actor = job.action === 'buy' ? event.args.buyer : event.args.seller;
            if (
              getAddress(actor) !== this.wallet.address ||
              getAddress(event.args.recipient) !== this.wallet.address ||
              curveTrade
            )
              throw Error('Ambiguous PONS trade receipt');
            curveTrade = {
              input: BigInt(job.action === 'buy' ? event.args.quoteIn : event.args.tokensIn),
              output: BigInt(job.action === 'buy' ? event.args.tokensOut : event.args.quoteOut),
            };
          }
        }
        if (
          route === 'v4' &&
          job.action === 'buy' &&
          getAddress(log.address) === this.c.V4_POOL_MANAGER
        ) {
          const event = V4_MANAGER.parseLog(log);
          if (
            event?.name === 'Swap' &&
            event.args.id === job.poolId &&
            getAddress(event.args.sender) === this.c.V4_ROUTER
          )
            v4Input -= BigInt(event.args.amount0);
        }
        try {
          const event = ERC20.parseLog(log);
          if (!event) continue;
          if (
            job.action === 'sell' &&
            getAddress(log.address) === job.token &&
            event.name === 'Transfer'
          ) {
            if (getAddress(event.args.from) === this.wallet.address)
              tokenDebited += BigInt(event.args.value);
            if (getAddress(event.args.to) === this.wallet.address)
              tokenDebited -= BigInt(event.args.value);
          }
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
            route !== 'curve' &&
            getAddress(event.args.src) === (route === 'v4' ? this.c.V4_ROUTER : this.c.V3_ROUTER)
          )
            received += BigInt(event.args.wad);
        } catch {
          /* unrelated log */
        }
      }
      if (route === 'curve') {
        if (!curveTrade) throw Error('Missing PONS fill event; pending journal retained');
        if (job.action === 'buy') {
          spent = curveTrade.input;
          if (curveTrade.output !== received || spent + curveRefund !== BigInt(job.amountWei))
            throw Error('PONS fill / token transfer / refund mismatch');
        } else {
          if (curveTrade.input !== BigInt(job.amountWei)) throw Error('PONS sell amount mismatch');
          received = curveTrade.output;
        }
      }
      if (route === 'v4' && job.action === 'buy') spent = v4Input;
      if (job.action === 'buy' && (spent <= 0n || spent > BigInt(job.amountWei)))
        throw Error('Invalid receipt purchase cost');
      if (job.action === 'sell' && tokenDebited !== BigInt(job.amountWei))
        throw Error('Sell did not debit the tracked token amount');
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
      s.spentWei = (BigInt(s.spentWei) + spent).toString();
      s.positions[job.token] = {
        venue: route === 'v3' ? 'v3' : 'pons',
        token: job.token,
        pool: job.pool,
        symbol: c.symbol,
        decimals: c.decimals,
        fee: c.fee,
        amountWei: received.toString(),
        entryWei: spent.toString(),
        gasWei: fee.toString(),
        openedAt: Date.now(),
        markWei: spent.toString(),
        markAt: 0,
        buyHash: job.hash,
        nextExitTry: 0,
      };
      c.status = 'entered';
      c.reason = 'Receipt confirmed';
      if (
        route === 'curve'
          ? received * BigInt(job.amountWei) < spent * BigInt(job.minimumWei)
          : received < BigInt(job.minimumWei)
      )
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
