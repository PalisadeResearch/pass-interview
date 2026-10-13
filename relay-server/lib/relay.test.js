import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';

async function createHarness() {
  const output = [];
  const sent = [];
  const handlers = new Map();
  const context = createContext({
    URL,
    console: {
      log: (...args) => output.push(args),
      error: (...args) => output.push(args),
    },
  });
  class FakeRealtimeClient {
    constructor() {
      this.realtime = {
        on() {},
        send: (...args) => sent.push(args),
      };
    }
    isConnected() { return true; }
    async connect() {}
    disconnect() {}
  }
  const source = await readFile(new URL('./relay.js', import.meta.url), 'utf8');
  const module = new SourceTextModule(source, { context });
  await module.link((specifier) => {
    if (specifier === 'ws') {
      return new SyntheticModule(['WebSocketServer'], function () {
        this.setExport('WebSocketServer', class {
          constructor() { throw new Error('A real listener must not be started'); }
        });
      }, { context });
    }
    assert.equal(specifier, '@openai/realtime-api-beta');
    return new SyntheticModule(['RealtimeClient'], function () {
      this.setExport('RealtimeClient', FakeRealtimeClient);
    }, { context });
  });
  await module.evaluate();
  const relay = new module.namespace.RealtimeRelay('sk-test-only-fake-credential');
  const ws = {
    on: (event, handler) => handlers.set(event, handler),
    close() {},
    send() {},
  };
  await relay.connectionHandler(ws, { url: '/', headers: { host: 'localhost' } });
  return { output, sent, message: handlers.get('message') };
}

test('malformed client messages never expose payloads or parser excerpts in logs', async () => {
  const harness = await createHarness();
  harness.message('PRIVATE_TEST_SENTINEL_not_valid_json');
  assert.equal(harness.sent.length, 0);
  assert.ok(harness.output.some((entry) => String(entry[1]).includes('Error')));
  assert.ok(!JSON.stringify(harness.output).includes('PRIVATE_TEST_SENTINEL'));
});

test('well-formed events still reach the mocked client once', async () => {
  const harness = await createHarness();
  harness.message(JSON.stringify({ type: 'test.event', value: 42 }));
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0][0], 'test.event');
  assert.equal(harness.sent[0][1].value, 42);
});
