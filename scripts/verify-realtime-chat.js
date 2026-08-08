// Per-archetype behavior health check for realtime-chat.
// Proves: WS upgrade succeeds, message broadcasts to another client, row persists.
const WebSocket = require('ws');

const API = process.argv[2];
const WS = API.replace(/^http/, 'ws');
const marker = 'zepit-verify-' + Date.now();

const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
const timer = setTimeout(() => fail('timed out waiting for broadcast'), 25000);

const listener = new WebSocket(WS);
listener.on('error', (e) => fail('listener ws error: ' + e.message));

listener.on('open', () => {
  console.log('PASS: websocket upgrade (listener)');
  listener.send(JSON.stringify({ type: 'join', room: 'general' }));
});

listener.on('message', async (raw) => {
  const m = JSON.parse(raw.toString());

  if (m.type === 'joined') {
    const sender = new WebSocket(WS);
    sender.on('error', (e) => fail('sender ws error: ' + e.message));
    sender.on('open', () => {
      console.log('PASS: websocket upgrade (sender)');
      sender.send(JSON.stringify({ type: 'join', room: 'general' }));
      setTimeout(() => sender.send(JSON.stringify({ author: 'verifier', body: marker })), 500);
    });
    return;
  }

  if (m.type === 'message' && m.body === marker) {
    clearTimeout(timer);
    console.log('PASS: message broadcast to second client');

    const rows = await fetch(`${API}/api/messages?room=general`).then((r) => r.json());
    if (!rows.some((r) => r.body === marker)) fail('message did not persist to postgres');
    console.log('PASS: message persisted in postgres (' + rows.length + ' rows in room)');
    console.log('\nALL CHECKS PASSED');
    process.exit(0);
  }
});
