import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import solc from 'solc';

const require = createRequire(import.meta.url);
export const artifact = (name: string) =>
  JSON.parse(fs.readFileSync(require.resolve(name), 'utf8'));
export function compile(
  sources: Record<string, { content: string }>,
  targets: Record<string, string[]>,
  compiler = solc,
  runs = 200,
) {
  const digest = createHash('sha256')
    .update(JSON.stringify({ sources, targets, compiler: compiler.version(), runs }))
    .update(fs.readFileSync('package-lock.json'))
    .digest('hex');
  const cache = path.join(os.tmpdir(), 'banger-solidity-cache');
  const cacheFile = path.join(cache, digest + '.json');
  if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  const selection = Object.fromEntries(
    Object.entries(targets).map(([file, names]) => [
      file,
      Object.fromEntries(names.map((name) => [name, ['abi', 'evm.bytecode.object']])),
    ]),
  );
  const result = JSON.parse(
    compiler.compile(
      JSON.stringify({
        language: 'Solidity',
        sources,
        settings: {
          evmVersion: 'cancun',
          viaIR: true,
          optimizer: { enabled: true, runs },
          outputSelection: selection,
          remappings: [
            '@openzeppelin/contracts/token/ERC721/IERC721Enumerable.sol=@openzeppelin/contracts/token/ERC721/extensions/IERC721Enumerable.sol',
            '@openzeppelin/contracts/token/ERC721/IERC721Metadata.sol=@openzeppelin/contracts/token/ERC721/extensions/IERC721Metadata.sol',
          ],
        },
      }),
      {
        import: (file: string) => {
          try {
            return { contents: fs.readFileSync(path.resolve('node_modules', file), 'utf8') };
          } catch {
            return { error: 'Missing Solidity import: ' + file };
          }
        },
      },
    ),
  );
  const errors = result.errors?.filter((e: any) => e.severity === 'error') ?? [];
  assert.deepEqual(
    errors.map((e: any) => e.formattedMessage),
    [],
    'Test contract compilation',
  );
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(result.contracts));
  return result.contracts;
}
export function ponsFixtures() {
  const bundle = artifact('./fixtures/pons-sources.json');
  return compile(
    {
      ...bundle.sources,
      'PonsFixture.sol': {
        content: fs.readFileSync(new URL('./fixtures/PonsFixture.sol', import.meta.url), 'utf8'),
      },
      'Tokens.sol': {
        content: fs.readFileSync(new URL('./fixtures/Tokens.sol', import.meta.url), 'utf8'),
      },
    },
    {
      'PonsFixture.sol': ['FixtureCurve', 'FixtureFactory', 'FixtureEscrow', 'FixtureCreate2'],
      'pons/hooks/PonsV2MemeHook.sol': ['PonsV2MemeHook'],
      'Tokens.sol': ['TestWETH', 'TestToken'],
    },
  );
}
export function modernRouterFixture() {
  const bundle = artifact('./fixtures/modern-router-sources.json');
  return compile(
    bundle.sources,
    { 'ur/UniversalRouter.sol': ['UniversalRouter'] },
    require('solc-0-8-26'),
    1,
  )['ur/UniversalRouter.sol'].UniversalRouter;
}
