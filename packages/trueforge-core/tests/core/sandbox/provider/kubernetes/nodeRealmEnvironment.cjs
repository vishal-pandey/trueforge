/**
 * Jest env for the live-cluster suite. undici (via @kubernetes/client-node) does
 * `events.addAbortListener(...)[Symbol.dispose]`; Node defines `Symbol.dispose` on the host
 * realm only, so inside Jest's VM context it is undefined ("removeAbortListener is not a
 * function"). Share the host realm's well-known dispose symbols with the test context.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Jest loads custom environments as CommonJS
const { TestEnvironment } = require('jest-environment-node');

class NodeRealmEnvironment extends TestEnvironment {
  constructor(config, context) {
    super(config, context);
    for (const key of ['dispose', 'asyncDispose']) {
      if (Symbol[key] !== undefined) {
        Object.defineProperty(this.global.Symbol, key, { value: Symbol[key], configurable: true });
      }
    }
  }
}

module.exports = NodeRealmEnvironment;
