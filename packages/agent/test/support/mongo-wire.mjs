import net from "node:net";
import { BSON } from "mongodb";

/**
 * A MongoDB server of the tests' own, in process: the wire protocol the official driver speaks (OP_QUERY for the
 * first handshake, OP_MSG after it), and an in-memory collection per name. Enough for the driver, and Mongoose on it,
 * to connect, insert, find, update, delete and count; not a database. Plain JavaScript, so that a project a test of
 * `check` makes can run it too.
 *
 * A command named in `failing` is answered `ok: 0`; an insert of a document whose `_id` is already there is answered
 * `ok: 1` with a write error, as a unique index answers.
 */

const OP_REPLY = 1;
const OP_QUERY = 2004;
const OP_MSG = 2013;

export async function startMongoWire({ failing = [] } = {}) {
  const collections = new Map();
  const commands = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4 && buffered.length >= buffered.readInt32LE(0)) {
        const length = buffered.readInt32LE(0);
        const message = buffered.subarray(0, length);
        buffered = buffered.subarray(length);
        const reply = answer(message);
        if (reply !== undefined) socket.write(reply);
      }
    });
  });

  function answer(message) {
    const requestId = message.readInt32LE(4);
    const opCode = message.readInt32LE(12);
    if (opCode === OP_QUERY) {
      let at = 20;
      while (message[at] !== 0) at += 1;
      at += 9; // the cstring's end, numberToSkip, numberToReturn
      const query = BSON.deserialize(message.subarray(at, at + message.readInt32LE(at)));
      return reply(OP_REPLY, requestId, run(query));
    }
    if (opCode !== OP_MSG) return undefined;
    const flags = message.readUInt32LE(16);
    let at = 20;
    let body;
    const end = message.length - (flags & 1 ? 4 : 0);
    while (at < end) {
      const kind = message[at];
      at += 1;
      if (kind === 0) {
        const size = message.readInt32LE(at);
        body = BSON.deserialize(message.subarray(at, at + size));
        at += size;
      } else {
        const size = message.readInt32LE(at);
        const section = message.subarray(at + 4, at + size);
        let name = 0;
        while (section[name] !== 0) name += 1;
        const identifier = section.subarray(0, name).toString("utf8");
        const documents = [];
        for (let doc = name + 1; doc < section.length; doc += section.readInt32LE(doc)) {
          documents.push(BSON.deserialize(section.subarray(doc, doc + section.readInt32LE(doc))));
        }
        if (body !== undefined) body[identifier] = documents;
        at += size;
      }
    }
    const result = run(body ?? {});
    // `moreToCome`: an unacknowledged write is answered with nothing.
    return flags & 2 ? undefined : reply(OP_MSG, requestId, result);
  }

  function run(command) {
    const name = Object.keys(command)[0] ?? "";
    commands.push(name);
    if (name === "hello" || name.toLowerCase() === "ismaster") {
      return {
        helloOk: true,
        ismaster: true,
        isWritablePrimary: true,
        maxBsonObjectSize: 16 * 1024 * 1024,
        maxMessageSizeBytes: 48_000_000,
        maxWriteBatchSize: 100_000,
        localTime: new Date(),
        logicalSessionTimeoutMinutes: 30,
        connectionId: 1,
        minWireVersion: 0,
        maxWireVersion: 21,
        readOnly: false,
        ok: 1,
      };
    }
    if (failing.includes(name)) return { ok: 0, errmsg: `${name} failed`, code: 2, codeName: "BadValue" };
    const collection = typeof command[name] === "string" ? command[name] : "";
    const ns = `${command.$db ?? "test"}.${collection}`;
    const docs = collections.get(collection) ?? [];
    collections.set(collection, docs);
    if (name === "insert") {
      const writeErrors = [];
      for (const [index, doc] of (command.documents ?? []).entries()) {
        if (doc._id !== undefined && docs.some((there) => String(there._id) === String(doc._id))) {
          writeErrors.push({ index, code: 11000, errmsg: "E11000 duplicate key error" });
        } else {
          docs.push(doc);
        }
      }
      return writeErrors.length > 0
        ? { n: docs.length, writeErrors, ok: 1 }
        : { n: command.documents?.length ?? 0, ok: 1 };
    }
    if (name === "find" || name === "aggregate") {
      return { cursor: { id: BSON.Long.fromNumber(0), ns, firstBatch: docs.slice(0, 1) }, ok: 1 };
    }
    if (name === "update") return { n: 1, nModified: 1, ok: 1 };
    if (name === "delete") return { n: 1, ok: 1 };
    if (name === "findAndModify")
      return { value: docs[0] ?? null, lastErrorObject: { n: docs.length > 0 ? 1 : 0 }, ok: 1 };
    if (name === "count") return { n: docs.length, ok: 1 };
    if (name === "listCollections" || name === "listIndexes") {
      return { cursor: { id: BSON.Long.fromNumber(0), ns, firstBatch: [] }, ok: 1 };
    }
    return { ok: 1 };
  }

  function reply(opCode, responseTo, document) {
    const body = BSON.serialize(document);
    const header = Buffer.alloc(16);
    if (opCode === OP_REPLY) {
      const prefix = Buffer.alloc(20); // responseFlags, cursorID, startingFrom, numberReturned
      prefix.writeInt32LE(1, 16);
      header.writeInt32LE(16 + prefix.length + body.length, 0);
      header.writeInt32LE(responseTo, 8);
      header.writeInt32LE(OP_REPLY, 12);
      return Buffer.concat([header, prefix, body]);
    }
    const prefix = Buffer.alloc(5); // flagBits, then a section of kind 0
    header.writeInt32LE(16 + prefix.length + body.length, 0);
    header.writeInt32LE(responseTo, 8);
    header.writeInt32LE(OP_MSG, 12);
    return Buffer.concat([header, prefix, body]);
  }

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `mongodb://127.0.0.1:${port}/shop`,
    /** The names of the commands the server was sent, in order, the driver's own among them. */
    commands,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
