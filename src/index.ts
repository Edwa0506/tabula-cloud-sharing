import { DurableObject } from "cloudflare:workers";

interface Env {
  COLLABORATION_ROOMS: DurableObjectNamespace<CollaborationRoom>;
}

interface RoomMetadata {
  version: 2;
  roomId: string;
  secretHash: string;
  adminHash: string;
  createdAt: number;
  updatedAt: number;
  latestSequence: number;
  snapshotBaseSequence: number;
  snapshotSequence?: number;
  stoppedAt?: number;
  purgeAt?: number;
}

interface ClientAttachment {
  authenticated: boolean;
  clientId?: number;
  windowStartedAt: number;
  messagesInWindow: number;
  bytesInWindow: number;
}

interface EncryptedEnvelope {
  type: "encrypted";
  version: 2;
  persistence: "none" | "update" | "snapshot";
  nonce: string;
  ciphertext: string;
  baseSequence?: number;
}

interface StoredEnvelope extends EncryptedEnvelope {
  sequence?: number;
}

const ROOM_PATH = /^\/v1\/rooms\/([A-Za-z0-9_-]{16,80})(?:\/(restore))?$/;
const LANDING_PATH = /^\/j\/([A-Za-z0-9_-]{16,80})$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,160}$/;
const ENCODED_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_CLIENTS = 16;
const MAX_MESSAGE_BYTES = 24 * 1024 * 1024;
const RATE_WINDOW_MS = 10_000;
const MAX_MESSAGES_PER_WINDOW = 500;
const MAX_BYTES_PER_WINDOW = 48 * 1024 * 1024;
const RECOVERY_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
const STORAGE_CHUNK_CHARS = 1_000_000;

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, x-tabula-admin",
};

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      ...corsHeaders,
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function landingPage() {
  return new Response(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Open shared paper in Tabula</title>
    <style>
      :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
      body { min-height: 100vh; display: grid; place-items: center; margin: 0; background: #f4f0e7; color: #2d2925; }
      main { width: min(520px, calc(100% - 48px)); padding: 42px; border: 1px solid #d8d0c3; border-radius: 18px; background: #fffdf8; box-shadow: 0 22px 70px #413a3024; }
      b { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 12px; background: #2d2925; color: #fffdf8; font: 26px Georgia, serif; }
      h1 { margin: 24px 0 10px; font: 32px/1.1 Georgia, serif; }
      p { color: #71695f; line-height: 1.55; }
      button { margin-top: 12px; padding: 11px 16px; border: 0; border-radius: 9px; background: #2d2925; color: white; font-weight: 700; cursor: pointer; }
      small { display: block; margin-top: 18px; color: #8a8176; }
    </style>
  </head>
  <body>
    <main>
      <b>T</b>
      <h1>A paper was shared with you.</h1>
      <p>Copy this private invitation, open Tabula, choose <strong>Share</strong>, and paste it into the invitation field.</p>
      <button id="copy">Copy invitation</button>
      <small>The text after # contains the encryption key. Tabula keeps it out of server requests.</small>
    </main>
    <script>
      document.getElementById("copy").addEventListener("click", async () => {
        await navigator.clipboard.writeText(location.href);
        document.getElementById("copy").textContent = "Copied";
      });
    </script>
  </body>
</html>`, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
    },
  });
}

async function forwardedRoomRequest(request: Request, env: Env, roomId: string) {
  const id = env.COLLABORATION_ROOMS.idFromName(roomId);
  const headers = new Headers(request.headers);
  headers.set("x-tabula-room-id", roomId);
  return env.COLLABORATION_ROOMS.get(id).fetch(new Request(request, { headers }));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return json({ ok: true, service: "tabula-share", version: 2 });
    }
    if (request.method === "GET" && LANDING_PATH.test(url.pathname)) return landingPage();

    const match = url.pathname.match(ROOM_PATH);
    if (match) return forwardedRoomRequest(request, env, match[1]);
    return json({ error: "not_found" }, 404);
  },
} satisfies ExportedHandler<Env>;

export class CollaborationRoom extends DurableObject<Env> {
  private roomId?: string;
  private persistenceQueue = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.initializeStorage();
  }

  private initializeStorage() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS encrypted_envelopes (
        kind TEXT NOT NULL CHECK (kind IN ('snapshot', 'update')),
        sequence INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL,
        byte_length INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (kind, sequence, chunk_index)
      )
    `);
  }

  async fetch(request: Request): Promise<Response> {
    this.roomId = request.headers.get("x-tabula-room-id") ?? this.roomId;
    if (!this.roomId) return json({ error: "invalid_room" }, 400);
    const url = new URL(request.url);

    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      const attachment: ClientAttachment = {
        authenticated: false,
        windowStartedAt: Date.now(),
        messagesInWindow: 0,
        bytesInWindow: 0,
      };
      server.serializeAttachment(attachment);
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method === "GET") {
      if (!this.ctx.storage.kv.get<RoomMetadata>("metadata")) {
        return json({ error: "not_found" }, 404);
      }
      const admin = request.headers.get("x-tabula-admin") ?? "";
      const metadata = await this.authorizeAdmin(admin);
      if (!metadata) return json({ error: "forbidden" }, 403);
      const storage = await this.roomStorageStats();
      return json({
        ok: true,
        status: metadata.stoppedAt ? "stopped" : "active",
        createdAt: metadata.createdAt,
        updatedAt: metadata.updatedAt,
        stoppedAt: metadata.stoppedAt,
        purgeAt: metadata.purgeAt,
        ...storage,
      });
    }

    if (request.method === "DELETE") {
      if (
        url.searchParams.get("permanent") === "1"
        && !this.ctx.storage.kv.get<RoomMetadata>("metadata")
      ) return json({ ok: true, deleted: true });
      const admin = request.headers.get("x-tabula-admin") ?? "";
      const metadata = await this.authorizeAdmin(admin);
      if (!metadata) return json({ error: "forbidden" }, 403);
      if (url.searchParams.get("permanent") === "1") {
        await this.purgeRoom();
        return json({ ok: true, deleted: true });
      }
      const stoppedAt = Date.now();
      const purgeAt = stoppedAt + RECOVERY_PERIOD_MS;
      this.ctx.storage.kv.put("metadata", { ...metadata, stoppedAt, purgeAt, updatedAt: stoppedAt });
      await this.ctx.storage.setAlarm(purgeAt);
      for (const socket of this.ctx.getWebSockets()) socket.close(4404, "Sharing was stopped by its owner.");
      return json({ ok: true, stoppedAt, purgeAt });
    }

    if (request.method === "POST" && url.pathname.endsWith("/restore")) {
      const admin = request.headers.get("x-tabula-admin") ?? "";
      const metadata = await this.authorizeAdmin(admin);
      if (!metadata) return json({ error: "forbidden" }, 403);
      const restored = { ...metadata, stoppedAt: undefined, purgeAt: undefined, updatedAt: Date.now() };
      this.ctx.storage.kv.put("metadata", restored);
      await this.ctx.storage.deleteAlarm();
      return json({ ok: true });
    }

    return json({ error: "method_not_allowed" }, 405);
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = socket.deserializeAttachment() as ClientAttachment | null;
    if (!attachment) {
      socket.close(4400, "Missing client state.");
      return;
    }
    const bytes = typeof message === "string" ? new TextEncoder().encode(message).byteLength : message.byteLength;
    if (bytes > MAX_MESSAGE_BYTES || !this.withinRateLimit(attachment, bytes)) {
      socket.close(4429, "Rate limit exceeded.");
      return;
    }
    if (typeof message !== "string") {
      socket.close(4400, "Messages must be JSON.");
      return;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(message) as Record<string, unknown>;
    } catch {
      socket.close(4400, "Messages must be JSON.");
      return;
    }

    if (!attachment.authenticated) {
      await this.authenticate(socket, attachment, parsed);
      return;
    }
    if (!isEncryptedEnvelope(parsed)) {
      socket.close(4400, "Invalid encrypted message.");
      return;
    }

    if (parsed.persistence === "none") {
      this.broadcast(parsed, socket);
      return;
    }
    const persist = this.persistenceQueue.then(() => this.persist(parsed));
    this.persistenceQueue = persist.then(() => undefined, () => undefined);
    try {
      const stored = await persist;
      this.broadcast(stored);
    } catch (error) {
      const quota = isStorageLimitError(error);
      const message = quota
        ? "Cloudflare’s Workers Free storage allowance is full. Delete an older shared project or its cloud copy, then try again."
        : "The encrypted cloud copy could not be saved.";
      this.send(socket, { type: "error", message });
      socket.close(quota ? 4429 : 1011, message);
    }
  }

  webSocketClose(): void {
    // Hibernation removes closed sockets from ctx.getWebSockets().
  }

  webSocketError(socket: WebSocket): void {
    socket.close(1011, "WebSocket error.");
  }

  async alarm(): Promise<void> {
    const metadata = this.ctx.storage.kv.get<RoomMetadata>("metadata");
    if (metadata?.purgeAt && metadata.purgeAt <= Date.now()) await this.purgeRoom();
  }

  private withinRateLimit(attachment: ClientAttachment, bytes: number) {
    const now = Date.now();
    if (now - attachment.windowStartedAt >= RATE_WINDOW_MS) {
      attachment.windowStartedAt = now;
      attachment.messagesInWindow = 0;
      attachment.bytesInWindow = 0;
    }
    attachment.messagesInWindow += 1;
    attachment.bytesInWindow += bytes;
    return attachment.messagesInWindow <= MAX_MESSAGES_PER_WINDOW
      && attachment.bytesInWindow <= MAX_BYTES_PER_WINDOW;
  }

  private async authenticate(
    socket: WebSocket,
    attachment: ClientAttachment,
    message: Record<string, unknown>,
  ) {
    const secret = typeof message.secret === "string" ? message.secret : "";
    const adminSecret = typeof message.adminSecret === "string" ? message.adminSecret : "";
    const clientId = message.clientId;
    const create = message.create === true;
    if (
      message.type !== "authenticate"
      || message.version !== 2
      || !TOKEN_PATTERN.test(secret)
      || !Number.isSafeInteger(clientId)
      || (create && !TOKEN_PATTERN.test(adminSecret))
    ) {
      this.reject(socket, "Invalid invitation credential.");
      return;
    }

    let metadata = this.ctx.storage.kv.get<RoomMetadata>("metadata");
    if (!metadata) {
      if (!create || !this.roomId) {
        this.reject(socket, "This shared project does not exist.");
        return;
      }
      const now = Date.now();
      metadata = {
        version: 2,
        roomId: this.roomId,
        secretHash: await digest(secret),
        adminHash: await digest(adminSecret),
        createdAt: now,
        updatedAt: now,
        latestSequence: 0,
        snapshotBaseSequence: -1,
      };
      this.ctx.storage.kv.put("metadata", metadata);
    }
    if (metadata.stoppedAt) {
      this.reject(socket, "Sharing has ended for this project.", 4404);
      return;
    }
    if (metadata.secretHash !== await digest(secret)) {
      this.reject(socket, "Invalid invitation credential.");
      return;
    }
    const connected = this.ctx.getWebSockets().filter((candidate) => {
      const state = candidate.deserializeAttachment() as ClientAttachment | null;
      return state?.authenticated;
    });
    if (connected.length >= MAX_CLIENTS) {
      this.reject(socket, "This collaboration room is full.", 4429);
      return;
    }

    attachment.authenticated = true;
    attachment.clientId = clientId as number;
    socket.serializeAttachment(attachment);
    this.send(socket, { type: "authenticated", version: 2 });
    await this.replay(socket, metadata);
  }

  private async persist(envelope: EncryptedEnvelope): Promise<StoredEnvelope> {
    return this.ctx.storage.transactionSync(() => {
      const metadata = this.ctx.storage.kv.get<RoomMetadata>("metadata");
      if (!metadata || metadata.stoppedAt || !this.roomId) throw new Error("Room is unavailable.");
      const sequence = metadata.latestSequence + 1;
      const stored: StoredEnvelope = { ...envelope, sequence };
      const serialized = JSON.stringify(stored);
      const byteLength = new TextEncoder().encode(serialized).byteLength;
      const baseSequence = Number.isSafeInteger(envelope.baseSequence) ? envelope.baseSequence! : -1;
      const useAsSnapshot = envelope.persistence === "snapshot"
        && baseSequence >= metadata.snapshotBaseSequence;

      if (useAsSnapshot) {
        this.ctx.storage.sql.exec("DELETE FROM encrypted_envelopes WHERE kind = 'snapshot'");
        this.ctx.storage.sql.exec(
          "DELETE FROM encrypted_envelopes WHERE kind = 'update' AND sequence <= ?",
          baseSequence,
        );
        this.writeRecord("snapshot", sequence, serialized, byteLength);
        metadata.snapshotBaseSequence = baseSequence;
        metadata.snapshotSequence = sequence;
      } else {
        this.writeRecord("update", sequence, serialized, byteLength);
      }
      metadata.latestSequence = sequence;
      metadata.updatedAt = Date.now();
      this.ctx.storage.kv.put("metadata", metadata);
      return stored;
    });
  }

  private async replay(socket: WebSocket, metadata: RoomMetadata) {
    const snapshot = this.readRecord("snapshot", metadata.snapshotSequence ?? 0);
    if (snapshot) this.send(socket, JSON.parse(snapshot));

    const updates = this.ctx.storage.sql.exec<{ sequence: number }>(
      `SELECT sequence
       FROM encrypted_envelopes
       WHERE kind = 'update' AND chunk_index = 0 AND sequence > ?
       ORDER BY sequence`,
      metadata.snapshotBaseSequence,
    ).toArray();
    for (const { sequence } of updates) {
      const value = this.readRecord("update", sequence);
      if (value) this.send(socket, JSON.parse(value));
    }
    this.send(socket, {
      type: "replay-complete",
      version: 2,
      sequence: metadata.latestSequence,
      hasSnapshot: Boolean(snapshot),
    });
  }

  private broadcast(message: unknown, except?: WebSocket) {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as ClientAttachment | null;
      if (socket !== except && attachment?.authenticated) this.send(socket, message);
    }
  }

  private send(socket: WebSocket, message: unknown) {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      socket.close(1011, "Could not deliver collaboration update.");
    }
  }

  private reject(socket: WebSocket, message: string, code = 4403) {
    this.send(socket, { type: "error", message });
    socket.close(code, message);
  }

  private async authorizeAdmin(secret: string) {
    if (!TOKEN_PATTERN.test(secret)) return undefined;
    const metadata = this.ctx.storage.kv.get<RoomMetadata>("metadata");
    if (!metadata || metadata.adminHash !== await digest(secret)) return undefined;
    return metadata;
  }

  private roomStorageStats() {
    return this.storageStats(
      "SELECT COALESCE(SUM(byte_length), 0) AS storedBytes, COALESCE(SUM(CASE WHEN chunk_index = 0 THEN 1 ELSE 0 END), 0) AS storedObjects FROM encrypted_envelopes",
    );
  }

  private async purgeRoom() {
    if (!this.roomId) {
      const metadata = this.ctx.storage.kv.get<RoomMetadata>("metadata");
      this.roomId = metadata?.roomId;
    }
    for (const socket of this.ctx.getWebSockets()) socket.close(4404, "Shared project deleted.");
    await this.ctx.storage.deleteAll();
    this.initializeStorage();
  }

  private writeRecord(kind: "snapshot" | "update", sequence: number, serialized: string, byteLength: number) {
    const chunks = [];
    for (let offset = 0; offset < serialized.length; offset += STORAGE_CHUNK_CHARS) {
      chunks.push(serialized.slice(offset, offset + STORAGE_CHUNK_CHARS));
    }
    for (let index = 0; index < chunks.length; index += 1) {
      this.ctx.storage.sql.exec(
        `INSERT INTO encrypted_envelopes (kind, sequence, chunk_index, byte_length, data)
         VALUES (?, ?, ?, ?, ?)`,
        kind,
        sequence,
        index,
        index === 0 ? byteLength : 0,
        chunks[index],
      );
    }
  }

  private readRecord(kind: "snapshot" | "update", sequence: number) {
    const rows = this.ctx.storage.sql.exec<{ data: string }>(
      `SELECT data FROM encrypted_envelopes
       WHERE kind = ? AND sequence = ?
       ORDER BY chunk_index`,
      kind,
      sequence,
    ).toArray();
    return rows.length > 0 ? rows.map(({ data }) => data).join("") : undefined;
  }

  private storageStats(query: string, ...bindings: number[]) {
    const row = this.ctx.storage.sql.exec<{ storedBytes: number; storedObjects: number }>(
      query,
      ...bindings,
    ).one();
    return {
      storedBytes: Number(row.storedBytes),
      storedObjects: Number(row.storedObjects),
    };
  }
}

function isStorageLimitError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return normalized.includes("sqlite_full")
    || normalized.includes("database or disk is full")
    || normalized.includes("storage limit")
    || normalized.includes("storage quota");
}

function isEncryptedEnvelope(
  value: Record<string, unknown>,
): value is Record<string, unknown> & EncryptedEnvelope {
  return value.type === "encrypted"
    && value.version === 2
    && ["none", "update", "snapshot"].includes(String(value.persistence))
    && typeof value.nonce === "string"
    && value.nonce.length >= 12
    && value.nonce.length <= 64
    && ENCODED_PATTERN.test(value.nonce)
    && typeof value.ciphertext === "string"
    && value.ciphertext.length > 0
    && value.ciphertext.length <= MAX_MESSAGE_BYTES * 2
    && ENCODED_PATTERN.test(value.ciphertext)
    && (value.baseSequence === undefined || Number.isSafeInteger(value.baseSequence));
}

async function digest(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
