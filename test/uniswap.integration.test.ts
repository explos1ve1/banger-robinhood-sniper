import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import ganache from '@ganache/core';
import solc from 'solc';
import {
  BrowserProvider,
  Contract,
  ContractFactory,
  Wallet,
  parseEther,
  MaxUint256,
  ZeroAddress,
} from 'ethers';
import { loadConfig } from '../src/config.js';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import { Transactions } from '../src/transactions.js';
const require = createRequire(import.meta.url);
const artifact = (p: string) => JSON.parse(fs.readFileSync(require.resolve(p), 'utf8'));

test(
  'real local V3 deployment: discovery, paper, live buy, recovery, exact approval and native ETH exit',
  { timeout: 120000 },
  async () => {
    const chain = ganache.provider({
      logging: { quiet: true },
      chain: { chainId: 31337, hardfork: 'shanghai' },
      wallet: { totalAccounts: 3, defaultBalance: 2000 },
    });
    const provider = new BrowserProvider(chain as any, undefined, {
      cacheTimeout: 0,
      pollingInterval: 20,
    });
    const accounts = Object.values(chain.getInitialAccounts());
    const deployer = new Wallet(accounts[0]!.secretKey, provider),
      buyerKey = accounts[1]!.secretKey;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'banger-evm-'));
    let engine: Engine | undefined;
    let paper: Engine | undefined;
    try {
      const source = fs.readFileSync(new URL('./fixtures/Tokens.sol', import.meta.url), 'utf8');
      const compiled = JSON.parse(
        solc.compile(
          JSON.stringify({
            language: 'Solidity',
            sources: { 'Tokens.sol': { content: source } },
            settings: {
              evmVersion: 'shanghai',
              optimizer: { enabled: true, runs: 200 },
              outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
            },
          }),
        ),
      );
      const errors = compiled.errors?.filter((e: any) => e.severity === 'error') ?? [];
      assert.deepEqual(errors, []);
      const deploy = async (a: any, args: any[] = []) => {
        const con = await new ContractFactory(
          a.abi,
          a.bytecode ?? a.evm.bytecode.object,
          deployer,
        ).deploy(...args);
        await con.waitForDeployment();
        return con as any;
      };
      const weth = await deploy(compiled.contracts['Tokens.sol'].TestWETH);
      const token = await deploy(compiled.contracts['Tokens.sol'].TestToken, [
        'Local Meme',
        'BANG',
      ]);
      const factory = await deploy(
        artifact('@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json'),
      );
      const f = await factory.getAddress(),
        w = await weth.getAddress(),
        tok = await token.getAddress();
      const router = await deploy(
        artifact('@uniswap/v3-periphery/artifacts/contracts/SwapRouter.sol/SwapRouter.json'),
        [f, w],
      );
      const quoter = await deploy(
        artifact('@uniswap/v3-periphery/artifacts/contracts/lens/QuoterV2.sol/QuoterV2.json'),
        [f, w],
      );
      const manager = await deploy(
        artifact(
          '@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json',
        ),
        [f, w, ZeroAddress],
      );
      await (await factory.createPool(w, tok, 10000)).wait();
      const poolAddress = await factory.getPool(w, tok, 10000);
      const pool = new Contract(
        poolAddress,
        artifact('@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json').abi,
        deployer,
      );
      await (await pool.getFunction('initialize')(2n ** 96n)).wait();
      await (await weth.deposit({ value: parseEther('100') })).wait();
      await (await token.mint(deployer.address, parseEther('100'))).wait();
      await (await weth.approve(await manager.getAddress(), MaxUint256)).wait();
      await (await token.approve(await manager.getAddress(), MaxUint256)).wait();
      const [token0, token1] = [w, tok].sort((a, b) =>
        a.toLowerCase().localeCompare(b.toLowerCase()),
      );
      await (
        await manager.mint(
          {
            token0,
            token1,
            fee: 10000,
            tickLower: -887200,
            tickUpper: 887200,
            amount0Desired: parseEther('50'),
            amount1Desired: parseEther('50'),
            amount0Min: 0,
            amount1Min: 0,
            recipient: deployer.address,
            deadline: Math.floor(Date.now() / 1000) + 600,
          },
          { gasLimit: 1500000n },
        )
      ).wait();
      const env = {
        CHAIN_ID: '31337',
        RPC_URL: 'http://127.0.0.1:1',
        V3_FACTORY: f,
        V3_ROUTER: await router.getAddress(),
        V3_QUOTER: await quoter.getAddress(),
        WETH: w,
        CONFIRMATIONS: '1',
        MIN_POOL_AGE_BLOCKS: '1',
        MAX_POOL_AGE_SECONDS: '3600',
        LOOKBACK_BLOCKS: '1000',
        DATA_DIR: root,
        MAX_FEE_GWEI: '100',
        MAX_GAS_PER_TX_ETH: '.01',
        MAX_SESSION_SPEND_ETH: '.05',
        BUY_ETH: '.005',
        TAKE_PROFIT_BPS: '1000000',
        STOP_LOSS_BPS: '9500',
      };
      // Config amounts are exact decimal literals with a leading zero.
      env.MAX_GAS_PER_TX_ETH = '0.01';
      env.MAX_SESSION_SPEND_ETH = '0.05';
      env.BUY_ETH = '0.005';
      const buyer = new Wallet(buyerKey, provider);
      const nonceBefore = await provider.getTransactionCount(buyer.address);
      paper = new Engine(loadConfig({ ...env, MODE: 'paper' }), provider);
      await paper.init();
      await paper.tick();
      assert.equal(Object.keys(paper.store.state.positions).length, 1);
      assert.equal(await provider.getTransactionCount(buyer.address), nonceBefore);
      assert.equal(paper.store.state.pending, null);
      paper.store.release();
      paper = undefined;
      const c = loadConfig({
        ...env,
        MODE: 'live',
        PRIVATE_KEY: buyerKey,
        LIVE_ACK: 'I_ACCEPT_REAL_TRADES',
      });
      engine = new Engine(c, provider);
      const report = await engine.init();
      assert.equal(report.routerKind, 'classic');
      await engine.scan();
      const candidate = Object.values(engine.store.state.pools)[0]!;
      assert.equal(candidate.pool, poolAddress);
      const market = await engine.dex.market(poolAddress);
      candidate.symbol = market.symbol;
      candidate.decimals = market.decimals;
      engine.store.save();
      // Force the response path to look interrupted AFTER the EVM has executed the buy.
      const receipt = provider.getTransactionReceipt.bind(provider),
        wait = provider.waitForTransaction.bind(provider);
      provider.getTransactionReceipt = async () => null;
      provider.waitForTransaction = async () => {
        throw Error('simulated lost response');
      };
      await engine.buy(candidate, market);
      assert.ok(engine.store.state.pending);
      provider.getTransactionReceipt = receipt;
      provider.waitForTransaction = wait;
      const balanceBeforeRecovery = await token.balanceOf(buyer.address);
      assert.ok(balanceBeforeRecovery > 0n);
      const directory = engine.store.directory,
        id = engine.store.id;
      engine.store.release();
      const restored = new Store(directory, id);
      restored.acquire();
      const recovery = new Transactions(c, provider, restored);
      assert.equal(await recovery.reconcile(), true);
      assert.equal(await recovery.reconcile(), true);
      assert.equal(await token.balanceOf(buyer.address), balanceBeforeRecovery);
      assert.equal(await provider.getTransactionCount(buyer.address), nonceBefore + 1);
      restored.release();
      engine = new Engine(c, provider);
      await engine.init();
      const position = engine.store.state.positions[tok]!;
      assert.ok(position);
      assert.equal(position.amountWei, balanceBeforeRecovery.toString());
      await engine.sell(position, await engine.dex.market(poolAddress), 'TEST EXIT');
      const allowance = await token.allowance(buyer.address, await router.getAddress());
      assert.equal(allowance, BigInt(position.amountWei));
      assert.notEqual(allowance, MaxUint256);
      await engine.sell(position, await engine.dex.market(poolAddress), 'TEST EXIT');
      assert.ok(position.closedAt);
      assert.ok(BigInt(position.exitWei!) > 0n);
      assert.equal(await token.balanceOf(buyer.address), 0n);
      assert.equal(await weth.balanceOf(buyer.address), 0n, 'sale is unwrapped to native ETH');
      assert.equal(engine.store.state.pending, null);
      assert.ok(BigInt(engine.store.state.gasWei) > 0n);
      assert.equal(
        BigInt(engine.store.state.realizedWei),
        BigInt(position.exitWei!) - BigInt(position.entryWei) - BigInt(position.gasWei),
      );
      // Explicit gas refusal must leave both nonce and journal untouched.
      const tx = new Transactions({ ...c, MAX_GAS_PER_TX_ETH: 1n }, provider, engine.store);
      const nonce = await provider.getTransactionCount(buyer.address);
      await assert.rejects(
        () =>
          tx.execute(
            { to: deployer.address, value: 1n },
            { action: 'approve', pool: poolAddress, token: tok, amountWei: '0', minimumWei: '0' },
          ),
        /gas budget/,
      );
      assert.equal(await provider.getTransactionCount(buyer.address), nonce);
      assert.equal(engine.store.state.pending, null);
      engine.store.release();
      engine = undefined;
      // Same round trip through the current Router02 ABI, including its deadline multicall.
      const router02 = await deploy(
        artifact(
          '@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json',
        ),
        [ZeroAddress, f, await manager.getAddress(), w],
      );
      const c02 = loadConfig({
        ...env,
        DATA_DIR: path.join(root, 'router02'),
        V3_ROUTER: await router02.getAddress(),
        MODE: 'live',
        PRIVATE_KEY: buyerKey,
        LIVE_ACK: 'I_ACCEPT_REAL_TRADES',
      });
      engine = new Engine(c02, provider);
      assert.equal((await engine.init()).routerKind, 'router02');
      await engine.tick();
      const p02 = engine.store.state.positions[tok]!;
      assert.ok(p02, 'Router02 actually filled the buy');
      await engine.sell(p02, await engine.dex.market(poolAddress), 'ROUTER02 EXIT');
      await engine.sell(p02, await engine.dex.market(poolAddress), 'ROUTER02 EXIT');
      assert.ok(p02.closedAt);
      assert.ok(BigInt(p02.exitWei!) > 0n);
      assert.equal(await token.balanceOf(buyer.address), 0n);
      assert.equal(await weth.balanceOf(buyer.address), 0n);
    } finally {
      engine?.store.release();
      paper?.store.release();
      provider.destroy();
      await chain.disconnect();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
