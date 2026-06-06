"use strict";

const { EventEmitter } = require("node:events");
const http = require("node:http");
const { Readable, Writable } = require("node:stream");
const { URLSearchParams } = require("node:url");

const {
  TunnelNode,
  metaToString,
  isTunnelNode,
} = loadTunnelNode();

const LIFECYCLE_METHODS = new Set([
  "init",
  "Init",
  "close",
  "Close",
  "meta",
  "Meta",
]);

class ServiceContext {
  constructor(route, requestMeta, rawData, handler) {
    this.route = route;
    this.handler = handler || null;
    this.segments = splitRoute(route);
    this.tail = this.segments.slice(1);
    this.requestMeta = requestMeta || {};
    this.responseMeta = {};
    this.rawData = rawData || Buffer.alloc(0);
    this.values = new Map();

    for (const [key, value] of Object.entries(this.requestMeta)) {
      this.values.set(`Request.${key}`, value);
    }
  }

  set(key, value) {
    if (typeof key === "string" && key.startsWith("Response.")) {
      this.responseMeta[key.slice("Response.".length)] = value;
    }
    this.values.set(key, value);
  }

  get(key) {
    return this.values.get(key);
  }

  setResponseMeta(key, value) {
    this.responseMeta[key] = value;
    this.values.set(`Response.${key}`, value);
  }
}

class ServiceTunnel extends TunnelNode {
  constructor(app, options = {}) {
    super();
    assertServiceTarget(app);

    this.app = app;
    this.options = {
      parseJSON: true,
      payloadMode: "",
      ...options,
    };
    this.routes = collectRoutes(app);
    if (this.routes.size === 0) {
      throw new TypeError(
        "service.new(app) requires at least one public handler method"
      );
    }
  }

  async init() {
    await callOptional(this.app, ["init", "Init"]);
  }

  async close() {
    await callOptional(this.app, ["close", "Close"]);
  }

  async meta() {
    const meta = await callOptional(this.app, ["meta", "Meta"]);
    return metaToString(meta);
  }

  async invoke(route, request) {
    try {
      const handler = this.resolve(route);
      const reqEnv = parseEnvelope(request);
      const rawData = decodeBase64(reqEnv.data);
      const payload = decodePayload(rawData, this.options);
      const ctx = new ServiceContext(route, reqEnv.meta, rawData, handler);
      const result = await handler.method.call(handler.receiver, ctx, payload);

      return encodeEnvelope(ctx.responseMeta, result);
    } catch (err) {
      return encodeEnvelope(
        { Error: err && err.message ? err.message : String(err) },
        ""
      );
    }
  }

  resolve(route) {
    const first = splitRoute(route)[0] || "";
    const key = normalizeRouteKey(first);
    const handler = this.routes.get(key);
    if (!handler) {
      throw new Error(`service route not found: ${route}`);
    }
    return handler;
  }

  listRoutes() {
    return [...this.routes.values()].map((entry) => ({
      path: entry.path,
      name: entry.name,
    }));
  }
}

class WebTunnel extends TunnelNode {
  constructor(app, options = {}) {
    super();
    assertWebTarget(app);

    this.app = app;
    this.options = {
      defaultMethod: "POST",
      ...options,
    };
  }

  async invoke(route, request) {
    try {
      const reqEnv = parseEnvelope(request);
      const rawData = decodeBase64(reqEnv.data);
      const req = createWebRequest(route, reqEnv.meta, rawData, this.options);
      const res = new CaptureResponse(req);

      await dispatchWebTarget(this.app, req, res);
      const body = await res.finished();
      return encodeEnvelope(webResponseMeta(res), body);
    } catch (err) {
      return encodeEnvelope(
        {
          Status: 500,
          Error: err && err.message ? err.message : String(err),
        },
        ""
      );
    }
  }
}

function createService(app, options) {
  return new ServiceTunnel(app, options);
}

function createWebService(app, options) {
  return new WebTunnel(app, options);
}

function assertServiceTarget(app) {
  if (!app || typeof app !== "object" || Array.isArray(app)) {
    throw new TypeError("service.new(app) requires a non-null service object");
  }
}

function assertWebTarget(app) {
  if (!app) {
    throw new TypeError("service.web(app) requires a web application target");
  }

  const isHandler = typeof app === "function";
  const isExpress = app && typeof app.handle === "function";
  const isKoa = app && typeof app.callback === "function";
  const isServer = app instanceof http.Server || typeof app.emit === "function";

  if (!isHandler && !isExpress && !isKoa && !isServer) {
    throw new TypeError(
      "service.web(app) requires a Node handler, Express/Koa app, or http.Server"
    );
  }
}

function loadTunnelNode() {
  try {
    return require("@aura-studio/tunnel-node");
  } catch (_) {
    try {
      return require("../../tunnel-node/src");
    } catch (_) {
      return createBundledTunnelNode();
    }
  }
}

function createBundledTunnelNode() {
  const brand = Symbol.for("aura-studio.tunnel-node");

  class BundledTunnelNode {
    constructor() {
      Object.defineProperty(this, brand, {
        value: true,
        enumerable: false,
      });
    }

    async init() {}
    async invoke() {
      throw new Error("TunnelNode.invoke(route, request) is not implemented");
    }
    async meta() { return ""; }
    async close() {}

    Init() { return this.init(); }
    Invoke(route, request) { return this.invoke(route, request); }
    Meta() { return this.meta(); }
    Close() { return this.close(); }
  }

  return {
    TunnelNode: BundledTunnelNode,
    metaToString,
    isTunnelNode(value) {
      if (!value) return false;
      if (value[brand] === true) return true;
      return (
        hasMethod(value, "init") &&
        hasMethod(value, "invoke") &&
        hasMethod(value, "meta") &&
        hasMethod(value, "close")
      ) || (
        hasMethod(value, "Init") &&
        hasMethod(value, "Invoke") &&
        hasMethod(value, "Meta") &&
        hasMethod(value, "Close")
      );
    },
  };
}

function hasMethod(value, name) {
  return value && typeof value[name] === "function";
}

function collectRoutes(app) {
  const routes = new Map();

  for (const { receiver, name, method } of collectMethods(app)) {
    if (!isPublicHandlerName(name)) continue;

    const paths = routePathsForMethod(name);
    const entry = {
      name,
      receiver,
      method,
      path: paths[0],
    };

    for (const path of paths) {
      const key = normalizeRouteKey(path);
      if (!routes.has(key)) {
        routes.set(key, entry);
      }
    }
  }

  return routes;
}

function collectMethods(app) {
  const methods = [];
  const seen = new Set();

  for (const name of Object.keys(app)) {
    const value = app[name];
    if (typeof value === "function" && !seen.has(name)) {
      seen.add(name);
      methods.push({ receiver: app, name, method: value });
    }
  }

  let proto = Object.getPrototypeOf(app);
  while (proto && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === "constructor" || seen.has(name)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(proto, name);
      if (!descriptor || typeof descriptor.value !== "function") continue;
      seen.add(name);
      methods.push({ receiver: app, name, method: descriptor.value });
    }
    proto = Object.getPrototypeOf(proto);
  }

  return methods;
}

function isPublicHandlerName(name) {
  if (!name || name.startsWith("_")) return false;
  if (LIFECYCLE_METHODS.has(name)) return false;
  return true;
}

function routePathsForMethod(name) {
  return unique([
    `/${toKebabCase(name)}`,
    `/${name}`,
    `/${toCamelCase(name)}`,
    `/${toPascalCase(name)}`,
  ]);
}

function normalizeRouteKey(path) {
  const first = splitRoute(path)[0] || "";
  return toKebabCase(first);
}

function parseEnvelope(raw) {
  const env = JSON.parse(raw || "{}");
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw new Error("invalid envelope");
  }
  return {
    meta: env.meta && typeof env.meta === "object" ? env.meta : {},
    data: typeof env.data === "string" ? env.data : "",
  };
}

function decodeBase64(data) {
  if (!data) return Buffer.alloc(0);
  return Buffer.from(data, "base64");
}

function decodePayload(rawData, options) {
  if (options.payloadMode === "buffer") return rawData;
  if (options.payloadMode === "string") return rawData.toString("utf8");

  const text = rawData.toString("utf8");
  if (!options.parseJSON || text === "") return text;

  try {
    return JSON.parse(text);
  } catch (_) {
    return text;
  }
}

function encodeEnvelope(meta, data) {
  const body = encodePayload(data);
  return JSON.stringify({
    meta: meta || {},
    data: body.toString("base64"),
  });
}

function encodePayload(data) {
  if (data == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === "string") return Buffer.from(data, "utf8");
  return Buffer.from(JSON.stringify(data), "utf8");
}

function createWebRequest(route, meta, rawData, options) {
  const headers = normalizeHeaders(meta);
  if (rawData.length > 0 && headers["content-length"] == null) {
    headers["content-length"] = String(rawData.length);
  }

  const req = Readable.from([rawData]);
  req.method = String(meta.Method || options.defaultMethod || "POST").toUpperCase();
  req.url = resolveRequestUrl(route, meta);
  req.originalUrl = req.url;
  req.headers = headers;
  req.rawHeaders = rawHeadersFrom(headers);
  req.httpVersion = "1.1";
  req.httpVersionMajor = 1;
  req.httpVersionMinor = 1;
  req.socket = new EventEmitter();
  req.socket.encrypted = false;
  req.connection = req.socket;
  return req;
}

function resolveRequestUrl(route, meta) {
  const path = meta.Path || route || "/";
  const query = queryToString(meta.Query);
  if (!query) return ensureLeadingSlash(path);

  const url = ensureLeadingSlash(path);
  return `${url}${url.includes("?") ? "&" : "?"}${query}`;
}

function ensureLeadingSlash(value) {
  const text = String(value || "/");
  return text.startsWith("/") ? text : `/${text}`;
}

function queryToString(value) {
  if (value == null || value === "") return "";
  if (typeof value === "string") return value.replace(/^\?/, "");
  if (typeof value === "object" && !Array.isArray(value)) {
    return new URLSearchParams(value).toString();
  }
  return String(value);
}

function normalizeHeaders(meta) {
  const headers = {};
  const source =
    (meta.Headers && typeof meta.Headers === "object" && meta.Headers) ||
    (meta.Header && typeof meta.Header === "object" && meta.Header) ||
    {};

  for (const [key, value] of Object.entries(source)) {
    if (value == null) continue;
    headers[key.toLowerCase()] = Array.isArray(value)
      ? value.map(String)
      : String(value);
  }

  for (const [key, value] of Object.entries(meta || {})) {
    if (!key.startsWith("Header.") || value == null) continue;
    headers[key.slice("Header.".length).toLowerCase()] = String(value);
  }

  return headers;
}

function rawHeadersFrom(headers) {
  const raw = [];
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) raw.push(key, item);
    } else {
      raw.push(key, value);
    }
  }
  return raw;
}

class CaptureResponse extends Writable {
  constructor(req) {
    super();
    this.req = req;
    this.statusCode = 200;
    this.statusMessage = "OK";
    this.headers = new Map();
    this.chunks = [];
    this.headersSent = false;
  }

  _write(chunk, _encoding, callback) {
    this.headersSent = true;
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    callback();
  }

  writeHead(statusCode, statusMessage, headers) {
    this.statusCode = Number(statusCode) || this.statusCode;
    if (typeof statusMessage === "string") {
      this.statusMessage = statusMessage;
    } else {
      headers = statusMessage;
    }
    if (headers) {
      for (const [key, value] of Object.entries(headers)) {
        this.setHeader(key, value);
      }
    }
    this.headersSent = true;
    return this;
  }

  setHeader(name, value) {
    this.headers.set(String(name).toLowerCase(), { name: String(name), value });
    return this;
  }

  getHeader(name) {
    const entry = this.headers.get(String(name).toLowerCase());
    return entry && entry.value;
  }

  getHeaders() {
    const headers = {};
    for (const entry of this.headers.values()) headers[entry.name] = entry.value;
    return headers;
  }

  removeHeader(name) {
    this.headers.delete(String(name).toLowerCase());
  }

  end(chunk, encoding, callback) {
    if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    if (chunk != null) this.write(chunk, encoding);
    return super.end(callback);
  }

  status(statusCode) {
    this.statusCode = Number(statusCode) || this.statusCode;
    return this;
  }

  send(body) {
    if (body != null && typeof body === "object" && !Buffer.isBuffer(body)) {
      if (!this.getHeader("content-type")) {
        this.setHeader("content-type", "application/json");
      }
      return this.end(JSON.stringify(body));
    }
    return this.end(body);
  }

  json(body) {
    this.setHeader("content-type", "application/json");
    return this.end(JSON.stringify(body));
  }

  finished() {
    if (this.writableEnded) return Promise.resolve(Buffer.concat(this.chunks));
    return new Promise((resolve, reject) => {
      this.once("finish", () => resolve(Buffer.concat(this.chunks)));
      this.once("error", reject);
    });
  }
}

async function dispatchWebTarget(app, req, res) {
  if (app instanceof http.Server) {
    app.emit("request", req, res);
    return;
  }

  if (app && typeof app.callback === "function") {
    await callRequestHandler(app.callback(), req, res);
    return;
  }

  if (app && typeof app.handle === "function") {
    await new Promise((resolve, reject) => {
      const next = (err) => {
        if (err) {
          reject(err);
          return;
        }
        if (!res.writableEnded) {
          res.statusCode = 404;
          res.end("not found");
        }
        resolve();
      };
      const result = app.handle(req, res, next);
      resolveWhenHandled(result, res, resolve, reject);
    });
    return;
  }

  await callRequestHandler(app, req, res);
}

async function callRequestHandler(handler, req, res) {
  await new Promise((resolve, reject) => {
    const result = handler(req, res);
    resolveWhenHandled(result, res, resolve, reject);
  });
}

function resolveWhenHandled(result, res, resolve, reject) {
  if (result && typeof result.then === "function") {
    result.then(() => {
      if (res.writableEnded) resolve();
      else res.once("finish", resolve);
    }, reject);
    return;
  }

  if (res.writableEnded) {
    resolve();
    return;
  }

  res.once("finish", resolve);
}

function webResponseMeta(res) {
  const headers = {};
  for (const [key, entry] of res.headers) {
    headers[key] = entry.value;
  }

  const meta = {
    Status: res.statusCode,
    Headers: headers,
  };

  const contentType = res.getHeader("content-type");
  if (contentType != null) meta.ContentType = Array.isArray(contentType)
    ? contentType[0]
    : String(contentType);

  return meta;
}

function splitRoute(route) {
  return String(route || "")
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean);
}

async function callOptional(target, names) {
  for (const name of names) {
    const value = target && target[name];
    if (typeof value === "function") return value.call(target);
    if (typeof value === "string") return value;
    if (value != null && name.toLowerCase() === "meta") return value;
  }
  return "";
}

function toKebabCase(value) {
  return wordsOf(value).join("-");
}

function toCamelCase(value) {
  const words = wordsOf(value);
  if (words.length === 0) return "";
  return words[0] + words.slice(1).map(capitalize).join("");
}

function toPascalCase(value) {
  return wordsOf(value).map(capitalize).join("");
}

function wordsOf(value) {
  return String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

function capitalize(value) {
  if (!value) return "";
  return value[0].toUpperCase() + value.slice(1);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

module.exports = {
  new: createService,
  create: createService,
  web: createWebService,
  createWeb: createWebService,
  Service: ServiceTunnel,
  ServiceTunnel,
  Web: WebTunnel,
  WebTunnel,
  Context: ServiceContext,
  ServiceContext,
  isTunnelNode,
};
