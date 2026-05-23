"use strict";

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

function createService(app, options) {
  return new ServiceTunnel(app, options);
}

function assertServiceTarget(app) {
  if (!app || typeof app !== "object" || Array.isArray(app)) {
    throw new TypeError("service.new(app) requires a non-null service object");
  }
}

function loadTunnelNode() {
  try {
    return require("@aura-studio/tunnel-node");
  } catch (_) {
    return require("../../tunnel-node/src");
  }
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
  Service: ServiceTunnel,
  ServiceTunnel,
  Context: ServiceContext,
  ServiceContext,
  isTunnelNode,
};
