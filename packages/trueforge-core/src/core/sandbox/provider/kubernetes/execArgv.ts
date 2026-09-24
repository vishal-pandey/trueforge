import { shellEscape } from '../Provider';

export const SANDBOX_HOME = '/home/trueforge';
/** GNU `timeout` exit status when the command ran past its deadline. */
export const EXEC_TIMEOUT_EXIT_CODE = 124;
/** `buildStatArgv` exit codes. */
export const STAT_EXIT_NOT_FOUND = 3;
export const STAT_EXIT_IS_DIR = 4;

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Exec argv for one command: in-pod `timeout`, stderr merged into stdout, env exported
 * via shell-escaped literals, cwd defaulting to the sandbox home.
 */
export function buildExecArgv(params: {
  command: string;
  cwd?: string | undefined;
  env?: Record<string, string> | undefined;
  timeoutSeconds: number;
}): string[] {
  const exports = Object.entries(params.env ?? {}).map(([key, value]) => {
    if (!ENV_KEY_RE.test(key)) {
      throw new Error(`Invalid environment variable name: ${key}`);
    }
    return `export ${key}=${shellEscape(value)}`;
  });
  const script = [
    'exec 2>&1',
    ...exports,
    `cd ${shellEscape(params.cwd ?? SANDBOX_HOME)} || exit 1`,
    params.command,
  ].join('\n');
  const seconds = Math.max(1, Math.ceil(params.timeoutSeconds));
  return ['timeout', '--kill-after=5s', `${String(seconds)}s`, '/bin/sh', '-c', script];
}

/** Prints the file size; exit 3 = missing, 4 = directory. Path passed as $1, never interpolated. */
export function buildStatArgv(path: string): string[] {
  return [
    '/bin/sh',
    '-c',
    `if [ ! -e "$1" ]; then exit ${String(STAT_EXIT_NOT_FOUND)}; fi; if [ -d "$1" ]; then exit ${String(STAT_EXIT_IS_DIR)}; fi; stat -c %s "$1"`,
    'sh',
    path,
  ];
}

export function buildCatArgv(path: string): string[] {
  return ['cat', '--', path];
}

/** Writes stdin to $1, creating parent directories. */
export function buildUploadArgv(remotePath: string): string[] {
  return ['/bin/sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', remotePath];
}

export function timeoutNote(exitCode: number, timeoutSeconds: number): string {
  return exitCode === EXEC_TIMEOUT_EXIT_CODE ? `\n[command timed out after ${String(Math.ceil(timeoutSeconds))}s]` : '';
}
