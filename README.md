# hotline-ws-bridge

A small Cloudflare Worker that bridges browser **WebSockets** to **Hotline TCP** — so a
Hotline client running in a web page (for example a classic Mac emulator) can reach real
Hotline servers and trackers.

Browsers can't open raw TCP sockets. Hotline speaks TCP: servers on **5500** (session) and
**5501** (file transfers), trackers on **5498**. This Worker terminates a WebSocket from the
browser and opens the matching TCP connection from Cloudflare's edge, relaying bytes in both
directions. It is a transparent pipe — it does not understand or parse the Hotline protocol.

## How it works

```
  browser tab                     Cloudflare Worker                Hotline server / tracker
 ┌────────────┐   WebSocket      ┌──────────────────┐   TCP        ┌────────────────────────┐
 │ Hotline    │ ───────────────▶ │ hotline-ws-bridge│ ───────────▶ │ 5500 session           │
 │ client     │ ◀─────────────── │ (cloudflare:     │ ◀─────────── │ 5501 transfer          │
 │ (in JS)    │   raw bytes      │  sockets connect)│   raw bytes  │ 5498 tracker           │
 └────────────┘                  └──────────────────┘              └────────────────────────┘
```

- **One WebSocket == one TCP connection.** Hotline opens two connections (a session on 5500
  and, when transferring files, a second on 5501), so the client opens a second WebSocket for
  the transfer. Querying a tracker is a third connection on 5498.
- Whatever the client sends over the WebSocket is written to the TCP socket, and everything
  the server sends back is delivered as WebSocket messages. Binary frames arrive as
  `ArrayBuffer` or `Blob` depending on the client; both are handled.

## Using it from a browser

Open a WebSocket to the Worker's `/connect` endpoint with the destination as query params:

```js
const ws = new WebSocket(
  "wss://your-bridge.example.com/connect?host=hotline.example.org&port=5500"
);
ws.binaryType = "arraybuffer";

ws.onopen = () => {
  // Send the raw Hotline protocol bytes your client would have written to the TCP socket.
  ws.send(new Uint8Array([0x54, 0x52, 0x54, 0x50, 0x48, 0x4f, 0x54, 0x4c, 0, 1, 0, 2])); // "TRTPHOTL" handshake
};
ws.onmessage = (event) => {
  const bytes = new Uint8Array(event.data); // the server's reply, verbatim
  // …feed bytes into your Hotline protocol parser…
};
```

Query parameters:

| Param  | Meaning                                        | Default                               |
| ------ | ---------------------------------------------- | ------------------------------------- |
| `host` | Destination hostname or IP.                    | the `DEFAULT_HOST` var, if configured |
| `port` | `5498` (tracker), `5500` (session), or `5501`. | `5500`                                |

A missing `host` (with no `DEFAULT_HOST` var set) is rejected with `400`; any other value of
`port` is rejected with `403`. A plain (non-WebSocket) `GET` to the Worker
returns a short usage line, which is handy for a quick reachability check.

Querying a tracker looks the same, on port `5498` — send the `HTRK` handshake
(`0x48 0x54 0x52 0x4b 0x00 0x01`) and read back the server list:

```js
const ws = new WebSocket("wss://your-bridge.example.com/connect?host=hltracker.com&port=5498");
ws.binaryType = "arraybuffer";
ws.onopen = () => ws.send(new Uint8Array([0x48, 0x54, 0x52, 0x4b, 0x00, 0x01]));
ws.onmessage = (event) => { /* server list bytes */ };
```

## Integrating with Infinite Mac

[Infinite Mac](https://github.com/mihaip/infinite-mac) runs a real classic Mac OS — with a
period Hotline client — in the browser via a WebAssembly emulator. The client inside the guest
speaks Hotline over TCP, but the emulator only exposes the Mac's **ethernet**, not sockets.
Connecting it to this Worker takes one piece in between: an in-page TCP/IP stack that turns the
guest's ethernet frames into terminated TCP connections you can forward over a WebSocket.

```
 emulated Mac (Open Transport)         in-page JavaScript                    this Worker
 ┌──────────────────────┐   ethernet  ┌───────────────────────┐  WebSocket  ┌──────────────┐   TCP
 │ Hotline client       │   frames    │ EmulatorEthernet-     │             │ hotline-ws-  │ ──────▶ server
 │ (TCP over OT)        │ ──────────▶ │ Provider → fake router│ ──────────▶ │ bridge       │        /tracker
 │                      │ ◀────────── │ + TCP/IP stack        │ ◀────────── │              │ ◀──────
 └──────────────────────┘             └───────────────────────┘             └──────────────┘
```

The pieces you supply on the page:

1. **An `EmulatorEthernetProvider`.** Infinite Mac lets you plug one in: it hands you the
   guest's outgoing ethernet frames through `send(destination, packet)` and delivers frames
   back to the guest through a delegate's `receive(packet)`. Feed every guest frame into your
   in-page stack, and push the stack's replies back through the delegate.

2. **An in-page TCP/IP stack.** The guest runs Open Transport and expects a real network — ARP,
   DHCP, DNS, then TCP. [v86's `fake_network.js`](https://github.com/copy/v86) is a good fit: a
   masquerading fake router that answers ARP/DHCP/DNS/ICMP for you and surfaces each guest TCP
   connection as an object with `write()` and an `on("data")` callback. Run its DHCP server so
   the guest auto-configures with no manual TCP/IP setup.

3. **Route Hotline connections to this bridge.** For each guest TCP connection to a Hotline
   port (5498/5500/5501), open a WebSocket to the bridge (`?host=…&port=…`) and splice the two
   together: bytes the guest sends go out over the WebSocket, and messages from the WebSocket
   get written back into the guest connection.

DNS ties it together. Resolve the hostnames the guest looks up to synthetic IPs, remember the
mapping, and call the bridge with the real hostname (`?host=hltracker.com`). Servers a user
picks from a tracker arrive as raw IPs and are bridged directly by IP.

One emulator-specific gotcha: Infinite Mac's guest ethernet driver drops unicast frames whose
destination MAC does not start with `0xb2`, so give your in-page router a MAC beginning with
`0xb2` — otherwise the guest's frames to your gateway are silently discarded.

The result is that the Hotline client believes it's on a LAN, the fake router terminates its
TCP in JavaScript, and this Worker carries each connection out to the real Hotline network.

### Reference implementation

A working end-to-end integration lives in a fork of Infinite Mac. The links below are pinned
to commit
[`6ffc4d4`](https://github.com/jhalter/infinite-mac/commit/6ffc4d466d5e53194c8c1c41446e0f4a038a9655)
so they don't drift:

- [`src/net/tcp-bridge/tcp-bridge-network.mjs`](https://github.com/jhalter/infinite-mac/blob/6ffc4d466d5e53194c8c1c41446e0f4a038a9655/src/net/tcp-bridge/tcp-bridge-network.mjs)
  — the in-page TCP/IP stack: the fake-router adapter, the dynamic-DNS pool, and the
  WebSocket splice (`acceptBridge`) that opens `?host=&port=` connections to this bridge.
- [`src/net/tcp-bridge/fake_network.js`](https://github.com/jhalter/infinite-mac/blob/6ffc4d466d5e53194c8c1c41446e0f4a038a9655/src/net/tcp-bridge/fake_network.js)
  — the vendored v86 fake router (BSD-2-Clause), patched only to expose a DNS hook.
- [`src/net/HotlineEthernetProvider.ts`](https://github.com/jhalter/infinite-mac/blob/6ffc4d466d5e53194c8c1c41446e0f4a038a9655/src/net/HotlineEthernetProvider.ts)
  — the `EmulatorEthernetProvider` that feeds guest frames into the stack and points it at a
  specific bridge URL.
- [`src/defs/run-def.ts`](https://github.com/jhalter/infinite-mac/blob/6ffc4d466d5e53194c8c1c41446e0f4a038a9655/src/defs/run-def.ts)
  — activates the provider via a `?hotline=true` URL parameter.

The netstack itself is protocol-agnostic (it bridges *any* guest TCP connection), so it's
reusable beyond Hotline; only the provider and the URL parameter are Hotline-specific.

## Security model

This is not a general-purpose TCP proxy, and it's worth understanding what it will and won't
do before you expose it.

- **Ports are restricted** to the Hotline set `{5498, 5500, 5501}`. Any other port gets a
  `403`.
- **`cloudflare:sockets` refuses** connections to Cloudflare's own IPs, to private and
  loopback ranges, and to port 25. Connections that fail those checks simply error and close.
- **Per-connection caps** bound the resource use of any single accepted connection:
  - it is closed after **30 minutes** (`MAX_CONNECTION_MS`), and
  - aborted once **50 MB** total has been relayed (`MAX_BYTES`).
- **Connection-rate limiting per IP** is *not* built into the Worker — add it at the edge with
  a WAF rate-limiting rule (see below). It belongs there, not in the Worker: the Workers
  rate-limit binding uses best-effort, per-isolate counters, and each long-lived WebSocket
  upgrade lands on a fresh isolate, so the count never converges for a socket proxy.

**Open-relay caveat.** By default the bridge relays to *any* host on the allowed ports.
That's deliberate — it lets a client browse the wider Hotline community via trackers — but it
means visitors reach third-party servers from Cloudflare's shared egress IPs, and anyone who
finds the endpoint can use it the same way. To limit the bridge to your own server(s), set
the **`ALLOWED_HOSTS`** wrangler var to a comma-separated list of hostnames:

```jsonc
"vars": { "ALLOWED_HOSTS": "hotline.example.org,tracker.example.org" }
```

Any `host` not on the list is rejected with `403` (matching is case-insensitive). Note that
this also blocks tracker-listed servers, which arrive as raw IPs — a locked-down bridge serves
exactly the hosts you name. Leave the var unset for the open-relay behavior.

## Setup

### Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) — the **free plan is enough**.
- Node.js and [Wrangler](https://developers.cloudflare.com/workers/wrangler/) (`npx wrangler`
  works without a global install).
- `npx wrangler login` (or a `CLOUDFLARE_API_TOKEN` with Workers edit permission).

### Configure

Edit `wrangler.jsonc`:

- Set **`name`** to whatever you want the Worker called.
- Choose how it's reachable — one of:
  - **No domain (default):** keep `"workers_dev": true` to get a
    `https://<name>.<subdomain>.workers.dev` URL for free.
  - **Your own domain:** replace `workers_dev` with a `routes` entry like
    `{ "pattern": "your-domain.com/hotline-bridge*", "zone_name": "your-domain.com" }`, and make
    sure a **proxied** DNS record exists for that hostname (a route needs one).
- Optionally set **`vars.DEFAULT_HOST`** — the server used when a client omits `?host=`
  (without it, `host` is required).
- Optionally set **`vars.ALLOWED_HOSTS`** — a comma-separated hostname allowlist that closes
  the open relay (see the security model section). Unset, any host is reachable on the
  allowed ports.

Optionally, in `src/index.js`:

- **`ALLOWED_PORTS`** — the ports the bridge will connect to.

### Deploy

```sh
npx wrangler deploy
```

Verify it's live by opening the endpoint in a browser (a plain `GET` returns the usage line),
then point a WebSocket client at `/connect?host=…&port=5500` — or run the example client:

```sh
node examples/bridge-test.mjs wss://<your-worker>/connect <your-hotline-server>
```

### Add rate limiting (recommended before exposing it)

Cap how many connections a single IP can open, at the edge. (WAF rules apply to zones, so
this needs the bridge routed on your own domain — `*.workers.dev` URLs can't carry one.) In
the Cloudflare dashboard, go to **Security → WAF → Rate limiting rules** and add one that
matches your bridge's route path (e.g. `URI Path contains "/hotline-bridge"`),
**5 requests / 10 seconds** per IP, action **Block**. The free plan allows exactly one
rate-limiting rule, and restricts the period to 10 seconds (the API rejects 60 with
"can only use a period among [10]").

As Terraform (`http_ratelimit` ruleset on your zone):

```hcl
resource "cloudflare_ruleset" "hotline_bridge_ratelimit" {
  zone_id = var.zone_id
  name    = "default"
  kind    = "zone"
  phase   = "http_ratelimit"
  rules = [{
    ref         = "hotline_bridge_per_ip"
    description = "Throttle Hotline bridge connections per client IP"
    expression  = "(starts_with(http.request.uri.path, \"/hotline-bridge\"))"
    action      = "block"
    enabled     = true
    ratelimit = {
      characteristics     = ["ip.src", "cf.colo.id"]
      period              = 10 # free plan allows only 10 s
      requests_per_period = 5
      mitigation_timeout  = 10
    }
  }]
}
```

## Configuration reference

`src/index.js`:

| Constant             | Purpose                                          | Default                       |
| -------------------- | ------------------------------------------------ | ----------------------------- |
| `ALLOWED_PORTS`      | Ports the bridge will connect to.                | `{5498, 5500, 5501}`          |
| `MAX_CONNECTION_MS`  | Max lifetime of a single connection.             | `1800000` (30 min)            |
| `MAX_BYTES`          | Max total bytes relayed per connection.          | `52428800` (50 MB)            |

`wrangler.jsonc`:

| Field                | Notes                                                                    |
| -------------------- | ------------------------------------------------------------------------ |
| `name`               | Worker name.                                                             |
| `workers_dev`        | A free `*.workers.dev` URL (the default).                                |
| `routes`             | Alternative: a route on your own zone; needs a proxied DNS record.       |
| `vars.DEFAULT_HOST`  | Optional destination when `?host=` is omitted (otherwise `host` is required). |
| `vars.ALLOWED_HOSTS` | Optional comma-separated hostname allowlist; unset = relay to any host. |
| `account_id`         | Optional; inferred from your Wrangler login when omitted.                |
| `compatibility_date` | Must be recent enough for `cloudflare:sockets` (any 2023+ date is fine). |

No `nodejs_compat` flag is required — `cloudflare:sockets` is a built-in Workers API.

## Cost

Fits the **Cloudflare Workers free plan**. Each bridged connection is one WebSocket request
(the initial upgrade; relayed messages don't count as requests), well within the free
100,000 requests/day. `cloudflare:sockets` and a single WAF rate-limiting rule are both free.

## Local development

`cloudflare:sockets` opens real outbound connections, so use remote dev:

```sh
npx wrangler dev --remote
```

Then drive it with a WebSocket client that speaks a little Hotline — connect, send the
`TRTPHOTL` handshake, and read the reply — to confirm the relay works end to end.

## License

MIT.

## Related

- [Infinite Mac](https://github.com/mihaip/infinite-mac) — the browser-based classic Mac
  emulator that runs the Hotline client on the other end of the bridge.
- [Infinite Mac fork with this bridge wired in](https://github.com/jhalter/infinite-mac/tree/6ffc4d466d5e53194c8c1c41446e0f4a038a9655)
  — the reference integration (in-page TCP/IP stack + `EmulatorEthernetProvider`), pinned to
  commit `6ffc4d4`.
