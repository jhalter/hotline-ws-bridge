// End-to-end test of the bridge: Node -> your deployed Worker -> TCP to a real
// Hotline server. Performs the TRTP handshake and a guest login, then checks
// that a non-Hotline port is refused.
//
// Usage: node bridge-test.mjs <bridge-url> <hotline-host>
//   e.g. node bridge-test.mjs wss://hotline-ws-bridge.example.workers.dev/connect hotline.example.org
// Or via env: BRIDGE_URL=... HOTLINE_HOST=... node bridge-test.mjs
const URL_BASE = process.argv[2] ?? process.env.BRIDGE_URL;
const HOST = process.argv[3] ?? process.env.HOTLINE_HOST;
if (!URL_BASE || !HOST) {
  console.error("usage: node bridge-test.mjs <bridge-url> <hotline-host>");
  process.exit(2);
}

const enc = new TextEncoder();
const obfuscate = (s) => enc.encode(s).map((b) => b ^ 0xff);

function field(id, data) {
  const buf = new Uint8Array(4 + data.length);
  const dv = new DataView(buf.buffer);
  dv.setUint16(0, id);
  dv.setUint16(2, data.length);
  buf.set(data, 4);
  return buf;
}
let nextTranID = 1;
function transaction(type, fields) {
  const payloadLen = 2 + fields.reduce((n, f) => n + f.length, 0);
  const buf = new Uint8Array(20 + payloadLen);
  const dv = new DataView(buf.buffer);
  dv.setUint16(2, type);
  dv.setUint32(4, nextTranID++);
  dv.setUint32(12, payloadLen);
  dv.setUint32(16, payloadLen);
  dv.setUint16(20, fields.length);
  let off = 22;
  for (const f of fields) { buf.set(f, off); off += f.length; }
  return buf;
}
function parseTransaction(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const t = { isReply: dv.getUint8(1), type: dv.getUint16(2), error: dv.getUint32(8), fields: new Map() };
  const count = dv.getUint16(20);
  let off = 22;
  for (let i = 0; i < count; i++) {
    const id = dv.getUint16(off);
    const len = dv.getUint16(off + 2);
    t.fields.set(id, buf.slice(off + 4, off + 4 + len));
    off += 4 + len;
  }
  return t;
}

class WSConn {
  constructor(url) {
    this.buf = new Uint8Array(0);
    this.waiter = null;
    this.closed = false;
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.open = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = (e) => reject(new Error("ws error: " + (e.message ?? e)));
    });
    this.ws.onmessage = (ev) => {
      const data = new Uint8Array(ev.data);
      const merged = new Uint8Array(this.buf.length + data.length);
      merged.set(this.buf);
      merged.set(data, this.buf.length);
      this.buf = merged;
      this.waiter?.();
    };
    this.ws.onclose = (ev) => {
      this.closeInfo = `${ev.code} ${ev.reason}`;
      this.closed = true;
      this.waiter?.();
    };
  }
  send(bytes) { this.ws.send(bytes); }
  async readBytes(n, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (this.buf.length < n) {
      if (this.closed) throw new Error(`connection closed (${this.closeInfo})`);
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${n} bytes (have ${this.buf.length})`);
      await new Promise((resolve) => { this.waiter = resolve; setTimeout(resolve, 50); });
      this.waiter = null;
    }
    const out = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    return out;
  }
  async readTransaction(timeoutMs = 8000) {
    const header = await this.readBytes(20, timeoutMs);
    const totalSize = new DataView(header.buffer).getUint32(12);
    const payload = await this.readBytes(totalSize, timeoutMs);
    const full = new Uint8Array(20 + totalSize);
    full.set(header);
    full.set(payload, 20);
    return parseTransaction(full);
  }
}

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};
const text = (u8) => (u8 ? new TextDecoder("latin1").decode(u8) : "<absent>");

const conn = new WSConn(`${URL_BASE}?host=${encodeURIComponent(HOST)}&port=5500`);
await conn.open;
check("websocket to bridge opened", true);

conn.send(new Uint8Array([0x54, 0x52, 0x54, 0x50, 0x48, 0x4f, 0x54, 0x4c, 0, 1, 0, 2]));
const hs = await conn.readBytes(8);
check(
  "hotline handshake via bridge",
  String.fromCharCode(...hs.slice(0, 4)) === "TRTP" && new DataView(hs.buffer).getUint32(4) === 0
);

conn.send(
  transaction(107, [
    field(105, obfuscate("guest")),
    field(102, enc.encode("Bridge Test")),
    field(104, new Uint8Array([0, 145])),
    field(160, new Uint8Array([0, 151])),
  ])
);
const reply = await conn.readTransaction();
check("login reply via bridge", reply.isReply === 1, `error=${reply.error}`);
if (reply.error === 0) {
  const t2 = await conn.readTransaction();
  console.log(`      next transaction type=${t2.type}`);
  const serverName = text(reply.fields.get(162));
  console.log(`      server name: ${JSON.stringify(serverName)}`);
}

// Also prove the transfer port routes.
const xfer = new WSConn(`${URL_BASE}?host=${encodeURIComponent(HOST)}&port=5501`);
await xfer.open;
check("transfer-port websocket opened", true);
xfer.ws.close();

// Any host is allowed, but only on Hotline ports — a non-Hotline port is refused.
const bad = new WSConn(`${URL_BASE}?host=example.com&port=22`);
const refused = await bad.open.then(() => false).catch(() => true);
check("non-Hotline port refused", refused);

conn.ws.close();
console.log(failures === 0 ? "\nBRIDGE RESULT: PASS" : `\nBRIDGE RESULT: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
