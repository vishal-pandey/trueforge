import {
  EXEC_TIMEOUT_EXIT_CODE,
  buildExecArgv,
  buildStatArgv,
  buildUploadArgv,
  timeoutNote,
} from '../../../../../src/core/sandbox/provider/kubernetes/execArgv';

describe('buildExecArgv', () => {
  it('wraps the command in timeout + sh with stderr merged and cwd', () => {
    const argv = buildExecArgv({ command: 'echo hi', cwd: '/opt/tf', timeoutSeconds: 30 });
    expect(argv.slice(0, 4)).toEqual(['timeout', '--kill-after=5s', '30s', '/bin/sh']);
    expect(argv[4]).toBe('-c');
    expect(argv[5]).toBe("exec 2>&1\ncd '/opt/tf' || exit 1\necho hi");
  });

  it('defaults cwd to the sandbox home', () => {
    expect(buildExecArgv({ command: 'pwd', timeoutSeconds: 5 })[5]).toBe(
      "exec 2>&1\ncd '/home/trueforge' || exit 1\npwd",
    );
  });

  it('escapes hostile env values literally', () => {
    const script = buildExecArgv({
      command: 'printenv A',
      env: { A: `it's "$HOME"\n; rm -rf /` },
      timeoutSeconds: 5,
    })[5];
    expect(script).toBe(
      `exec 2>&1\nexport A='it'\\''s "$HOME"\n; rm -rf /'\ncd '/home/trueforge' || exit 1\nprintenv A`,
    );
  });

  it('rejects invalid env keys', () => {
    expect(() => buildExecArgv({ command: 'true', env: { 'A;B': 'x' }, timeoutSeconds: 5 })).toThrow(
      'Invalid environment variable name: A;B',
    );
  });

  it('rounds timeout up to whole seconds, minimum 1', () => {
    expect(buildExecArgv({ command: 'true', timeoutSeconds: 0.2 })[2]).toBe('1s');
    expect(buildExecArgv({ command: 'true', timeoutSeconds: 1.5 })[2]).toBe('2s');
  });
});

describe('file argv', () => {
  it('stat reports size and maps missing/dir to exit codes 3/4 without interpolating the path', () => {
    const argv = buildStatArgv("/tmp/a b'c");
    expect(argv[0]).toBe('/bin/sh');
    expect(argv[argv.length - 1]).toBe("/tmp/a b'c");
    expect(argv[2]).toContain('exit 3');
    expect(argv[2]).toContain('exit 4');
    expect(argv[2]).not.toContain("a b'c");
  });

  it('upload creates the parent dir and writes stdin to the path', () => {
    const argv = buildUploadArgv('/opt/tf/uploads/x.bin');
    expect(argv).toEqual(['/bin/sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', '/opt/tf/uploads/x.bin']);
  });
});

describe('timeoutNote', () => {
  it('is appended only for the timeout exit code', () => {
    expect(EXEC_TIMEOUT_EXIT_CODE).toBe(124);
    expect(timeoutNote(124, 30)).toBe('\n[command timed out after 30s]');
    expect(timeoutNote(0, 30)).toBe('');
  });
});
