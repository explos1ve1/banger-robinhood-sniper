import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  Contract,
  ContractFactory,
  JsonRpcProvider,
  Wallet,
  ZeroAddress,
  ZeroHash,
  getCreate2Address,
  keccak256,
  parseEther,
  toBeHex,
} from 'ethers';
import { Engine } from '../src/engine.js';
import { loadConfig, minOut } from '../src/config.js';
import { CURVE, PERMIT2, V4_QUOTER } from '../src/pons-abi.js';
import { curveQuote } from '../src/pons.js';
import { poolId } from '../src/v4.js';
import { artifact, ponsFixtures, modernRouterFixture } from './solidity.js';

const require = createRequire(import.meta.url);
const sqrt = (n: bigint) => {
  let a = n,
    b = (n + 1n) / 2n;
  while (b < a) {
    a = b;
    b = (a + n / a) / 2n;
  }
  return a;
};
async function localEvm() {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const arch = process.arch === 'x64' ? 'amd64' : process.arch;
  const system = process.platform === 'win32' ? 'win32' : process.platform;
  const executable = require.resolve(
    `@foundry-rs/anvil-${system}-${arch}/bin/anvil${process.platform === 'win32' ? '.exe' : ''}`,
  );
  const child = spawn(
    executable,
    [
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--accounts',
      '0',
      '--hardfork',
      'cancun',
      '--silent',
    ],
    { stdio: 'ignore' },
  );
  const provider = new JsonRpcProvider(`http://127.0.0.1:${port}`, 31337, {
    cacheTimeout: 0,
    batchMaxCount: 1,
    pollingInterval: 20,
    staticNetwork: true,
  });
  try {
    for (let i = 0; i < 100; i++) {
      try {
        await provider.getBlockNumber();
        return { child, provider };
      } catch {
        await sleep(50);
      }
    }
    throw Error('Local Anvil did not start');
  } catch (e) {
    provider.destroy();
    child.kill();
    throw e;
  }
}

test(
  'PONS: actual curve fills, refund accounting, tax gate, recovery, graduation and modern V4 native ETH exit',
  { timeout: 300000 },
  async (t) => {
    t.diagnostic('Compiling pinned PONS and modern Universal Router test fixtures');
    const compiled = ponsFixtures();
    const modernRouter = modernRouterFixture();
    const { child, provider } = await localEvm();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'banger-pons-'));
    let engine: Engine | undefined, paper: Engine | undefined, partial: Engine | undefined;
    try {
      const owner = Wallet.createRandom().connect(provider);
      const buyer = Wallet.createRandom().connect(provider);
      const partialBuyer = Wallet.createRandom().connect(provider);
      for (const wallet of [owner, buyer, partialBuyer])
        await provider.send('anvil_setBalance', [wallet.address, toBeHex(parseEther('100'))]);
      const deploy = async (a: any, args: any[] = []) => {
        const code = a.evm?.bytecode.object ?? a.bytecode?.object ?? a.bytecode;
        const contract = await new ContractFactory(a.abi, code, owner).deploy(...args);
        await contract.waitForDeployment();
        return contract as any;
      };
      const local = compiled['PonsFixture.sol'];
      const weth = await deploy(compiled['Tokens.sol'].TestWETH);
      const manager = await deploy(
        artifact('@uniswap/v4-core/out/PoolManager.sol/PoolManager.json'),
        [owner.address],
      );
      const managerAddress = await manager.getAddress();
      // Official Permit2 test helper supplies its published runtime bytecode.
      const permitSource = fs.readFileSync(
        require.resolve('@uniswap/v4-periphery/lib/permit2/test/utils/DeployPermit2.sol'),
        'utf8',
      );
      const permitCode = permitSource.match(/hex"([0-9a-fA-F]+)"/)![1]!;
      const permitAddress = loadConfig({}).PERMIT2;
      await provider.send('anvil_setCode', [permitAddress, '0x' + permitCode]);
      const escrow = await deploy(local.FixtureEscrow);
      const create2 = await deploy(local.FixtureCreate2);
      const hookArtifact = compiled['pons/hooks/PonsV2MemeHook.sol'].PonsV2MemeHook;
      const initCode = (
        await new ContractFactory(
          hookArtifact.abi,
          hookArtifact.evm.bytecode.object,
          owner,
        ).getDeployTransaction(
          managerAddress,
          await escrow.getAddress(),
          owner.address,
          owner.address,
        )
      ).data!;
      const initHash = keccak256(initCode),
        deployerAddress = await create2.getAddress();
      let salt = 0n,
        hookAddress: string;
      do {
        hookAddress = getCreate2Address(deployerAddress, toBeHex(salt++, 32), initHash);
      } while ((BigInt(hookAddress) & 0x3fffn) !== 0x2044n);
      await (await create2.deploy(toBeHex(salt - 1n, 32), initCode)).wait();
      const hook = new Contract(hookAddress, hookArtifact.abi, owner);
      const factory = await deploy(local.FixtureFactory, [
        managerAddress,
        permitAddress,
        hookAddress,
      ]);
      await (await hook.getFunction('setFactory')(await factory.getAddress())).wait();
      const view = await deploy(
        artifact('@uniswap/v4-periphery/foundry-out/StateView.sol/StateView.json'),
        [managerAddress],
      );
      const quoter = await deploy(
        artifact('@uniswap/v4-periphery/foundry-out/V4Quoter.sol/V4Quoter.json'),
        [managerAddress],
      );
      const params = {
        permit2: permitAddress,
        weth9: await weth.getAddress(),
        v2Factory: ZeroAddress,
        v3Factory: ZeroAddress,
        pairInitCodeHash: ZeroHash,
        poolInitCodeHash: ZeroHash,
        v4PoolManager: managerAddress,
        permissionsAdapterFactory: ZeroAddress,
        v3NFTPositionManager: ZeroAddress,
        v4PositionManager: ZeroAddress,
        spokePool: ZeroAddress,
      };
      const router = await deploy(modernRouter, [params]);
      const lp = await deploy(
        artifact('@uniswap/v4-core/out/PoolModifyLiquidityTest.sol/PoolModifyLiquidityTest.json'),
        [managerAddress],
      );
      const launch = async (quote = ZeroAddress) => {
        const token = await deploy(compiled['Tokens.sol'].TestToken, ['PONS local test', 'PONST']);
        const curve = await deploy(local.FixtureCurve, [
          await factory.getAddress(),
          quote,
          hookAddress,
          await escrow.getAddress(),
        ]);
        await (await token.mint(await curve.getAddress(), parseEther('1000'))).wait();
        await (
          await factory.register(await token.getAddress(), await curve.getAddress(), quote)
        ).wait();
        return { token, curve };
      };
      const { token, curve } = await launch();
      await (
        await curve.buy(parseEther('.02'), 1n, owner.address, { value: parseEther('.02') })
      ).wait();
      const env = {
        MODE: 'live',
        VENUES: 'pons',
        CHAIN_ID: '31337',
        RPC_URL: 'http://127.0.0.1:1',
        PONS_V2_FACTORY: await factory.getAddress(),
        V4_POOL_MANAGER: managerAddress,
        V4_ROUTER: await router.getAddress(),
        V4_QUOTER: await quoter.getAddress(),
        V4_STATE_VIEW: await view.getAddress(),
        PERMIT2: permitAddress,
        V4_ROUTER_VERSION: '2.1.1',
        WETH: await weth.getAddress(),
        DATA_DIR: root,
        PRIVATE_KEY: buyer.privateKey,
        LIVE_ACK: 'I_ACCEPT_REAL_TRADES',
        CONFIRMATIONS: '1',
        MIN_POOL_AGE_BLOCKS: '1',
        MAX_POOL_AGE_SECONDS: '3600',
        LOOKBACK_BLOCKS: '1000',
        MAX_FEE_GWEI: '100',
        MAX_GAS_PER_TX_ETH: '0.01',
        TX_WAIT_MS: '2000',
      };
      paper = new Engine(loadConfig({ ...env, MODE: 'paper' }), provider);
      await paper.init();
      const ownerNonce = await provider.getTransactionCount(owner.address);
      await paper.tick();
      assert.equal(
        Object.keys(paper.store.state.positions).length,
        1,
        'paper discovers and quotes PONS',
      );
      assert.equal(
        await provider.getTransactionCount(owner.address),
        ownerNonce,
        'paper signs nothing',
      );
      paper.store.release();
      paper = undefined;

      engine = new Engine(loadConfig(env), provider);
      await engine.init();
      await engine.scan();
      const pool = await curve.getAddress(),
        tok = await token.getAddress();
      const candidate = engine.store.state.pools[pool]!;
      assert.equal(candidate.venue, 'pons');
      await (await curve.setTestSnipeTax(9900)).wait();
      await engine.tick();
      assert.equal(
        await provider.getTransactionCount(buyer.address),
        0,
        'opening tax blocks entry',
      );
      assert.match(candidate.reason, /snipe tax/);
      await (await curve.setTestSnipeTax(0)).wait();
      const market = await engine.dex.market(pool, 'pons');
      const q = await engine.dex.quote(market, engine.c.BUY_ETH);
      const normalReceipt = provider.getTransactionReceipt.bind(provider);
      provider.getTransactionReceipt = async () => null;
      await engine.buy(candidate, market);
      assert.ok(engine.store.state.pending, 'unknown outcome retains signed curve transaction');
      provider.getTransactionReceipt = normalReceipt;
      const nonceAfterBuy = await provider.getTransactionCount(buyer.address);
      engine.store.release();
      engine = new Engine(loadConfig(env), provider);
      await engine.init();
      await engine.tx!.reconcile();
      assert.equal(
        await provider.getTransactionCount(buyer.address),
        nonceAfterBuy,
        'recovery does not double-buy',
      );
      let position = engine.store.state.positions[tok]!;
      assert.equal(BigInt(position.amountWei), q.out);
      assert.equal(await token.balanceOf(buyer.address), q.out);
      assert.equal(position.entryWei, engine.c.BUY_ETH.toString());
      assert.equal(position.venue, 'pons');

      // Sell on the real base curve, with an exact allowance and receipt PNL.
      const sellMarket = await engine.dex.market(pool, 'pons');
      const expectedExit = await engine.dex.quote(sellMarket, q.out, true);
      await engine.sell(position, sellMarket, 'TEST CURVE EXIT');
      assert.equal(await token.allowance(buyer.address, pool), q.out);
      await engine.sell(position, await engine.dex.market(pool, 'pons'), 'TEST CURVE EXIT');
      assert.ok(position.closedAt);
      assert.equal(BigInt(position.exitWei!), expectedExit.out);
      assert.equal(await token.balanceOf(buyer.address), 0n);
      assert.equal(
        BigInt(engine.store.state.realizedWei),
        expectedExit.out - BigInt(position.entryWei) - BigInt(position.gasWei),
      );
      t.diagnostic('PONS buy, native sell, exact approval and pending recovery passed');

      // A different launch finishes during our oversized buy and returns excess ETH.
      const last = await launch();
      await (
        await last.curve.buy(parseEther('.02'), 1n, owner.address, { value: parseEther('.02') })
      ).wait();
      partial = new Engine(
        loadConfig({
          ...env,
          PRIVATE_KEY: partialBuyer.privateKey,
          BUY_ETH: '2',
          MAX_SESSION_SPEND_ETH: '5',
          MAX_PRICE_MOVE_BPS: '5000',
          MAX_SESSION_LOSS_ETH: '2',
        }),
        provider,
      );
      await partial.init();
      await partial.scan();
      const lastPool = await last.curve.getAddress(),
        lastToken = await last.token.getAddress();
      const finalMarket = await partial.dex.market(lastPool, 'pons');
      const finalQuote = curveQuote(finalMarket.pons!, parseEther('2'));
      assert.ok(finalQuote.spent! < parseEther('2'));
      const beforeBuy = await provider.getBalance(partialBuyer.address);
      await partial.buy(partial.store.state.pools[lastPool]!, finalMarket);
      position = partial.store.state.positions[lastToken]!;
      assert.ok(position, 'partially filled buy tracked');
      assert.equal(BigInt(position.entryWei), finalQuote.spent);
      assert.equal(BigInt(position.amountWei), finalQuote.out);
      assert.equal(
        partial.store.state.halt,
        '',
        'valid partial rate does not trip an absolute quantity halt',
      );
      assert.equal(
        beforeBuy - (await provider.getBalance(partialBuyer.address)),
        BigInt(position.entryWei) + BigInt(position.gasWei),
      );
      assert.equal(await last.curve.readyToGraduate(), true);
      await assert.rejects(
        partial.dex.quote(
          await partial.dex.market(lastPool, 'pons'),
          BigInt(position.amountWei),
          true,
        ),
        /curve closed/,
      );
      await partial.managePositions();
      assert.equal(position.closedAt, undefined, 'closed curve retains the real holding');
      // A PONS custom quote asset is not mislabeled as native ETH.
      const custom = await launch(await weth.getAddress());
      await partial.scan();
      assert.equal(partial.store.state.pools[await custom.curve.getAddress()], undefined);
      t.diagnostic('Partial refund, exact cost basis and custom-pair filtering passed');

      await (await factory.setAllowGraduation(true)).wait();
      await (await factory.graduate(lastToken)).wait();
      await assert.rejects(partial.dex.market(lastPool, 'pons'), /graduation pending/);
      const record = await factory.getLaunchedToken(lastToken);
      const sqrtPrice = sqrt((BigInt(record.sweptTokens) << 192n) / BigInt(record.sweptQuote));
      const liquidity = (sqrt(BigInt(record.sweptTokens) * BigInt(record.sweptQuote)) * 9n) / 10n;
      await (await factory.seed(lastToken, await lp.getAddress(), sqrtPrice, liquidity)).wait();
      const graduated = await partial.dex.market(lastPool, 'pons');
      assert.equal(graduated.route, 'v4');
      const id = poolId(graduated.pons!.key);
      const nativeBalance = await provider.getBalance(partialBuyer.address);
      const v4Quote = await partial.dex.quote(graduated, BigInt(position.amountWei), true);
      assert.ok(v4Quote.out > 0n);
      for (let i = 0; i < 4 && !position.closedAt; i++) {
        position.nextExitTry = 0;
        await partial.managePositions();
      }
      assert.ok(position.closedAt, partial.store.state.events.at(-1)?.message);
      assert.equal(BigInt(position.exitWei!), v4Quote.out, 'net V4 exit includes PONS hook fee');
      assert.equal(await last.token.balanceOf(partialBuyer.address), 0n);
      assert.equal(await weth.balanceOf(partialBuyer.address), 0n, 'exit delivers native ETH');
      assert.ok((await provider.getBalance(partialBuyer.address)) > nativeBalance);
      const permit = new Contract(permitAddress, PERMIT2, provider);
      assert.equal(
        (
          await permit.getFunction('allowance')(
            partialBuyer.address,
            lastToken,
            await router.getAddress(),
          )
        )[0],
        0n,
      );
      assert.equal(await last.token.allowance(partialBuyer.address, permitAddress), 0n);
      assert.ok(
        (await hook.getFunction('pendingFees')(id, ZeroAddress)) > 0n,
        'real PONS hook collected ETH fee',
      );
      assert.equal(
        BigInt(partial.store.state.realizedWei),
        BigInt(position.exitWei!) - BigInt(position.entryWei) - BigInt(position.gasWei),
      );
      t.diagnostic('Actual PONS hook + modern V4 router + Permit2 + native ETH receipt PNL passed');
    } finally {
      engine?.store.release();
      paper?.store.release();
      partial?.store.release();
      provider.destroy();
      child.kill();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
