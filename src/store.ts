import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Config } from './config.js';

export interface Candidate {
  pool: string;
  token: string;
  fee: number;
  block: number;
  blockHash: string;
  createdAt: number;
  status: 'waiting' | 'ready' | 'entered' | 'expired' | 'blocked';
  reason: string;
  symbol: string;
  decimals: number;
  nextTry: number;
}
export interface Position {
  pool: string;
  token: string;
  symbol: string;
  decimals: number;
  fee: number;
  amountWei: string;
  entryWei: string;
  gasWei: string;
  openedAt: number;
  closedAt?: number;
  exitWei?: string;
  markWei: string;
  markAt: number;
  buyHash?: string;
  sellHash?: string;
  nextExitTry: number;
}
export interface Pending {
  hash: string;
  raw: string;
  nonce: number;
  action: 'buy' | 'sell' | 'approve';
  token: string;
  pool: string;
  amountWei: string;
  minimumWei: string;
  createdAt: number;
}
export interface Entry {
  at: number;
  kind: string;
  message: string;
}
export interface State {
  version: 1;
  identity: string;
  cursor: number;
  cursorHash: string;
  spentWei: string;
  realizedWei: string;
  gasWei: string;
  pools: Record<string, Candidate>;
  positions: Record<string, Position>;
  pending: Pending | null;
  events: Entry[];
  halt: string;
}
export function fresh(identity: string): State {
  return {
    version: 1,
    identity,
    cursor: -1,
    cursorHash: '',
    spentWei: '0',
    realizedWei: '0',
    gasWei: '0',
    pools: {},
    positions: {},
    pending: null,
    events: [],
    halt: '',
  };
}
export function identity(c: Config, account: string): string {
  return [c.CHAIN_ID, c.MODE, account, c.V3_FACTORY, c.V3_ROUTER, c.V3_QUOTER, c.WETH]
    .map(String)
    .join(':')
    .toLowerCase();
}
export class Store {
  readonly file: string;
  readonly lock: string;
  readonly pauseFile: string;
  state: State;
  private owned = false;
  constructor(
    readonly directory: string,
    readonly id: string,
  ) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = path.join(directory, 'state.json');
    this.lock = path.join(directory, 'process.lock');
    this.pauseFile = path.join(directory, 'PAUSE');
    if (fs.existsSync(this.file)) {
      this.state = JSON.parse(fs.readFileSync(this.file, 'utf8')) as State;
      if (this.state.version !== 1 || this.state.identity !== id)
        throw Error(
          'State identity mismatch. Use a separate DATA_DIR for a different chain, mode, wallet or router.',
        );
      for (const key of ['spentWei', 'realizedWei', 'gasWei'] as const)
        if (!/^-?\d+$/.test(this.state[key]))
          throw Error('Invalid state ledger; restore a reviewed backup, never silently reset it.');
      if (!this.state.pools || !this.state.positions || !Array.isArray(this.state.events))
        throw Error('Invalid state format');
    } else this.state = fresh(id);
  }
  acquire() {
    try {
      fs.writeFileSync(this.lock, JSON.stringify({ pid: process.pid, host: os.hostname() }), {
        flag: 'wx',
        mode: 0o600,
      });
      this.owned = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const owner = JSON.parse(fs.readFileSync(this.lock, 'utf8')) as { pid: number; host: string };
      if (owner.host !== os.hostname()) throw Error('State is locked by another host');
      try {
        process.kill(owner.pid, 0);
        throw Error('Another BANGER process is using this state');
      } catch (x) {
        if ((x as NodeJS.ErrnoException).code !== 'ESRCH') throw x;
      }
      fs.unlinkSync(this.lock);
      this.acquire();
    }
  }
  save() {
    if (!this.owned) throw Error('State must be locked before writing');
    const tmp = this.file + '.tmp';
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(this.state, null, 2) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
    // Directory fsync is supported on POSIX; Windows uses rename's durability.
    if (process.platform !== 'win32') {
      const d = fs.openSync(this.directory, 'r');
      try {
        fs.fsyncSync(d);
      } finally {
        fs.closeSync(d);
      }
    }
  }
  event(kind: string, message: string) {
    this.state.events.push({ at: Date.now(), kind, message });
    this.state.events = this.state.events.slice(-100);
    this.save();
  }
  release() {
    if (this.owned) {
      fs.unlinkSync(this.lock);
      this.owned = false;
    }
  }
  get paused() {
    return fs.existsSync(this.pauseFile) || !!this.state.halt;
  }
}
export function stateDirectory(c: Config, account: string) {
  return path.resolve(c.DATA_DIR, `${c.MODE}-${c.CHAIN_ID}-${account.toLowerCase().slice(0, 12)}`);
}
