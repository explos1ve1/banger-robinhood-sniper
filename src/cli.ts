#!/usr/bin/env node
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import dotenv from 'dotenv';
import { Wallet, parseEther } from 'ethers';
import { loadConfig, safeError } from './config.js';
import { Engine } from './engine.js';
import { makeProvider } from './v3.js';
import { Venues } from './venues.js';
import { Store, identity, stateDirectory } from './store.js';
import { terminal } from './terminal.js';
import { demoState } from './demo.js';

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      mode: { type: 'string' },
      once: { type: 'boolean' },
      headless: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  const command = positionals[0] ?? 'run';
  if (values.help) {
    console.log(
      'BANGER\n  demo [--once]\n  doctor\n  run [--mode watch|paper|live] [--headless] [--once]\n  status | pause | resume\n\nCopy .env.example to .env. Read README.md before enabling live mode.',
    );
    return;
  }
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const tty = process.stdout.isTTY && !values.headless;
  const draw = (s: string) => {
    if (tty) process.stdout.write('\x1b[H\x1b[2J');
    process.stdout.write(s + '\n');
  };
  if (command === 'demo') {
    let tick = 0;
    const cfg = {
      MODE: 'paper' as const,
      CHAIN_ID: 4663,
      BUY_ETH: parseEther('.001'),
      MAX_SESSION_SPEND_ETH: parseEther('.01'),
      MAX_OPEN_POSITIONS: 3,
    };
    do {
      draw(
        terminal(
          demoState(values.once ? 15 : tick * 0.2),
          cfg,
          120 + tick,
          true,
          process.stdout.columns ?? 116,
        ),
      );
      tick++;
      if (!values.once) await sleep(200);
    } while (!stopping && !values.once);
    return;
  }
  const fileEnv = fs.existsSync('.env') ? dotenv.parse(fs.readFileSync('.env')) : {};
  const env = { ...fileEnv, ...process.env, ...(values.mode ? { MODE: values.mode } : {}) };
  const c = loadConfig(env);
  if (command === 'doctor') {
    const provider = makeProvider(c);
    try {
      console.log(JSON.stringify(await new Venues(c, provider).doctor(), null, 2));
    } finally {
      provider.destroy();
    }
    return;
  }
  const account = c.MODE === 'live' ? new Wallet(c.PRIVATE_KEY).address : 'no-signer';
  if (['status', 'pause', 'resume'].includes(command)) {
    const store = new Store(stateDirectory(c, account), identity(c, account));
    if (command === 'pause') {
      fs.writeFileSync(store.pauseFile, 'Operator paused new entries.\n');
      console.log('New entries paused. Existing positions remain managed.');
    } else if (command === 'resume') {
      if (store.state.halt)
        throw Error('Accounting halt requires inspection; resume will not erase it.');
      fs.rmSync(store.pauseFile, { force: true });
      console.log('New entries resumed within configured limits.');
    } else draw(terminal(store.state, c, 0, false, process.stdout.columns ?? 116, store.paused));
    return;
  }
  if (command !== 'run') throw Error('Unknown command. Use --help.');
  const engine = new Engine(c);
  let cleanup = () => {};
  const stopEngine = () => {
    engine.stopping = true;
    stopping = true;
  };
  process.on('SIGINT', stopEngine);
  process.on('SIGTERM', stopEngine);
  try {
    await engine.init();
    if (tty && process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      const key = (buffer: Buffer) => {
        const k = buffer.toString();
        if (k === 'q' || k === '\u0003') stopEngine();
        if (k === 'p') fs.writeFileSync(engine.store.pauseFile, 'Operator paused new entries.\n');
        if (k === 'r' && !engine.store.state.halt)
          fs.rmSync(engine.store.pauseFile, { force: true });
      };
      process.stdin.on('data', key);
      cleanup = () => {
        process.stdin.off('data', key);
        process.stdin.setRawMode(false);
        process.stdin.pause();
      };
    }
    let failures = 0;
    do {
      try {
        await engine.tick();
        failures = 0;
      } catch (e) {
        engine.connected = false;
        failures++;
        engine.store.event('RPC / RETRY', safeError(e));
      }
      if (tty)
        draw(
          terminal(
            engine.store.state,
            c,
            engine.block,
            false,
            process.stdout.columns ?? 116,
            engine.store.paused,
          ),
        );
      else
        console.log(
          JSON.stringify({
            mode: c.MODE,
            block: engine.block,
            connected: engine.connected,
            pending: engine.store.state.pending?.hash ?? null,
            last: engine.store.state.events.at(-1),
          }),
        );
      if (!stopping && !values.once)
        await sleep(Math.min(30000, c.POLL_MS * 2 ** Math.min(failures, 4)));
    } while (!stopping && !values.once);
  } finally {
    cleanup();
    engine.close();
    process.off('SIGINT', stopEngine);
    process.off('SIGTERM', stopEngine);
  }
}
main().catch((e) => {
  console.error('BANGER: ' + safeError(e));
  process.exitCode = 1;
});
