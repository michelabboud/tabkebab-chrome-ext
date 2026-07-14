import { expect, test } from 'bun:test';

test('every repository JavaScript file parses', async () => {
  const listed = Bun.spawnSync([
    'git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '*.js',
  ]);
  expect(listed.exitCode).toBe(0);
  const files = new TextDecoder()
    .decode(listed.stdout)
    .split('\0')
    .filter(Boolean);
  expect(files.length).toBeGreaterThan(0);
  const transpiler = new Bun.Transpiler({ loader: 'js' });
  for (const file of files) {
    const source = await Bun.file(file).text();
    expect(() => transpiler.transformSync(source)).not.toThrow();
  }
});

test('manifest is MV3 and mirrors VERSION', async () => {
  const manifest = JSON.parse(await Bun.file('manifest.json').text());
  const version = (await Bun.file('VERSION').text()).trim();

  expect(manifest.manifest_version).toBe(3);
  expect(manifest.version).toBe(version);
});
