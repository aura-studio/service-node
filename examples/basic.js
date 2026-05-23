"use strict";

const service = require("../src");

class GreeterService {
  greet(ctx, input) {
    ctx.setResponseMeta("ContentType", "application/json");
    return { message: `hello ${input.name || "world"}` };
  }

  getProfile(_ctx, input) {
    return { id: input.id, name: "Aura" };
  }
}

function envelope(data) {
  return JSON.stringify({
    meta: {},
    data: Buffer.from(JSON.stringify(data), "utf8").toString("base64"),
  });
}

async function main() {
  const tunnel = service.new(new GreeterService());

  console.log(tunnel.listRoutes());

  const response = await tunnel.invoke("/greet", envelope({ name: "Aura" }));
  const decoded = JSON.parse(response);

  console.log(Buffer.from(decoded.data, "base64").toString("utf8"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
