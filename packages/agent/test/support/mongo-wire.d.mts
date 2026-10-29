/** The tests' own MongoDB server (`mongo-wire.mjs`): what a test reads of it. */
export interface MongoWire {
  url: string;
  /** The names of the commands the server was sent, in order, the driver's own among them. */
  commands: string[];
  close(): Promise<void>;
}

export function startMongoWire(options?: { failing?: readonly string[] }): Promise<MongoWire>;
