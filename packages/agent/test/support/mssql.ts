import net from "node:net";

/**
 * A SQL Server in this process, spoken to by the real `tedious` client, as `mysql.ts` is a MySQL server for the
 * real `mysql2` (ADR 0245). `tedious` carries no server half of TDS, so this is one, as small as the client lets it
 * be: a pre-login that offers no encryption, a login that is always accepted, and an answer of one row with one
 * column to every statement, in a batch or through `sp_executesql` — or the error a test asks for, or a wait.
 * Transactions are begun and ended on the server's word alone. Nothing else of SQL Server is here: what needs a real
 * one is in the integration test.
 */

/** What the server does with one statement. */
export interface MssqlReply {
  /** Waits this long before answering, so a statement is slow and a pool has time to run out. */
  delayMs?: number;
  /** An error instead of a result. */
  error?: { number: number; message: string };
}

export interface FakeMssql {
  host: string;
  port: number;
  /** The statements the server received, in order, as they came over the wire: with the values in their parameters. */
  received: string[];
  /** How many connections it has accepted. */
  accepted: () => number;
  close: () => Promise<void>;
}

const TYPE = {
  SQL_BATCH: 0x01,
  RPC: 0x03,
  TABULAR: 0x04,
  ATTENTION: 0x06,
  TRANSACTION: 0x0e,
  LOGIN7: 0x10,
  PRELOGIN: 0x12,
};
const TOKEN = {
  COLMETADATA: 0x81,
  ROW: 0xd1,
  DONE: 0xfd,
  DONEPROC: 0xfe,
  DONEINPROC: 0xff,
  RETURNSTATUS: 0x79,
  RETURNVALUE: 0xac,
  ERROR: 0xaa,
  ENVCHANGE: 0xe3,
  LOGINACK: 0xad,
};
const DONE_ERROR = 0x0002;
const DONE_COUNT = 0x0010;
const DONE_ATTN = 0x0020;

const ucs2 = (text: string): Buffer => Buffer.from(text, "utf16le");
const bVarchar = (text: string): Buffer => Buffer.concat([Buffer.from([text.length]), ucs2(text)]);
const usVarchar = (text: string): Buffer => {
  const length = Buffer.alloc(2);
  length.writeUInt16LE(text.length);
  return Buffer.concat([length, ucs2(text)]);
};
const u16 = (value: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(value);
  return b;
};
const u32 = (value: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value);
  return b;
};
/** A token whose length is the two bytes after its type. */
const sized = (type: number, body: Buffer): Buffer => Buffer.concat([Buffer.from([type]), u16(body.length), body]);
const done = (type: number, status: number, rows: number): Buffer => {
  const b = Buffer.alloc(13);
  b.writeUInt8(type, 0);
  b.writeUInt16LE(status, 1);
  b.writeUInt16LE(0xc1, 3);
  b.writeBigUInt64LE(BigInt(rows), 5);
  return b;
};
const envchange = (type: number, next: Buffer, previous: Buffer): Buffer =>
  sized(TOKEN.ENVCHANGE, Buffer.concat([Buffer.from([type]), next, previous]));
const varbyte = (bytes: Buffer): Buffer => Buffer.concat([Buffer.from([bytes.length]), bytes]);

/** One INT column called `one`, and a row with 1 in it. */
const ROWS = Buffer.concat([
  Buffer.from([TOKEN.COLMETADATA]),
  u16(1),
  u32(0), // user type
  u16(0), // flags
  Buffer.from([0x38]), // INT4
  bVarchar("one"),
  Buffer.from([TOKEN.ROW]),
  u32(1),
]);

function errorToken(error: { number: number; message: string }): Buffer {
  return sized(
    TOKEN.ERROR,
    Buffer.concat([
      u32(error.number),
      Buffer.from([1, 16]),
      usVarchar(error.message),
      bVarchar("fake"),
      bVarchar(""),
      u32(1),
    ]),
  );
}

function prelogin(): Buffer {
  // VERSION, ENCRYPTION (not supported), INSTOPT, THREADID, MARS, and the terminator.
  const options: Array<[number, Buffer]> = [
    [0x00, Buffer.from([16, 0, 0x03, 0xe8, 0, 0])],
    [0x01, Buffer.from([0x02])],
    [0x02, Buffer.from([0x00])],
    [0x03, Buffer.from([0, 0, 0, 1])],
    [0x04, Buffer.from([0x00])],
  ];
  const head = Buffer.alloc(options.length * 5 + 1);
  let offset = head.length;
  options.forEach(([token, data], i) => {
    head.writeUInt8(token, i * 5);
    head.writeUInt16BE(offset, i * 5 + 1);
    head.writeUInt16BE(data.length, i * 5 + 3);
    offset += data.length;
  });
  head.writeUInt8(0xff, options.length * 5);
  return Buffer.concat([head, ...options.map(([, data]) => data)]);
}

function loginAck(): Buffer {
  const tdsVersion = Buffer.alloc(4);
  tdsVersion.writeUInt32BE(0x74000004);
  const ack = sized(
    TOKEN.LOGINACK,
    Buffer.concat([Buffer.from([1]), tdsVersion, bVarchar("Microsoft SQL Server"), Buffer.from([16, 0, 0x03, 0xe8])]),
  );
  return Buffer.concat([
    envchange(1, bVarchar("master"), bVarchar("master")),
    envchange(7, varbyte(Buffer.from([0x09, 0x04, 0xd0, 0x00, 0x34])), varbyte(Buffer.alloc(0))),
    envchange(4, bVarchar("4096"), bVarchar("4096")),
    ack,
    done(TOKEN.DONE, 0, 0),
  ]);
}

/** The text of a batch: the headers, then the statement in UTF-16. */
function batchText(payload: Buffer): string {
  return payload.subarray(payload.readUInt32LE(0)).toString("utf16le");
}

/**
 * What an RPC runs: for `sp_executesql` (10) its first parameter, the statement; for a procedure called by its name,
 * the name.
 */
function rpcText(payload: Buffer): string {
  let at = payload.readUInt32LE(0);
  const nameLength = payload.readUInt16LE(at);
  at += 2;
  if (nameLength !== 0xffff) return payload.subarray(at, at + nameLength * 2).toString("utf16le");
  const procId = payload.readUInt16LE(at);
  at += 2 + 2; // the id, and the option flags
  if (procId !== 10) return `sp ${procId}`;
  at += 1 + payload.readUInt8(at) * 2 + 1; // the parameter's name, and its status
  const type = payload.readUInt8(at);
  if (type !== 0xe7) return `sp_executesql of type ${type}`;
  const max = payload.readUInt16LE(at + 1);
  at += 1 + 2 + 5; // type, max length, collation
  if (max !== 0xffff) return payload.subarray(at + 2, at + 2 + payload.readUInt16LE(at)).toString("utf16le");
  at += 8; // the total length of a PLP value, then its chunks
  const chunks: Buffer[] = [];
  for (let length = payload.readUInt32LE(at); length !== 0; length = payload.readUInt32LE(at)) {
    chunks.push(payload.subarray(at + 4, at + 4 + length));
    at += 4 + length;
  }
  return Buffer.concat(chunks).toString("utf16le");
}

export async function startFakeMssql(handler: (sql: string) => MssqlReply = () => ({})): Promise<FakeMssql> {
  const received: string[] = [];
  const sockets = new Set<net.Socket>();
  let accepted = 0;
  const server = net.createServer((socket) => {
    accepted += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let pending = Buffer.alloc(0);
    let message: Buffer[] = [];
    let packetId = 1;
    let handles = 0;
    const send = (payload: Buffer): void => {
      if (socket.destroyed) return;
      const max = 4096 - 8;
      for (let at = 0; at < payload.length || at === 0; at += max) {
        const part = payload.subarray(at, at + max);
        const last = at + max >= payload.length;
        const header = Buffer.alloc(8);
        header.writeUInt8(TYPE.TABULAR, 0);
        header.writeUInt8(last ? 0x01 : 0x00, 1);
        header.writeUInt16BE(part.length + 8, 2);
        header.writeUInt8(packetId++ % 256, 6);
        socket.write(Buffer.concat([header, part]));
        if (last) break;
      }
    };
    const answer = (sql: string, rpc: boolean): void => {
      received.push(sql);
      const reply = handler(sql);
      const respond = (): void => {
        if (reply.error) {
          send(Buffer.concat([errorToken(reply.error), done(rpc ? TOKEN.DONEPROC : TOKEN.DONE, DONE_ERROR, 0)]));
        } else if (rpc && sql === "sp_prepare") {
          // `mssql`'s prepared statement: the handle comes back as the output parameter `@handle`.
          handles += 1;
          const value = Buffer.concat([u16(0), bVarchar("@handle"), Buffer.from([0x01]), u32(0), u16(0)]);
          const typed = Buffer.concat([value, Buffer.from([0x26, 4, 4]), u32(handles)]);
          send(Buffer.concat([Buffer.from([TOKEN.RETURNVALUE]), typed, done(TOKEN.DONEPROC, 0, 0)]));
        } else if (rpc && sql === "sp_unprepare") {
          send(done(TOKEN.DONEPROC, 0, 0));
        } else if (/^\s*set\s/i.test(sql)) {
          // The session's options, which `tedious` sends as it logs in: no rows, as SQL Server answers them.
          send(done(TOKEN.DONE, 0, 0));
        } else if (rpc) {
          send(
            Buffer.concat([
              ROWS,
              done(TOKEN.DONEINPROC, DONE_COUNT, 1),
              Buffer.from([TOKEN.RETURNSTATUS]),
              u32(0),
              done(TOKEN.DONEPROC, 0, 0),
            ]),
          );
        } else {
          send(Buffer.concat([ROWS, done(TOKEN.DONE, DONE_COUNT, 1)]));
        }
      };
      if (reply.delayMs) setTimeout(respond, reply.delayMs);
      else respond();
    };
    const handle = (type: number, payload: Buffer): void => {
      switch (type) {
        case TYPE.PRELOGIN:
          send(prelogin());
          return;
        case TYPE.LOGIN7:
          send(loginAck());
          return;
        case TYPE.SQL_BATCH:
          answer(batchText(payload), false);
          return;
        case TYPE.RPC:
          answer(rpcText(payload), true);
          return;
        case TYPE.TRANSACTION: {
          // Begin (5) gets a descriptor; commit (7) and rollback (8) give it back.
          const request = payload.readUInt16LE(payload.readUInt32LE(0));
          const descriptor = Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]);
          const change =
            request === 5
              ? envchange(8, varbyte(descriptor), varbyte(Buffer.alloc(0)))
              : envchange(request === 7 ? 9 : 10, varbyte(Buffer.alloc(0)), varbyte(descriptor));
          send(Buffer.concat([change, done(TOKEN.DONE, 0, 0)]));
          return;
        }
        case TYPE.ATTENTION:
          send(done(TOKEN.DONE, DONE_ATTN, 0));
          return;
        default:
          socket.destroy();
      }
    };
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 8) {
        const length = pending.readUInt16BE(2);
        if (pending.length < length) return;
        const type = pending.readUInt8(0);
        const eom = (pending.readUInt8(1) & 0x01) === 0x01;
        message.push(pending.subarray(8, length));
        pending = pending.subarray(length);
        if (eom) {
          const payload = Buffer.concat(message);
          message = [];
          handle(type, payload);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the fake SQL Server has no port");
  return {
    host: "127.0.0.1",
    port: address.port,
    received,
    accepted: () => accepted,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
