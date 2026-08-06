// This proxy runs on a server runtime (not in the browser bundle), where
// process.env is available but @types/node is not part of this package's types.
declare const process: { env: Record<string, string | undefined> };
