// hotline-ws-bridge: a WebSocket-to-TCP bridge for browser Hotline clients.
//
// Opening a WebSocket to /connect?host=<server>&port=<5498|5500|5501> opens a
// TCP connection to that Hotline server (or tracker) and pumps bytes in both
// directions. `host` may be a hostname or an IP; if omitted it falls back to
// the DEFAULT_HOST wrangler var, when configured. One WebSocket == one TCP
// connection (the Hotline file-transfer connection is simply a second
// WebSocket with port=5501).
//
// This relays to *any* host so a client can browse the wider Hotline community
// via trackers, but it is NOT a general TCP proxy: only the Hotline tracker
// (5498), session (5500), and transfer (5501) ports are allowed, and
// cloudflare:sockets additionally refuses Cloudflare IPs, private/loopback
// ranges, and port 25. Per-connection caps bound the resource use of any single
// connection; add an edge rate-limit rule before exposing it (see the README's
// rate-limiting section).

import { connect } from "cloudflare:sockets";

const ALLOWED_PORTS = new Set([5498, 5500, 5501]);

// Per-connection abuse guards. Connection *count* per IP belongs at the edge
// (a WAF rate-limiting rule — see the README); these bound the resource use of
// any single accepted connection.
const MAX_CONNECTION_MS = 30 * 60 * 1000; // close a held connection after 30 min
const MAX_BYTES = 50 * 1024 * 1024; // cap total bytes relayed per connection

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);

		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return new Response(
				"hotline-ws-bridge. Open a WebSocket to /connect?host=<server>&port=5498|5500|5501\n",
				{ status: 200, headers: { "content-type": "text/plain" } }
			);
		}

		const host = url.searchParams.get("host") ?? env.DEFAULT_HOST;
		if (!host) {
			return new Response("host required", { status: 400 });
		}
		const port = Number(url.searchParams.get("port") ?? "5500");
		if (!ALLOWED_PORTS.has(port)) {
			return new Response("destination not allowed", { status: 403 });
		}

		// Optional host allowlist: set the ALLOWED_HOSTS wrangler var to a
		// comma-separated list of hostnames to restrict the bridge to your own
		// server(s). Unset (the default), the bridge relays to any host on the
		// allowed ports so clients can browse the wider Hotline community via
		// trackers.
		const allowedHosts = env.ALLOWED_HOSTS?.split(",")
			.map((h) => h.trim().toLowerCase())
			.filter(Boolean);
		if (allowedHosts?.length && !allowedHosts.includes(host.toLowerCase())) {
			return new Response("destination not allowed", { status: 403 });
		}

		const pair = new WebSocketPair();
		const client = pair[0];
		const ws = pair[1];
		ws.accept();

		const socket = connect({ hostname: host, port });
		const writer = socket.writable.getWriter();

		// Serialize guest->server writes: message events fire unthrottled, and
		// interleaved writer.write() calls would corrupt the byte stream.
		let writeChain = Promise.resolve();
		let closedByPeer = false;
		let bytesRelayed = 0;
		let lifetimeTimer;

		// Single teardown path: close both ends once, and stop the lifetime timer.
		const shutdown = (code, reason) => {
			if (closedByPeer) return;
			closedByPeer = true;
			clearTimeout(lifetimeTimer);
			try {
				ws.close(code, reason);
			} catch {}
			socket.close().catch(() => {});
		};

		// Bound how long any single connection can be held open.
		lifetimeTimer = setTimeout(
			() => shutdown(1000, "session time limit reached"),
			MAX_CONNECTION_MS
		);

		// Listeners are registered synchronously, before the 101 is returned, so
		// no early client bytes are dropped.
		// Depending on compatibility date, binary messages arrive as ArrayBuffer or
		// Blob (the spec's default binaryType); handle all three shapes.
		ws.addEventListener("message", (event) => {
			writeChain = writeChain
				.then(async () => {
					if (closedByPeer) return;
					const data = event.data;
					const bytes =
						typeof data === "string"
							? new TextEncoder().encode(data)
							: data instanceof Blob
								? new Uint8Array(await data.arrayBuffer())
								: new Uint8Array(data);
					bytesRelayed += bytes.length;
					if (bytesRelayed > MAX_BYTES) {
						shutdown(1009, "transfer limit reached");
						return;
					}
					await writer.write(bytes);
				})
				.catch(() => shutdown(1011, "tcp write failed"));
		});
		ws.addEventListener("close", () => shutdown(1000, "client closed"));

		ctx.waitUntil(
			(async () => {
				try {
					await socket.opened;
					for await (const chunk of socket.readable) {
						bytesRelayed += chunk.byteLength;
						if (bytesRelayed > MAX_BYTES) {
							shutdown(1009, "transfer limit reached");
							break;
						}
						ws.send(chunk);
					}
					shutdown(1000, "upstream EOF");
				} catch (err) {
					console.log(
						JSON.stringify({ event: "bridge_error", host, port, error: String(err) })
					);
					shutdown(1011, "upstream error");
				}
			})()
		);

		return new Response(null, { status: 101, webSocket: client });
	},
};
