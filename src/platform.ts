import { randomUUID } from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";

/**
 * Foreign Node capabilities required by the bridge.
 *
 * Deterministic record, protocol, and target-selection decisions stay outside
 * this boundary. Tests replace individual operations to model failures without
 * accessing a user's Claude configuration or runtime directory.
 */
export type NodePlatform = {
  readonly cwd: () => string;
  readonly environment: (name: string) => string | undefined;
  readonly homeDirectory: () => string;
  readonly temporaryDirectory: () => string;
  readonly processId: () => number;
  readonly now: () => number;
  readonly randomIdentifier: () => string;
  readonly chmod: (path: string, mode: number) => void;
  readonly closeServer: (server: Server) => Promise<void>;
  readonly createServer: (
    options: { readonly allowHalfOpen: boolean },
    listener: (connection: Socket) => void,
  ) => Server;
  readonly connect: (options: { readonly path: string }) => Socket;
  readonly destroySocket: (socket: Socket) => void;
  readonly endSocket: (
    socket: Socket,
    options: { readonly bytes: string | undefined; readonly onComplete: (() => void) | undefined },
  ) => void;
  readonly listenServer: (server: Server, path: string) => Promise<void>;
  readonly onServerError: (server: Server, listener: (error: Error) => void) => void;
  readonly onSocketClose: (socket: Socket, listener: () => void) => void;
  readonly onSocketData: (socket: Socket, listener: (chunk: Buffer) => void) => void;
  readonly onSocketEnd: (socket: Socket, listener: () => void) => void;
  readonly onSocketError: (socket: Socket, listener: (error: Error) => void) => void;
  readonly onceSocketConnect: (socket: Socket, listener: () => void) => void;
  readonly onceSocketError: (socket: Socket, listener: (error: Error) => void) => void;
  readonly setSocketTimeout: (socket: Socket, milliseconds: number, listener: () => void) => void;
  readonly unrefServer: (server: Server) => void;
  readonly link: (existingPath: string, newPath: string) => void;
  readonly lstat: (path: string) => Stats;
  readonly makeDirectory: (path: string, options: { readonly mode: number }) => void;
  readonly readDirectory: (path: string) => string[];
  readonly readDirectoryEntries: (
    path: string,
  ) => ReadonlyArray<{ readonly name: string; isFile: () => boolean }>;
  readonly readFile: (path: string) => string;
  readonly removeFile: (path: string) => void;
  readonly removeDirectory: (path: string) => void;
  readonly rename: (oldPath: string, newPath: string) => void;
  readonly unlink: (path: string) => void;
  readonly writeFile: (
    path: string,
    contents: string,
    options: { readonly flag: "wx"; readonly mode: number },
  ) => void;
};

/**
 * Production implementation of the bridge's Node capability boundary.
 */
export const nodePlatform: NodePlatform = {
  cwd: () => process.cwd(),
  environment: (name) => process.env[name],
  homeDirectory: homedir,
  temporaryDirectory: tmpdir,
  processId: () => process.pid,
  now: Date.now,
  randomIdentifier: randomUUID,
  chmod: chmodSync,
  closeServer: (server) =>
    new Promise((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
    }),
  createServer,
  connect,
  destroySocket: (socket) => socket.destroy(),
  endSocket: (socket, { bytes, onComplete }) => {
    if (bytes === undefined) socket.end(onComplete);
    else socket.end(bytes, onComplete);
  },
  listenServer: (server, path) =>
    new Promise((resolve, reject) => {
      const onStartupError = (error: Error) => reject(error);
      server.once("error", onStartupError);
      server.listen(path, () => {
        server.off("error", onStartupError);
        resolve();
      });
    }),
  onServerError: (server, listener) => server.on("error", listener),
  onSocketClose: (socket, listener) => socket.on("close", listener),
  onSocketData: (socket, listener) => socket.on("data", listener),
  onSocketEnd: (socket, listener) => socket.on("end", listener),
  onSocketError: (socket, listener) => socket.on("error", listener),
  onceSocketConnect: (socket, listener) => socket.once("connect", listener),
  onceSocketError: (socket, listener) => socket.once("error", listener),
  setSocketTimeout: (socket, milliseconds, listener) => socket.setTimeout(milliseconds, listener),
  unrefServer: (server) => server.unref(),
  link: linkSync,
  lstat: lstatSync,
  makeDirectory: mkdirSync,
  readDirectory: readdirSync,
  readDirectoryEntries: (path) => readdirSync(path, { withFileTypes: true }),
  readFile: (path) => readFileSync(path, "utf8"),
  removeFile: (path) => rmSync(path, { force: true }),
  removeDirectory: rmdirSync,
  rename: renameSync,
  unlink: unlinkSync,
  writeFile: (path, contents, options) =>
    writeFileSync(path, contents, { encoding: "utf8", ...options }),
};
